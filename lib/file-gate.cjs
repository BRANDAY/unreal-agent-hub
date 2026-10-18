// File gate: no races between chats over the same files. It runs on PreToolUse for file edits (Claude Code Edit,
// Write, MultiEdit, NotebookEdit; Codex apply_patch) and reads the `files` block of the profile and of the project
// overlay (docs/FILES.md):
//   build  an edit of what the build compiles waits while ANOTHER chat or script holds the build resource
//          (`buildResource`, "cpp" by default): the build sees one consistent tree, the edit goes on when it is free.
//   claim  the first chat that edits a shared file (a build file or a `claim` path) claims it. While that chat's
//          changes are not committed, another chat's edit of the file is denied with the holder's name: two chats
//          in one file overwrite each other's lines. Different files stay free.
// A claim ends by itself when the file is clean against HEAD (after a short grace: the edit may still be pending), when a commit on a main branch (`mergedInto`) that
// touches the file is at least as new as the holder's last edit (its work is merged, even if the file is dirty
// again from someone else), or after `claimHours` without an edit by its holder. `hub claims` lists them,
// `hub claims release <path>` frees one by hand.
// Claims are one JSON file per edited path in state/claims/, created by an atomic exclusive create, so of two
// chats claiming at the same moment exactly one wins. Edits made through a shell (sed -i, scripts) are not seen.
// Like every hub hook it fails open: an error lets the edit through.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const U = require('./util.cjs');
const C = require('./config.cjs');

const DEFAULTS = {
  build: [], claim: [], free: [], buildResource: 'cpp', claimHours: 6, cleanGraceSec: 120,
  mergedInto: ['main', 'master', 'origin/main', 'origin/master'],
};
const EDIT_TOOLS = /^(Edit|Write|MultiEdit|NotebookEdit|apply_patch|edit_file|write_file)$/i;
const SWEEP_EVERY_MS = 10 * 60e3;
const WIN = process.platform === 'win32';

/** The merged `files` settings (profile, then overlay on top) or null when the gate is off for this project. */
function settings(cfg, profile) {
  const p = profile && profile.files;
  const o = cfg.project ? cfg.project.files : undefined;
  if (o === false || (!p && !o)) return null;
  const s = Object.assign({}, DEFAULTS, p || {}, o || {});
  for (const k of ['build', 'claim', 'free', 'mergedInto']) s[k] = [].concat(s[k] || []);
  return s.build.length || s.claim.length ? s : null;
}

