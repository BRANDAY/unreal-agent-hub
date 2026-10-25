# Changelog

## 0.6.1 - 2026-10-25

- **PowerShell module: chat names in any alphabet.** `Invoke-HubCli` read Node's UTF-8 output in the console's
  code page (OEM 866 in a Russian Windows PowerShell 5.1), so `Get-HubStatus`, `Enter-HubLock` errors and the rest
  showed Cyrillic holders as mojibake. The module now reads that output as UTF-8 and restores the console encoding
  after the call.

## 0.6.0 - 2026-10-25

Locks also cover what the previous holder left behind, and the editor's app-wide calls go in turn.

- **App-wide calls of a `wait` gate** (`calls`, [PROFILES.md](docs/PROFILES.md#app-wide-calls)): a level load,
  save-all (`save_assets` with no list), `StartPIE`...`StopPIE` and level-instance edits from a chat that does not hold
  the editor take it for the call - a call hold (`by: hook-call`, TTL 5 min, PIE until `StopPIE`, 15 min) counted
  per call and freed by the new PostToolUse / PostToolUseFailure hooks. Other chats' calls wait behind it; ordinary
  calls of a free editor take nothing. A tool script (`execute_tool_script`) is searched for the same names. The
  Unreal profile carries the engine's list; a project gate adds its own tools (`"calls": {"tools": [...]}`). A call
  hold is not "a restart under way" for the app watch.
- **Stamps** (`hub stamp <name>`, `hub whose <name> [--require]`, [CLI.md](docs/CLI.md#hub-stamp-and-hub-whose)): who
  made a build - chat, time, commit, uncommitted files, the files' time and size. `whose` says "not yours" or
  "unknown" (files changed since); `--require` exits 3. A level load stamps `level`; before an app-wide call the model
  hears once (Claude Code: PreToolUse `additionalContext`) that the build or the open level is another chat's.
  PowerShell: `Set-HubStamp`, `Assert-HubOwn`.
- **A live Blender as a resource**: the example overlay gates `mcp__blender__*` on a project resource `blender`;
  headless Blender runs are left alone ([PROFILES.md](docs/PROFILES.md#a-live-blender-next-to-the-editor)).
- **Planning rule** in `AGENTS.snippet.md`: split a task into offline / editor / test machine first; one line each for
  call holds, `hub whose` and Blender.
- `install-hooks` and the plugin's `hooks.json` register PostToolUse and PostToolUseFailure for `mcp__.*` (was
  `start_session` only). `store.refresh` takes a new `ttlMin` into the expiry.

## 0.5.0 - 2026-10-22

The whole hub speaks the chosen language, and handover cards can be closed.

- **One set of translations for everything** a person reads: the board, the CLI (`hub help`, `status`, `hold`,
  `release`, `break`, `claims`, `watch`, `node`, `doctor`...), hook messages and session-start notes,
  notifications (board and duty chat), MCP tool results, the file gate and the watchdog's reasons. All of it lives in
  `web/i18n/<lang>.json` (English, German, French, Italian, Spanish, Russian); `lib/i18n.cjs` renders it on the
  server. The language is `lang` in the machine config or `UAH_LANG`, now also `auto` (the system locale). Log files,
  `events.jsonl` and the MCP tool descriptions stay in English.
- **Server text on the board follows the viewer's language:** why a run waits, why a lock is stale, who holds a
  resource, why an action failed and a busy machine's load reasons come as messages (`blockedByMsg`, `staleMsg`,
  `errorMsg`, `humanMsg`, probe `load.why`) next to the plain text, so a Russian page on an English hub shows Russian.
  A probe from an older node (plain strings) still shows as written.
- **Handover cards:** a close button hides a card (and a "yours again" notice) on that page only; the run keeps
  waiting and the card returns if it asks again; "Show hidden requests" brings them back. Without a connection to
  the hub a red banner says since when, and the answer buttons are disabled instead of failing silently.
- **Demo:** `node examples/demo.cjs --lang ru` makes the machines, chats and notes Russian too; the demo's handover
  reason now comes from the real busy check.
- `lock.describe` names the mode in words (`chat on the machine` instead of `node-chat`).

## 0.4.0 - 2026-10-22

What runs beside a chat, and a new board page.

- **Working in the background** (Claude Code): the `Stop` event's `background_tasks` with unfinished work (shells,
  subagents, monitors, workflows, teammates, cloud sessions) sets the chat to `background` instead of idle and keeps
  the list in its record; an `idle_prompt` notification keeps the state; a `<task-notification>` with a finished
  status in the next prompt drops that task. Other agents are unchanged. On a node, `background` frees the node's
  chat lock like idle does.
- **Cloud sessions:** a `PostToolUse` hook for the desktop app's `start_session` tool only (matcher
  `mcp__.*__start_session`, in `hooks/hooks.json` and `hub install-hooks --agent claude`) records sessions a chat
  starts with `target: "cloud"`; the desktop app's `cloudSpawnedTasks` adds older ones (title looked up once in the
  parent's transcript).
- **Subagents** of the Claude Code chats on the hub machine, read from `<transcript>/subagents/agent-*.meta.json`
  (`lib/adapters/claude-transcripts.cjs`); the hook now keeps `transcript_path`.
- **Board state:** `sessions[].background`, `.subagents`, `.started`, `.old` (closed more than 6 h ago; `hidden`
  counts them, `/state?live=1` leaves them out), top-level `subagents[]` and `cloud[]`, chat history of kind
  `background`. A tool call no longer ends the timeline's "working" interval, and only tool calls that change the
  state are logged to `chats.jsonl`.
- **Desktop records** are also read from `%LOCALAPPDATA%/Claude-Data/<profile>/claude-code-sessions` (newer Windows
  builds of the app).
- **New board page:** React 19 + Mantine 9 (mantine-datatable, @mantine/charts, Tabler icons), built with Vite from
  `web-src/` into `web/` (committed; nothing to install at run time; `npm run board:build` rebuilds it). Counters,
  busy resource cards filled with the resource colour (new optional `color` in the config), machines, a chats table
  with tabs, search, a switch for long-closed chats and expandable rows, subagents, cloud sessions, charts (time per
  chat, chats by state, load, subagents), a timeline with "now" on the left that scrolls into the past (1/2/4 h in
  view), light and dark themes. Everything of the old page stays: handover banner,
  presence, nodes and roles, notifications, `?win=`, `?lang=` and all six languages (new keys in every dictionary). A
  narrow pane gets a compact layout (state as an icon, details under the name, the banner's buttons under its
  text). The vendored React 18 and htm are gone; `web/THIRD-PARTY-LICENSES.txt` lists the bundled libraries.
- `examples/demo.cjs` shows background work, subagents, a cloud session and a long-closed chat.
- Tests 48 (7 new).

## 0.3.0 - 2026-10-20

Catching up with the studio setup the hub comes from (there is no 0.2.x). Editor restarts no longer break the other
chats, and a file claim no longer outlives a chat that is closed.

- **Watch** (`lib/watch.cjs`, [docs/WATCH.md](docs/WATCH.md)), configured by a `watch` block in the profile (the
  `unreal` profile: MCP port 8000, `UnrealEditor`, `Saved/Logs/{marker}.log`, clean-exit text, busy `cpp`/`cook`/
  `editor`) and the project overlay (`start`):
  - `hub watch down` / `hub watch up` / `hub watch`: a chat's close script marks the editor as "closed by a chat,
    it comes back";
  - the `PreToolUse` hook holds an agent's MCP call while the port is dead and a restart is under way (a busy
    resource held, the marker up, or the watchdog starting it); down with none of these it goes on as before;
  - the board's watchdog (every 30 s) starts the app with `watch.start` when a chat closed it or its log has no
    clean exit, never while a busy resource was held in the last 2 min, never after a clean close by hand, at most
    twice an hour. `UAH_WATCH=0` turns it off.
- **File gate:** `claimBranches` (for example `task/*`) and `quietMin`: a claim ends once its holder chat is closed or
  silent (no record, ended, agent process gone, or 20 min without an event) and a commit on such a branch touched
  the file after the holder's last edit. For workflows where every chat commits to its own branch without a
  checkout.
- Tests 41 (7 new).

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
