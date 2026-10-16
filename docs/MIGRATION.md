# Migrating from home-grown lock scripts

This page shows how to move a project from its own lock scripts to Unreal Agent Hub in small, reversible steps. It is written for the common home-grown setup: one PowerShell `lock.ps1` that uses a named mutex and lock files inside the repository, a few helper functions called from about a dozen scripts, a small board server, a node agent installed as global agent hooks on a second machine, and one JSON config for machines and resources. If yours looks different, the steps still apply; only the names change.

## What you start from

| Piece in the old setup | Typical form | Replaced by |
|---|---|---|
| Lock files | `dev/locks/<res>.json` and `<res>.wait.<token>.json` in the repository | The state folder `~/.unreal-agent-hub/state/` (same naming: `<key>.json`, `<key>.wait.<token>.json`) |
| Mutual exclusion while editing those files | A named Windows mutex | Nothing. The store uses three atomic file operations (create-if-absent, rename, link-back) and the rename-aside protocol described in [PROTOCOL.md](PROTOCOL.md) |
| `Enter-XLock` / `Exit-XLock` in many scripts | PowerShell functions | `Enter-HubLock` / `Exit-HubLock` ([POWERSHELL.md](POWERSHELL.md)) |
| Token passed to nested scripts | An environment variable per resource | `UAH_TOKEN_<KEY>` |
| Board server | A Node or PowerShell script and an HTML page | `hub serve` ([BOARD.md](BOARD.md)) |
| Node agent as global hooks on the second machine | `hub-agent.cjs` in the user's agent settings | The plugin or `hub install-hooks` with `role: "node"` ([AGENTS.md](AGENTS.md)) |
| Resource list | `hub.config.json` | `~/.unreal-agent-hub/config.json` plus `.unreal-agent-hub.json` in each project ([CONFIG.md](CONFIG.md)) |

## Differences to know before you start

- The store moves out of the repository into `~/.unreal-agent-hub/state` (`UAH_HOME` moves it). Lock files no longer travel with the repo, are not committed, and are shared by every project on the machine.
- `since` and `expires` in lock and waiter files are integer milliseconds since the epoch. Anything that reads the old files (dashboards, scripts) must be pointed at the new store or updated.
- There is no mutex any more. Old and new systems do not see each other's locks, so never run both against the same resource at the same time; the steps below avoid that.
- Priorities, aging, presence and handover requests are new ([ROLES.md](ROLES.md), [HANDOVER.md](HANDOVER.md)). The default behaviour of a plain `Enter-HubLock` is the old one: wait for your turn.

## Step 1: install side by side

Install Node.js 18 or newer and the package (`npm i -g unreal-agent-hub`, or the Claude Code plugin). Do not touch the old scripts yet. Try the hub in a scratch home on another port, so it cannot collide with anything:

```powershell
$env:UAH_HOME = "$env:TEMP\uah-trial"
hub serve --port 8791
```

Open `http://127.0.0.1:8791`, run `node examples/demo.cjs --port 8792` if you want to see a populated board, then close both.
Rollback: delete the scratch folder and uninstall the package; nothing else changed.

## Step 2: write the configuration with the same resource names

Translate the old config one to one. Machine-wide resources go into `~/.unreal-agent-hub/config.json`; resources that belong to one project go into `<project>/.unreal-agent-hub.json`. Keep the old names so scripts need no edits:

```json
{ "role": "hub", "id": "main", "roles": ["hub", "build", "workstation"],
  "resources": [ { "id": "cpp", "ttlMin": 90 } ],
  "nodes": [ { "id": "laptop", "ssh": "laptop", "tunnelPort": 18791, "roles": ["runner", "workstation"],
               "resources": [ { "id": "laptop", "ttlMin": 180 } ], "token": "..." } ] }
```
```json
{ "project": "MyGame", "profile": "unreal",
  "resources": [ { "id": "cook", "ttlMin": 180 }, { "id": "smoke", "ttlMin": 90 }, { "id": "editor", "ttlMin": 30 } ] }
```

Project resources get the key `MyGame~cook`; the bare name `cook` still works inside the project. Map old ttl values to `ttlMin`. Put `"profile": "unreal"` in the overlay if the project should get the Unreal profile's gates ([PROFILES.md](PROFILES.md)). Check with `hub config` and `hub status`.
Rollback: delete the two files.

