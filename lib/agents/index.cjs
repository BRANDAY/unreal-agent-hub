// Which agent sent a hook event, and how to answer it.
//   input agent   detected from the payload (Cursor: conversation_id + cursor_version; Codex: turn_id or the
//                 PLUGIN_ROOT variable Codex sets for plugin hooks; otherwise Claude Code). It labels the chat.
//   output format the agent whose settings file holds the hook (`hub hook --agent X`, written by install-hooks).
//                 Cursor running hooks from ~/.claude/settings.json sends its own payload but expects Claude's
//                 output, and translates it itself.
'use strict';
const AGENTS = { claude: require('./claude.cjs'), codex: require('./codex.cjs'), cursor: require('./cursor.cjs') };

function detect(input, env) {
  env = env || process.env;
  if (input && (input.cursor_version || input.conversation_id || input.workspace_roots)) return 'cursor';
  if (input && input.turn_id) return 'codex';
  if (env.PLUGIN_ROOT && !env.CLAUDECODE && !env.CLAUDE_CODE_ENTRYPOINT) return 'codex';
  return 'claude';
}

/** {ev, out}: the normalized event and the module that formats the answer. */
function read(input, hint, env) {
  const inputAgent = detect(input, env);
  const ev = AGENTS[inputAgent].normalize(input || {}, env || process.env);
  const out = AGENTS[hint] || AGENTS[inputAgent];
  return { ev, out, inputAgent, outputAgent: out.name };
}

module.exports = { AGENTS, detect, read };
