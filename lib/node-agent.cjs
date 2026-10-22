// The node side of a hook event (role "node"): the chat's status goes to the hub's board, and heavy work that the
// profile gates on "@machine" waits for this machine's resource through the hub (POST /api/node/hold), exactly as
// the hub's own scripts wait. The hub holds the queue; when it cannot be reached, everything goes on as if there
// were no hub (fail open) and the chat state stays in this machine's state/chats/ until the hub reads it (`dump`).
'use strict';
const U = require('./util.cjs');
const { T } = require('./i18n.cjs');
const client = require('./transport/client.cjs');
const { matchGates } = require('./hook.cjs');

const POLL_MS = 3000;

function nodeBody(cfg, rec, extra) {
  return Object.assign({}, rec, { node: cfg.id, lastReply: undefined }, extra || {});
}

async function onHook(cfg, profile, ev, rec, out, write) {
  const allow = () => write(out.allow(ev.rawEvent));
  if (cfg.transport === 'folder' && cfg.folder) {
    try { require('./transport/folder.cjs').publish(cfg.folder, cfg.id, 'chat', rec); } catch (_) {}
  }
  if (ev.event === 'PreToolUse') {
    const gates = matchGates([...(profile.gates || []), ...((cfg.project && cfg.project.gates) || [])], ev)
      .filter(g => g.resource === '@machine' || g.resource === `@node:${cfg.id}`);
    if (!gates.length) { client.post(cfg, '/api/node/event', nodeBody(cfg, rec), 800); return allow(); }
    const what = ev.command ? `${ev.tool}: ${U.clip(ev.command, 100)}` : ev.tool;
    const t0 = Date.now();
    const waitMs = (cfg.gateWaitSec || 1500) * 1000;
    let said = false;
    for (;;) {
      const r = await client.post(cfg, '/api/node/hold', nodeBody(cfg, rec, { tool: what, command: U.clip(ev.command, 160) }), 4000);
      if (!r) { log(cfg, `hub unreachable, ${what} goes on`); return allow(); }
      if (r.ok) { if (said) log(cfg, `GO ${ev.session} ${what} after ${Math.round((Date.now() - t0) / 1000)} s`); return allow(); }
      if (!said) { said = true; log(cfg, `WAIT ${ev.session} ${what} behind ${r.holder}`); }
      if (Date.now() - t0 > waitMs) {
        return write(out.deny('PreToolUse', T('nodeAgent.busy', { id: cfg.id, holder: r.holder, min: Math.round(waitMs / 60e3) })));
      }
      await U.sleep(POLL_MS);
    }
  }
  const slow = ev.event === 'SessionStart' || ev.event === 'UserPromptSubmit';
  const r = await client.post(cfg, '/api/node/event', nodeBody(cfg, rec), slow ? 2500 : 1200);
  if (!slow) return allow();
  const lines = [];
  if (ev.event === 'SessionStart') {
    lines.push(r
      ? T('nodeAgent.start', { id: cfg.id, hub: r.hub || T('nodeAgent.mainMachine') })
      : T('nodeAgent.startNoHub', { id: cfg.id }));
  }
  if (r && r.holder && !r.mine) lines.push(T('nodeAgent.held', { holder: r.holder, waiters: r.waiters ? T('nodeAgent.waiters', { n: r.waiters }) : '' }));
  if (r && r.asks) lines.push(T('nodeAgent.asks', { n: r.asks }));
  return write(out.context(ev.event, lines.join('\n'), ev.rawEvent) || out.allow(ev.rawEvent));
}

function log(cfg, line) { U.appendLine(require('path').join(cfg.stateDir, 'agent.log'), `${new Date().toISOString()} ${line}`); }

module.exports = { onHook };
