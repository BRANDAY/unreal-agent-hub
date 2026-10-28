// The watchdog proxy in front of the editor's MCP (lib/mcp-proxy.cjs, docs/MCP-PROXY.md) against a fake editor.
// By default the fake behaves like the UE 5.8 ModelContextProtocol plugin (sessions in memory, 404 "client should
// reinitialize" after a restart, ping without a session, GET 405, MethodNotFound for unknown methods, an unreadable
// unframed SSE reply when a call carries a progressToken). Options turn on what a later plugin might do instead: no
// sessions, no initialize, ping only in a session, a prompts family, its own server/discover, a request to the client
// mid-call, another tool list, another protocol version. Then the hub's side: the status file the board and the hook
// read, the reason of a restart in a timeout, `hub mcp-proxy install` for the three agents.
// Nothing here touches the real editor, port 8000 or 8001: all ports are ephemeral, every home folder is temporary.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const net = require('net');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { tempHome, rm } = require('./helpers.cjs');

const HUB = path.join(__dirname, '..', 'bin', 'hub.cjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'uah-mcp-proxy-'));
const HOME = tempHome({ id: 'm1' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let cacheN = 0;
const check = (name, cond, extra) => assert.ok(cond, name + (extra ? '  -- ' + extra : ''));
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const procs = new Set();
test.after(() => { for (const p of procs) try { p.kill(); } catch (_) {} rm(TMP); rm(HOME); });

// ------------------------------------------------------------------------------------------- fake editor
function fakeEditor(port, o = {}) {
  const sessions = new Set();
  const stats = { calls: 0, inits: 0, tokens: 0, deletes: 0, versionHeaders: [] };
  const tools = o.tools || ['list_toolsets', 'call_tool'];
  const versions = o.versions || ['2025-11-25', '2025-06-18', '2024-11-05'];
  const pending = new Map(); // id of a request we sent to the client -> continuation
  const server = http.createServer((req, res) => {
    if (req.method === 'GET') { res.writeHead(405); return res.end(); }
    if (req.method === 'DELETE') { stats.deletes++; const ok = sessions.delete(req.headers['mcp-session-id']); res.writeHead(ok ? 202 : 400); return res.end(); }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const msg = JSON.parse(body);
      const json = (obj, extra = {}, status = 200) => { res.writeHead(status, Object.assign({ 'Content-Type': 'application/json' }, extra)); res.end(JSON.stringify(obj)); };
      const sid = req.headers['mcp-session-id'];
      if (req.headers['mcp-protocol-version']) stats.versionHeaders.push(req.headers['mcp-protocol-version']);
      if (msg.method === undefined) { const k = pending.get(msg.id); if (k) { pending.delete(msg.id); k(msg); } res.writeHead(202); return res.end(); }
      if (msg.method === 'ping') {
        if (o.pingNeedsSession && !sessions.has(sid)) return json({ jsonrpc: '2.0', id: msg.id, error: { code: -32600, message: 'no session' } }, {}, 400);
        return json({ jsonrpc: '2.0', id: msg.id, result: {} });
      }
      if (msg.method === 'initialize') {
        if (o.noInit) return json({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Call to unknown method "initialize"' } }, {}, 400);
        stats.inits++;
        const v = versions.includes(msg.params.protocolVersion) ? msg.params.protocolVersion : versions[0];
        const caps = Object.assign({ tools: { listChanged: true }, resources: {} }, o.prompts ? { prompts: {} } : {});
        const result = { protocolVersion: v, capabilities: caps, serverInfo: { name: 'fake-ue', version: '1' } };
        if (o.stateless) return json({ jsonrpc: '2.0', id: msg.id, result });
        const id = 'up' + Math.random().toString(16).slice(2);
        sessions.add(id);
        return json({ jsonrpc: '2.0', id: msg.id, result }, { 'Mcp-Session-Id': id });
      }
      const known = ['notifications/initialized', 'notifications/cancelled', 'tools/list', 'tools/call', 'resources/list', 'resources/read',
        ...(o.prompts ? ['prompts/list', 'prompts/get'] : []), ...(o.discover ? ['server/discover'] : [])];
      if (!known.includes(msg.method)) return json({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Call to unknown method "${msg.method}"` } }, {}, 400);
      if (msg.method === 'server/discover') return json({ jsonrpc: '2.0', id: msg.id, result: { fake: 'discover' } });
      if (!o.stateless && !o.noInit) {
        if (!sid) { res.writeHead(400); return res.end(); }
        if (!sessions.has(sid)) return json({ jsonrpc: '2.0', id: msg.id, error: { code: -32600, message: `Unknown session id '${sid}'; client should reinitialize` } }, {}, 404);
      }
      if (msg.method === 'notifications/initialized') { res.writeHead(202); return res.end(); }
      if (msg.method === 'tools/list') return json({ jsonrpc: '2.0', id: msg.id, result: { tools: tools.map((name) => ({ name, inputSchema: { type: 'object' } })) } });
      if (msg.method === 'prompts/list') return json({ jsonrpc: '2.0', id: msg.id, result: { prompts: [{ name: 'p1' }] } });
      if (msg.method === 'prompts/get') return json({ jsonrpc: '2.0', id: msg.id, result: { messages: [{ role: 'user', content: { type: 'text', text: 'prompt from ' + (o.label || 'editor') } }] } });
      if (msg.method === 'tools/call') {
        stats.calls++;
        const result = { content: [{ type: 'text', text: `ran ${msg.params.name} on ${o.label || 'editor'}` }] };
        if (o.hangCalls) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.write(''); return; } // dies before answering
        const token = msg.params._meta && msg.params._meta.progressToken;
        if (token !== undefined) {
          stats.tokens++;
          // Like the plugin: SSE with neither Content-Length nor chunked encoding, which Node reads as an empty body.
          res.socket.write(`HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: keep-alive\r\nMcp-Session-Id: ${sid}\r\n\r\n` +
            `event: message\r\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\r\n\r\n`);
          return;
        }
        if (msg.params.name === 'ask') {
          // A later plugin asking the user mid-call (elicitation), framed SSE: request out, wait for the answer, result.
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 'srv-1', method: 'elicitation/create', params: { message: 'sure?' } })}\n\n`);
          pending.set('srv-1', (answer) => {
            res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'answer ' + JSON.stringify(answer.result) }] } })}\n\n`);
            res.end();
          });
          return;
        }
        return setTimeout(() => json({ jsonrpc: '2.0', id: msg.id, result }), msg.params.name === 'slow' ? 2500 : 0);
      }
      json({ jsonrpc: '2.0', id: msg.id, result: {} });
    });
  });
  const sockets = new Set();
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  return new Promise((r) => server.listen(port, '127.0.0.1', () => r({
    stats, sessions,
    stop: () => new Promise((rr) => { for (const s of sockets) s.destroy(); server.close(() => rr()); }),
  })));
}

// ------------------------------------------------------------------------------------------- proxy + client
function env(extra) { return Object.assign({}, process.env, { UAH_HOME: HOME, CLAUDE_CODE_SESSION_ID: '', CLAUDE_PID: '' }, extra || {}); }

function startProxy(upPort, extra = [], cacheFile, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [HUB, 'mcp-proxy', '--port', '0', '--upstream', `http://127.0.0.1:${upPort}/mcp`,
      '--cache', cacheFile || path.join(TMP, `cache${++cacheN}.json`), '--log', path.join(TMP, 'proxy.log'), '--keepalive', '1', ...extra],
    { stdio: ['ignore', 'ignore', 'pipe'], cwd: opts.cwd || TMP, env: env(opts.env) });
    procs.add(p);
    let err = '';
    p.stderr.on('data', (c) => {
      err += c;
      const m = err.match(/listening on http:\/\/127\.0\.0\.1:(\d+)\/mcp/);
      if (m && !p.port) { p.port = Number(m[1]); resolve(p); }
    });
    p.on('exit', (code) => { procs.delete(p); reject(new Error(`proxy exited ${code}: ${err}`)); });
  });
}

