// Hook input/output of Claude Code, Codex and Cursor, with payloads shaped as in each agent's documentation
// (test/fixtures/<agent>/*.json).
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { fixture } = require('./helpers.cjs');
const agents = require('../lib/agents/index.cjs');
const { matchGates } = require('../lib/hook.cjs');

const NOENV = {};
const unrealGates = require('../profiles/unreal.json').gates;

test('agent detection from the payload', () => {
  assert.equal(agents.detect(fixture('claude', 'pretooluse-bash'), NOENV), 'claude');
  assert.equal(agents.detect(fixture('codex', 'pretooluse-bash'), NOENV), 'codex');
  assert.equal(agents.detect(fixture('cursor', 'beforeshellexecution'), NOENV), 'cursor');
  // Codex plugin hooks: no turn_id on SessionStart, but Codex sets PLUGIN_ROOT.
  assert.equal(agents.detect({ session_id: 's', hook_event_name: 'SessionStart' }, { PLUGIN_ROOT: '/p' }), 'codex');
});

test('Claude Code: every event normalizes', () => {
  const pre = agents.read(fixture('claude', 'pretooluse-bash'), 'claude', NOENV).ev;
  assert.deepEqual([pre.agent, pre.event, pre.session, pre.cwd, pre.tool, pre.command], ['claude', 'PreToolUse', 'abc123', '/home/user/my-project', 'Bash', 'npm test']);
  assert.equal(agents.read(fixture('claude', 'userpromptsubmit'), '', NOENV).ev.prompt, 'Write a function that rebuilds the lighting');
  const ss = agents.read(fixture('claude', 'sessionstart'), '', NOENV).ev;
  assert.equal(ss.title, 'auth-refactor');
  assert.equal(ss.source, 'resume');
  assert.equal(agents.read(fixture('claude', 'notification'), '', NOENV).ev.notificationType, 'permission_prompt');
  assert.equal(agents.read(fixture('claude', 'stop'), '', NOENV).ev.lastReply, "I've completed the refactor.");
  assert.equal(agents.read(fixture('claude', 'sessionend'), '', NOENV).ev.reason, 'other');
});

test('Claude Code / Codex output: deny and additionalContext', () => {
  const { out } = agents.read(fixture('claude', 'pretooluse-bash'), 'claude', NOENV);
  assert.deepEqual(out.deny('PreToolUse', 'busy'), { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'busy' } });
  assert.equal(out.allow(), null);
  assert.deepEqual(out.context('SessionStart', 'hi'), { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'hi' } });
  assert.equal(out.context('Stop', 'hi'), null);
  const cx = agents.read(fixture('codex', 'pretooluse-bash'), 'codex', NOENV);
  assert.equal(cx.ev.agent, 'codex');
  assert.equal(cx.ev.command, 'RunUAT.bat BuildCookRun -project=Game.uproject');
  assert.equal(cx.out.deny('PreToolUse', 'x').hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(agents.read(fixture('codex', 'stop'), 'codex', NOENV).ev.event, 'Stop');
});

test('Cursor: events, session and folder are mapped to the common shape', () => {
  const sh = agents.read(fixture('cursor', 'beforeshellexecution'), 'cursor', NOENV).ev;
  assert.deepEqual([sh.agent, sh.event, sh.session, sh.cwd, sh.tool, sh.command], ['cursor', 'PreToolUse', 'conv-42', '/Users/me/game', 'Shell', 'UnrealEditor-Cmd Game.uproject -run=cook']);
  const mcp = agents.read(fixture('cursor', 'beforemcpexecution'), 'cursor', NOENV).ev;
  assert.equal(mcp.tool, 'mcp__unreal-mcp__call_tool');
  const pre = agents.read(fixture('cursor', 'pretooluse-shell'), 'cursor', NOENV).ev;
  assert.equal(pre.command, 'npm install');
  assert.equal(agents.read(fixture('cursor', 'beforesubmitprompt'), 'cursor', NOENV).ev.event, 'UserPromptSubmit');
  const ss = agents.read(fixture('cursor', 'sessionstart'), 'cursor', NOENV).ev;
  assert.equal(ss.event, 'SessionStart');
  assert.equal(ss.session, 'conv-42', 'conversation_id is the session on every event');
  assert.equal(agents.read(fixture('cursor', 'stop'), 'cursor', NOENV).ev.event, 'Stop');
});

test('Cursor output: permission answers are always valid JSON', () => {
  const { ev, out } = agents.read(fixture('cursor', 'beforeshellexecution'), 'cursor', NOENV);
  assert.deepEqual(out.allow(ev.rawEvent), { continue: true, permission: 'allow' });
  assert.deepEqual(out.deny('PreToolUse', 'busy'), { continue: true, permission: 'deny', user_message: 'busy', agent_message: 'busy' });
  assert.deepEqual(out.allow('beforeSubmitPrompt'), { continue: true });
  assert.deepEqual(out.context('SessionStart', 'hello', 'sessionStart'), { additional_context: 'hello' });
  assert.equal(out.allow('stop'), null);
});

test('Cursor running hooks from ~/.claude/settings.json: Cursor payload in, Claude answer out', () => {
  const r = agents.read(fixture('cursor', 'beforeshellexecution'), 'claude', NOENV);
  assert.equal(r.inputAgent, 'cursor');
  assert.equal(r.outputAgent, 'claude');
  assert.equal(r.out.deny('PreToolUse', 'x').hookSpecificOutput.permissionDecision, 'deny');
});

test('the unreal profile gates the same heavy work from all three agents', () => {
  const evs = [
    agents.read(fixture('codex', 'pretooluse-bash'), '', NOENV).ev,
    agents.read(fixture('cursor', 'beforeshellexecution'), '', NOENV).ev,
    agents.read(fixture('cursor', 'beforemcpexecution'), '', NOENV).ev,
  ];
  for (const ev of evs) assert.equal(matchGates(unrealGates, ev).length, 1, `${ev.agent} ${ev.tool} ${ev.command}`);
  assert.equal(matchGates(unrealGates, agents.read(fixture('claude', 'pretooluse-bash'), '', NOENV).ev).length, 0, 'npm test is not heavy');
});
