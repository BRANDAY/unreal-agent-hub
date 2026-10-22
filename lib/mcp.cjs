// `hub mcp`: a small MCP server over stdio (JSON-RPC 2.0, one message per line) for Claude Code, Codex and Cursor.
// The chat sees the queue as data and takes a hold with a tool call instead of a shell command:
//   hub_status   hub_hold   hub_release   hub_here   hub_grant   hub_decline
// The hold belongs to the agent process that started this server (its parent): it lasts until hub_release,
// the agent exits, or the TTL is over. On a node, status and the handover answers go to the hub over HTTP.
'use strict';
const readline = require('readline');
const C = require('./config.cjs');
const U = require('./util.cjs');
const { T } = require('./i18n.cjs');

const PROTOCOL = '2025-06-18';
const VERSION = require('../package.json').version;

const TOOLS = [
  { name: 'hub_status', description: 'Shared resources of Unreal Agent Hub: who holds each one, who waits in the queue (by priority), and handover requests waiting for a person. Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'hub_hold', description: 'Hold a shared resource (for example the editor or the C++ build) across several steps of this chat, so no other chat or script takes it in between. Waits up to wait_sec for it. Release it with hub_release when done.',
    inputSchema: { type: 'object', properties: {
      resource: { type: 'string', description: 'Resource name: an id such as "cpp" or "editor", "@node:<id>", or "role:runner" for the first free runner.' },
      ttl_min: { type: 'number', description: 'Minutes after which the hold expires by itself (default: the resource TTL).' },
      note: { type: 'string', description: 'What the hold is for, shown on the board.' },
      wait_sec: { type: 'number', description: 'How long to wait in the queue (0-50 seconds, default 20). If still busy, the answer says who holds it.' },
    }, required: ['resource'], additionalProperties: false } },
  { name: 'hub_release', description: 'Release a resource this chat holds (taken with hub_hold or hub hold).',
    inputSchema: { type: 'object', properties: { resource: { type: 'string' } }, required: ['resource'], additionalProperties: false } },
  { name: 'hub_here', description: 'Mark that the person sits at a machine (presence): remote runs then queue and ask before taking it. on=false removes the mark.',
    inputSchema: { type: 'object', properties: { machine: { type: 'string', description: 'Machine id (default: where the person usually sits).' },
      on: { type: 'boolean', default: true }, ttl_min: { type: 'number' } }, additionalProperties: false } },
  { name: 'hub_grant', description: 'Answer "yes, take it" to a handover request: a remote run may use the machine the person sits at, for one run. Use only when the person said so.',
    inputSchema: { type: 'object', properties: { resource: { type: 'string', description: 'Resource key or machine id (default: the only pending request).' },
      token: { type: 'string' } }, additionalProperties: false } },
  { name: 'hub_decline', description: 'Answer "not now" to a handover request: the run stays queued and asks again later. Use only when the person said so.',
    inputSchema: { type: 'object', properties: { resource: { type: 'string' }, token: { type: 'string' } }, additionalProperties: false } },
];

function textResult(text, data, isError) {
  const r = { content: [{ type: 'text', text }] };
  if (data !== undefined) r.structuredContent = Array.isArray(data) ? { items: data } : data;
  if (isError) r.isError = true;
  return r;
}

