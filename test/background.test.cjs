// Background work of Claude Code chats: the Stop event's background_tasks ("working in the background"), task
// notices that end a task, cloud sessions recorded from start_session, and the board's subagents / cloud / `old` state.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { tempHome, fixture, rm } = require('./helpers.cjs');
const C = require('../lib/config.cjs');
const U = require('../lib/util.cjs');
const chats = require('../lib/chats.cjs');
const T = require('../lib/adapters/claude-transcripts.cjs');
const desktop = require('../lib/adapters/claude-desktop.cjs');

// A project folder with an overlay, an isolated hub home, and a listener on the board port so the hook does not
// start a real board.
async function setup() {
  const port = 19000 + Math.floor(Math.random() * 900);
  const home = tempHome({ id: 'm1', port, resources: [{ id: 'cpp', ttlMin: 30 }] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uah-bg-'));
  fs.writeFileSync(path.join(dir, '.unreal-agent-hub.json'), JSON.stringify({ project: 'Game' }));
  const cfg = C.load({ env: { UAH_HOME: home }, cwd: dir });
  const board = net.createServer(s => s.destroy());
  await new Promise(r => board.listen(port, '127.0.0.1', r));
  return { home, dir, cfg, close: () => new Promise(r => board.close(r)) };
}

async function hook(t, name, patch) {
  const input = Object.assign(fixture('claude', name), { cwd: t.dir, session_id: 'sess-bg' }, patch || {});
  let out = '';
  await require('../lib/hook.cjs').run('claude', { cfg: t.cfg, stdout: { write: s => { out += s; } }, input, env: {} });
  return out;
}

const logged = t => fs.readFileSync(path.join(t.cfg.stateDir, 'chats.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));

test('Stop with unfinished background tasks: "background", and the list keeps only unfinished ones', async () => {
  const t = await setup();
  try {
    await hook(t, 'userpromptsubmit');
    await hook(t, 'stop-background');
    let rec = chats.read(t.cfg, 'sess-bg');
    assert.equal(rec.state, 'background');
    assert.deepEqual(rec.background.map(x => [x.id, x.type]), [['bsh7k2m9q', 'shell'], ['a41f0c9e2b7d5a13', 'subagent']]);
    assert.equal(rec.background[1].agentType, 'Explore');
    assert.equal(rec.transcript, '/home/user/.claude/projects/p/abc123.jsonl');
    // idle_prompt does not turn a chat with background work into "waiting for a prompt"
    await hook(t, 'notification-idle');
    assert.equal(chats.read(t.cfg, 'sess-bg').state, 'background');
    // the notice of the finished build drops it from the list
    await hook(t, 'userpromptsubmit-task-notification');
    rec = chats.read(t.cfg, 'sess-bg');
    assert.equal(rec.state, 'working');
    assert.deepEqual(rec.background.map(x => x.id), ['a41f0c9e2b7d5a13']);
    // a Stop without background work: idle again, and idle_prompt keeps it idle
    await hook(t, 'stop', { background_tasks: [{ id: 'a41f0c9e2b7d5a13', type: 'subagent', status: 'completed' }] });
    rec = chats.read(t.cfg, 'sess-bg');
    assert.equal(rec.state, 'idle');
    assert.deepEqual(rec.background, []);
    await hook(t, 'notification-idle');
    assert.equal(chats.read(t.cfg, 'sess-bg').state, 'idle');
    assert.deepEqual(logged(t).map(e => e.state), ['working', 'background', 'background', 'working', 'idle', 'idle']);
  } finally { await t.close(); rm(t.home); rm(t.dir); }
});

test('PostToolUse of start_session with target "cloud" records the cloud session; other tools change nothing', async () => {
  const t = await setup();
  try {
    await hook(t, 'userpromptsubmit');
    const before = logged(t).length;
    assert.equal(await hook(t, 'posttooluse-start-session'), '', 'PostToolUse never answers');
    let rec = chats.read(t.cfg, 'sess-bg');
    assert.equal(rec.cloud.length, 1);
    assert.deepEqual([rec.cloud[0].title, rec.cloud[0].remote, rec.cloud[0].task], ['Profile the harbor level on the cloud runner', 'session_01AbCdEfGhIjKlMnOp', 'task_5e8a9c21']);
    assert.equal(rec.state, 'working', 'a tool call keeps the state');
    // the same session again replaces its record; a local start_session or another tool is ignored
    await hook(t, 'posttooluse-start-session');
    await hook(t, 'posttooluse-start-session', { tool_input: { title: 'Local side task', target: 'local' } });
    const updated = chats.read(t.cfg, 'sess-bg').updated;
    await hook(t, 'posttooluse-start-session', { tool_name: 'Bash', tool_input: { command: 'ls', target: 'cloud' } });
    rec = chats.read(t.cfg, 'sess-bg');
    assert.equal(rec.cloud.length, 1);
    assert.equal(rec.updated, updated, 'another tool does not touch the record');
    assert.equal(logged(t).length, before, 'PostToolUse is not a state change for the timeline');
  } finally { await t.close(); rm(t.home); rm(t.dir); }
});

test('helpers: backgroundOf, finishedIds, cloudStart', () => {
  assert.equal(chats.backgroundOf(undefined), null, 'no list at all is not "nothing in the background"');
  assert.deepEqual(chats.backgroundOf([{ id: 'x', status: 'failed' }, { id: 'y', status: 'killed' }]), []);
  assert.deepEqual(chats.finishedIds('<task-notification><task-id>a</task-id><status>running</status></task-notification>'), []);
  assert.deepEqual(chats.finishedIds('x <task-notification><task-id> b </task-id><status>failed</status></task-notification>'), ['b']);
  assert.equal(chats.cloudStart('mcp__ccd_session__start_session', { target: 'local' }, ''), null);
  assert.equal(chats.cloudStart('mcp__other__start_session', { target: 'cloud', title: 'x' }, { text: 'session_0123456789ab' }).remote, 'session_0123456789ab');
});

// --- board state ------------------------------------------------------------------------------------------------

function writeSubagent(dir, id, meta, ageMin) {
  fs.mkdirSync(dir, { recursive: true });
  const log = path.join(dir, `agent-${id}.jsonl`), m = path.join(dir, `agent-${id}.meta.json`);
  fs.writeFileSync(log, '{}\n');
  fs.writeFileSync(m, JSON.stringify(meta));
  const at = new Date(Date.now() - ageMin * 60e3);
  fs.utimesSync(log, at, at);
  fs.utimesSync(m, at, at);
}

test('subagents: running, finished, quiet, listed in the background, too old', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'uah-sub-'));
  try {
    const transcript = path.join(base, 'projects', 'p', 's1.jsonl');
    const dir = path.join(base, 'projects', 'p', 's1', 'subagents');
    writeSubagent(dir, 'run', { description: 'Find the shader cache', agentType: 'Explore', model: 'haiku', requestShape: 'background' }, 1);
    writeSubagent(dir, 'done', { description: 'Read the logs', agentType: 'general-purpose', finished: true }, 2);
    writeSubagent(dir, 'quiet', { description: 'Silent one', agentType: 'Plan' }, 30);
    writeSubagent(dir, 'listed', { description: 'Long research', agentType: 'general-purpose' }, 40);
    writeSubagent(dir, 'stopped', { description: 'Stopped by the person', stoppedByUser: true }, 1);
    writeSubagent(dir, 'old', { description: 'Yesterday' }, 5 * 60);
    const c = { session: 's1', transcript, state: 'background', background: [{ id: 'listed', type: 'subagent' }] };
    const subs = T.subagentsOf(c, true);
    const by = Object.fromEntries(subs.map(a => [a.id, a]));
    assert.deepEqual(Object.keys(by).sort(), ['done', 'listed', 'quiet', 'run', 'stopped']);
    assert.equal(by.run.running, true);
    assert.equal(by.run.background, true);
    assert.deepEqual([by.run.description, by.run.type, by.run.model], ['Find the shader cache', 'Explore', 'haiku']);
    assert.equal(by.done.running, false);
    assert.equal(by.quiet.running, false, 'silent for 30 min counts as finished');
    assert.equal(by.listed.running, true, 'listed in the chat\'s background tasks');
    assert.equal(by.stopped.running, false);
    assert.equal(by.stopped.stopped, true);
    // a closed chat: only the ones it still lists run (none, since it is not busy any more)
    assert.equal(T.subagentsOf(Object.assign({}, c, { state: 'gone' }), false).filter(a => a.running).length, 0);
    // the transcript path from the CLI's naming when the hook did not record one
    assert.equal(T.transcriptOf({ session: 's2', cwd: 'D:\\Games\\My Game' }, '/h'), path.join('/h', '.claude', 'projects', 'D--Games-My-Game', 's2.jsonl'));
  } finally { rm(base); }
});

test('cloud sessions: hook record merged with the desktop list, title from the transcript, status', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'uah-cloud-'));
  try {
    const transcript = path.join(base, 's1.jsonl');
    fs.writeFileSync(transcript, [
      JSON.stringify({ message: { content: [{ type: 'tool_use', name: 'mcp__ccd_session__start_session', input: { target: 'cloud', title: 'Bake "night" lighting' } }] } }),
      JSON.stringify({ message: { content: [{ type: 'tool_result', content: 'started session_02ZyXwVuTsRqPoNm' }] } }),
    ].join('\n'));
    const rec = { session: 's1', transcript, state: 'idle', cloud: [{ title: 'Profile the harbor', remote: 'session_01AbCdEfGhIjKlMnOp', task: 'task_5e8a9c21', started: 1000 }] };
    const desk = { cloud: [{ taskId: 'task_aaaaaa11', sessionId: 'session_02ZyXwVuTsRqPoNm' }, { taskId: 'task_5e8a9c21', sessionId: 'session_01AbCdEfGhIjKlMnOp' }] };
    const list = T.cloudOf(rec, desk);
    const by = Object.fromEntries(list.map(c => [c.remote, c]));
    assert.equal(list.length, 2);
    assert.equal(by.session_01AbCdEfGhIjKlMnOp.title, 'Profile the harbor');
    assert.equal(by.session_01AbCdEfGhIjKlMnOp.started, 1000);
    assert.equal(by.session_02ZyXwVuTsRqPoNm.title, 'Bake "night" lighting', 'title found in the parent transcript');
    assert.equal(by.session_02ZyXwVuTsRqPoNm.url, 'https://claude.ai/code/session_02ZyXwVuTsRqPoNm');
    assert.equal(by.session_01AbCdEfGhIjKlMnOp.status, 'seen');
    const busy = T.cloudOf(Object.assign({}, rec, { state: 'background', background: [{ id: 'cloud-session_01AbCdEfGhIjKlMnOp', type: 'cloud session', status: 'running' }] }), null);
    assert.equal(busy[0].status, 'running');
  } finally { rm(base); }
});

