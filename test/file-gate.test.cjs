// The file gate (lib/file-gate.cjs, docs/FILES.md): which paths it watches, a shared file claimed by the first
// chat until its work is committed or merged into main, and edits of build files waiting for the build resource.
// Every test works in a throwaway git repository and an isolated hub home.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { tempHome, rm } = require('./helpers.cjs');
const C = require('../lib/config.cjs');
const FG = require('../lib/file-gate.cjs');
const client = require('../lib/lock-client.cjs');
const agents = require('../lib/agents/index.cjs');
const { Store } = require('../lib/store.cjs');

const UNREAL = require('../profiles/unreal.json');
const FILES = { build: ['Source/**', '**/*.Build.cs'], buildResource: 'cpp', claim: ['Tools/**', 'Config/*.ini'], free: ['**/*.md'] };

function sh(dir, args, env) {
  return cp.execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: Object.assign({}, process.env, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }, env || {}) });
}

// A project with an overlay (`files` block, generic profile) in a git repository on branch main.
function project(overlayFiles) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uah-proj-'));
  sh(dir, ['init', '-q', '-b', 'main', '.']);
  sh(dir, ['config', 'core.autocrlf', 'false']);
  fs.writeFileSync(path.join(dir, '.unreal-agent-hub.json'), JSON.stringify({ project: 'Game', files: overlayFiles === undefined ? FILES : overlayFiles }));
  fs.mkdirSync(path.join(dir, 'Tools'));
  fs.mkdirSync(path.join(dir, 'Source'));
  fs.writeFileSync(path.join(dir, 'Tools', 'run.py'), 'print(1)\n');
  fs.writeFileSync(path.join(dir, 'Source', 'Game.cpp'), 'int x;\n');
  fs.mkdirSync(path.join(dir, 'Config'));
  fs.writeFileSync(path.join(dir, 'Config', 'DefaultEngine.ini'), '[Core]\n');
  sh(dir, ['add', '-A']);
  // An hour old: git keeps whole seconds, and a commit in the same second as a claim counts as "merged after it".
  sh(dir, ['commit', '-q', '-m', 'init'], { GIT_COMMITTER_DATE: new Date(Date.now() - 3600e3).toISOString() });
  return dir;
}

function setup(machine) {
  const home = tempHome(Object.assign({ id: 'm1', resources: [{ id: 'cpp', ttlMin: 30 }, { id: 'cook', ttlMin: 30 }] }, machine || {}));
  const dir = project();
  const cfg = C.load({ env: { UAH_HOME: home }, cwd: dir });
  const match = C.profileFor(cfg, dir);
  const store = new Store(cfg.stateDir, { machine: 'm1' });
  return { home, dir, cfg, match, profile: match.profile, store };
}

const edit = (dir, rel) => ({ tool: 'Edit', files: [rel], cwd: dir, event: 'PreToolUse' });
const A = { session: 'sess-A', chat: 'chat A', agent: 'claude' };
const B = { session: 'sess-B', chat: 'chat B', agent: 'claude' };
const touch = (dir, rel, text) => fs.appendFileSync(path.join(dir, rel), text || '// edit\n');

test('which paths the gate watches: build files, claimed files, free files', () => {
  const s = FG.settings({ project: null }, UNREAL);
  const k = rel => { const c = FG.classify(s, rel); return c.build ? 'build' : c.claim ? 'claim' : '-'; };
  assert.equal(k('Source/Game/Hero.cpp'), 'build');
  assert.equal(k('Source/Game/Game.Build.cs'), 'build');
  assert.equal(k('Plugins/Tools/Foo/Source/Foo/Bar.h'), 'build');
  assert.equal(k('Plugins/Foo/Foo.uplugin'), 'build');
  assert.equal(k('Game.uproject'), 'build');
  assert.equal(k('source/game/hero.cpp'), 'build', 'case-insensitive');
  assert.equal(k('Config/DefaultEngine.ini'), 'claim');
  assert.equal(k('Config/Windows/WindowsEngine.ini'), '-', '* stays inside one folder');
  assert.equal(k('Source/README.md'), '-', 'free wins');
  assert.equal(k('Content/Maps/L_Main.umap'), '-');
  assert.equal(FG.settings({ project: { files: false } }, UNREAL), null, 'an overlay turns the gate off with files: false');
  assert.equal(FG.settings({ project: null }, { name: 'generic' }), null, 'no files block, no gate');
  const o = FG.settings({ project: { files: { claim: ['Scripts/**'] } } }, UNREAL);
  assert.deepEqual([o.claim, o.buildResource, o.build.length], [['Scripts/**'], 'cpp', UNREAL.files.build.length], 'the overlay replaces single keys');
});

