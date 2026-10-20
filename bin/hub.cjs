#!/usr/bin/env node
// Unreal Agent Hub command line. `hub help` lists the commands; docs/CLI.md explains each one.
'use strict';
const path = require('path');
const fs = require('fs');
const C = require('../lib/config.cjs');
const U = require('../lib/util.cjs');

const HELP = `Unreal Agent Hub - a queue for shared resources of AI coding agents and scripts.

Usage: hub <command> [options]

  status [--json]                         who holds what, who waits, handover requests
  lock <res>[,<res>...] [opts] -- <cmd>  run a command while holding <res> (like flock); several are taken
                                          in the order given ("cpp,cook": a packaging run holds both)
  hold <res> [opts]                       hold <res> for this chat until release / its agent exits / TTL
  release <res> [--force]                 release a hold of this chat (--force: anyone's)
  break <res> [--force]                   drop a stale lock (--force: also a live one; ask its owner first)
  here [<machine>] [--off] [--ttl N]      "I am sitting at this machine" (presence)
  claims [--json] | claims release <path> files claimed by chats (file gate); release frees one by hand
  watch [status|down|up] [--note TEXT]    the project app (editor): state; down = closed by a chat, comes back
  grant [<res|machine>] [--token T]       answer a handover request: "yes, take it"
  decline [<res|machine>] [--token T]     answer a handover request: "not now"
  serve [--port N] [--no-tunnels]         run the board (http://127.0.0.1:8790)
  probe                                   what this machine is busy with (JSON)
  dump                                    this machine's chats (JSON)
  hook [--agent claude|codex|cursor]      hook entry point (stdin: the agent's hook JSON)
  mcp                                     MCP server over stdio
  install-hooks --agent A [--uninstall] [--dry-run] [--file F]
  node add <id> [--ssh alias] [--tunnel-port N] [--label L] [--roles a,b]
  node install <id>                       print the steps to set up a node
  duty                                    make this chat the hub's duty chat (notifications)
  take <res> --pid N [opts] / free <res> --token T     for script wrappers (PowerShell module)
  config [--json]                         the merged configuration (tokens hidden)
  doctor                                  check the setup
  version

Options for lock / hold / take:
  --ttl N  --note TEXT  --no-wait  --wait-min N  --priority N  --ask | --no-ask  --chat NAME

Resources: an id ("cpp"), a project resource ("editor" inside a project with .unreal-agent-hub.json),
"@machine", "@node:<id>", or a pool "role:runner" (the first free runner wins).
Home folder: ${C.home()} (UAH_HOME moves it).`;

