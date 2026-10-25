#!/usr/bin/env node
// Unreal Agent Hub command line. `hub help` lists the commands; docs/CLI.md explains each one.
'use strict';
const path = require('path');
const fs = require('fs');
const C = require('../lib/config.cjs');
const U = require('../lib/util.cjs');
const { T } = require('../lib/i18n.cjs');

// Commands of `hub help`: [syntax, description key, gap after the syntax (default: pad to column 42)]. The syntax stays as
// typed; the explanations are translated.
const HELP_CMDS = [
  ['status [--json]', 'status'],
  ['lock <res>[,<res>...] [opts] -- <cmd>', 'lock', 2],
  ['hold <res> [opts]', 'hold'],
  ['release <res> [--force]', 'release'],
  ['break <res> [--force] [--place N]', 'break'],
  ['here [<machine>] [--off] [--ttl N]', 'here'],
  ['claims [--json] | claims release <path>', 'claims'],
  ['watch [status|down|up] [--note TEXT]', 'watch'],
  ['stamp <name> [--files a,b] [--note TEXT]', 'stamp', 2],
  ['whose <name> [--require] [--json]', 'whose'],
  ['grant [<res|machine>] [--token T]', 'grant'],
  ['decline [<res|machine>] [--token T]', 'decline'],
  ['serve [--port N] [--no-tunnels]', 'serve'],
  ['probe', 'probe'],
  ['dump', 'dump'],
  ['hook [--agent claude|codex|cursor]', 'hook'],
  ['mcp', 'mcp'],
  ['install-hooks --agent A [--uninstall] [--dry-run] [--file F]', null],
  ['node add <id> [--ssh alias] [--tunnel-port N] [--label L] [--roles a,b]', null],
  ['node install <id>', 'nodeInstall'],
  ['duty', 'duty'],
  ['take <res> --pid N [opts] / free <res> --token T', 'take', 5],
  ['config [--json]', 'config'],
  ['doctor', 'doctor'],
  ['version', null],
];

function help() {
  const lines = [T('cli.help.title'), '', T('cli.help.usage'), ''];
  for (const [cmd, key, gap] of HELP_CMDS) {
    if (!key) { lines.push('  ' + cmd); continue; }
    const [first, ...more] = T('cli.help.' + key).split('\n');
    lines.push('  ' + (gap ? cmd + ' '.repeat(gap) : cmd.padEnd(40)) + first);
    for (const m of more) lines.push(' '.repeat(42) + m);
  }
  lines.push('', T('cli.help.opts'), '  --ttl N  --note TEXT  --no-wait  --wait-min N  --priority N  --ask | --no-ask  --chat NAME  --shared', '',
    T('cli.help.resources'), T('cli.help.home', { home: C.home() }));
  return lines.join('\n');
}

function parse(argv) {
  const out = { _: [], rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { out.rest = argv.slice(i + 1); break; }
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (k.startsWith('no-')) { out[k] = true; continue; }
      const nxt = argv[i + 1];
      if (nxt !== undefined && !nxt.startsWith('--') && !['json', 'force', 'off', 'uninstall', 'dry-run', 'ask', 'require', 'shared'].includes(k)) { out[k] = nxt; i++; } else out[k] = true;
    } else out._.push(a);
  }
  return out;
}

function store(cfg) { const { Store } = require('../lib/store.cjs'); return new Store(cfg.stateDir, { machine: cfg.id }); }
function die(msg, code) { process.stderr.write(`hub: ${msg}\n`); process.exit(code == null ? 1 : code); }
function print(s) { process.stdout.write(s.endsWith('\n') ? s : s + '\n'); }

