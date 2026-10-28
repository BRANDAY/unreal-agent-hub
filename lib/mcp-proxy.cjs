// `hub mcp-proxy`: a watchdog proxy in front of the editor's MCP server (Unreal: the ModelContextProtocol plugin,
// 127.0.0.1:8000/mcp, Streamable HTTP). docs/MCP-PROXY.md has the setup.
//
// WHY. The editor IS the MCP server. When one chat restarts the editor, every other chat loses unreal-mcp for good:
// the client retries a dead HTTP server a few times (~31 s in Claude Code), marks it failed and never dials again,
// while a restart takes 2-6 min; and the sessions the editor kept in memory are gone, so old Mcp-Session-Id values
// get 404. Only a manual Reconnect brought the tools back.
//
// WHAT. The agent talks to this process instead of the editor. The proxy never goes away, so the client never
// gives up:
//   - initialize, ping and every */list (tools, resources, prompts...) are answered even with the editor closed,
//     from the cache state/mcp-proxy/cache-<project>.json, refreshed whenever the editor answers (first run:
//     lib/mcp-proxy-seed.json);
//   - any other request waits for the editor up to `waitSec` with a progress heartbeat, then goes through. A timeout
//     comes back as a tool error that says why the editor is down (lib/watch.cjs: a chat closed it, a build holds
//     it, the board is starting it) and what to do;
//   - each client session owns one editor session. A 404 from the editor (it was restarted) re-runs initialize on
//     the editor with the client's original params and repeats the request, which the editor never executed.
//     A call the editor may have executed (connection lost mid-call) is never repeated.
//
// VERSION-PROOF BY DESIGN. Nothing below names a tool or a toolset. What the proxy assumes about the server is taken
// from the server itself: which method families exist (initialize -> capabilities), the protocol version (the
// editor's answer, remembered per version), whether it keeps sessions at all (no Mcp-Session-Id = stateless, fine),
// whether it has initialize (MethodNotFound = stateless). Requests the server sends to the client (sampling,
// elicitation) and the client's answers are relayed. The one plugin-specific workaround is forUpstream();
// `--probe` reports whether the editor still behaves as assumed.
//
// Transport per the plugin source (Engine/Plugins/Experimental/ModelContextProtocol/.../ModelContextProtocolServer.cpp,
// UE 5.8): Streamable HTTP, POST only (GET -> 405, no standalone SSE stream), DELETE ends a session.
//
// Modes:  hub mcp-proxy --stdio     one client over stdin/stdout: the agent starts it per chat (the main mode)
//         hub mcp-proxy             HTTP on 127.0.0.1:<mcpProxy.port>/mcp (+ GET /status), shared by the chats
//         hub mcp-proxy --probe     check the editor against the proxy's assumptions, exit 0/1/2
// Options: --port N  --host H  --upstream URL  --wait SEC  --cache FILE  --log FILE  --keepalive SEC  --down-mark FILE
//          (env UAH_MCP_PROXY_*), else `mcpProxy` of the project overlay, the machine config and the profile.
// Every proxy process writes state/mcp-proxy/<pid>.json (editor up, calls waiting) for the board and the hook.
// Any error of the hub's own (config, state folder) fails open: the proxy still relays.
'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const U = require('./util.cjs');
const C = require('./config.cjs');
const W = require('./watch.cjs');
const { msg, say } = require('./i18n.cjs');

const SEED = path.join(__dirname, 'mcp-proxy-seed.json');
const DEFAULTS = { upstream: '', waitSec: 900, port: 8001, host: '127.0.0.1', keepaliveSec: 10, daemon: false };
const STATUS_MS = 20000;
const STATUS_FRESH_MS = 90000;

function dir(cfg) { return path.join(cfg.stateDir, 'mcp-proxy'); }

/** `mcpProxy` of the profile, the machine config and the project overlay (in that order, single keys replaced). */
function settings(cfg, profile, match) {
  const w = cfg ? W.settings(cfg, profile, match) : null;
  const s = Object.assign({}, DEFAULTS, (profile && profile.mcpProxy) || {}, (cfg && cfg.mcpProxy) || {},
    (cfg && cfg.project && cfg.project.mcpProxy) || {});
  if (!s.upstream) s.upstream = `http://127.0.0.1:${(w && w.port) || 8000}/mcp`;
  s.project = (w && w.project) || (cfg ? W.projectId(cfg, match) : '') || '';
  s.watch = w;
  return s;
}

const pick = (...xs) => xs.find(x => x !== undefined && x !== null && x !== '' && x !== true);

