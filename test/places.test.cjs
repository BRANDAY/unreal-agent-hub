// Resources with places (`slots` > 1): a shared take holds one place, any other take all of them; a shared take
// does not slip past a whole one waiting ahead; `hold: false` refuses holds; the board and status show k/N.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { tempHome, loadCfg, rm } = require('./helpers.cjs');
const { Store } = require('../lib/store.cjs');
const client = require('../lib/lock-client.cjs');
const status = require('../lib/status.cjs');

const RES = [{ id: 'runs', ttlMin: 5, slots: 2, hold: false }, { id: 'cook', ttlMin: 5, slots: 4 }];
const rec = token => ({ token, mode: 'script', pid: process.pid, ttlMin: 5 });

function setup() {
  const home = tempHome({ id: 'm1', resources: RES });
  const cfg = loadCfg(home);
  return { home, cfg, store: new Store(cfg.stateDir, { machine: 'm1' }) };
}

test('two shared takes side by side, a third waits; a whole take needs every place', () => {
  const { home, store } = setup();
  const a = store.tryTake('runs', rec('A'), { slots: 2, shared: true });
  const b = store.tryTake('runs', rec('B'), { slots: 2, shared: true });
  assert.deepEqual([a.ok, a.lock.place, b.ok, b.lock.place], [true, 1, true, 2]);
  assert.equal(store.tryTake('runs', rec('C'), { slots: 2, shared: true }).why, 'held');
  assert.equal(store.tryTake('runs', rec('W'), { slots: 2 }).why, 'held');
  assert.deepEqual(store.keys(), ['runs'], 'place 2 counts as its resource');
  assert.equal(store.freePlaces('runs', 2), 0);
  assert.equal(store.release('runs', 'A').ok, true);
  assert.equal(store.tryTake('runs', rec('W'), { slots: 2 }).why, 'held', 'one place is still taken');
  assert.equal(store.readLock('runs').token, 'B', 'readLock finds the holder of place 2');
  assert.equal(store.release('runs', 'B').ok, true);
  const w = store.tryTake('runs', rec('W'), { slots: 2 });
  assert.equal(w.ok, true);
  assert.deepEqual(store.readLocks('runs').map(l => [l.place, l.token]), [[1, 'W'], [2, 'W']]);
  assert.equal(store.tryTake('runs', rec('D'), { slots: 2, shared: true }).why, 'held');
  assert.equal(store.release('runs', 'W').ok, true);
  assert.deepEqual(store.placeKeys('runs'), [], 'a release frees every place of a whole take');
  const log = fs.readFileSync(path.join(store.dir, 'log.txt'), 'utf8');
  assert.equal((log.match(/FREE {2}runs .*all 2 places/g) || []).length, 1, 'a whole take is freed once in the log');
  rm(home);
});

test('a stale place is broken by the next taker; the board breaks it by token on whatever place it is', () => {
  const { home, store } = setup();
  assert.equal(store.tryTake('runs', rec('LIVE'), { slots: 2, shared: true }).ok, true);
  fs.writeFileSync(store.lockFile('runs.2'), JSON.stringify({ resource: 'runs', token: 'OLD', mode: 'script', pid: process.pid,
    machine: 'm1', since: Date.now() - 10e3, ttlMin: 1, expires: Date.now() - 1000, slots: 2, shared: true, place: 2 }));
  assert.equal(store.readLock('runs').token, 'LIVE', 'the first live place answers');
  assert.equal(store.breakStale('runs', 'OLD', 'test').ok, true);
  assert.equal(store.readLocks('runs').length, 1);
  fs.writeFileSync(store.lockFile('runs.2'), JSON.stringify({ resource: 'runs', token: 'OLD2', mode: 'script', pid: process.pid,
    machine: 'm1', since: Date.now() - 10e3, ttlMin: 1, expires: Date.now() - 1000, slots: 2, shared: true, place: 2 }));
  const n = store.tryTake('runs', rec('NEW'), { slots: 2, shared: true });
  assert.equal(n.ok, true);
  assert.equal(n.lock.place, 2);
  assert.match(fs.readFileSync(path.join(store.dir, 'events.jsonl'), 'utf8'), /"kind":"BREAK".*"token":"OLD2"|"token":"OLD2".*"kind":"BREAK"/);
  rm(home);
});

