# MCP proxy: the editor restarts, the chats keep their tools

For Unreal, the MCP server the agents talk to is the editor itself (the ModelContextProtocol plugin,
`http://127.0.0.1:8000/mcp`, Streamable HTTP). When one chat restarts the editor, every other chat loses `unreal-mcp`
for good: Claude Code retries a dead HTTP server for about 31 s, marks it failed and never dials again, while a
restart takes 2-6 minutes; and the sessions the editor kept in memory are gone, so the old `Mcp-Session-Id` values get
`404`. Until now somebody had to press Reconnect in every chat.

`hub mcp-proxy` sits between the agent and the editor. The agent starts it like any stdio MCP server and it never goes
away, so the client never gives up. The watch ([WATCH.md](WATCH.md)) keeps calls from failing during a restart and
opens a closed editor again; the proxy keeps the chat's connection alive across it.

## What it does

| Client request | Editor up | Editor down |
|---|---|---|
| `initialize`, `ping`, `notifications/initialized` | `initialize`: the editor's own answer (its protocol version and capabilities) | answered by the proxy from its cache |
| any `*/list` (`tools`, `resources`, `prompts`, ...) | from the editor; the cache is refreshed | from the cache (first run: `lib/mcp-proxy-seed.json`); a family the editor announced but never listed gives an empty list at once |
| other requests of a family the editor announced (`tools/call`, `resources/read`, `prompts/get`, ...) | to the editor | **waits** for the editor up to `waitSec` (900 s), then goes through |
| a method the editor never announced (`server/discover`, the first request of Claude Code 2.1.227) | to the editor | `-32601` at once, as the UE 5.8 plugin answers |
| a request of the editor to the client mid-call (sampling, elicitation) and the client's answer | relayed both ways | - |

- **One editor session per client.** The proxy gives the client its own session id and keeps a separate editor session
  for it. A `404` from the editor (it was restarted) re-runs `initialize` on the editor with the client's original
  parameters and sends the request again: the editor never executed it, so the repeat is safe.
- **A call that may have run is never repeated.** If the editor goes away in the middle of `tools/call`, the client
  gets a tool error: the call may or may not have been applied, check before repeating it.
- **A timeout is a tool error, not a dead transport**, and it says why the editor is down, from the hub's own watch
  state: a chat closed it (`hub watch down`), a build or a cook holds a `busy` resource, or the board's watchdog is
  starting it. The session stays: the next call works without a reconnect.
- **Heartbeat.** Claude Code aborts a tool that "sent no response or progress" for its idle timeout. While the proxy
  waits for the editor and while the tool runs, it sends `notifications/progress` every 10 s (when the call carries a
  `progressToken`) and an SSE comment in HTTP mode.
- **`progressToken` is not sent to the editor.** With it the UE 5.8 plugin answers an SSE body with neither
  `Content-Length` nor chunked encoding (its own comment in `ProcessToolCallJsonRpcCall` says so) and Node reads it as
  empty. Without it the editor sends one JSON reply; the client's progress comes from the proxy.
- **A changed tool list** after a restart reaches the client as `notifications/tools/list_changed`.

### Plugin updates

The proxy names no tool and no toolset and keeps no list of the plugin's methods. What it needs to know about the
server it takes from the server: method families from `initialize -> capabilities`, the protocol version from the
editor's answer (remembered per version for the time it is down), sessions or none (no `Mcp-Session-Id` = stateless,
nothing to reopen), no `initialize` at all (taken as it is). It does not survive a change of transport (WebSocket, or
a standing GET stream for server pushes) without an update. After an engine update:

```bash
hub mcp-proxy --probe
```

Read-only (initialize, tools/list, a DELETE of its own session). Exit `0` = the editor behaves as assumed, `1` = a line
marked `WARN` to look at, `2` = the editor does not answer.

## Setup

One proxy per chat over stdio is the main mode: there is no daemon to start before the chat (a proxy that starts after
the client gave up would be the very failure it fixes) and no shared process that could take every chat down with it.

```bash
hub mcp-proxy install --agent claude
```

