// What the chats' tokens would cost at API prices (lib/usage.cjs): which journals count, one response per
// message.id|requestId with the largest output, incremental scans, pricing, a journal seen on two machines counted once,
// and the board's /state.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tempHome, loadCfg, rm } = require('./helpers.cjs');
const Us = require('../lib/usage.cjs');

const PRICES = { read: '2026-10-12', source: 'https://example.com/pricing', longContext: { 'claude-small': { above: 1000, use: 'claude-small-long' } },
  models: { 'claude-big': [10, 12.5, 20, 1, 50], 'claude-small': [1, 1.25, 2, 0.1, 5], 'claude-small-long': [2, 2.5, 4, 0.2, 10] } };

const line = o => JSON.stringify(o) + '\n';
const reply = (id, model, usage, ts) => line({ type: 'assistant', requestId: 'r' + id, timestamp: ts || '2026-10-29T10:00:00Z', message: { id: 'm' + id, model, usage } });

function journalsRoot() {
  const root = fs.mkdtempSync(path.join(require('os').tmpdir(), 'uah-journals-'));
  const proj = path.join(root, 'D--Games-MyGame');
  fs.mkdirSync(path.join(proj, 's1', 'subagents'), { recursive: true });
  fs.mkdirSync(path.join(root, 'D--Games-MyGame--claude-worktrees-x'));
  fs.mkdirSync(path.join(root, 'C--Other'));
  fs.writeFileSync(path.join(proj, 's1.jsonl'),
    line({ type: 'user', message: { content: 'Fix the cook crash' } })
    + reply(1, 'claude-big-20261001', { input_tokens: 1e6, output_tokens: 100 })
    + reply(1, 'claude-big-20261001', { input_tokens: 1e6, output_tokens: 1e6 }) // the same response, output grew
    + reply(2, 'claude-small', { input_tokens: 2000, cache_read_input_tokens: 0, output_tokens: 0 }) // > 1000: long context
    + line({ type: 'custom-title', customTitle: 'Cook crash' }));
  fs.writeFileSync(path.join(proj, 's1', 'subagents', 'agent-a1.jsonl'), reply(3, 'claude-small', { input_tokens: 1e6, output_tokens: 0 }));
  fs.writeFileSync(path.join(root, 'D--Games-MyGame--claude-worktrees-x', 's2.jsonl'), reply(4, 'claude-unknown', { input_tokens: 5, output_tokens: 5 }));
  fs.writeFileSync(path.join(root, 'C--Other', 's3.jsonl'), reply(5, 'claude-big', { input_tokens: 1e6, output_tokens: 0 }));
  return { root, proj };
}

function project(home, root) {
  fs.mkdirSync(path.join(home, 'state', 'projects'), { recursive: true });
  fs.writeFileSync(path.join(home, 'state', 'projects', 'MyGame.json'), JSON.stringify({ id: 'MyGame', root, resources: [] }));
}

test('the journal folder of a working directory, and which folders count', () => {
  assert.equal(Us.folderOf('D:\\Games\\MyGame'), 'D--Games-MyGame');
  const home = tempHome({ id: 'm1' });
  try {
    const cfg = loadCfg(home);
    assert.equal(Us.matcher(cfg)('D--Games-MyGame'), false, 'no project known yet');
    project(home, 'D:\\Games\\MyGame');
    const t = Us.matcher(cfg);
    assert.deepEqual(['D--Games-MyGame', 'd--games-mygame--claude-worktrees-x', 'D--Games-MyGameOld', 'C--Other'].map(t), [true, true, false, false]);
    assert.equal(Us.matcher(cfg, 'other|mygame')('C--Other'), true);
    assert.equal(Us.matcher(cfg, '*')('anything'), true);
  } finally { rm(home); }
});

