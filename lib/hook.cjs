// `hub hook [--agent claude|codex|cursor]`: one command for every hook event of every supported agent.
//   SessionStart       chat status; on the hub: start the board if its port is silent; one line of context
//   UserPromptSubmit   status "working"; a line when a resource this chat may need is held by someone else
//   PreToolUse         the profile's gates: heavy work waits for its resource (or holds it); after gateWaitSec
//                      the call is denied with the holder's name. File edits go through the file gate first
//                      (lib/file-gate.cjs): build files wait for the build, a shared file belongs to the first chat
//                      that edits it until its work is committed
//   Notification       "needs a person" on permission prompts and questions
//   Stop, SessionEnd   idle / ended; holds the hook took for this chat are released. A Claude Code Stop whose
//                      background_tasks still has unfinished work sets "background" instead of idle
//   PostToolUse        (Claude Code, start_session only) records a cloud session this chat started
// Chats outside every profile (no marker such as *.uproject nearby) are left alone at once. Any error fails
// open: the hub helps, it must never be the reason a chat cannot work.
'use strict';
const fs = require('fs');
const path = require('path');
const net = require('net');
const U = require('./util.cjs');
const C = require('./config.cjs');
const agents = require('./agents/index.cjs');
const chats = require('./chats.cjs');
const W = require('./watch.cjs');
const { describe } = require('./store.cjs');
const { T, msg } = require('./i18n.cjs');

const STATE_OF = { SessionStart: 'idle', UserPromptSubmit: 'working', PreToolUse: 'working', Stop: 'idle', SessionEnd: 'ended' };
const SHELL_TOOLS = /^(Bash|PowerShell|Shell|run_shell_command|shell)$/i;

/** Gate rules of the profile and the project overlay that match this tool call. */
function matchGates(rules, ev) {
  const out = [];
  for (const g of rules || []) {
    let hit = false;
    if (g.tools && ev.tool && new RegExp(g.tools).test(ev.tool)) hit = true;
    if (!hit && g.commands && ev.command && (SHELL_TOOLS.test(ev.tool) || !ev.tool) && new RegExp(g.commands, 'i').test(ev.command)) hit = true;
    if (hit) out.push(g);
  }
  return out;
}

function chatFields(cfg, ev, prev) {
  const f = { agent: ev.agent, cwd: ev.cwd, event: ev.event, machine: cfg.id, hostSession: ev.hostSession || (prev && prev.hostSession) || '' };
  if (ev.ownerPid) f.ownerPid = ev.ownerPid;
  const desk = ev.agent === 'claude' ? require('./adapters/claude-desktop.cjs').sessionRecord() : null;
  if (ev.title) f.title = ev.title;
  else if (desk && desk.title) f.title = desk.title;
  else if (!(prev && prev.title) && ev.prompt) f.title = U.clip(chats.promptText(ev.prompt), 60);
  if (desk && desk.parent) f.parent = desk.parent;
  if (cfg.project) f.project = cfg.project.id;
  if (ev.transcript) f.transcript = ev.transcript;
  switch (ev.event) {
    case 'SessionStart': Object.assign(f, { state: 'idle', source: ev.source, ended: 0 }); break;
    case 'UserPromptSubmit': {
      Object.assign(f, { state: 'working', lastPrompt: chats.sharedPrompt(cfg, ev.prompt), turnStarted: Date.now(), notice: '' });
      // A task notice in the prompt ends that background task: drop it until the next Stop says otherwise.
      const gone = chats.finishedIds(ev.prompt);
      if (gone.length && prev && Array.isArray(prev.background)) f.background = prev.background.filter(t => !gone.includes(t.id));
      break;
    }
    case 'Stop': {
      // A turn that ends with work still running in the background is not "waiting for a prompt".
      const bg = chats.backgroundOf(ev.backgroundTasks);
      Object.assign(f, { state: bg && bg.length ? 'background' : 'idle', lastReply: cfg.role === 'node' && cfg.share.prompt === 'none' ? '' : U.clip(ev.lastReply, 300),
        waitingFor: '', stopped: Date.now() });
      if (bg) f.background = bg;
      break;
    }
    case 'SessionEnd': Object.assign(f, { state: 'ended', ended: Date.now(), endReason: ev.reason }); break;
    case 'Notification': {
      const t = ev.notificationType;
      if (t === 'permission_prompt' || t === 'elicitation_dialog' || t === 'agent_needs_input') f.state = 'needs-owner';
      else if (t === 'idle_prompt') f.state = prev && prev.state === 'background' && (prev.background || []).length ? 'background' : 'idle';
      f.notice = U.clip(ev.message, 200);
      break;
    }
    case 'PostToolUse': {
      const c = chats.cloudStart(ev.tool, ev.toolInput, ev.toolResponse);
      if (c) f.cloud = ((prev && prev.cloud) || []).filter(x => !c.remote || x.remote !== c.remote).concat(c).slice(-20);
      break;
    }
    default: if (STATE_OF[ev.event]) f.state = STATE_OF[ev.event];
  }
  return f;
}

