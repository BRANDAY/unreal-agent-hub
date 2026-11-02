// The project's app (for Unreal: the editor, whose MCP server is the editor itself) down on purpose, mid-restart, or
// gone - and the board's watchdog that opens it again (docs/WATCH.md).
//
// When one chat restarts the editor (close, build, start), the other chats' MCP calls hit a dead port and fail; an
// editor a chat closed (or that crashed) stays down until somebody notices. Three parts:
//   - markers: a chat's close script runs `hub watch down` ("closed by a chat, it comes back"); the start script runs
//     `hub watch up` once the app answers (the watchdog clears both as soon as the port is alive anyway);
//   - the gate: an agent tool call that needs the app (`watch.tools`, "^mcp__unreal-mcp__") waits while the port is
//     dead and a restart is under way - a `busy` resource is held, the marker is up or the watchdog is starting it -
//     instead of failing on a dead socket. Down with none of these (a person closed it) the call goes on as before;
//   - the watchdog (in the board, every 30 s): starts the app with `watch.start` when the port is dead, no app
//     process runs, no `busy` resource has been held for `quietMin`, and either a chat closed it (the marker) or the
//     app's log has no clean exit (a crash or a kill). A clean exit with no marker is a person's own close: it stays
//     closed. At most `maxPerHour` starts an hour.
//   - stalls: the app down with no process under a held busy lock for `alertMin` is an alarm (log, board, the
//     holder's chat), and a caller waiting for an app only its own lock keeps down is refused after `stallSec`.
// Settings: `watch` in the profile (the unreal profile ships the detection) and in the project overlay (`start`).
// Each project the hooks have seen is remembered in state/watch/<project>.json, so the board knows what to watch.
'use strict';
const fs = require('fs');
const net = require('net');
const path = require('path');
const U = require('./util.cjs');
const C = require('./config.cjs');
const { msg, say } = require('./i18n.cjs');

// stallSec: a caller waiting for an app only its own lock keeps down is refused after this long (selfStall);
// alertMin: the watchdog raises an alarm when the app has been down this long under a held busy lock.
const DEFAULTS = { port: 0, tools: '', processes: [], start: null, log: '', cleanExit: '', busy: [], quietMin: 2, maxPerHour: 2, openingMin: 20,
  stallSec: 60, alertMin: 3 };

function dir(cfg) { return path.join(cfg.stateDir, 'watch'); }
function confFile(cfg, pid) { return path.join(dir(cfg), `${pid}.json`); }
function downFile(cfg, pid) { return path.join(dir(cfg), `${pid}.down.json`); }
function openingFile(cfg, pid) { return path.join(dir(cfg), `${pid}.opening.json`); }

/** Project id for watch files: the overlay's project, else the marker's name (MyGame.uproject -> MyGame). */
function projectId(cfg, match) {
  if (cfg.project) return cfg.project.id;
  return match && match.marker ? C.safeId(path.basename(match.marker).replace(/\.[^.]+$/, '')) : '';
}

/** Profile `watch`, then the overlay's on top (single keys replaced; `false` turns it off). Null without a port. */
function settings(cfg, profile, match) {
  const p = profile && profile.watch;
  const o = cfg.project ? cfg.project.watch : undefined;
  if (o === false || (!p && !o)) return null;
  const w = Object.assign({}, DEFAULTS, p || {}, o || {});
  if (!Number(w.port)) return null;
  const root = cfg.project && cfg.project.root ? cfg.project.root : match && match.marker ? path.dirname(match.marker) : '';
  const name = match && match.marker ? path.basename(match.marker).replace(/\.[^.]+$/, '') : '';
  w.port = Number(w.port);
  w.processes = [].concat(w.processes || []);
  w.busy = [].concat(w.busy || []);
  w.root = root;
  w.project = projectId(cfg, match);
  w.logFile = w.log ? path.resolve(root, String(w.log).replace(/\{marker\}/g, name)) : '';
  w.busyKeys = [...new Set(w.busy.flatMap(n => C.resolve(cfg, n).map(r => r.key)))];
  return w.project ? w : null;
}

