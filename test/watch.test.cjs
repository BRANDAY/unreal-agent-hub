// The project app watch (lib/watch.cjs, docs/WATCH.md): settings from the profile and overlay, "a restart is under
// way", agent calls held while the app is down mid-restart, and every decision of the board's watchdog.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { tempHome, rm } = require('./helpers.cjs');
const C = require('../lib/config.cjs');
const W = require('../lib/watch.cjs');
const client = require('../lib/lock-client.cjs');
const { Store } = require('../lib/store.cjs');

const DEAD_PORT = 1; // nothing listens on 127.0.0.1:1, a connect is refused at once

function setup(watch) {
  const home = tempHome({ id: 'm1', resources: [{ id: 'cpp', ttlMin: 30 }, { id: 'cook', ttlMin: 30 }] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uah-watch-'));
  fs.writeFileSync(path.join(dir, 'Game.uproject'), '{}');
  fs.writeFileSync(path.join(dir, '.unreal-agent-hub.json'), JSON.stringify({ project: 'Game', profile: 'unreal',
    resources: [{ id: 'editor', ttlMin: 30 }], watch: Object.assign({ port: DEAD_PORT, start: ['node', '-e', '0'] }, watch || {}) }));
  const cfg = C.load({ env: { UAH_HOME: home }, cwd: dir });
  const match = C.profileFor(cfg, dir);
  const store = new Store(cfg.stateDir, { machine: 'm1' });
  return { home, dir, cfg, match, store, w: W.settings(cfg, match.profile, match) };
}
const clean = t => { rm(t.home); rm(t.dir); };

test('settings: the unreal profile gives detection, the overlay the start command', () => {
  const t = setup();
  const { w } = t;
  assert.equal(w.project, 'Game');
  assert.equal(w.port, DEAD_PORT, 'the overlay replaces the port');
  assert.equal(w.tools, '^mcp__unreal-mcp__');
  assert.deepEqual(w.processes, ['UnrealEditor']);
  assert.equal(w.logFile, path.join(t.dir, 'Saved', 'Logs', 'Game.log'), '{marker} is the .uproject name');
  assert.deepEqual(w.busyKeys.sort(), ['Game~editor', 'cook', 'cpp']);
  W.remember(t.cfg, w);
  assert.equal(W.list(t.cfg)[0].project, 'Game');
  const off = C.load({ env: { UAH_HOME: t.home }, overlayFile: (() => { const f = path.join(t.dir, 'off.json'); fs.writeFileSync(f, JSON.stringify({ project: 'Game', watch: false })); return f; })() });
  assert.equal(W.settings(off, t.match.profile, t.match), null, 'watch: false turns it off');
  clean(t);
});

test('a restart is under way: a busy resource, a chat\'s close marker, or the board starting it', async () => {
  const t = setup();
  const { cfg, store, w } = t;
  assert.equal(W.restartPending(cfg, store, w), null, 'down and nothing restarting it: a person closed it');
  const b = await client.acquire(cfg, store, 'cpp', { mode: 'script', chat: 'build chat', noWait: true });
  assert.match(W.restartPending(cfg, store, w), /cpp is held .*build chat/);
  client.release(cfg, store, 'cpp', b.token, 'done');
  W.markDown(cfg, 'Game', { by: 'chat A' });
  assert.match(W.restartPending(cfg, store, w), /closed by chat A/);
  W.markUp(cfg, 'Game');
  assert.equal(W.restartPending(cfg, store, w), null);
  fs.writeFileSync(W.openingFile(cfg, 'Game'), JSON.stringify({ at: Date.now() }));
  assert.match(W.restartPending(cfg, store, w), /board is starting it/);
  fs.writeFileSync(W.openingFile(cfg, 'Game'), JSON.stringify({ at: Date.now() - 30 * 60e3 }));
  assert.equal(W.restartPending(cfg, store, w), null, 'a start note older than openingMin no longer counts');
  clean(t);
});

test('an agent call waits while the app is down mid-restart, goes on when it is back or when nobody restarts it', async () => {
  const t = setup();
  const { cfg, store, w } = t;
  W.markDown(cfg, 'Game', { by: 'chat A' });
  let up = false, said = '';
  setTimeout(() => { up = true; }, 300);
  const r = await W.waitRestart(cfg, store, w, { pollMs: 50, waitSec: 20, portAlive: async () => up, onWait: why => { said = why; } });
  assert.deepEqual([r.ok, r.waited], [true, true]);
  assert.match(said, /closed by chat A/);
  const gone = await W.waitRestart(cfg, store, w, { pollMs: 50, waitSec: 0.2 });
  assert.equal(gone.ok, false, 'still down after waitSec: denied');
  assert.match(gone.reason, /closed by chat A/);
  W.markUp(cfg, 'Game');
  const closed = await W.waitRestart(cfg, store, w, { pollMs: 50, waitSec: 20 });
  assert.deepEqual([closed.ok, closed.down, closed.waited], [true, true, false], 'a person closed it: the call goes on and fails as before');
  clean(t);
});

test('watchdog: starts the app after a chat closed it, never while a build runs, at most maxPerHour', async () => {
  const t = setup();
  const { cfg, store, w } = t;
  let clock = Date.now(), started = 0, alive = false, running = false;
  const logs = [];
  const tick = W.makeWatchdog(cfg, store, w, l => logs.push(l), { portAlive: async () => alive, running: () => running, now: () => clock, start: () => { started++; } });
  W.markDown(cfg, 'Game', { by: 'chat A' });
  const b = await client.acquire(cfg, store, 'cpp', { mode: 'script', chat: 'build', noWait: true });
  assert.equal(await tick(), 'busy', 'a build holds cpp: wait');
  client.release(cfg, store, 'cpp', b.token, 'done');
  assert.equal(await tick(), 'quiet', 'not before quietMin after the last lock');
  clock += 3 * 60e3;
  running = true;
  assert.equal(await tick(), 'starting', 'an app process is running (booting): hands off');
  running = false;
  assert.equal(await tick(), 'started');
  assert.equal(started, 1);
  assert.ok(fs.existsSync(W.openingFile(cfg, 'Game')), 'the start note makes agent calls wait');
  assert.equal(await tick(), 'started');
  assert.equal(await tick(), 'limit', 'two starts this hour: wait for a person');
  clock += 61 * 60e3;
  assert.equal(await tick(), 'started', 'a new hour');
  alive = true;
  assert.equal(await tick(), 'up');
  assert.equal(fs.existsSync(W.downFile(cfg, 'Game')) || fs.existsSync(W.openingFile(cfg, 'Game')), false, 'up clears both markers');
  assert.ok(logs.some(l => /starting it - closed by chat A/.test(l)));
  clean(t);
});

test('watchdog: a clean close by hand stays closed, a crash gets one start, no start command means wait', async () => {
  const t = setup();
  const { cfg, store, w } = t;
  const clock = Date.now() + 10 * 60e3;
  let started = 0;
  const deps = { portAlive: async () => false, running: () => false, now: () => clock, start: () => { started++; } };
  fs.mkdirSync(path.dirname(w.logFile), { recursive: true });
  fs.writeFileSync(w.logFile, 'LogInit: ...\nLogExit: Exiting.\nLog file closed, 10/20/26 22:00:00\n');
  const tick = W.makeWatchdog(cfg, store, w, () => {}, deps);
  assert.equal(await tick(), 'closed');
  fs.writeFileSync(w.logFile, 'LogInit: ...\nLogWindows: Error: Fatal error!\n');
  assert.equal(await tick(), 'started', 'no clean exit: a crash');
  assert.equal(await tick(), 'gave-up', 'one start per crash; the log did not change since');
  assert.equal(started, 1);
  const noStart = W.makeWatchdog(cfg, store, Object.assign({}, w, { start: null }), () => {}, deps);
  W.markDown(cfg, 'Game', { by: 'chat A' });
  assert.equal(await noStart(), 'no-start');
  clean(t);
});

test('the hook holds an unreal-mcp call while the editor restarts and denies it after gateWaitSec', async () => {
  const t = setup();
  const { cfg, dir } = t;
  cfg.gateWaitSec = 0.3;
  W.markDown(cfg, 'Game', { by: 'chat A' });
  let out = '';
  await require('../lib/hook.cjs').run('claude', { cfg, stdout: { write: s => { out += s; } },
    input: { session_id: 'sess-B', hook_event_name: 'PreToolUse', cwd: dir, tool_name: 'mcp__unreal-mcp__call_tool', tool_input: {} } });
  const d = JSON.parse(out);
  assert.equal(d.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(d.hookSpecificOutput.permissionDecisionReason, /Game: the app is down and a restart is under way \(closed by chat A/);
  W.markUp(cfg, 'Game');
  out = '';
  await require('../lib/hook.cjs').run('claude', { cfg, stdout: { write: s => { out += s; } },
    input: { session_id: 'sess-B', hook_event_name: 'PreToolUse', cwd: dir, tool_name: 'Bash', tool_input: { command: 'ls' } } });
  assert.equal(out, '', 'other tools are not held');
  clean(t);
});
