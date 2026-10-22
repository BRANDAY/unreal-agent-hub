// Telling a person about the two events that concern them: a handover request and "the machine is yours again".
// Sinks (cfg.handover.notify):
//   board           always: the board reads asks and state/notices.jsonl and shows a banner (+ browser notification)
//   remote-control  a message into the hub's duty chat (`hub duty` registers one), which can forward it over Claude
//                   Remote Control to wherever the person sits. Each delivered message is one model turn there, so
//                   only these two events are sent, never routine traffic. See docs/HANDOVER.md.
'use strict';
const path = require('path');
const U = require('./util.cjs');
const { T } = require('./i18n.cjs');

function noticesFile(cfg) { return path.join(cfg.stateDir, 'notices.jsonl'); }

function text(ev) {
  const a = ev.ask || {};
  const who = a.chat || a.script || T('notify.remoteRun');
  const machine = ev.key;
  if (ev.kind === 'ask') return T('notify.ask', { who, from: a.machine || '?', machine, what: a.note || a.command || a.script || '' });
  if (ev.kind === 'return') return T('notify.return', { who, machine, min: Math.round((ev.heldMs || 0) / 60e3), restored: ev.restored ? T('notify.restored') : '' });
  return ev.text || '';
}

function send(cfg, ev) {
  const a = ev.ask || {};
  const line = { t: Date.now(), kind: ev.kind, key: ev.key, token: a.token, who: a.chat || a.script || '', from: a.machine || '', heldMs: ev.heldMs || 0, text: text(ev) };
  U.appendLine(noticesFile(cfg), JSON.stringify(line));
  const sinks = (cfg.handover && cfg.handover.notify) || ['board'];
  if (sinks.includes('remote-control')) {
    try { require('./adapters/claude-messaging.cjs').toDuty(cfg, line.text); } catch (_) {}
  }
  return line;
}

function recent(cfg, ms) {
  const since = Date.now() - (ms || 30 * 60e3);
  let raw = '';
  try { raw = require('fs').readFileSync(noticesFile(cfg), 'utf8'); } catch (_) { return []; }
  return raw.trim().split('\n').slice(-200).map(l => { try { return JSON.parse(l); } catch (_) { return null; } })
    .filter(n => n && n.t >= since);
}

module.exports = { send, recent, text, noticesFile };