// POST to the proxy; returns {status, headers, messages[], raw}. onMessage sees each SSE message as it arrives.
function post(port, msg, sid, onMessage) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(msg);
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    if (sid) headers['Mcp-Session-Id'] = sid;
    const req = http.request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers, agent: false }, (res) => {
      let raw = '', buf = '';
      const messages = [];
      const sse = String(res.headers['content-type']).includes('text/event-stream');
      res.setEncoding('utf8');
      res.on('data', (c) => {
        raw += c;
        if (!sse) return;
        buf += c;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const d = buf.slice(0, i).split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
          buf = buf.slice(i + 2);
          if (d) { const m = JSON.parse(d); messages.push(m); if (onMessage) onMessage(m); }
        }
      });
      res.on('end', () => {
        if (!sse && raw) messages.push(JSON.parse(raw));
        resolve({ status: res.statusCode, headers: res.headers, messages, raw });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}
const final = (r) => r.messages.find((m) => m.id !== undefined && !m.method);
const INIT = (v = '2025-06-18') => ({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: v, capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
const CALL = (id, name, extra = {}) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: Object.assign({ name, arguments: {} }, extra) });
async function session(port, v) { const r = await post(port, INIT(v)); return { sid: r.headers['mcp-session-id'], r }; }
const kill = (p) => { procs.delete(p); p.kill(); };

// A stdio proxy: send() a message, waitId() for the reply with that id.
function stdioProxy(upPort, extra = [], opts = {}) {
  const sp = spawn(process.execPath, [HUB, 'mcp-proxy', '--stdio', '--upstream', `http://127.0.0.1:${upPort}/mcp`,
    '--cache', path.join(TMP, `cache_stdio${++cacheN}.json`), '--log', path.join(TMP, 'proxy.log'), ...extra],
  { stdio: ['pipe', 'pipe', 'ignore'], cwd: opts.cwd || TMP, env: env(opts.env) });
  procs.add(sp);
  const lines = [];
  let sbuf = '';
  sp.stdout.on('data', (c) => { sbuf += c; let i; while ((i = sbuf.indexOf('\n')) >= 0) { lines.push(JSON.parse(sbuf.slice(0, i))); sbuf = sbuf.slice(i + 1); } });
  sp.on('exit', () => procs.delete(sp));
  return {
    sp, lines,
    send: (m) => sp.stdin.write(JSON.stringify(m) + '\n'),
    waitId: async (id, ms) => { const end = Date.now() + ms; while (Date.now() < end) { const m = lines.find((x) => x.id === id && !x.method); if (m) return m; await sleep(100); } return null; },
  };
}

test('UE 5.8 behaviour: cache while closed, wait for the editor, reopen its session after a restart', async () => {
  const upPort = await freePort();
  // 1. Editor closed from the start: no cache file, so the seed answers.
  let proxy = await startProxy(upPort, ['--wait', '30']);
  let { sid, r } = await session(proxy.port);
  check('initialize with the editor closed', r.status === 200 && final(r).result.protocolVersion === '2025-06-18' && !!sid);
  r = await post(proxy.port, { jsonrpc: '2.0', method: 'notifications/initialized' }, sid);
  check('notifications/initialized -> 202', r.status === 202);
  r = await post(proxy.port, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, sid);
  const seedNames = (final(r).result.tools || []).map((t) => t.name);
  check('tools/list with the editor closed comes from the seed', seedNames.includes('call_tool'), seedNames.join(','));
  r = await post(proxy.port, { jsonrpc: '2.0', id: 21, method: 'resources/list' }, sid);
  check('resources/list with the editor closed answers at once', final(r) && Array.isArray(final(r).result.resources));
  r = await post(proxy.port, { jsonrpc: '2.0', id: 3, method: 'ping' }, sid);
  check('ping with the editor closed', r.status === 200 && final(r).result);
  let t = Date.now();
  r = await post(proxy.port, { jsonrpc: '2.0', id: 31, method: 'server/discover', params: {} });
  check('unannounced method (Claude Code probe server/discover), editor closed -> MethodNotFound at once',
    final(r).error && final(r).error.code === -32601 && r.status === 400 && Date.now() - t < 1000, `${Date.now() - t} ms`);

  // 2. A call made while the editor is closed waits, then goes through once it is up.
  const t0 = Date.now();
  const pending = post(proxy.port, CALL(4, 'list_toolsets'), sid);
  await sleep(3500);
  let ed = await fakeEditor(upPort, { label: 'editor#1' });
  r = await pending;
  check('tools/call waits for the editor and passes', final(r) && /ran list_toolsets on editor#1/.test(JSON.stringify(final(r).result)),
    `${Math.round((Date.now() - t0) / 1000)} s`);
  check('the wait kept the stream alive (SSE keepalive comments)', /: mcp-proxy: waiting/.test(r.raw));
  check('reply carries the proxy session id, not the editor one', r.headers['mcp-session-id'] === sid);
  check('Mcp-Protocol-Version sent to the editor', ed.stats.versionHeaders.includes('2025-06-18'));

  r = await post(proxy.port, { jsonrpc: '2.0', id: 5, method: 'tools/list' }, sid);
  check('tools/list with the editor up comes from the editor', final(r).result.tools.length === 2);
  r = await post(proxy.port, { jsonrpc: '2.0', id: 51, method: 'server/discover', params: {} });
  check('sessionless probe with the editor up is asked of the editor, no session opened',
    final(r).error && final(r).error.code === -32601 && ed.stats.inits === 1, `inits ${ed.stats.inits}`);

  // 3. Editor restarted with a different tool set: its sessions are gone (404); the proxy reinitializes, repeats the
  //    call and tells the client the list changed.
  await ed.stop();
  ed = await fakeEditor(upPort, { label: 'editor#2', tools: ['list_toolsets', 'call_tool', 'new_tool'] });
  r = await post(proxy.port, CALL(6, 'call_tool'), sid);
  check('after an editor restart the call passes on a new editor session', final(r) && /editor#2/.test(JSON.stringify(final(r).result)));
  check('the restarted editor ran it exactly once', ed.stats.calls === 1 && ed.stats.inits === 1, JSON.stringify({ calls: ed.stats.calls, inits: ed.stats.inits }));
  const r6 = r;
  await sleep(300);
  r = await post(proxy.port, CALL(61, 'call_tool'), sid);
  const changed = [...r6.messages, ...r.messages].filter((m) => m.method === 'notifications/tools/list_changed').length;
  check('changed tool list after the restart -> notifications/tools/list_changed to the client, once', changed === 1 && final(r) && !final(r).error, `${changed}`);

  // 4. progressToken: kept away from the editor (its unframed SSE reply is unreadable); the proxy beats progress itself.
  r = await post(proxy.port, CALL(7, 'slow', { _meta: { progressToken: 'p1' } }), sid);
  check('progressToken is not sent to the editor', !ed.stats.tokens && final(r) && final(r).id === 7 && /ran slow/.test(JSON.stringify(final(r).result)));
  check('progress heartbeat while the tool runs', r.messages.some((m) => m.method === 'notifications/progress' && m.params.progressToken === 'p1'));

  // 5. Unknown session id (the proxy itself was restarted) is adopted, not 404.
  r = await post(proxy.port, CALL(8, 'list_toolsets'), 'stale-id-from-old-proxy');
  check('unknown proxy session id is adopted', r.status === 200 && final(r) && !final(r).error);

  // 6. GET -> 405 like the plugin; /status answers.
  const get = await new Promise((res) => http.get({ host: '127.0.0.1', port: proxy.port, path: '/mcp' }, (x) => { x.resume(); res(x.statusCode); }));
  check('GET /mcp -> 405', get === 405);
  const st = await new Promise((res) => http.get({ host: '127.0.0.1', port: proxy.port, path: '/status' }, (x) => { let b = ''; x.on('data', (c) => { b += c; }); x.on('end', () => res(JSON.parse(b))); }));
  check('GET /status: editor up, sessions listed', st.editorUp === true && st.sessions.length >= 1, JSON.stringify(st).slice(0, 120));
  kill(proxy);
  await ed.stop();

  // 7. Timeout: the editor never comes back -> a tool error that says what to do.
  proxy = await startProxy(upPort, ['--wait', '3']);
  ({ sid } = await session(proxy.port));
  r = await post(proxy.port, CALL(9, 'list_toolsets'), sid);
  check('timeout gives a tool error, not a dead transport', final(r) && final(r).result && final(r).result.isError && /did not answer/.test(final(r).result.content[0].text));

  // 8. The editor dies in the middle of a call: no repeat (it may have run), clear error.
  ed = await fakeEditor(upPort, { hangCalls: true });
  const mid = post(proxy.port, CALL(10, 'call_tool'), sid);
  for (let i = 0; i < 100 && ed.stats.calls === 0; i++) await sleep(100); // the call has reached the editor
  await ed.stop();
  r = await mid;
  check('editor lost mid-call -> error, call not repeated',
    final(r) && final(r).result && final(r).result.isError && /stopped answering/.test(final(r).result.content[0].text) && ed.stats.calls === 1);
  kill(proxy);
});

test('what a later plugin might do: no sessions, no initialize, new families, other versions, server requests', async () => {
  const upPort = await freePort();
  // 9. Stateless server: no Mcp-Session-Id at all.
  let ed = await fakeEditor(upPort, { stateless: true, label: 'stateless' });
  let proxy = await startProxy(upPort, ['--wait', '10']);
  let { sid } = await session(proxy.port);
  let r = await post(proxy.port, CALL(11, 'list_toolsets'), sid);
  check('stateless editor (no session ids): calls pass', final(r) && /on stateless/.test(JSON.stringify(final(r).result)));
  kill(proxy); await ed.stop();

  // 10. No initialize at all, ping only inside a session.
  ed = await fakeEditor(upPort, { noInit: true, pingNeedsSession: true, label: 'noinit' });
  proxy = await startProxy(upPort, ['--wait', '10']);
  ({ sid } = await session(proxy.port));
  r = await post(proxy.port, CALL(12, 'list_toolsets'), sid);
  check('editor without initialize, ping refused without a session: still seen as up, calls pass',
    final(r) && /on noinit/.test(JSON.stringify(final(r).result)));
  kill(proxy); await ed.stop();

  // 11. A new method family (prompts) and the editor's own server/discover; then the same with the editor closed.
  const famCache = path.join(TMP, 'family_cache.json');
  ed = await fakeEditor(upPort, { prompts: true, discover: true, label: 'v2' });
  proxy = await startProxy(upPort, ['--wait', '4'], famCache);
  ({ sid } = await session(proxy.port));
  r = await post(proxy.port, { jsonrpc: '2.0', id: 13, method: 'prompts/list' }, sid);
  check('new family announced by the editor: prompts/list forwarded', final(r) && final(r).result.prompts[0].name === 'p1');
  r = await post(proxy.port, { jsonrpc: '2.0', id: 14, method: 'prompts/get', params: { name: 'p1' } }, sid);
  check('prompts/get forwarded', final(r) && /prompt from v2/.test(JSON.stringify(final(r).result)));
  r = await post(proxy.port, { jsonrpc: '2.0', id: 15, method: 'server/discover' }, sid);
  check('a method the editor gained (server/discover) is forwarded, not answered by the proxy', final(r) && final(r).result && final(r).result.fake === 'discover');
  await ed.stop();
  r = await post(proxy.port, { jsonrpc: '2.0', id: 16, method: 'prompts/list' }, sid);
  check('editor closed: prompts/list from cache', final(r) && final(r).result.prompts[0].name === 'p1');
  const pget = post(proxy.port, { jsonrpc: '2.0', id: 17, method: 'prompts/get', params: { name: 'p1' } }, sid);
  await sleep(1500);
  ed = await fakeEditor(upPort, { prompts: true, label: 'v2b' });
  r = await pget;
  check('editor closed: prompts/get waits for it (announced family) and passes', final(r) && /prompt from v2b/.test(JSON.stringify(final(r).result)));
  kill(proxy); await ed.stop();

  // 12. Protocol version: the editor speaks only 2026-01-01; the client asks for it.
  const verCache = path.join(TMP, 'ver_cache.json');
  ed = await fakeEditor(upPort, { versions: ['2026-01-01'] });
  proxy = await startProxy(upPort, ['--wait', '4'], verCache);
  ({ r } = await session(proxy.port, '2026-01-01'));
  check('editor up: the client gets the version the editor negotiated', final(r).result.protocolVersion === '2026-01-01');
  kill(proxy); await ed.stop();
  proxy = await startProxy(upPort, ['--wait', '4'], verCache);
  ({ r } = await session(proxy.port, '2026-01-01'));
  check('editor closed: a version the editor accepted before is answered from the cache', final(r).result.protocolVersion === '2026-01-01');
  kill(proxy);

  // 13. The editor asks the client something mid-call (elicitation): request relayed, the answer goes back.
  ed = await fakeEditor(upPort, { label: 'asker' });
  proxy = await startProxy(upPort, ['--wait', '10']);
  ({ sid } = await session(proxy.port));
  r = await post(proxy.port, CALL(18, 'ask'), sid, (m) => {
    if (m.method === 'elicitation/create') post(proxy.port, { jsonrpc: '2.0', id: m.id, result: { action: 'accept' } }, sid);
  });
  check('server -> client request relayed and answered within the call', final(r) && final(r).result.content[0].text === 'answer {"action":"accept"}',
    final(r) ? JSON.stringify(final(r).result).slice(0, 80) : 'no reply');
  kill(proxy); await ed.stop();
});

// A project folder with an overlay, so the proxy started in it knows the project and its watch state.
function project(name) {
  const dir = fs.mkdtempSync(path.join(TMP, 'proj-'));
  fs.writeFileSync(path.join(dir, `${name}.uproject`), '{}');
  fs.writeFileSync(path.join(dir, '.unreal-agent-hub.json'), JSON.stringify({ project: name, profile: 'unreal', resources: [{ id: 'editor', ttlMin: 30 }] }));
  return dir;
}

test('stdio: one chat over stdin/stdout; its status file tells the board and the hook that calls wait in the proxy', async () => {
  const upPort = await freePort();
  const dir = project('Game');
  const C = require('../lib/config.cjs');
  const MP = require('../lib/mcp-proxy.cjs');
  const cfg = C.load({ env: { UAH_HOME: HOME }, cwd: dir });
  const p = stdioProxy(upPort, ['--wait', '30'], { cwd: dir, env: { CLAUDE_CODE_SESSION_ID: 'sess-proxied' } });
  p.send(INIT()); p.send({ jsonrpc: '2.0', method: 'notifications/initialized' }); p.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const l2 = await p.waitId(2, 5000);
  check('stdio: tools/list with the editor closed', l2 && l2.result.tools.length === 3);
  p.send(CALL(3, 'list_toolsets'));
  let mine = null;
  for (let i = 0; i < 40 && !(mine && mine.waiting); i++) { await sleep(100); mine = MP.list(cfg).find((x) => x.pid === p.sp.pid); }
  check('status file: stdio, project Game, this chat, editor down, one call waiting',
    mine && mine.mode === 'stdio' && mine.project === 'Game' && mine.session === 'sess-proxied' && mine.editorUp === false && mine.waiting === 1, JSON.stringify(mine));
  const board = MP.boardState(cfg).find((x) => x.project === 'Game');
  check('board: the project\'s editor is down with a call waiting', board && board.editorUp === false && board.waiting >= 1 && board.clients >= 1, JSON.stringify(board));
  check('the hook sees this chat\'s calls as proxied, another chat\'s not',
    MP.proxied(cfg, 'Game', { session: 'sess-proxied' }) && !MP.proxied(cfg, 'Game', { session: 'other' }) && !MP.proxied(cfg, 'Other', { session: 'sess-proxied' }));

  // The hook does not hold the proxied call for the restart (the proxy waits); another chat's call is still held.
  const W = require('../lib/watch.cjs');
  const hcfg = C.load({ env: { UAH_HOME: HOME }, cwd: dir });
  hcfg.project.watch = { port: upPort };
  hcfg.gateWaitSec = 0.3;
  W.markDown(hcfg, 'Game', { by: 'chat A' });
  const hook = async (session) => {
    let out = '';
    await require('../lib/hook.cjs').run('claude', { cfg: hcfg, stdout: { write: (s) => { out += s; } },
      input: { session_id: session, hook_event_name: 'PreToolUse', cwd: dir, tool_name: 'mcp__unreal-mcp__call_tool', tool_input: {} } });
    return out;
  };
  check('hook: the proxied chat\'s call goes on at once', !/restart is under way/.test(await hook('sess-proxied')));
  check('hook: a chat without the proxy still waits and is denied after gateWaitSec', /restart is under way \(closed by chat A/.test(await hook('sess-direct')));
  W.markUp(hcfg, 'Game');

  const ed = await fakeEditor(upPort, { label: 'editor#3' });
  const l3 = await p.waitId(3, 15000);
  check('stdio: call waits and passes', l3 && /editor#3/.test(JSON.stringify(l3.result)));
  p.sp.stdin.end();
  await new Promise((r) => p.sp.once('exit', r));
  check('the status file is gone with the process', !fs.existsSync(path.join(MP.dir(cfg), `${p.sp.pid}.json`)));
  await ed.stop();
});

test('a timeout says why the editor is down: the hub\'s watch state, or a --down-mark file', async () => {
  const upPort = await freePort();
  const dir = project('Lights');
  const C = require('../lib/config.cjs');
  const W = require('../lib/watch.cjs');
  const cfg = C.load({ env: { UAH_HOME: HOME }, cwd: dir });
  W.markDown(cfg, 'Lights', { by: 'chat Rebuild' });
  let proxy = await startProxy(upPort, ['--wait', '2'], null, { cwd: dir });
  let { sid } = await session(proxy.port);
  let r = await post(proxy.port, CALL(1, 'list_toolsets'), sid);
  check('reason from `hub watch down`', final(r).result.isError && /Why: closed by chat Rebuild at \d\d:\d\d, coming back\./.test(final(r).result.content[0].text), final(r).result.content[0].text);
  W.markUp(cfg, 'Lights');
  kill(proxy);
  const mark = path.join(TMP, 'down_mark.json');
  fs.writeFileSync(mark, JSON.stringify({ at: '2026-10-29T10:15:00', by: 'close_editor.ps1' }));
  proxy = await startProxy(upPort, ['--wait', '2', '--down-mark', mark], null, { cwd: dir });
  ({ sid } = await session(proxy.port));
  r = await post(proxy.port, CALL(2, 'list_toolsets'), sid);
  check('reason from --down-mark with an ISO time', /Why: closed by close_editor\.ps1 at 10:15/.test(final(r).result.content[0].text), final(r).result.content[0].text);
  kill(proxy);
  rm(dir);
});

test('install: unreal-mcp goes through the proxy and comes back as it was, for claude, cursor and codex', () => {
  const I = require('../lib/mcp-proxy-install.cjs');
  const C = require('../lib/config.cjs');
  const dir = project('Inst');
  const home = tempHome({ id: 'm1' });
  const cfg = C.load({ env: { UAH_HOME: home }, cwd: dir });
  try {
    // claude: the project's .mcp.json with the editor's own http entry and another server left alone.
    const mcpJson = path.join(dir, '.mcp.json');
    const before = { mcpServers: { 'unreal-mcp': { type: 'http', url: 'http://127.0.0.1:8123/mcp' }, other: { command: 'x' } } };
    fs.writeFileSync(mcpJson, JSON.stringify(before, null, 2) + '\n');
    assert.equal(I.defaultFile('claude', cfg, dir), mcpJson, 'the project file that has the entry');
    const dry = I.run({ agent: 'claude', dryRun: true, cfg, cwd: dir });
    assert.equal(JSON.parse(fs.readFileSync(mcpJson, 'utf8')).mcpServers['unreal-mcp'].type, 'http', 'dry run writes nothing');
    assert.match(dry.text, /mcp-proxy/);
    let r = I.run({ agent: 'claude', cfg, cwd: dir });
    const e = JSON.parse(fs.readFileSync(mcpJson, 'utf8')).mcpServers['unreal-mcp'];
    assert.deepEqual([e.type, e.command, e.args.slice(1), e.timeout], ['stdio', 'node', ['mcp-proxy', '--stdio', '--upstream', 'http://127.0.0.1:8123/mcp'], 1800000]);
    assert.match(e.args[0], /bin\/hub\.cjs$/);
    assert.ok(r.backup && fs.existsSync(r.backup), 'backup beside it');
    assert.ok(fs.existsSync(path.join(home, 'bin', 'hub.cjs')), 'the shim the entry calls');
    r = I.run({ agent: 'claude', cfg, cwd: dir });
    assert.equal(r.changed, false, 'a second install changes nothing');
    I.run({ agent: 'claude', uninstall: true, cfg, cwd: dir });
    assert.deepEqual(JSON.parse(fs.readFileSync(mcpJson, 'utf8')), before, 'uninstall puts the original entry back');
    r = I.run({ agent: 'claude', uninstall: true, cfg, cwd: dir });
    assert.equal(r.changed, false);
    assert.match(r.notes[0], /nothing to undo/);

    // cursor: no entry yet -> one is added for the profile's upstream; uninstall removes it.
    const cur = path.join(TMP, 'cursor-mcp.json');
    fs.writeFileSync(cur, JSON.stringify({ mcpServers: { other: { command: 'y' } } }));
    r = I.run({ agent: 'cursor', file: cur, cfg, cwd: dir });
    const ce = JSON.parse(fs.readFileSync(cur, 'utf8')).mcpServers['unreal-mcp'];
    assert.equal(ce.type, undefined);
    assert.equal(ce.args[ce.args.length - 1], 'http://127.0.0.1:8000/mcp');
    assert.ok(r.notes.some((n) => /had no unreal-mcp entry/.test(n)));
    I.run({ agent: 'cursor', file: cur, uninstall: true, cfg, cwd: dir });
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(cur, 'utf8')).mcpServers), ['other']);

    // codex: a TOML section with a subtable; the old lines are kept commented out and come back on uninstall.
    const toml = path.join(TMP, 'config.toml');
    const tb = 'model = "o4"\n\n[mcp_servers.unreal-mcp]\nurl = "http://127.0.0.1:8000/mcp"\n\n[mcp_servers.unreal-mcp.env]\nA = "1"\n\n[mcp_servers.other]\ncommand = "z"\n';
    fs.writeFileSync(toml, tb);
    I.run({ agent: 'codex', file: toml, cfg, cwd: dir });
    const tx = fs.readFileSync(toml, 'utf8');
    assert.match(tx, /\[mcp_servers\.unreal-mcp\]\ncommand = "node"\nargs = \[".*hub\.cjs", "mcp-proxy", "--stdio", "--upstream", "http:\/\/127\.0\.0\.1:8000\/mcp"\]/);
    assert.match(tx, /#\| A = "1"/);
    assert.match(tx, /tool_timeout_sec = 1800/);
    assert.match(tx, /\[mcp_servers\.other\]\ncommand = "z"/);
    assert.equal((tx.match(/^\[mcp_servers\.unreal-mcp/mg) || []).length, 1, 'one live section');
    I.run({ agent: 'codex', file: toml, cfg, cwd: dir });
    assert.equal(fs.readFileSync(toml, 'utf8'), tx, 'install again: the same file');
    I.run({ agent: 'codex', file: toml, uninstall: true, cfg, cwd: dir });
    assert.equal(fs.readFileSync(toml, 'utf8'), tb, 'uninstall: the original file');
  } finally { rm(home); rm(dir); }
});

test('settings: the unreal profile gives the upstream, the project overlay overrides it, flags win', () => {
  const C = require('../lib/config.cjs');
  const MP = require('../lib/mcp-proxy.cjs');
  const dir = project('Cfg');
  const ov = path.join(dir, '.unreal-agent-hub.json');
  let cfg = C.load({ env: { UAH_HOME: HOME }, cwd: dir });
  let m = C.profileFor(cfg, dir);
  let s = MP.settings(cfg, m.profile, m);
  assert.deepEqual([s.upstream, s.waitSec, s.port, s.project], ['http://127.0.0.1:8000/mcp', 900, 8001, 'Cfg']);
  fs.writeFileSync(ov, JSON.stringify({ project: 'Cfg', mcpProxy: { upstream: 'http://127.0.0.1:9000/mcp', waitSec: 60 } }));
  cfg = C.load({ env: { UAH_HOME: HOME }, cwd: dir });
  m = C.profileFor(cfg, dir);
  s = MP.settings(cfg, m.profile, m);
  assert.deepEqual([s.upstream, s.waitSec], ['http://127.0.0.1:9000/mcp', 60]);
  const o = MP.options(s, { stdio: true, wait: '5' }, {}, cfg);
  assert.deepEqual([o.mode, o.upstream, o.waitSec], ['stdio', 'http://127.0.0.1:9000/mcp', 5]);
  assert.equal(o.cache, path.join(cfg.stateDir, 'mcp-proxy', 'cache-Cfg.json'));
  rm(dir);
});
