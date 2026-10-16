# Handover requests: "Yes, take it"

What happens when a run needs a machine that a person is using - and why nothing is ever taken from them.
Implementation: `lib/handover.cjs`, `lib/lock-client.cjs`, the board banner in `web/app.js`.

## The rule

A resource is **never** taken from a person. If a run (a script or a chat) needs a machine where someone sits - an
explicit presence mark ("I'm at Laptop") or a busy desktop found by the probe (Unreal open, GPU eaten) - the run
**queues and asks at the same time**. The person decides: close their Unreal, or press **Yes, take it**, or
**Not now**.

## Step by step

1. **Who asks.** Any waiter whose way is blocked by a person: the lock holder is a `presence` mark, or the probe
   says the desktop is busy. Scripts and chats never ask each other - they release on their own. Runs from another
   machine ask by default (`handover.ask: true`); `--no-ask` turns it off for one run, `--ask` forces it.
2. **The request.** `<key>.ask.<token>.json` with who asks, from which machine, what it will run (note, script,
   first 160 characters of the command), since when it waits, and why it is blocked. Event `ASK`.
3. **Where the person sees it.**
   - **The board** - the main place, one for everyone, on the hub. A banner at the top: "Studio PC asks for Laptop:
     Smoke tests for the loading screen - waiting 4 min", with **Yes, take it** and **Not now**. An open board tab
     also plays a short sound and shows a browser notification. The board can be opened on the node as well,
     through the same tunnel (`http://127.0.0.1:18791`).
   - **A chat** - answer in words in any chat that has the MCP server ("yes, take it" -> `hub_grant`, "not now" ->
     `hub_decline`), or `hub grant` / `hub decline` in a shell.
   - **Remote Control (optional)** - with `"notify": ["board", "remote-control"]` the request and the "yours again"
     notice also go to the hub's duty chat (`hub duty` in it), which can forward them over Claude's Remote Control
     to the chat where the person is, including a phone. Each delivered message costs one model turn there, so only
     these two events are sent. Today the messages are queued in `state/outbox.jsonl` and shown to the duty chat on
     its next turn; direct delivery through the session's messaging socket waits for a documented format.
   - **No programs on the node.** No tray apps, no windows of our own - by design.
4. **"Yes, take it" (GRANT).** A presence mark is put aside (`<key>.presence.saved.json`) and removed from the lock.
   If the person was "busy by probe" (Unreal open), the request becomes `granted`: the probe no longer stops **this
   one waiter**. Their processes are not touched; if their Unreal holds the video memory, the banner said so
   ("video memory in use: 11640 of 12288 MB") and it was their call.
5. **"Not now" (DECLINE).** The run stays in the queue, nothing is cancelled. It asks again after
   `askAgainMin` (default 15 minutes), or never with `askAgain: false`. The journal keeps "declined".
6. **The person closes Unreal.** That is an answer too: while a request is pending, the grace pause after closing
   (`graceMin`) is skipped and the run takes the machine at once (`skipGraceWhenAsked`).
7. **The run stops waiting** (`--wait-min` over, Ctrl+C, `--no-wait`): the request disappears (`CANCEL`).
8. **After the run - automatic.** The run releases the machine itself (`finally` in a script, Stop/SessionEnd of a
   chat; a crashed holder goes stale by pid or TTL). The hub then:
   - writes `RETURN` and a notice; the board shows "Smoke tests for the loading screen has finished - Laptop is
     yours again";
   - sends the same notice the same way as the request (Remote Control, if enabled);
   - puts the presence mark back if its TTL has not run out - the person is still there.
   A grant is for one run: the next run asks again.

## Configuration

```json
"handover": { "ask": true, "notify": ["board"], "askAgainMin": 15, "askAgain": true,
              "skipGraceWhenAsked": true, "restorePresence": true }
```

## Events

| Event | When |
|---|---|
| `ASK` | a blocked remote waiter asks (again after a decline: `times` grows) |
| `GRANT` | "Yes, take it" (board, `hub_grant`, `hub grant`) |
| `DECLINE` | "Not now" |
| `CANCEL` | the waiter left without the machine |
| `RETURN` | the granted run has finished; `restored` says whether presence came back |

The board's timeline shows them as dots on the machine's row.