function acquireOpts(a, extra) {
  return Object.assign({
    ttlMin: a.ttl ? Number(a.ttl) : undefined, note: typeof a.note === 'string' ? a.note : '', noWait: !!a['no-wait'],
    waitMin: a['wait-min'] ? Number(a['wait-min']) : undefined, priority: a.priority != null ? Number(a.priority) : undefined,
    ask: a.ask ? true : a['no-ask'] ? false : undefined, chat: typeof a.chat === 'string' ? a.chat : undefined,
    shared: !!a.shared,
    onWait: (r, waited) => process.stderr.write(T('cli.waiting', { key: r.key, text: r.text,
      since: waited >= 60e3 ? T('cli.waitingSince', { n: Math.round(waited / 60e3) }) : '' }) + '\n'),
  }, extra || {});
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0] || 'help';
  const a = parse(argv.slice(1));
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    try { C.load({ cwd: process.cwd() }); } catch (_) {} // sets the language
    return print(help());
  }
  if (cmd === 'version' || cmd === '--version') return print(require('../package.json').version);
  if (cmd === 'hook') {
    try { await require('../lib/hook.cjs').run(typeof a.agent === 'string' ? a.agent : ''); } catch (e) {
      U.appendLine(path.join(C.stateDir(), 'hook-errors.log'), `${new Date().toISOString()} ${e && e.stack || e}`);
    }
    return process.exit(0);
  }
  if (cmd === 'mcp') { require('../lib/mcp.cjs').serve(); return; }

  const cfg = C.load({ cwd: process.cwd() });
  C.rememberProject(cfg);
  const client = require('../lib/lock-client.cjs');

  switch (cmd) {
    case 'status': {
      const S = require('../lib/status.cjs');
      const d = S.data(cfg, store(cfg));
      return print(a.json ? JSON.stringify(d, null, 2) : S.format(d));
    }
    case 'lock': {
      const names = String(a._[0] || '').split(',').map(s => s.trim()).filter(Boolean);
      if (!names.length || !a.rest.length) die(T('cli.usage', { syntax: 'hub lock <resource>[,<resource>...] [options] -- <command...>' }));
      const st = store(cfg);
      // Several resources are taken one after another in the order given and released in reverse. Keep one order
      // everywhere (cpp before cook) and two such commands never wait on each other.
      const held = [];
      const env = Object.assign({}, process.env);
      for (const res of names) {
        const r = await client.acquire(cfg, st, res, acquireOpts(a, { mode: 'script', script: path.basename(a.rest[0]), command: a.rest.join(' '), env }));
        if (!r.ok) {
          for (const h of held.reverse()) if (!h.reentrant && !h.presence) client.release(cfg, st, h.key, h.token, 'lock not completed');
          die(r.error, 75);
        }
        if (!r.reentrant && !r.presence) process.stderr.write(T('cli.took', { key: r.key, after: r.waitedMs > 6000 ? T('cli.tookAfter', { n: (r.waitedMs / 60e3).toFixed(1) }) : '' }) + '\n');
        env[client.tokenEnv(r.key)] = r.token;
        held.push(r);
      }
      // On Windows the command goes through cmd.exe (so .cmd/.bat and built-ins work), as one quoted string.
      const win = process.platform === 'win32';
      const quote = s => (/^[\w@%+=:,./\\-]+$/.test(s) ? s : `"${String(s).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`);
      const child = win
        ? require('child_process').spawn(a.rest.map(quote).join(' '), { stdio: 'inherit', env, shell: true })
        : require('child_process').spawn(a.rest[0], a.rest.slice(1), { stdio: 'inherit', env });
      const free = () => { for (const h of held.slice().reverse()) if (!h.reentrant && !h.presence) client.release(cfg, st, h.key, h.token, 'command finished'); };
      for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { try { child.kill(sig); } catch (_) {} });
      child.on('error', e => { free(); die(String(e.message || e), 127); });
      child.on('exit', (code, sig) => { free(); process.exit(code == null ? (sig ? 1 : 0) : code); });
      return;
    }
    case 'take': {
      const res = a._[0];
      if (!res || !a.pid) die(T('cli.usage', { syntax: 'hub take <resource> --pid <pid> [options]' }));
      const r = await client.acquire(cfg, store(cfg), res, acquireOpts(a, { mode: 'script', pid: Number(a.pid), script: typeof a.script === 'string' ? a.script : 'script' }));
      print(JSON.stringify(r.ok ? { ok: true, key: r.key, token: r.token, reentrant: !!r.reentrant, presence: !!r.presence, ttlMin: r.lock && r.lock.ttlMin, waitedMs: r.waitedMs }
        : { ok: false, error: r.error }));
      return process.exit(r.ok ? 0 : 75);
    }
    case 'free': {
      const res = a._[0];
      if (!res || !a.token) die(T('cli.usage', { syntax: 'hub free <resource> --token <token>' }));
      const m = C.resolve(cfg, res);
      const key = m.length ? m[0].key : res;
      const r = client.release(cfg, store(cfg), key, String(a.token), 'released');
      return print(r.ok ? T('cli.released', { key }) : T(r.error === 'gone' ? 'cli.freeGone' : 'cli.freeOther', { key }));
    }
    case 'hold': {
      const res = a._[0];
      if (!res) die(T('cli.usage', { syntax: 'hub hold <resource> [--ttl N] [--note text] [--no-wait]' }));
      const who = client.identity(cfg, { chat: a.chat });
      if (!who.session && !a.chat && !who.ownerPid && !a.ttl) die(T('cli.holdNeedsChat'));
      const r = await client.acquire(cfg, store(cfg), res, acquireOpts(a, { mode: 'hold', script: 'hub hold', extra: { by: 'cli' } }));
      if (!r.ok) die(r.error, 75);
      return print(r.reentrant ? T('cli.holdAlready', { key: r.key }) : r.presence ? T('cli.holdPresence', { key: r.key })
        : T('cli.holdDone', { key: r.key, res, ttl: r.lock.ttlMin }));
    }
    case 'release': {
      const res = a._[0];
      if (!res) die(T('cli.usage', { syntax: 'hub release <resource> [--force]' }));
      const st = store(cfg);
      const m = C.resolve(cfg, res);
      const key = m.length ? m[0].key : res;
      const lock = st.readLock(key);
      if (!lock) return print(T('cli.notHeld', { key }));
      const who = client.identity(cfg, {});
      if (!client.isMineFn(key, who)(lock) && !a.force) die(T('cli.heldByOther', { key, holder: require('../lib/store.cjs').describe(lock) }));
      const r = client.release(cfg, st, key, lock.token, a.force ? 'released by hand (--force)' : 'released');
      return print(r.ok ? T('cli.released', { key }) : T('cli.releaseFail', { key, error: r.error }));
    }
    case 'watch': {
      const W = require('../lib/watch.cjs');
      const match = C.profileFor(cfg, process.cwd());
      const profile = (match && match.profile) || cfg.profiles[cfg.profile] || {};
      const w = W.settings(cfg, profile, match);
      if (!w) die(T('cli.watchNone'));
      W.remember(cfg, w);
      const sub = a._[0] || 'status';
      if (sub === 'down') {
        const who = client.identity(cfg, { chat: a.chat });
        W.markDown(cfg, w.project, { by: who.chat || (typeof a.note === 'string' ? a.note : '') || 'a script', session: who.session, note: typeof a.note === 'string' ? a.note : '' });
        return print(T('cli.watchDown', { project: w.project, busy: w.busyKeys.join(', ') || T('watch.aResource') }));
      }
      if (sub === 'up') { W.markUp(cfg, w.project); return print(T('cli.watchUp', { project: w.project })); }
      if (sub !== 'status') die(T('cli.usage', { syntax: 'hub watch [status|down|up] [--note TEXT]' }));
      const alive = await W.portAlive(w.port);
      const why = alive ? null : W.restartPending(cfg, store(cfg), w);
      return print(T('cli.watchState', { project: w.project, port: w.port,
        state: alive ? T('cli.watchAnswers') : why ? T('cli.watchDeadRestart', { why }) : T('cli.watchDeadIdle'),
        dog: w.start ? T('cli.watchdogOn', { cmd: [].concat(w.start).join(' ') }) : T('cli.watchdogOff') }));
    }
    case 'stamp': {
      const name = a._[0];
      if (!name) die(T('cli.usage', { syntax: 'hub stamp <name> [--files <pattern,pattern>] [--note text]' }));
      const files = typeof a.files === 'string' ? a.files.split(',').map(s => s.trim()).filter(Boolean) : [];
      const rec = require('../lib/stamps.cjs').write(cfg, name, client.identity(cfg, { chat: a.chat }),
        { files, note: typeof a.note === 'string' ? a.note : '', cwd: process.cwd() });
      return print(T('cli.stamped', { name: rec.name, n: rec.files.length, commit: rec.commit || '-' }));
    }
    case 'whose': {
      const name = a._[0];
      if (!name) die(T('cli.usage', { syntax: 'hub whose <name> [--require] [--json]' }));
      const c = require('../lib/stamps.cjs').check(cfg, name, client.identity(cfg, { chat: a.chat }));
      const { say } = require('../lib/i18n.cjs');
      if (a.json) print(JSON.stringify({ known: c.known, mine: c.mine, changed: c.changed, text: say(c.m), stamp: c.rec }, null, 2));
      else if (!c.mine && a.require) die(T('cli.whoseRequire', { text: say(c.m) }), 3);
      else print(say(c.m));
      return process.exit(c.mine || !a.require ? 0 : 3);
    }
    case 'break': {
      const res = a._[0];
      if (!res) die(T('cli.usage', { syntax: 'hub break <resource> [--force]' }));
      const st = store(cfg);
      const m = C.resolve(cfg, res);
      const key = m.length ? m[0].key : res;
      const lock = st.readLock(key);
      if (!lock) return print(T('cli.notHeld', { key }));
      const { describe } = require('../lib/store.cjs');
      if (lock.stale) { const r = st.breakStale(key, lock.token, 'hub break'); return print(r.ok ? T('cli.brokeStale', { what: describe(lock), stale: lock.stale }) : T('cli.notBroken', { error: r.error })); }
      if (!a.force) die(T('cli.breakLive', { key, what: describe(lock) }));
      const r = st.forceBreak(key, 'hub break --force', a.place ? Number(a.place) : 0);
      return print(r.ok ? T('cli.broke', { what: describe(lock) }) : T('cli.notBroken', { error: r.error }));
    }
    case 'claims': {
      const FG = require('../lib/file-gate.cjs');
      if (a._[0] === 'release') {
        if (!a._[1]) die(T('cli.usage', { syntax: 'hub claims release <path>' }));
        const r = FG.release(cfg, a._[1], process.cwd(), store(cfg));
        if (!r.ok) die(r.error);
        return print(T('cli.claimReleased', { file: r.claim.rel || r.claim.file, chat: r.claim.chat || r.claim.session }));
      }
      const list = FG.list(cfg);
      if (a.json) return print(JSON.stringify(list, null, 2));
      if (!list.length) return print(T('cli.noClaims'));
      return print(list.map(c => T('cli.claimLine', { state: c.active ? T('cli.claimHeld') : T('cli.claimOver', { why: T('cli.claimWhy.' + String(c.why).replace(/,.*/, '')) }),
        file: c.rel || c.file, chat: c.chat || c.session, since: U.hm(c.since), last: U.hm(c.at) })).join('\n'));
    }
    case 'here': {
      const r = require('../lib/presence.cjs').here(cfg, store(cfg), a._[0], !a.off, { ttlMin: a.ttl ? Number(a.ttl) : undefined, by: 'hub here' });
      if (!r.ok) die(r.error);
      return print(a.off ? T('cli.hereOff', { key: r.key }) : T('cli.hereOn', { key: r.key, ttl: r.ttlMin ? T('presence.forMin', { n: r.ttlMin }) : '' }));
    }
    case 'grant':
    case 'decline': {
      const out = await require('../lib/mcp.cjs').call(cmd === 'grant' ? 'hub_grant' : 'hub_decline', { resource: a._[0], token: a.token }, { cfg, ownerPid: 0 });
      print(out.content[0].text);
      return process.exit(out.isError ? 1 : 0);
    }
    case 'serve': {
      const { createBoard } = require('../lib/server/board.cjs');
      const b = createBoard(cfg, { port: a.port ? Number(a.port) : undefined, noTunnels: !!a['no-tunnels'] });
      try { await b.listen(); } catch (e) {
        if (e.code === 'EADDRINUSE') { print(T('cli.portTaken', { port: a.port || cfg.port })); return process.exit(0); }
        throw e;
      }
      print(T('cli.serving', { time: new Date().toISOString(), name: cfg.name, port: a.port || cfg.port, state: cfg.stateDir, pid: process.pid }));
      return;
    }
    case 'probe': {
      const prof = cfg.profiles[cfg.profile || 'unreal'] || {};
      const p = await require('../lib/detect/probe.cjs').probe(cfg, prof);
      if (cfg.transport === 'folder' && cfg.folder) require('../lib/transport/folder.cjs').publish(cfg.folder, cfg.id, 'probe', p);
      return print(JSON.stringify(p));
    }
    case 'dump': return print(JSON.stringify(require('../lib/chats.cjs').list(cfg).filter(c => c.machine === cfg.id || !c.machine)));
    case 'install-hooks': {
      const r = require('../lib/install-hooks.cjs').run({ agent: a.agent, uninstall: !!a.uninstall, dryRun: !!a['dry-run'], file: typeof a.file === 'string' ? a.file : undefined, cfg });
      if (a['dry-run']) print(r.text);
      else print(T(a.uninstall ? 'cli.hooksRemoved' : 'cli.hooksInstalled', { file: r.file, backup: r.backup ? T('cli.hooksBackup', { name: path.basename(r.backup) }) : '' }));
      for (const n of r.notes || []) print(n);
      return;
    }
    case 'node': return nodeCmd(cfg, a);
    case 'duty': {
      const sid = process.env.CLAUDE_CODE_SESSION_ID;
      if (!sid) die(T('cli.dutyNeedsChat'));
      U.writeJson(path.join(cfg.stateDir, 'duty.json'), { session: sid, hostSession: process.env.CLAUDE_CODE_HOST_SESSION_ID || '', since: Date.now(),
        socket: process.env.CLAUDE_CODE_MESSAGING_SOCKET ? true : false });
      return print(T('cli.dutyDone', { id: sid.slice(0, 8) }));
    }
    case 'config': {
      const shown = JSON.parse(JSON.stringify(cfg, (k, v) => (k === 'token' && v ? '***' : v)));
      delete shown.profiles;
      return print(JSON.stringify(shown, null, 2));
    }
    case 'doctor': return doctor(cfg);
    default: die(T('cli.unknown', { cmd }));
  }
}

