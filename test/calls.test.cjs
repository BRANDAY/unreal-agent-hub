// App-wide calls of a wait gate (lib/calls.cjs, docs/PROFILES.md "calls"), stamps (lib/stamps.cjs, `hub stamp` /
// `hub whose`) and a live Blender as a resource: each case runs the hook as Claude Code does, in a throwaway home and
// a throwaway Unreal project with an overlay.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { tempHome, rm } = require('./helpers.cjs');
const C = require('../lib/config.cjs');
const S = require('../lib/stamps.cjs');
const hook = require('../lib/hook.cjs');
const client = require('../lib/lock-client.cjs');
const { Store } = require('../lib/store.cjs');
const { say } = require('../lib/i18n.cjs');

function setup() {
  const home = tempHome({ id: 'm1', lang: 'en' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uah-calls-'));
  fs.writeFileSync(path.join(dir, 'Game.uproject'), '{}');
  fs.writeFileSync(path.join(dir, '.unreal-agent-hub.json'), JSON.stringify({
    project: 'Game', profile: 'unreal',
    resources: [{ id: 'editor', ttlMin: 30 }, { id: 'blender', ttlMin: 30 }],
    gates: [
      { tools: '^mcp__unreal-mcp__', resource: 'editor', mode: 'wait', calls: { tools: ['reload_project_toolsets'] } },
      { tools: '^mcp__blender__', resource: 'blender', mode: 'wait' },
    ],
    watch: false, // no editor runs here: the app watch (test/watch.test.cjs) stays out of the way
  }));
  const load = () => { const c = C.load({ env: { UAH_HOME: home }, cwd: dir }); c.gateWaitSec = 0.3; return c; };
  const cfg = load();
  return { home, dir, cfg, load, store: new Store(cfg.stateDir, { machine: 'm1' }) };
}
const clean = t => { rm(t.home); rm(t.dir); };

async function call(t, sid, tool, args, opts) {
  opts = opts || {};
  let out = '';
  const input = { session_id: sid, hook_event_name: opts.event || 'PreToolUse', cwd: t.dir,
    tool_name: opts.mcp || 'mcp__unreal-mcp__call_tool',
    tool_input: opts.mcp ? (args || {}) : { toolset_name: 'editor_toolset.toolsets.scene.SceneTools', tool_name: tool, arguments: args || {} } };
  await hook.run('claude', { cfg: opts.cfg || t.cfg, env: {}, stdout: { write: s => { out += s; } }, input });
  const h = out ? JSON.parse(out).hookSpecificOutput || {} : {};
  return { denied: h.permissionDecision === 'deny', reason: h.permissionDecisionReason || '', context: h.additionalContext || '' };
}
const post = (t, sid, tool, args, opts) => call(t, sid, tool, args, Object.assign({ event: 'PostToolUse' }, opts || {}));
const editor = t => t.store.readLock('Game~editor');

test('an ordinary editor call takes nothing; a level load holds the editor for the call and stamps the level', async () => {
  const t = setup();
  assert.ok(!(await call(t, 'A', 'get_current_level')).denied);
  assert.equal(editor(t), null);
  await call(t, 'A', 'load_level', { level_path: '/Game/L_Test' });
  const l = editor(t);
  assert.equal(l.by, 'hook-call');
  assert.equal(l.mode, 'hold');
  assert.equal(l.calls, 1);
  assert.equal(l.ttlMin, 5);
  await post(t, 'A', 'load_level', { level_path: '/Game/L_Test' });
  assert.equal(editor(t), null);
  const st = S.read(t.cfg, 'level');
  assert.equal(st.value, '/Game/L_Test');
  assert.equal(st.session, 'A');
  clean(t);
});

test('while chat A\'s call holds the editor, chat B waits - any call - and goes once it is done', async () => {
  const t = setup();
  await call(t, 'A', 'load_level', { level_path: '/Game/L' });
  const d = await call(t, 'B', 'get_current_level');
  assert.ok(d.denied, 'B is held behind A (denied after the short test wait)');
  assert.match(d.reason, /Game~editor/);
  const cfgB = t.load();
  cfgB.gateWaitSec = 20;
  const b = call(t, 'B', 'StartPIE', {}, { cfg: cfgB });
  await new Promise(r => setTimeout(r, 700));
  assert.ok(t.store.readWaiters('Game~editor').length, 'B queues as a waiter');
  await post(t, 'A', 'load_level', { level_path: '/Game/L' });
  assert.ok(!(await b).denied);
  assert.equal(editor(t).session, 'B', 'B now holds it for its PIE');
  clean(t);
});

test('a chat\'s own hold lets its calls through and is not dropped by them', async () => {
  const t = setup();
  const r = await client.acquire(t.cfg, t.store, 'editor', { mode: 'hold', session: 'A', chat: 'chat A', ownerPid: 0, env: {}, extra: { by: 'cli' } });
  assert.ok(r.ok);
  assert.ok(!(await call(t, 'A', 'load_level', { level_path: '/Game/L' })).denied);
  await post(t, 'A', 'load_level', { level_path: '/Game/L' });
  assert.equal(editor(t).by, 'cli', 'the real hold stays');
  const d = await call(t, 'B', 'save_assets', { asset_paths: [] });
  assert.ok(d.denied);
  assert.match(d.reason, /chat A/);
  clean(t);
});

test('save_assets with a list is not app-wide; with none it is', async () => {
  const t = setup();
  await call(t, 'A', 'save_assets', { asset_paths: ['/Game/A'] });
  assert.equal(editor(t), null);
  await call(t, 'A', 'save_assets', { asset_paths: [] });
  assert.equal(editor(t).by, 'hook-call');
  clean(t);
});

test('StartPIE keeps the call hold until StopPIE; a failed StartPIE frees it; calls are counted', async () => {
  const t = setup();
  await call(t, 'A', 'StartPIE');
  await post(t, 'A', 'StartPIE');
  assert.equal(editor(t).until, 'StopPIE');
  assert.equal(editor(t).ttlMin, 15);
  assert.ok((await call(t, 'B', 'get_current_level')).denied, 'mid-PIE another chat waits');
  await call(t, 'A', 'StopPIE');
  await post(t, 'A', 'StopPIE');
  assert.equal(editor(t), null);
  await call(t, 'A', 'StartPIE');
  await call(t, 'A', 'StartPIE', {}, { event: 'PostToolUseFailure' });
  assert.equal(editor(t), null);
  await call(t, 'A', 'load_level', { level_path: '/Game/A' });
  await call(t, 'A', 'reload_project_toolsets');
  assert.equal(editor(t).calls, 2, 'the overlay adds its own tools to the profile\'s');
  await post(t, 'A', 'load_level', { level_path: '/Game/A' });
  assert.equal(editor(t).calls, 1);
  await post(t, 'A', 'reload_project_toolsets');
  assert.equal(editor(t), null);
  clean(t);
});

test('a tool script that loads a level takes the call hold; Stop frees a forgotten one', async () => {
  const t = setup();
  await call(t, 'A', 'execute_tool_script', { script: 'def run():\n  execute_tool("x.SceneTools.get_current_level", "{}")\n  return {}' });
  assert.equal(editor(t), null);
  await call(t, 'A', 'execute_tool_script', { script: 'def run():\n  execute_tool("x.SceneTools.load_level", "{}")\n  return {}' });
  assert.equal(editor(t).by, 'hook-call');
  await hook.run('claude', { cfg: t.cfg, env: {}, stdout: { write() {} }, input: { session_id: 'A', hook_event_name: 'Stop', cwd: t.dir } });
  assert.equal(editor(t), null);
  clean(t);
});

test('before an app-wide call the model hears, once, that the build or the open level is another chat\'s', async () => {
  const t = setup();
  S.write(t.cfg, 'build', { session: 'B', chat: 'chat B' }, { cwd: t.dir });
  assert.equal((await call(t, 'A', 'get_current_level')).context, '', 'ordinary calls say nothing');
  const r = await call(t, 'A', 'StartPIE');
  assert.match(r.context, /Unreal Agent Hub, before this call: "build" is from chat B, \d\d:\d\d, not yours/);
  await call(t, 'A', 'StopPIE');
  await post(t, 'A', 'StopPIE');
  assert.equal((await call(t, 'A', 'StartPIE')).context, '', 'not repeated');
  clean(t);
});

test('a held Blender holds the other chat\'s Blender calls; the editor is not involved', async () => {
  const t = setup();
  const opts = { mcp: 'mcp__blender__get_scene_info' };
  assert.ok(!(await call(t, 'B', null, {}, opts)).denied);
  const r = await client.acquire(t.cfg, t.store, 'blender', { mode: 'hold', session: 'A', chat: 'chat A', ownerPid: 0, env: {}, extra: { by: 'cli' } });
  assert.ok(!(await call(t, 'A', null, {}, opts)).denied, 'the holder passes');
  const d = await call(t, 'B', null, {}, opts);
  assert.ok(d.denied);
  assert.match(d.reason, /Game~blender.*chat A/);
  client.release(t.cfg, t.store, r.key, r.token, 'test');
  assert.ok(!(await call(t, 'B', null, {}, opts)).denied);
  assert.equal(editor(t), null);
  clean(t);
});

test('a call hold is not "a restart under way" for the app watch', async () => {
  const t = setup();
  const W = require('../lib/watch.cjs');
  await call(t, 'A', 'load_level', { level_path: '/Game/L' });
  const w = { busyKeys: ['Game~editor'], project: 'Game' };
  assert.equal(W.restartPending(t.cfg, t.store, w), null);
  await post(t, 'A', 'load_level', { level_path: '/Game/L' });
  await client.acquire(t.cfg, t.store, 'editor', { mode: 'hold', session: 'A', ownerPid: 0, env: {}, extra: { by: 'cli' } });
  assert.match(W.restartPending(t.cfg, t.store, w) || '', /editor/, 'the same chat\'s real hold still is');
  clean(t);
});

test('stamps: none, mine, another chat\'s, changed files; `hub whose --require` exits 3', () => {
  const t = setup();
  const bin = path.join(t.dir, 'Binaries');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'Game-a.dll'), 'one');
  assert.equal(S.check(t.cfg, 'build', { session: 'A' }).known, false);
  const rec = S.write(t.cfg, 'build', { session: 'A', chat: 'chat A' }, { files: ['Binaries/Game-*.dll'], cwd: t.dir, note: 'Development' });
  assert.deepEqual(rec.files.map(f => f.path), ['Binaries/Game-a.dll']);
  assert.equal(rec.key, 'Game~build');
  assert.equal(S.check(t.cfg, 'build', { session: 'A' }).mine, true);
  const other = S.check(t.cfg, 'build', { session: 'B' });
  assert.equal(other.mine, false);
  assert.match(say(other.m), /"build" is from chat A, \d\d:\d\d, not yours/);
  fs.writeFileSync(path.join(bin, 'Game-a.dll'), 'a longer build');
  const ch = S.check(t.cfg, 'build', { session: 'A' });
  assert.equal(ch.changed, true, 'made outside the stamping step');
  assert.match(say(ch.m), /changed after chat A stamped it/);

  const env = Object.assign({}, process.env, { UAH_HOME: t.home, UAH_LANG: 'en', CLAUDE_CODE_SESSION_ID: 'B', UAH_CHAT: 'chat B' });
  const hub = args => spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'hub.cjs'), ...args], { cwd: t.dir, env, encoding: 'utf8' });
  const st = hub(['stamp', 'build', '--files', 'Binaries/Game-*.dll']);
  assert.equal(st.status, 0, st.stderr);
  assert.match(st.stdout, /stamped "build": 1 files/);
  assert.equal(hub(['whose', 'build', '--require']).status, 0, 'B stamped it: its own');
  const env2 = Object.assign({}, env, { CLAUDE_CODE_SESSION_ID: 'A' });
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'hub.cjs'), 'whose', 'build', '--require'], { cwd: t.dir, env: env2, encoding: 'utf8' });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /from chat B.*not yours.*--require/);
  assert.equal(spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'hub.cjs'), 'whose', 'build'], { cwd: t.dir, env: env2, encoding: 'utf8' }).status, 0, 'without --require only a line');
  clean(t);
});
