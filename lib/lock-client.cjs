// Taking a resource the way every client does it: one attempt, or a wait in the queue with a waiter file, a
// handover request when a person is in the way, and a pool ("role:runner") where the first free member wins.
// Used by `hub lock|hold|take`, the hooks' gates, the MCP server and the board (for its nodes' chats).
'use strict';
const U = require('./util.cjs');
const C = require('./config.cjs');
const Q = require('./queue.cjs');
const H = require('./handover.cjs');
const roles = require('./roles.cjs');
const { describe } = require('./store.cjs');

const POLL_MS = 2000;

function tokenEnv(key) { return `UAH_TOKEN_${String(key).toUpperCase().replace(/[^A-Z0-9]/g, '_')}`; }

/** Who is asking, from the environment of an agent's process (overridable by options). */
function identity(cfg, opts) {
  opts = opts || {};
  const env = opts.env || process.env;
  const session = opts.session || env.UAH_SESSION || env.CLAUDE_CODE_SESSION_ID || '';
  let chat = opts.chat || env.UAH_CHAT || '';
  if (!chat && session) {
    const c = require('./chats.cjs').read(cfg, session);
    if (c && c.title) chat = c.title;
    else {
      const d = require('./adapters/claude-desktop.cjs').sessionRecord(env);
      if (d && d.title) chat = d.title;
    }
  }
  const ownerPid = Number(opts.ownerPid != null ? opts.ownerPid : env.CLAUDE_PID || 0) || 0;
  return {
    chat, session, agent: opts.agent || (env.CLAUDE_CODE_SESSION_ID ? 'claude' : ''),
    hostSession: opts.hostSession || env.CLAUDE_CODE_HOST_SESSION_ID || '',
    ownerPid, ownerPidStart: ownerPid ? U.procStart(ownerPid) : 0,
  };
}

function isMineFn(key, who, env) {
  const t = (env || process.env)[tokenEnv(key)];
  return lock => !!lock && ((t && lock.token === t)
    || ((lock.mode === 'hold' || lock.mode === 'node-chat') && !!who.session && lock.session === who.session)
    || (lock.mode === 'hold' && !!who.ownerPid && lock.ownerPid === who.ownerPid));
}

/**
 * Takes one resource of `name` (a name, key, "@machine", "@node:x" or "role:x").
 * opts: mode (script|hold|node-chat|presence), ttlMin, note, script, command, pid, noWait, waitMin, priority,
 *       ask (true|false|undefined = by config), from (machine id of the caller), passPresence, onWait(text),
 *       identity fields (chat, session, agent, ownerPid), node (for node-chat), signal ({aborted}).
 * Resolves {ok, key, token, lock, reentrant, presence, waitedMs} or {ok:false, error, holder}.
 */