test('edited files come from Claude Code, Codex apply_patch and Cursor payloads', () => {
  const ed = agents.read({ session_id: 's', hook_event_name: 'PreToolUse', cwd: '/p', tool_name: 'Edit', tool_input: { file_path: '/p/Source/A.cpp', old_string: 'a', new_string: 'b' } }, 'claude', {}).ev;
  assert.deepEqual(ed.files, ['/p/Source/A.cpp']);
  const nb = agents.read({ session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'NotebookEdit', tool_input: { notebook_path: 'a.ipynb' } }, 'claude', {}).ev;
  assert.deepEqual(nb.files, ['a.ipynb']);
  const patch = '*** Begin Patch\n*** Update File: Source/A.cpp\n@@\n-a\n+b\n*** Add File: Tools/new.py\n+x\n*** End Patch';
  const cx = agents.read({ session_id: 's', turn_id: 't', hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: { command: patch } }, 'codex', {}).ev;
  assert.deepEqual(cx.files, ['Source/A.cpp', 'Tools/new.py']);
  assert.equal(cx.command, '', 'a patch is not a shell command for the gates');
  const cu = agents.read({ conversation_id: 'c', cursor_version: '1', hook_event_name: 'preToolUse', tool_name: 'Write', tool_input: JSON.stringify({ file_path: 'Tools/a.py' }) }, 'cursor', {}).ev;
  assert.deepEqual(cu.files, ['Tools/a.py']);
  const bash = agents.read({ session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }, 'claude', {}).ev;
  assert.deepEqual(bash.files, []);
});

test('claim: the first chat holds a shared file until its change is committed', async () => {
  const t = setup();
  const { cfg, profile, match, store, dir } = t;
  assert.deepEqual(await FG.check(cfg, profile, match, edit(dir, 'Tools/run.py'), A, { store, client }), { ok: true });
  touch(dir, 'Tools/run.py');
  const denied = await FG.check(cfg, profile, match, edit(dir, 'Tools/run.py'), B, { store, client });
  assert.equal(denied.ok, false);
  assert.match(denied.reason, /Tools\/run\.py is being edited by chat "chat A"/);
  assert.match(denied.reason, /hub claims release/);
  assert.equal((await FG.check(cfg, profile, match, edit(dir, 'Tools/run.py'), A, { store, client })).ok, true, 'the holder goes on');
  assert.equal((await FG.check(cfg, profile, match, edit(dir, 'Tools/other.py'), B, { store, client })).ok, true, 'another file is free');
  assert.equal((await FG.check(cfg, profile, match, edit(dir, 'Docs/notes.md'), B, { store, client })).ok, true, 'unwatched paths are free');
  const listed = FG.list(cfg).find(c => c.rel === 'Tools/run.py');
  assert.deepEqual([listed.session, listed.active], ['sess-A', true]);

  sh(dir, ['commit', '-q', '-am', 'A done']);
  assert.equal((await FG.check(cfg, profile, match, edit(dir, 'Tools/run.py'), B, { store, client })).ok, false, 'clean, but within the grace for a pending edit');
  assert.equal((await FG.check(cfg, profile, match, edit(dir, 'Tools/run.py'), B, { store, client, now: Date.now() + 180e3 })).ok, true, 'committed: the claim is over');
  assert.equal(FG.list(cfg).find(c => c.rel === 'Tools/run.py').session, 'sess-B', 'the claim passed to the next chat');
  assert.match(fs.readFileSync(path.join(cfg.stateDir, 'log.txt'), 'utf8'), /CLAIMDENY Tools\/run\.py[\s\S]*CLAIMTAKE Tools\/run\.py by chat B \(was chat A, clean\)/);
  rm(t.home); rm(dir);
});

