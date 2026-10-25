// What the previous holder left behind (`hub stamp` / `hub whose`, docs/CLI.md). A lock says who goes now, not what
// the one before left: a chat that runs its required checks right after another chat's experimental build gets
// that build. So the step that makes something others will use (a build script, a level load through the gate)
// stamps it - who, when, the commit, and the time and size of its files - and the step that uses it asks whose it is.
//   state/stamps/<key>.json   key = <project>~<name> inside a project with an overlay, else <name>
// A stamp whose files changed since is "unknown": something made them outside the stamping step.
'use strict';
const fs = require('fs');
const path = require('path');
const U = require('./util.cjs');
const C = require('./config.cjs');
const { msg } = require('./i18n.cjs');

function key(cfg, name) {
  const id = C.safeId(name);
  return cfg.project ? `${cfg.project.id}~${id}` : id;
}

function file(cfg, name) { return path.join(cfg.stateDir, 'stamps', `${key(cfg, name)}.json`); }

function rootOf(cfg, cwd) { return (cfg.project && cfg.project.root) || cwd || process.cwd(); }

// "Binaries/Win64/UnrealEditor-*.dll": a wildcard in the file name only; the folder is taken as written.
function expand(root, patterns) {
  const out = [];
  for (const p of [].concat(patterns || []).filter(Boolean)) {
    const abs = path.resolve(root, p);
    const base = path.basename(abs);
    if (!/[*?]/.test(base)) { if (fs.existsSync(abs)) out.push(abs); continue; }
    let names = [];
    try { names = fs.readdirSync(path.dirname(abs)); } catch (_) {}
    const re = U.globToRe(base);
    for (const n of names.sort()) if (re.test(n)) out.push(path.join(path.dirname(abs), n));
  }
  return [...new Set(out)];
}

function fileStamps(root, files) {
  return files.map(f => {
    try { const st = fs.statSync(f); return { path: path.relative(root, f).replace(/\\/g, '/'), mtime: Math.round(st.mtimeMs), size: st.size }; } catch (_) { return null; }
  }).filter(Boolean);
}

function git(root, args) {
  try {
    const r = require('child_process').spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    return r.status === 0 ? String(r.stdout) : null;
  } catch (_) { return null; }
}

/**
 * Stamps `name` for `who`. opts: files (patterns relative to the project root), note, value (what it is, such as
 * a level path), cwd. Returns the record.
 */
function write(cfg, name, who, opts) {
  opts = opts || {};
  const root = rootOf(cfg, opts.cwd);
  const patterns = [].concat(opts.files || []).filter(Boolean);
  const head = git(root, ['rev-parse', '--short', 'HEAD']);
  const status = head != null ? git(root, ['status', '--porcelain']) : null;
  const rec = {
    v: 1, name: C.safeId(name), key: key(cfg, name), at: Date.now(), machine: cfg.id,
    chat: who.chat || '', session: who.session || '', agent: who.agent || '', note: opts.note || '', value: opts.value || '',
    commit: head ? head.trim() : '', dirty: status != null ? status.split('\n').filter(Boolean).length : 0,
    root, patterns, files: fileStamps(root, expand(root, patterns)),
  };
  U.writeJson(file(cfg, name), rec);
  return rec;
}

function read(cfg, name) { return U.readJson(file(cfg, name)); }

/**
 * Is `name` this chat's own? {known, mine, changed, rec, m} where m is a message (or a list of them) for say():
 * stamp.none / stamp.changed / stamp.mine / stamp.other, then stamp.commit and stamp.dirty.
 */
function check(cfg, name, who) {
  const rec = read(cfg, name);
  const n = C.safeId(name);
  if (!rec) return { known: false, mine: false, changed: false, rec: null, m: msg('stamp.none', { name: n }) };
  const by = rec.chat || rec.session || rec.machine || '?';
  const at = U.hm(rec.at);
  let changed = false;
  if ((rec.patterns || []).length) {
    const now = fileStamps(rec.root, expand(rec.root, rec.patterns));
    const was = rec.files || [];
    changed = now.length !== was.length || now.some(f => {
      const w = was.find(x => x.path === f.path);
      return !w || w.size !== f.size || Math.abs(w.mtime - f.mtime) > 1000;
    });
  }
  if (changed) return { known: true, mine: false, changed: true, rec, m: msg('stamp.changed', { name: n, chat: by, at }) };
  const tail = [rec.commit ? msg('stamp.commit', { commit: rec.commit }) : null, rec.dirty ? msg('stamp.dirty', { n: rec.dirty }) : null].filter(Boolean);
  const mine = !!(rec.session && who.session && rec.session === who.session);
  const what = rec.value ? `${n} ${rec.value}` : n;
  return { known: true, mine, changed: false, rec, m: [msg(mine ? 'stamp.mine' : 'stamp.other', { name: what, chat: by, at }), ...tail] };
}

module.exports = { key, file, expand, write, read, check };
