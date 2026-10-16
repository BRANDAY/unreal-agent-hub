# The board

This page describes the live board of Unreal Agent Hub: what each section shows, its languages and notifications, the HTTP endpoints behind it, how its access checks work, and how to run it (`lib/server/board.cjs`, `lib/server/nodes.cjs`, `web/`). For the security reasoning see [SECURITY.md](SECURITY.md); for the handover questions the board asks see [HANDOVER.md](HANDOVER.md).

![Board](images/board.jpg)

## Running it

```bash
hub serve                 # http://127.0.0.1:8790
hub serve --port 8791     # another port
hub serve --no-tunnels    # do not open the nodes' ssh tunnels
```

- The board needs no build step and no dependencies. It reads the state folder (`~/.unreal-agent-hub/state`) and pushes changes to the page over Server-Sent Events.
- On the hub, the hooks start it for you: at `SessionStart` and at every prompt, if nothing answers on the board port, a detached `hub serve` is started (log in `state/board.log`). A second copy that loses the race exits quietly because the port is taken.
- It listens on `127.0.0.1` only. Nodes reach it through the reverse ssh tunnel it keeps open ([TRANSPORTS.md](TRANSPORTS.md)).
- React 18.3.1, ReactDOM 18.3.1 and htm 3.1.1 are vendored in `web/vendor`, so the page works offline.
- Try it with made-up data: `node examples/demo.cjs --port 8791`. The demo uses a temporary `UAH_HOME` and a "folder" node, and touches neither your real state nor ssh.

## Sections

From top to bottom:

| Section | What it shows |
|---|---|
| Top bar | Hub name and machine, live indicator, four counters (resources busy out of all, queued waiters, chats working, things that need you), the language menu, and an "Enable notifications" button while the browser has not been asked |
| Handover banner | One banner per pending or declined request: who asks for which machine, what for, how long they have waited, why it is blocked, video memory in use, and the buttons "Yes, take it" and "Not now". After "not now" it shows when the question comes again. For 15 minutes after a granted run ends, a notice "X has finished - the machine is yours again" |
| Resources | Cards grouped by "<hub> (this machine)" and by project. A card shows free, busy, stale or "a person is here"; the holder with an agent badge (claude, codex, cursor) and the "open chat" button; the mode and note; a running timer and a TTL bar (it turns amber past 85 percent); and the queue in serving order with each waiter's effective priority. A free card shows who held it last. A stale lock gets a "Remove the stale lock" button (with a confirmation) |
| Machines | One card per node: roles, the person's desktop processes (with project and start time), a reason when load is high, video memory bar, the grace pause after closing Unreal, the node's chats, when it was last checked, tunnel state, a warning "no node token", and buttons "Check now" and "I'm at <machine>" / "I left <machine>" (presence, see [ROLES.md](ROLES.md)) |
| Timeline | Windows of 1, 3, 12 or 24 hours. One row per resource: filled bars are holds (colour = chat, amber = a person's presence), hatched bars are waits, dots are events: ask and decline (amber), grant and return (green). Below, one row per chat: blue = working, orange = needs you. Hover for details |
| Load | For each resource over the chosen window: percent of time held, number of takes, total time waited |
| Chats | Cards for sessions seen in the last 48 hours: title, state (working, waiting for a prompt, needs you, closed, process ended), agent badge, machine and project, what it holds and what it waits for, the last prompt or the notice that needs the person, and an "open chat" button for Claude desktop sessions. A checkbox adds archived and closed chats |
| Lock journal | The last 30 lines of `state/log.txt` (TAKE, WAIT, FREE, BREAK, ASK, GRANT, ...) |

History for the timeline and load comes from `state/events.jsonl` and `state/chats.jsonl` for the last 24 hours (the last 4 MB of each file are read).

## Languages

The board is available in English, German, French, Italian, Spanish and Russian (`web/i18n/<lang>.json`; codes `en de fr it es ru`). The language is chosen in this order, first match wins:

1. the `?lang=` query parameter, for example `http://127.0.0.1:8790/?lang=de`;
2. the browser's `localStorage` key `hub.lang`, set by the language menu;
3. `lang` from the machine config ([CONFIG.md](CONFIG.md));
4. the browser's language;
5. English.

## Notifications

When a new handover request appears, or a "machine is yours again" notice arrives, the page plays a short beep (880 Hz, about 0.18 s). If the browser granted notification permission (press "Enable notifications"), it also shows a browser notification titled with the board's name. The page only reacts to requests that appear while it is open; it does not notify about the state it found on load. For messages outside the browser see "Remote Control" in [TRANSPORTS.md](TRANSPORTS.md).

## HTTP endpoints

GET:

| Path | Returns |
|---|---|
| `/` | The page |
| `/state` | The whole state as JSON (the same document the page receives) |
| `/events` | Server-Sent Events: the state as a `data:` line on every change, a ping every 15 s |
| `/app.js`, `/style.css`, `/favicon.svg`, `/vendor/*.js`, `/i18n/<lang>.json` | Static files; nothing else is served and paths cannot leave `web/` |

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