test('claim: ends when the holder\'s work is merged into main, even if the file is dirty again', async () => {
  const t = setup();
  const { cfg, profile, match, store, dir } = t;
  const now = Date.now();
  // An older commit touching the file does not end a claim made after it.
  touch(dir, 'Config/DefaultEngine.ini', '[a]\n');
  sh(dir, ['add', '-A']);
  sh(dir, ['commit', '-q', '-m', 'old'], { GIT_COMMITTER_DATE: new Date(now - 600e3).toISOString() });
  assert.equal((await FG.check(cfg, profile, match, edit(dir, 'Config/DefaultEngine.ini'), A, { store, client, now: now - 300e3 })).ok, true);
  touch(dir, 'Config/DefaultEngine.ini', 'x=1\n');
  assert.equal((await FG.check(cfg, profile, match, edit(dir, 'Config/DefaultEngine.ini'), B, { store, client, now })).ok, false, 'older commit: still held');
  // The holder commits on a task branch, the branch is merged into main, and someone's edit makes the file dirty again.
  sh(dir, ['checkout', '-q', '-b', 'task/a']);
  sh(dir, ['commit', '-q', '-am', 'A on a branch'], { GIT_COMMITTER_DATE: new Date(now - 200e3).toISOString() });
  sh(dir, ['checkout', '-q', 'main']);
  touch(dir, 'Config/DefaultEngine.ini', 'y=2\n');
  assert.equal((await FG.check(cfg, profile, match, edit(dir, 'Config/DefaultEngine.ini'), B, { store, client, now })).ok, false, 'not merged yet: still held');
  sh(dir, ['checkout', '-q', '--', 'Config/DefaultEngine.ini']);
  sh(dir, ['merge', '-q', '--ff-only', 'task/a']);
  touch(dir, 'Config/DefaultEngine.ini', 'z=3\n');
  assert.ok(sh(dir, ['status', '--porcelain']).includes('DefaultEngine.ini'), 'the file is dirty again');
  assert.equal((await FG.check(cfg, profile, match, edit(dir, 'Config/DefaultEngine.ini'), B, { store, client, now })).ok, true, 'merged into main: the claim is over');
  rm(t.home); rm(dir);
});

test('claim: ends after claimHours without an edit, and `release` frees it by hand', async () => {
  const t = setup();
  const { cfg, profile, match, store, dir } = t;
  const now = Date.now();
  await FG.check(cfg, profile, match, edit(dir, 'Tools/run.py'), A, { store, client, now: now - 7 * 3600e3 });
  touch(dir, 'Tools/run.py');
  assert.equal((await FG.check(cfg, profile, match, edit(dir, 'Tools/run.py'), B, { store, client, now })).ok, true, 'idle for 7 h (> 6): over');
  touch(dir, 'Tools/run.py');
  assert.equal((await FG.check(cfg, profile, match, edit(dir, 'Tools/run.py'), A, { store, client, now })).ok, false, 'now B holds it');
  const r = FG.release(cfg, 'Tools/run.py', dir, store);
  assert.equal(r.claim.session, 'sess-B');
  assert.equal((await FG.check(cfg, profile, match, edit(dir, 'Tools/run.py'), A, { store, client, now })).ok, true);
  assert.equal(FG.release(cfg, 'Tools/nothing.py', dir, store).ok, false);
  rm(t.home); rm(dir);
});

test('two chats claiming one file at the same moment: exactly one wins', async () => {
  const t = setup();
  const { cfg, profile, match, store, dir } = t;
  touch(dir, 'Tools/run.py');
  const rs = await Promise.all([A, B].map(w => FG.check(cfg, profile, match, edit(dir, 'Tools/run.py'), w, { store, client })));
  assert.equal(rs.filter(r => r.ok).length, 1);
  rm(t.home); rm(dir);
});

