// Queue order: priority by holder kind, aging, then since, then token; blocked waiters do not hold others back.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Q = require('../lib/queue.cjs');

const cfg = { priorities: { presence: 100, 'node-chat': 50, hold: 40, script: 30, gate: 30 }, aging: { everyMin: 10, step: 10 } };
const now = 1_000_000_000;

test('higher priority first, then the earlier since, then the token', () => {
  const ws = [
    { token: 'b', mode: 'script', since: now - 5000 },
    { token: 'a', mode: 'script', since: now - 5000 },
    { token: 'c', mode: 'hold', since: now - 1000 },
    { token: 'd', mode: 'node-chat', since: now },
    { token: 'e', mode: 'script', since: now - 9000 },
  ];
  assert.deepEqual(Q.order(ws, cfg, now).map(w => w.token), ['d', 'c', 'e', 'a', 'b']);
});

test('aging: a script waiting 30 minutes passes a fresh hold (30 + 3*10 = 60 > 40)', () => {
  const ws = [{ token: 'hold', mode: 'hold', since: now }, { token: 'old', mode: 'script', since: now - 30 * 60e3 }];
  assert.equal(Q.effectivePriority(ws[1], cfg, now), 60);
  assert.deepEqual(Q.order(ws, cfg, now).map(w => w.token), ['old', 'hold']);
});

test('an explicit priority overrides the holder kind', () => {
  const ws = [{ token: 'x', mode: 'script', priority: 90, since: now }, { token: 'y', mode: 'node-chat', since: now - 1 }];
  assert.equal(Q.order(ws, cfg, now)[0].token, 'x');
});

test('ahead(): only waiters that rank before me and are not blocked by a person', () => {
  const ws = [
    { token: 'p', mode: 'script', since: now - 60e3, blocked: 'human', blockedAt: now - 1000 },
    { token: 'q', mode: 'script', since: now - 30e3 },
    { token: 'me', mode: 'script', since: now - 10e3 },
  ];
  assert.deepEqual(Q.ahead(ws, { token: 'me', mode: 'script', since: now - 10e3 }, cfg, now).map(w => w.token), ['q']);
  // A blocked mark older than 20 s no longer counts.
  ws[0].blockedAt = now - 60e3;
  assert.deepEqual(Q.ahead(ws, { token: 'me', mode: 'script', since: now - 10e3 }, cfg, now).map(w => w.token), ['p', 'q']);
});