function parse(argv) {
  const out = { _: [], rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { out.rest = argv.slice(i + 1); break; }
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (k.startsWith('no-')) { out[k] = true; continue; }
      const nxt = argv[i + 1];
      if (nxt !== undefined && !nxt.startsWith('--') && !['json', 'force', 'off', 'uninstall', 'dry-run', 'ask'].includes(k)) { out[k] = nxt; i++; } else out[k] = true;
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
    onWait: (r, waited) => process.stderr.write(`[hub] ${r.key} is busy: ${r.text}. Waiting${waited >= 60e3 ? `, ${Math.round(waited / 60e3)} min so far` : ''} (--no-wait fails at once).\n`),
  }, extra || {});
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0] || 'help';
  const a = parse(argv.slice(1));
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') return print(HELP);
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
      if (!names.length || !a.rest.length) die('usage: hub lock <resource>[,<resource>...] [options] -- <command...>');
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
        if (!r.reentrant && !r.presence) process.stderr.write(`[hub] took ${r.key}${r.waitedMs > 6000 ? ` after ${(r.waitedMs / 60e3).toFixed(1)} min` : ''}.\n`);
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
      if (!res || !a.pid) die('usage: hub take <resource> --pid <pid> [options]');
      const r = await client.acquire(cfg, store(cfg), res, acquireOpts(a, { mode: 'script', pid: Number(a.pid), script: typeof a.script === 'string' ? a.script : 'script' }));
      print(JSON.stringify(r.ok ? { ok: true, key: r.key, token: r.token, reentrant: !!r.reentrant, presence: !!r.presence, ttlMin: r.lock && r.lock.ttlMin, waitedMs: r.waitedMs }
        : { ok: false, error: r.error }));
      return process.exit(r.ok ? 0 : 75);
    }
    case 'free': {
      const res = a._[0];
      if (!res || !a.token) die('usage: hub free <resource> --token <token>');
      const m = C.resolve(cfg, res);
      const key = m.length ? m[0].key : res;
      const r = client.release(cfg, store(cfg), key, String(a.token), 'released');
      return print(r.ok ? `released ${key}` : `${key}: ${r.error === 'gone' ? 'not held' : 'held by someone else now - left in place'}`);
    }
    case 'hold': {
      const res = a._[0];
      if (!res) die('usage: hub hold <resource> [--ttl N] [--note text] [--no-wait]');
      const who = client.identity(cfg, { chat: a.chat });
      if (!who.session && !a.chat && !who.ownerPid && !a.ttl) die('a hold outlives this command: run it from an agent chat, or give --chat NAME and --ttl N.');
      const r = await client.acquire(cfg, store(cfg), res, acquireOpts(a, { mode: 'hold', script: 'hub hold', extra: { by: 'cli' } }));
      if (!r.ok) die(r.error, 75);
      return print(r.reentrant ? `already held by this chat: ${r.key}` : r.presence ? `${r.key}: the person's presence lets this chat through`
        : `held ${r.key} until \`hub release ${res}\`, the end of this chat, or ${r.lock.ttlMin} min`);
    }
    case 'release': {
      const res = a._[0];
      if (!res) die('usage: hub release <resource> [--force]');
      const st = store(cfg);
      const m = C.resolve(cfg, res);
      const key = m.length ? m[0].key : res;
      const lock = st.readLock(key);
      if (!lock) return print(`${key} is not held`);
      const who = client.identity(cfg, {});
      if (!client.isMineFn(key, who)(lock) && !a.force) die(`${key} is held by ${require('../lib/store.cjs').describe(lock)}, not by this chat. --force releases it anyway; ask its owner first.`);
      const r = client.release(cfg, st, key, lock.token, a.force ? 'released by hand (--force)' : 'released');
      return print(r.ok ? `released ${key}` : `could not release ${key}: ${r.error}`);
    }
    case 'watch': {
      const W = require('../lib/watch.cjs');
      const match = C.profileFor(cfg, process.cwd());
      const profile = (match && match.profile) || cfg.profiles[cfg.profile] || {};
      const w = W.settings(cfg, profile, match);
      if (!w) die('no `watch` settings for this folder (a profile or .unreal-agent-hub.json with watch.port)');
      W.remember(cfg, w);
      const sub = a._[0] || 'status';
      if (sub === 'down') {
        const who = client.identity(cfg, { chat: a.chat });
        W.markDown(cfg, w.project, { by: who.chat || (typeof a.note === 'string' ? a.note : '') || 'a script', session: who.session, note: typeof a.note === 'string' ? a.note : '' });
        return print(`${w.project}: marked as closed by a chat - calls wait for it and the board's watchdog starts it again when nothing holds ${w.busyKeys.join(', ') || 'a resource'}`);
      }
      if (sub === 'up') { W.markUp(cfg, w.project); return print(`${w.project}: marked as up`); }
      if (sub !== 'status') die('usage: hub watch [status|down|up] [--note TEXT]');
      const alive = await W.portAlive(w.port);
      const why = alive ? null : W.restartPending(cfg, store(cfg), w);
      return print(`${w.project}: port ${w.port} ${alive ? 'answers' : why ? `is dead, restart under way: ${why}` : 'is dead, nothing restarting it'}` +
        `; watchdog ${w.start ? `starts it with: ${[].concat(w.start).join(' ')}` : 'off (no watch.start)'}`);
    }
    case 'break': {
      const res = a._[0];
      if (!res) die('usage: hub break <resource> [--force]');
      const st = store(cfg);
      const m = C.resolve(cfg, res);
      const key = m.length ? m[0].key : res;
      const lock = st.readLock(key);
      if (!lock) return print(`${key} is not held`);
      const { describe } = require('../lib/store.cjs');
      if (lock.stale) { const r = st.breakStale(key, lock.token, 'hub break'); return print(r.ok ? `broke the stale lock of ${describe(lock)} (${lock.stale})` : `not broken: ${r.error}`); }
      if (!a.force) die(`${key} is live: ${describe(lock)}. Only --force drops a live lock; ask its owner first. Nothing here stops processes.`);
      const r = st.forceBreak(key, 'hub break --force');
      return print(r.ok ? `broke the lock of ${describe(lock)}` : `not broken: ${r.error}`);
    }
    case 'claims': {
      const FG = require('../lib/file-gate.cjs');
      if (a._[0] === 'release') {
        if (!a._[1]) die('usage: hub claims release <path>');
        const r = FG.release(cfg, a._[1], process.cwd(), store(cfg));
        if (!r.ok) die(r.error);
        return print(`released ${r.claim.rel || r.claim.file} (was "${r.claim.chat || r.claim.session}")`);
      }
      const list = FG.list(cfg);
      if (a.json) return print(JSON.stringify(list, null, 2));
      if (!list.length) return print('no claimed files');
      return print(list.map(c => `${c.active ? 'held' : `over (${c.why})`}  ${c.rel || c.file}  ${c.chat || c.session}  since ${U.hm(c.since)}, last edit ${U.hm(c.at)}`).join('\n'));
    }
    case 'here': {
      const r = require('../lib/presence.cjs').here(cfg, store(cfg), a._[0], !a.off, { ttlMin: a.ttl ? Number(a.ttl) : undefined, by: 'hub here' });
      if (!r.ok) die(r.error);
      return print(a.off ? `presence removed from ${r.key}` : `presence on ${r.key}${r.ttlMin ? ` for ${r.ttlMin} min` : ''}: remote runs queue and ask`);
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
        if (e.code === 'EADDRINUSE') { print(`port ${a.port || cfg.port} is taken - the board is already running`); return process.exit(0); }
        throw e;
      }
      print(`${new Date().toISOString()} ${cfg.name}: http://127.0.0.1:${a.port || cfg.port}  (state ${cfg.stateDir}, pid ${process.pid})`);
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
      else print(`${a.uninstall ? 'removed the hub hooks from' : 'installed the hub hooks in'} ${r.file}${r.backup ? ` (backup ${path.basename(r.backup)})` : ''}`);
      for (const n of r.notes || []) print(n);
      return;
    }
    case 'node': return nodeCmd(cfg, a);
    case 'duty': {
      const sid = process.env.CLAUDE_CODE_SESSION_ID;
      if (!sid) die('run `hub duty` from the chat that should receive the hub\'s notifications');
      U.writeJson(path.join(cfg.stateDir, 'duty.json'), { session: sid, hostSession: process.env.CLAUDE_CODE_HOST_SESSION_ID || '', since: Date.now(),
        socket: process.env.CLAUDE_CODE_MESSAGING_SOCKET ? true : false });
      return print(`this chat (${sid.slice(0, 8)}) is the hub's duty chat now; handover requests and "machine is yours again" go here`);
    }
    case 'config': {
      const shown = JSON.parse(JSON.stringify(cfg, (k, v) => (k === 'token' && v ? '***' : v)));
      delete shown.profiles;
      return print(JSON.stringify(shown, null, 2));
    }
    case 'doctor': return doctor(cfg);
    default: die(`unknown command "${cmd}" - see hub help`);
  }
}

