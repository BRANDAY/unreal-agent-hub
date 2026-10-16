// "Yes, take it": a remote run that waits because a person is at the machine asks them; nothing is taken from
// them; after the run, the machine and the person's presence mark come back by themselves.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tempHome, loadCfg, rm } = require('./helpers.cjs');
const { Store } = require('../lib/store.cjs');
const H = require('../lib/handover.cjs');
const client = require('../lib/lock-client.cjs');
const presence = require('../lib/presence.cjs');
const roles = require('../lib/roles.cjs');

function setup(extra) {
  const home = tempHome(Object.assign({
    id: 'studio', label: 'Studio',
    nodes: [{ id: 'laptop', label: 'Laptop', ssh: 'laptop', roles: ['runner', 'workstation'], resources: [{ id: 'laptop', ttlMin: 180 }], profile: 'unreal' }],
  }, extra || {}));
  const cfg = loadCfg(home);
  const store = new Store(cfg.stateDir, { machine: cfg.id });
  return { home, cfg, store };
}

// A fresh probe in the cache, so no ssh is attempted.
function probe(cfg, busy) {
  roles.saveProbe(cfg, 'laptop', { at: Date.now(), busy, reasons: busy ? ['processes'] : [], desktop: busy ? [{ name: 'UnrealEditor.exe', pid: 1, project: 'Game' }] : [], gpu: { usedMB: 11600, totalMB: 12288, util: 40 } }, '', 'test');
}

const waitFor = async (cond, ms) => { const t0 = Date.now(); while (!cond()) { if (Date.now() - t0 > (ms || 5000)) throw new Error('timeout'); await new Promise(r => setTimeout(r, 20)); } };

test('presence: the run queues and asks; "yes, take it" lets it in; afterwards presence comes back', async () => {
  const { home, cfg, store } = setup();
  probe(cfg, false);
  assert.equal(presence.here(cfg, store, 'laptop', true, { by: 'test' }).ok, true);
  const run = client.acquire(cfg, store, '@node:laptop', { mode: 'script', script: 'remote_run', note: 'smoke loading', pollMs: 20, waitMin: 1 });
  await waitFor(() => store.readAsks('laptop').some(a => a.state === 'pending'));
  const ask = store.readAsks('laptop')[0];
  assert.equal(ask.note, 'smoke loading');
  assert.equal(store.readLock('laptop').mode, 'presence', 'nothing is taken from the person while they decide');
  assert.equal(H.grant(store, cfg, 'laptop', null, 'test').ok, true);
  const r = await run;
  assert.equal(r.ok, true);
  assert.equal(store.readLock('laptop').token, r.token);
  assert.equal(store.readAsk('laptop', r.token).state, 'running');
  client.release(cfg, store, 'laptop', r.token, 'done');
  const back = store.readLock('laptop');
  assert.equal(back && back.mode, 'presence', 'the presence mark is restored');
  const evs = fs.readFileSync(path.join(cfg.stateDir, 'events.jsonl'), 'utf8');
  for (const k of ['ASK', 'GRANT', 'RETURN']) assert.match(evs, new RegExp(`"kind":"${k}"`));
  assert.match(fs.readFileSync(path.join(cfg.stateDir, 'notices.jsonl'), 'utf8'), /is yours again/);
  rm(home);
});

test('a busy desktop (Unreal open): "not now" keeps the run queued; closing Unreal lets it in without the grace pause', async () => {
  const { home, cfg, store } = setup({ handover: { askAgainMin: 0.002 } });
  probe(cfg, true);
  const run = client.acquire(cfg, store, '@node:laptop', { mode: 'script', script: 'remote_run', pollMs: 20, waitMin: 1 });
  await waitFor(() => store.readAsks('laptop').some(a => a.state === 'pending'));
  assert.equal(store.readLock('laptop'), null, 'no lock file: the person is in the way through the probe');
  const w = store.readWaiters('laptop')[0];
  assert.equal(w.blocked, 'human');
  assert.equal(H.decline(store, cfg, 'laptop', null, 'test').ok, true);
  assert.equal(store.readAsks('laptop')[0].state, 'declined');
  // askAgainMin passes (0.12 s here): asked again.
  await waitFor(() => store.readAsks('laptop').some(a => a.state === 'pending' && a.times === 2));
  // The person closes Unreal: the probe says free; lastBusyAt is recent, but a pending request skips the grace.
  roles.saveProbe(cfg, 'laptop', { at: Date.now(), busy: false, reasons: [], desktop: [] }, '', 'test');
  const r = await run;
  assert.equal(r.ok, true);
  client.release(cfg, store, 'laptop', r.token, 'done');
  rm(home);
});

test('a chat on the machine itself passes the person\'s presence; a grant only lets in that one run', async () => {
  const { home, cfg, store } = setup();
  probe(cfg, false);
  presence.here(cfg, store, 'laptop', true, {});
  const local = await client.acquire(cfg, store, '@node:laptop', { mode: 'hold', from: 'laptop', noWait: true, session: 's-local' });
  assert.equal(local.ok, true);
  assert.equal(local.presence, true);
  const remote = await client.acquire(cfg, store, '@node:laptop', { mode: 'script', noWait: true });
  assert.equal(remote.ok, false, 'a remote run with --no-wait fails at once');
  assert.match(remote.error, /person at Laptop/);
  rm(home);
});

test('a waiter that leaves cancels its request', async () => {
  const { home, cfg, store } = setup();
  probe(cfg, true);
  const ctl = { aborted: false };
  const run = client.acquire(cfg, store, '@node:laptop', { mode: 'script', pollMs: 20, waitMin: 1, signal: ctl });
  await waitFor(() => store.readAsks('laptop').length === 1);
  ctl.aborted = true;
  const r = await run;
  assert.equal(r.ok, false);
  assert.equal(store.readAsks('laptop').length, 0);
  assert.match(fs.readFileSync(path.join(cfg.stateDir, 'events.jsonl'), 'utf8'), /"kind":"CANCEL"/);
  rm(home);
});

test('pools: role:runner takes the first free runner', async () => {
  const { home, cfg, store } = setup({
    nodes: [
      { id: 'n1', roles: ['runner'], resources: [{ id: 'n1' }], profile: 'generic' },
      { id: 'n2', roles: ['runner'], resources: [{ id: 'n2' }], profile: 'generic' },
    ],
  });
  for (const id of ['n1', 'n2']) roles.saveProbe(cfg, id, { at: Date.now(), busy: false, reasons: [], desktop: [] }, '', 'test');
  const a = await client.acquire(cfg, store, 'role:runner', { mode: 'script', noWait: true });
  const b = await client.acquire(cfg, store, 'role:runner', { mode: 'script', noWait: true });
  const c = await client.acquire(cfg, store, 'role:runner', { mode: 'script', noWait: true });
  assert.deepEqual([a.ok, b.ok, c.ok], [true, true, false]);
  assert.notEqual(a.key, b.key);
  rm(home);
});
