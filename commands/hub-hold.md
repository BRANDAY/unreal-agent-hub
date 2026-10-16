---
description: Hold a shared resource for this chat across several steps (Unreal Agent Hub)
argument-hint: <resource> [note]
---

Hold the resource `$ARGUMENTS` for this chat with the `hub_hold` tool (resource = the first word, note = the
rest). If it is busy, say who holds it and how long the queue is; do not stop anyone's processes. Remind the
person that `hub_release` (or `/hub-release`) frees it, and that it also ends with this chat or its TTL.
