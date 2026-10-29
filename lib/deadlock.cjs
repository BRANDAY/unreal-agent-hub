// Deadlocks between waiters, found the way PostgreSQL's lock manager finds them (src/backend/storage/lmgr/README,
// deadlock.c): a waiter looks every few seconds for a cycle in the wait-for graph
//   waiter -> the take in its way -> the waiter that owns that take -> ... -> the first waiter again.
// A waiter "owns" a take when it works under it: the take's token is in its `holds` (UAH_TOKEN_* of a parent
// script), it is the same process (a script lock), or it is the same chat (a hold). An edge is HARD when a holder is
// in the way and SOFT when only the queue order is (a shared reader behind a whole take that waits). A cycle with a
// soft edge is broken by letting that reader go first (PostgreSQL rearranges its wait queue the same way: JUMP in the
// log); a cycle of hard edges only by one waiter giving up - the youngest, with the whole cycle named (DEADLOCK).
// Seen in practice: a chat held one cook place and its run waited for the laptop; another chat's run held the laptop
// and waited for a cook place behind a package that needed every cook place - three chats stood still for 41 min.
// Optional `lockOrder` (resource ids in the order chains should take them, lockdep's idea): waiting for one while
// holding a later one is said once, on the first wait.
'use strict';
const fs = require('fs');
const C = require('./config.cjs');
const Q = require('./queue.cjs');

const DEFAULTS = { checkSec: 10, jumpWaitSec: 30, anySec: 120, maxDepth: 16 };

function settings(cfg) { return Object.assign({}, DEFAULTS, (cfg && cfg.deadlock) || {}); }

/** The tokens a process works under: UAH_TOKEN_* in its environment (set by its own or a parent's take). */
function heldTokens(env, except) {
  const out = [];
  for (const [k, v] of Object.entries(env || process.env)) if (k.startsWith('UAH_TOKEN_') && v && v !== except) out.push(v);
  return out;
}

/** Every live take (one per token, with its place count) and every live waiter, on every resource of the store. */
function graph(cfg, store) {
  const slots = new Map();
  try { for (const r of C.allResources(cfg)) slots.set(r.key, r.slots || 1); } catch (_) {}
  const g = { holders: new Map(), waiters: [], slots, cfg };
  for (const key of store.keys()) {
    const takes = new Map();
    for (const l of store.readLocks(key)) {
      if (!l || l.stale || l.unreadable) continue;
      if (!takes.has(l.token)) takes.set(l.token, { lock: l, places: 0 });
      takes.get(l.token).places++;
      if (!slots.has(key) && Number(l.slots) > 1) slots.set(key, Number(l.slots));
    }
    g.holders.set(key, [...takes.values()]);
  }
  let names = [];
  try { names = fs.readdirSync(store.dir); } catch (_) {}
  const keys = new Set();
  for (const n of names) { const i = n.indexOf('.wait.'); if (i > 0 && n.endsWith('.json')) keys.add(n.slice(0, i)); }
  for (const key of keys) for (const w of store.readWaiters(key)) g.waiters.push(Object.assign({ resource: key }, w));
  return g;
}

/** Is `lock` taken by (or for) the waiter `w`: a token it works under, its own process, or a hold of its chat. */
function owns(w, lock) {
  if (!w || !lock) return false;
  if ((w.holds || []).includes(lock.token)) return true;
  const isHold = lock.mode === 'hold' || lock.mode === 'node-chat';
  const sameMachine = (lock.machine || '') === (w.machine || '');
  if (!isHold && sameMachine && Number(lock.pid) && Number(lock.pid) === Number(w.pid)
    && (!lock.pidStart || !w.pidStart || Number(lock.pidStart) === Number(w.pidStart))) return true;
  return isHold && !!lock.session && lock.session === w.session;
}

/**
 * Whom the waiter `w` waits for: the waiters owning the takes in its way (hard) and the waiters the queue serves
 * before it (soft). A shared reader with a free place waits only for those the queue lets go first.
 */
