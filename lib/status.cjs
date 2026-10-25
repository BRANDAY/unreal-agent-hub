// `hub status` and the hub_status MCP tool: every resource with its holder, queue and handover requests.
'use strict';
const C = require('./config.cjs');
const Q = require('./queue.cjs');
const roles = require('./roles.cjs');
const { describe } = require('./store.cjs');
const U = require('./util.cjs');
const { T } = require('./i18n.cjs');

function data(cfg, store) {
  const now = Date.now();
  return C.allResources(cfg).map(r => {
    const lock = store.readLock(r.key);
    const locks = r.slots > 1 ? store.readLocks(r.key) : (lock ? [lock] : []);
    const node = C.nodeOf(cfg, r.key);
    let machine = null;
    if (node) {
      const p = roles.readProbe(cfg, node.id);
      const h = roles.humanBusy(cfg, node, p, {});
      machine = { node: node.id, online: p ? !!p.online : null, probedAt: p ? p.fetched : 0, human: h ? h.text : '' };
    }
    return {
      key: r.key, label: r.label, scope: r.scope, node: r.node || '',
      holder: lock ? Object.assign({}, lock, { text: describe(lock) }) : null,
      slots: r.slots || 1, hold: r.hold !== false,
      holders: locks.map(l => Object.assign({}, l, { text: describe(l) })),
      queue: Q.order(store.readWaiters(r.key), cfg, now).map(w => ({ token: w.token, who: w.chat || `${w.script || w.mode} pid ${w.pid || '-'}`,
        mode: w.mode, shared: !!w.shared, priority: Q.effectivePriority(w, cfg, now), waitingMin: Math.round((now - Number(w.since)) / 60e3), blocked: Q.isBlocked(w, now) ? w.blocked : '' })),
      asks: store.readAsks(r.key).map(a => ({ token: a.token, state: a.state, who: a.chat || a.script || a.token, from: a.machine, note: a.note || a.command || '', since: a.since })),
      machine,
    };
  });
}

function format(rows) {
  if (!rows.length) return T('status.none');
  const lines = [];
  for (const r of rows) {
    let state = T('status.free');
    if (r.holder) state = r.holder.stale ? T('status.stale', { why: r.holder.stale, text: r.holder.text }) : r.holder.text;
    else if (r.machine && r.machine.human) state = T('status.freeHuman', { human: r.machine.human });
    else if (r.machine && r.machine.online === false) state = T('status.freeOffline', { time: U.hm(r.machine.probedAt) });
    if (r.slots > 1) {
      // A resource with places: "k/N" and one line per holder; a whole take holds every place under one token.
      const live = (r.holders || []).filter(h => !h.stale);
      const used = live.reduce((n, h) => n + (h.shared ? 1 : r.slots), 0);
      lines.push(`${r.key.padEnd(18)} ${T('status.places', { used: Math.min(used, r.slots), slots: r.slots })}`);
      const tokens = new Set();
      for (const h of r.holders || []) {
        if (tokens.has(h.token)) continue;
        tokens.add(h.token);
        lines.push(`${''.padEnd(18)}   ` + (h.stale ? T('status.stale', { why: h.stale, text: h.text }) : h.text));
      }
      if (!(r.holders || []).length && state !== T('status.free')) lines.push(`${''.padEnd(18)}   ${state}`);
    } else lines.push(`${r.key.padEnd(18)} ${state}`);
    for (const w of r.queue) lines.push(`${''.padEnd(18)}   ` + T('status.queued', { who: w.who, mode: w.mode, priority: w.priority, min: w.waitingMin, blocked: w.blocked ? T('status.waitsPerson') : '' }));
    for (const a of r.asks) lines.push(`${''.padEnd(18)}   ` + T('status.asks', { who: a.who, from: a.from || '?', state: a.state, note: a.note ? ' - ' + a.note : '' }));
  }
  return lines.join('\n');
}

module.exports = { data, format };
