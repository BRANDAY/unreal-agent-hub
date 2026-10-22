// The MCP server over stdio, and install-hooks for the three agents (on temporary files only).
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { tempHome, loadCfg, rm } = require('./helpers.cjs');

test('MCP: initialize, tools/list, hub_status, hub_hold and hub_release', async () => {
  const home = tempHome({ id: 'studio', resources: [{ id: 'cpp', ttlMin: 30 }] });
  const p = cp.spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'hub.cjs'), 'mcp'], { env: Object.assign({}, process.env, { UAH_HOME: home, CLAUDE_CODE_SESSION_ID: '' }) });
  const replies = new Map();
  let buf = '';
  p.stdout.on('data', d => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim()) { const m = JSON.parse(line); replies.set(m.id, m); } }
  });
  const call = (id, method, params) => new Promise((resolve, reject) => {
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    const t0 = Date.now();
    const iv = setInterval(() => { if (replies.has(id)) { clearInterval(iv); resolve(replies.get(id)); } else if (Date.now() - t0 > 8000) { clearInterval(iv); reject(new Error('no reply ' + method)); } }, 10);
  });
  try {
    const init = await call(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    assert.equal(init.result.serverInfo.name, 'unreal-agent-hub');
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const list = await call(2, 'tools/list', {});
    assert.deepEqual(list.result.tools.map(t => t.name), ['hub_status', 'hub_hold', 'hub_release', 'hub_here', 'hub_grant', 'hub_decline']);
    const st = await call(3, 'tools/call', { name: 'hub_status', arguments: {} });
    assert.match(st.result.content[0].text, /cpp\s+free/);
    const hold = await call(4, 'tools/call', { name: 'hub_hold', arguments: { resource: 'cpp', note: 'test', wait_sec: 0 } });
    assert.equal(hold.result.isError, undefined, JSON.stringify(hold));
    assert.match(fs.readFileSync(path.join(home, 'state', 'cpp.json'), 'utf8'), /"mode": "hold"/);
    const rel = await call(5, 'tools/call', { name: 'hub_release', arguments: { resource: 'cpp' } });
    assert.match(rel.result.content[0].text, /Released cpp/);
    const bad = await call(6, 'nope', {});
    assert.equal(bad.error.code, -32601);
  } finally {
    p.kill();
    rm(home);
  }
});

test('install-hooks: Claude, Codex and Cursor files; re-run replaces, uninstall keeps foreign hooks', () => {
  const home = tempHome({ id: 'studio' });
  const cfg = loadCfg(home);
  const I = require('../lib/install-hooks.cjs');
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'uah-hooks-'));
  const claude = path.join(dir, 'settings.json');
  fs.writeFileSync(claude, JSON.stringify({ model: 'x', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo foreign' }] }] } }));
  I.run({ agent: 'claude', file: claude, cfg });
  I.run({ agent: 'claude', file: claude, cfg }); // twice: still one set
  let s = JSON.parse(fs.readFileSync(claude, 'utf8'));
  assert.equal(s.model, 'x');
  assert.equal(s.hooks.PreToolUse.length, 2, 'the foreign hook and ours');
  assert.equal(s.hooks.PreToolUse[1].hooks[0].timeout, 1800);
  assert.match(s.hooks.SessionStart[0].hooks[0].command, /hook --agent claude$/);
  assert.ok(s.hooks.Notification);
  assert.equal(s.hooks.PostToolUse[0].matcher, 'mcp__.*__start_session', 'PostToolUse only for start_session (cloud sessions)');
  I.run({ agent: 'claude', file: claude, cfg, uninstall: true });
  s = JSON.parse(fs.readFileSync(claude, 'utf8'));
  assert.deepEqual(Object.keys(s.hooks), ['PreToolUse']);
  assert.equal(s.hooks.PreToolUse[0].hooks[0].command, 'echo foreign');
  assert.ok(fs.readdirSync(dir).some(n => n.includes('.bak-agent-hub-')), 'a backup was kept');

  const codex = path.join(dir, 'codex-hooks.json');
  const rc = I.run({ agent: 'codex', file: codex, cfg });
  const c = JSON.parse(fs.readFileSync(codex, 'utf8'));
  assert.ok(c.hooks.PreToolUse && !c.hooks.Notification && !c.hooks.PostToolUse, 'Codex has no Notification event and no start_session');
  assert.equal(c.hooks.SessionEnd[0].hooks[0].timeout, 3);
  assert.ok(rc.notes.some(n => /trust/.test(n)));

  const cursor = path.join(dir, 'cursor-hooks.json');
  I.run({ agent: 'cursor', file: cursor, cfg });
  const cu = JSON.parse(fs.readFileSync(cursor, 'utf8'));
  assert.equal(cu.version, 1);
  assert.deepEqual(Object.keys(cu.hooks), ['sessionStart', 'beforeSubmitPrompt', 'beforeShellExecution', 'beforeMCPExecution', 'stop', 'sessionEnd']);
  assert.match(cu.hooks.beforeShellExecution[0].command, /--agent cursor$/);
  rm(dir);
  rm(home);
});

test('hook end to end: a Cursor shell call of an Unreal project gets valid JSON back', () => {
  const home = tempHome({ id: 'studio', machineResource: 'studio-gpu', resources: [{ id: 'studio-gpu', ttlMin: 30 }] });
  const proj = fs.mkdtempSync(path.join(require('os').tmpdir(), 'uah-proj-'));
  fs.writeFileSync(path.join(proj, 'Game.uproject'), '{}');
  const input = { conversation_id: 'c1', hook_event_name: 'beforeShellExecution', cursor_version: '2.4.0', workspace_roots: [proj], command: 'echo hi', cwd: proj };
  const r = cp.spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'hub.cjs'), 'hook', '--agent', 'cursor'],
    { input: JSON.stringify(input), env: Object.assign({}, process.env, { UAH_HOME: home }), encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout), { continue: true, permission: 'allow' });
  assert.ok(fs.existsSync(path.join(home, 'state', 'chats', 'c1.json')));
  // Outside any profile: allowed, nothing recorded.
  const other = fs.mkdtempSync(path.join(require('os').tmpdir(), 'uah-other-'));
  const r2 = cp.spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'hub.cjs'), 'hook', '--agent', 'cursor'],
    { input: JSON.stringify(Object.assign({}, input, { conversation_id: 'c2', workspace_roots: [other], cwd: other })), env: Object.assign({}, process.env, { UAH_HOME: home }), encoding: 'utf8' });
  assert.deepEqual(JSON.parse(r2.stdout), { continue: true, permission: 'allow' });
  assert.ok(!fs.existsSync(path.join(home, 'state', 'chats', 'c2.json')));
  rm(proj); rm(other); rm(home);
});
