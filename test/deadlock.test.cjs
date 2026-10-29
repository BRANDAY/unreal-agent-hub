// Deadlocks between waiters (lib/deadlock.cjs): a cycle of holders is broken by the youngest waiter giving up, a
// cycle through the queue order by a shared reader going first, and `lockOrder` warns on the first wait.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tempHome, loadCfg, rm } = require('./helpers.cjs');
const { Store } = require('../lib/store.cjs');
const client = require('../lib/lock-client.cjs');
const D = require('../lib/deadlock.cjs');

function setup(resources, extra) {
  const home = tempHome(Object.assign({ id: 'm1', resources, deadlock: { checkSec: 0.05 } }, extra || {}));
  const cfg = loadCfg(home);
  return { home, cfg, store: new Store(cfg.stateDir, { machine: 'm1' }) };
}

// A chat's hold, written as the hook or `hub hold` writes it (no owner process: only the TTL ends it).
function hold(store, key, session, opts) {
  const r = store.tryTake(key, Object.assign({ token: `hold-${session}-${key}`, mode: 'hold', session, chat: session, pid: process.pid, ttlMin: 5 }, opts || {}),
    Object.assign({ slots: 1 }, opts && opts.places));
  assert.equal(r.ok, true, `hold of ${key} by ${session}`);
  return r.lock.token;
}

// A run of a chat: a script take with the chat's session, isolated from this process's own environment.
function run(cfg, store, key, session, opts) {
  return client.acquire(cfg, store, key, Object.assign({ mode: 'script', session, chat: session, script: `run-${session}`,
    env: {}, ownerPid: 0, pollMs: 20, waitMin: 1 }, opts || {}));
}

const log = cfg => fs.readFileSync(path.join(cfg.stateDir, 'log.txt'), 'utf8');
const sleep = ms => new Promise(r => setTimeout(r, ms));

test('a cycle of holders: the youngest waiter gives up with the cycle named, the other goes on', async () => {
  const { home, cfg, store } = setup([{ id: 'x', ttlMin: 5 }, { id: 'y', ttlMin: 5 }]);
  try {
    hold(store, 'x', 'A');
    const yTok = hold(store, 'y', 'B');
    const a = run(cfg, store, 'y', 'A');
    await sleep(60);
    const b = await run(cfg, store, 'x', 'B');
    assert.equal(b.ok, false);
    assert.match(b.deadlock, /^chat "B" .*waits for x, held by chat "A" .* -> chat "A" .*waits for y, held by chat "B" .* -> the first again$/);
    assert.equal(b.errorMsg.k, 'err.deadlock');
    assert.match(log(cfg), /CYCLE x : /);
    assert.match(log(cfg), /DEADLOCK x : chat "B"/);
    // B lets go of what it held while it waited; A takes it.
    assert.equal(store.release('y', yTok).ok, true);
    const ra = await a;
    assert.equal(ra.ok, true);
    assert.equal(ra.key, 'y');
    const events = fs.readFileSync(path.join(cfg.stateDir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
    assert.ok(events.some(e => e.kind === 'DEADLOCK' && e.session === 'B' && /waits for/.test(e.cycle)));
  } finally { rm(home); }
});

test('a cycle through the queue order: a shared reader goes past the whole take queued ahead (JUMP)', async () => {
  // A holds one cook place and its run waits for the laptop; B holds the laptop and its run waits for a cook place
  // behind C's package, which needs every cook place - A's among them.
  const { home, cfg, store } = setup([{ id: 'cook', ttlMin: 5, slots: 2 }, { id: 'laptop', ttlMin: 5 }],
    { deadlock: { checkSec: 0.05, jumpWaitSec: 60 } });
  const ac = { aborted: false };
  try {
    hold(store, 'cook', 'A', { places: { slots: 2, shared: true } });
    const lapTok = hold(store, 'laptop', 'B');
    const pkg = run(cfg, store, 'cook', 'C', { signal: ac });
    await sleep(40);
    const aRun = run(cfg, store, 'laptop', 'A', { signal: ac });
    await sleep(40);
    const bRun = await run(cfg, store, 'cook', 'B', { shared: true });
    assert.equal(bRun.ok, true, 'the reader got the free place');
    assert.match(log(cfg), /JUMP  cook by chat "B"/);
    assert.doesNotMatch(log(cfg), /DEADLOCK/, 'nobody gave up');
    // B's run ends and lets the laptop go: A's run goes on.
    store.release('cook', bRun.token);
    store.release('laptop', lapTok);
    const ra = await aRun;
    assert.equal(ra.ok, true);
    ac.aborted = true;
    assert.equal((await pkg).error, 'aborted');
  } finally { ac.aborted = true; rm(home); }
});

test('a plain queue is no deadlock: nobody gives up, nobody jumps', async () => {
  const { home, cfg, store } = setup([{ id: 'x', ttlMin: 5 }]);
  try {
    const t = hold(store, 'x', 'A');
    const b = run(cfg, store, 'x', 'B');
    await sleep(150);
    assert.doesNotMatch(log(cfg), /CYCLE|JUMP|DEADLOCK/);
    store.release('x', t);
    assert.equal((await b).ok, true);
  } finally { rm(home); }
});

test('a waiter owns the takes it works under: its token list, its process, its chat\'s hold', () => {
  const w = { token: 'w', pid: 7, pidStart: 1, session: 's', machine: 'm1', holds: ['t1'] };
  assert.equal(D.owns(w, { token: 't1', mode: 'script', pid: 99 }), true);
  assert.equal(D.owns(w, { token: 't2', mode: 'script', pid: 7, pidStart: 1, machine: 'm1' }), true);
  assert.equal(D.owns(w, { token: 't3', mode: 'script', pid: 7, pidStart: 2, machine: 'm1' }), false, 'pid reused');
  assert.equal(D.owns(w, { token: 't4', mode: 'hold', session: 's' }), true);
  assert.equal(D.owns(w, { token: 't5', mode: 'script', session: 's', pid: 8 }), false, 'a script of the same chat is its own process');
  assert.deepEqual(D.heldTokens({ UAH_TOKEN_CPP: 'a', UAH_TOKEN_X: 'b', OTHER: 'c' }, 'b'), ['a']);
});

test('lockOrder: waiting for an earlier resource while holding a later one is said once, on the first wait', async () => {
  const { home, cfg, store } = setup([{ id: 'editor', ttlMin: 5 }, { id: 'cook', ttlMin: 5 }], { lockOrder: ['editor', 'cook'] });
  const ac = { aborted: false };
  try {
    hold(store, 'cook', 'A');
    hold(store, 'editor', 'B');
    const notes = [];
    const r = run(cfg, store, 'editor', 'A', { signal: ac, onNotice: t => notes.push(t) });
    await sleep(80);
    ac.aborted = true;
    await r;
    assert.equal(notes.filter(n => /holds cook and now waits for editor/.test(n)).length, 1);
    assert.match(log(cfg), /ORDER editor by chat "A".*holds cook and waits for editor; the order is editor -> cook/);
  } finally { ac.aborted = true; rm(home); }
});
