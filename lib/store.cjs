// The lock store: one folder of small JSON files, the single source of truth. The protocol is described in
// docs/PROTOCOL.md so that clients in any language are equal; it needs no mutex, only three atomic file
// operations every OS has: create-if-absent (link / O_EXCL), rename, and link-back-without-overwrite.
//
//   <key>.json                  the lock (absent = free); place 1 of a resource with places (`slots` > 1)
//   <key>.<n>.json              place n (2..slots) of such a resource: a shared take holds one place, a whole
//                               take holds all of them under one token
//   <key>.wait.<token>.json     one waiter in the queue
//   <key>.ask.<token>.json      a handover request to a person ("may I take your machine?")
//   <key>.json.aside-<pid>-<r>  a lock moved aside while it is checked before removal (lives milliseconds)
//   events.jsonl                TAKE WAIT GO FREE BREAK LEAVE ASK GRANT DECLINE CANCEL RETURN CONFLICT, tied by token
//   log.txt                     the same for people
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const U = require('./util.cjs');
const { msg, say } = require('./i18n.cjs');

const UNREADABLE_GRACE_MS = 10e3;
const WAITER_HEARTBEAT_MS = 20e3;
const ASIDE_FRESH_MS = 5e3;

class Store {
  /** @param {string} dir state folder  @param {{machine?: string}} [opts] */
  constructor(dir, opts) {
    this.dir = dir;
    this.machine = (opts && opts.machine) || U.hostname();
    fs.mkdirSync(dir, { recursive: true });
  }

  lockFile(key) { return path.join(this.dir, `${key}.json`); }
  waiterFile(key, token) { return path.join(this.dir, `${key}.wait.${token}.json`); }
  askFile(key, token) { return path.join(this.dir, `${key}.ask.${token}.json`); }

  // --- journal ----------------------------------------------------------------------------------------------
  event(kind, rec, extra) {
    if (!rec) return;
    const e = Object.assign({
      t: Date.now(), kind, res: rec.resource, token: rec.token, mode: rec.mode || '', chat: rec.chat || '',
      session: rec.session || '', agent: rec.agent || '', pid: rec.pid || 0, script: rec.script || '',
      note: rec.note || '', machine: rec.machine || '', node: rec.node || '',
    }, extra || {});
    U.appendLine(path.join(this.dir, 'events.jsonl'), JSON.stringify(e));
  }
  log(line) { U.appendLine(path.join(this.dir, 'log.txt'), `${U.stamp()} ${line}`); }

  // --- reading ------------------------------------------------------------------------------------------------
  /**
   * The lock of `key` with `.stale` (a reason or null), or null when free. For a resource with places: the first
   * live place (or the first stale one), so a gate or a status line sees a holder whichever place they hold.
   */
  readLock(key) {
    const first = this._readPlace(key);
    if (first && !first.stale) return first;
    const all = this.readLocks(key);
    return all.find(l => !l.stale) || all[0] || null;
  }

  /** Every place of `key` that has a lock file, in place order, each with `.place` (1-based). */
  readLocks(key) {
    return this.placeKeys(key).map(pk => {
      const l = this._readPlace(pk);
      if (l) l.place = placeOf(key, pk);
      return l;
    }).filter(Boolean);
  }

  /** The place keys of `key` present on disk: `key` itself and `key.<n>`. */
  placeKeys(key) {
    let names = [];
    try { names = fs.readdirSync(this.dir); } catch (_) { return []; }
    const re = new RegExp(`^${escapeRe(key)}(?:\\.(\\d+))?\\.json$`);
    return names.map(n => re.exec(n)).filter(Boolean)
      .sort((a, b) => Number(a[1] || 1) - Number(b[1] || 1)).map(m => (m[1] ? `${key}.${m[1]}` : key));
  }

