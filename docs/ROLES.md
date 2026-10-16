# Roles, presence and the queue

This page explains machine roles (hub, build, workstation, runner), pools of runners, how the hub decides that a person is using a machine, presence ("I am sitting here"), and how the queue decides who gets a resource next (`lib/roles.cjs`, `lib/presence.cjs`, `lib/queue.cjs`, `lib/lock-client.cjs`). Handover requests, which come into play when a person is in the way, are in [HANDOVER.md](HANDOVER.md).

## Machine roles

A machine can have several roles at once. Roles are listed in `roles` (the hub itself) and `nodes[].roles` ([CONFIG.md](CONFIG.md)).

| Role | Meaning | Typical machine |
|---|---|---|
| `hub` | Keeps the queue (the state folder) and the board. Exactly one machine | The main PC |
| `build` | Compiles and cooks; its resources are things like `cpp` and `cook` | The main PC |
| `workstation` | A person sits and works there, so remote runs must not trample them | A laptop that is also used by hand |
| `runner` | Runs games, tests and renders sent by other machines; can be addressed as a pool | A test laptop |

In the current code only `runner` (or any role name you write after `role:`) changes behaviour, through pools. The other role names are labels shown on the board. The busy detection below applies to every node that has a probe, whatever its roles say.

## Pools: `role:runner`

`role:<name>` names every machine resource whose machine has that role. The caller takes the first member that is free:

```bash
hub lock role:runner -- node run-smoke.js
```

How it works: the lock client tries the members in order (nodes in config order, then the hub's own resources if they are marked `"kind": "machine"`), and writes a waiter file on every member while none is free. The first member that can be taken wins, and the waiter files on the others are removed. A runner with a person at it counts as not free for remote callers and does not hold up the pool.

## Workstation busy: presence or probe

A node's machine resource is "taken by a person" for remote callers in either of two ways:

1. Presence: someone marked "I am here" (below). A presence mark is a lock with mode `presence`.
2. The probe says busy: the person's processes run on a desktop session, or the load is above the profile's `busyAbove` thresholds. Closing the work does not free the machine at once: the profile's `graceMin` pause (3 minutes for Unreal) counts from the last time processes were seen. A pending handover request ends the pause ("they agreed by closing it"). Details of what counts as a person's process: [PROFILES.md](PROFILES.md#who-counts-as-a-person-the-session-rule).

The check happens only when a remote caller (another machine) wants the resource and no lock already answers for it; the probe is at most 30 seconds old before a first attempt, and refreshed at most once a minute while waiting. An offline machine is not guessed about: the run is attempted and fails on its own transport. `UAH_NODE_PROBE=off` switches probing off. The hub's own desktop is not probed in the current code; for the hub's own machine only a presence mark expresses "a person is here".

## Presence

Presence says "I am sitting at this machine": remote runs queue and ask instead of taking the machine. Three ways to set it:

```bash
hub here laptop          # command line; --off removes it; --ttl N minutes
```
Or press the "I'm at <machine>" button on a node's card on the board, or call the `hub_here` MCP tool ([MCP.md](MCP.md)).

- The mark is a lock on the machine's resource with a TTL (`presenceTtlMin`, default 180 minutes). It disappears by itself.
- With no machine given, `operator.at` is used, then the hub's `id`. The machine needs a machine resource (`nodes[].resources`, or `machineResource` for the hub).
- If the resource is already busy with something else, the mark is refused ("the mark goes on when it is free"); it does not queue.
- The chats the person runs on that machine pass through the mark: a node's own chats and its hook gates are not blocked by it (the hub does this with `passPresence`). Only remote callers see "a person is here". The `presence.blocks` setting is reserved: the code does not read it and the behaviour is fixed.
- In the current code the pass-through applies to machine resources that belong to a node. On the hub's own `machineResource` a presence mark also stops the hub's own chats at their `@machine` gates (they wait until the mark ends). Treat this as a known gap until it is fixed.

## Priorities

Each waiter has a priority; the higher goes first.

| Kind of taker | Base priority |
|---|---|
| presence | 100 |
| node chat (a chat on another machine) | 50 |
| hold (`hub hold`, `hub_hold`, hook holds) | 40 |
| script (`hub lock`, `hub take`, PowerShell) | 30 |
| gate (a tool call waiting without taking) | 30 |

These are `priorities` in the config. A waiter may carry its own `--priority N`, which replaces the base. The presence value exists for completeness: a presence mark does not wait in the queue (see above).

Aging stops anything from starving: for every `aging.everyMin` minutes (10) of waiting, a waiter gains `aging.step` points (10). Effective priority = base + steps * step.

Ties go to the waiter that started waiting earlier, then to the smaller token, so every client reading the same files computes the same order.

No preemption: a priority only orders the queue. Nobody is ever pushed out of a lock they hold, and nothing in the hub stops a process.

## The queue is work-conserving

A waiter that cannot take the resource for its own reason does not hold back the others. If a remote run waits because a person sits at its machine, its waiter file is marked `blocked: human` (refreshed on every poll, about every 2 seconds). Waiters that are blocked this way, and were refreshed within the last 20 seconds, are skipped when deciding who is "ahead". Anyone else who can take the resource may go first, and the blocked one gets its place back when the person leaves or agrees. Waiters that have gone away (no heartbeat for 20 seconds and, on the same machine, their process is gone) are dropped from the queue.

## Who gets it next (plain language)

1. Whoever holds a resource keeps it until they finish, their process dies, or their TTL runs out. Waiting never takes it from them.
2. When it is free, everyone waiting looks at the line, about every two seconds. The one first in line takes it; the others see someone ahead and keep waiting.
3. The line is ordered by score. The score starts with the kind of taker: a chat on another machine 50, a hold 40, a script 30. Every 10 minutes of waiting adds 10.
4. If scores are equal, whoever started waiting first goes first.
5. Someone who cannot go because a person is at the machine is skipped, not waited for.
6. A chat gets the same resource again without waiting if it already holds it (nested scripts of the same lock pass through).

Example: a chat holds `cpp`. A script (score 30) has waited 30 minutes, so it now has 30 + 3 * 10 = 60 points. A hold request arrives (score 40). When `cpp` is freed, the script goes first. Had the hold arrived 30 minutes ago too, it would have 70 and go first. Long waiters win in the end.

## Checking what happens

`hub status` lists each resource's queue in this order with the effective priority and the waiting time, and marks waiters that wait for a person. The board shows the same, and [BOARD.md](BOARD.md) explains the timeline.
