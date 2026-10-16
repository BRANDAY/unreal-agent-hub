// Detector "gpu": video memory and load. Only nvidia-smi is supported today; other cards report null.
'use strict';
const cp = require('child_process');
const path = require('path');

function nvidia() {
  try {
    const opt = { encoding: 'utf8', windowsHide: true, timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] };
    const q = cp.execFileSync('nvidia-smi', ['--query-gpu=name,memory.used,memory.total,utilization.gpu', '--format=csv,noheader,nounits'], opt);
    const [name, used, total, util] = q.trim().split(/\r?\n/)[0].split(',').map(s => s.trim());
    let apps = [];
    try {
      apps = cp.execFileSync('nvidia-smi', ['--query-compute-apps=pid,process_name', '--format=csv,noheader'], opt)
        .trim().split(/\r?\n/).filter(Boolean).map(l => { const [pid, p] = l.split(',').map(s => s.trim()); return { pid: +pid, name: path.basename(p || '') }; });
    } catch (_) {}
    return { name, usedMB: +used, totalMB: +total, util: +util, apps };
  } catch (_) { return null; }
}

function detect(kind) {
  if (kind === false || kind === 'none') return null;
  return nvidia();
}

module.exports = { detect, nvidia };