  _readPlace(key) {
    const file = this.lockFile(key);
    let st;
    try { st = fs.statSync(file); } catch (_) { return null; }
    const lock = U.readJson(file);
    if (!lock) {
      const old = Date.now() - st.mtimeMs > UNREADABLE_GRACE_MS;
      const m = old ? msg('stale.unreadable') : null;
      return { resource: key, unreadable: true, token: '', stale: m ? say(m) : null, staleMsg: m };
    }
    const m = this.staleMsg(lock);
    lock.stale = m ? say(m) : null;
    lock.staleMsg = m;
    return lock;
  }

  /** Why a lock no longer counts (§4 of docs/PROTOCOL.md), or null while it is live. */
  staleReason(lock, now) {
    const m = this.staleMsg(lock, now);
    return m ? say(m) : null;
  }

  /** staleReason() as a message {k, v} for the board, which renders it in the viewer's language. */
  staleMsg(lock, now) {
    now = now || Date.now();
    if (!lock) return null;
    if (Number(lock.expires) && Number(lock.expires) < now) return msg('stale.ttl', { min: lock.ttlMin });
    const local = !lock.machine || lock.machine === this.machine;
    if (!local) return null; // another machine's process: only its TTL can be judged from here
    if (lock.mode === 'script') {
      if (!U.sameProcessAlive(lock.pid, lock.pidStart)) return msg('stale.exited', { pid: lock.pid });
    } else if (lock.mode === 'hold') {
      if (lock.ownerPid && !U.sameProcessAlive(lock.ownerPid, lock.ownerPidStart)) return msg('stale.ended');
    }
    return null;
  }

  waiterAlive(w, now) {
    now = now || Date.now();
    if (w.heartbeat && now - Number(w.heartbeat) < WAITER_HEARTBEAT_MS) return true;
    const local = !w.machine || w.machine === this.machine;
    return !!(local && w.pid && U.sameProcessAlive(w.pid, w.pidStart));
  }

  /** Live waiters of `key` (dead ones older than a few seconds are removed). */
  readWaiters(key) {
    return this._scan(`${key}.wait.`).map(({ file, rec, mtime }) => {
      if (rec && this.waiterAlive(rec)) return rec;
      if (Date.now() - mtime > UNREADABLE_GRACE_MS) U.safeUnlink(file);
      return null;
    }).filter(Boolean);
  }

  readAsks(key) { return this._scan(`${key}.ask.`).map(x => x.rec).filter(Boolean); }

  _scan(prefix) {
    let names = [];
    try { names = fs.readdirSync(this.dir); } catch (_) { return []; }
    const out = [];
    for (const n of names) {
      if (!n.startsWith(prefix) || !n.endsWith('.json')) continue;
      const file = path.join(this.dir, n);
      let mtime = 0;
      try { mtime = fs.statSync(file).mtimeMs; } catch (_) { continue; }
      out.push({ file, rec: U.readJson(file), mtime });
    }
    return out;
  }

  // A lock of `key` is being checked aside by someone right now: do not create a new one in that window.
  _asideBusy(key) {
    const prefix = `${key}.json.aside-`;
    let names = [];
    try { names = fs.readdirSync(this.dir); } catch (_) { return false; }
    return names.some(n => {
      if (!n.startsWith(prefix)) return false;
      try { return Date.now() - fs.statSync(path.join(this.dir, n)).mtimeMs < ASIDE_FRESH_MS; } catch (_) { return false; }
    });
  }

