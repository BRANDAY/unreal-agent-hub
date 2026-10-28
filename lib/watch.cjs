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
// Settings: `watch` in the profile (the unreal profile ships the detection) and in the project overlay (`start`).
// Each project the hooks have seen is remembered in state/watch/<project>.json, so the board knows what to watch.
'use strict';
const fs = require('fs');
const net = require('net');
const path = require('path');
const U = require('./util.cjs');
const C = require('./config.cjs');
const { msg, say } = require('./i18n.cjs');

const DEFAULTS = { port: 0, tools: '', processes: [], start: null, log: '', cleanExit: '', busy: [], quietMin: 2, maxPerHour: 2, openingMin: 20 };

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
    cleanExit: w.cleanExit, busyKeys: w.busyKeys, quietMin: w.quietMin, maxPerHour: w.maxPerHour, openingMin: w.openingMin };
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
 * or {ok: false, reason} after waitSec. opts: waitSec, pollMs, onWait(reason), portAlive (tests).
 */
async function waitRestart(cfg, store, w, opts) {
  opts = opts || {};
  const alive = opts.portAlive || (p => portAlive(p));
  const started = Date.now();
  let waiting = false, reason = null;
  for (;;) {
    if (await alive(w.port)) return { ok: true, waited: waiting, waitedMs: Date.now() - started };
    const why = restartWhy(cfg, store, w);
    reason = why ? say(why) : null;
    if (!reason) return { ok: true, waited: waiting, down: true, waitedMs: Date.now() - started };
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
  let lastBusy = 0, told = '';
  const tries = [];
  const say = line => { if (line !== told) { told = line; log(line); } };
  return async function tick() {
    if (await alive(w.port)) { markUp(cfg, w.project); told = ''; return 'up'; }
    if (running(w.processes)) return 'starting'; // booting, a -game run, or hung: not the watchdog's to touch
    if (busyLocks(store, w).length) { lastBusy = now(); return 'busy'; }
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

module.exports = { DEFAULTS, settings, remember, list, projectId, markDown, markUp, portAlive, restartWhy, restartPending, waitRestart, makeWatchdog, lastExit, downFile, openingFile };
