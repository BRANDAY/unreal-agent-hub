// Detector "load": a workstation is busy when other applications ate the machine, even with no Unreal open.
// busyAbove: { gpuMemPct: 85, gpuUtilPct: 90, cpuPct: 90 } - any threshold crossed makes the machine busy.
'use strict';
const os = require('os');

function cpuTimes() { return os.cpus().map(c => { const t = c.times; return { idle: t.idle, total: t.user + t.nice + t.sys + t.idle + t.irq }; }); }

/** CPU load in percent over `ms` milliseconds. */
async function cpuPct(ms) {
  const a = cpuTimes();
  await new Promise(r => setTimeout(r, ms || 500));
  const b = cpuTimes();
  let idle = 0, total = 0;
  for (let i = 0; i < a.length; i++) { idle += b[i].idle - a[i].idle; total += b[i].total - a[i].total; }
  return total > 0 ? Math.round((1 - idle / total) * 100) : 0;
}

/** {busy, why[]} for a probe's numbers and the profile's thresholds. */
function judge(busyAbove, sample) {
  const why = [];
  if (!busyAbove) return { busy: false, why };
  const g = sample.gpu;
  if (g && g.totalMB && busyAbove.gpuMemPct != null) {
    const p = Math.round(g.usedMB / g.totalMB * 100);
    if (p >= busyAbove.gpuMemPct) why.push(`video memory ${p}% >= ${busyAbove.gpuMemPct}%`);
  }
  if (g && busyAbove.gpuUtilPct != null && g.util >= busyAbove.gpuUtilPct) why.push(`GPU load ${g.util}% >= ${busyAbove.gpuUtilPct}%`);
  if (sample.cpuPct != null && busyAbove.cpuPct != null && sample.cpuPct >= busyAbove.cpuPct) why.push(`CPU ${sample.cpuPct}% >= ${busyAbove.cpuPct}%`);
  return { busy: why.length > 0, why };
}

module.exports = { cpuPct, judge };