  // --- writing ------------------------------------------------------------------------------------------------
  /**
   * Removes the lock of `key` only if `check(movedLock)` still agrees after it is moved aside atomically.
   * Otherwise the file is linked back without overwriting anything. Returns {ok, lock, error}.
   */
  removeIf(key, check) {
    const file = this.lockFile(key);
    const aside = `${file}.aside-${process.pid}-${U.rand(3)}`;
    try { fs.renameSync(file, aside); } catch (e) { return { ok: false, error: e.code === 'ENOENT' ? 'gone' : e.code }; }
    const moved = U.readJson(aside) || { resource: key, unreadable: true, token: '' };
    if (!moved.unreadable) { moved.staleMsg = this.staleMsg(moved); moved.stale = moved.staleMsg ? say(moved.staleMsg) : null; }
    if (check(moved)) { U.safeUnlink(aside); return { ok: true, lock: moved }; }
    // Not the lock we meant: put it back. link() never overwrites. Takers do not create a lock while a fresh
    // aside file exists, so the name is normally still free here.
    try { fs.linkSync(aside, file); U.safeUnlink(aside); return { ok: false, error: 'changed', lock: moved }; } catch (e) {
      if (e.code !== 'EEXIST' && !fs.existsSync(file)) {
        try { fs.renameSync(aside, file); return { ok: false, error: 'changed', lock: moved }; } catch (_) {}
      }
    }
    this.log(`CONFLICT ${key}: could not put back the lock of ${describe(moved, 'en')}; a new lock took its place`);
    this.event('CONFLICT', moved);
    U.safeUnlink(aside);
    return { ok: false, error: 'conflict', lock: moved };
  }

  /** Drops the lock of `key` (every place it holds) if it is still `token` and still stale. */
  breakStale(key, token, by) {
    return this._removeEach(key, l => (l.token || '') === (token || '') && !!l.stale, (lock) => {
      this.log(`BREAK ${key} from ${describe(lock, 'en')}: stale (${say(lock.staleMsg || lock.stale, 'en')})${by ? ', by ' + by : ''}`);
      this.event('BREAK', lock, { why: lock.stale, by: by || '' });
    });
  }

  /** Drops whatever lock `key` has, live or not, on every place or on one (`hub break --force [--place n]`). */
  forceBreak(key, by, place) {
    return this._removeEach(key, l => !place || Number(l.place || 1) === Number(place), (lock) => {
      this.log(`BREAK ${key} from ${describe(lock, 'en')}: by hand${by ? ' (' + by + ')' : ''}`);
      this.event('BREAK', lock, { why: 'forced', by: by || '' });
    });
  }

  /** Releases `key` if it is still held under `token` (all the places of a whole take). */
  release(key, token, why) {
    return this._removeEach(key, l => l.token === token, (lock) => {
      const min = ((Date.now() - Number(lock.since)) / 60e3).toFixed(1);
      this.log(`FREE  ${key} by ${describe(lock, 'en')} after ${min} min${why ? ' (' + why + ')' : ''}`);
      this.event('FREE', lock, { why: why || '', heldMs: Date.now() - Number(lock.since) });
    });
  }

  // removeIf() on every place of `key`; `done(lock)` once per lock (a whole take counts once, not per place).
  _removeEach(key, check, done) {
    const pks = this.placeKeys(key);
    if (!pks.length) return { ok: false, error: 'gone' };
    let first = null, last = null;
    const seen = new Set();
    for (const pk of pks) {
      // Read first: removeIf moves the file aside while it checks, and another holder's place must not leave its
      // name even for that moment (a taker could slip into it and one of the two locks would be lost).
      const cur = this._readPlace(pk);
      if (!cur || cur.unreadable) { last = last || { ok: false, error: cur ? 'unreadable' : 'gone' }; continue; }
      cur.place = placeOf(key, pk);
      if (!check(cur)) { last = { ok: false, error: 'changed', lock: cur }; continue; }
      const r = this.removeIf(pk, l => { l.place = placeOf(key, pk); return check(l); });
      last = r;
      if (!r.ok) continue;
      first = first || r;
      const id = r.lock.token || pk;
      if (!seen.has(id)) { seen.add(id); done(r.lock); }
    }
    return first || last;
  }

  /** Extends the TTL of a held lock (and merges fields) on every place it holds. Only the holder calls this. */
  refresh(key, token, fields) {
    let any = false;
    for (const pk of this.placeKeys(key)) {
      const cur = this._readPlace(pk);
      if (!cur || cur.token !== token) continue;
      const next = Object.assign({}, cur, fields || {});
      delete next.stale;
      delete next.staleMsg;
      delete next.place;
      if (next.ttlMin) next.expires = Date.now() + next.ttlMin * 60e3;
      try { U.writeJson(this.lockFile(pk), next); any = true; } catch (_) {}
    }
    return any;
  }