test('a scan: one response per message, the largest output, subagents, titles, then only what was appended', () => {
  const { root, proj } = journalsRoot();
  const home = tempHome({ id: 'm1' });
  try {
    const cfg = loadCfg(home);
    project(home, 'D:\\Games\\MyGame');
    const cache = Us.cacheFile(cfg, 'm1');
    const c = Us.scan({ root, cache, test: Us.matcher(cfg), tzmin: 0, machine: 'm1', prices: PRICES });
    assert.deepEqual(Object.keys(c.files).sort(), ['s1/a1', 's1/main', 's2/main']);
    const main = c.files['s1/main'];
    assert.equal(main.steps, 2);
    assert.equal(main.title, 'Cook crash');
    assert.equal(main.first, 'Fix the cook crash');
    assert.deepEqual(main.days['2026-10-29']['claude-big'], [1e6, 0, 0, 0, 1e6]);
    assert.deepEqual(main.days['2026-10-29']['claude-small-long'], [2000, 0, 0, 0, 0]);
    // Appended: only the new line is read.
    const off = main.off;
    fs.appendFileSync(path.join(proj, 's1.jsonl'), reply(6, 'claude-small', { input_tokens: 10, output_tokens: 10 }, '2026-10-30T01:00:00Z'));
    const c2 = Us.scan({ root, cache, test: Us.matcher(cfg), tzmin: 0, machine: 'm1', prices: PRICES });
    assert.ok(c2.files['s1/main'].off > off);
    assert.equal(c2.files['s1/main'].steps, 3);
    assert.deepEqual(c2.files['s1/main'].days['2026-10-30']['claude-small'], [10, 0, 0, 0, 10]);

    const s = Us.summarize([c2], PRICES, '2026-10-29');
    // big: 1M in * 10 + 1M out * 50 = 60; small-long: 2000 * 2 / 1e6 and the subagent's 1M in * 2 (its context is long
    // too) = 2.004; day 30: tiny.
    assert.equal(s.today, 62);
    assert.equal(s.total, 62);
    assert.equal(s.responses, 5);
    assert.deepEqual(s.unpriced, ['claude-unknown']);
    assert.equal(s.since, '2026-10-29');
    assert.equal(s.chats[0].sid, 's1');
    assert.equal(s.chats[0].name, 'Cook crash');
    assert.equal(s.chatsToday.length, 1);
    assert.deepEqual(s.models.map(m => m.model), ['claude-big', 'claude-small-long', 'claude-small']);
  } finally { rm(home); rm(root); }
});

test('a journal seen on two machines counts once, the copy with more responses', () => {
  const day = { '2026-10-29': { 'claude-small': [1e6, 0, 0, 0, 0] } };
  const a = { files: { 's/main': { sid: 's', steps: 1, days: day } } };
  const b = { files: { 's/main': { sid: 's', steps: 2, days: { '2026-10-29': { 'claude-small': [2e6, 0, 0, 0, 0] } } } } };
  assert.equal(Us.summarize([a, b], PRICES, '2026-10-29').total, 2);
});

test('the board: state.usage with chat titles, `hub usage` priced from the caches', async () => {
  const { root } = journalsRoot();
  const port = 19000 + Math.floor(Math.random() * 500);
  const home = tempHome({ id: 'm1', port, usage: { root, match: 'mygame', everySec: 10, prices: 'prices.json' } });
  fs.writeFileSync(path.join(home, 'prices.json'), JSON.stringify(PRICES));
  const { createBoard } = require('../lib/server/board.cjs');
  const cfg = loadCfg(home);
  fs.mkdirSync(path.join(cfg.stateDir, 'chats'), { recursive: true });
  require('../lib/chats.cjs').update(cfg, 's1', { title: 'Board title', hostSession: 'local_1', updated: Date.now(), state: 'idle' });
  const b = createBoard(cfg, { noTunnels: true, noWatch: true });
  await b.listen();
  try {
    let st = null;
    for (let i = 0; i < 100 && !(st && st.usage && st.usage.responses); i++) {
      await new Promise(r => setTimeout(r, 100));
      st = b.buildState();
    }
    assert.ok(st.usage && st.usage.responses >= 4, 'the scan child filled the cache');
    assert.ok(st.usage.machines.m1.ok);
    const row = st.usage.chats.find(c => c.sid === 's1');
    assert.equal(row.title, 'Board title');
    assert.equal(row.hostSession, 'local_1');
    const out = require('child_process').execFileSync(process.execPath, [path.join(__dirname, '..', 'bin', 'hub.cjs'), 'usage', '--json'],
      { env: Object.assign({}, process.env, { UAH_HOME: home }), encoding: 'utf8' });
    assert.ok(JSON.parse(out).total > 0);
  } finally { await b.close(); rm(home); rm(root); }
});

test('usage off: no usage in the state', async () => {
  const home = tempHome({ id: 'm1', port: 19600 + Math.floor(Math.random() * 300), usage: { enabled: false } });
  const { createBoard } = require('../lib/server/board.cjs');
  const b = createBoard(loadCfg(home), { noTunnels: true, noWatch: true });
  try { assert.equal(b.buildState().usage, undefined); } finally { await b.close(); rm(home); }
});