/** Options of one proxy process: command-line flags, then UAH_MCP_PROXY_*, then settings(). */
function options(s, a, env, cfg) {
  a = a || {}; env = env || process.env;
  const base = cfg ? dir(cfg) : path.join(os.tmpdir(), 'unreal-agent-hub-mcp-proxy');
  const upstream = String(pick(a.upstream, env.UAH_MCP_PROXY_UPSTREAM, s.upstream));
  let tag = s.project;
  if (!tag) { try { tag = 'port-' + (new URL(upstream).port || 80); } catch (_) { tag = 'default'; } }
  return {
    mode: a.stdio ? 'stdio' : a.probe ? 'probe' : 'http',
    host: String(pick(a.host, env.UAH_MCP_PROXY_HOST, s.host)),
    port: Number(pick(a.port, env.UAH_MCP_PROXY_PORT, s.port)),
    upstream,
    waitSec: Number(pick(a.wait, env.UAH_MCP_PROXY_WAIT_SEC, s.waitSec)),
    keepaliveSec: Number(pick(a.keepalive, env.UAH_MCP_PROXY_KEEPALIVE_SEC, s.keepaliveSec)),
    cache: String(pick(a.cache, env.UAH_MCP_PROXY_CACHE, path.join(base, `cache-${C.safeId(tag)}.json`))),
    log: String(pick(a.log, env.UAH_MCP_PROXY_LOG, path.join(base, 'proxy.log'))),
    downMark: String(pick(a['down-mark'], env.UAH_MCP_PROXY_DOWN_MARK, '')),
    project: s.project,
  };
}

/** Live proxy processes of this machine (state/mcp-proxy/<pid>.json); files of gone processes are removed. */
function list(cfg, now) {
  now = now || Date.now();
  let names = [];
  try { names = fs.readdirSync(dir(cfg)); } catch (_) { return []; }
  const out = [];
  for (const n of names) {
    if (!/^\d+\.json$/.test(n)) continue;
    const file = path.join(dir(cfg), n);
    const p = U.readJson(file);
    if (!p || !p.pid) continue;
    const local = !p.machine || p.machine === cfg.id;
    if (local && !U.pidAlive(p.pid)) { U.safeUnlink(file); continue; }
    if (now - Number(p.at || 0) > STATUS_FRESH_MS) continue;
    out.push(p);
  }
  return out;
}

/**
 * Does this chat's call to the project's app go through a proxy? Then the proxy does the waiting and the hook does
 * not wait for a restart as well. A stdio proxy belongs to the chat whose agent started it (its session or pid); an
 * HTTP proxy of the project serves every chat of it.
 */
function proxied(cfg, project, ev) {
  if (!project) return false;
  return list(cfg).some(p => p.project === project && (p.mode === 'http'
    || (ev.session && p.session && p.session === ev.session) || (ev.ownerPid && p.ownerPid && p.ownerPid === ev.ownerPid)));
}

/** The board's view: one entry per project (or upstream) with the editor's state and the calls waiting for it. */
function boardState(cfg, now) {
  const by = new Map();
  for (const p of list(cfg, now)) {
    const k = p.project || p.upstream;
    const g = by.get(k) || { project: p.project || '', upstream: p.upstream, editorUp: false, checkedAt: 0, waiting: 0, running: 0, proxies: 0, clients: 0 };
    if (Number(p.checkedAt || 0) >= g.checkedAt) { g.editorUp = !!p.editorUp; g.checkedAt = Number(p.checkedAt || 0); }
    g.waiting += Number(p.waiting) || 0;
    g.running += Number(p.running) || 0;
    g.proxies++;
    g.clients += p.mode === 'http' ? Number(p.sessions) || 0 : 1;
    by.set(k, g);
  }
  return [...by.values()];
}

