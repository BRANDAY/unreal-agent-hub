# The board

This page describes the live board of Unreal Agent Hub: what each section shows, its languages and notifications, the HTTP endpoints behind it, how its access checks work, and how to run it (`lib/server/board.cjs`, `lib/server/nodes.cjs`, `lib/adapters/claude-transcripts.cjs`, `web/`, sources in `web-src/`). For the security reasoning see [SECURITY.md](SECURITY.md); for the handover questions the board asks see [HANDOVER.md](HANDOVER.md).

![Board](images/board.jpg)

## Running it

```bash
hub serve                 # http://127.0.0.1:8790
hub serve --port 8791     # another port
hub serve --no-tunnels    # do not open the nodes' ssh tunnels
```

- The board needs no build step and no runtime dependencies. It reads the state folder (`~/.unreal-agent-hub/state`) and pushes changes to the page over Server-Sent Events.
- On the hub, the hooks start it for you: at `SessionStart` and at every prompt, if nothing answers on the board port, a detached `hub serve` is started (log in `state/board.log`). A second copy that loses the race exits quietly because the port is taken.
- It listens on `127.0.0.1` only. Nodes reach it through the reverse ssh tunnel it keeps open ([TRANSPORTS.md](TRANSPORTS.md)).
- The page is a React 19 + Mantine 9 app (mantine-datatable, @mantine/charts on Recharts, Tabler icons), built with Vite from `web-src/` into `web/index.html` and `web/assets/`. The built files are committed, so the page works offline and needs no npm at run time. To change it: `cd web-src && npm install && npm run build` (`npm run dev` serves it with hot reload against a running board; `UAH_BOARD=http://127.0.0.1:8791` points it at another port). The bundled libraries and their licenses (MIT and a few ISC/BSD) are listed in `web/THIRD-PARTY-LICENSES.txt`, which the build writes.
- Light and dark themes follow the system; the sun/moon button switches them.
- Try it with made-up data: `node examples/demo.cjs --port 8791`. The demo uses a temporary `UAH_HOME` and a "folder" node, and touches neither your real state nor ssh.

## Sections

From top to bottom:

