// The Claude desktop app's own records of its Code sessions: title, archived flag, parent session. They live in
// %APPDATA%/Claude/claude-code-sessions/<account>/<org>/local_*.json (macOS: ~/Library/Application Support/Claude).
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

/** This process's own desktop session record, from the variables the app sets for its sessions. */
function sessionRecord(env) {
  env = env || process.env;
  const host = env.CLAUDE_CODE_HOST_SESSION_ID, acct = env.CLAUDE_CODE_ACCOUNT_UUID, org = env.CLAUDE_CODE_ORGANIZATION_UUID;
  if (!host || !acct || !org) return null;
  const j = readJson(path.join(appDir(env), acct, org, `${host}.json`));
  return j ? toRec(j) : null;
}

function toRec(j) {
  return {
    hostSession: j.sessionId || '', session: j.cliSessionId || '', title: j.title || '', cwd: j.cwd || '',
    archived: !!j.isArchived, lastActivity: j.lastActivityAt || 0, created: j.createdAt || 0,
    parent: (j.spawnedFrom && j.spawnedFrom.sessionId) || '', gitCommonDir: (j.gitAnchors && j.gitAnchors.commonDir) || '',
  };
}

const cache = new Map();
/** Recent desktop sessions (last `recentMs`), cached by file mtime. */
function recent(recentMs, env) {
  const root = appDir(env);
  const out = [];
  let accts = [];
  try { accts = fs.readdirSync(root); } catch (_) { return out; }
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
  return out;
}

/** Opens a chat in the desktop app: claude://code/continue?session=local_<id> (the app accepts only that form). */
function openChat(hostSession) {
  if (!/^local_[A-Za-z0-9-]{1,64}$/.test(String(hostSession || ''))) return { ok: false, error: 'not a desktop session id' };
  const url = `claude://code/continue?session=${hostSession}&source=agent_hub`;
  return Object.assign(require('./platform.cjs').openUrl(url), { url });
}

module.exports = { appDir, sessionRecord, recent, openChat };