// ---------------------------------------------------------------------------------------------------- the proxy
// ctx: {cfg, store, watch} for the reasons of a restart and the status file; any of them may be missing.
function create(OPT, ctx) {
  ctx = ctx || {};
  const UP = new URL(OPT.upstream);
  const statusFile = ctx.cfg ? path.join(dir(ctx.cfg), `${process.pid}.json`) : '';
  const ownerPid = Number(process.env.CLAUDE_PID) || process.ppid || 0;
  const started = Date.now();
  // Families a server may announce in initialize -> capabilities, by request prefix (MCP spec: "completion/complete"
  // is announced as "completions"). Only consulted while the editor is down.
  const capabilityOf = (method) => {
    const f = String(method).split('/')[0];
    const caps = (cache.initialize && cache.initialize.capabilities) || {};
    return caps[f] !== undefined ? f : caps[f + 's'] !== undefined ? f + 's' : null;
  };
  const isList = (m) => /\/list$/.test(m);
  // Result field of a list method: tools/list -> tools, resources/templates/list -> resourceTemplates.
  const listKey = (m) => m.split('/').slice(0, -1).map((p, i) => (i ? p[0].toUpperCase() + p.slice(1) : p)).join('');
  // Safe to repeat if the editor dropped the connection after receiving them: reads, no side effects.
  const isRead = (m) => isList(m) || /\/(read|get|complete)$/.test(m) || m === 'ping';
  const isRequest = (m) => m.id !== undefined && m.id !== null;
  // A JSON-RPC response (to a request of ours) as opposed to a request or notification from the server.
  const isResponse = (m) => m && !m.method && isRequest(m);

  // -------------------------------------------------------------------------------------------------- log
  function log(text) {
    const line = `${new Date().toISOString()} [${process.pid}${OPT.mode === 'http' ? '' : ' ' + OPT.mode}] ${text}\n`;
    process.stderr.write(line);
    if (OPT.log) {
      try { fs.mkdirSync(path.dirname(OPT.log), { recursive: true }); fs.appendFileSync(OPT.log, line); } catch (_) {}
    }
  }
  if (OPT.log) {
    try { if (fs.statSync(OPT.log).size > 5 * 1024 * 1024) fs.renameSync(OPT.log, OPT.log + '.old'); } catch (_) {}
  }

  // -------------------------------------------------------------------------------------------------- cache
  // { initialize: <editor's initialize result>, versions: [protocol versions the editor accepted as asked],
  //   lists: { "tools/list": <result>, "resources/list": <result>, ... }, savedAt }
  function normalizeCache(c) {
    c = c || {};
    c.lists = c.lists || {};
    if (Array.isArray(c.tools) && !c.lists['tools/list']) c.lists['tools/list'] = { tools: c.tools };
    if (Array.isArray(c.resources) && !c.lists['resources/list']) c.lists['resources/list'] = { resources: c.resources };
    delete c.tools; delete c.resources;
    c.versions = c.versions || (c.initialize && c.initialize.protocolVersion ? [c.initialize.protocolVersion] : []);
    return c;
  }
  let cache = normalizeCache(U.readJson(OPT.cache) || U.readJson(SEED));
  function saveCache(patch) {
    cache = Object.assign({}, cache, patch, { savedAt: new Date().toISOString() });
    try {
      fs.mkdirSync(path.dirname(OPT.cache), { recursive: true });
      const tmp = OPT.cache + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(cache, null, 1));
      fs.renameSync(tmp, OPT.cache);
    } catch (e) { log(`cache write failed: ${e.message}`); }
  }
  const listCount = (m) => { const r = cache.lists[m]; if (!r) return 0; const a = Object.values(r).find(Array.isArray); return a ? a.length : 0; };

  // -------------------------------------------------------------------------------------------------- status
  // state/mcp-proxy/<pid>.json: what the board shows and what tells the hook that this chat's calls are proxied.
  const sessions = new Map();
  const active = new Set(); // phase objects of the calls under way: {now: 'running' | 'waiting'}
  let lastSig = '';
  let upCheck = { at: 0, up: false, pending: null };
  function writeStatus(force) {
    if (!statusFile) return;
    const waiting = [...active].filter(p => p.now === 'waiting').length;
    const first = sessions.values().next().value;
    const rec = { pid: process.pid, ownerPid, session: process.env.CLAUDE_CODE_SESSION_ID || '', mode: OPT.mode, project: OPT.project || '',
      upstream: OPT.upstream, editorUp: upCheck.up, waiting, running: active.size - waiting, sessions: sessions.size,
      client: OPT.mode === 'stdio' && first ? ((first.initParams && first.initParams.clientInfo) || {}).name || '' : '',
      started, machine: ctx.cfg.id, waitSec: OPT.waitSec };
    const sig = JSON.stringify(rec);
    if (!force && sig === lastSig) return;
    lastSig = sig;
    try { U.writeJson(statusFile, Object.assign(rec, { at: Date.now(), checkedAt: upCheck.at })); } catch (_) {}
  }
  if (statusFile) process.on('exit', () => U.safeUnlink(statusFile));

  // -------------------------------------------------------------------------------------------------- upstream
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // One POST to the editor. Resolves {status, headers, messages[]} - the JSON body or every SSE "data:" message,
  // with onMessage called as each arrives - or {down: true, sent} when the editor did not answer. `sent` tells
  // whether the request may have reached it (a refused connection never did).
  function upstreamPost(body, sess, onMessage, timeoutMs) {
    return new Promise((resolve) => {
      const data = Buffer.from(JSON.stringify(body));
      const headers = {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Content-Length': data.length,
      };
      if (sess && sess.upId) headers['Mcp-Session-Id'] = sess.upId;
      if (sess && sess.upVersion) headers['Mcp-Protocol-Version'] = sess.upVersion;
      let connected = false, done = false;
      const finish = (r) => { if (!done) { done = true; resolve(r); } };
      const req = http.request({ host: UP.hostname, port: UP.port || 80, path: UP.pathname + UP.search, method: 'POST',
        headers, agent: false }, (res) => {
        const ctype = String(res.headers['content-type'] || '');
        const sse = ctype.includes('text/event-stream');
        const messages = [];
        let buf = '';
        res.setEncoding('utf8');
        const take = (text) => {
          if (!text.trim()) return;
          let m;
          try { m = JSON.parse(text); } catch (_) { return; }
          for (const one of Array.isArray(m) ? m : [m]) { messages.push(one); if (onMessage) onMessage(one); }
        };
        const takeBlock = (block) => {
          const dataLines = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, ''));
          if (dataLines.length) take(dataLines.join('\n'));
        };
        res.on('data', (chunk) => {
          buf += chunk;
          if (!sse) return;
          let mt;
          while ((mt = /\r?\n\r?\n/.exec(buf))) { takeBlock(buf.slice(0, mt.index)); buf = buf.slice(mt.index + mt[0].length); }
        });
        let ended = false;
        const end = () => {
          if (ended) return;
          ended = true;
          if (sse) takeBlock(buf); else take(buf);
          finish({ status: res.statusCode, headers: res.headers, messages });
        };
        res.on('end', end);
        // Closed before the body ended: the editor went away mid-reply. Keep what was delivered, report the loss.
        res.on('close', () => { if (!res.complete && !ended && !messages.some(isResponse)) finish({ down: true, sent: true }); else end(); });
        res.on('error', () => finish({ down: true, sent: true }));
      });
      req.on('socket', (s) => s.on('connect', () => { connected = true; }));
      req.on('error', () => finish({ down: true, sent: connected }));
      if (timeoutMs) req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
      req.end(data);
    });
  }

  // Is the editor's MCP server answering at all right now? Any HTTP reply below 500 counts - a server that wants a
  // session for ping (or has no ping) is still alive. Cached for 1 s.
  async function editorUp(force) {
    if (!force && Date.now() - upCheck.at < 1000) return upCheck.up;
    if (upCheck.pending) return upCheck.pending;
    upCheck.pending = upstreamPost({ jsonrpc: '2.0', id: 'proxy-ping', method: 'ping' }, null, null, 3000).then((r) => {
      const up = !r.down && r.status < 500;
      if (up !== upCheck.up) log(up ? 'editor is UP' : 'editor is DOWN');
      upCheck = { at: Date.now(), up, pending: null };
      writeStatus();
      return up;
    });
    return upCheck.pending;
  }

  // Why the editor is down, as a message, or null: --down-mark (a file {at: ms | ISO, by|chat|owner|note}) if given,
  // else the hub's own watch state (a busy resource, `hub watch down`, the board's watchdog starting it).
  function downWhy() {
    if (OPT.downMark) {
      const m = U.readJson(OPT.downMark);
      if (m) {
        const at = typeof m.at === 'number' ? m.at : Date.parse(m.at);
        return msg('watch.closedBy', { by: m.by || m.chat || m.owner || m.note || msg('watch.aChat'), time: Number.isFinite(at) ? U.hm(at) : '?' });
      }
    }
    if (ctx.cfg && ctx.store && ctx.watch) { try { return W.restartWhy(ctx.cfg, ctx.store, ctx.watch); } catch (_) {} }
    return null;
  }

  // -------------------------------------------------------------------------------------------------- sessions
  // proxy session id -> {id, initParams, toldVersion, upReady, upId, upVersion, upInit, created, calls, notify[]}
  const DEFAULT_INIT = { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'unknown', version: '0' } };

  function newSession(initParams, id) {
    const s = { id: id || crypto.randomUUID().replace(/-/g, ''), initParams: initParams || DEFAULT_INIT, toldVersion: null,
      upReady: false, upId: null, upVersion: null, upInit: null, created: Date.now(), calls: 0, notify: [], listSig: null };
    sessions.set(s.id, s);
    return s;
  }

  const toolsSig = (result) => JSON.stringify(((result && result.tools) || []).map((t) => t.name).sort());

  // Opens this client's session on the editor (initialize + notifications/initialized). Throws 'down' if the editor
  // does not answer. A server that gives no Mcp-Session-Id keeps no sessions (stateless); one that answers
  // MethodNotFound to initialize has no handshake at all. Both are taken as they are.
  function ensureUpstream(s) {
    if (s.upReady) return Promise.resolve();
    if (s.upInit) return s.upInit;
    s.upInit = (async () => {
      const r = await upstreamPost({ jsonrpc: '2.0', id: 'proxy-init', method: 'initialize', params: s.initParams }, null, null, 10000);
      if (r.down || r.status >= 500) throw new Error('down');
      const reply = r.messages.find(isResponse);
      if (reply && reply.error && reply.error.code === -32601) {
        s.upId = null; s.upVersion = null; s.upReady = true;
        log(`session ${s.id.slice(0, 8)}: editor has no initialize - talking to it without a handshake`);
        return;
      }
      if (!reply || !reply.result) throw new Error(`initialize failed: HTTP ${r.status} ${JSON.stringify((reply && reply.error) || '')}`);
      const res = reply.result;
      const asked = s.initParams.protocolVersion;
      const versions = new Set(cache.versions);
      if (res.protocolVersion === asked) versions.add(asked);
      saveCache({ initialize: res, versions: [...versions] });
      s.upId = r.headers['mcp-session-id'] || null;
      s.upVersion = res.protocolVersion || null;
      if (s.toldVersion && s.upVersion && s.toldVersion !== s.upVersion) {
        log(`session ${s.id.slice(0, 8)}: told the client protocol ${s.toldVersion}, the editor speaks ${s.upVersion}`);
      }
      await upstreamPost({ jsonrpc: '2.0', method: 'notifications/initialized' }, s, null, 10000);
      s.upReady = true;
      log(`session ${s.id.slice(0, 8)}: editor session ${s.upId ? s.upId.slice(0, 8) : '(stateless)'} opened, protocol ${s.upVersion}`);
      if (s.listSig !== null && capabilityOf('tools/list')) refreshTools(s);
    })().finally(() => { s.upInit = null; });
    return s.upInit;
  }

  function dropUpstream(s) { s.upReady = false; s.upId = null; }

  // After the editor came back: if its tool list is not what this client was given, tell the client
  // (notifications/tools/list_changed on its next reply - the plugin itself only pushes inside an open call).
  async function refreshTools(s) {
    const r = await upstreamPost({ jsonrpc: '2.0', id: 'proxy-tools', method: 'tools/list' }, s, null, 15000);
    const reply = !r.down && r.messages.find(isResponse);
    if (!reply || !reply.result) return;
    saveCache({ lists: Object.assign({}, cache.lists, { 'tools/list': reply.result }) });
    if (toolsSig(reply.result) !== s.listSig) {
      log(`session ${s.id.slice(0, 8)}: the editor's tool list changed - notifying the client`);
      s.listSig = toolsSig(reply.result);
      s.notify.push({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
      if (s.push) s.push();
    }
  }

  // The request as the editor gets it: without _meta.progressToken. With a token the UE 5.8 plugin answers
  // text/event-stream with neither Content-Length nor chunked encoding (its own comment in ProcessToolCallJsonRpcCall
  // says HTTP/1.1 clients cannot frame that), and Node reads such a body as empty - measured 28.10.2026. Without it the
  // editor sends one framed application/json reply; the client's progress comes from the proxy's own heartbeat.
  function forUpstream(m) {
    const meta = m.params && m.params._meta;
    if (!meta || meta.progressToken === undefined) return m;
    const rest = Object.assign({}, meta);
    delete rest.progressToken;
    const params = Object.assign({}, m.params, { _meta: rest });
    if (!Object.keys(rest).length) delete params._meta;
    return Object.assign({}, m, { params });
  }

  // Sends one client message to the editor and hands every message that comes back to sink.message(): requests and
  // notifications from the server as they stream, the response last. Waits for the editor when it is down (phase.now =
  // 'waiting' for the heartbeat), repeats a request the editor never executed (refused connection, 404 for a session
  // lost in a restart). Returns true if a response was delivered, false on timeout or with wait=false while down.
  async function forward(s, m, sink, { wait = true, retryAfterSend = false, phase = {} } = {}) {
    const deadline = Date.now() + OPT.waitSec * 1000;
    let waitingSince = 0, lastReinit = 0;
    const upMsg = forUpstream(m);
    const setPhase = (p) => { if (phase.now !== p) { phase.now = p; writeStatus(); } };
    for (;;) {
      let ok = await editorUp();
      if (ok) {
        try { await ensureUpstream(s); } catch (e) { ok = false; upCheck.at = 0; if (e.message !== 'down') log(`session ${s.id.slice(0, 8)}: ${e.message}`); }
      }
      if (ok) {
        setPhase('running');
        const r = await upstreamPost(upMsg, s, (x) => { if (x.method) sink.message(x); }, isRead(m.method) ? 60000 : 0);
        if (!r.down && r.status === 404 && s.upId) {
          log(`session ${s.id.slice(0, 8)}: editor forgot session ${s.upId.slice(0, 8)} (restart) - reinitializing`);
          dropUpstream(s);
          if (Date.now() - lastReinit < 1000) await sleep(1000);
          lastReinit = Date.now();
          continue;
        }
        if (!r.down && r.status < 500) {
          if (waitingSince) log(`session ${s.id.slice(0, 8)}: ${m.method} went through after ${Math.round((Date.now() - waitingSince) / 1000)} s of waiting`);
          const final = r.messages.find(isResponse);
          if (final) sink.message(final, r);
          else sink.message(errorFor(m, -32603, `Unreal MCP answered HTTP ${r.status} with no JSON-RPC response`), r);
          return true;
        }
        upCheck.at = 0;
        if (!r.down) log(`session ${s.id.slice(0, 8)}: editor answered HTTP ${r.status} to ${m.method} - treating it as down`);
        if (r.down && r.sent && !retryAfterSend) {
          sink.message(toolError(m, say(msg('proxy.lost'))));
          return true;
        }
        dropUpstream(s);
      }
      if (!wait || Date.now() > deadline) return false;
      setPhase('waiting');
      if (!waitingSince) { waitingSince = Date.now(); log(`session ${s.id.slice(0, 8)}: ${m.method} waits for the editor`); }
      await sleep(2000);
    }
  }

  function errorFor(m, code, message) { return { jsonrpc: '2.0', id: m.id === undefined ? null : m.id, error: { code, message } }; }
  function toolError(m, text) {
    if (m.method !== 'tools/call') return errorFor(m, -32000, text);
    return { jsonrpc: '2.0', id: m.id, result: { isError: true, content: [{ type: 'text', text }] } };
  }
  function timeoutReply(m) {
    const why = downWhy();
    return toolError(m, say(msg('proxy.timeout', { upstream: OPT.upstream, sec: OPT.waitSec, why: why ? msg('proxy.why', { why }) : '' })));
  }

  function beatText(sec, phase) {
    return say(msg(phase === 'waiting' ? 'proxy.beatWaiting' : 'proxy.beatRunning', { upstream: OPT.upstream, sec }));
  }

  // The protocol version to tell a client while the editor is down: its own, if the editor ever accepted it;
  // otherwise the one the editor last answered with.
  function offlineVersion(asked) {
    if (cache.versions.includes(asked)) return asked;
    return (cache.initialize && cache.initialize.protocolVersion) || asked;
  }

  // Handles one client message. sink = {message(obj, upstreamReply?), waiting(sec, phase), accepted()}.
  async function handle(s, m, sink) {
    const meth = m.method;
    if (meth === undefined) {
      // The client's answer to a request the editor sent it (sampling, elicitation): back to the editor.
      if (s.upReady) upstreamPost(m, s, null, 10000).catch(() => {});
      return sink.accepted();
    }
    if (meth === 'initialize') {
      let result = null;
      if (await editorUp()) {
        try { await ensureUpstream(s); result = cache.initialize; } catch (_) {}
      }
      const asked = m.params && m.params.protocolVersion;
      const base = cache.initialize || { capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'Unreal Engine (via Unreal Agent Hub mcp-proxy)', version: '0' } };
      result = result ? Object.assign({}, result) : Object.assign({}, base, { protocolVersion: offlineVersion(asked) });
      s.toldVersion = result.protocolVersion;
      log(`session ${s.id.slice(0, 8)}: initialize from ${JSON.stringify((m.params || {}).clientInfo || {})}, editor ${s.upReady ? 'up' : 'down - answered from cache'}, protocol ${result.protocolVersion}`);
      writeStatus();
      return sink.message({ jsonrpc: '2.0', id: m.id, result });
    }
    if (meth === 'ping') return sink.message({ jsonrpc: '2.0', id: m.id, result: {} });
    if (s.transient) {
      // A sessionless probe of a method the server never announced: ask the editor once without a session (the plugin
      // answers unknown methods before it looks at sessions), or answer like it when it is down.
      const r = (await editorUp()) ? await upstreamPost(forUpstream(m), null, null, 10000) : { down: true };
      const reply = !r.down && r.messages.find(isResponse);
      if (reply) return sink.message(reply, r);
      return sink.message(errorFor(m, -32601, `Call to unknown method "${meth}"`), { status: 400 });
    }
    if (!isRequest(m)) {
      // notifications: initialized is ours to answer; the rest go on if the editor session exists.
      if (meth !== 'notifications/initialized' && s.upReady) upstreamPost(forUpstream(m), s, null, 5000).catch(() => {});
      return sink.accepted();
    }
    if (isList(meth)) {
      let got = null;
      const ok = await forward(s, m, { message: (x) => { if (isResponse(x)) got = x; else sink.message(x); }, waiting() {} },
        { wait: false, retryAfterSend: true });
      if (ok && got && got.result) {
        if (!got.result.nextCursor && !(m.params && m.params.cursor)) saveCache({ lists: Object.assign({}, cache.lists, { [meth]: got.result }) });
        if (meth === 'tools/list') s.listSig = toolsSig(got.result);
        return sink.message(got);
      }
      if (ok && got) return sink.message(got);
      if (cache.lists[meth] || capabilityOf(meth)) {
        // Never seen, but the server has the family: an empty list now beats a connect that hangs on a closed editor.
        const result = cache.lists[meth] || { [listKey(meth)]: [] };
        log(`session ${s.id.slice(0, 8)}: ${meth} answered from cache (${listCount(meth)})`);
        if (meth === 'tools/list') s.listSig = toolsSig(result);
        return sink.message({ jsonrpc: '2.0', id: m.id, result });
      }
    }
    if (!(await editorUp()) && !capabilityOf(meth)) {
      // Down, and the server never announced this family (Claude Code 2.1.227 opens with server/discover): answer
      // like the plugin does instead of making a probe wait for a closed editor. Up, everything goes to the editor.
      return sink.message(errorFor(m, -32601, `Call to unknown method "${meth}"`), { status: 400 });
    }
    s.calls++;
    if (s.calls === 1) log(`session ${s.id.slice(0, 8)}: first ${meth}, progressToken ${m.params && m.params._meta && m.params._meta.progressToken !== undefined ? 'present' : 'absent'}`);
    // Heartbeat for the whole call - while the editor is down and while the tool runs: Claude Code aborts a tool that
    // "sent no response or progress" for its idle timeout, and the editor's own progress is off (forUpstream()).
    const phase = { now: 'running' };
    active.add(phase);
    writeStatus();
    const t0 = Date.now();
    const beat = setInterval(() => sink.waiting(Math.round((Date.now() - t0) / 1000), phase.now), OPT.keepaliveSec * 1000);
    let ok;
    try { ok = await forward(s, m, sink, { retryAfterSend: isRead(meth), phase }); } finally { clearInterval(beat); active.delete(phase); writeStatus(); }
    if (!ok) sink.message(timeoutReply(m));
  }

  // ---------------------------------------------------------------------------------------------------- HTTP front
  function statusJson() {
    return { upstream: OPT.upstream, project: OPT.project || '', editorUp: upCheck.up, checkedAt: upCheck.at, waitSec: OPT.waitSec,
      waiting: [...active].filter(p => p.now === 'waiting').length, running: [...active].filter(p => p.now !== 'waiting').length,
      cache: { file: OPT.cache, savedAt: cache.savedAt, protocol: cache.initialize && cache.initialize.protocolVersion,
        lists: Object.fromEntries(Object.keys(cache.lists).map((k) => [k, listCount(k)])) },
      sessions: [...sessions.values()].map((s) => ({ id: s.id, editorSession: s.upId, editorReady: s.upReady,
        client: (s.initParams.clientInfo || {}).name, calls: s.calls, created: new Date(s.created).toISOString() })) };
  }

  function heartbeat() { const t = setInterval(() => { editorUp(true).then(() => writeStatus(true)); }, STATUS_MS); t.unref(); }

  function startHttp() {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://x');
      if (req.method === 'GET' && url.pathname === '/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(statusJson(), null, 1));
      }
      if (url.pathname !== '/mcp') { res.writeHead(404); return res.end(); }
      if (req.method === 'GET') { res.writeHead(405, { Allow: 'POST, DELETE' }); return res.end(); }
      const sid = req.headers['mcp-session-id'];
      if (req.method === 'DELETE') {
        const s = sid && sessions.get(sid);
        if (s) {
          sessions.delete(sid);
          if (s.upId) deleteUpstream(s.upId);
          log(`session ${sid.slice(0, 8)}: closed by client`);
          writeStatus();
        }
        res.writeHead(s ? 202 : 404); return res.end();
      }
      if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let m;
        try { m = JSON.parse(body); } catch (_) { m = null; }
        const valid = m && !Array.isArray(m) && m.jsonrpc === '2.0' &&
          (typeof m.method === 'string' || (m.method === undefined && isRequest(m) && ('result' in m || 'error' in m)));
        if (!valid) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify(errorFor(m || {}, -32600, 'Invalid JSON-RPC message (batches are not supported)')));
        }
        let s;
        if (m.method === 'initialize') s = newSession(m.params);
        else if (sid && sessions.has(sid)) s = sessions.get(sid);
        else if (m.method && isRequest(m) && !capabilityOf(m.method) && !isList(m.method)) {
          s = { id: sid || '', transient: true, initParams: DEFAULT_INIT, calls: 0, notify: [] }; // a probe: no session kept
        } else {
          // Unknown id (this proxy restarted) or none: adopt it rather than 404, so the client never has to reinit.
          s = newSession(null, sid || undefined);
          log(`session ${s.id.slice(0, 8)}: adopted for ${m.method || 'a response'} (${sid ? 'unknown id' : 'no id'})`);
        }
        const canStream = String(req.headers.accept || '').includes('text/event-stream');
        let sse = false;
        const progressToken = m.params && m.params._meta && m.params._meta.progressToken;
        const openSse = () => {
          if (sse || res.headersSent) return;
          sse = true;
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive',
            'Mcp-Session-Id': s.id });
        };
        const event = (x) => res.write(`event: message\ndata: ${JSON.stringify(x)}\n\n`);
        const flushNotify = () => { while (s.notify && s.notify.length) event(s.notify.shift()); };
        const sink = {
          message(x, up) {
            if (res.writableEnded) return;
            if (!isResponse(x)) { if (canStream) { openSse(); flushNotify(); event(x); } return; }
            if (canStream && s.notify && s.notify.length) openSse();
            if (sse) { flushNotify(); event(x); return res.end(); }
            res.writeHead(up && up.status >= 400 ? up.status : 200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': s.id });
            res.end(JSON.stringify(x));
          },
          waiting(sec, phase) {
            if (!canStream || res.writableEnded) return;
            openSse();
            flushNotify();
            res.write(`: mcp-proxy: ${beatText(sec, phase)}\n\n`);
            if (progressToken !== undefined) {
              event({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken, progress: sec, message: beatText(sec, phase) } });
            }
          },
          accepted() { res.writeHead(202, { 'Mcp-Session-Id': s.id }); res.end(); },
        };
        handle(s, m, sink).catch((e) => {
          log(`error in ${m.method}: ${e.stack || e}`);
          sink.message(errorFor(m, -32603, `mcp-proxy internal error: ${e.message}`));
        });
      });
    });
    server.requestTimeout = 0;
    server.headersTimeout = 60000;
    server.keepAliveTimeout = 65000;
    server.on('error', (e) => { log(`listen failed: ${e.message}`); process.exit(1); });
    server.listen(OPT.port, OPT.host, () => {
      log(`listening on http://${OPT.host}:${server.address().port}/mcp -> ${OPT.upstream} (wait ${OPT.waitSec} s, ` +
        `cache ${listCount('tools/list')} tools from ${cache.savedAt || 'the seed'})`);
      editorUp(true).then(() => writeStatus(true));
      heartbeat();
    });
    return server;
  }

  function deleteUpstream(upId) {
    const req = http.request({ host: UP.hostname, port: UP.port || 80, path: UP.pathname + UP.search, method: 'DELETE',
      headers: { 'Mcp-Session-Id': upId }, agent: false }, (r) => r.resume());
    req.on('error', () => {});
    req.setTimeout(3000, () => req.destroy());
    req.end();
  }

  // ---------------------------------------------------------------------------------------------------- stdio front
  function startStdio() {
    const s = newSession(null);
    const out = (x) => process.stdout.write(JSON.stringify(x) + '\n');
    s.push = () => { while (s.notify.length) out(s.notify.shift()); };
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let m;
        try { m = JSON.parse(line); } catch (_) { out(errorFor({ id: null }, -32700, 'Parse error')); continue; }
        if (!m || (typeof m.method !== 'string' && !(isRequest(m) && ('result' in m || 'error' in m)))) continue;
        if (m.method === 'initialize') { s.initParams = m.params || DEFAULT_INIT; if (s.upId) deleteUpstream(s.upId); dropUpstream(s); }
        const progressToken = m.params && m.params._meta && m.params._meta.progressToken;
        const sink = {
          message(x) { if (x) out(x); },
          waiting(sec, phase) {
            if (progressToken !== undefined) out({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken,
              progress: sec, message: beatText(sec, phase) } });
          },
          accepted() {},
        };
        handle(s, m, sink).catch((e) => {
          log(`error in ${m.method}: ${e.stack || e}`);
          if (isRequest(m)) out(errorFor(m, -32603, `mcp-proxy internal error: ${e.message}`));
        });
      }
    });
    process.stdin.on('end', () => { if (s.upId) deleteUpstream(s.upId); setTimeout(() => process.exit(0), 200); });
    log(`stdio session -> ${OPT.upstream} (wait ${OPT.waitSec} s, cache ${listCount('tools/list')} tools)`);
    editorUp(true).then(() => writeStatus(true));
    heartbeat();
  }

  // ---------------------------------------------------------------------------------------------------- probe
  // After an engine or plugin update: does the editor still behave the way this proxy assumes? Read-only
  // (initialize, tools/list, DELETE of its own session). Exit 0 = fine, 1 = something to look at, 2 = editor down.
  async function probe() {
    const lines = [], bad = [];
    const note = (ok, text) => { lines.push(`${ok ? 'OK  ' : 'WARN'} ${text}`); if (!ok) bad.push(text); };
    if (!(await editorUp(true))) { console.log(`DOWN editor does not answer on ${OPT.upstream}`); process.exit(2); }
    const s = newSession({ protocolVersion: (cache.initialize && cache.initialize.protocolVersion) || DEFAULT_INIT.protocolVersion,
      capabilities: {}, clientInfo: { name: 'mcp-proxy-probe', version: '1' } });
    try { await ensureUpstream(s); } catch (e) { console.log(`FAIL initialize: ${e.message}`); process.exit(1); }
    const init = cache.initialize || {};
    note(true, `protocol ${s.upVersion}, server ${JSON.stringify(init.serverInfo || {})}, capabilities ${Object.keys(init.capabilities || {}).join(', ')}`);
    note(true, s.upId ? 'sessions: Mcp-Session-Id given (404 after a restart is handled)' : 'sessions: none (stateless server) - fine, nothing to reopen');
    const r = await upstreamPost({ jsonrpc: '2.0', id: 'probe-tools', method: 'tools/list' }, s, null, 15000);
    const reply = (r.messages || []).find(isResponse);
    const tools = reply && reply.result && reply.result.tools;
    note(Array.isArray(tools), `tools/list: ${Array.isArray(tools) ? tools.length + ' tools (' + tools.map((t) => t.name).slice(0, 6).join(', ') + ')' : 'HTTP ' + r.status}`);
    if (Array.isArray(tools)) saveCache({ lists: Object.assign({}, cache.lists, { 'tools/list': reply.result }) });
    const g = await new Promise((res) => {
      const q = http.request({ host: UP.hostname, port: UP.port || 80, path: UP.pathname + UP.search, method: 'GET', agent: false,
        headers: Object.assign({ Accept: 'text/event-stream' }, s.upId ? { 'Mcp-Session-Id': s.upId } : {}) }, (x) => { res(x.statusCode); x.destroy(); });
      q.on('error', () => res(0)); q.setTimeout(3000, () => q.destroy()); q.end();
    });
    note(g === 405, g === 405 ? 'GET stream: none (405), as the proxy assumes'
      : `GET stream: HTTP ${g} - the editor now offers server push; the proxy does not relay it yet (pushes arrive only inside calls)`);
    if (s.upId) deleteUpstream(s.upId);
    console.log(lines.join('\n'));
    console.log(bad.length ? `\n${bad.length} thing(s) to look at` : '\nPROBE OK - the editor behaves as the proxy assumes');
    setTimeout(() => process.exit(bad.length ? 1 : 0), 300);
  }

  return { handle, startHttp, startStdio, probe, statusJson, log };
}

