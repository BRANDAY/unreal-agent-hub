// Handover requests: "may I take the machine you are sitting at?" (docs/HANDOVER.md).
// A resource is never taken from a person. A remote run that waits because of them queues AND asks:
//   ASK      <key>.ask.<token>.json, state "pending"; the board shows a banner with "Yes, take it" / "Not now"
//   GRANT    the person agreed: their presence mark is put aside (and comes back later); a busy probe no longer
//            stops this one waiter, for one run only
//   DECLINE  "not now": the run stays in the queue; asked again after askAgainMin (or never, askAgain: false)
//   CANCEL   the run stopped waiting: the request disappears
//   RETURN   the run that was let in has finished: "the machine is yours again", presence restored
'use strict';
const path = require('path');
const U = require('./util.cjs');
const notify = require('./notify.cjs');

function savedPresenceFile(store, key) { return path.join(store.dir, `${key}.presence.saved.json`); }

function hcfg(cfg) { return Object.assign({ ask: true, askAgainMin: 15, askAgain: true, restorePresence: true }, cfg.handover || {}); }

/** Creates or renews the request of waiter `w` for `key`. Returns the ask record. */
function ask(store, cfg, key, w, blockedBy) {
  const h = hcfg(cfg);
  const cur = store.readAsk(key, w.token);
  const now = Date.now();
  if (cur && cur.state === 'pending') {
    if (cur.blockedBy !== blockedBy) { cur.blockedBy = blockedBy; store.writeAsk(key, cur); }
    return cur;
  }
  if (cur && cur.state === 'granted') return cur;
  if (cur && cur.state === 'declined') {
    if (!h.askAgain || now - cur.declinedAt < h.askAgainMin * 60e3) return cur;
  }
  const rec = Object.assign({}, cur || {}, {
    token: w.token, state: 'pending', askedAt: now, since: (cur && cur.since) || w.since || now,
    chat: w.chat || '', session: w.session || '', agent: w.agent || '', machine: w.machine || '', node: w.node || '',
    script: w.script || '', note: w.note || '', command: U.clip(w.command, 160), ttlMin: w.ttlMin || 0,
    blockedBy, times: ((cur && cur.times) || 0) + 1,
  });
  store.writeAsk(key, rec);
  store.event('ASK', Object.assign({ resource: key }, rec), { blockedBy, times: rec.times });
  store.log(`ASK   ${key} by ${rec.chat || rec.script || rec.token}: ${blockedBy}`);
  notify.send(cfg, { kind: 'ask', key, ask: rec });
  return rec;
}

function pick(store, key, token) {
  const asks = store.readAsks(key).filter(a => a.state === 'pending' || a.state === 'declined');
  if (token) return asks.find(a => a.token === token) || null;
  return asks.sort((a, b) => a.since - b.since)[0] || null;
}

/** The person says "yes, take it". */
function grant(store, cfg, key, token, by) {
  const a = pick(store, key, token);
  if (!a) return { ok: false, error: 'no pending request for ' + key };
  const now = Date.now();
  const lock = store.readLock(key);
  if (lock && !lock.stale && lock.mode === 'presence') {
    // Put the presence mark aside; it comes back when the run is over and its TTL is not over yet.
    try { U.writeJson(savedPresenceFile(store, key), Object.assign({}, lock, { savedAt: now, grantedTo: a.token })); } catch (_) {}
    store.release(key, lock.token, `granted to ${a.chat || a.script || a.token}`);
  }
  Object.assign(a, { state: 'granted', grantedAt: now, grantedBy: by || '', until: now + (a.ttlMin || 180) * 60e3 });
  store.writeAsk(key, a);
  store.event('GRANT', Object.assign({ resource: key }, a), { by: by || '' });
  store.log(`GRANT ${key} to ${a.chat || a.script || a.token}${by ? ' (' + by + ')' : ''}`);
  return { ok: true, ask: a };
}

