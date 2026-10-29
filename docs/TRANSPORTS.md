# Transports

This page explains how the hub and its nodes (other machines) talk to each other: the three transports in `lib/transport/*` (A: ssh-reverse, B: http, D: folder), what is built and what is not, how Remote Control (C) is used only to notify a person, and the step-by-step setup of transport A. For the roles of machines see [ROLES.md](ROLES.md); for the security model see [SECURITY.md](SECURITY.md).

## The idea

A hub keeps the queue. A node is another machine whose chats and scripts want shared resources, and whose desktop may be in use by a person. Two directions are needed:

- hub to node: "what are you busy with?" (the probe) and "list your chats" (the dump). The hub asks.
- node to hub: chat events, and holds of the node's machine resource by its chats. The node's hook posts JSON to the hub's board (`/api/node/*`, with a node id and a token).

If the hub cannot be reached, the node's hooks fail open: work goes on as if there were no hub.

## Comparison

| | A: ssh-reverse | B: http | D: folder | C: Remote Control |
|---|---|---|---|---|
| Status | Built, default | Node to hub built; hub to node on demand not built | Read side built, holds not | Notifications only |
| Hub to node | `ssh <alias> node .unreal-agent-hub/bin/hub.cjs probe` or `dump` | Only a probe the node pushed itself (none is sent yet) | Reads `probe.json` and `chats/*.json` from the folder | not used |
| Node to hub | HTTP to `127.0.0.1:<tunnelPort>` on the node, carried by `ssh -R` | HTTP(S) to `hubUrl` directly | Hooks publish chat records; holds would be request and answer files | not used |
| Needs | ssh from hub to node (keys are yours) | A reachable address (LAN, tailnet) | A synced folder (OneDrive, Syncthing, SMB) | A duty chat on the hub |
| Inbound ports on the node | none | none | none | none |
| Tokens | yes | yes | no (folder access is the control) | no |
| Latency | seconds | seconds | seconds to a minute | each message is one model turn |

## A: ssh-reverse (built, default)

The hub opens everything; the node opens nothing. The hub keeps a reverse tunnel `ssh -N -R <tunnelPort>:127.0.0.1:<boardPort> <alias>` open (it reopens it after 60 s if it drops, with `ServerAliveInterval=30`). On the node, `http://127.0.0.1:<tunnelPort>` is therefore the hub's board. The node's hooks and MCP server post there with the header `X-Agent-Hub-Node: <id>` and `Authorization: Bearer <token>`.

For probes and dumps the hub runs exactly one fixed remote command:

```text
ssh -o BatchMode=yes -o ConnectTimeout=5 <alias> node .unreal-agent-hub/bin/hub.cjs probe
ssh -o BatchMode=yes -o ConnectTimeout=5 <alias> node .unreal-agent-hub/bin/hub.cjs dump
ssh -o BatchMode=yes -o ConnectTimeout=5 <alias> node .unreal-agent-hub/bin/hub.cjs usage --scan --print --machine <id> --tzmin <n> [--match-b64 <base64>]
```

The path is relative to the node user's home folder on purpose: an ssh session starts there on every OS, and `~` would not be expanded by `cmd.exe` on Windows. `nodes[].hubPath` changes it. The answer must be JSON on stdout (probe times out after 40 s, dump after 30 s, usage after 10 min; the usage filter travels base64-encoded, so no shell ever sees its `|`). No remote shell commands are built from user input.

The project never creates, changes or deletes ssh keys or `authorized_keys`. It only uses an ssh connection that already works without a password.

### Setup, step by step

1. Make `ssh <alias>` work from the hub to the node without a prompt (`BatchMode=yes` forbids prompts). The alias lives in `~/.ssh/config` on the hub, for example:

   ```text
   Host laptop
     HostName 192.168.1.50
     User builder
     IdentityFile ~/.ssh/laptop_key
   ```

2. On the hub add the node. This writes it into `~/.unreal-agent-hub/config.json` with a generated token and prints the config for the node:

   ```bash
   hub node add laptop --ssh laptop --tunnel-port 18791 --label "Laptop" --roles runner,workstation
   ```

   Use a different `--tunnel-port` for every node.