// Starts the board (`hub serve`) detached when nothing answers on its port. A second copy that loses the race
// exits on EADDRINUSE by itself.
function ensureBoard(cfg) {
  return new Promise(resolve => {
    const sock = net.connect({ host: '127.0.0.1', port: cfg.port });
    const done = up => { sock.destroy(); resolve(up); };
    sock.setTimeout(500, () => done(true));
    sock.on('connect', () => done(true));
    sock.on('error', () => {
      sock.destroy();
      try {
        fs.mkdirSync(cfg.stateDir, { recursive: true });
        const out = fs.openSync(path.join(cfg.stateDir, 'board.log'), 'a');
        const child = require('child_process').spawn(process.execPath, [path.join(C.PKG_ROOT, 'bin', 'hub.cjs'), 'serve'],
          { detached: true, windowsHide: true, stdio: ['ignore', out, out], env: process.env });
        child.unref();
        resolve(true);
      } catch (_) { resolve(false); }
    });
  });
}

// ~/.unreal-agent-hub/bin/hub.cjs: a fixed path to the current version (the plugin's own folder changes with every
// version), so scripts, PowerShell and the hub's ssh probes always know what to call.
function ensureShim(cfg) {
  const file = path.join(cfg.home, 'bin', 'hub.cjs');
  const target = path.join(C.PKG_ROOT, 'bin', 'hub.cjs');
  const body = `#!/usr/bin/env node\n// Written by Unreal Agent Hub: forwards to the installed version.\nrequire(${JSON.stringify(target)});\n`;
  try {
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === body) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body, 'utf8');
  } catch (_) {}
}