/** The person says "not now". */
function decline(store, cfg, key, token, by) {
  const a = pick(store, key, token);
  if (!a) return { ok: false, error: 'no pending request for ' + key };
  Object.assign(a, { state: 'declined', declinedAt: Date.now(), declinedBy: by || '' });
  store.writeAsk(key, a);
  store.event('DECLINE', Object.assign({ resource: key }, a), { by: by || '' });
  store.log(`DECLINE ${key} for ${a.chat || a.script || a.token}${by ? ' (' + by + ')' : ''}`);
  return { ok: true, ask: a, askAgainAt: hcfg(cfg).askAgain ? a.declinedAt + hcfg(cfg).askAgainMin * 60e3 : 0 };
}

function cancel(store, key, token) {
  const a = store.readAsk(key, token);
  if (!a) return false;
  store.dropAsk(key, token);
  if (a.state !== 'running') store.event('CANCEL', Object.assign({ resource: key }, a));
  return true;
}

function isGranted(store, key, token) {
  const a = store.readAsk(key, token);
  return !!(a && (a.state === 'granted' || a.state === 'running') && (!a.until || a.until > Date.now()));
}

function isPending(store, key, token) {
  const a = store.readAsk(key, token);
  return !!(a && a.state === 'pending');
}

/** The waiter got the resource: a granted request becomes "running" until the run frees it. */
function started(store, key, token) {
  const a = store.readAsk(key, token);
  if (!a) return;
  if (a.state === 'granted') { a.state = 'running'; a.startedAt = Date.now(); store.writeAsk(key, a); }
  else store.dropAsk(key, token); // the person closed their work meanwhile: nothing to give back
}

/** The run that a person let in has ended: tell them, and give their presence mark back. */
function returned(store, cfg, key, token, heldMs) {
  const a = store.readAsk(key, token);
  if (!a || (a.state !== 'running' && a.state !== 'granted')) return false;
  store.dropAsk(key, token);
  const h = hcfg(cfg);
  const saved = U.readJson(savedPresenceFile(store, key));
  let restored = false;
  if (saved && saved.grantedTo === token) {
    U.safeUnlink(savedPresenceFile(store, key));
    if (h.restorePresence && (!saved.expires || saved.expires > Date.now())) {
      const rec = Object.assign({}, saved, { token: U.newToken(), note: 'restored after a run' });
      for (const k of ['since', 'expires', 'stale', 'savedAt', 'grantedTo', 'resource']) delete rec[k];
      rec.ttlMin = Math.max(1, Math.round(((saved.expires || Date.now() + 60e3) - Date.now()) / 60e3));
      restored = store.tryTake(key, rec, {}).ok;
    }
  }
  store.event('RETURN', Object.assign({ resource: key }, a), { heldMs: heldMs || 0, restored });
  store.log(`RETURN ${key} after ${a.chat || a.script || a.token} (${Math.round((heldMs || 0) / 60e3)} min)${restored ? ', presence restored' : ''}`);
  notify.send(cfg, { kind: 'return', key, ask: a, heldMs, restored });
  return true;
}

/** Board housekeeping: requests whose waiter is gone are cancelled; finished runs are returned. */
function sweep(store, cfg, keys) {
  for (const key of keys) {
    const waiters = new Set(store.readWaiters(key).map(w => w.token));
    const lock = store.readLock(key);
    for (const a of store.readAsks(key)) {
      const holding = lock && lock.token === a.token && !lock.stale;
      if ((a.state === 'running' || (a.state === 'granted' && !waiters.has(a.token))) && !holding) {
        returned(store, cfg, key, a.token, a.startedAt ? Date.now() - a.startedAt : 0);
      } else if ((a.state === 'pending' || a.state === 'declined') && !waiters.has(a.token)) {
        cancel(store, key, a.token);
      } else if (a.state === 'declined') {
        // Ask again when the pause is over (only the waiter itself renews it; this keeps the board honest).
      }
    }
  }
}

module.exports = { ask, grant, decline, cancel, isGranted, isPending, started, returned, sweep, savedPresenceFile };