  /** How many of the `slots` places of `key` are free (no lock, or a stale one). */
  freePlaces(key, slots) {
    const n = Math.max(1, Number(slots) || 1);
    let free = 0;
    for (let i = 1; i <= n; i++) { const l = this._readPlace(placeKey(key, i)); if (!l || l.stale) free++; }
    return free;
  }

  /**
   * One attempt to take `key` for `rec` (a full lock record without since/expires).
   *   opts.isMine(lock)      the caller already holds it (re-entrant: nested scripts, a chat's own hold)
   *   opts.passPresence      a person's presence hold does not stop this caller (their own chats)
   *   opts.blocker()         returns a reason when something outside the store makes the resource busy
   *   opts.ahead()           the waiters that go first (lib/queue.cjs; default: no queue check)
   *   opts.slots, .shared    a resource with places: a shared take holds one free place, any other take all of them
   * Returns {ok:true, lock, reentrant?, presence?} or {ok:false, why, holder?, busy?, ahead?}.
   */
  tryTake(key, rec, opts) {
    opts = opts || {};
    const slots = Math.max(1, Number(opts.slots) || 1);
    const places = [];
    for (let i = 1; i <= slots; i++) places.push(placeKey(key, i));
    let cur = places.map(pk => this._readPlace(pk));
    const mine = cur.find(l => l && !l.unreadable && opts.isMine && opts.isMine(l));
    if (mine) return { ok: true, reentrant: true, lock: mine };
    if (cur.some(l => l && l.stale)) {
      cur.forEach((l, i) => { if (l && l.stale) this.removeIf(places[i], m => (m.token || '') === (l.token || '') && !!m.stale).ok && this._brokeStale(key, l, rec); });
      cur = places.map(pk => this._readPlace(pk));
    }
    const live = cur.filter(l => l && !l.stale);
    const presence = live.find(l => l.mode === 'presence');
    if (presence && opts.passPresence) return { ok: true, presence: true, lock: presence };
    const shared = !!opts.shared && slots > 1;
    const free = places.filter((pk, i) => !cur[i] || cur[i].stale);
    if (shared ? !free.length : live.length) {
      const holder = live[0];
      return { ok: false, why: holder.unreadable ? 'unreadable' : 'held', holder, holders: live };
    }
    if (free.some(pk => this._asideBusy(pk))) return { ok: false, why: 'breaking' };
    if (opts.blocker) {
      const busy = opts.blocker();
      if (busy) return { ok: false, why: 'busy', busy };
    }
    if (opts.ahead) {
      const ahead = opts.ahead();
      if (ahead && ahead.length) return { ok: false, why: 'queue', ahead };
    }
    const now = Date.now();
    const base = Object.assign({ v: 1, machine: this.machine }, rec, { resource: key, since: now,
      expires: rec.ttlMin ? now + rec.ttlMin * 60e3 : 0 }, slots > 1 ? { slots, shared } : {});
    let lock = null;
    if (shared) {
      // One free place, the lowest first; another taker may win a place between the read and the create.
      for (const pk of free) {
        const l = Object.assign({}, base, { place: placeOf(key, pk) });
        try { U.createExclusive(this.lockFile(pk), l); lock = l; break; } catch (e) { if (e.code !== 'EEXIST') throw e; }
      }
      if (!lock) return { ok: false, why: 'race' };
    } else {
      // Every place under one token; a place taken meanwhile undoes the ones created here.
      const made = [];
      for (const pk of places) {
        const l = slots > 1 ? Object.assign({}, base, { place: placeOf(key, pk) }) : base;
        try { U.createExclusive(this.lockFile(pk), l); made.push(pk); } catch (e) {
          for (const m of made) U.safeUnlink(this.lockFile(m));
          if (e.code === 'EEXIST') return { ok: false, why: 'race' };
          throw e;
        }
      }
      lock = base;
    }
    this.log(`TAKE  ${key} by ${describe(lock, 'en')}`);
    this.event('TAKE', lock, slots > 1 ? { place: lock.place || 0, slots } : undefined);
    return { ok: true, lock };
  }

