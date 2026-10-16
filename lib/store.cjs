// The lock store: one folder of small JSON files, the single source of truth. The protocol is described in
// docs/PROTOCOL.md so that clients in any language are equal; it needs no mutex, only three atomic file
// operations every OS has: create-if-absent (link / O_EXCL), rename, and link-back-without-overwrite.
//
//   <key>.json                  the lock (absent = free)
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
  /** The lock of `key` with `.stale` (a reason or null), or null when free. */
  readLock(key) {
    const file = this.lockFile(key);
    let st;
    try { st = fs.statSync(file); } catch (_) { return null; }
    const lock = U.readJson(file);
    if (!lock) {
      const old = Date.now() - st.mtimeMs > UNREADABLE_GRACE_MS;
      return { resource: key, unreadable: true, token: '', stale: old ? 'unreadable lock file' : null };
    }
    lock.stale = this.staleReason(lock);
    return lock;
  }

  /** Why a lock no longer counts (§4 of docs/PROTOCOL.md), or null while it is live. */
  staleReason(lock, now) {
    now = now || Date.now();
    if (!lock) return null;
    if (Number(lock.expires) && Number(lock.expires) < now) return `TTL of ${lock.ttlMin} min is over`;
    const local = !lock.machine || lock.machine === this.machine;
    if (!local) return null; // another machine's process: only its TTL can be judged from here
    if (lock.mode === 'script') {
      if (!U.sameProcessAlive(lock.pid, lock.pidStart)) return `its process ${lock.pid} has exited`;
    } else if (lock.mode === 'hold') {
      if (lock.ownerPid && !U.sameProcessAlive(lock.ownerPid, lock.ownerPidStart)) return 'its agent session has ended';
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
    if (!moved.unreadable) moved.stale = this.staleReason(moved);
    if (check(moved)) { U.safeUnlink(aside); return { ok: true, lock: moved }; }
    // Not the lock we meant: put it back. link() never overwrites. Takers do not create a lock while a fresh
    // aside file exists, so the name is normally still free here.
    try { fs.linkSync(aside, file); U.safeUnlink(aside); return { ok: false, error: 'changed', lock: moved }; } catch (e) {
      if (e.code !== 'EEXIST' && !fs.existsSync(file)) {
        try { fs.renameSync(aside, file); return { ok: false, error: 'changed', lock: moved }; } catch (_) {}
      }
    }
    this.log(`CONFLICT ${key}: could not put back the lock of ${describe(moved)}; a new lock took its place`);
    this.event('CONFLICT', moved);
    U.safeUnlink(aside);
    return { ok: false, error: 'conflict', lock: moved };
  }

  /** Drops the lock of `key` if it is still `token` and still stale. */
  breakStale(key, token, by) {
    const r = this.removeIf(key, l => (l.token || '') === (token || '') && !!l.stale);
    if (r.ok) {
      this.log(`BREAK ${key} from ${describe(r.lock)}: stale (${r.lock.stale})${by ? ', by ' + by : ''}`);
      this.event('BREAK', r.lock, { why: r.lock.stale, by: by || '' });
    }
    return r;
  }

  /** Drops whatever lock `key` has, live or not (`hub break --force`). */
  forceBreak(key, by) {
    const r = this.removeIf(key, () => true);
    if (r.ok) {
      this.log(`BREAK ${key} from ${describe(r.lock)}: by hand${by ? ' (' + by + ')' : ''}`);
      this.event('BREAK', r.lock, { why: 'forced', by: by || '' });
    }
    return r;
  }

  /** Releases `key` if it is still held under `token`. */
  release(key, token, why) {
    const r = this.removeIf(key, l => l.token === token);
    if (r.ok) {
      const min = ((Date.now() - Number(r.lock.since)) / 60e3).toFixed(1);
      this.log(`FREE  ${key} by ${describe(r.lock)} after ${min} min${why ? ' (' + why + ')' : ''}`);
      this.event('FREE', r.lock, { why: why || '', heldMs: Date.now() - Number(r.lock.since) });
    }
    return r;
  }

  /** Extends the TTL of a held lock (and merges fields). Only the holder calls this. */
  refresh(key, token, fields) {
    const cur = this.readLock(key);
    if (!cur || cur.token !== token) return false;
    const next = Object.assign({}, cur, fields || {});
    delete next.stale;
    if (cur.ttlMin) next.expires = Date.now() + cur.ttlMin * 60e3;
    try { U.writeJson(this.lockFile(key), next); return true; } catch (_) { return false; }
  }

  /**
   * One attempt to take `key` for `rec` (a full lock record without since/expires).
   *   opts.isMine(lock)      the caller already holds it (re-entrant: nested scripts, a chat's own hold)
   *   opts.passPresence      a person's presence hold does not stop this caller (their own chats)
   *   opts.blocker()         returns a reason when something outside the store makes the resource busy
   *   opts.queue             the ordered waiters, from lib/queue.cjs (default: no queue check)
   * Returns {ok:true, lock, reentrant?, presence?} or {ok:false, why, holder?, busy?, ahead?}.
   */
  tryTake(key, rec, opts) {
    opts = opts || {};
    let cur = this.readLock(key);
    if (cur && !cur.unreadable && opts.isMine && opts.isMine(cur)) return { ok: true, reentrant: true, lock: cur };
    if (cur && cur.stale) { this.breakStale(key, cur.token, rec.chat || rec.script || 'a waiter'); cur = this.readLock(key); }
    if (cur && !cur.stale) {
      if (cur.mode === 'presence' && opts.passPresence) return { ok: true, presence: true, lock: cur };
      return { ok: false, why: cur.unreadable ? 'unreadable' : 'held', holder: cur };
    }
    if (this._asideBusy(key)) return { ok: false, why: 'breaking' };
    if (opts.blocker) {
      const busy = opts.blocker();
      if (busy) return { ok: false, why: 'busy', busy };
    }
    if (opts.ahead) {
      const ahead = opts.ahead();
      if (ahead && ahead.length) return { ok: false, why: 'queue', ahead };
    }
    const now = Date.now();
    const lock = Object.assign({ v: 1, machine: this.machine }, rec, { resource: key, since: now,
      expires: rec.ttlMin ? now + rec.ttlMin * 60e3 : 0 });
    try {
      U.createExclusive(this.lockFile(key), lock);
    } catch (e) {
      if (e.code === 'EEXIST') return { ok: false, why: 'race' };
      throw e;
    }
    this.log(`TAKE  ${key} by ${describe(lock)}`);
    this.event('TAKE', lock);
    return { ok: true, lock };
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

  /** Every lock key present in the folder (for the board and status). */
  keys() {
    let names = [];
    try { names = fs.readdirSync(this.dir); } catch (_) { return []; }
    return names.filter(n => n.endsWith('.json') && !n.includes('.wait.') && !n.includes('.ask.') && !n.includes('.probe.')
      && !n.includes('.saved.') && !n.includes('.tunnel.')).map(n => n.slice(0, -5));
  }
}

/** "chat 'X' (hold, note) since 13:04, TTL until 14:04" */
function describe(lock) {
  if (!lock) return 'free';
  if (lock.unreadable) return 'an unreadable lock file';
  const who = lock.mode === 'presence' ? (lock.chat || 'a person at the machine')
    : lock.chat ? `chat "${lock.chat}"` : lock.session ? `session ${String(lock.session).slice(0, 8)}` : 'a process outside any agent';
  const what = lock.mode === 'script' ? `${lock.script || 'script'} pid ${lock.pid}` : lock.mode;
  const until = Number(lock.expires) ? `, TTL until ${U.hm(lock.expires)}` : '';
  return `${who} (${what}${lock.note ? ', ' + lock.note : ''}) since ${U.hm(lock.since)}${until}`;
}

module.exports = { Store, describe, WAITER_HEARTBEAT_MS, machineName: () => U.hostname(), os };
