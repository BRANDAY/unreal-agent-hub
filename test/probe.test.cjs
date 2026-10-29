// The machine probe (lib/detect/probe.cjs): which profile processes make a machine busy, and which do not.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const processes = require('../lib/detect/processes.cjs');
const { probe } = require('../lib/detect/probe.cjs');
const { tempHome, loadCfg, rm } = require('./helpers.cjs');

const exe = n => (process.platform === 'win32' ? n + '.exe' : n);
const ROWS = [
  { name: exe('UnrealEditor'), pid: 10, desktop: true, memMB: 900 },
  { name: exe('EOSOverlayRenderer-Win64-Shipping'), pid: 11, desktop: true, memMB: 40 },
  { name: exe('DreamHack-Win64-Shipping'), pid: 12, desktop: false, memMB: 2000 },
];

test('ignoreProcesses drops a process that matches the patterns but is not the workload', () => {
  const pats = ['UnrealEditor', '*-Win64-Shipping'];
  assert.deepEqual(processes.match(pats, ROWS).desktop.map(r => r.pid), [10, 11]);
  const m = processes.match(pats, ROWS, ['EOSOverlayRenderer-*']);
  assert.deepEqual(m.desktop.map(r => r.pid), [10]);
  assert.deepEqual(m.remote.map(r => r.pid), [12], 'a run over ssh is still listed as remote');
});

test('the unreal profile: the Epic overlay alone leaves the machine free, and request_editor_quit is app-wide', async () => {
  const home = tempHome({ id: 'm1' });
  try {
    const cfg = loadCfg(home);
    const prof = cfg.profiles.unreal;
    const p = await probe(cfg, prof, { rows: [ROWS[1]], gpu: null, cpuPct: 0 });
    assert.equal(p.busy, false);
    assert.deepEqual(p.desktop, []);
    const q = await probe(cfg, prof, { rows: ROWS, gpu: null, cpuPct: 0 });
    assert.deepEqual([q.busy, q.reasons], [true, ['processes']]);
    assert.ok(prof.calls.tools.includes('request_editor_quit'));
  } finally { rm(home); }
});
