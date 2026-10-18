// A demo board with made-up machines, chats and a day of history - for screenshots and for a first look.
//   node examples/demo.cjs [--port 8791] [--home <folder>]
// Everything lives in a temporary home folder (UAH_HOME); nothing touches ~/.unreal-agent-hub, ssh or other
// machines: the demo node uses the "folder" transport and a probe written here.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
const opt = k => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : undefined; };
const port = Number(opt('port') || 8791);
const home = opt('home') || fs.mkdtempSync(path.join(os.tmpdir(), 'uah-demo-'));
process.env.UAH_HOME = home;

const U = require('../lib/util.cjs');
const C = require('../lib/config.cjs');
const { Store } = require('../lib/store.cjs');

const now = Date.now();
const min = 60e3;
const project = path.join(home, 'projects', 'MyGame');
const folder = path.join(home, 'sync');
fs.mkdirSync(project, { recursive: true });
fs.writeFileSync(path.join(project, 'MyGame.uproject'), '{}');
U.writeJson(path.join(project, '.unreal-agent-hub.json'), {
  project: 'MyGame',
  resources: [
    { id: 'editor', ttlMin: 30, label: 'Editor restart', icon: 'editor' },
    { id: 'cook', ttlMin: 180, label: 'Cook / Packaged', icon: 'cook' },
    { id: 'smoke', ttlMin: 90, label: 'Smoke tests', icon: 'smoke' },
  ],
  gates: [{ tools: '^mcp__unreal-mcp__', resource: 'editor', holderPasses: true }],
});
U.writeJson(path.join(home, 'config.json'), {
  id: 'studio', label: 'Studio PC', roles: ['hub', 'build', 'workstation'], port, lang: 'en',
  resources: [{ id: 'cpp', ttlMin: 90, label: 'C++ build', icon: 'cpp' }],
  nodes: [{ id: 'laptop', label: 'Laptop', detail: 'RTX 3060, 12 GB', roles: ['runner', 'workstation'], transport: 'folder', folder,
    resources: [{ id: 'laptop', ttlMin: 180 }], profile: 'unreal', token: U.rand(16) }],
});

const cfg = C.load({ cwd: project });
C.rememberProject(cfg);
const store = new Store(cfg.stateDir, { machine: cfg.id });
const dir = cfg.stateDir;

// --- a day of history ------------------------------------------------------------------------------------------
const chats = [
  { session: 'a1f0c2d4-1111', title: 'Lighting pass for the harbor level', agent: 'claude', host: 'local_7c1e9a52-aaaa' },
  { session: 'b2e1d3c5-2222', title: 'Fix the cook crash in the shader cache', agent: 'codex' },
  { session: 'c3d2e4f6-3333', title: 'Smoke tests for the loading screen', agent: 'claude', host: 'local_91b4d7e0-bbbb' },
  { session: 'd4e3f5a7-4444', title: 'Retarget the run animations', agent: 'cursor' },
  { session: 'e6a1b2c3-6666', title: 'Night sky and fog in the old town', agent: 'claude' },
  { session: 'f7b2c3d4-7777', title: 'Door portals between the levels', agent: 'claude' },
  { session: 'a8c3d4e5-8888', title: 'AI patrol routes in the maze', agent: 'codex' },
  { session: 'b9d4e5f6-9999', title: 'Main menu settings page', agent: 'claude' },
  { session: 'cae5f6a7-aaaa', title: 'Footstep sounds on wet stone', agent: 'cursor' },
];
const events = [];
const ev = (t, kind, res, tok, c, extra) => events.push(Object.assign({ t, kind, res, token: tok, mode: 'script', chat: c ? c.title : '', session: c ? c.session : '', agent: c ? c.agent : '', script: '', note: '' }, extra || {}));
let seed = 7;
const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };

