// The hub side of every node (cfg.nodes): keeps its transport (the reverse ssh tunnel), probes it on demand, takes
// its chats' events and their holds of the node's machine resource. A node chat's hold is an ordinary lock file
// (mode "node-chat"), so the hub's scripts queue behind it and a queued node chat is an ordinary waiter.
'use strict';
const crypto = require('crypto');
const U = require('../util.cjs');
const C = require('../config.cjs');
const chats = require('../chats.cjs');
const roles = require('../roles.cjs');
const Q = require('../queue.cjs');
const H = require('../handover.cjs');
const { describe } = require('../store.cjs');

const PROBE_MIN_GAP_MS = 60e3;
const PROBE_VIEW_EVERY_MS = 5 * 60e3;
const NODE_WAITER_STALE_MS = 15e3;

module.exports = function createNodes(cfg, store, boardPort, onChange, opts) {
  opts = opts || {};
  const nodes = new Map();
  for (const n of cfg.nodes) {
    nodes.set(n.id, { cfg: n, key: n.resources[0].key, profile: cfg.profiles[n.profile] || {}, tunnel: { up: false, since: 0, pid: 0, error: '' },
      probing: false, lastProbeTry: 0, waiters: new Map(), transport: require('../transport/index.cjs').forNode(cfg, n) });
  }
  const changed = () => { try { onChange && onChange(); } catch (_) {} };

  // --- auth -------------------------------------------------------------------------------------------------
  /** The node a request comes from, or null. A node with a token must present it (Bearer). */
  function authNode(headers) {
    const id = C.safeId(headers['x-agent-hub-node'] || headers['x-hub-agent'] || '');
    const n = nodes.get(id);
    if (!n) return null;
    if (!n.cfg.token) return n; // no token configured: trusted as before (hub doctor warns)
    const m = String(headers.authorization || '').match(/^Bearer\s+(.+)$/);
    if (!m) return null;
    const a = Buffer.from(m[1]), b = Buffer.from(String(n.cfg.token));
    return a.length === b.length && crypto.timingSafeEqual(a, b) ? n : null;
  }

  // --- probes -----------------------------------------------------------------------------------------------
  async function probe(id, force) {
    const n = nodes.get(id);
    if (!n || n.probing) return;
    const last = roles.readProbe(cfg, id);
    if (!force && Date.now() - Math.max(n.lastProbeTry, (last && last.fetched) || 0) < PROBE_MIN_GAP_MS) return;
    n.probing = true; n.lastProbeTry = Date.now(); changed();
    const r = await n.transport.probe();
    roles.saveProbe(cfg, id, r.probe, r.error, 'board');
    n.probing = false;
    changed();
  }

  async function dump(id) {
    const n = nodes.get(id);
    const r = await n.transport.dump();
    for (const c of r.chats || []) {
      const cur = chats.read(cfg, c.session);
      if (!cur || Number(c.updated || 0) > Number(cur.updated || 0)) chats.update(cfg, c.session, Object.assign({}, c, { machine: id, node: id }));
    }
    // A hold whose chat finished while the tunnel was down.
    const lock = store.readLock(n.key);
    const c = lock && lock.mode === 'node-chat' && lock.node === id && chats.read(cfg, lock.session);
    if (c && (c.state === 'idle' || c.state === 'ended')) release(n, lock.session, 'chat finished while the tunnel was down');
    changed();
  }

  // --- holds by node chats --------------------------------------------------------------------------------------
  const tokenOf = (n, sid) => `node-${n.cfg.id}-${String(sid).replace(/[^A-Za-z0-9]/g, '').slice(0, 12)}`;
  const chatName = (n, c) => `${n.cfg.label || n.cfg.id}: ${c.title || c.project || String(c.session).slice(0, 8)}`;

  function record(n, c, note) {
    return {
      token: tokenOf(n, c.session), mode: 'node-chat', chat: chatName(n, c), session: c.session || '', agent: c.agent || '',
      hostSession: c.hostSession || '', pid: 0, script: `chat on ${n.cfg.id}`, note: note || '', command: U.clip(c.command, 160),
      machine: n.cfg.id, node: n.cfg.id, ttlMin: n.profile.holdTtlMin || cfg.holdTtlMin || 60, by: 'node',
    };
  }

  function hold(n, body) {
    if (!body.session) return { ok: false, holder: 'no session' };
    saveChat(n, body);
    const token = tokenOf(n, body.session);
    const rec = record(n, body, body.tool);
    let w = n.waiters.get(token);
    const me = { token, mode: 'node-chat', since: w ? w.since : Date.now() };
    const r = store.tryTake(n.key, rec, {
      isMine: l => l.token === token,
      passPresence: true, // the person's presence at this very machine does not stop the chats they run there
      ahead: () => Q.ahead(store.readWaiters(n.key), me, cfg),
    });
    if (r.ok) {
      if (r.reentrant) store.refresh(n.key, token);
      if (w) { n.waiters.delete(token); store.dropWaiter(n.key, token, 'GO'); }
      if (!r.reentrant && !r.presence) changed();
      return { ok: true, mine: !r.presence, presence: !!r.presence };
    }
    const holder = r.holder ? describe(r.holder) : r.why === 'queue' ? `${r.ahead.length} queued before (${r.ahead[0].chat || r.ahead[0].script})` : r.why;
    if (!w) { w = { since: me.since }; n.waiters.set(token, w); }
    w.last = Date.now();
    const ww = store.writeWaiter(n.key, Object.assign(rec, { since: w.since, ttlMin: 0, heartbeat: Date.now() }));
    if (ww.fresh) { store.log(`WAIT  ${n.key} by ${describe(ww.waiter)} behind ${holder}`); store.event('WAIT', ww.waiter, { behind: holder }); changed(); }
    return { ok: false, holder };
  }

  function release(n, sid, why) {
    const cur = store.readLock(n.key);
    if (!cur || cur.token !== tokenOf(n, sid)) return false;
    const r = require('../lock-client.cjs').release(cfg, store, n.key, cur.token, why);
    if (r.ok) changed();
    return r.ok;
  }

  function saveChat(n, body) {
    const f = Object.assign({}, body, { machine: n.cfg.id, node: n.cfg.id, received: Date.now() });
    delete f.tool;
    if (cfg.share && cfg.share.prompt === 'none') f.lastPrompt = '';
    return chats.update(cfg, body.session, f);
  }

  function onEvent(n, body) {
    if (!body.session) return { ok: false };
    const c = saveChat(n, body);
    if (body.event !== 'PostToolUse') chats.event(cfg, { session: body.session, title: c.title || '', agent: c.agent || '', event: body.event, state: c.state || '', machine: n.cfg.id });
    const token = tokenOf(n, body.session);
    const cur = store.readLock(n.key);
    const mine = !!(cur && cur.token === token);
    if (mine && (body.state === 'idle' || body.state === 'background' || body.state === 'ended')) release(n, body.session, `chat ${body.event}`);
    else if (mine) store.refresh(n.key, token);
    if (body.state === 'ended' || body.event === 'Stop') dropWaiter(n, token, 'LEAVE');
    changed();
    const after = store.readLock(n.key);
    const busy = after && !after.stale && after.token !== token && after.mode !== 'presence';
    return { ok: true, hub: cfg.label, holder: busy ? describe(after) : '', mine: !busy, waiters: store.readWaiters(n.key).length,
      asks: store.readAsks(n.key).filter(a => a.state === 'pending').length };
  }

  function dropWaiter(n, token, kind) {
    if (!n.waiters.has(token)) return;
    n.waiters.delete(token);
    store.dropWaiter(n.key, token, kind);
  }

  // Node chats that stopped asking (stopped, or the tunnel dropped) leave the queue.
  const sweepTimer = setInterval(() => {
    for (const n of nodes.values()) for (const [tok, w] of n.waiters) if (Date.now() - w.last > NODE_WAITER_STALE_MS) dropWaiter(n, tok, 'LEAVE');
  }, 5000);
  sweepTimer.unref();

  let viewers = 0;
  const viewTimer = setInterval(() => { if (viewers > 0) for (const id of nodes.keys()) probe(id, false); }, PROBE_VIEW_EVERY_MS);
  viewTimer.unref();

  const stops = [];
  if (!opts.noTunnels) {
    for (const n of nodes.values()) {
      if ((n.cfg.transport || 'ssh-reverse') !== 'ssh-reverse' || !n.cfg.tunnelPort) continue;
      stops.push(n.transport.tunnel(boardPort, st => {
        const wasUp = n.tunnel.up;
        n.tunnel = Object.assign({ since: Date.now() }, st);
        if (st.up && !wasUp) { probe(n.cfg.id, true); dump(n.cfg.id).catch(() => {}); }
        changed();
      }));
    }
  }

  return {
    ids: () => [...nodes.keys()],
    get: id => nodes.get(id),
    authNode,
    viewer(delta) { viewers = Math.max(0, viewers + delta); if (delta > 0) for (const id of nodes.keys()) probe(id, false); },
    probe(id) { if (!nodes.has(id)) return { ok: false, error: 'unknown node' }; probe(id, true); return { ok: true }; },
    hold, onEvent,
    stop() { clearInterval(sweepTimer); clearInterval(viewTimer); for (const s of stops) s(); },
    state() {
      return [...nodes.values()].map(n => {
        const p = roles.readProbe(cfg, n.cfg.id);
        const lock = store.readLock(n.key);
        const list = chats.list(cfg).filter(c => c.machine === n.cfg.id && chats.active(c))
          .sort((a, b) => Number(b.updated || 0) - Number(a.updated || 0))
          .map(c => ({ session: c.session, title: c.title || '', project: c.project || '', state: c.state || '', agent: c.agent || '', lastPrompt: c.lastPrompt || '', updated: c.updated }));
        const human = roles.humanBusy(cfg, n.cfg, p, {});
        return {
          id: n.cfg.id, label: n.cfg.label || n.cfg.id, detail: n.cfg.detail || '', roles: n.cfg.roles || [], key: n.key,
          transport: n.cfg.transport || 'ssh-reverse', tunnelPort: n.cfg.tunnelPort || 0, tunnel: n.tunnel, probing: n.probing,
          probe: p, human: human ? human.text : '', graceMin: (n.profile.busy || {}).graceMin || 0,
          presence: !!(lock && !lock.stale && lock.mode === 'presence'), insecure: !n.cfg.token, chats: list,
        };
      });
    },
  };
};
