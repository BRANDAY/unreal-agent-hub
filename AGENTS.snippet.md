<!-- Paste into AGENTS.md (Codex, Cursor) or CLAUDE.md of a project that uses Unreal Agent Hub. -->
## Shared resources (Unreal Agent Hub)

This project shares the editor, C++ builds, cooks and test machines with other agent chats and scripts.
- At the start of a task split the work into offline (scripts, data, C++ before the build, headless tools, documents),
  the editor and the test machine. Iterate offline or on a test level; take the editor for a concrete operation and
  the test machine for the final run.
- Before heavy work check the queue: `hub status` (or the `hub_status` MCP tool).
- One app-wide editor call (load a level, save all, Play-In-Editor) holds the editor for that call by itself. A
  sequence of such steps (load, change, save) still needs `hub hold editor` ... `hub release editor`.
- Before a required check ask whose build it runs on: `hub whose build --require` fails when another chat made it.
- A live Blender (its MCP tools) is shared the same way: `hub hold blender` while you work in it; headless Blender
  runs need no lock.
- One heavy command: `hub lock <resource> -- <command>` (waits its turn, runs, releases).
- Several steps that must not be interrupted: `hub hold <resource>` ... `hub release <resource>`
  (or `hub_hold` / `hub_release`).
- "Resource ... is busy" means: do other work and try later. Never stop processes you did not start and
  never break another holder's lock.
- "<file> is being edited by chat X" means: another chat holds that file until its change is committed. Ask
  that chat to make the change or to commit; edit shared files with the edit tools, not through the shell.
- Requests "may I take your machine?" are answered (`hub_grant` / `hub_decline`) only with the person's own words.