It finds the `unreal-mcp` entry (the project's `.mcp.json`, else `~/.claude.json` at user scope or this project's
local scope; with none, a new entry in the project's `.mcp.json`) and points it at the proxy. The editor's URL moves
into `--upstream`:

```json
"unreal-mcp": { "type": "stdio", "command": "node",
  "args": ["~/.unreal-agent-hub/bin/hub.cjs", "mcp-proxy", "--stdio", "--upstream", "http://127.0.0.1:8000/mcp"],
  "timeout": 1800000 }
```

The name stays `unreal-mcp`: the gates (`^mcp__unreal-mcp__`), the watch and the chats' tool permissions keep working.
`timeout` (ms) is Claude Code's tool timeout for the server, longer than the proxy's wait. The file is copied to
`<file>.bak-agent-hub-<time>` first and the previous entry is kept in `state/mcp-proxy/installed.json`;
`--uninstall` puts it back, `--dry-run` prints the result. New chats use the proxy; a running chat needs one reconnect
of `unreal-mcp`.

| Agent | File | Entry |
|---|---|---|
| `claude` | `.mcp.json` of the project or `~/.claude.json` (`--file` for another) | `mcpServers.unreal-mcp`, `type: stdio` |
| `cursor` | `~/.cursor/mcp.json` (`--file .cursor/mcp.json` for a project) | `mcpServers.unreal-mcp` |
| `codex` | `~/.codex/config.toml` | `[mcp_servers.unreal-mcp]` with `tool_timeout_sec = 1800`; the old lines stay beside it, commented out with `#|` |

Headers or other settings of the old entry are not relayed: the proxy talks to the editor on `127.0.0.1` without them.

### HTTP mode

```bash
hub mcp-proxy --port 8001
```

One process for every chat: `http://127.0.0.1:8001/mcp` for the clients, `GET /status` for a look inside. It must
listen before a chat starts; `"mcpProxy": { "daemon": true }` makes the hooks start it on `SessionStart`, the way they
start the board. Point the clients at it by hand (`"type": "http", "url": "http://127.0.0.1:8001/mcp"`).

## Settings

`mcpProxy` in the unreal profile, then in the machine config, then in the project overlay (single keys replaced);
flags and `UAH_MCP_PROXY_*` variables win:

| Key | Flag | Default | Meaning |
|---|---|---|---|
| `upstream` | `--upstream URL` | `http://127.0.0.1:8000/mcp` | The editor's MCP endpoint (without a profile: `watch.port`) |
| `waitSec` | `--wait SEC` | `900` | How long a call waits for the editor before the tool error |
| `port` | `--port N` | `8001` | HTTP mode only |
| `host` | `--host H` | `127.0.0.1` | HTTP mode only |
| `keepaliveSec` | `--keepalive SEC` | `10` | Heartbeat interval |
| `daemon` | | `false` | The hooks start the HTTP mode on `SessionStart` |
| | `--cache FILE` | `state/mcp-proxy/cache-<project>.json` | The editor's initialize answer and lists, shared by the project's proxies |
| | `--log FILE` | `state/mcp-proxy/proxy.log` | One line per decision (kept below 5 MB: the old part goes to `.old`) |
| | `--down-mark FILE` | | A file `{at, by}` (`at` in ms or ISO) that means "closed on purpose", for scripts that do not call `hub watch down` |

The proxy reads the settings of the folder it is started in (the agent starts MCP servers in the project folder). If
the hub's config cannot be read, it still relays with the defaults: the hub must never be the reason a chat cannot
work.

## With the rest of the hub

- **Board.** Every proxy writes `state/mcp-proxy/<pid>.json` (editor up, calls waiting and running, its chat). The
  project's `editor` card shows "MCP: the editor answers / is down · N calls wait for it"; a project without an
  `editor` resource gets a card of its own.
- **Hook.** A call that goes through the chat's own proxy (its session or agent pid in the status file, or an HTTP
  proxy of the project) is not held by the `PreToolUse` restart wait as well: one wait, in the proxy, not two. The
  `editor` lock, the call holds and the `@machine` gate stay as they are.
- **Watchdog.** The board's watchdog opens a crashed or chat-closed editor again; the proxy waits for it instead of the
  client.

## Tests

`test/mcp-proxy.test.cjs` runs the proxy against a fake editor that behaves like the UE 5.8 plugin, then like a
possible later one (no sessions, no initialize, new families, other protocol versions, requests to the client), in
HTTP and stdio mode, plus the status file, the hook, the timeout reasons and `install` for the three agents. Nothing
touches a real editor or ports 8000/8001.
