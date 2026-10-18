<!-- Paste into AGENTS.md (Codex, Cursor) or CLAUDE.md of a project that uses Unreal Agent Hub. -->
## Shared resources (Unreal Agent Hub)

This project shares the editor, C++ builds, cooks and test machines with other agent chats and scripts.
- Before heavy work check the queue: `hub status` (or the `hub_status` MCP tool).
- One heavy command: `hub lock <resource> -- <command>` (waits its turn, runs, releases).
- Several steps that must not be interrupted: `hub hold <resource>` ... `hub release <resource>`
  (or `hub_hold` / `hub_release`).
- "Resource ... is busy" means: do other work and try later. Never stop processes you did not start and
  never break another holder's lock.
- "<file> is being edited by chat X" means: another chat holds that file until its change is committed. Ask
  that chat to make the change or to commit; edit shared files with the edit tools, not through the shell.
- Requests "may I take your machine?" are answered (`hub_grant` / `hub_decline`) only with the person's own words.
