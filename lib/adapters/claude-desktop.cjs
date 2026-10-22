// The Claude desktop app's own records of its Code sessions: title, archived flag, parent session, the cloud sessions
// it started. They live in <root>/<account>/<org>/local_*.json, where <root> is
// %APPDATA%/Claude/claude-code-sessions or, for newer Windows builds, %LOCALAPPDATA%/Claude-Data/<profile>/claude-code-sessions
// (macOS: ~/Library/Application Support/Claude/claude-code-sessions).
// This is undocumented and may move between app versions, so every function here fails quietly: without it the
// board names chats by session_id and session_title from the hook events.
'use strict';
const fs = require('fs');
const path = require('path');
const { readJson, homeDir } = require('../util.cjs');

function appDir(env) {
  env = env || process.env;
  if (env.APPDATA) return path.join(env.APPDATA, 'Claude', 'claude-code-sessions');
  if (process.platform === 'darwin') return path.join(homeDir(), 'Library', 'Application Support', 'Claude', 'claude-code-sessions');
  return path.join(homeDir(), '.config', 'Claude', 'claude-code-sessions');
}

/** Every folder that may hold session records: the classic one and each profile under %LOCALAPPDATA%/Claude-Data. */
function roots(env) {
  env = env || process.env;
  const out = [appDir(env)];
  if (env.LOCALAPPDATA) {
    const base = path.join(env.LOCALAPPDATA, 'Claude-Data');
    let names = [];
    try { names = fs.readdirSync(base); } catch (_) {}
    for (const n of names) out.push(path.join(base, n, 'claude-code-sessions'));
  }
  return out.filter(d => { try { return fs.statSync(d).isDirectory(); } catch (_) { return false; } });
}

/** This process's own desktop session record, from the variables the app sets for its sessions. */
function sessionRecord(env) {
  env = env || process.env;
  const host = env.CLAUDE_CODE_HOST_SESSION_ID, acct = env.CLAUDE_CODE_ACCOUNT_UUID, org = env.CLAUDE_CODE_ORGANIZATION_UUID;
  if (!host || !acct || !org) return null;
  for (const root of roots(env)) {
    const j = readJson(path.join(root, acct, org, `${host}.json`));
    if (j) return toRec(j);
  }
  return null;
}

function toRec(j) {
  return {
    hostSession: j.sessionId || '', session: j.cliSessionId || '', title: j.title || '', cwd: j.cwd || '',
    archived: !!j.isArchived, lastActivity: j.lastActivityAt || 0, created: j.createdAt || 0,
    parent: (j.spawnedFrom && j.spawnedFrom.sessionId) || '', gitCommonDir: (j.gitAnchors && j.gitAnchors.commonDir) || '',
    // Cloud sessions this chat started: [{ taskId, sessionId: "session_..." }] (undocumented field).
    cloud: Array.isArray(j.cloudSpawnedTasks) ? j.cloudSpawnedTasks.filter(c => c && (c.sessionId || c.taskId)) : [],
  };
}

const cache = new Map();
/** Recent desktop sessions (last `recentMs`), cached by file mtime. */
function recent(recentMs, env) {
  const out = [];
  for (const root of roots(env)) {
  let accts = [];
  try { accts = fs.readdirSync(root); } catch (_) { continue; }
  for (const a of accts) {
    let orgs = [];
    try { orgs = fs.readdirSync(path.join(root, a)); } catch (_) { continue; }
    for (const o of orgs) {
      const dir = path.join(root, a, o);
      let names = [];
      try { names = fs.readdirSync(dir); } catch (_) { continue; }
      for (const n of names) {
        if (!n.startsWith('local_') || !n.endsWith('.json')) continue;
        const file = path.join(dir, n);
        let st;
        try { st = fs.statSync(file); } catch (_) { continue; }
        if (Date.now() - st.mtimeMs > recentMs) continue;
        let c = cache.get(file);
        if (!c || c.mtime !== st.mtimeMs) { const j = readJson(file); c = { mtime: st.mtimeMs, rec: j && toRec(j) }; cache.set(file, c); }
        if (c.rec && (!c.rec.lastActivity || Date.now() - c.rec.lastActivity < recentMs)) out.push(c.rec);
      }
    }
  }
  }
  return out;
}

/** Opens a chat in the desktop app: claude://code/continue?session=local_<id> (the app accepts only that form). */
function openChat(hostSession) {
  if (!/^local_[A-Za-z0-9-]{1,64}$/.test(String(hostSession || ''))) return { ok: false, error: 'not a desktop session id' };
  const url = `claude://code/continue?session=${hostSession}&source=agent_hub`;
  return Object.assign(require('./platform.cjs').openUrl(url), { url });
}

module.exports = { appDir, roots, sessionRecord, recent, openChat, toRec };
