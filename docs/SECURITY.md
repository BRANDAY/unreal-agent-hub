# Security

The threat model, what the hub protects against, and what it deliberately does not.

## Threat model

- **Locks are advisory.** They are respected by the clients that go through them (hooks, `hub lock`, the
  PowerShell module, MCP). A process that ignores them is not stopped. The participants - your own chats and
  scripts - are trusted.
- **Local users are trusted.** Anyone who can write to `~/.unreal-agent-hub/state` can change the queue. The folder
  belongs to the user; do not share it with other accounts.
- **Untrusted:** web pages open in a browser on the same machine (they can reach `127.0.0.1`), other processes on a
  node that could pretend to be its agent, and the network between machines.

## The board

- Listens on **127.0.0.1 only**.
- **Host check against DNS rebinding.** A page from `evil.example` whose name is re-pointed to 127.0.0.1 counts as the
  same origin for the browser and could read `/state` (chat titles, prompt starts) and call actions. The board
  answers only requests whose `Host` is `127.0.0.1:<port>`, `localhost:<port>` or `[::1]:<port>` - plus the same for
  every node's tunnel port (that is how the board opens on a node) and `board.allowHosts`. Anything else gets 421.
- **Actions** (`/api/break`, `presence`, `grant`, `decline`, `open`, `node/probe`) are POST with the header
  `X-Agent-Hub: 1`. A page from another origin cannot send a custom header without a CORS preflight, which the board
  never answers; if an `Origin` header is present, it must be one of the board's own addresses.
- The board removes only **stale** locks. A live lock is removed only by `hub break --force` on the command line.
- Static files are served only from `web/` by a fixed pattern; no directory listing, no path traversal.

## Nodes

- **Token per node.** `hub node add <id>` generates 32 random bytes; the hub keeps it in its config, the node in its
  own config or in the plugin's `token` option (marked `sensitive`, so Claude Code stores it in the OS keychain).
  Node requests carry `X-Agent-Hub-Node: <id>` and `Authorization: Bearer <token>`, compared in constant time. A node
  without a configured token is accepted for compatibility, flagged "no node token" on the board and by `hub doctor`.
- Transport B (direct HTTP over a LAN) must use the token and should use TLS or Tailscale; see [TRANSPORTS](TRANSPORTS.md).

## SSH

- Always `BatchMode=yes` and `ConnectTimeout`; no password prompts.
- The hub runs on a node only fixed commands: `node .unreal-agent-hub/bin/hub.cjs probe` and `... dump`. No argument
  comes from data sent by the node.
- **The project never creates, changes, rotates or deletes ssh keys or `authorized_keys`.** Setting up ssh is the
  user's job; the docs only describe what must already work.

## What leaves a node

The chat's title, folder, agent and state; the start of the last prompt as `share.prompt` allows: `none`, `clip160`
(the first 160 characters - the default, useful to see what a chat works on) or `full`. The model's replies never
leave a node.

## Fail open, never kill

- Every hook catches its own errors and lets the action through; an unreachable hub means "no hub".
- A gate waits less than the hook's timeout (`gateWaitSec` 1500 s < 1800 s) and then **denies** with the holder's
  name, so a timeout never lets heavy work slip through silently.
- Nothing in the project stops, kills or closes processes. The texts to agents say so too: "never stop processes you
  did not start".

## Reporting

Please report security issues **privately**: by e-mail to **i.miranovich.se@gmail.com** (subject "Unreal Agent Hub
security"), or through GitHub's "Report a vulnerability" (private advisory) on the repository. Please do not open a
public issue for a vulnerability before it is fixed.