function nodeCmd(cfg, a) {
  const sub = a._[0], id = C.safeId(a._[1] || '');
  if (sub === 'add') {
    if (!id) die(T('cli.usage', { syntax: 'hub node add <id> [--ssh alias] [--tunnel-port N] [--label L] [--roles runner,workstation]' }));
    const file = cfg.machineFile;
    const m = U.readJson(file) || {};
    m.nodes = m.nodes || [];
    let n = m.nodes.find(x => x.id === id);
    if (!n) { n = { id }; m.nodes.push(n); }
    Object.assign(n, {
      label: typeof a.label === 'string' ? a.label : n.label || id,
      roles: typeof a.roles === 'string' ? a.roles.split(',') : n.roles || ['runner', 'workstation'],
      transport: n.transport || 'ssh-reverse', ssh: typeof a.ssh === 'string' ? a.ssh : n.ssh || id,
      tunnelPort: a['tunnel-port'] ? Number(a['tunnel-port']) : n.tunnelPort || 18791 + m.nodes.indexOf(n),
      profile: n.profile || 'unreal', token: n.token || U.rand(32),
    });
    U.writeJson(file, m);
    print(T('cli.nodeAdded', { id, file }));
    return print(JSON.stringify({ role: 'node', id, hubUrl: `http://127.0.0.1:${n.tunnelPort}`, token: n.token, profile: n.profile }, null, 2));
  }
  if (sub === 'install') {
    const n = cfg.nodes.find(x => x.id === id);
    if (!n) die(T('cli.nodeNone', { id }));
    return print([
      T('cli.nodeSteps.head', { id }),
      T('cli.nodeSteps.s1', { id }),
      T('cli.nodeSteps.s2', { id }),
      T('cli.nodeSteps.s3', { ssh: n.ssh || id }),
      T('cli.nodeSteps.s4', { id, port: n.tunnelPort }),
    ].join('\n'));
  }
  die(T('cli.usage', { syntax: 'hub node add <id> | hub node install <id>' }));
}

