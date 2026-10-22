# Architecture

How the parts of Unreal Agent Hub fit together: concepts, processes, data flow, and the source layout.

## Concepts

| Term | Meaning |
|---|---|
| **Hub** | The one machine that keeps the lock store (the source of truth), the board (HTTP + SSE on 127.0.0.1) and the tunnels to nodes. |
| **Node** | Any other machine. It runs the same package in role `node`: hooks for its chats, `hub probe` for "what is this machine busy with". No service, no open port. |
| **Resource** | A named exclusive lock with a TTL. Scope `machine` (one per machine, e.g. `cpp`), `project` (one per project, e.g. `MyGame~editor`), or a whole node (`laptop`). |
| **Holder** | `script` (a process), `hold` (an agent chat across steps), `node-chat` (a chat on a node, through the board), `presence` (a person), and `gate` (a tool call that waits without taking - only ever a waiter). |
| **Role** | What a machine does: `hub`, `build`, `workstation`, `runner` ([ROLES](ROLES.md)). |
| **Profile** | Which chats take part (a marker such as `*.uproject`), which calls are heavy (gates), which processes mean "a person uses this machine" ([PROFILES](PROFILES.md)). |
| **Presence** | "I am sitting at this machine": a `presence` hold, or the probe finding the profile's processes on the desktop. |
| **Transport** | How a node reaches the hub and the hub asks a node ([TRANSPORTS](TRANSPORTS.md)). |

## Processes

```
                      HUB
  scripts ── hub lock / Enter-HubLock ──┐
  agent chats ── hook (hub hook) ───────┼──► ~/.unreal-agent-hub/state/   (lib/store.cjs)
  agent chats ── MCP (hub mcp) ─────────┤      <key>.json, <key>.wait.*.json, <key>.ask.*.json,
                                        │      events.jsonl, log.txt, chats/, <node>.probe.json
  browser ◄── SSE ── board (hub serve) ─┘      ▲
                       │  ssh -N -R 18791:127.0.0.1:8790 <node>      (kept open by the board)
                       │  ssh <node> node .unreal-agent-hub/bin/hub.cjs probe|dump   (on demand)
                      NODE
  agent chats ── hook (role node) ── POST http://127.0.0.1:18791/api/node/{event,hold} + token
```

- **No daemon is required on the hub either.** Scripts and hooks read and write the store directly. The board is
  needed for nodes (it takes their holds and keeps the tunnels) and for people (the page). Hooks start it when its
  port is silent.
- **The same code runs everywhere.** Only the "sink" of a hook differs: on the hub it writes the store; on a node
  it posts to the board, and when the hub cannot be reached it lets everything through.
- **Waiting costs no model turns.** A gate waits inside the hook process; a script waits inside `hub lock`.
- **The cost of a hook** in a project outside every profile: about 110 ms per call on Windows 11 with Node 24, of
  which about 60 ms is Node's own start (measured 16.10.2026). The plugin's `PreToolUse` matcher limits it to
  shell and MCP calls.

## A heavy call, end to end

1. A Codex chat in `D:\Games\MyGame` runs `RunUAT.bat BuildCookRun ...`.
2. Codex starts `hub hook --agent codex` with the PreToolUse JSON.
3. `lib/agents/codex.cjs` normalizes it to `{agent, event, session, cwd, tool, command}`.
4. `lib/config.cjs` loads the machine config and the project overlay; `profileFor` finds `MyGame.uproject` -> profile
   `unreal`.
5. `matchGates` finds the profile gate for `RunUAT` -> resource `@machine` (or the overlay's own rule).
6. `lib/lock-client.cjs` tries the store; another chat holds it -> a waiter file appears, the board shows it in the
   queue, the hook polls every 2 s.
7. The holder releases -> the waiter is first in line -> it takes the lock (`hold`, released at the chat's Stop),
   the hook exits 0, the command runs.
8. Had it waited `gateWaitSec`, the hook would print Codex's deny JSON with the holder's name.

## Source layout

```
bin/hub.cjs                CLI (all commands)
lib/config.cjs             config layers, resource names, profiles
lib/store.cjs              the lock protocol (docs/PROTOCOL.md)
lib/queue.cjs              priorities, aging, work-conserving order
lib/lock-client.cjs        acquire (queue, pools, probes, handover), release, gate wait
lib/handover.cjs           ask / grant / decline / cancel / return
lib/presence.cjs           "I am at this machine"
lib/roles.cjs              roles, probe cache, "is a person using it"
lib/hook.cjs               the hook for every agent; lib/node-agent.cjs on nodes
lib/agents/                claude.cjs, codex.cjs, cursor.cjs, index.cjs (detection)
lib/detect/                markers, processes (Windows/POSIX), gpu (nvidia-smi), unreal-editor, load, probe
lib/transport/             ssh-reverse, http-direct, folder, client (node -> hub)
lib/adapters/              claude-desktop (titles, open chat, cloud ids), claude-transcripts (subagents, cloud sessions),
                           claude-messaging (duty chat), platform
lib/server/                board.cjs (HTTP, SSE, actions), nodes.cjs (tunnels, node holds)
lib/mcp.cjs                MCP server over stdio
lib/status.cjs, chats.cjs, notify.cjs, install-hooks.cjs
web/                       the built board page: index.html, assets/, i18n/*.json, THIRD-PARTY-LICENSES.txt
web-src/                   its sources: React 19 + Mantine 9, Vite (npm run build -> web/)
ps/AgentHub.psm1           PowerShell module
profiles/                  unreal.json, generic.json, examples/
.claude-plugin/            plugin.json, marketplace.json      (Claude Code)
plugin.json, mcp.json      agent-plugins manifest              (Codex)
hooks/hooks.json, skills/hub/SKILL.md, commands/, AGENTS.snippet.md
examples/                  configs and demo.cjs (a demo board)
test/                      node:test
```

## Design choices

- **Files, not a server, as the source of truth.** Any language can take a lock; a crashed board loses nothing.
- **No mutex.** Named mutexes exist only on Windows and only for one language at a time; the rename-aside protocol
  works for every client and every OS ([PROTOCOL](PROTOCOL.md)).
- **Machine-wide store in the home folder**, not in a repository: one machine serves many projects and worktrees,
  and scripts outside any agent find it. Not in the plugin's data folder either - it is removed with the plugin.
- **Fail open.** The hub helps; it must never be the reason work cannot go on.
- **Never preempt, never kill.** Priorities order the queue only.
