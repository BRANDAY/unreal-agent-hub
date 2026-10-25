// OpenAI Codex hooks (learn.chatgpt.com/docs/hooks, formerly developers.openai.com/codex/hooks): the same event
// names and stdin fields as Claude Code plus turn_id and model, the same deny and additionalContext output. There
// is no Notification event. Hooks run only after the user trusted them (`/hooks` in Codex).
'use strict';
const claude = require('./claude.cjs');

const name = 'codex';

function normalize(input, env) {
  const n = claude.normalize(input, env || {});
  n.agent = name;
  n.ownerPid = 0; // Codex exports no pid of its own: a hold lives until Stop/SessionEnd or its TTL
  n.hostSession = '';
  if (!input.session_id && (env || process.env).CODEX_SESSION_ID) n.session = (env || process.env).CODEX_SESSION_ID;
  return n;
}

// Context before a tool call (Claude Code's PreToolUse additionalContext) is not documented for Codex: left out.
function context(event, text, rawEvent) { return event === 'PreToolUse' ? null : claude.context(event, text, rawEvent); }

module.exports = { name, normalize, deny: claude.deny, allow: claude.allow, context };
