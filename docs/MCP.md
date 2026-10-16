# MCP server

This page documents the MCP server started by `hub mcp` (`lib/mcp.cjs`): its six tools with input schemas and example answers, who owns a hold, how a node behaves, and how to register the server in Claude Code, Codex and Cursor. The same operations exist as shell commands in [CLI.md](CLI.md).

## What it is

`hub mcp` speaks MCP (JSON-RPC 2.0, one message per line on stdin and stdout, protocol version `2025-06-18` unless the client asks for another). It answers `initialize`, `ping`, `tools/list` and `tools/call`; `notifications/*` need no answer. Any other method gets error `-32601`. An unknown tool name gets `-32602`. The server declares `tools` only (no resources, no prompts).

With it a chat sees the queue as data and takes a hold with a tool call instead of a shell command. Hooks still do the automatic part (heavy tool calls wait by themselves); the MCP tools are for explicit multi-step holds and for answering handover requests.

## Tools

| Tool | Purpose | Arguments |
|---|---|---|
| `hub_status` | Read-only: every resource, holder, queue, handover requests | none |
| `hub_hold` | Hold a resource across several steps of this chat | `resource` (required), `ttl_min`, `note`, `wait_sec` |
| `hub_release` | Release a resource this chat holds | `resource` (required) |
| `hub_here` | Mark that the person sits at a machine (presence) | `machine`, `on` (default true), `ttl_min` |
| `hub_grant` | Answer "yes, take it" to a handover request | `resource`, `token` |
| `hub_decline` | Answer "not now" to a handover request | `resource`, `token` |

All schemas set `additionalProperties: false`.

### `hub_status`

```json
{ "type": "object", "properties": {}, "additionalProperties": false }
```

Answer: text in the same layout as `hub status`, plus `structuredContent` (`{"items": [...]}`) with the rows.

```
cpp                chat "Fix cook crash" (hold, rebuild) since 13:04, TTL until 14:04
                     queued: Smoke tests (script, priority 30, 3 min)
laptop             free
```

### `hub_hold`

```json
{
  "type": "object",
  "properties": {
    "resource": { "type": "string", "description": "an id such as \"cpp\" or \"editor\", \"@node:<id>\", or \"role:runner\"" },
    "ttl_min":  { "type": "number" },
    "note":     { "type": "string" },
    "wait_sec": { "type": "number", "description": "0-50 seconds, default 20" }
  },
  "required": ["resource"], "additionalProperties": false
}
```

Call and answer:

```json
{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"hub_hold","arguments":{"resource":"editor","note":"rebuild cycle","wait_sec":0}}}
```
```json
{"jsonrpc":"2.0","id":4,"result":{"content":[{"type":"text","text":"Held MyGame~editor (TTL 30 min). Release it with hub_release when done."}],"structuredContent":{"ok":true,"key":"MyGame~editor","token":"a1b2c3d4e5f6"}}}
```

`wait_sec` is clamped to 0 to 50 so a tool call never outlives the client's timeout; `0` fails at once. When the resource is still busy the answer has `isError: true`: "Not held: ... Do other work and try again later; never stop processes you did not start." Other outcomes: "Already held by this chat" (re-entrant), or "the person's presence lets this chat through (nothing taken)" when a person's presence mark sits on a node machine this chat runs on.

### `hub_release`

```json
{ "type": "object", "properties": { "resource": { "type": "string" } }, "required": ["resource"], "additionalProperties": false }
```

Answers: `Released cpp.`, `cpp is not held.`, or an error if someone else holds it ("Only its holder releases it"). A hold counts as this chat's when its owner process id equals the MCP server's parent, or its session id equals `CLAUDE_CODE_SESSION_ID`.

### `hub_here`

```json
{ "type": "object", "properties": { "machine": { "type": "string" }, "on": { "type": "boolean", "default": true }, "ttl_min": { "type": "number" } }, "additionalProperties": false }
```

`hub_here {"machine":"laptop"}` answers `Presence marked on laptop for 180 min.`; with `"on": false` it answers `Presence mark removed from laptop.` Without `machine` the target is `operator.at`, then the hub's id.

### `hub_grant` and `hub_decline`

```json
{ "type": "object", "properties": { "resource": { "type": "string" }, "token": { "type": "string" } }, "additionalProperties": false }
```

`resource` is a resource key or a machine id. If both arguments are missing, the only pending request is used; with zero or several the answer is "No single pending handover request: name the resource or machine." Answers: `Granted laptop to Smoke tests for one run.` and `Declined for now; it asks again in 15 min.` Use them only with the person's own words ([HANDOVER.md](HANDOVER.md)).

## Who owns a hold

A hold made through MCP belongs to the agent process that started the server, that is, the server's parent process id (`process.ppid`), together with the chat's session id when the agent exports one. The hold ends when:

1. `hub_release` is called;
2. the agent process exits (the next taker sees "its agent session has ended" and removes the lock);
3. its TTL runs out.

It does not end when a single turn ends. For Claude Code the parent is the agent itself. For Codex and Cursor the parent may be a wrapper process; this has not been verified on a live install, so give such holds a short `ttl_min`.

## On a node

On a machine with `role: "node"` the tools do not touch the local state folder:

| Tool | Behaviour on a node |
|---|---|
| `hub_status` | Calls `POST /api/node/state` on the hub and prints `key  holder  N queued` per resource. If the hub is unreachable: "The hub is not reachable from this node." |
| `hub_here`, `hub_grant`, `hub_decline` | Forwarded to the hub (`/api/node/presence`, `/api/node/grant`, `/api/node/decline`) with the node's token |
| `hub_hold`, `hub_release` | Not available: "runs on the hub; on a node, heavy work holds this machine through the hook" |

Heavy work on a node waits for its machine resource through the hook, not through MCP. See [TRANSPORTS.md](TRANSPORTS.md).

## Registering the server

The server is a `node` process: `node <path>/bin/hub.cjs mcp`. The path `~/.unreal-agent-hub/bin/hub.cjs` is a shim written on the first `SessionStart` hook or by `install-hooks`; it forwards to the installed version, so the registration survives updates.

### Claude Code

The plugin registers it for you (`.claude-plugin/plugin.json` declares `unreal-agent-hub` with `node ${CLAUDE_PLUGIN_ROOT}/bin/hub.cjs mcp`). Without the plugin:

```bash
claude mcp add unreal-agent-hub -- node ~/.unreal-agent-hub/bin/hub.cjs mcp
```

On Windows use the full path, for example `node C:\Users\you\.unreal-agent-hub\bin\hub.cjs mcp`.

### Codex

Add to `~/.codex/config.toml` (`hub install-hooks --agent codex` prints this block):

```toml
[mcp_servers.unreal-agent-hub]
command = "node"
args = ["/home/you/.unreal-agent-hub/bin/hub.cjs", "mcp"]
```

### Cursor

Add to `~/.cursor/mcp.json` (or a project's `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "unreal-agent-hub": { "command": "node", "args": ["/home/you/.unreal-agent-hub/bin/hub.cjs", "mcp"] }
  }
}
```

The repository also ships `mcp.json` at its root (`mcpServers.unreal-agent-hub` with `${PLUGIN_ROOT}/bin/hub.cjs mcp`) for plugin hosts that follow the agent-plugins.org layout; see [AGENTS.md](AGENTS.md).

## Testing by hand

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
              '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | node bin/hub.cjs mcp
```

Use `UAH_HOME=/tmp/uah-test` to keep the experiment away from your real state ([CONFIG.md](CONFIG.md)).