// A busy day: every task runs the same pipeline - C++ build, cook (which holds the build too), smoke test on the
// laptop - and queues whenever a stage is taken. Editor restarts come in between.
const SCRIPT = { cpp: 'build.ps1', 'MyGame~cook': 'package.ps1', 'MyGame~smoke': 'run_smoke.ps1', 'MyGame~editor': 'editor.ps1', laptop: 'remote_run.ps1' };
const freeAt = {};
const chatBusy = new Map();
const stage = (res, c, asked, len, also) => {
  const keys = [res, ...(also || [])];
  const start = Math.max(asked, ...keys.map(k => freeAt[k] || 0));
  const script = SCRIPT[res];
  if (start > asked + 30e3) for (const k of keys) { const w = U.rand(4); ev(asked, 'WAIT', k, w, c, { script }); ev(start, 'GO', k, w, null); }
  for (const k of keys) { const tok = U.rand(4); ev(start, 'TAKE', k, tok, c, { script, note: k === 'laptop' ? 'smoke: loading' : '' }); ev(start + len, 'FREE', k, tok, c); freeAt[k] = start + len + min; }
  return start + len;
};
for (let t = now - 24 * 60 * min; t < now - 40 * min; t += (22 + rnd() * 30) * min) {
  const c = chats[Math.floor(rnd() * chats.length)];
  let at = stage('cpp', c, t, (4 + rnd() * 9) * min);
  if (rnd() < 0.7) at = stage('MyGame~cook', c, at + (1 + rnd() * 3) * min, (12 + rnd() * 25) * min, ['cpp']);
  if (rnd() < 0.8) at = stage(rnd() < 0.5 ? 'laptop' : 'MyGame~smoke', c, at + (1 + rnd() * 2) * min, (5 + rnd() * 14) * min);
  if (rnd() < 0.45) stage('MyGame~editor', chats[Math.floor(rnd() * chats.length)], t + rnd() * 20 * min, (1 + rnd() * 6) * min);
  chatBusy.set(c, (chatBusy.get(c) || []).concat([[t - (2 + rnd() * 10) * min, at + rnd() * 8 * min]]));
}
for (const c of chats) {
  const spans = chatBusy.get(c) || [];
  for (const [i, [a, b]] of spans.entries()) {
    events.push({ t: a, session: c.session, title: c.title, agent: c.agent, event: 'UserPromptSubmit', state: 'working' });
    events.push({ t: b, session: c.session, title: c.title, agent: c.agent, event: 'Stop', state: i < spans.length - 1 && rnd() < 0.12 ? 'needs-owner' : 'idle' });
  }
}
// The history ends a few minutes ago: nothing starts later, and what is still running then ends there.
const late = new Set(events.filter(e => (e.kind === 'TAKE' || e.kind === 'WAIT') && e.t > now - 5 * min).map(e => e.token));
for (const e of events) if (e.t > now - min) e.t = now - min;
const lockEvents = events.filter(e => e.kind && !late.has(e.token)).sort((a, b) => a.t - b.t);
const chatEvents = events.filter(e => !e.kind).sort((a, b) => a.t - b.t);
fs.writeFileSync(path.join(dir, 'events.jsonl'), lockEvents.map(e => JSON.stringify(e)).join('\n') + '\n');
fs.writeFileSync(path.join(dir, 'chats.jsonl'), chatEvents.map(e => JSON.stringify(e)).join('\n') + '\n');

// --- now ----------------------------------------------------------------------------------------------------------
const chatRec = (c, state, extra) => U.writeJson(path.join(dir, 'chats', `${c.session}.json`), Object.assign({
  session: c.session, title: c.title, agent: c.agent, machine: 'studio', project: 'MyGame', cwd: project, hostSession: c.host || '',
  state, updated: now - Math.round(rnd() * 20) * min, started: now - 5 * 3600e3,
}, extra || {}));
chatRec(chats[0], 'working', { lastPrompt: 'Bake the lighting for the harbor level and compare it with the reference shots' });
chatRec(chats[1], 'working', { lastPrompt: 'The cook dies in FShaderCodeLibrary - find why and fix it, then cook again' });
chatRec(chats[2], 'needs-owner', { notice: 'Claude needs your permission to use PowerShell' });
chatRec(chats[3], 'idle', { lastPrompt: 'Retarget the run cycle from the reference skeleton', machine: 'laptop', node: 'laptop' });
for (const c of chats.slice(4)) chatRec(c, 'idle', { lastPrompt: c.title });
U.writeJson(path.join(dir, 'chats', 'e5f4a6b8-5555.json'), { session: 'e5f4a6b8-5555', title: 'Profile the laptop at Medium', agent: 'claude', machine: 'laptop', node: 'laptop', project: 'MyGame', state: 'working', updated: now - 2 * min, lastPrompt: 'Measure the frame time on the laptop' });