function edges(g, w) {
  const key = w.resource;
  const holders = g.holders.get(key) || [];
  if (holders.some(h => owns(w, h.lock))) return [];
  const slots = g.slots.get(key) || 1;
  const used = holders.reduce((n, h) => n + h.places, 0);
  const free = Math.max(0, slots - used);
  const queued = g.waiters.filter(x => x.resource === key);
  const shared = !!w.shared && slots > 1;
  const ahead = Q.aheadForPlaces(Q.ahead(queued, w, g.cfg), { shared }, free);
  const hard = shared && free > 0 ? [] : holders;
  const out = [];
  for (const h of hard) for (const o of g.waiters) if (o.token !== w.token && owns(o, h.lock)) out.push({ to: o, kind: 'hard', res: key, lock: h.lock });
  for (const a of ahead) out.push({ to: a, kind: 'soft', res: key, lock: null });
  return out;
}

/** The steps of a cycle from the waiter with `token` back to it, or null. */
function findCycle(g, token, maxDepth) {
  const me = g.waiters.find(w => w.token === token);
  if (!me) return null;
  const depthMax = maxDepth || DEFAULTS.maxDepth;
  const seen = new Set([token]);
  const walk = (node, depth) => {
    if (depth > depthMax) return null;
    for (const e of edges(g, node)) {
      const step = { from: node, to: e.to, kind: e.kind, res: e.res, lock: e.lock };
      if (e.to.token === token) return [step];
      if (seen.has(e.to.token)) continue;
      seen.add(e.to.token);
      const rest = walk(e.to, depth + 1);
      if (rest) return [step, ...rest];
    }
    return null;
  };
  return walk(me, 0);
}

/** A shared reader held back only by the queue order (every edge soft): letting it go first breaks the cycle. */
function canJump(g, w) {
  if (!w || !w.shared) return false;
  const es = edges(g, w);
  return es.length > 0 && es.every(e => e.kind === 'soft');
}

function who(x) {
  const name = x.chat ? `chat "${x.chat}"` : x.session ? `session ${x.session}` : 'a process outside an agent';
  return `${name} (${x.script || x.mode || 'script'} pid ${x.pid || 0})`;
}

/** The cycle in one line (English, for the log and the error). */
function format(cycle) {
  return cycle.map(s => `${who(s.from)} waits for ${s.res}, ${s.kind === 'hard' ? `held by ${who(s.lock)}` : `queued behind ${who(s.to)}`}`)
    .join(' -> ') + ' -> the first again';
}

/**
 * What the waiter `token` should do about a cycle it is in: {cycle: null} when there is none, else
 * {cycle, text, jump: true} when it may go first, {giveUp: true} when it is the one to give up, or {wait: true}.
 * `since` is when this waiter first saw the cycle (ms).
 */
function decide(g, token, since, cfg, now) {
  const s = settings(cfg);
  const cycle = findCycle(g, token, s.maxDepth);
  if (!cycle) return { cycle: null };
  const text = format(cycle);
  const me = g.waiters.find(w => w.token === token);
  if (canJump(g, me)) return { cycle, text, jump: true };
  const members = cycle.map(x => x.from);
  const jumpers = members.filter(m => m.dl && canJump(g, m));
  const victims = members.filter(m => m.dl).sort((a, b) => Number(b.since) - Number(a.since));
  const mine = victims.length > 0 && victims[0].token === token;
  const age = ((now || Date.now()) - since) / 1000;
  if ((age >= s.jumpWaitSec || !jumpers.length) && (mine || age >= s.anySec)) return { cycle, text, giveUp: true };
  return { cycle, text, wait: true };
}

/** "holds b, c and waits for a" when `lockOrder` puts a before b and c, else null. */
function orderWarning(g, w, cfg) {
  const order = (cfg && cfg.lockOrder) || [];
  if (!order.length) return null;
  const idOf = key => String(key).replace(/^.*~/, '');
  const want = order.indexOf(idOf(w.resource));
  if (want < 0) return null;
  const later = [];
  for (const [key, takes] of g.holders) {
    const at = order.indexOf(idOf(key));
    if (at > want && takes.some(h => owns(w, h.lock))) later.push(idOf(key));
  }
  return later.length ? { later, want: idOf(w.resource), order } : null;
}

module.exports = { DEFAULTS, settings, heldTokens, graph, owns, edges, findCycle, canJump, decide, format, orderWarning, who };
