// Detector "unreal-editor": project and start time of running Unreal editors, from their command lines. Called
// only when an editor runs (on Windows a PowerShell call costs about a second).
'use strict';
const cp = require('child_process');

function details(pids) {
  const out = {};
  if (!pids || !pids.length) return out;
  try {
    if (process.platform === 'win32') {
      const ps = "Get-CimInstance Win32_Process -Filter \"Name like 'UnrealEditor%'\" | ForEach-Object { '{0}|{1}|{2}' -f $_.ProcessId, $_.CreationDate.ToUniversalTime().ToString('o'), $_.CommandLine }";
      const t = cp.execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
      for (const line of t.split(/\r?\n/)) {
        const m = line.match(/^(\d+)\|([^|]*)\|(.*)$/);
        if (m) out[+m[1]] = { since: Date.parse(m[2]) || 0, project: project(m[3]) };
      }
    } else {
      const t = cp.execFileSync('ps', ['-o', 'pid=,lstart=,args=', '-p', pids.join(',')], { encoding: 'utf8', timeout: 10000 });
      for (const line of t.split('\n')) {
        const m = line.trim().match(/^(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/);
        if (m) out[+m[1]] = { since: Date.parse(m[2]) || 0, project: project(m[3]) };
      }
    }
  } catch (_) {}
  return out;
}

function project(cmdline) { return (String(cmdline).match(/([^"\\/]+)\.uproject/i) || [])[1] || ''; }

module.exports = { details, project };
