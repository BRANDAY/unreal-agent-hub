// "What is this machine busy with right now", as one JSON object. The hub asks a node for it over its transport
// (`hub probe` over ssh) before a remote run takes the node, and when the board asks.
'use strict';
const processes = require('./processes.cjs');
const gpu = require('./gpu.cjs');
const unreal = require('./unreal-editor.cjs');
const load = require('./load.cjs');
const { hostname } = require('../util.cjs');

async function probe(cfg, profile, opts) {
  opts = opts || {};
  profile = profile || {};
  const busyCfg = profile.busy || {};
  const rows = opts.rows || processes.list();
  const { desktop, remote } = processes.match(busyCfg.processes || [], rows, busyCfg.ignoreProcesses);
  if (busyCfg.details === 'unreal-editor') {
    const det = unreal.details(desktop.filter(p => /^UnrealEditor/i.test(p.name)).map(p => p.pid));
    for (const p of desktop) Object.assign(p, det[p.pid] || {});
  }
  const g = busyCfg.gpu === false ? null : (opts.gpu !== undefined ? opts.gpu : gpu.detect(busyCfg.gpu));
  const cpu = busyCfg.busyAbove && busyCfg.busyAbove.cpuPct != null ? (opts.cpuPct != null ? opts.cpuPct : await load.cpuPct(500)) : null;
  const l = load.judge(busyCfg.busyAbove, { gpu: g, cpuPct: cpu });
  const reasons = [];
  if (desktop.length) reasons.push('processes');
  if (l.busy) reasons.push('load');
  let chats = 0;
  try { chats = require('../chats.cjs').list(cfg).filter(c => c.state && c.state !== 'ended').length; } catch (_) {}
  return {
    at: Date.now(), host: hostname(), node: cfg.id, profile: profile.name || '',
    busy: reasons.length > 0, reasons, desktop, remote, gpu: g, cpuPct: cpu, load: l, chats,
  };
}

module.exports = { probe };