/** `hub mcp-proxy [--stdio|--probe] ...`: the settings of the folder it was started in, then the chosen front. */
function serve(a, opts) {
  opts = opts || {};
  const env = opts.env || process.env;
  const cwd = opts.cwd || process.cwd();
  let cfg = null, s = Object.assign({}, DEFAULTS, { upstream: 'http://127.0.0.1:8000/mcp', project: '' }), ctx = {};
  try {
    cfg = C.load({ cwd, env });
    const match = C.profileFor(cfg, cwd);
    // The proxy is for the editor: outside a project folder the unreal profile's defaults apply.
    const profile = (match && match.profile) || cfg.profiles[(cfg.project && cfg.project.profile) || cfg.profile] || cfg.profiles.unreal || {};
    s = settings(cfg, profile, match);
    const { Store } = require('./store.cjs');
    ctx = { cfg, store: new Store(cfg.stateDir, { machine: cfg.id }), watch: s.watch };
    if (s.watch) W.remember(cfg, s.watch);
  } catch (e) {
    process.stderr.write(`mcp-proxy: hub config not loaded (${e && e.message}); relaying with defaults\n`);
    cfg = null; ctx = {};
  }
  const OPT = options(s, a, env, cfg);
  try { new URL(OPT.upstream); } catch (_) { process.stderr.write(`mcp-proxy: bad upstream URL ${OPT.upstream}\n`); process.exit(2); }
  const p = create(OPT, ctx);
  if (OPT.mode === 'stdio') p.startStdio(); else if (OPT.mode === 'probe') p.probe(); else p.startHttp();
  return p;
}

module.exports = { DEFAULTS, settings, options, create, serve, list, proxied, boardState, dir, SEED };
