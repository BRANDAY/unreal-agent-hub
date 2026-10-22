// Chats (agent sessions) as the board shows them: one small file per session in state/chats/, written by the
// hooks of this machine or, for a node's chats, by the board from the node's events. Best effort: a lost update
// costs one stale field until the next event.
'use strict';
const fs = require('fs');
const path = require('path');
const U = require('./util.cjs');

const ACTIVE_MS = 12 * 3600e3;

function dir(cfg) { return path.join(cfg.stateDir, 'chats'); }
function file(cfg, sid) { return path.join(dir(cfg), `${String(sid).replace(/[^A-Za-z0-9._-]/g, '_')}.json`); }

function read(cfg, sid) { return sid ? U.readJson(file(cfg, sid)) : null; }

function update(cfg, sid, fields) {
  if (!sid) return null;
  const cur = read(cfg, sid) || { session: sid, started: Date.now() };
  const next = Object.assign(cur, fields, { updated: Date.now() });
  try { U.writeJson(file(cfg, sid), next); } catch (_) {}
  return next;
}

function list(cfg) {
  let names = [];
  try { names = fs.readdirSync(dir(cfg)); } catch (_) { return []; }
  return names.filter(n => n.endsWith('.json')).map(n => U.readJson(path.join(dir(cfg), n))).filter(Boolean);
}

function event(cfg, rec) { U.appendLine(path.join(cfg.stateDir, 'chats.jsonl'), JSON.stringify(Object.assign({ t: Date.now() }, rec))); }

// The prompt as the board shows it: without the <system-reminder> blocks an app adds, a message from another
// session as "from <name>: <text>", a background notice as a short tag.
function promptText(p) {
  let s = String(p || '').replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ');
  const m = s.match(/<cross-session-message[^>]*?(?:name="([^"]*)")?[^>]*>([\s\S]*?)(?:<\/cross-session-message>|$)/);
  if (m) s = `from ${m[1] || 'another session'}: ${m[2]}`;
  else if (/<task-notification>/.test(s)) s = '(background task notice)';
  else if (/<agent-message\b/.test(s)) s = '(subagent report)';
  else if (/<side-sessions-event>/.test(s)) s = '(side session report)';
  return s;
}

/** The prompt text a node may send to the hub, per share.prompt: none | clip160 | full. */
function sharedPrompt(cfg, text) {
  const mode = (cfg.share && cfg.share.prompt) || 'clip160';
  if (mode === 'none') return '';
  const t = promptText(text);
  return mode === 'full' ? U.clip(t, 4000) : U.clip(t, 160);
}

function active(c) { return c && c.state !== 'ended' && Date.now() - Number(c.updated || 0) < ACTIVE_MS; }

// --- background work (Claude Code) ------------------------------------------------------------------------------
// Stop carries background_tasks: what keeps running after the turn (shell, subagent, monitor, workflow, teammate,
// cloud session, ...). Only the unfinished ones matter; a chat with any of them is "working in the background", not
// waiting for a prompt.
const DONE = /^(completed|done|finished|failed|error|killed|stopped|cancell?ed)$/i;

/** The unfinished background tasks of a Stop payload (null when the payload has no list at all). */
function backgroundOf(list) {
  if (!Array.isArray(list)) return null;
  return list.filter(t => t && !DONE.test(String(t.status || ''))).slice(0, 20).map(t => ({
    id: String(t.id || ''), type: String(t.type || ''), status: String(t.status || ''),
    description: U.clip(t.description || t.name || t.command, 160), agentType: String(t.agent_type || ''),
    command: U.clip(t.command, 160),
  }));
}

/** Task ids a prompt reports as finished: <task-notification><task-id>X</task-id><status>completed</status>. */
function finishedIds(prompt) {
  const ids = [];
  for (const m of String(prompt || '').matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
    const id = (m[1].match(/<task-id>([^<]+)<\/task-id>/) || [])[1];
    const st = (m[1].match(/<status>([^<]+)<\/status>/) || [])[1] || '';
    if (id && DONE.test(st.trim())) ids.push(id.trim());
  }
  return ids;
}

const START_SESSION = /^mcp__[A-Za-z0-9_-]*__start_session$/;
/**
 * A cloud session this chat started (PostToolUse of the desktop app's start_session tool with target "cloud").
 * Cloud sessions run no local hooks, so the chat that started them is the only witness.
 */
function cloudStart(tool, toolInput, toolResponse) {
  const ti = toolInput || {};
  if (!START_SESSION.test(String(tool || '')) || String(ti.target || '') !== 'cloud') return null;
  const out = typeof toolResponse === 'string' ? toolResponse : JSON.stringify(toolResponse || '');
  return {
    title: U.clip(ti.title, 120), started: Date.now(),
    remote: (out.match(/session_[A-Za-z0-9]{10,}/) || [])[0] || '',
    task: (out.match(/task_[a-f0-9]{6,}/) || [])[0] || '',
  };
}

module.exports = { dir, file, read, update, list, event, promptText, sharedPrompt, active, backgroundOf, finishedIds, cloudStart,
  ACTIVE_MS, DONE };
