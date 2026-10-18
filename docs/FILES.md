# File gate: one chat per shared file, no edits under a running build

Resource locks keep two chats from building or cooking at the same time. They do not stop two chats from editing
the same file: each reads it, each writes its own version, and lines land in the wrong places or vanish. Nor do
they stop a chat from editing a `.cpp` while another chat's build or cook is compiling that tree. The file gate
closes both gaps. It runs in the `PreToolUse` hook for file edits and is configured per profile and per project.

## The two rules

**Build files wait for the build.** An edit of a file the build compiles (`Source/**`, `*.Build.cs`, the
`.uproject`, ...) waits while *another* chat or script holds the build resource (`buildResource`, `cpp` by
default). The build sees one consistent tree; the edit goes on as soon as the resource is free. The chat's own
build never holds it back (a lock whose session is the editing chat passes). After `gateWaitSec` (25 min by
default) the edit is denied with the holder's name, like every other gate. The wait takes nothing and queues
nothing: it is the same `gateWait` that the profile's `mode: "wait"` gates use, so the board shows the chat as
waiting for `cpp`.

**A shared file belongs to the first chat that edits it.** The first chat to edit a watched file (a build file or
a `claim` path) claims it. While that chat's changes are not committed, another chat's edit of the file is denied:

```
Tools/run.py is being edited by chat "Fix the smoke test" (claimed 14:02, last edit 14:31); its changes are not
committed yet. Two chats in one file overwrite each other, so this edit is refused. Ask that chat to make the
change or to commit first. Freeing the claim by hand is for the person in charge: hub claims release "Tools/run.py"
```

Different files stay free, also inside one folder. A claim ends by itself when:

- the file is **clean** against `HEAD` (committed or reverted), after a grace of `cleanGraceSec` (120 s) from the
  holder's last edit: a claim is written before its edit lands, and the edit may still be waiting for a
  permission prompt;
- a commit that touches the file, reachable from one of the **`mergedInto`** branches (`main`, `master`,
  `origin/main`, `origin/master`; missing ones are skipped), is at least as new as the holder's last edit. The
  holder's work is merged, even if the file is dirty again from someone else. A task branch counts once it is
  merged;
- the holder has not edited the file for **`claimHours`** (6).

The holder's next edit takes the claim over again with a fresh time; any other chat takes over a claim that has
ended. Outside a git repository a claim ends only by `claimHours` or by hand.

## Configuration

A `files` block in a profile gives the defaults; the same block in the project overlay `.unreal-agent-hub.json`
replaces single keys on top of it, and `"files": false` turns the gate off for that project. A profile without a
`files` block (such as `generic`) has no gate until an overlay adds one.

```json
"files": {
  "build": ["Source/**", "Plugins/**/Source/**", "Plugins/**/*.uplugin", "*.uproject", "**/*.Build.cs", "**/*.Target.cs"],
  "buildResource": "cpp",
  "claim": ["Config/*.ini"],
  "free": ["**/*.md"]
}
```

| Key | Default | Meaning |
|---|---|---|
| `build` | `[]` | What the build compiles. These files wait for `buildResource` and are claimed |
| `buildResource` | `"cpp"` | Resource name the build scripts take (`hub lock cpp -- build.bat`). If it does not resolve to a known resource, nothing waits |
| `claim` | `[]` | Other shared files that are claimed but do not wait for the build |
| `free` | `[]` | Never claimed and never waiting, even if `build` or `claim` match (notes every chat appends to, a version file every chat bumps) |
| `claimHours` | `6` | A claim without an edit by its holder for this long ends |
| `cleanGraceSec` | `120` | A claim on a clean file stays this long after the holder's last edit |
| `mergedInto` | `["main","master","origin/main","origin/master"]` | Branches whose commits end a claim |

The `unreal` profile ships the block above. A project overlay that also claims its scripts and keeps the version
file free:

```json
{
  "project": "MyGame",
  "files": {
    "claim": ["Config/*.ini", "Scripts/**", "Tools/**", "Content/Python/**"],
    "free": ["**/*.md", "Config/DefaultGame.ini"]
  }
}
```

Patterns are relative to the project root (the overlay's folder, otherwise the folder of the profile's marker such
as the `.uproject`), use `/`, and are case-insensitive: `**/` is any number of folders (also none), `**` anything,
`*` anything but `/`, `?` one character but `/`. Files outside the project root (another worktree, another
project) are not watched by this project's rules; each worktree has its own files and its own claims.

## Commands

```bash
hub claims                       # every claim on this machine: held or over (and why), file, chat, times
hub claims --json
hub claims release Tools/run.py  # free one by hand (path relative to the current folder, or absolute)
```

Releasing someone's claim by hand lets the next chat write over work that is not committed yet: ask the holder (or
the person in charge) first. The hub log (`state/log.txt`) records `CLAIM`, `CLAIMDENY`, `CLAIMTAKE`, `CLAIMEND`,
`CLAIMRELEASE`, `SRCGO` and `SRCDENY` lines.

## Packaging holds the build and the cook

A cook loads the editor's modules and builds the game target. If another chat rebuilds the editor in the middle of
it, the cook runs on half-replaced binaries. So a packaging run holds the build resource for its whole length, not
only the cook resource, and edits of build files wait for it as well:

```bash
hub lock cpp,cook --ttl 180 -- RunUAT.bat BuildCookRun -project=MyGame.uproject -cook -build -stage -pak
```

```powershell
Invoke-HubLocked cpp, cook { & .\Tools\package.ps1 } -TtlMin 180
```

Several resources are taken one after another in the order given and released in reverse. Keep one order
everywhere (`cpp` before `cook`) and two scripts never wait on each other.

## Where it works and where it does not

| Agent | Edits seen | How |
|---|---|---|
| Claude Code | `Edit`, `Write`, `MultiEdit`, `NotebookEdit` | `PreToolUse` matcher of the plugin and of `install-hooks` |
| Codex | `apply_patch` (paths from the patch headers) | `PreToolUse` matcher of `install-hooks`; unverified on a live install |
| Cursor | none by default | Cursor's `preToolUse` payload is read if you route it to the hub yourself; `install-hooks` does not install it |

- Edits through a shell (`sed -i`, a Python rewrite, a generator script) are not seen. Edit watched files with the
  agent's edit tools.
- The gate runs on the hub and on standalone machines, not on nodes (`role: node`): a node's claims would be local
  to it anyway, and its build resource lives on the hub.
- The board does not show claims yet; `hub claims` does.
- Like every hub hook the gate fails open: an error lets the edit through.
