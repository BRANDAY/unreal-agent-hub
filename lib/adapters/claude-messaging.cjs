// Notification sink "remote-control": puts a message in front of a person through the hub's duty chat.
//
// How it is meant to work (docs/HANDOVER.md): `hub duty`, run in one chat on the hub, registers that chat. A
// hook or script may only write into its OWN session's inbox (CLAUDE_CODE_MESSAGING_SOCKET with
// CLAUDE_CODE_MESSAGING_TOKEN; a named pipe on Windows); the duty chat then forwards the text over Remote
// Control to the chat on the machine where the person sits. Every delivered message is one model turn there.
//
// The wire format of that inbox is not documented publicly, so this adapter does not speak it yet: it queues
// the message in state/outbox.jsonl, and the duty chat's own UserPromptSubmit/SessionStart hook shows pending
// lines as context on its next turn. The board stays the main place where requests are seen and answered.
'use strict';
const path = require('path');
const U = require('../util.cjs');

function toDuty(cfg, text) {
  const duty = U.readJson(path.join(cfg.stateDir, 'duty.json'));
  if (!duty || !duty.session) return { ok: false, error: 'no duty chat (run `hub duty` in one)' };
  U.appendLine(path.join(cfg.stateDir, 'outbox.jsonl'), JSON.stringify({ t: Date.now(), to: duty.session, text }));
  return { ok: true, queued: true };
}

/** Lines waiting for the duty chat `session`; they are marked as delivered. */
function takeFor(cfg, session) {
  const file = path.join(cfg.stateDir, 'outbox.jsonl');
  let raw = '';
  try { raw = require('fs').readFileSync(file, 'utf8'); } catch (_) { return []; }
  const rows = raw.trim().split('\n').map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
  const mine = rows.filter(r => r.to === session && !r.delivered);
  if (!mine.length) return [];
  for (const r of mine) r.delivered = Date.now();
  try { require('fs').writeFileSync(file, rows.slice(-500).map(r => JSON.stringify(r)).join('\n') + '\n'); } catch (_) {}
  return mine.map(r => r.text);
}

module.exports = { toDuty, takeFor };