test('desktop records: roots under LOCALAPPDATA/Claude-Data, cloudSpawnedTasks', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'uah-desk-'));
  try {
    const root = path.join(base, 'local', 'Claude-Data', 'profile1', 'claude-code-sessions');
    const org = path.join(root, 'acct', 'org');
    fs.mkdirSync(org, { recursive: true });
    U.writeJson(path.join(org, 'local_abc.json'), { sessionId: 'local_abc', cliSessionId: 's1', title: 'Harbor lighting', lastActivityAt: Date.now(),
      cloudSpawnedTasks: [{ taskId: 'task_1', sessionId: 'session_0123456789ab' }, null] });
    const env = { APPDATA: path.join(base, 'roaming'), LOCALAPPDATA: path.join(base, 'local'), CLAUDE_CODE_HOST_SESSION_ID: 'local_abc', CLAUDE_CODE_ACCOUNT_UUID: 'acct', CLAUDE_CODE_ORGANIZATION_UUID: 'org' };
    assert.deepEqual(desktop.roots(env), [root]);
    const recs = desktop.recent(3600e3, env);
    assert.equal(recs.length, 1);
    assert.deepEqual(recs[0].cloud, [{ taskId: 'task_1', sessionId: 'session_0123456789ab' }]);
    assert.equal(desktop.sessionRecord(env).title, 'Harbor lighting');
  } finally { rm(base); }
});