  _brokeStale(key, lock, rec) {
    const by = rec.chat || rec.script || 'a waiter';
    this.log(`BREAK ${key} from ${describe(lock, 'en')}: stale (${say(lock.staleMsg || lock.stale, 'en')}), by ${by}`);
    this.event('BREAK', lock, { why: lock.stale, by });
    return true;
  }

  writeWaiter(key, rec) {
    const file = this.waiterFile(key, rec.token);
    const fresh = !fs.existsSync(file);
    const w = Object.assign({ v: 1, machine: this.machine }, rec, { resource: key, heartbeat: Date.now() });
    try { U.writeJson(file, w); } catch (_) {}
    return { fresh, waiter: w };
  }

  dropWaiter(key, token, kind, extra) {
    const file = this.waiterFile(key, token);
    const w = U.readJson(file);
    const gone = U.safeUnlink(file);
    if (gone && kind && w) this.event(kind, w, extra);
    return gone ? w : null;
  }

  writeAsk(key, ask) { try { U.writeJson(this.askFile(key, ask.token), Object.assign({ resource: key }, ask)); } catch (_) {} }
  dropAsk(key, token) { return U.safeUnlink(this.askFile(key, token)); }
  readAsk(key, token) { return U.readJson(this.askFile(key, token)); }

  /** Every lock key present in the folder (for the board and status); places 2..n count as their resource. */
  keys() {
    let names = [];
    try { names = fs.readdirSync(this.dir); } catch (_) { return []; }
    const keys = names.filter(n => n.endsWith('.json') && !n.includes('.wait.') && !n.includes('.ask.') && !n.includes('.probe.')
      && !n.includes('.saved.') && !n.includes('.tunnel.')).map(n => n.slice(0, -5).replace(/\.\d+$/, ''));
    return [...new Set(keys)];
  }
}

// Place n of `key`: place 1 is `key` itself, so a resource without places keeps its one file.
function placeKey(key, n) { return Number(n) > 1 ? `${key}.${n}` : key; }
function placeOf(key, pk) { return pk === key ? 1 : Number(pk.slice(key.length + 1)) || 1; }
function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** "chat 'X' (hold, note) since 13:04, TTL until 14:04", in `lang` or the hub's language. */
function describe(lock, lang) { return say(describeMsg(lock), lang); }

/** describe() as a message {k, v}, for text that reaches the board. */
function describeMsg(lock) {
  if (!lock) return msg('lock.free');
  if (lock.unreadable) return msg('lock.unreadable');
  const who = lock.mode === 'presence' ? (lock.chat || msg('lock.who.person'))
    : lock.chat ? msg('lock.who.chat', { chat: lock.chat }) : lock.session ? msg('lock.who.session', { id: String(lock.session).slice(0, 8) }) : msg('lock.who.outside');
  const what = lock.mode === 'script' ? msg('lock.what.script', { script: lock.script || 'script', pid: lock.pid }) : msg('mode.' + lock.mode);
  const until = Number(lock.expires) ? msg('lock.until', { time: U.hm(lock.expires) }) : '';
  const place = Number(lock.slots) > 1 ? (lock.shared ? msg('lock.place', { place: lock.place || 1, slots: lock.slots })
    : msg('lock.whole', { slots: lock.slots })) : '';
  return msg('lock.describe', { who, what, note: (place ? ', ' + say(place) : '') + (lock.note ? ', ' + lock.note : ''), since: U.hm(lock.since), until });
}

module.exports = { Store, describe, describeMsg, placeKey, WAITER_HEARTBEAT_MS, machineName: () => U.hostname(), os };
