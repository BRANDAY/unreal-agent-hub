// `hub status` and the hub_status MCP tool: every resource with its holder, queue and handover requests.
'use strict';
const C = require('./config.cjs');
const Q = require('./queue.cjs');
const roles = require('./roles.cjs');
const { describe } = require('./store.cjs');
const U = require('./util.cjs');

function data(cfg, store) {
  const now = Date.now();
  return C.allResources(cfg).map(r => {
    const lock = store.readLock(r.key);
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
      queue: Q.order(store.readWaiters(r.key), cfg, now).map(w => ({ token: w.token, who: w.chat || `${w.script || w.mode} pid ${w.pid || '-'}`,
        mode: w.mode, priority: Q.effectivePriority(w, cfg, now), waitingMin: Math.round((now - Number(w.since)) / 60e3), blocked: Q.isBlocked(w, now) ? w.blocked : '' })),
      asks: store.readAsks(r.key).map(a => ({ token: a.token, state: a.state, who: a.chat || a.script || a.token, from: a.machine, note: a.note || a.command || '', since: a.since })),
      machine,
    };
  });
}

function format(rows) {
  if (!rows.length) return 'No resources are configured yet (see docs/CONFIG.md).';
  const lines = [];
  for (const r of rows) {
    let state = 'free';
    if (r.holder) state = r.holder.stale ? `stale (${r.holder.stale}): ${r.holder.text}` : r.holder.text;
    else if (r.machine && r.machine.human) state = `free of runs, but ${r.machine.human}`;
    else if (r.machine && r.machine.online === false) state = `free (machine offline at ${U.hm(r.machine.probedAt)})`;
    lines.push(`${r.key.padEnd(18)} ${state}`);
    for (const w of r.queue) lines.push(`${''.padEnd(18)}   queued: ${w.who} (${w.mode}, priority ${w.priority}, ${w.waitingMin} min${w.blocked ? ', waits for a person' : ''})`);
    for (const a of r.asks) lines.push(`${''.padEnd(18)}   asks the person: ${a.who} from ${a.from || '?'} - ${a.state}${a.note ? ' - ' + a.note : ''}`);
  }
  return lines.join('\n');
}

module.exports = { data, format };