const take = (key, rec, ago) => {
  const r = store.tryTake(key, Object.assign({ token: U.rand(6), pid: process.pid, machine: 'studio' }, rec), {});
  const l = store.readLock(key);
  delete l.stale;
  l.since = now - ago * min;
  if (l.ttlMin) l.expires = l.since + l.ttlMin * min;
  U.writeJson(store.lockFile(key), l);
  return r;
};
take('cpp', { mode: 'script', chat: chats[1].title, session: chats[1].session, agent: 'codex', script: 'build.ps1', note: 'MyGameEditor Development', ttlMin: 90 }, 7);
take('MyGame~cook', { mode: 'hold', chat: chats[0].title, session: chats[0].session, agent: 'claude', hostSession: chats[0].host, script: 'hub hold', note: 'cook, then copy to the laptop', ttlMin: 180 }, 38);
store.writeWaiter('MyGame~cook', { token: U.rand(4), mode: 'script', chat: chats[2].title, session: chats[2].session, agent: 'claude', pid: process.pid, script: 'package.ps1', since: now - 12 * min });
store.writeWaiter('cpp', { token: U.rand(4), mode: 'gate', chat: chats[0].title, session: chats[0].session, agent: 'claude', pid: process.pid, script: 'Bash: UnrealBuildTool', since: now - 3 * min });

// The laptop: a person sits at it (presence) and a smoke run from the studio asks for it.
U.writeJson(path.join(folder, 'laptop', 'probe.json'), { at: now, host: 'laptop', node: 'laptop', profile: 'unreal', busy: true, reasons: ['processes'],
  desktop: [{ name: 'UnrealEditor.exe', pid: 4412, memMB: 2900, project: 'MyGame', since: now - 52 * min }], remote: [],
  gpu: { name: 'NVIDIA GeForce RTX 3060', usedMB: 11640, totalMB: 12288, util: 63 }, cpuPct: null, chats: 2 });
require('../lib/roles.cjs').saveProbe(cfg, 'laptop', U.readJson(path.join(folder, 'laptop', 'probe.json')), '', 'board');
take('laptop', { mode: 'presence', chat: 'person at Laptop', node: 'laptop', machine: 'laptop', note: 'board', ttlMin: 180 }, 52);
const runTok = U.rand(5);
const w = store.writeWaiter('laptop', { token: runTok, mode: 'script', chat: chats[2].title, session: chats[2].session, agent: 'claude', pid: process.pid,
  script: 'remote_run.ps1', note: 'smoke: loading', machine: 'studio', since: now - 4 * min, blocked: 'human', blockedAt: now }).waiter;
require('../lib/handover.cjs').ask(store, cfg, 'laptop', w, 'someone is using Laptop (UnrealEditor - MyGame - GPU 11640/12288 MB)');
const a = store.readAsk('laptop', runTok); a.since = now - 4 * min; store.writeAsk('laptop', a);
require('../lib/notify.cjs').send(cfg, { kind: 'return', key: 'laptop', ask: { chat: 'Profile the laptop at Medium', token: 'old' }, heldMs: 14 * min });

// Keep the demo waiters alive (their pid is this process) and serve the board.
setInterval(() => {
  for (const key of ['MyGame~cook', 'cpp', 'laptop']) for (const x of store.readWaiters(key)) store.writeWaiter(key, Object.assign(x, x.blocked ? { blockedAt: Date.now() } : {}));
}, 5000).unref();
const { createBoard } = require('../lib/server/board.cjs');
const board = createBoard(cfg, { noTunnels: true });
board.listen().then(() => console.log(`demo board: http://127.0.0.1:${port}   (home ${home})`));