test('board state: background list, subagents, cloud, `old` for chats closed long ago, ?live=1', async () => {
  const port = 19900 + Math.floor(Math.random() * 90);
  const home = tempHome({ id: 'm1', port, resources: [{ id: 'cpp' }] });
  const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'uah-ch-'));
  const cfg = require('./helpers.cjs').loadCfg(home);
  const now = Date.now();
  const transcript = path.join(claudeHome, 'projects', 'p', 'live.jsonl');
  writeSubagent(path.join(claudeHome, 'projects', 'p', 'live', 'subagents'), 'a1', { description: 'Scan the logs', agentType: 'Explore' }, 1);
  chats.update(cfg, 'live', { title: 'Lighting', agent: 'claude', machine: 'm1', state: 'background', transcript,
    background: [{ id: 'b1', type: 'shell', status: 'running', description: 'Build' }],
    cloud: [{ title: 'Cloud profile', remote: 'session_01AbCdEfGhIjKlMnOp', task: 'task_5e8a9c21', started: now }] });
  chats.update(cfg, 'idle-one', { title: 'Idle', agent: 'claude', machine: 'm1', state: 'idle', background: [{ id: 'stale', type: 'shell' }] });
  chats.update(cfg, 'closed', { title: 'Closed long ago', agent: 'codex', machine: 'm1', state: 'ended' });
  const f = chats.file(cfg, 'closed');
  U.writeJson(f, Object.assign(U.readJson(f), { updated: now - 7 * 3600e3 }));
  const { createBoard } = require('../lib/server/board.cjs');
  const b = createBoard(cfg, { noTunnels: true, noWatch: true, log: false, claudeHome });
  try {
    const st = b.buildState();
    const by = Object.fromEntries(st.sessions.map(s => [s.session, s]));
    assert.deepEqual(by.live.background.map(x => x.id), ['b1']);
    assert.deepEqual(by['idle-one'].background, [], 'an idle chat shows no background work');
    assert.equal(by.live.subagents, 1);
    assert.equal(st.subagents.length, 1);
    assert.deepEqual([st.subagents[0].description, st.subagents[0].chat, st.subagents[0].running], ['Scan the logs', 'Lighting', true]);
    assert.equal(st.cloud.length, 1);
    assert.deepEqual([st.cloud[0].title, st.cloud[0].parentTitle, st.cloud[0].url], ['Cloud profile', 'Lighting', 'https://claude.ai/code/session_01AbCdEfGhIjKlMnOp']);
    assert.equal(by.closed.old, true);
    assert.equal(by.live.old, false);
    assert.equal(st.hidden, 1);
    assert.equal(b.buildState({ live: true }).sessions.some(s => s.session === 'closed'), false);
    // the timeline's chat history knows the background kind
    chats.event(cfg, { session: 'live', title: 'Lighting', event: 'UserPromptSubmit', state: 'working' });
    chats.event(cfg, { session: 'live', title: 'Lighting', event: 'PreToolUse', state: 'working' });
    chats.event(cfg, { session: 'live', title: 'Lighting', event: 'Stop', state: 'background' });
    const h = b.buildState().history.chats.filter(c => c.session === 'live');
    assert.deepEqual(h.map(c => c.kind), ['working', 'background'], 'a tool call continues the working interval');
  } finally { await b.close(); rm(home); rm(claudeHome); }
});