3. On the node install Node.js 18 or newer and the plugin (Claude Code: `/plugin marketplace add <owner>/unreal-agent-hub`, `/plugin install unreal-agent-hub`), or the npm package (`npm i -g unreal-agent-hub && hub install-hooks --agent claude`). The `hub.cjs` shim must exist at `~/.unreal-agent-hub/bin/hub.cjs`; it is written by the first `SessionStart` hook or by `install-hooks`.
4. On the node write `~/.unreal-agent-hub/config.json` with what `hub node add` printed:

   ```json
   { "role": "node", "id": "laptop", "hubUrl": "http://127.0.0.1:18791", "token": "<printed token>", "profile": "unreal" }
   ```

5. On the hub check that the probe works: `ssh laptop node .unreal-agent-hub/bin/hub.cjs probe` must print JSON.
6. Restart the board (`hub serve`; the hooks start it on demand). It opens the tunnel. The board's Machines section shows "tunnel up" and the first probe.

`hub node install <id>` prints these steps for a node already in the config. `hub doctor` warns about a node without a token.

## B: http (partly built)

The node talks to the hub's address directly (`hubUrl: "https://hub.example:8790"`, LAN or tailnet), always with its token. The client side (`lib/transport/client.cjs`) is built and is the same code transport A uses; only the URL differs. Set `tlsInsecure: true` only for a self-signed test certificate.

Not built:

- On-demand probes. The hub cannot ask the node. The server accepts a probe pushed by the node (`POST /api/node/probe-push`), but no code on the node sends one yet, so a node on this transport shows as "not checked".
- `dump` returns an empty list.
- The board listens on `127.0.0.1` only. For a direct address something must forward to it (a reverse proxy, `tailscale serve`, an ssh tunnel), and the name used must be in `board.allowHosts` ([BOARD.md](BOARD.md)).

## D: folder (read side built)

For machines that share a synced folder and nothing else. A node's agent publishes `<folder>/<node>/probe.json` and `<folder>/<node>/chats/<session>.json`; the hub reads them. Configure `transport: "folder"` and `folder` on the hub's node entry, and the same on the node. `examples/demo.cjs` uses this transport to show a node without any network.

Not built: holds of the node's resource by its chats (they would need request and answer files), so a folder node cannot make the hub's scripts wait for it. Access to the folder is the only access control.

## C: Remote Control (notifications only)

Remote Control is not a transport. It is used for one purpose: telling a person about the two events that concern them, a handover request and "the machine is yours again" ([HANDOVER.md](HANDOVER.md)). It is enabled with `handover.notify: ["board", "remote-control"]`.

How it works today (`lib/notify.cjs`, `lib/adapters/claude-messaging.cjs`):

1. In one chat on the hub run `hub duty`. That chat becomes the duty chat; the choice is stored in `state/duty.json`.
2. When one of the two events happens, the text is appended to `state/outbox.jsonl`.
3. The duty chat's own `SessionStart` or `UserPromptSubmit` hook shows pending lines as context on its next turn ("Hub notification for the person (show it to them): ...").

The wire format for writing into a session inbox directly is not publicly documented, so the adapter does not speak it; delivery therefore happens on the duty chat's next turn, not instantly. Every message delivered through Remote Control is one model turn on the receiving side, which is why only these two events are sent and never routine traffic. The board remains the main place where requests are seen and answered, with a browser notification and a beep.

## What a node sends and receives

| Route on the hub | Sent by a node | Effect |
|---|---|---|
| `POST /api/node/event` | every hook event, with the chat record | Updates the board; releases that chat's hold when it goes idle or ends |
| `POST /api/node/hold` | a `PreToolUse` that matches an `@machine` gate | Takes the node's machine resource for that chat or queues it; answer `ok` or the holder's name |
| `POST /api/node/state` | `hub_status` on a node | The hub's full state |
| `POST /api/node/grant`, `decline`, `presence` | the node's MCP tools | Same as on the hub |

A node chat's hold is an ordinary lock file (mode `node-chat`) on the hub, so the hub's scripts queue behind it. Prompts sent to the hub follow `share.prompt` ([CONFIG.md](CONFIG.md)). If the hub does not answer within the timeout, the call goes on.