test('a shared take does not slip past a whole take waiting ahead; shared ones ahead block only when they use up the places', async () => {
  const { home, cfg, store } = setup();
  const a = await client.acquire(cfg, store, 'runs', { shared: true, noWait: true, chat: 'A', ownerPid: 0 });
  assert.equal(a.ok, true);
  // A whole take is waiting (one place is busy); a new shared take must queue behind it even though place 2 is free.
  store.writeWaiter('runs', { token: 'WHOLE', mode: 'script', chat: 'measure', pid: process.pid, since: Date.now() - 5000 });
  const s = await client.acquire(cfg, store, 'runs', { shared: true, noWait: true, chat: 'S', ownerPid: 0 });
  assert.equal(s.ok, false);
  assert.match(s.error, /measure/);
  store.dropWaiter('runs', 'WHOLE');
  // A shared waiter ahead and one free place: the new shared take would leave nothing for it, so it waits.
  store.writeWaiter('runs', { token: 'SH', mode: 'script', chat: 'early', pid: process.pid, since: Date.now() - 5000, shared: true });
  assert.equal((await client.acquire(cfg, store, 'runs', { shared: true, noWait: true, chat: 'S2', ownerPid: 0 })).ok, false);
  store.dropWaiter('runs', 'SH');
  // cook has 4 places: one shared waiter ahead still leaves a place for the newcomer.
  store.writeWaiter('cook', { token: 'SH', mode: 'script', chat: 'early', pid: process.pid, since: Date.now() - 5000, shared: true });
  assert.equal((await client.acquire(cfg, store, 'cook', { shared: true, noWait: true, chat: 'S3', ownerPid: 0 })).ok, true);
  rm(home);
});

test('hold: false refuses a hold and allows a run; status shows k/N with one line per holder', async () => {
  const { home, cfg, store } = setup();
  const h = await client.acquire(cfg, store, 'runs', { mode: 'hold', noWait: true, chat: 'chain', ownerPid: 0 });
  assert.equal(h.ok, false);
  assert.match(h.error, /run|hold/i);
  assert.equal(store.readLock('runs'), null, 'nothing was taken');
  const c = await client.acquire(cfg, store, 'cook', { mode: 'hold', noWait: true, chat: 'chain', ownerPid: 0, ttlMin: 5 });
  assert.equal(c.ok, true, 'a resource without hold: false can be held (all of its places)');
  const r = await client.acquire(cfg, store, 'runs', { shared: true, noWait: true, chat: 'smoke A', ownerPid: 0 });
  assert.equal(r.ok, true);
  const rows = status.data(cfg, store);
  const runs = rows.find(x => x.key === 'runs');
  assert.deepEqual([runs.slots, runs.hold, runs.holders.length], [2, false, 1]);
  const text = status.format(rows);
  assert.match(text, /runs\s+.*1\/2/);
  assert.match(text, /cook\s+.*4\/4/);
  rm(home);
});

test('two shared and one whole process racing: never more holders than places', async () => {
  const { home } = setup();
  const run = (tag, how) => new Promise((resolve, reject) => {
    const p = cp.spawn(process.execPath, [path.join(__dirname, 'places-worker.cjs'), home, '25', tag, how], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', d => { out += d; });
    p.on('exit', code => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`${tag} exit ${code}: ${out}`))));
  });
  const res = await Promise.all([run('s1', 'shared'), run('s2', 'shared'), run('s3', 'shared'), run('w1', 'whole')]);
  for (const r of res) assert.equal(r.overlaps, 0);
  rm(home);
});