async function call(name, args, ctx) {
  const cfg = ctx.cfg;
  args = args || {};
  if (cfg.role === 'node') return callRemote(name, args, cfg);
  const { Store } = require('./store.cjs');
  const store = new Store(cfg.stateDir, { machine: cfg.id });
  const H = require('./handover.cjs');
  const findKey = (name) => {
    if (name) {
      const m = C.resolve(cfg, name);
      if (m.length) return m[0].key;
      return require('./presence.cjs').machineKey(cfg, name);
    }
    const pending = C.allResources(cfg).filter(r => store.readAsks(r.key).some(a => a.state === 'pending' || a.state === 'declined'));
    return pending.length === 1 ? pending[0].key : null;
  };
  switch (name) {
    case 'hub_status': {
      const S = require('./status.cjs');
      const d = S.data(cfg, store);
      return textResult(S.format(d), d);
    }
    case 'hub_hold': {
      const client = require('./lock-client.cjs');
      const waitSec = Math.max(0, Math.min(50, args.wait_sec == null ? 20 : Number(args.wait_sec)));
      const r = await client.acquire(cfg, store, args.resource, {
        mode: 'hold', ttlMin: args.ttl_min, note: args.note || 'hub_hold', script: 'MCP hub_hold',
        ownerPid: ctx.ownerPid, noWait: waitSec === 0, waitMin: waitSec / 60, extra: { by: 'mcp' },
      });
      if (!r.ok) return textResult(T('mcp.notHeld', { error: r.error }), { ok: false, error: r.error }, true);
      return textResult(r.reentrant ? T('mcp.holdAlready', { key: r.key }) : r.presence ? T('mcp.holdPresence', { key: r.key })
        : T('mcp.held', { key: r.key, ttl: r.lock.ttlMin }), { ok: true, key: r.key, token: r.token });
    }
    case 'hub_release': {
      const m = C.resolve(cfg, args.resource);
      const key = m.length ? m[0].key : args.resource;
      const lock = store.readLock(key);
      if (!lock) return textResult(T('mcp.relNotHeld', { key }), { ok: true });
      const mine = lock.ownerPid && lock.ownerPid === ctx.ownerPid || (lock.session && lock.session === process.env.CLAUDE_CODE_SESSION_ID);
      if (!mine) return textResult(T('mcp.relNotMine', { key, holder: require('./store.cjs').describe(lock) }), { ok: false }, true);
      const r = require('./lock-client.cjs').release(cfg, store, key, lock.token, 'hub_release');
      return textResult(r.ok ? T('mcp.released', { key }) : T('mcp.relFail', { key, error: r.error }), { ok: r.ok }, !r.ok);
    }
    case 'hub_here': {
      const r = require('./presence.cjs').here(cfg, store, args.machine, args.on !== false, { ttlMin: args.ttl_min, by: 'MCP' });
      return textResult(r.ok ? (args.on === false ? T('mcp.hereOff', { key: r.key }) : T('mcp.hereOn', { key: r.key, ttl: r.ttlMin ? T('presence.forMin', { n: r.ttlMin }) : '' })) : r.error, r, !r.ok);
    }
    case 'hub_grant':
    case 'hub_decline': {
      const key = findKey(args.resource);
      if (!key) return textResult(T('mcp.noPending'), { ok: false }, true);
      const r = (name === 'hub_grant' ? H.grant : H.decline)(store, cfg, key, args.token, 'MCP');
      return textResult(r.ok ? (name === 'hub_grant' ? T('mcp.granted', { key, who: r.ask.chat || r.ask.script || r.ask.token }) : T('mcp.declined', { min: cfg.handover.askAgainMin })) : r.error, r, !r.ok);
    }
    default: throw Object.assign(new Error(`unknown tool ${name}`), { code: -32602 });
  }
}

async function callRemote(name, args, cfg) {
  const client = require('./transport/client.cjs');
  if (name === 'hub_status') {
    const s = await client.post(cfg, '/api/node/state', {}, 4000);
    if (!s) return textResult(T('mcp.hubDown'), { ok: false }, true);
    const lines = s.resources.map(r => `${r.key.padEnd(18)} ${r.lock ? (r.lock.chat || r.lock.mode) : T('status.free')}${r.waiters.length ? T('mcp.queued', { n: r.waiters.length }) : ''}`);
    return textResult(lines.join('\n'), { resources: s.resources.map(r => ({ key: r.key, lock: r.lock, waiters: r.waiters, asks: r.asks })) });
  }
  const route = { hub_here: '/api/node/presence', hub_grant: '/api/node/grant', hub_decline: '/api/node/decline' }[name];
  if (!route) return textResult(T('mcp.runsOnHub', { name }), { ok: false }, true);
  const r = await client.post(cfg, route, { key: args.resource, node: args.machine || cfg.id, token: args.token, on: args.on !== false, ttlMin: args.ttl_min }, 4000);
  if (!r) return textResult(T('mcp.hubDown'), { ok: false }, true);
  return textResult(r.ok ? T('mcp.done') : r.error || T('mcp.failed'), r, !r.ok);
}

function serve(opts) {
  opts = opts || {};
  const input = opts.input || process.stdin, output = opts.output || process.stdout;
  const ctx = { cfg: opts.cfg || C.load({ cwd: process.cwd() }), ownerPid: opts.ownerPid != null ? opts.ownerPid : process.ppid };
  const send = msg => output.write(JSON.stringify(msg) + '\n');
  const rl = readline.createInterface({ input });
  rl.on('line', async line => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch (_) { return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); }
    const { id, method, params } = msg;
    const reply = result => { if (id !== undefined && id !== null) send({ jsonrpc: '2.0', id, result }); };
    const fail = (code, message) => { if (id !== undefined && id !== null) send({ jsonrpc: '2.0', id, error: { code, message } }); };
    try {
      if (method === 'initialize') {
        reply({ protocolVersion: (params && params.protocolVersion) || PROTOCOL, capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'unreal-agent-hub', version: VERSION },
          instructions: 'Shared resources (editor, C++ build, cook, GPU machines) of Unreal Agent Hub. Check hub_status before heavy work; hold a resource across several steps with hub_hold and free it with hub_release. Answer handover requests (hub_grant / hub_decline) only with the person\'s own words.' });
      } else if (method === 'ping') reply({});
      else if (method === 'tools/list') reply({ tools: TOOLS });
      else if (method === 'tools/call') reply(await call(params.name, params.arguments, ctx));
      else if (method && method.startsWith('notifications/')) { /* no answer */ }
      else fail(-32601, `method not found: ${method}`);
    } catch (e) { fail(e.code || -32603, String(e.message || e)); }
  });
  return rl;
}

module.exports = { serve, call, TOOLS };