// "Source/**", "**/*.Build.cs", "Config/*.ini": relative to the project root, case-insensitive, "/" separators.
//   **/  any number of folders (also none)    **  anything    *  anything but "/"    ?  one character but "/"
function globRe(g) {
  let re = '';
  const s = String(g).replace(/\\/g, '/');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '*' && s[i + 1] === '*') {
      if (s[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
    } else if (ch === '*') re += '[^/]*';
    else if (ch === '?') re += '[^/]';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$', 'i');
}
const anyMatch = (globs, rel) => globs.some(g => globRe(g).test(rel));

/** {build, claim} for a path relative to the project root; free paths are neither. */
function classify(s, rel) {
  if (!rel || anyMatch(s.free, rel)) return { build: false, claim: false };
  const build = anyMatch(s.build, rel);
  return { build, claim: build || anyMatch(s.claim, rel) };
}

/** The folder the patterns are relative to: the overlay's folder, else the folder of the profile's marker. */
function rootFor(cfg, match, cwd) {
  if (cfg.project && cfg.project.root) return cfg.project.root;
  if (match && match.marker) return path.dirname(match.marker);
  return cwd;
}

/** The paths a tool call edits (absolute), from the normalized event. */
function editedFiles(ev) {
  if (!ev || !EDIT_TOOLS.test(ev.tool || '') || !ev.files || !ev.files.length) return [];
  return ev.files.map(f => path.resolve(ev.cwd || process.cwd(), f));
}

function claimsDir(cfg) { return path.join(cfg.stateDir, 'claims'); }
function normPath(abs) { const p = path.resolve(abs).replace(/\\/g, '/'); return WIN ? p.toLowerCase() : p; }
function claimFile(cfg, abs) {
  return path.join(claimsDir(cfg), crypto.createHash('sha1').update(normPath(abs)).digest('hex').slice(0, 24) + '.json');
}

// git runs in the nearest existing folder of the file (a new file's folder may not exist yet).
function gitCwd(abs) {
  for (let d = path.dirname(abs); ; d = path.dirname(d)) {
    if (fs.existsSync(d)) return d;
    if (path.dirname(d) === d) return d;
  }
}
function git(abs, args) { return execFileSync('git', args, { cwd: gitCwd(abs), encoding: 'utf8', timeout: 8000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }); }

// Uncommitted changes (or untracked) in the file. On a git error (no repository, no git) say "dirty": a claim is
// then kept until it goes idle rather than lost.
function dirty(abs) {
  try { return git(abs, ['status', '--porcelain', '--', abs]).trim() !== ''; } catch (_) { return true; }
}

// The holder's work is merged: a commit touching the file, reachable from a main branch, made at or after the
// holder's last edit (whole seconds: git keeps seconds). A task branch counts once it is merged.
function mergedSince(abs, atMs, branches) {
  try {
    const ct = git(abs, ['log', '-1', '--format=%ct', '--ignore-missing', ...branches, '--', abs]).trim();
    return ct !== '' && Number(ct) * 1000 >= Math.floor(atMs / 1000) * 1000;
  } catch (_) { return false; }
}

/** Whether a claim still holds, and if not, why. */
function claimState(c, now, s) {
  const at = Number(c.at) || 0;
  if (now - at >= (s.claimHours || DEFAULTS.claimHours) * 3600e3) return { active: false, why: 'idle' };
  // A claim is written before its edit lands (the edit may still wait for a permission prompt), so a clean file
  // ends a claim only after a short grace.
  if (!dirty(c.file)) return now - at < (s.cleanGraceSec != null ? s.cleanGraceSec : DEFAULTS.cleanGraceSec) * 1000
    ? { active: true, pending: true } : { active: false, why: 'clean' };
  if (mergedSince(c.file, at, s.mergedInto || DEFAULTS.mergedInto)) return { active: false, why: 'merged' };
  return { active: true };
}

function readClaims(cfg) {
  let names = [];
  try { names = fs.readdirSync(claimsDir(cfg)); } catch (_) { return []; }
  return names.filter(n => n.endsWith('.json')).map(n => Object.assign(U.readJson(path.join(claimsDir(cfg), n)) || {}, { _file: path.join(claimsDir(cfg), n) }))
    .filter(c => c.file);
}

// Drops claims that are over, at most every SWEEP_EVERY_MS, so the folder stays small.
function sweep(cfg, s, now, store, keep) {
  const mark = path.join(claimsDir(cfg), '.swept');
  try { if (now - fs.statSync(mark).mtimeMs < SWEEP_EVERY_MS) return; } catch (_) {}
  try { fs.mkdirSync(claimsDir(cfg), { recursive: true }); fs.writeFileSync(mark, String(now)); } catch (_) { return; }
  for (const c of readClaims(cfg)) {
    if (keep && keep.has(c._file)) continue;
    const st = claimState(c, now, c.settings || s);
    if (!st.active) { U.safeUnlink(c._file); if (store) store.log(`CLAIMEND ${c.rel || c.file} of ${c.chat || c.session} (${st.why})`); }
  }
}

const hhmm = ms => U.hm(ms);

/**
 * Checks one PreToolUse edit. who: {session, chat, agent}. Resolves {ok: true} or {ok: false, reason}.
 * opts: store, client (lock-client), waitSec, pollMs, onWait(key, lock), now.
 */
async function check(cfg, profile, match, ev, who, opts) {
  opts = opts || {};
  const s = settings(cfg, profile);
  const files = editedFiles(ev);
  if (!s || !files.length || !who.session) return { ok: true };
  const root = rootFor(cfg, match, ev.cwd);
  const store = opts.store;
  const items = [];
  for (const abs of files) {
    const rel = path.relative(root, abs).replace(/\\/g, '/');
    if (!rel || rel.startsWith('../') || rel === '..' || path.isAbsolute(rel)) continue;
    const k = classify(s, rel);
    if (k.claim) items.push(Object.assign({ abs, rel }, k));
  }
  if (!items.length) return { ok: true };

  // 1. Build gate: wait (taking nothing) while another chat or script holds the build resource.
  const build = items.find(i => i.build);
  if (build && opts.client && store) {
    const members = C.resolve(cfg, s.buildResource);
    if (members.length) {
      const base = opts.client.isMineFn(members[0].key, who, {});
      const r = await opts.client.gateWait(cfg, store, members[0].key, Object.assign({}, who, {
        script: `${ev.tool}: ${build.rel}`, waitSec: opts.waitSec || cfg.gateWaitSec, pollMs: opts.pollMs,
        isMine: l => (!!who.session && l.session === who.session) || base(l),
        onWait: l => { if (opts.onWait) opts.onWait(members[0].key, l); },
      }));
      if (!r.ok) {
        const { describe } = require('./store.cjs');
        store.log(`SRCDENY ${who.session} ${build.rel} behind ${r.holder ? describe(r.holder) : r.error}`);
        return { ok: false, reason: `${build.rel}: "${members[0].key}" is busy - ${r.holder ? describe(r.holder) : r.error}; waited ` +
          `${Math.round((opts.waitSec || cfg.gateWaitSec || 0) / 60)} min. Edits of what the build compiles wait until the build is done. ` +
          'Do other work and try again later; `hub status` shows the queue. Never stop processes you did not start.' };
      }
      if (r.waited) store.log(`SRCGO ${who.session} ${build.rel} after ${Math.round(r.waitedMs / 1000)} s`);
    }
  }

  // 2. Claims: the first chat to edit a shared file holds it until its work is committed or merged.
  const now = opts.now || Date.now();
  fs.mkdirSync(claimsDir(cfg), { recursive: true });
  for (const it of items) {
    const file = claimFile(cfg, it.abs);
    const rec = { v: 1, file: it.abs, rel: it.rel, root, session: who.session, chat: who.chat || '', agent: who.agent || '',
      machine: cfg.id, since: now, at: now, settings: { claimHours: s.claimHours, cleanGraceSec: s.cleanGraceSec, mergedInto: s.mergedInto } };
    try {
      U.createExclusive(file, rec);
      if (store) store.log(`CLAIM ${it.rel} by ${who.chat || who.session}`);
      continue;
    } catch (e) { if (e.code !== 'EEXIST') throw e; }
    const c = U.readJson(file);
    if (!c || !c.file) { U.writeJson(file, rec); continue; }
    if (c.session === who.session) { U.writeJson(file, Object.assign(rec, { since: c.since || now })); continue; }
    const st = claimState(c, now, s);
    if (st.active) {
      if (store) store.log(`CLAIMDENY ${it.rel} for ${who.chat || who.session}, held by ${c.chat || c.session}`);
      return { ok: false, reason: `${it.rel} is being edited by chat "${c.chat || c.session}" (claimed ${hhmm(c.since)}, last edit ${hhmm(c.at)}); ` +
        'its changes are not committed yet. Two chats in one file overwrite each other, so this edit is refused. ' +
        'Ask that chat to make the change or to commit first. Freeing the claim by hand is for the person in charge: ' +
        `hub claims release "${it.rel}"` };
    }
    U.writeJson(file, rec);
    if (store) store.log(`CLAIMTAKE ${it.rel} by ${who.chat || who.session} (was ${c.chat || c.session}, ${st.why})`);
  }
  sweep(cfg, s, now, store, new Set(items.map(i => claimFile(cfg, i.abs))));
  return { ok: true };
}

/** Every claim on this machine with its state (for `hub claims`). */
function list(cfg, now) {
  now = now || Date.now();
  return readClaims(cfg).map(c => {
    const st = claimState(c, now, c.settings || DEFAULTS);
    const out = Object.assign({}, c, st);
    delete out._file; delete out.settings;
    return out;
  }).sort((a, b) => a.since - b.since);
}

/** Frees the claim on `p` (absolute, or relative to `cwd`). */
function release(cfg, p, cwd, store) {
  const abs = path.resolve(cwd || process.cwd(), p);
  const file = claimFile(cfg, abs);
  const c = U.readJson(file);
  if (!c) return { ok: false, error: `no claim on ${abs}` };
  U.safeUnlink(file);
  if (store) store.log(`CLAIMRELEASE ${c.rel || c.file} by hand (was ${c.chat || c.session})`);
  return { ok: true, claim: c };
}

module.exports = { settings, classify, globRe, rootFor, editedFiles, check, list, release, claimState, claimFile, DEFAULTS, EDIT_TOOLS };
