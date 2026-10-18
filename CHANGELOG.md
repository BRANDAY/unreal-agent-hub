# Changelog

## 0.1.1 - 2026-10-18

Races between chats over files, from the same studio setup: two chats editing one file overwrote each other's
lines, and a cook ran on editor binaries that another chat was rebuilding.

- **File gate** (`lib/file-gate.cjs`, [docs/FILES.md](docs/FILES.md)) in the `PreToolUse` hook for file edits
  (Claude Code `Edit`, `Write`, `MultiEdit`, `NotebookEdit`; Codex `apply_patch`):
  - an edit of what the build compiles waits while another chat or script holds the build resource (`cpp`); the
    chat's own build does not hold it back; after `gateWaitSec` the edit is denied with the holder's name;
  - the first chat to edit a shared file claims it; another chat's edit is denied while the holder's changes are
    uncommitted. A claim ends when the file is clean (after a 120 s grace for a pending edit), when a commit on a
    main branch touching the file is at least as new as the holder's last edit (merged work, even if the file is
    dirty again), or after `claimHours` without an edit. One claim file per path, created atomically: of two chats
    claiming at once exactly one wins.
  - Configured by a `files` block in the profile (the `unreal` profile ships one: sources, plugins, `.uproject`,
    `*.Build.cs`, `*.Target.cs`, `Config/*.ini`; docs free) and in the project overlay (single keys replaced,
    `false` turns it off).
- `hub claims [--json]`, `hub claims release <path>`.
- **Several resources in one lock:** `hub lock cpp,cook -- <command>` and `Invoke-HubLocked cpp, cook { ... }` take
  them in the order given and release in reverse; a packaging run holds the build for its whole length.
- Hook matchers (plugin `hooks/hooks.json`, `install-hooks` for Claude Code and Codex) now include the edit tools.
- `gateWait` takes an `isMine` option; normalized hook events carry `files`.
- Windows: `writeJson` retries a rename over a file that another process holds for a moment (`EPERM`, `EACCES`,
  `EBUSY`, up to about 3 s); seen as a rare failure when a claim or lock made by `createExclusive` was rewritten
  while the antivirus was still scanning it.
- Board: `?win=1|3|12|24` in the address picks the timeline window (for links and screenshots).
- `examples/demo.cjs` plays a busy day: nine chats, every task runs the pipeline build -> cook (holding the build)
  -> smoke test, and queues while a stage is taken. New screenshot of the 24 h timeline in the README.

### Known limitations in 0.1.1

- Edits through a shell (`sed -i`, scripts) are not seen by the file gate.
- The file gate does not run on nodes (`role: node`), and Cursor's `preToolUse` is not installed by `install-hooks`.
- The board does not show claims yet (`hub claims` does).
- Codex `apply_patch` payloads are parsed from the patch headers; not verified on a live Codex install.

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
