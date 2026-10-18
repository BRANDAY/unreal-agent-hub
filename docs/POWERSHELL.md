# PowerShell module

This page documents `ps/AgentHub.psm1`, the PowerShell wrapper that lets build and test scripts take a shared resource the way `flock` does, with four functions: `Enter-HubLock`, `Exit-HubLock`, `Get-HubStatus` and `Invoke-HubLocked`. The module only wraps `hub.cjs`; Node.js 18 or newer must be installed. For the command line itself see [CLI.md](CLI.md).

## Quick start

```powershell
Import-Module (Join-Path $env:USERPROFILE '.unreal-agent-hub\ps\AgentHub.psm1')

$lock = Enter-HubLock cpp -Note "$Target $Config"   # waits its turn
try {
    & .\Build.bat MyGameEditor Win64 Development
} finally {
    Exit-HubLock $lock                                # always release
}
```

Use the `try` / `finally` pattern every time. If the script is killed before `finally` runs, the lock is not lost for ever: it belongs to the PowerShell process, and once that process is gone the next taker finds the lock stale and removes it. `finally` just frees the resource sooner.

The module file can also be imported from the package folder (`ps\AgentHub.psm1` next to `bin\`), for example from a clone of the repository.

## Functions

### `Enter-HubLock <Resource> [options]`

Takes the resource for the running script. It calls `hub take <Resource> --pid <PID> --script <calling script file name>` and parses the JSON answer.

| Parameter | Maps to | Meaning |
|---|---|---|
| `-Resource` (position 0) | resource name | Any name from [CONFIG.md](CONFIG.md#resource-names) |
| `-NoWait` | `--no-wait` | Throw at once if busy |
| `-TtlMin N` | `--ttl N` | Lifetime in minutes |
| `-Note TEXT` | `--note` | Shown on the board |
| `-WaitMin N` | `--wait-min` | Give up after N minutes |
| `-Priority N` | `--priority` | Override the queue priority (0 or more) |
| `-Chat NAME` | `--chat` | Chat name on the board |
| `-Ask` / `-NoAsk` | `--ask` / `--no-ask` | Force or forbid a handover request |

It returns a handle object with `Resource`, `Key`, `Token` and `Reentrant`. If the resource cannot be taken (busy with `-NoWait`, wait timed out, unknown name) it throws `[hub] <resource> : <reason>`. A script that wants to continue without the lock catches it:

```powershell
try { $lock = Enter-HubLock cook -NoWait } catch { Write-Warning $_; return }
```

On success it prints `[hub] took <key> after N min (TTL M min).` (the "after" part only when it waited more than six seconds).

### `Exit-HubLock <Handle>`

Releases what `Enter-HubLock` took through `hub free`, clears the token variable and prints the result. A re-entrant handle, or `$null`, releases nothing, so calling it in `finally` is always safe.

### `Get-HubStatus`

Returns the parsed output of `hub status --json`: one object per resource with `key`, `label`, `scope`, `node`, `holder`, `queue`, `asks` and `machine`.

```powershell
Get-HubStatus | Where-Object { $_.holder } | Select-Object key, @{n='who';e={ $_.holder.text }}
```

### `Invoke-HubLocked <Resource[]> <ScriptBlock> [-Note] [-NoWait] [-TtlMin]`

Takes the resource, runs the block, and always releases:

```powershell
Invoke-HubLocked cook { & .\Tools\package.ps1 } -Note "nightly"
```

Several resources are taken in the order given and released in reverse; if one cannot be taken, the ones already
taken are released before the error comes out. A packaging run holds the build for its whole length, because the
cook loads the editor's modules ([FILES.md](FILES.md#packaging-holds-the-build-and-the-cook)):

```powershell
Invoke-HubLocked cpp, cook { & .\Tools\package.ps1 } -TtlMin 180   # always cpp before cook
```

The same by hand: `$cpp = Enter-HubLock cpp -TtlMin 180; $cook = Enter-HubLock cook; try { ... } finally { Exit-HubLock $cook; Exit-HubLock $cpp }`.

## Nesting

When `Enter-HubLock` succeeds it sets the process environment variable `UAH_TOKEN_<KEY>` (key upper-cased, every character outside `A-Z0-9` turned into `_`; `cpp` gives `UAH_TOKEN_CPP`, `MyGame~cook` gives `UAH_TOKEN_MYGAME_COOK`). Child processes inherit it. A script started from inside the lock that calls `Enter-HubLock` for the same resource finds its own token, gets a re-entrant handle and passes straight through instead of waiting for its parent. `Exit-HubLock` on that inner handle does nothing, and the outer script frees the lock. The same variable is set by `hub lock`, so shell and PowerShell nesting mix freely.

## How `hub.cjs` is found

The module looks in this order:

1. `$env:UAH_HUB_CJS`, if it points to an existing file;
2. `<UAH_HOME or ~\.unreal-agent-hub>\bin\hub.cjs` (the shim written by the first `SessionStart` hook or by `hub install-hooks`);
3. `..\bin\hub.cjs` relative to the module file.

Set `UAH_HUB_CJS` when the shim does not exist yet (a fresh machine, a CI agent) or when you want a specific version.

## Windows PowerShell 5.1

The module runs on Windows PowerShell 5.1 and PowerShell 7. While a script waits, `hub.cjs` writes `[hub] cpp is busy: ... Waiting` lines to stderr about once a minute. In 5.1 those lines appear on the console as the "waiting" messages and are not captured into the module's output; the JSON answer is read from stdout only. Do not redirect `2>&1` around `Enter-HubLock`: in 5.1 it would turn each stderr line into an error record. Run the script normally, or redirect only the work inside the `try`.

## Moving old scripts

A thin `Enter-XLock` / `Exit-XLock` shim that forwards to these functions is the usual way to adopt the hub without editing every script; see [MIGRATION.md](MIGRATION.md).