## Step 3: turn the old `lock.ps1` into a shim

Keep the file name and the function names, so the ~13 scripts keep working, and make it forward to the hub. During the transition set both token variables, old and new, so a script that still reads the old variable keeps working:

```powershell
# lock.ps1 - shim over Unreal Agent Hub
Import-Module "$env:USERPROFILE\.unreal-agent-hub\ps\AgentHub.psm1" -Force

$script:NameMap = @{ 'cpp' = 'cpp'; 'cook' = 'MyGame~cook'; 'laptop' = '@node:laptop' }   # old name -> hub name

function Enter-XLock {
    param([Parameter(Mandatory, Position = 0)][string]$Resource, [switch]$NoWait, [int]$TtlMin = 0, [string]$Note = '')
    $name = if ($script:NameMap.ContainsKey($Resource)) { $script:NameMap[$Resource] } else { $Resource }
    $h = Enter-HubLock $name -NoWait:$NoWait -TtlMin $TtlMin -Note $Note
    if (-not $h.Reentrant) { [Environment]::SetEnvironmentVariable("XLOCK_TOKEN_$($Resource.ToUpper())", $h.Token) }  # old name
    return $h
}
function Exit-XLock($Handle) {
    Exit-HubLock $Handle
    if ($Handle) { [Environment]::SetEnvironmentVariable("XLOCK_TOKEN_$($Handle.Resource.ToUpper())", $null) }
}
```

Before switching, make sure no old lock is held (the old board or `lock.ps1 status` shows nothing busy), then replace the file. From now on every script uses the new store. Callers need no edits, and later you can replace `Enter-XLock` by `Enter-HubLock` file by file and delete the shim.
Rollback: restore the old `lock.ps1` from git; wait until no hub lock is held (`hub status`).

## Step 4: replace the project hooks

The old project had hooks that gated the editor tools, wrote chat status for the board and started the board server. Remove them from the project's `.claude/settings*.json` and use the plugin instead (`/plugin install unreal-agent-hub`), or write the same hooks with `hub install-hooks --agent claude`. Gates that were hard-coded move into the overlay's `gates`, for example:

```json
"gates": [ { "tools": "^mcp__unreal-mcp__", "resource": "editor", "mode": "wait" } ]
```

Open a chat in the project and run `hub status`: the chat appears on the board and heavy calls wait for their resource.
Rollback: re-add the old hook entries and remove the hub's (`hub install-hooks --agent claude --uninstall`).

## Step 5: nodes

On each second machine: install Node.js and the package or plugin, set role `node` (plugin option `role`, or `"role": "node"` in `~/.unreal-agent-hub/config.json`), put in the token printed by `hub node add <id>`, and remove the old node agent's global hooks from that machine's agent settings. Never leave both: the old and new agents would each gate the same tool calls. Make sure `ssh <alias> node .unreal-agent-hub/bin/hub.cjs probe` prints JSON ([TRANSPORTS.md](TRANSPORTS.md)). The hub keeps the tunnel itself; any old tunnel script or scheduled task is no longer needed. Ssh keys stay exactly as they are.
Rollback per node: reinstall the old agent hooks, remove the hub's, set the node's role back or uninstall.

## Step 6: retire the old board

When the new board has run for a few days without surprises: stop the old board server and its auto-start (scheduled task, hook, shortcut), remove its code, and delete the old `dev/locks` folder from the repository and from `.gitignore` if it is no longer needed. Point bookmarks to `http://127.0.0.1:8790`.
Rollback: restore the old board files from git and start it; the hub keeps working beside it, because it reads only its own store.

## After the move

- Run `hub doctor` on every machine.
- Decide on handover (`handover.ask`), presence and priorities; the defaults suit most teams ([ROLES.md](ROLES.md)).
- Let people use `hub lock <res> -- <command>` from the shell, and add the short block from `AGENTS.snippet.md` to the project's `AGENTS.md` or `CLAUDE.md` ([AGENTS.md](AGENTS.md)).
- See [SECURITY.md](SECURITY.md) for what the tokens and the Host check protect.
