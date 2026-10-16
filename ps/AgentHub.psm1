# Unreal Agent Hub for PowerShell scripts: take a shared resource for the running script, like flock(1).
#
#   Import-Module (Join-Path $env:USERPROFILE '.unreal-agent-hub\ps\AgentHub.psm1')   # or this file's path
#   $lock = Enter-HubLock cpp -Note "$Target $Config"          # waits its turn; -NoWait fails at once
#   try { ...the work... } finally { Exit-HubLock $lock }
#
# The lock belongs to this PowerShell process: if it dies, the lock is stale and the next taker drops it.
# A nested script started from here passes straight through (the token travels in $env:UAH_TOKEN_<RESOURCE>).
# Everything is done by hub.cjs (Node.js >= 18); this module only wraps it.

function Get-HubCli {
    if ($env:UAH_HUB_CJS -and (Test-Path $env:UAH_HUB_CJS)) { return $env:UAH_HUB_CJS }
    $home1 = if ($env:UAH_HOME) { $env:UAH_HOME } else { Join-Path $env:USERPROFILE '.unreal-agent-hub' }
    $shim = Join-Path $home1 'bin\hub.cjs'
    if (Test-Path $shim) { return $shim }
    return (Join-Path $PSScriptRoot '..\bin\hub.cjs')
}

function Invoke-HubCli([string[]]$Arguments) {
    $cli = Get-HubCli
    # stderr (the "waiting for ..." lines) goes straight to the console; stdout is the answer.
    $out = & node $cli @Arguments
    return [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = ($out -join "`n") }
}

function Get-HubTokenVariable([string]$Key) {
    return 'UAH_TOKEN_' + (($Key.ToUpperInvariant()) -replace '[^A-Z0-9]', '_')
}

function Enter-HubLock {
    <#
    .SYNOPSIS
    Takes a shared resource for this script, waiting in the queue while someone else has it.
    .OUTPUTS
    A handle for Exit-HubLock.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory, Position = 0)][string]$Resource,
        [switch]$NoWait,
        [int]$TtlMin = 0,
        [string]$Note = '',
        [int]$WaitMin = 0,
        [int]$Priority = -1,
        [string]$Chat = '',
        [switch]$Ask,
        [switch]$NoAsk
    )
    $caller = (Get-PSCallStack | Select-Object -Skip 1 -First 1).ScriptName
    $script = if ($caller) { Split-Path $caller -Leaf } else { 'powershell' }
    $a = @('take', $Resource, '--pid', "$PID", '--script', $script)
    if ($NoWait) { $a += '--no-wait' }
    if ($TtlMin -gt 0) { $a += @('--ttl', "$TtlMin") }
    if ($Note) { $a += @('--note', $Note) }
    if ($WaitMin -gt 0) { $a += @('--wait-min', "$WaitMin") }
    if ($Priority -ge 0) { $a += @('--priority', "$Priority") }
    if ($Chat) { $a += @('--chat', $Chat) }
    if ($Ask) { $a += '--ask' }
    if ($NoAsk) { $a += '--no-ask' }
    $r = Invoke-HubCli $a
    $j = $null
    try { $j = $r.Output | ConvertFrom-Json } catch {}
    if (-not $j -or -not $j.ok) {
        $why = if ($j -and $j.error) { $j.error } else { $r.Output }
        throw "[hub] $Resource : $why"
    }
    if (-not $j.reentrant -and -not $j.presence) {
        [Environment]::SetEnvironmentVariable((Get-HubTokenVariable $j.key), $j.token)
        Write-Host "[hub] took $($j.key)$(if ($j.waitedMs -gt 6000) { ' after {0:N1} min' -f ($j.waitedMs / 60000) }) (TTL $($j.ttlMin) min)."
    }
    return [pscustomobject]@{ Resource = $Resource; Key = $j.key; Token = $j.token; Reentrant = [bool]($j.reentrant -or $j.presence) }
}

function Exit-HubLock($Handle) {
    <# .SYNOPSIS Releases what Enter-HubLock took (a re-entrant handle releases nothing). #>
    if (-not $Handle -or $Handle.Reentrant) { return }
    $r = Invoke-HubCli @('free', $Handle.Key, '--token', $Handle.Token)
    [Environment]::SetEnvironmentVariable((Get-HubTokenVariable $Handle.Key), $null)
    Write-Host "[hub] $($r.Output)"
}

function Get-HubStatus {
    <# .SYNOPSIS Who holds each resource, who waits, and handover requests (as objects). #>
    $r = Invoke-HubCli @('status', '--json')
    return ($r.Output | ConvertFrom-Json)
}

function Invoke-HubLocked {
    <#
    .SYNOPSIS
    Runs a script block while holding a resource: Invoke-HubLocked cook { & .\package.ps1 }
    #>
    param([Parameter(Mandatory, Position = 0)][string]$Resource, [Parameter(Mandatory, Position = 1)][scriptblock]$Body, [string]$Note = '', [switch]$NoWait)
    $h = Enter-HubLock $Resource -Note $Note -NoWait:$NoWait
    try { & $Body } finally { Exit-HubLock $h }
}

Export-ModuleMember -Function Enter-HubLock, Exit-HubLock, Get-HubStatus, Invoke-HubLocked
