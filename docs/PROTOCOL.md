# The lock protocol

How every client - the Node CLI, the hooks, the board, the PowerShell module or a client you write in Python or
bash - takes, queues for, releases and breaks a lock. It needs no mutex and no server: only three atomic file
operations that every OS and file system offers. Implementation: `lib/store.cjs`, `lib/queue.cjs`,
`lib/lock-client.cjs`.

## The folder

`$UAH_HOME/state` (default `~/.unreal-agent-hub/state`). One machine-wide folder, outside any repository, so
scripts outside an agent (a build script, CI) find it too.

| File | Meaning |
|---|---|
| `<key>.json` | the lock of resource `<key>`; absent = free |
| `<key>.wait.<token>.json` | one waiter in the queue |
| `<key>.ask.<token>.json` | a handover request to a person ([HANDOVER](HANDOVER.md)) |
| `<key>.json.aside-<pid>-<rand>` | a lock moved aside while it is checked before removal; lives milliseconds |
| `<key>.presence.saved.json` | a presence mark put aside by "Yes, take it", restored after the run |
| `<node>.probe.json` | the last probe of a node |
| `events.jsonl` | `TAKE WAIT GO FREE BREAK LEAVE ASK GRANT DECLINE CANCEL RETURN CONFLICT`, tied by token |
| `log.txt` | the same events for people |
| `chats/<session>.json`, `chats.jsonl` | chat status for the board |

`<key>` is the resource id (`cpp`), or `<project>~<id>` for a project resource (`MyGame~editor`).

## Records

```json
{
  "v": 1, "resource": "cpp", "token": "3f9a1c0b2e7d", "mode": "script",
  "chat": "Fix the cook crash", "session": "b2e1d3c5-...", "agent": "codex",
  "pid": 23884, "pidStart": 1792159641000, "ownerPid": 0, "ownerPidStart": 0,
  "machine": "studio", "node": "", "script": "build.ps1", "note": "Editor Development",
  "since": 1792159641123, "ttlMin": 90, "expires": 1792165041123
}
```

- `since`, `expires`, `heartbeat`, `pidStart` are **integer milliseconds** since the epoch. No string comparison of
  dates anywhere.
- `mode` is the holder kind: `script` (lives while `pid` lives), `hold` (lives while the agent process `ownerPid`
  lives, or until its TTL), `node-chat` (a chat on a node, held through the board), `presence` (a person; TTL only),
  `gate` (only ever a waiter: a tool call waiting without taking).
- A waiter record is the same shape plus `heartbeat`, and `blocked: "human"` + `blockedAt` while a person is in its way.

## 1. Take

Write the full record to a temporary file, then **hard-link** it to `<key>.json`. `link()` is atomic and fails with
`EEXIST` if the name exists, so a reader sees either no file or the complete record. On volumes without hard links
the client falls back to `open(O_CREAT|O_EXCL)` ("CreateNew" in .NET, `wx` in Node); a reader that finds an
unreadable file younger than 10 s treats it as being written, older as stale.

Before creating, a client checks, in this order:

1. the current lock: mine (same token from `UAH_TOKEN_<KEY>`, or my chat's hold) -> re-entrant, done;
2. stale -> break it (step 2), then look again;
3. held -> wait (or, for a person's `presence`, pass if the caller is that machine's own chat);
4. a fresh `*.aside-*` file of this key exists -> someone is breaking it right now: wait;
5. something outside the store makes the resource busy (a person at the machine, by probe) -> wait;
6. a live waiter ranks before me in the queue (step 3) -> wait.

## 2. Break a stale lock

Never "read, decide, delete": between the read and the delete someone may have replaced it.

1. `rename(<key>.json, <key>.json.aside-<pid>-<rand>)` - atomic; only one breaker wins it.
2. Read the moved file. If its token is the one judged stale and it is still stale, delete it. Done.
3. Otherwise (a fresh lock was written meanwhile) `link()` it back to `<key>.json` - which never overwrites - and
   delete the aside name.

Takers do not create a lock while a fresh aside file exists (step 1.4), so the link-back normally succeeds. If it
cannot (a taker created a lock in the microseconds before seeing the aside file), the client logs `CONFLICT` and
drops the moved lock; its owner finds the token mismatch on release. With advisory locks among friendly clients
this is accepted and documented, not hidden.

Release uses the same rename-aside step with "the token is still mine" as the check, so a holder whose lock expired
and was taken over never deletes the new holder's lock.

## 3. Queue

A waiter writes `<key>.wait.<token>.json` and refreshes its `heartbeat` every poll (2 s for scripts, 3 s for node
chats). The serving order is computed by every client from the same files:

1. effective priority, highest first: base priority by `mode` (`presence 100`, `node-chat 50`, `hold 40`,
   `script 30`, `gate 30`; a waiter's own `priority` overrides) **plus** `aging.step` for every `aging.everyMin`
   minutes waited (default +10 per 10 minutes);
2. then the earlier `since`;
3. then the smaller token.

A waiter marked `blocked` (a person is in its way, refreshed within 20 s) is skipped by others: the queue stays
work-conserving. Priorities only order the queue; a holder is never pushed out.

A pool (`role:runner`) writes one waiter file with the same token on every member and takes the first member where
it may; then it removes the others.

## 4. Stale

A lock is stale when:

- its `expires` has passed (TTL);
- `script`: its `pid` is dead, or alive with a different start time (pids are reused) - judged only on the machine
  in `machine`;
- `hold`: its `ownerPid` (the agent process) is dead in the same sense; without an `ownerPid`, only the TTL;
- `node-chat`: its TTL, which every event of that chat extends; the board also frees it on the chat's Stop/SessionEnd;
- `presence`: its TTL only.

A waiter is dead when its heartbeat is older than 20 s and its pid (if local) is gone; dead waiter files are
removed after 10 s.

## 5. Journal

`events.jsonl` - one JSON line per event, `t` in milliseconds:

```json
{"t":1792159641123,"kind":"TAKE","res":"cpp","token":"3f9a1c0b2e7d","mode":"script","chat":"...","session":"...","agent":"codex","pid":23884,"script":"build.ps1","note":"","machine":"studio","node":""}
```

`WAIT` -> `GO`/`LEAVE` and `TAKE` -> `FREE`/`BREAK` are tied by token; the board draws the timeline from them.

## Writing a client in another language

1. Resolve the folder (`UAH_HOME`), the key and the TTL from `hub config --json` or the config files.
2. Take: write a temp file, `link` it to `<key>.json`; on `EEXIST`, read and apply section 1.
3. Wait: write and refresh your waiter file; poll every 1-3 s; compute the order of section 3.
4. Release: rename-aside, check the token, delete or link back.
5. Append to `events.jsonl` (`O_APPEND`, one line) and `log.txt`.

Or simply call `hub take <res> --pid <your pid>` / `hub free <res> --token <t>` and let the Node client do it - that is
what the PowerShell module does.