/** Records the project's watch settings for the board; rewrites only on a change. */
function remember(cfg, w) {
  if (!w || !w.project) return;
  const rec = { project: w.project, root: w.root, port: w.port, processes: w.processes, start: w.start, logFile: w.logFile,
    cleanExit: w.cleanExit, busyKeys: w.busyKeys, quietMin: w.quietMin, maxPerHour: w.maxPerHour, openingMin: w.openingMin,
    stallSec: w.stallSec, alertMin: w.alertMin };
  const cur = U.readJson(confFile(cfg, w.project));
  if (cur && JSON.stringify(cur) === JSON.stringify(rec)) return;
  try { U.writeJson(confFile(cfg, w.project), rec); } catch (_) {}
}

function list(cfg) {
  let names = [];
  try { names = fs.readdirSync(dir(cfg)); } catch (_) { return []; }
  return names.filter(n => /^[^.]+\.json$/.test(n)).map(n => U.readJson(path.join(dir(cfg), n))).filter(w => w && w.project);
}

function markDown(cfg, pid, rec) { U.writeJson(downFile(cfg, pid), Object.assign({ at: Date.now() }, rec || {})); }
function markUp(cfg, pid) { for (const f of [downFile(cfg, pid), openingFile(cfg, pid)]) U.safeUnlink(f); }