| Section | What it shows |
|---|---|
| Top bar | Hub name and machine, live indicator, an "Enable notifications" button while the browser has not been asked, the language menu and the theme switch |
| Handover banner | One banner per pending or declined request: who asks for which machine, what for, how long they have waited, why it is blocked, video memory in use, and the buttons "Yes, take it" and "Not now" (in a narrow window the buttons sit under the text). After "not now" it shows when the question comes again. For 15 minutes after a granted run ends, a notice "X has finished - the machine is yours again" |
| Counters | Six tiles: what needs you (chats asking for a permission or an answer, silent chats, pending handover requests), chats working out of open ones, chats working in the background, subagents running, resources busy out of all (and how many wait), cloud sessions started in the last 48 hours |
| Resources | Cards grouped by "<hub> (this machine)" and by project; a busy card is filled with the resource's colour (`color` in the config, else by its icon; amber for a person's presence, red when stale), a free one stays neutral. A card shows free, busy, stale or "a person is here"; the holder with an agent badge (claude, codex, cursor) and the "open chat" button; the mode and note; a running timer and a TTL bar (it turns amber past 85 percent); and the queue in serving order with each waiter's effective priority. A free card shows who held it last. A stale lock gets a "Remove the stale lock" button (with a confirmation). With the MCP proxy ([MCP-PROXY.md](MCP-PROXY.md)) the project's `editor` card has one more line: "MCP: the editor answers" or "is down", and how many calls wait for it; a project without an `editor` resource gets an "Editor MCP (proxy)" card |
| Machines | One card per node: roles, the person's desktop processes (with project and start time), a reason when load is high, video memory bar, the grace pause after closing Unreal, the node's chats, when it was last checked, tunnel state, a warning "no node token", and buttons "Check now" and "I'm at <machine>" / "I left <machine>" (presence, see [ROLES.md](ROLES.md)) |
| Chats | A table of the sessions seen in the last 48 hours, sorted by default as: needs you, silent, working, working in the background, waiting for a prompt, closed. Tabs: Active, Need you, Background, All, Closed; a search box (title, prompt, session id, project, machine); a switch for chats closed more than 6 hours ago (hidden by default, their count in the label). A row shows the state, the title with agent, machine and project badges, the notice or the last prompt, background work (commands, subagents, monitors, cloud sessions), what it holds and waits for, the last activity, and an "open chat" button for Claude desktop sessions. Click a row for the last prompt and reply, every background task and running subagent, the session id, parent and folder. Below 900 px of table width the state becomes a coloured icon (label and meaning in its tooltip) and the rest folds into a line under the title |
| Subagents | The Agent calls of the Claude Code chats on the hub machine: running now, or all of the last 3 hours. Task (the description the chat gave), type, model, "background" when the chat did not wait for it, the chat, how long it has run and its last step. "Quiet": running, but its transcript has been silent for over 5 minutes |
| Cloud sessions | Sessions a chat started in the Claude cloud: title, the chat that started it (with "open chat"), when, and a link to claude.ai. A cloud session sends no events to this machine, so its state is "started" unless the parent chat still lists it as a running background task |
| Over the last | Windows of 1, 3, 12 or 24 hours (the last choice is remembered; `?win=24` in the address picks one for a link or a screenshot). Charts: time per chat (the ten busiest: turns, background work, waiting for you), chats by state now (donut), load per resource (percent of the window held, takes, time waited, the waiting part hatched), subagents started per half hour by type |
| Timeline | "Now" is at the left edge next to the names; older hours scroll to the right. 1, 2 or 4 hours fit the visible width (2 by default, remembered); the window above sets how far back it goes. One row per resource: filled bars are holds (resource colour, amber = a person's presence), hatched bars are waits, dots are events: ask and decline (amber), grant and return (green). Below, one row per chat that worked in view, newest first (a button shows the ones that worked earlier in the window): its colour = working, cyan = working in the background, orange = needs you. Hover for details |
| Lock journal | The last 30 lines of `state/log.txt` (TAKE, WAIT, FREE, BREAK, ASK, GRANT, ...) |

### Chat states

| State | Meaning |
|---|---|
| working | A turn is running (from the prompt to `Stop`) |
| working in the background | The turn has ended, but the Claude Code `Stop` event listed unfinished background tasks (`background_tasks`: shells, subagents, monitors, workflows, teammates, cloud sessions). They wake the chat themselves. A task notice in the next prompt (`<task-notification>` with status completed) drops that task; an `idle_prompt` notification keeps the state |
| waiting for a prompt | The turn has ended and nothing runs in the background |
| needs you | A permission prompt, a question or an agent asking for input |
| silent | Shown by the page for a chat that has been "working" with no event for over an hour: it most likely crashed |
| process ended / closed | The agent process is gone, or the session ended. Closed more than 6 hours ago: hidden behind the switch (`old: true` in the state) |

### Subagents and cloud sessions

Both come from Claude Code's own files on the hub machine and are undocumented, so they may change between versions; the board then shows nothing rather than failing (`lib/adapters/claude-transcripts.cjs`).

- Subagents: `<transcript dir>/<session>/subagents/agent-<id>.meta.json` (description, agent type, model, background or not, `finished`, `stoppedByUser`) next to `agent-<id>.jsonl`. The transcript is the hook's `transcript_path`, else `~/.claude/projects/<folder as dashes>/<session>.jsonl`. A subagent counts as running when the chat lists it in its background tasks, or when the chat is alive, it is not finished and its transcript was written in the last 15 minutes. Its start is the birth time of the `.jsonl` (the meta file is rewritten when it ends). Node chats are left out: their files are on the node.
- Cloud sessions: the `PostToolUse` hook of the desktop app's `start_session` tool with `target: "cloud"` records title, start time and the `session_...` / `task_...` ids in the chat's record; the desktop app's own record of the chat (`cloudSpawnedTasks`) adds the ids of sessions started before the hook was installed, whose title is then looked up once in the parent's transcript.

History for the timeline and load comes from `state/events.jsonl` and `state/chats.jsonl` for the last 24 hours (the last 4 MB of each file are read).

## Languages

The board is available in English, German, French, Italian, Spanish and Russian (`web/i18n/<lang>.json`; codes `en de fr it es ru`). The language is chosen in this order, first match wins:

1. the `?lang=` query parameter, for example `http://127.0.0.1:8790/?lang=de`;
2. the browser's `localStorage` key `hub.lang`, set by the language menu;
3. `lang` from the machine config ([CONFIG.md](CONFIG.md));
4. the browser's language;
5. English.

Text the hub itself produces and the board shows - why a run waits, why a lock is stale, who holds a resource, why an
action failed - comes as a message (`{ "k": "<key>", "v": { ... } }`) next to the plain text (`blockedByMsg`,
`staleMsg`, `errorMsg`, `humanMsg`, and the entries of a probe's `load.why`), so the page shows it in the viewer's
language even when the hub speaks another one. What people typed - chat titles, notes, machine and resource labels -
is shown as written.

### Adding or fixing a translation

All languages of the hub - the board, the CLI, hook messages, notifications - live in one flat file per language,
`web/i18n/<lang>.json`; a missing key falls back to English, then to the key itself. To add a language, copy
`en.json` to `<code>.json` (a two-letter code), translate the values and keep every `{placeholder}` as is. It shows up
in the language menu and as a `lang` value by itself; the page fetches it at run time, so no rebuild is needed. Log
files (`state/log.txt`, `events.jsonl`) stay in English on purpose, and so do the MCP tool descriptions (they are
read by models).

## Handover cards

Each request card has a close button: it hides the card on this page only (the browser remembers it), the run keeps
waiting, and the card comes back if the run asks again. "Show hidden requests" brings them back at once. While the
page has no connection to the hub, a red banner says since when, the request buttons are disabled (an answer would
not arrive), and the page reconnects by itself.

## Notifications

When a new handover request appears, or a "machine is yours again" notice arrives, the page plays a short beep (880 Hz, about 0.18 s). If the browser granted notification permission (press "Enable notifications"), it also shows a browser notification titled with the board's name. The page only reacts to requests that appear while it is open; it does not notify about the state it found on load. For messages outside the browser see "Remote Control" in [TRANSPORTS.md](TRANSPORTS.md).

## HTTP endpoints

GET:

| Path | Returns |
|---|---|
| `/` | The page |
| `/state` | The whole state as JSON (the same document the page receives). `?live=1` leaves out chats closed long ago |
| `/events` | Server-Sent Events: the state as a `data:` line on every change, a ping every 15 s |
| `/assets/<name>.js`, `.css`, `/favicon.svg`, `/i18n/<lang>.json` | Static files (assets are content-hashed and cached as immutable); nothing else is served and paths cannot leave `web/` |

The state document has, besides resources, nodes, asks, notices, log and history: `sessions[]` (each with `state`, `background[]`, `subagents` running, `started`, `old`), `hidden` (chats flagged old), `subagents[]` (`id`, `session`, `chat`, `description`, `type`, `model`, `background`, `started`, `last`, `running`, `stopped`), `cloud[]` (`remote`, `task`, `title`, `started`, `status`, `url`, `parentSession`, `parentTitle`), `mcpProxy[]` (per project: `project`, `upstream`, `editorUp`, `checkedAt`, `waiting`, `running`, `proxies`, `clients`) and, in `history.chats`, intervals of kind `working`, `background` and `owner`.

POST (anything under `/api/` that is not POST gets 405):

| Path | Body | Who may call |
|---|---|---|
| `/api/break` | `key`, `token` | Page. Removes a stale lock only if it is still the same lock and still stale; live locks are refused |
| `/api/open` | `hostSession` | Page. Opens a Claude desktop chat (`claude://code/continue?session=local_...`) |
| `/api/node/probe` | `node` | Page. "Check now" |
| `/api/presence` | `node` (or `machine`), `on` | Page |
| `/api/grant`, `/api/decline` | `key` (or `node`), `token` | Page |
| `/api/node/event` | chat record | Node agent |
| `/api/node/hold` | chat record plus `tool`, `command` | Node agent |
| `/api/node/state` | none | Node agent |
| `/api/node/probe-push` | a probe object | Node agent |
| `/api/node/grant`, `/api/node/decline`, `/api/node/presence` | as the page versions | Node agent |

Answers are JSON: `200` with `{"ok":true,...}`, `409` for a refused page action, `401` for a bad node id or token, `403` for a page request without the header or with a foreign origin, `404` for an unknown action.

## Access checks

1. Host check. Every request must carry a `Host` header that is one of the board's own addresses: `127.0.0.1`, `localhost` or `[::1]` with the board port, plus the same three names with each node's `tunnelPort` (requests arriving through a reverse tunnel carry that port). Anything else gets `421`. This stops DNS-rebinding attacks. Extra names go into `board.allowHosts` as `host:port` strings, for example `["hub.tail1234.ts.net:8790"]`.
2. Page actions (the POST routes above except `/api/node/*`) must send `X-Agent-Hub: 1` and, if they send an `Origin`, one that matches an allowed address. A web page on another site cannot send that header without a CORS preflight, and the board never answers one.
3. Node routes need `X-Agent-Hub-Node: <id>` and `Authorization: Bearer <token>`, compared in constant time. A node configured without a token is accepted by id alone; `hub doctor` and the board warn about it.

The board takes no passwords and has no accounts: whoever can reach `127.0.0.1:<port>` on the hub is the operator.

## Behaviour worth knowing

- Probing nodes: when the page connects, and then every 5 minutes while at least one page is open, the board asks each node for a probe (never more often than once a minute). "Check now" forces one. When a tunnel comes up the board probes and dumps that node at once.
- Housekeeping: about every 2 seconds, and when the state folder changes, the board sweeps handover requests (cancels those whose waiter left, returns finished runs) and rebuilds the state.
- The lock journal and the history are plain files; the board never edits a lock except by the page actions above.