async function run(hint, opts) {
  opts = opts || {};
  const input = opts.input || await U.readStdin(3000);
  const { ev, out } = agents.read(input, hint, opts.env);
  const write = obj => { if (obj) (opts.stdout || process.stdout).write(JSON.stringify(obj)); };
  const allow = () => write(out.allow(ev.rawEvent));
  const cfg = opts.cfg || C.load({ cwd: ev.cwd });
  const match = C.profileFor(cfg, ev.cwd);
  if ((!match && !cfg.project) || !ev.session) return allow();
  const profile = (match && match.profile) || cfg.profiles[cfg.profile] || cfg.profiles.generic || {};
  C.rememberProject(cfg);
  if (ev.event === 'SessionStart') ensureShim(cfg);
  if (ev.event === 'SessionStart' || ev.event === 'UserPromptSubmit') W.remember(cfg, W.settings(cfg, profile, match));

  // PostToolUse is registered for one tool only (start_session); anything else is not the hub's business.
  if (ev.event === 'PostToolUse' && !chats.cloudStart(ev.tool, ev.toolInput, ev.toolResponse)) return allow();
  const prev = chats.read(cfg, ev.session);
  const fields = chatFields(cfg, ev, prev);
  if (match) fields.marker = path.basename(match.marker);
  const rec = chats.update(cfg, ev.session, fields);
  // The timeline reads chat intervals from this log: a tool call is logged only when it changes the state.
  if (!/^(Pre|Post)ToolUse$/.test(ev.event) || ((prev && prev.state) || '') !== (rec.state || '')) {
    chats.event(cfg, { session: ev.session, title: rec.title || '', agent: ev.agent, event: ev.event, state: rec.state || '' });
  }

  if (cfg.role === 'node') return require('./node-agent.cjs').onHook(cfg, profile, ev, rec, out, write);

  const { Store } = require('./store.cjs');
  const store = new Store(cfg.stateDir, { machine: cfg.id });
  const client = require('./lock-client.cjs');
  const who = { session: ev.session, chat: rec.title || '', agent: ev.agent, ownerPid: ev.ownerPid, hostSession: rec.hostSession };

  if (ev.event === 'PreToolUse') {
    if (ev.files && ev.files.length) {
      const fr = await require('./file-gate.cjs').check(cfg, profile, match, ev, who, { store, client,
        onWait: key => chats.update(cfg, ev.session, { waitingFor: key, waitingSince: Date.now(), waitingTool: ev.tool }) });
      if ((chats.read(cfg, ev.session) || {}).waitingFor) chats.update(cfg, ev.session, { waitingFor: '', waitingSince: 0, waitingTool: '' });
      if (!fr.ok) return write(out.deny('PreToolUse', fr.reason));
    }
    // A call that needs the project's app (the editor's MCP) waits while the app is mid-restart (lib/watch.cjs).
    const w = W.settings(cfg, profile, match);
    if (w && w.tools && ev.tool && new RegExp(w.tools).test(ev.tool)) {
      const wr = await W.waitRestart(cfg, store, w, {
        onWait: () => chats.update(cfg, ev.session, { waitingFor: 'restart', waitingSince: Date.now(), waitingTool: ev.tool }) });
      if (wr.waited) chats.update(cfg, ev.session, { waitingFor: '', waitingSince: 0, waitingTool: '' });
      if (!wr.ok) return write(out.deny('PreToolUse', T('hook.appDown', { project: w.project, reason: wr.reasonMsg || wr.reason, min: Math.round((cfg.gateWaitSec || 0) / 60) })));
    }
    const gates = matchGates([...(profile.gates || []), ...((cfg.project && cfg.project.gates) || [])], ev);
    for (const g of gates) {
      const members = C.resolve(cfg, g.resource);
      if (!members.length) continue;
      const mode = g.mode || (String(g.resource).startsWith('@') || String(g.resource).startsWith('role:') ? 'hold' : 'wait');
      const what = ev.command ? `${ev.tool}: ${U.clip(ev.command, 100)}` : ev.tool;
      let r;
      if (mode === 'wait') {
        r = await client.gateWait(cfg, store, members[0].key, Object.assign({}, who, { script: what, waitSec: cfg.gateWaitSec, pid: process.pid,
          onWait: () => chats.update(cfg, ev.session, { waitingFor: members[0].key, waitingSince: Date.now(), waitingTool: what }) }));
      } else {
        r = await client.acquire(cfg, store, members, Object.assign({}, who, { mode: 'hold', note: what, script: what, command: ev.command,
          ttlMin: g.ttlMin || profile.holdTtlMin || cfg.holdTtlMin, waitMin: cfg.gateWaitSec / 60, extra: { by: 'hook' },
          onWait: () => chats.update(cfg, ev.session, { waitingFor: members.map(m => m.key).join('|'), waitingSince: Date.now(), waitingTool: what }) }));
      }
      if (rec.waitingFor || (chats.read(cfg, ev.session) || {}).waitingFor) chats.update(cfg, ev.session, { waitingFor: '', waitingSince: 0, waitingTool: '' });
      if (!r.ok) {
        const key = members.map(m => m.key).join(' / ');
        const holder = r.holder ? describe(r.holder) : (r.error || T('hook.busyWord'));
        return write(out.deny('PreToolUse', T('hook.busy', { key, holder, min: Math.round((cfg.gateWaitSec || 0) / 60), retry: msg('gate.retry') })));
      }
    }
    return allow();
  }

  if (ev.event === 'Stop' || ev.event === 'SessionEnd') {
    for (const key of store.keys()) {
      const l = store.readLock(key);
      if (l && l.session === ev.session && l.by === 'hook' && l.mode === 'hold') client.release(cfg, store, key, l.token, `chat ${ev.event}`);
    }
    return allow();
  }

  if (ev.event === 'SessionStart' || ev.event === 'UserPromptSubmit') {
    if (cfg.role === 'hub') await ensureBoard(cfg);
    const lines = [];
    if (ev.event === 'SessionStart') {
      lines.push(T('hook.hubLine', { label: cfg.label, port: cfg.port, project: profile.name || T('hook.project') }));
    }
    const relevant = new Set();
    for (const g of [...(profile.gates || []), ...((cfg.project && cfg.project.gates) || [])]) for (const m of C.resolve(cfg, g.resource)) relevant.add(m.key);
    for (const key of relevant) {
      const l = store.readLock(key);
      if (l && !l.stale && l.session !== ev.session) lines.push(T('hook.held', { key, holder: describe(l) }));
    }
    for (const text of require('./adapters/claude-messaging.cjs').takeFor(cfg, ev.session)) lines.push(T('hook.notice', { text }));
    return write(out.context(ev.event, lines.join('\n'), ev.rawEvent) || out.allow(ev.rawEvent));
  }
  return allow();
}

module.exports = { run, matchGates, chatFields, ensureBoard, ensureShim };
