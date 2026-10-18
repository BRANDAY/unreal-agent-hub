// Cursor hooks (cursor.com/docs/hooks): camelCase events, conversation_id instead of session_id, workspace_roots
// instead of cwd, and {permission, user_message, agent_message} instead of permissionDecision. Permission hooks
// must print valid JSON even to allow (invalid JSON blocks the action); a crash or timeout lets it through.
'use strict';

const name = 'cursor';

const EVENTS = {
  sessionStart: 'SessionStart', sessionEnd: 'SessionEnd', beforeSubmitPrompt: 'UserPromptSubmit', stop: 'Stop',
  preToolUse: 'PreToolUse', beforeShellExecution: 'PreToolUse', beforeMCPExecution: 'PreToolUse',
};
// Cursor's own hook events that expect a permission answer.
const PERMISSION_EVENTS = new Set(['preToolUse', 'beforeShellExecution', 'beforeMCPExecution', 'beforeReadFile', 'subagentStart']);

function parseMaybe(s) { if (typeof s !== 'string') return s || {}; try { return JSON.parse(s); } catch (_) { return {}; } }

function normalize(input) {
  const raw = input.hook_event_name || '';
  const ev = EVENTS[raw] || raw;
  let tool = input.tool_name || '';
  let command = '';
  let files = [];
  if (raw === 'beforeShellExecution') { tool = 'Shell'; command = input.command || ''; }
  else if (raw === 'beforeMCPExecution') {
    // Claude-style name, so the same gates match: mcp__<server>__<tool>.
    tool = `mcp__${input.mcp_server_name || input.server_name || 'mcp'}__${input.tool_name || ''}`;
  } else if (raw === 'preToolUse') {
    const ti = parseMaybe(input.tool_input);
    command = typeof ti.command === 'string' ? ti.command : '';
    files = require('./claude.cjs').editedFiles(ti);
  }
  const roots = input.workspace_roots || [];
  return {
    agent: name,
    rawEvent: raw,
    event: ev,
    session: input.conversation_id || input.session_id || '',
    cwd: input.cwd || roots[0] || process.cwd(),
    tool, command, files,
    prompt: input.prompt || '',
    title: '',
    notificationType: '',
    message: '',
    lastReply: '',
    source: input.composer_mode || '',
    reason: input.reason || input.status || '',
    ownerPid: 0,
    hostSession: '',
  };
}

function deny(event, reason) {
  return { continue: true, permission: 'deny', user_message: reason, agent_message: reason };
}

function allow(rawEvent) {
  if (rawEvent && !PERMISSION_EVENTS.has(rawEvent) && rawEvent !== 'beforeSubmitPrompt') return null;
  return rawEvent === 'beforeSubmitPrompt' ? { continue: true } : { continue: true, permission: 'allow' };
}

function context(event, text, rawEvent) {
  if (rawEvent === 'sessionStart' && text) return { additional_context: text };
  if (rawEvent === 'beforeSubmitPrompt') return { continue: true };
  return null;
}

module.exports = { name, normalize, deny, allow, context, EVENTS, PERMISSION_EVENTS };