function portAlive(port, ms) {
  return new Promise(resolve => {
    const s = net.createConnection({ port, host: '127.0.0.1' });
    const done = ok => { s.destroy(); resolve(ok); };
    s.setTimeout(ms || 600, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

function appRunning(patterns) {
  if (!patterns || !patterns.length) return false;
  const m = require('./detect/processes.cjs').match(patterns);
  return m.desktop.length + m.remote.length > 0;
}

// The app's log: a clean exit leaves `cleanExit` in its last 8 KB.
function lastExit(w) {
  if (!w.logFile || !w.cleanExit) return null;
  try {
    const st = fs.statSync(w.logFile);
    const fd = fs.openSync(w.logFile, 'r');
    const len = Math.min(st.size, 8192);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
    return { mtimeMs: st.mtimeMs, clean: new RegExp(w.cleanExit).test(buf.toString('utf8')) };
  } catch (_) { return null; }
}

// A call hold (lib/calls.cjs: one app-wide call, such as a level load) is not a restart under way.
function busyLocks(store, w) { return (w.busyKeys || []).map(k => store.readLock(k)).filter(l => l && !l.stale && l.by !== 'hook-call'); }

/**
 * The busy lock the caller holds itself while nothing of its restart is under way - no app process, no other live
 * lock of the caller (its build or cook): it waits for an app only it would start, and the watchdog never starts it
 * while that lock is held. Null otherwise. who: {session, ownerPid}. deps.running (tests).
 * Seen 02.11.2026: a chat's `hold editor` was granted with the editor already down, and the same chat's MCP call
 * then waited 900 s in the mcp-proxy - for itself.
 */
function selfStall(store, w, who, deps) {
  if (!who || (!who.session && !who.ownerPid)) return null;
  const mine = l => (!!who.session && l.session === who.session) || (!!who.ownerPid && Number(l.ownerPid) === Number(who.ownerPid));
  const held = busyLocks(store, w).find(mine);
  if (!held) return null;
  if (((deps && deps.running) || appRunning)(w.processes)) return null;
  for (const key of store.keys()) {
    const l = store.readLock(key);
    if (l && !l.stale && l.mode !== 'hold' && mine(l)) return null;
  }
  return held;
}

/** The message for a caller stalled by its own lock (selfStall). */
function selfStallMsg(w, lock) {
  return msg('watch.selfStall', { project: w.project, resource: lock.resource || msg('watch.aResource'),
    what: require('./store.cjs').describe(lock), start: w.start ? [].concat(w.start).join(' ') : msg('watch.noStart') });
}

/**
 * Tracks selfStall over time for one waiting caller: returns the lock once the caller has been stalled by it for
 * stallSec in a row (the seconds between a build and the start script do not count), else null. Reads the process
 * list at most every checkMs.
 */
function stallTracker(store, w, who, opts) {
  opts = opts || {};
  const stallMs = (opts.stallSec !== undefined ? opts.stallSec : w.stallSec !== undefined ? w.stallSec : DEFAULTS.stallSec) * 1000;
  const checkMs = opts.checkMs !== undefined ? opts.checkMs : 10e3;
  const now = opts.now || Date.now;
  let since = 0, at = -Infinity, lock = null;
  return function check() {
    if (now() - at >= checkMs) {
      at = now();
      lock = selfStall(store, w, who, opts);
      since = lock ? since || at : 0;
    }
    return lock && now() - since >= stallMs ? lock : null;
  };
}

function stallFile(cfg, pid) { return path.join(dir(cfg), `${pid}.stall.json`); }
/** The watchdog's current alarm for a project: {at, since, project, resource, token, session, chat, minutes}, or null. */
function readStall(cfg, pid) { return U.readJson(stallFile(cfg, pid)); }

/** Why a restart is under way (calls should wait), as a message, or null. */
function restartWhy(cfg, store, w, now) {
  now = now || Date.now();
  const busy = busyLocks(store, w);
  if (busy.length) return msg('watch.held', { resource: busy[0].resource || msg('watch.aResource'), what: require('./store.cjs').describe(busy[0]) });
  const m = U.readJson(downFile(cfg, w.project));
  if (m) return msg('watch.closedBy', { by: m.by || msg('watch.aChat'), time: U.hm(m.at) });
  const o = U.readJson(openingFile(cfg, w.project));
  if (o && now - Number(o.at) < (w.openingMin || DEFAULTS.openingMin) * 60e3) return msg('watch.starting');
  return null;
}

/** The same as text in the hub's language, or null. */
function restartPending(cfg, store, w, now) {
  const m = restartWhy(cfg, store, w, now);
  return m ? say(m) : null;
}

/**
 * Holds an agent's call while the app's port is dead and a restart is under way. Resolves {ok, waited, waitedMs}
 * or {ok: false, reason} after waitSec, or {ok: false, self: true, reason} once the caller has waited stallSec for a
 * restart only its own lock holds up (selfStall). opts: waitSec, pollMs, onWait(reason), who {session, ownerPid},
 * stallSec, checkMs, running and portAlive (tests).
 */
async function waitRestart(cfg, store, w, opts) {
  opts = opts || {};
  const alive = opts.portAlive || (p => portAlive(p));
  const stalled = opts.who ? stallTracker(store, w, opts.who, opts) : () => null;
  const started = Date.now();
  let waiting = false, reason = null;
  for (;;) {
    if (await alive(w.port)) return { ok: true, waited: waiting, waitedMs: Date.now() - started };
    const why = restartWhy(cfg, store, w);
    reason = why ? say(why) : null;
    if (!reason) return { ok: true, waited: waiting, down: true, waitedMs: Date.now() - started };
    const own = stalled();
    if (own) {
      const m = selfStallMsg(w, own);
      store.log(`SELFSTALL ${w.project}: ${say(m, 'en')}`);
      return { ok: false, self: true, waited: waiting, reason: say(m), reasonMsg: m, waitedMs: Date.now() - started };
    }
    if (!waiting) {
      waiting = true;
      store.log(`RESTARTWAIT ${w.project}: ${say(why, 'en')}`);
      if (opts.onWait) opts.onWait(reason);
    }
    if (Date.now() - started > (opts.waitSec || cfg.gateWaitSec || 1500) * 1000) return { ok: false, reason, reasonMsg: why };
    await U.sleep(opts.pollMs || 3000);
  }
}

/**
 * One watchdog for a remembered project (state/watch/<project>.json). Returns an async tick for the board.
 * deps (tests): portAlive(port), running(patterns), start(w), now().
 */
function makeWatchdog(cfg, store, w, log, deps) {
  deps = deps || {};
  const alive = deps.portAlive || (p => portAlive(p));
  const running = deps.running || appRunning;
  const now = deps.now || Date.now;
  const start = deps.start || (x => {
    const argv = [].concat(x.start);
    const child = require('child_process').spawn(argv[0], argv.slice(1), { cwd: x.root, detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  });
  let lastBusy = 0, told = '', downSince = 0;
  const tries = [];
  const say = line => { if (line !== told) { told = line; log(line); } };
  const calm = () => { downSince = 0; U.safeUnlink(stallFile(cfg, w.project)); };
  // Down with no app process under a held busy lock for alertMin: nobody is starting it, and the watchdog may not
  // while the lock is held. Say so once per lock - in the hub's log, on the board (state/watch/<project>.stall.json,
  // notices) and to the holder's chat on its next tool call (lib/hook.cjs) - instead of letting the queue believe the
  // app is busy (02.11.2026: 30 min down under a rebuild hold, three chats queued, nobody knew).
  const alarm = (lock) => {
    const minutes = Math.round((now() - downSince) / 60e3);
    const cur = readStall(cfg, w.project);
    if (cur && cur.token === lock.token) {
      if (cur.minutes !== minutes) U.writeJson(stallFile(cfg, w.project), Object.assign(cur, { at: now(), minutes }));
      return;
    }
    const text = require('./i18n.cjs').say(msg('watch.stallAlarm', { project: w.project, min: minutes, what: require('./store.cjs').describe(lock) }));
    U.writeJson(stallFile(cfg, w.project), { at: now(), since: downSince, minutes, project: w.project, resource: lock.resource || '',
      token: lock.token || '', session: lock.session || '', ownerPid: lock.ownerPid || 0, chat: lock.chat || '' });
    log(`${w.project}: down ${minutes} min with no app process while ${require('./store.cjs').describe(lock, 'en')} holds it - nobody is starting it`);
    try { (deps.notify || require('./notify.cjs').send)(cfg, { kind: 'stall', key: lock.resource || w.project, text, ask: { chat: lock.chat, token: lock.token } }); } catch (_) {}
  };
  return async function tick() {
    if (await alive(w.port)) { markUp(cfg, w.project); told = ''; calm(); return 'up'; }
    if (running(w.processes)) { calm(); return 'starting'; } // booting, a -game run, or hung: not the watchdog's to touch
    const busy = busyLocks(store, w);
    if (busy.length) {
      lastBusy = now();
      downSince = downSince || now();
      if (now() - downSince >= (w.alertMin !== undefined ? w.alertMin : DEFAULTS.alertMin) * 60e3) alarm(busy[0]);
      return 'busy';
    }
    calm();
    if (now() - lastBusy < (w.quietMin || DEFAULTS.quietMin) * 60e3) return 'quiet';
    const marker = U.readJson(downFile(cfg, w.project));
    const exit = lastExit(w);
    let why = null;
    if (marker) why = `closed by ${marker.by || 'a chat'} at ${U.hm(marker.at)} and not started again`;
    else if (exit && !exit.clean && !tries.some(t => t > exit.mtimeMs)) why = 'its log ends without a clean exit (crash or kill)';
    if (!why && exit && !exit.clean) { say(`${w.project}: down after a crash; a start was already tried for it - waiting for a person`); return 'gave-up'; }
    if (!why) { say(`${w.project}: down, closed cleanly by hand - left closed`); return 'closed'; }
    if (!w.start) { say(`${w.project}: down (${why}); no watch.start configured - waiting for a person`); return 'no-start'; }
    while (tries.length && tries[0] < now() - 3600e3) tries.shift();
    if (tries.length >= (w.maxPerHour || DEFAULTS.maxPerHour)) { say(`${w.project}: down (${why}) - ${tries.length} starts this hour already, waiting for a person`); return 'limit'; }
    tries.push(now());
    U.writeJson(openingFile(cfg, w.project), { at: now(), why });
    log(`${w.project}: starting it - ${why}`);
    start(w);
    return 'started';
  };
}

module.exports = { DEFAULTS, settings, remember, list, projectId, markDown, markUp, portAlive, restartWhy, restartPending, waitRestart, makeWatchdog, lastExit, downFile, openingFile,
  selfStall, selfStallMsg, stallTracker, stallFile, readStall };