async function doctor(cfg) {
  const lines = [];
  const ok = (good, text) => lines.push(`${good ? 'ok  ' : 'warn'} ${text}`);
  ok(Number(process.versions.node.split('.')[0]) >= 18, T('cli.doc.node', { v: process.versions.node }));
  ok(cfg.machineFileExists, T('cli.doc.machine', { file: cfg.machineFile, missing: cfg.machineFileExists ? '' : T('cli.doc.machineMissing') }));
  try { fs.mkdirSync(cfg.stateDir, { recursive: true }); fs.accessSync(cfg.stateDir, fs.constants.W_OK); ok(true, T('cli.doc.state', { dir: cfg.stateDir })); } catch (e) { ok(false, T('cli.doc.stateErr', { dir: cfg.stateDir, code: e.code })); }
  ok(true, T('cli.doc.role', { role: cfg.role, id: cfg.id, roles: (cfg.roles || []).join(', ') }));
  const up = await new Promise(r => { const s = require('net').connect({ host: '127.0.0.1', port: cfg.port }); s.on('connect', () => { s.destroy(); r(true); }); s.on('error', () => r(false)); });
  if (cfg.role === 'hub') ok(up, T('cli.doc.board', { port: cfg.port, state: up ? T('cli.doc.boardUp') : T('cli.doc.boardDown') }));
  for (const n of cfg.nodes) ok(!!n.token, T('cli.doc.nodeRow', { id: n.id, transport: n.transport, tunnel: n.tunnelPort ? T('cli.doc.tunnel', { port: n.tunnelPort }) : '', token: n.token ? T('cli.doc.tokenSet') : T('cli.doc.nodeNoToken') }));
  if (cfg.role === 'node') ok(!!cfg.hubUrl && !!cfg.token, T('cli.doc.hub', { url: cfg.hubUrl || T('cli.doc.hubUrlMissing'), token: cfg.token ? T('cli.doc.tokenSet') : T('cli.doc.noToken') }));
  const ssh = require('../lib/transport/ssh-reverse.cjs').sshPath(cfg);
  ok(true, T('cli.doc.ssh', { path: ssh }));
  const shim = path.join(cfg.home, 'bin', 'hub.cjs');
  ok(fs.existsSync(shim), T('cli.doc.shim', { file: shim, missing: fs.existsSync(shim) ? '' : T('cli.doc.shimMissing') }));
  for (const ag of ['claude', 'codex', 'cursor']) {
    const f = require('../lib/install-hooks.cjs').defaultFile(ag);
    let has = false;
    try { has = fs.readFileSync(f, 'utf8').includes('unreal-agent-hub'); } catch (_) {}
    lines.push('info ' + T('cli.doc.hooks', { agent: ag, file: f, state: has ? T('cli.doc.hooksOn') : T('cli.doc.hooksOff') }));
  }
  print(lines.join('\n'));
}

main().catch(e => die(String(e && e.stack || e)));
