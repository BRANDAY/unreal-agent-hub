// `hub install-hooks --agent claude|codex|cursor [--uninstall] [--dry-run] [--file <settings>]`
// The path without a plugin: writes the hub's hook entries into the agent's user settings, marked by the command
// itself, so running it again replaces them and --uninstall removes exactly them. The previous file is kept
// beside it as <file>.bak-agent-hub-<time>.
//   claude  ~/.claude/settings.json    (Cursor reads these too, through Third-Party Imports)
//   codex   ~/.codex/hooks.json        (Codex runs them only after you trust them with /hooks)
//   cursor  ~/.cursor/hooks.json       (only for machines without Claude Code hooks: otherwise they run twice)
'use strict';
const fs = require('fs');
const path = require('path');
const U = require('./util.cjs');
const C = require('./config.cjs');

const MARK = 'unreal-agent-hub';

function hubCommand(cfg, agent) {
  const shim = path.join(cfg.home, 'bin', 'hub.cjs').replace(/\\/g, '/');
  return `node "${shim}" hook --agent ${agent}`;
}

function defaultFile(agent) {
  const home = U.homeDir();
  return { claude: path.join(home, '.claude', 'settings.json'), codex: path.join(home, '.codex', 'hooks.json'),
    cursor: path.join(home, '.cursor', 'hooks.json') }[agent];
}

const isOurs = h => String((h && h.command) || '').includes(MARK) || /hub\.cjs"?\s+hook\b/.test(String((h && h.command) || ''));

// Claude Code and Codex share one shape: hooks -> event -> [{matcher, hooks: [{type, command, timeout}]}].
function nested(doc, agent, cmd, install) {
  doc.hooks = doc.hooks || {};
  for (const ev of Object.keys(doc.hooks)) {
    doc.hooks[ev] = (doc.hooks[ev] || []).map(g => Object.assign({}, g, { hooks: (g.hooks || []).filter(h => !isOurs(h)) })).filter(g => g.hooks.length);
    if (!doc.hooks[ev].length) delete doc.hooks[ev];
  }
  if (!install) return doc;
  const add = (ev, h, matcher) => { (doc.hooks[ev] = doc.hooks[ev] || []).push(Object.assign(matcher ? { matcher } : {}, { hooks: [Object.assign({ type: 'command', command: cmd }, h)] })); };
  add('SessionStart', { timeout: 10 });
  add('UserPromptSubmit', { timeout: 10 });
  add('PreToolUse', { timeout: 1800, statusMessage: 'Unreal Agent Hub: waiting for a shared resource' }, agent === 'codex' ? '^(Bash|shell|apply_patch|mcp__.*)$' : 'Bash|PowerShell|Edit|Write|MultiEdit|NotebookEdit|mcp__.*');
  if (agent === 'claude') add('Notification', { timeout: 10, async: true });
  // The desktop app's start_session tool: records cloud sessions this chat starts (they run no local hooks).
  if (agent === 'claude') add('PostToolUse', { timeout: 10, async: true }, 'mcp__.*__start_session');
  add('Stop', agent === 'claude' ? { timeout: 10, async: true } : { timeout: 10 });
  add('SessionEnd', agent === 'claude' ? { timeout: 10 } : { timeout: 3 });
  return doc;
}

// Cursor: {version: 1, hooks: {event: [{command, timeout, matcher?}]}}.
function flat(doc, cmd, install) {
  doc.version = doc.version || 1;
  doc.hooks = doc.hooks || {};
  for (const ev of Object.keys(doc.hooks)) {
    doc.hooks[ev] = (doc.hooks[ev] || []).filter(h => !isOurs(h));
    if (!doc.hooks[ev].length) delete doc.hooks[ev];
  }
  if (!install) return doc;
  const add = (ev, h) => { (doc.hooks[ev] = doc.hooks[ev] || []).push(Object.assign({ command: cmd }, h)); };
  add('sessionStart', { timeout: 10 });
  add('beforeSubmitPrompt', { timeout: 10 });
  add('beforeShellExecution', { timeout: 1800 });
  add('beforeMCPExecution', { timeout: 1800 });
  add('stop', { timeout: 10 });
  add('sessionEnd', { timeout: 10 });
  return doc;
}

function run(opts) {
  const agent = opts.agent || 'claude';
  if (!['claude', 'codex', 'cursor'].includes(agent)) throw new Error(`unknown agent "${agent}" (claude, codex, cursor)`);
  const cfg = opts.cfg || C.load({});
  const file = opts.file || defaultFile(agent);
  const install = !opts.uninstall;
  const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replace(/^﻿/, '') : '';
  const doc = raw.trim() ? JSON.parse(raw) : {};
  const cmd = hubCommand(cfg, agent);
  const next = agent === 'cursor' ? flat(doc, cmd, install) : nested(doc, agent, cmd, install);
  const text = JSON.stringify(next, null, 2) + '\n';
  const notes = [];
  if (agent === 'codex' && install) {
    notes.push('Codex runs new hooks only after you trust them: open Codex and run /hooks.');
    notes.push(`MCP server (optional) - add to ~/.codex/config.toml:\n[mcp_servers.unreal-agent-hub]\ncommand = "node"\nargs = ["${path.join(cfg.home, 'bin', 'hub.cjs').replace(/\\/g, '/')}", "mcp"]`);
  }
  if (agent === 'cursor' && install) {
    const claude = defaultFile('claude');
    try { if (JSON.stringify(U.readJson(claude) || {}).includes(MARK)) notes.push(`Warning: ${claude} already has the hub's hooks, and Cursor runs those too. Remove one of the two.`); } catch (_) {}
  }
  if (opts.dryRun) return { file, text, notes, changed: text !== raw };
  if (!install && !raw) return { file, notes: ['nothing to remove'], changed: false };
  if (install) require('./hook.cjs').ensureShim(cfg);
  let backup = '';
  if (raw) {
    backup = `${file}.bak-agent-hub-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
    fs.copyFileSync(file, backup);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
  return { file, backup, notes, changed: true };
}

module.exports = { run, nested, flat, hubCommand, defaultFile, MARK };
