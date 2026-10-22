// Presence: "I am sitting at this machine". A presence hold on the machine's resource makes remote runs queue
// (and ask, docs/HANDOVER.md) while the chats the person runs on that machine pass (presence.blocks: ["remote"]).
'use strict';
const C = require('./config.cjs');
const { fail } = require('./i18n.cjs');

/** The machine resource key of machine `id` (a node, or the hub's own `machineResource`). */
function machineKey(cfg, id) {
  if (!id || id === cfg.id) return cfg.machineResource || null;
  const n = cfg.nodes.find(x => x.id === C.safeId(id) || (x.label || '').toLowerCase() === String(id).toLowerCase());
  return n ? n.resources[0].key : null;
}

function labelOf(cfg, id) {
  if (!id || id === cfg.id) return cfg.label;
  const n = cfg.nodes.find(x => x.id === C.safeId(id));
  return n ? n.label || n.id : id;
}

function here(cfg, store, id, on, opts) {
  opts = opts || {};
  id = id || (cfg.operator && cfg.operator.at) || cfg.id;
  const key = machineKey(cfg, id);
  if (!key) return fail('presence.noResource', { id });
  const cur = store.readLock(key);
  if (!on) {
    if (!cur || cur.mode !== 'presence') return fail('presence.none');
    const r = store.release(key, cur.token, `the person left${opts.by ? ', ' + opts.by : ''}`);
    return r.ok ? { ok: true, key } : { ok: false, error: r.error };
  }
  if (cur && !cur.stale && cur.mode === 'presence') {
    store.refresh(key, cur.token);
    return { ok: true, key, already: true };
  }
  if (cur && !cur.stale) return fail('presence.busy', { holder: require('./store.cjs').describe(cur) }, { key });
  const ttl = Number(opts.ttlMin || cfg.presenceTtlMin || 180);
  const r = store.tryTake(key, {
    token: require('./util.cjs').newToken(), mode: 'presence', chat: `person at ${labelOf(cfg, id)}`, note: opts.by || '',
    node: C.nodeOf(cfg, key) ? C.nodeOf(cfg, key).id : '', ttlMin: ttl, machine: C.nodeOf(cfg, key) ? C.nodeOf(cfg, key).id : cfg.id,
  }, {});
  return r.ok ? { ok: true, key, ttlMin: ttl } : { ok: false, error: r.why, key };
}

module.exports = { here, machineKey, labelOf };
