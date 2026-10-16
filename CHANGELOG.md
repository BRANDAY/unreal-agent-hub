# Changelog

## 0.1.0 - 2026-10-16

First version, extracted from a working in-house setup of one game studio and generalized.

- Lock store without a mutex (`docs/PROTOCOL.md`): atomic create by hard link, stale locks removed by
  rename-aside and checked, integer-millisecond queue order. Equal for clients in any language.
- Queue with priorities by holder kind and aging, never preempting; work-conserving (waiters blocked by a
  person do not hold back others). Pools by machine role (`role:runner`).
- Machine roles hub / build / workstation / runner; presence ("I am at this machine"); a load detector.
- Handover requests: a remote run asks the person at a machine, who answers "Yes, take it" / "Not now" on the
  board, in a chat (MCP `hub_grant` / `hub_decline`) or with `hub grant`; release and "the machine is yours
  again" are automatic, the presence mark comes back.
- Hooks for Claude Code, OpenAI Codex and Cursor through one normalization layer (`lib/agents/`); gates from
  profiles (`unreal`, `generic`; examples `blender`, `docker-gpu`) and project overlays.
- Board on 127.0.0.1 with SSE, Host and Origin checks, node tokens, six languages (en, de, fr, it, es, ru),
  vendored React 18.3.1 and htm 3.1.1.
- MCP server: `hub_status`, `hub_hold`, `hub_release`, `hub_here`, `hub_grant`, `hub_decline`.
- CLI `hub`, PowerShell module `AgentHub.psm1`, Claude Code plugin + marketplace, Codex plugin manifest
  (unverified on a live install), `install-hooks` for all three agents.
- Transports: reverse ssh tunnel (built), direct HTTP (node to hub built; on-demand probes not yet), synced
  folder (read side built).
- License: PolyForm Small Business 1.0.0 with commercial licenses above the size line (`COMMERCIAL.md`);
  outside contributions under the `CLA.md`.

### Known limitations in 0.1.0

- `presence.blocks` is not read yet: on the hub's own machine resource a presence mark also stops the hub's own
  chats at `@machine` gates (on nodes the node's own chats pass, as intended). The hub's own desktop is not probed.
- Machine roles other than the pool name `role:<x>` are labels; busy detection runs for every probed node. Hub
  resources join a `role:` pool only when listed by key.
- Transport B: the board listens on 127.0.0.1 only, so a direct `hubUrl` needs a forwarder plus `board.allowHosts`;
  nothing calls `/api/node/probe-push` yet; `dump` over HTTP returns an empty list.
- Remote Control notices are queued in `state/outbox.jsonl` and reach the duty chat on its next turn, not instantly.
- The plugin option `role` defaults to `hub`; set it explicitly on nodes.
- The overlay `labels` key and a profile's `labels` block are read but not used yet.
- Not verified on a live install: Claude plugin hooks in the desktop app, the Codex plugin manifest
  (`${PLUGIN_ROOT}` in `mcp.json`), the 1800 s `PreToolUse` timeout.