function nodeCmd(cfg, a) {
  const sub = a._[0], id = C.safeId(a._[1] || '');
  if (sub === 'add') {
    if (!id) die('usage: hub node add <id> [--ssh alias] [--tunnel-port N] [--label L] [--roles runner,workstation]');
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
    print(`node "${id}" is in ${file}. On that machine, ~/.unreal-agent-hub/config.json:`);
    return print(JSON.stringify({ role: 'node', id, hubUrl: `http://127.0.0.1:${n.tunnelPort}`, token: n.token, profile: n.profile }, null, 2));
  }
  if (sub === 'install') {
    const n = cfg.nodes.find(x => x.id === id);
    if (!n) die(`no node "${id}" - run hub node add ${id} first`);
    return print([
      `Steps for node "${id}" (nothing is run from here):`,
      `1. On ${id}: install Node.js >= 18, then the plugin (Claude Code: /plugin marketplace add <owner>/unreal-agent-hub, /plugin install unreal-agent-hub),`,
      `   or the npm package: npm i -g unreal-agent-hub && hub install-hooks --agent claude`,
      `2. On ${id}: write ~/.unreal-agent-hub/config.json as printed by \`hub node add ${id}\` (role node, hubUrl, token).`,
      `3. Here: make sure \`ssh ${n.ssh || id} node .unreal-agent-hub/bin/hub.cjs probe\` prints JSON (ssh keys are yours to set up).`,
      `4. Here: restart the board (hub serve); it opens the tunnel 127.0.0.1:${n.tunnelPort} on ${id}.`,
    ].join('\n'));
  }
  die('usage: hub node add <id> | hub node install <id>');
}

