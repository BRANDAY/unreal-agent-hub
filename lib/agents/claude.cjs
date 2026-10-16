// Claude Code hooks (code.claude.com/docs/en/hooks): JSON on stdin with session_id, cwd, hook_event_name,
// tool_name, tool_input; a deny is hookSpecificOutput.permissionDecision = "deny"; context for the model is
// hookSpecificOutput.additionalContext on SessionStart and UserPromptSubmit.
'use strict';

const name = 'claude';

function normalize(input, env) {
  env = env || process.env;
  const ti = input.tool_input || {};
  return {
    agent: name,
    event: input.hook_event_name || '',
    session: input.session_id || env.CLAUDE_CODE_SESSION_ID || '',
    cwd: input.cwd || env.CLAUDE_PROJECT_DIR || process.cwd(),
    tool: input.tool_name || '',
    command: typeof ti.command === 'string' ? ti.command : '',
    prompt: input.prompt || '',
    title: input.session_title || '',
    notificationType: input.notification_type || '',
    message: input.message || '',
    lastReply: input.last_assistant_message || '',
    source: input.source || '',
    reason: input.reason || '',
    ownerPid: Number(env.CLAUDE_PID) || 0,
    hostSession: env.CLAUDE_CODE_HOST_SESSION_ID || '',
  };
}

function deny(event, reason) {
  return { hookSpecificOutput: { hookEventName: event || 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
}

function allow() { return null; }

function context(event, text) {
  if (!text || (event !== 'SessionStart' && event !== 'UserPromptSubmit')) return null;
  return { hookSpecificOutput: { hookEventName: event, additionalContext: text } };
}

module.exports = { name, normalize, deny, allow, context };
