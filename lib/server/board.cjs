// The board: http://127.0.0.1:<port> (HTTP + Server-Sent Events, no dependencies). It reads the state folder,
// keeps the nodes' tunnels and serves the page in web/. It listens on 127.0.0.1 only and answers only requests
// whose Host is one of its own addresses (its port, and every node's tunnel port), against DNS rebinding.
// Page actions are POSTs with the X-Agent-Hub header (a page from another origin cannot send it without a CORS
// preflight this server never answers); node agents use their id and token instead. See docs/SECURITY.md.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const U = require('../util.cjs');
const C = require('../config.cjs');
const Q = require('../queue.cjs');
const H = require('../handover.cjs');
const chats = require('../chats.cjs');
const notify = require('../notify.cjs');
const presence = require('../presence.cjs');
const { Store, describe } = require('../store.cjs');

const WEB = path.join(C.PKG_ROOT, 'web');
const HISTORY_MS = 24 * 3600e3;
const RECENT_MS = 48 * 3600e3;
// Chats closed (process gone, session ended, archived) longer ago than this are flagged `old`: the page hides them
// behind a switch, and /state?live=1 leaves them out.
const CLOSED_KEEP_MS = 6 * 3600e3;
const LANGS = ['en', 'de', 'fr', 'it', 'es', 'ru'];
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff' };

function readJsonl(file, since) {
  let text = '';
  try {
    const fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 4 * 1024 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    text = buf.toString('utf8');
  } catch (_) { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { const e = JSON.parse(line); e.ms = Number(e.t) || Date.parse(e.t); if (e.ms >= since) out.push(e); } catch (_) {}
  }
  return out.sort((a, b) => a.ms - b.ms);
}