async function acquire(cfg, store, name, opts) {
  opts = opts || {};
  const members = Array.isArray(name) ? name : C.resolve(cfg, name);
  if (!members.length) return { ok: false, error: `unknown resource "${name}"` };
  const who = Object.assign(identity(cfg, opts), pickIdentity(opts));
  const mode = opts.mode || 'script';
  const token = opts.token || U.newToken();
  const from = opts.from || cfg.id;
  const pid = opts.pid || process.pid;
  const started = Date.now();
  const waitMs = (opts.waitMin != null ? opts.waitMin : cfg.waitMin || 240) * 60e3;
  let lastSay = 0, waiting = false, result = null;
  const probeAt = new Map();

  const recFor = (m) => strip({
    token, mode, chat: who.chat, session: who.session, agent: who.agent, hostSession: who.hostSession,
    pid, pidStart: opts.pidStart != null ? opts.pidStart : (pid === process.pid ? U.procStart(pid) : U.procStart(pid)),
    ownerPid: who.ownerPid, ownerPidStart: who.ownerPidStart, script: opts.script || '', note: opts.note || '',
    command: U.clip(opts.command, 160), node: opts.node || '', machine: opts.machine || undefined,
    ttlMin: opts.ttlMin || m.ttlMin || cfg.defaultTtlMin, priority: opts.priority, ...(opts.extra || {}),
  });

  try {
    while (!result) {
      let lastReason = null;
      for (const m of members) {
        const isMine = opts.isMine || isMineFn(m.key, who, opts.env);
        const node = C.nodeOf(cfg, m.key);
        const remote = node && node.id !== from;
        const askOn = opts.ask != null ? opts.ask : !!(cfg.handover && cfg.handover.ask);
        const granted = H.isGranted(store, m.key, token);
        let busy = null;
        // A machine's person: probed only while no lock answers by itself, at most every 60 s while waiting.
        if (remote && !granted && !store.readLock(m.key) && process.env.UAH_NODE_PROBE !== 'off') {
          const last = probeAt.get(m.key) || 0;
          const gap = waiting ? 60e3 : 0;
          if (Date.now() - last >= gap) {
            probeAt.set(m.key, Date.now());
            await roles.getProbe(cfg, node.id, waiting ? 50 : 30);
          }
          busy = roles.humanBusy(cfg, node, roles.readProbe(cfg, node.id), { skipGrace: H.isPending(store, m.key, token) && cfg.handover.skipGraceWhenAsked !== false });
        }
        const me = { token, mode, since: waiting ? (store.readWaiters(m.key).find(w => w.token === token) || {}).since || started : started, priority: opts.priority };
        const r = store.tryTake(m.key, recFor(m), {
          isMine, passPresence: opts.passPresence != null ? opts.passPresence : !remote && !!node,
          blocker: () => (busy ? busy.text : null),
          ahead: () => Q.ahead(store.readWaiters(m.key), me, cfg),
        });
        if (r.ok) {
          result = Object.assign({ key: m.key, token: r.reentrant ? r.lock.token : token }, r);
          H.started(store, m.key, token);
          break;
        }
        const human = (r.holder && r.holder.mode === 'presence') || (busy && busy.kind === 'human');
        const desc = r.holder ? describe(r.holder) : r.busy ? r.busy : r.why === 'queue' ? `${r.ahead.length} queued before (${r.ahead[0].chat || r.ahead[0].script || r.ahead[0].token})` : r.why;
        lastReason = { key: m.key, text: desc, holder: r.holder || null, human };
        if (opts.noWait) continue;
        const w = store.writeWaiter(m.key, Object.assign(recFor(m), { since: me.since, ttlMin: recFor(m).ttlMin,
          blocked: human ? 'human' : '', blockedAt: human ? Date.now() : 0 }));
        if (w.fresh) {
          store.log(`WAIT  ${m.key} by ${describe(w.waiter)} behind ${desc}`);
          store.event('WAIT', w.waiter, { behind: desc });
        }
        if (human && remote && askOn) H.ask(store, cfg, m.key, w.waiter, desc);
      }
      if (result) break;
      if (opts.noWait) return { ok: false, error: `${lastReason.key} is busy: ${lastReason.text}`, holder: lastReason.holder, reason: lastReason };
      waiting = true;
      const waited = Date.now() - started;
      if (opts.onWait && Date.now() - lastSay >= 60e3) { lastSay = Date.now(); opts.onWait(lastReason, waited); }
      if (waited > waitMs) return { ok: false, timeout: true, error: `gave up after ${Math.round(waitMs / 60e3)} min: ${lastReason.text}`, reason: lastReason };
      if (opts.signal && opts.signal.aborted) return { ok: false, error: 'aborted', reason: lastReason };
      await U.sleep(opts.pollMs || POLL_MS);
    }
  } finally {
    for (const m of members) {
      const takenHere = result && result.key === m.key;
      store.dropWaiter(m.key, token, takenHere ? 'GO' : (waiting ? 'LEAVE' : null), { waitedMs: Date.now() - started });
      if (!takenHere) H.cancel(store, m.key, token);
    }
  }
  result.ok = true;
  result.waitedMs = Date.now() - started;
  return result;
}

function strip(o) { for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k]; return o; }

function pickIdentity(opts) {
  const out = {};
  for (const k of ['chat', 'session', 'agent', 'hostSession', 'ownerPid', 'ownerPidStart']) if (opts[k] !== undefined && opts[k] !== '') out[k] = opts[k];
  return out;
}

/** Frees `key` held under `token` and tells a person their machine is back if they had let this run in. */
function release(cfg, store, key, token, why) {
  const r = store.release(key, token, why);
  if (r.ok) H.returned(store, cfg, key, token, Date.now() - Number(r.lock.since));
  return r;
}

/**
 * A gate: wait (without taking anything) until `key` is free of other holders, as an MCP call of a chat waits
 * for the editor that another chat is restarting. The holder's own calls pass (opts.isMine(lock) widens "own").
 */
async function gateWait(cfg, store, key, opts) {
  opts = opts || {};
  const who = Object.assign(identity(cfg, opts), pickIdentity(opts));
  const isMine = opts.isMine || isMineFn(key, who, opts.env);
  const token = `gate-${U.rand(4)}`;
  const started = Date.now();
  const waitMs = (opts.waitSec || cfg.gateWaitSec || 1500) * 1000;
  let waiting = false, wrec = null, ok = false;
  try {
    for (;;) {
      const lock = store.readLock(key);
      const free = !lock || !!lock.stale || isMine(lock) || (lock.mode === 'presence' && opts.passPresence);
      if (free) { ok = true; return { ok: true, waitedMs: Date.now() - started, waited: waiting }; }
      if (!waiting) {
        waiting = true;
        wrec = { token, mode: 'gate', chat: who.chat, session: who.session, agent: who.agent, pid: opts.pid || process.pid,
          pidStart: U.procStart(opts.pid || process.pid), script: opts.script || '', note: opts.note || '', since: started };
        const w = store.writeWaiter(key, wrec);
        store.event('WAIT', w.waiter, { behind: describe(lock) });
        if (opts.onWait) opts.onWait(lock);
      } else {
        store.writeWaiter(key, wrec); // heartbeat
      }
      if (Date.now() - started > waitMs) return { ok: false, timeout: true, holder: lock, error: describe(lock) };
      await U.sleep(opts.pollMs || POLL_MS);
    }
  } finally {
    if (waiting) store.dropWaiter(key, token, ok ? 'GO' : 'LEAVE', { waitedMs: Date.now() - started });
  }
}

module.exports = { acquire, release, gateWait, identity, tokenEnv, isMineFn, POLL_MS };
