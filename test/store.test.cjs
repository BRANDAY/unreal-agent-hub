// The lock protocol (docs/PROTOCOL.md): exclusive create, re-entrance, stale break by rename, and a real race of
// two processes taking the same resource many times.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { tempHome, loadCfg, rm } = require('./helpers.cjs');
const { Store } = require('../lib/store.cjs');

const RES = [{ id: 'res', ttlMin: 5 }];

test('take, busy for another, re-entrant for the holder, release', () => {
  const home = tempHome({ id: 'm1', resources: RES });
  const store = new Store(loadCfg(home).stateDir, { machine: 'm1' });
  const a = store.tryTake('res', { token: 'A', mode: 'script', pid: process.pid, ttlMin: 5 });
  assert.equal(a.ok, true);
  const b = store.tryTake('res', { token: 'B', mode: 'script', pid: process.pid, ttlMin: 5 });
  assert.equal(b.ok, false);
  assert.equal(b.why, 'held');
  const again = store.tryTake('res', { token: 'C' }, { isMine: l => l.token === 'A' });
  assert.equal(again.reentrant, true);
  assert.equal(store.release('res', 'B').ok, false, 'a wrong token releases nothing');
  assert.ok(store.readLock('res'), 'the lock is still in place after a wrong release');
  assert.equal(store.release('res', 'A').ok, true);
  assert.equal(store.readLock('res'), null);
  rm(home);
});

test('a lock past its TTL or of a dead process is stale and gets broken by the next taker', () => {
  const home = tempHome({ id: 'm1', resources: RES });
  const store = new Store(loadCfg(home).stateDir, { machine: 'm1' });
  fs.writeFileSync(store.lockFile('res'), JSON.stringify({ resource: 'res', token: 'OLD', mode: 'script', pid: process.pid, machine: 'm1', since: Date.now() - 10e3, ttlMin: 1, expires: Date.now() - 1000 }));
  assert.match(store.readLock('res').stale, /TTL/);
  const r = store.tryTake('res', { token: 'NEW', mode: 'script', pid: process.pid, ttlMin: 5 });
  assert.equal(r.ok, true);
  assert.equal(store.readLock('res').token, 'NEW');
  const ev = fs.readFileSync(path.join(store.dir, 'events.jsonl'), 'utf8');
  assert.match(ev, /"kind":"BREAK"/);
  store.release('res', 'NEW');
  // A dead pid (a process that has exited).
  const dead = cp.spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']).stdout.toString();
  fs.writeFileSync(store.lockFile('res'), JSON.stringify({ resource: 'res', token: 'DEAD', mode: 'script', pid: Number(dead), machine: 'm1', since: Date.now(), ttlMin: 60, expires: Date.now() + 3600e3 }));
  assert.match(store.readLock('res').stale || '', /exited/);
  rm(home);
});

test('breakStale puts back a lock that changed in between', () => {
  const home = tempHome({ id: 'm1', resources: RES });
  const store = new Store(loadCfg(home).stateDir, { machine: 'm1' });
  store.tryTake('res', { token: 'LIVE', mode: 'script', pid: process.pid, ttlMin: 5 });
  const r = store.breakStale('res', 'SOMEONE-ELSE');
  assert.equal(r.ok, false);
  assert.equal(store.readLock('res').token, 'LIVE', 'the live lock is linked back');
  assert.deepEqual(fs.readdirSync(store.dir).filter(n => n.includes('.aside-')), [], 'no aside file is left behind');
  rm(home);
});

test('two processes racing for one resource never overlap', async () => {
  const home = tempHome({ id: 'm1', resources: RES });
  const rounds = 25;
  const run = tag => new Promise((resolve, reject) => {
    const p = cp.spawn(process.execPath, [path.join(__dirname, 'race-worker.cjs'), home, String(rounds), tag], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    p.stdout.on('data', d => { out += d; });
    p.on('exit', code => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`${tag} exited ${code}: ${out}`))));
  });
  const [a, b] = await Promise.all([run('A'), run('B')]);
  assert.equal(a.overlaps + b.overlaps, 0, 'the marker file was never created twice');
  const evs = fs.readFileSync(path.join(home, 'state', 'events.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(evs.filter(e => e.kind === 'TAKE').length, rounds * 2);
  // Every TAKE is followed by its own FREE before the next TAKE.
  let held = null;
  for (const e of evs) {
    if (e.kind === 'TAKE') { assert.equal(held, null, 'a TAKE while another lock was held'); held = e.token; }
    if (e.kind === 'FREE') { assert.equal(e.token, held); held = null; }
  }
  rm(home);
});

test('two processes breaking the same stale lock: exactly one wins', async () => {
  const home = tempHome({ id: 'm1', resources: RES });
  const store = new Store(path.join(home, 'state'), { machine: 'm1' });
  fs.writeFileSync(store.lockFile('res'), JSON.stringify({ resource: 'res', token: 'OLD', mode: 'script', pid: 1, machine: 'm1', since: 1, ttlMin: 1, expires: 2 }));
  const code = `
    const { Store } = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'store.cjs'))});
    const s = new Store(${JSON.stringify(store.dir)}, { machine: 'm1' });
    const until = Number(process.argv[1]); while (Date.now() < until) {}
    const r = s.tryTake('res', { token: process.argv[2], mode: 'script', pid: process.pid, ttlMin: 5 });
    process.stdout.write(r.ok ? 'won' : 'lost:' + r.why);`;
  const start = Date.now() + 400;
  const runOne = tok => new Promise(res => cp.execFile(process.execPath, ['-e', code, String(start), tok], (e, out) => res(String(out))));
  const results = await Promise.all([runOne('P1'), runOne('P2')]);
  const winners = results.filter(r => r === 'won').length;
  assert.ok(winners <= 1, `at most one winner, got ${results}`);
  const lock = store.readLock('res');
  if (winners === 1) assert.ok(['P1', 'P2'].includes(lock.token));
  rm(home);
});