test('build files wait while another chat or script holds cpp, and go on when it is released', async () => {
  const t = setup();
  const { cfg, profile, match, store, dir } = t;
  const build = await client.acquire(cfg, store, 'cpp', { mode: 'script', session: 'sess-X', chat: 'build chat', script: 'build.ps1', noWait: true });
  assert.equal(build.ok, true);
  let waitedFor = '';
  setTimeout(() => client.release(cfg, store, 'cpp', build.token, 'done'), 400);
  const t0 = Date.now();
  const r = await FG.check(cfg, profile, match, edit(dir, 'Source/Game.cpp'), A, { store, client, pollMs: 50, waitSec: 20, onWait: key => { waitedFor = key; } });
  assert.equal(r.ok, true);
  assert.ok(Date.now() - t0 >= 350, 'it waited for the release');
  assert.equal(waitedFor, 'cpp');
  assert.equal((await FG.check(cfg, profile, match, edit(dir, 'Tools/run.py'), B, { store, client })).ok, true, 'non-build files never wait');

  // Held and never released: denied after waitSec with the holder's name.
  const again = await client.acquire(cfg, store, 'cpp', { mode: 'script', session: 'sess-X', chat: 'build chat', script: 'package.ps1', noWait: true });
  const d = await FG.check(cfg, profile, match, edit(dir, 'Source/Other.cpp'), B, { store, client, pollMs: 50, waitSec: 0.3 });
  assert.equal(d.ok, false);
  assert.match(d.reason, /Source\/Other\.cpp: "cpp" is busy - .*build chat/);
  // The holder's own chat is not held back by its own build.
  const own = await FG.check(cfg, profile, match, edit(dir, 'Source/Other.cpp'), { session: 'sess-X', chat: 'build chat' }, { store, client, pollMs: 50, waitSec: 0.3 });
  assert.equal(own.ok, true);
  client.release(cfg, store, 'cpp', again.token, 'done');
  rm(t.home); rm(dir);
});

test('the hook denies another chat\'s edit of a claimed file in the agent\'s own format', async () => {
  const t = setup();
  const { cfg, dir } = t;
  const hook = require('../lib/hook.cjs');
  const run = async (sid, file) => {
    let out = '';
    await hook.run('claude', { cfg, stdout: { write: s => { out += s; } },
      input: { session_id: sid, hook_event_name: 'PreToolUse', cwd: dir, tool_name: 'Write', tool_input: { file_path: path.join(dir, file), content: 'x' } } });
    return out ? JSON.parse(out) : null;
  };
  assert.equal(await run('sess-A', 'Tools/run.py'), null, 'allowed: no output');
  touch(dir, 'Tools/run.py');
  const d = await run('sess-B', 'Tools/run.py');
  assert.equal(d.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(d.hookSpecificOutput.permissionDecisionReason, /being edited by chat/);
  rm(t.home); rm(dir);
});

test('`hub lock cpp,cook` holds both for the command and frees both after it', () => {
  const t = setup();
  const env = Object.assign({}, process.env, { UAH_HOME: t.home, UAH_NODE_PROBE: 'off' });
  delete env.UAH_TOKEN_CPP; delete env.UAH_TOKEN_COOK;
  const probe = "const s=require('fs').readdirSync(process.argv[1]);console.log([!!process.env.UAH_TOKEN_CPP,!!process.env.UAH_TOKEN_COOK,s.filter(n=>n==='cpp.json'||n==='cook.json').sort().join(',')].join(' '))";
  const lockDir = new Store(t.cfg.stateDir, { machine: 'm1' }).lockFile('cpp').replace(/[^\\/]+$/, '');
  const out = cp.execFileSync(process.execPath, [path.join(__dirname, '..', 'bin', 'hub.cjs'), 'lock', 'cpp,cook', '--', process.execPath, '-e', probe, lockDir],
    { cwd: os.tmpdir(), env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  assert.equal(out, 'true true cook.json,cpp.json');
  const st = new Store(t.cfg.stateDir, { machine: 'm1' });
  assert.equal(st.readLock('cpp'), null);
  assert.equal(st.readLock('cook'), null);
  rm(t.home); rm(t.dir);
});
