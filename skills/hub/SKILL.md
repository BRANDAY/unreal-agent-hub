---
name: hub
description: Use Unreal Agent Hub correctly when this chat needs a shared resource - the Unreal editor, a C++ build, a cook, a GPU machine or another computer - or when a heavy launch was denied or is waiting with "Resource ... is busy". Covers hub_status, hub_hold / hub_release (or `hub hold` / `hub release`), `hub lock <res> -- <cmd>`, and answering "may I take your machine?" requests only with the person's own words.
---

# Unreal Agent Hub in a chat

Several chats and scripts share a few things that only one may use at a time. The hub keeps the queue; hooks
make heavy calls wait by themselves. What this chat should do:

1. **Before heavy work, look:** `hub_status` (MCP) or `hub status`. It shows who holds each resource, who waits
   (in priority order) and requests waiting for a person.
2. **A chain of steps that must not be interrupted** (save -> close the editor -> build -> start it): hold the
   resource first, release it at the end.
   - MCP: `hub_hold { "resource": "editor", "note": "rebuild cycle" }` ... `hub_release { "resource": "editor" }`
   - shell: `hub hold editor --note "rebuild cycle"` ... `hub release editor`
   A hold also ends when this chat ends or its TTL is over.
3. **One command that needs a resource:** `hub lock cpp -- <command>` - waits its turn, runs, releases.
   Nested `hub lock` calls of the same command pass through.
4. **When a call was denied with "Resource ... is busy":** do other work and try later. Never stop, kill or
   close processes you did not start, and never break someone else's lock; `hub break --force` exists only
   for the owner of that work.
   **"... is being edited by chat X":** another chat holds that file until its change is committed. Ask that
   chat (or the person) to make the change or to commit; do not route around it with shell edits, and
   `hub claims release` only at the person's word. Edit shared files with the edit tools, not `sed -i`.
5. **Someone else's machine:** if a person sits at the machine you need, your run waits and the board asks
   them. Answer a request with `hub_grant` / `hub_decline` **only** when the person said so in this chat
   ("yes, take it" / "not now"); never decide for them.
6. Presence: when the person says they are at a machine, `hub_here { "machine": "<id>" }`; when they leave,
   `hub_here { "machine": "<id>", "on": false }`.

Resource names: an id (`cpp`), a project resource (`editor`), `@machine` (this machine), `@node:<id>`, or a
pool `role:runner` (the first free runner).
