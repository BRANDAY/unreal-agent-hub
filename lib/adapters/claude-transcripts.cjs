// What a Claude Code chat runs beside itself, read from its own files (the board, lib/server/board.cjs):
//   subagents       <transcript dir>/<session>/subagents/agent-<id>.meta.json and agent-<id>.jsonl
//   cloud sessions  the chat record's `cloud` list (the hook saw start_session) merged with the desktop app's
//                   `cloudSpawnedTasks`; a title the hook did not see is looked up once in the parent's transcript
// These files are Claude Code internals and undocumented: everything here fails quietly to an empty list.
'use strict';
const fs = require('fs');
const path = require('path');
const { readJson, homeDir } = require('../util.cjs');

// A subagent whose meta has no `finished: true` and whose transcript has been silent this long counts as finished.
const SUB_QUIET_MS = 15 * 60e3;
// Subagents older than this (last write) are left out, unless the chat still lists them as running.
const SUB_KEEP_MS = 3 * 3600e3;

/** The chat's transcript: the hook's transcript_path, or the CLI's naming (~/.claude/projects/<cwd as dashes>/<id>.jsonl). */
function transcriptOf(c, home) {
  if (c.transcript) return c.transcript;
  if (!c.cwd || !c.session) return '';
  return path.join(home || homeDir(), '.claude', 'projects', String(c.cwd).replace(/[^A-Za-z0-9]/g, '-'), `${c.session}.jsonl`);
}

function subagentDir(c, home) {
  const t = transcriptOf(c, home);
  return t ? path.join(path.dirname(t), path.basename(t, '.jsonl'), 'subagents') : '';
}

const metaCache = new Map(); // file -> { mtime, meta }

/**
 * Subagents of one chat. `c`: { session, transcript?, cwd?, state, background? }; `alive`: the chat's process is
 * alive. Running = listed in the chat's background tasks, or (alive chat) not finished and written in the last 15 min.
 */
function subagentsOf(c, alive, opts) {
  opts = opts || {};
  const now = opts.now || Date.now();
  const dir = subagentDir(c, opts.home);
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) { return []; }
  const live = c.state === 'background' || c.state === 'working' ? c.background || [] : [];
  const bgRunning = new Set(live.filter(t => /agent/i.test(t.type)).map(t => t.id));
  const out = [];
  for (const n of names) {
    if (!n.startsWith('agent-') || !n.endsWith('.meta.json')) continue;
    const id = n.slice('agent-'.length, -'.meta.json'.length);
    const file = path.join(dir, n), log = path.join(dir, `agent-${id}.jsonl`);
    let mst, lst;
    try { mst = fs.statSync(file); } catch (_) { continue; }
    try { lst = fs.statSync(log); } catch (_) { lst = mst; }
    const last = Math.max(lst.mtimeMs, mst.mtimeMs);
    if (now - last > SUB_KEEP_MS && !bgRunning.has(id)) continue;
    let m = metaCache.get(file);
    if (!m || m.mtime !== mst.mtimeMs) { m = { mtime: mst.mtimeMs, meta: readJson(file) || {} }; metaCache.set(file, m); }
    const meta = m.meta;
    const running = bgRunning.has(id) || (!!alive && meta.finished !== true && !meta.stoppedByUser && now - last < SUB_QUIET_MS);
    out.push({
      id, session: c.session, description: String(meta.description || ''), type: String(meta.agentType || ''), model: String(meta.model || ''),
      name: String(meta.name || ''), background: meta.requestShape === 'background',
      // The meta file is rewritten when the agent ends, so its birth time is the end; the transcript only grows.
      started: Math.round(lst.birthtimeMs || lst.ctimeMs || lst.mtimeMs), last: Math.round(last), running, stopped: !!meta.stoppedByUser,
    });
  }
  return out.sort((a, b) => b.started - a.started);
}

const titleCache = new Map(); // remote id -> title
/** The title a chat gave a cloud session, from its start_session call in the transcript before the session id. */
function cloudTitle(transcript, remote, task) {
  const key = remote || task;
  if (!key || !transcript) return '';
  if (titleCache.has(key)) return titleCache.get(key);
  let title = '';
  try {
    if (fs.statSync(transcript).size > 80 * 1024 * 1024) throw new Error('too big');
    const text = fs.readFileSync(transcript, 'utf8');
    const at = remote && text.indexOf(remote) >= 0 ? text.indexOf(remote) : task ? text.indexOf(task) : -1;
    if (at >= 0) {
      const before = text.slice(Math.max(0, at - 200000), at);
      const calls = [...before.matchAll(/"name":"mcp__[A-Za-z0-9_-]*__start_session","input":\{[^]*?"title":"((?:[^"\\]|\\.)*)"/g)];
      if (calls.length) title = JSON.parse(`"${calls[calls.length - 1][1]}"`);
    }
  } catch (_) {}
  titleCache.set(key, title);
  return title;
}

/**
 * Cloud sessions of one chat: the hook's records (title, start time) merged with the desktop app's list (ids).
 * `rec`: the chat record (cloud, background, state, transcript, cwd, session); `desk`: its desktop record or null.
 */
function cloudOf(rec, desk, opts) {
  opts = opts || {};
  const mine = new Map();
  for (const c of (desk && desk.cloud) || []) mine.set(c.sessionId || c.taskId, { remote: c.sessionId || '', task: c.taskId || '', title: '', started: 0 });
  for (const c of rec.cloud || []) {
    const k = c.remote || c.task;
    if (!k) continue;
    mine.set(k, Object.assign(mine.get(k) || {}, { remote: c.remote || '', task: c.task || '', title: c.title || '', started: Number(c.started) || 0 }));
  }
  const state = opts.state || rec.state;
  const busy = state === 'background' || state === 'working';
  const bgCloud = busy ? (rec.background || []).filter(t => /cloud/i.test(t.type)) : [];
  const out = [];
  for (const c of mine.values()) {
    if (!c.title && c.remote) c.title = cloudTitle(transcriptOf(rec, opts.home), c.remote, c.task);
    const live = bgCloud.find(t => (c.remote && t.id.includes(c.remote)) || (c.task && t.id.includes(c.task)) || (c.title && t.description === c.title));
    out.push(Object.assign(c, {
      status: live ? live.status || 'running' : bgCloud.length ? 'unknown' : 'seen',
      url: /^session_[A-Za-z0-9]+$/.test(c.remote) ? `https://claude.ai/code/${c.remote}` : '',
    }));
  }
  return out;
}

module.exports = { transcriptOf, subagentDir, subagentsOf, cloudTitle, cloudOf, SUB_QUIET_MS, SUB_KEEP_MS };