async function doctor(cfg) {
  const lines = [];
  const ok = (good, text) => lines.push(`${good ? 'ok  ' : 'warn'} ${text}`);
  ok(Number(process.versions.node.split('.')[0]) >= 18, `Node.js ${process.versions.node} (needs >= 18)`);
  ok(cfg.machineFileExists, `machine config ${cfg.machineFile}${cfg.machineFileExists ? '' : ' - missing, defaults in use'}`);
  try { fs.mkdirSync(cfg.stateDir, { recursive: true }); fs.accessSync(cfg.stateDir, fs.constants.W_OK); ok(true, `state folder ${cfg.stateDir}`); } catch (e) { ok(false, `state folder ${cfg.stateDir}: ${e.code}`); }
  ok(true, `role ${cfg.role}, id ${cfg.id}, roles ${(cfg.roles || []).join(', ')}`);
  const up = await new Promise(r => { const s = require('net').connect({ host: '127.0.0.1', port: cfg.port }); s.on('connect', () => { s.destroy(); r(true); }); s.on('error', () => r(false)); });
  if (cfg.role === 'hub') ok(up, `board port ${cfg.port} ${up ? 'answers' : 'is silent (hub serve starts it; hooks start it on demand)'}`);
  for (const n of cfg.nodes) ok(!!n.token, `node ${n.id}: ${n.transport}${n.tunnelPort ? ', tunnel ' + n.tunnelPort : ''}${n.token ? ', token set' : ' - no token: any local process on the node can speak for it'}`);
  if (cfg.role === 'node') ok(!!cfg.hubUrl && !!cfg.token, `hub ${cfg.hubUrl || '(hubUrl missing)'}${cfg.token ? ', token set' : ', no token'}`);
  const ssh = require('../lib/transport/ssh-reverse.cjs').sshPath(cfg);
  ok(true, `ssh client: ${ssh}`);
  const shim = path.join(cfg.home, 'bin', 'hub.cjs');
  ok(fs.existsSync(shim), `shim ${shim}${fs.existsSync(shim) ? '' : ' - written on the first SessionStart or install-hooks'}`);
  for (const ag of ['claude', 'codex', 'cursor']) {
    const f = require('../lib/install-hooks.cjs').defaultFile(ag);
    let has = false;
    try { has = fs.readFileSync(f, 'utf8').includes('unreal-agent-hub'); } catch (_) {}
    lines.push(`info ${ag} hooks in ${f}: ${has ? 'installed' : 'not installed (fine when the plugin is used)'}`);
  }
  print(lines.join('\n'));
}

main().catch(e => die(String(e && e.stack || e)));
