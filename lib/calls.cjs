// App-wide tool calls of a `wait` gate (docs/PROFILES.md "calls"): loading a level, saving everything, Play-In-Editor,
// reloading the editor's tools. A plain `wait` gate only waits while someone holds the resource; two chats' calls
// still go into one editor in turn, and one chat's level load lands in the middle of another's work. A call listed
// in `calls` takes the gate's resource itself, as a short hold for the call ("call hold", by: "hook-call"), counted
// per call; the PostToolUse (or PostToolUseFailure) of the last one frees it. An entry with `until` keeps it until
// that other tool has run (StartPIE -> StopPIE) or `spanTtlMin` is over. Ordinary calls of a free resource take
// nothing. An entry with `stamp` records what the call opened (lib/stamps.cjs), and before an app-wide call the model
// is told once when a stamp listed in `notes` (a build, the open level) is another chat's.
'use strict';
const S = require('./stamps.cjs');
const { say } = require('./i18n.cjs');

const BY = 'hook-call';

// What the call really runs: an MCP proxy tool (`call_tool` with tool_name / arguments) carries the app's tool in its
// input; any other tool is itself.
function callOf(ev) {
  const mcp = String(ev.tool || '').split('__').pop();
  const ti = ev.toolInput || {};
  if (mcp === 'call_tool' && ti.tool_name) {
    const name = String(ti.tool_name);
    return { tail: name.split('.').pop(), label: `${ti.toolset_name ? String(ti.toolset_name).split('.').pop() + '.' : ''}${name}`, args: ti.arguments || {} };
  }
  return { tail: mcp, label: mcp, args: ti };
}

const entry = e => (typeof e === 'string' ? { tool: e } : e);

/**
 * The gate's calls definition: `true` is the profile's `calls`; an object adds its `tools` to the profile's and
 * overrides the other fields (`"inherit": false` drops the profile's). null when the gate has none.
 */
function defOf(gate, profile) {
  if (!gate || !gate.calls) return null;
  const base = (profile && profile.calls) || {};
  const own = gate.calls === true ? {} : gate.calls;
  const inherit = own.inherit !== false;
  const d = Object.assign({}, inherit ? base : {}, own);
  d.tools = [...(inherit ? base.tools || [] : []), ...(gate.calls === true ? [] : own.tools || [])].map(entry).filter(e => e && e.tool);
  d.ttlMin = Number(d.ttlMin) || 5;
  d.spanTtlMin = Number(d.spanTtlMin) || 15;
  d.notes = d.notes || [];
  return d;
}

/** The entry of `def` this call matches, or null. */
function match(def, call) {
  if (!def) return null;
  for (const e of def.tools) {
    if (e.tool !== call.tail) continue;
    if (e.emptyArg) {
      const v = call.args[e.emptyArg];
      if (Array.isArray(v) ? v.length : v) return null; // a named list (its own assets), not "everything"
    }
    return e;
  }
  const sc = def.script;
  if (sc && sc.tool === call.tail) {
    const text = String(call.args[sc.arg || 'script'] || '');
    const hit = def.tools.find(e => new RegExp(`\\b${e.tool}\\b`).test(text));
    if (hit) return { tool: hit.tool, viaScript: true };
  }
  return null;
}

/** PreToolUse: take (or count into this chat's own) call hold of `members`. Resolves like client.acquire. */
async function take(cfg, store, client, members, e, def, who, opts) {
  const ttl = e.until ? def.spanTtlMin : def.ttlMin;
  const r = await client.acquire(cfg, store, members, Object.assign({}, who, {
    mode: 'hold', script: opts.script, note: e.viaScript ? 'in a tool script' : e.until ? `until ${e.until}` : '', ttlMin: ttl,
    waitMin: (cfg.gateWaitSec || 1500) / 60, extra: { by: BY, calls: 1, until: e.until || '' }, onWait: opts.onWait,
  }));
  if (r.ok && r.reentrant && r.lock && r.lock.by === BY) {
    store.refresh(r.key, r.lock.token, { calls: (Number(r.lock.calls) || 0) + 1, until: e.until || r.lock.until || '',
      ttlMin: Math.max(Number(r.lock.ttlMin) || 0, ttl) });
  }
  return r;
}

/** One line for the model when a stamp in `def.notes` is another chat's (each text once per chat), or ''. */
function notes(cfg, def, who, seen) {
  const out = [];
  for (const name of def.notes || []) {
    const c = S.check(cfg, name, who);
    if (c.known && !c.mine && !c.changed) out.push(say(c.m));
  }
  const text = out.join('; ');
  return text && text !== seen ? text : '';
}

/** PostToolUse / PostToolUseFailure: stamp what the call opened, count the call out of this chat's call hold. */
function done(cfg, store, client, members, e, def, ev, who, failed) {
  const call = callOf(ev);
  if (!failed && e.stamp && call.args[e.arg]) S.write(cfg, e.stamp, who, { value: String(call.args[e.arg]), note: call.label, cwd: ev.cwd });
  for (const m of members) {
    const lock = store.readLock(m.key);
    if (!lock || lock.by !== BY || lock.session !== ev.session) continue;
    if (lock.until && lock.until === call.tail) { client.release(cfg, store, m.key, lock.token, `${call.tail} done`); continue; }
    const calls = Math.max(0, (Number(lock.calls) || 1) - 1);
    const until = failed && e.until && lock.until === e.until ? '' : lock.until || ''; // a failed StartPIE: no span
    if (calls > 0 || until) store.refresh(m.key, lock.token, { calls, until });
    else client.release(cfg, store, m.key, lock.token, 'call done');
  }
}

module.exports = { BY, callOf, defOf, match, take, notes, done };
