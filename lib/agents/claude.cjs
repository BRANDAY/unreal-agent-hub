// Claude Code hooks (code.claude.com/docs/en/hooks): JSON on stdin with session_id, cwd, hook_event_name,
// tool_name, tool_input; a deny is hookSpecificOutput.permissionDecision = "deny"; context for the model is
// hookSpecificOutput.additionalContext on SessionStart, UserPromptSubmit and PreToolUse.
'use strict';

// The files a tool call edits: file_path / notebook_path / path, and the headers of an apply_patch patch
// ("*** Update File: src/a.cpp", "*** Add File:", "*** Delete File:", "*** Move to:").
function editedFiles(ti) {
  const out = [];
  for (const k of ['file_path', 'notebook_path', 'path']) if (typeof ti[k] === 'string' && ti[k]) { out.push(ti[k]); break; }
  for (const v of [ti.patch, ti.input, ti.command]) {
    if (typeof v !== 'string' || !v.includes('*** ')) continue;
    for (const m of v.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+?)\s*$/gm)) out.push(m[1]);
  }
  return [...new Set(out)];
}

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
    command: typeof ti.command === 'string' && !ti.command.startsWith('*** Begin Patch') ? ti.command : '',
    files: editedFiles(ti),
    prompt: input.prompt || '',
    title: input.session_title || '',
    notificationType: input.notification_type || '',
    message: input.message || '',
    lastReply: input.last_assistant_message || '',
    source: input.source || '',
    reason: input.reason || '',
    transcript: input.transcript_path || '',
    // Stop: what keeps running after the turn (shell, subagent, monitor, workflow, cloud session, ...).
    backgroundTasks: Array.isArray(input.background_tasks) ? input.background_tasks : null,
    toolInput: ti,
    toolResponse: input.tool_response,
    ownerPid: Number(env.CLAUDE_PID) || 0,
    hostSession: env.CLAUDE_CODE_HOST_SESSION_ID || '',
  };
}

function deny(event, reason) {
  return { hookSpecificOutput: { hookEventName: event || 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
}

function allow() { return null; }

function context(event, text) {
  if (!text || !['SessionStart', 'UserPromptSubmit', 'PreToolUse'].includes(event)) return null;
  return { hookSpecificOutput: { hookEventName: event, additionalContext: text } };
}

module.exports = { name, normalize, deny, allow, context, editedFiles };