function createBoard(cfg, opts) {
  opts = opts || {};
  const port = opts.port || cfg.port;
  const store = new Store(cfg.stateDir, { machine: cfg.id });
  let tickTimer = null;
  const later = () => { clearTimeout(tickTimer); tickTimer = setTimeout(tick, 150); };
  const nodes = require('./nodes.cjs')(cfg, store, port, later, { noTunnels: opts.noTunnels });

  const allowedHosts = new Set();
  for (const h of ['127.0.0.1', 'localhost', '[::1]']) {
    allowedHosts.add(`${h}:${port}`);
    for (const n of cfg.nodes) if (n.tunnelPort) allowedHosts.add(`${h}:${n.tunnelPort}`);
  }
  for (const h of (cfg.board && cfg.board.allowHosts) || []) allowedHosts.add(String(h).toLowerCase());
  const hostOk = h => allowedHosts.has(String(h || '').toLowerCase());
  const originOk = o => !o || [...allowedHosts].some(h => o === `http://${h}` || o === `https://${h}`);

  // --- state ------------------------------------------------------------------------------------------------
  function lockHistory(resources) {
    const evs = readJsonl(path.join(cfg.stateDir, 'events.jsonl'), Date.now() - HISTORY_MS);
    const open = new Map(), out = [];
    const close = (token, ms, how) => {
      for (const k of ['hold:' + token, 'wait:' + token]) {
        const iv = open.get(k);
        if (iv && (how !== 'TAKE' || k.startsWith('wait:'))) { iv.end = ms; iv.how = how; open.delete(k); }
      }
    };
    for (const e of evs) {
      const base = { res: e.res, chat: e.chat || '', session: e.session || '', script: e.script || '', note: e.note || '', mode: e.mode || '', agent: e.agent || '', token: e.token };
      if (e.kind === 'TAKE') { close(e.token, e.ms, 'TAKE'); const iv = Object.assign({ kind: 'hold', start: e.ms, end: null }, base); open.set('hold:' + e.token, iv); out.push(iv); }
      else if (e.kind === 'WAIT') { const iv = Object.assign({ kind: 'wait', start: e.ms, end: null }, base); open.set('wait:' + e.token, iv); out.push(iv); }
      else if (['FREE', 'BREAK', 'GO', 'LEAVE'].includes(e.kind)) close(e.token, e.ms, e.kind);
      else if (['ASK', 'GRANT', 'DECLINE', 'RETURN'].includes(e.kind)) out.push(Object.assign({ kind: e.kind.toLowerCase(), start: e.ms, end: e.ms }, base));
    }
    const live = new Set();
    for (const r of resources) {
      if (r.lock && !r.lock.stale && r.lock.token) live.add(r.lock.token);
      for (const w of r.waiters) live.add(w.token);
    }
    for (const iv of open.values()) {
      if (live.has(iv.token)) continue;
      const next = evs.find(e => e.res === iv.res && e.ms > iv.start);
      iv.end = next ? next.ms : iv.start + 1000;
      iv.how = 'lost';
    }
    return out;
  }

  // Chat intervals: working (a prompt until the turn ends), background (the turn ended with work still running),
  // owner (waiting for a person). An event of the same kind continues the current interval.
  function chatHistory() {
    const evs = readJsonl(path.join(cfg.stateDir, 'chats.jsonl'), Date.now() - HISTORY_MS);
    const cur = new Map(), out = [];
    for (const e of evs) {
      const kind = e.event === 'UserPromptSubmit' || e.state === 'working' ? 'working' : e.state === 'needs-owner' ? 'owner' : e.state === 'background' ? 'background' : null;
      const prev = cur.get(e.session);
      if (prev && prev.kind === kind && e.event !== 'UserPromptSubmit') continue;
      if (prev) { prev.end = e.ms; cur.delete(e.session); }
      if (kind) { const iv = { session: e.session, title: e.title || '', kind, start: e.ms, end: null }; cur.set(e.session, iv); out.push(iv); }
    }
    return out;
  }

  function logTail(n) {
    try { return fs.readFileSync(path.join(cfg.stateDir, 'log.txt'), 'utf8').trimEnd().split(/\r?\n/).slice(-n).reverse(); } catch (_) { return []; }
  }

  function buildState(bopts) {
    const now = Date.now();
    const liveOnly = !!(bopts && bopts.live);
    const resources = C.allResources(cfg).map(r => {
      const lock = store.readLock(r.key);
      const waiters = Q.order(store.readWaiters(r.key), cfg, now).map(w => ({
        token: w.token, mode: w.mode, chat: w.chat || '', session: w.session || '', agent: w.agent || '', script: w.script || '',
        note: w.note || '', since: w.since, machine: w.machine || '', blocked: Q.isBlocked(w, now) ? w.blocked : '',
        priority: Q.effectivePriority(w, cfg, now),
      }));
      const asks = store.readAsks(r.key);
      return { key: r.key, id: r.id, label: r.label || r.id, icon: r.icon || '', color: r.color || '', scope: r.scope, project: r.project || '',
        projectLabel: r.projectLabel || r.project || '', node: r.node || '', ttlMin: r.ttlMin, lock, waiters, asks };
    });
    const desk = new Map();
    for (const d of require('../adapters/claude-desktop.cjs').recent(RECENT_MS)) if (d.session) desk.set(d.session, d);
    const T = require('../adapters/claude-transcripts.cjs');
    const subagents = [], cloud = [];
    let hidden = 0;
    const sessions = chats.list(cfg).filter(c => now - Number(c.updated || 0) < RECENT_MS).map(c => {
      const d = desk.get(c.session) || {};
      let state = c.state || 'unknown';
      const local = !c.machine || c.machine === cfg.id;
      if (c.ownerPid && local && !U.pidAlive(c.ownerPid) && state !== 'ended') state = 'gone';
      const holds = resources.filter(r => r.lock && !r.lock.stale && r.lock.session === c.session).map(r => r.key);
      const waits = resources.filter(r => r.waiters.some(w => w.session === c.session)).map(r => r.key);
      const title = d.title || c.title || '';
      const hostSession = d.hostSession || c.hostSession || '';
      const busy = state === 'background' || state === 'working';
      // Subagents and cloud sessions: Claude Code chats of this machine only (their files live here).
      let subs = [];
      if ((c.agent || 'claude') === 'claude' && local) {
        const alive = state !== 'gone' && state !== 'ended';
        subs = T.subagentsOf({ session: c.session, transcript: c.transcript, cwd: d.cwd || c.cwd, state, background: c.background }, alive, { home: opts.claudeHome });
        for (const a of subs) subagents.push(Object.assign(a, { chat: title, hostSession, machine: c.machine || cfg.id }));
        for (const x of T.cloudOf(Object.assign({}, c, { cwd: d.cwd || c.cwd }), d, { state, home: opts.claudeHome })) {
          cloud.push(Object.assign(x, { parentSession: c.session, parentTitle: title, hostSession }));
        }
      }
      const last = Math.max(Number(c.updated || 0), d.lastActivity || 0);
      const out = {
        session: c.session, hostSession, title, agent: c.agent || 'claude',
        machine: c.machine || cfg.id, project: c.project || '', archived: !!d.archived, state, holds, waits,
        last, lastPrompt: c.lastPrompt || '', lastReply: c.lastReply || '',
        notice: c.notice || '', parent: d.parent || c.parent || '', cwd: c.cwd || '', waitingFor: c.waitingFor || '',
        background: busy ? (c.background || []) : [], subagents: subs.filter(a => a.running).length,
        started: Number(c.started) || d.created || 0,
      };
      out.old = (state === 'gone' || state === 'ended' || out.archived) && now - last > CLOSED_KEEP_MS;
      if (out.old) hidden++;
      return out;
    }).filter(s => !(liveOnly && s.old)).sort((a, b) => b.last - a.last);
    const asks = [];
    for (const r of resources) for (const a of r.asks) asks.push(Object.assign({ key: r.key, label: r.label, node: r.node }, a));
    return {
      at: now, name: cfg.name || 'Unreal Agent Hub', lang: cfg.lang || 'en', langs: LANGS,
      hub: { id: cfg.id, label: cfg.label, roles: cfg.roles, port, operatorAt: (cfg.operator && cfg.operator.at) || cfg.id },
      handover: { askAgainMin: cfg.handover.askAgainMin },
      resources, nodes: nodes.state(), sessions, hidden, asks, notices: notify.recent(cfg, 30 * 60e3), log: logTail(30),
      subagents: subagents.sort((a, b) => (b.running - a.running) || b.last - a.last),
      cloud: cloud.sort((a, b) => (b.started || 0) - (a.started || 0)),
      history: { locks: lockHistory(resources), chats: chatHistory() },
    };
  }

  // --- push -------------------------------------------------------------------------------------------------
  const clients = new Set();
  let lastJson = '';
  function tick() {
    try { H.sweep(store, cfg, C.allResources(cfg).map(r => r.key)); } catch (_) {}
    let json;
    try { json = JSON.stringify(buildState()); } catch (e) { json = JSON.stringify({ error: String(e && e.stack || e) }); }
    if (json === lastJson) return;
    lastJson = json;
    for (const res of clients) res.write(`data: ${json}\n\n`);
  }
  const timers = [setInterval(tick, 2000), setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 15000)];

  // Watchdogs (lib/watch.cjs): every 30 s, for each project the hooks remembered with a `watch.start`, start its app
  // again when a chat closed it or it crashed. UAH_WATCH=0 or opts.noWatch turns them off.
  if (!opts.noWatch && process.env.UAH_WATCH !== '0') {
    const W = require('../watch.cjs');
    const dogs = new Map();
    timers.push(setInterval(() => {
      for (const w of W.list(cfg)) {
        if (!w.start) continue;
        const sig = JSON.stringify(w);
        if (!dogs.has(w.project) || dogs.get(w.project).sig !== sig) dogs.set(w.project, { sig, tick: W.makeWatchdog(cfg, store, w, line => store.log(`WATCH ${line}`)) });
        dogs.get(w.project).tick().catch(e => store.log(`WATCH ${w.project}: error ${e && e.message}`));
      }
    }, opts.watchMs || 30000));
  }
  let watcher = null;
  try { fs.mkdirSync(cfg.stateDir, { recursive: true }); watcher = fs.watch(cfg.stateDir, later); } catch (_) {}

  // --- actions --------------------------------------------------------------------------------------------------
  function readBody(req, limit) {
    return new Promise(resolve => {
      let d = '';
      req.on('data', c => { d += c; if (d.length > (limit || 8192)) req.destroy(); });
      req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch (_) { resolve({}); } });
    });
  }

  function keyOf(body) {
    const k = String(body.key || body.res || '');
    if (C.allResources(cfg).some(r => r.key === k)) return k;
    return presence.machineKey(cfg, body.node || body.machine || '') || '';
  }

  function action(url, body, by) {
    switch (url) {
      case '/api/break': {
        const key = keyOf(body);
        if (!key) return { ok: false, error: 'unknown resource' };
        const lock = store.readLock(key);
        if (!lock) return { ok: false, error: 'the lock is already gone' };
        if (lock.token !== body.token) return { ok: false, error: 'the lock has changed - reload' };
        if (!lock.stale) return { ok: false, error: 'the lock is live: only `hub break --force` removes a live lock' };
        const r = store.breakStale(key, body.token, by);
        return r.ok ? { ok: true } : { ok: false, error: r.error };
      }
      case '/api/open': return require('../adapters/claude-desktop.cjs').openChat(body.hostSession);
      case '/api/node/probe': return nodes.probe(C.safeId(body.node));
      case '/api/presence': return presence.here(cfg, store, body.node || body.machine, !!body.on, { by });
      case '/api/grant': { const key = keyOf(body); return key ? H.grant(store, cfg, key, body.token, by) : { ok: false, error: 'unknown resource' }; }
      case '/api/decline': { const key = keyOf(body); return key ? H.decline(store, cfg, key, body.token, by) : { ok: false, error: 'unknown resource' }; }
      default: return null;
    }
  }

  async function api(req, res) {
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
    if (req.method !== 'POST') return send(405, { ok: false, error: 'POST only' });
    const url = req.url.split('?')[0];
    if (url.startsWith('/api/node/') && url !== '/api/node/probe') {
      const n = nodes.authNode(req.headers);
      if (!n) return send(401, { ok: false, error: 'unknown node or bad token' });
      const body = await readBody(req, 32768);
      let out;
      if (url === '/api/node/event') out = nodes.onEvent(n, body);
      else if (url === '/api/node/hold') out = nodes.hold(n, body);
      else if (url === '/api/node/state') out = Object.assign({ ok: true }, buildState());
      else if (url === '/api/node/probe-push') { require('../roles.cjs').saveProbe(cfg, n.cfg.id, Object.assign(body, { pushed: true }), '', 'node'); out = { ok: true }; }
      else if (['/api/node/grant', '/api/node/decline', '/api/node/presence'].includes(url)) {
        out = action(url.replace('/node', ''), Object.assign({ node: body.node || n.cfg.id }, body), `node ${n.cfg.id}`);
      } else return send(404, { ok: false, error: 'no such action' });
      later();
      return send(200, out);
    }
    if (req.headers['x-agent-hub'] !== '1' || !originOk(req.headers.origin)) return send(403, { ok: false, error: 'forbidden' });
    const body = await readBody(req);
    const out = action(url, body, 'board');
    if (!out) return send(404, { ok: false, error: 'no such action' });
    if (opts.log !== false) console.log(`${new Date().toISOString()} ${url} ${JSON.stringify(body)} -> ${JSON.stringify(out)}`);
    if (out.ok) later();
    send(out.ok ? 200 : 409, out);
  }

  function serveFile(res, rel) {
    const file = path.normalize(path.join(WEB, rel));
    if (!file.startsWith(WEB)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end(); }
      const immutable = rel.startsWith('assets/');
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': immutable ? 'max-age=31536000, immutable' : 'no-cache',
        'X-Content-Type-Options': 'nosniff' });
      res.end(data);
    });
  }

  const server = http.createServer((req, res) => {
    if (!hostOk(req.headers.host)) { res.writeHead(421, { 'Content-Type': 'text/plain' }); return res.end('Misdirected request: unknown Host'); }
    const url = req.url.split('?')[0];
    if (url.startsWith('/api/')) return api(req, res);
    if (url === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      clients.add(res);
      nodes.viewer(+1);
      if (!lastJson) tick();
      res.write(`data: ${lastJson}\n\n`);
      req.on('close', () => { clients.delete(res); nodes.viewer(-1); });
      return;
    }
    if (url === '/state') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(buildState({ live: /[?&]live=1(&|$)/.test(req.url) }), null, 2));
    }
    if (url === '/' || url === '/index.html') return serveFile(res, 'index.html');
    // The page is a Vite build (web-src/ -> web/index.html + web/assets/<name>-<hash>.js|css).
    if (/^\/(favicon\.svg|i18n\/[a-z]{2}\.json|assets\/[\w.-]+\.(js|css|svg|png|woff2?))$/.test(url)) return serveFile(res, url.slice(1));
    res.writeHead(404); res.end();
  });

  return {
    server, store, nodes, buildState, tick,
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => resolve(port));
      });
    },
    close() {
      for (const t of timers) clearInterval(t);
      if (watcher) watcher.close();
      nodes.stop();
      for (const c of clients) try { c.end(); } catch (_) {}
      return new Promise(r => server.close(() => r()));
    },
  };
}

module.exports = { createBoard, LANGS };
