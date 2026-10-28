// `hub mcp-proxy install --agent claude|codex|cursor [--uninstall] [--dry-run] [--file <config>]`
// Points the agent's `unreal-mcp` entry at `hub mcp-proxy --stdio` (one proxy per chat). The name stays, so the hub's
// gates (^mcp__unreal-mcp__) and the chat's tool permissions do not change; the editor's URL moves into the proxy's
// --upstream. The previous entry is kept in state/mcp-proxy/installed.json (codex: commented out beside the new one)
// and the whole file as <file>.bak-agent-hub-<time>; --uninstall puts the previous entry back.
//   claude  the project's .mcp.json if it has the entry, else ~/.claude.json (user scope, or this project's local
//           scope) if that has it, else a new entry in the project's .mcp.json
//   codex   ~/.codex/config.toml, [mcp_servers.unreal-mcp]
//   cursor  ~/.cursor/mcp.json (a project's .cursor/mcp.json with --file)
'use strict';
const fs = require('fs');
const path = require('path');
const U = require('./util.cjs');
const C = require('./config.cjs');
const { T } = require('./i18n.cjs');

const NAME = 'unreal-mcp';
const TOML_BEGIN = '# >>> unreal-agent-hub mcp-proxy: `hub mcp-proxy install --agent codex --uninstall` restores the entry it replaced';
const TOML_END = '# <<< unreal-agent-hub mcp-proxy';
const TOML_SAVED = '#| ';
const TIMEOUT_SEC = 1800; // a tool call may wait for the editor (waitSec 900) and then run

function shim(cfg) { return path.join(cfg.home, 'bin', 'hub.cjs').replace(/\\/g, '/'); }
function proxyArgs(cfg, upstream) { return [shim(cfg), 'mcp-proxy', '--stdio', '--upstream', upstream]; }

const isOurs = e => !!e && Array.isArray(e.args) && e.args.includes('mcp-proxy') && e.args.some(x => /hub\.cjs$/.test(String(x)));
const firstUrl = list => (list || []).map(String).find(x => /^https?:\/\//.test(x));

/** The editor's URL in an entry: its url, an http(s) argument (mcp-remote and the like), or our --upstream. */
function urlOf(e) {
  if (!e) return '';
  if (isOurs(e)) { const i = e.args.indexOf('--upstream'); return i >= 0 ? String(e.args[i + 1] || '') : ''; }
  return e.url || e.serverUrl || firstUrl(e.args) || '';
}

function projectRoot(cfg, cwd) {
  if (cfg.project && cfg.project.root) return cfg.project.root;
  const m = C.profileFor(cfg, cwd);
  return m && m.marker ? path.dirname(m.marker) : cwd;
}

const normPath = p => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

// Where in a JSON document the server entries are: [{where, servers}], the ones that have unreal-mcp first.
function containers(doc, root, claudeJson) {
  const out = [{ where: 'mcpServers', get: () => doc.mcpServers, make: () => (doc.mcpServers = doc.mcpServers || {}) }];
  if (claudeJson && doc.projects && typeof doc.projects === 'object') {
    for (const k of Object.keys(doc.projects)) {
      if (normPath(k) !== normPath(root)) continue;
      const p = doc.projects[k];
      out.unshift({ where: `projects/${k}/mcpServers`, get: () => p && p.mcpServers, make: () => (p.mcpServers = p.mcpServers || {}) });
    }
  }
  return out;
}

function findEntry(doc, root, claudeJson) {
  return containers(doc, root, claudeJson).find(c => c.get() && c.get()[NAME]) || null;
}

function readDoc(file) {
  const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replace(/^﻿/, '') : '';
  return { raw, doc: raw.trim() ? JSON.parse(raw) : {} };
}

function defaultFile(agent, cfg, cwd) {
  const home = U.homeDir();
  if (agent === 'codex') return path.join(home, '.codex', 'config.toml');
  if (agent === 'cursor') return path.join(home, '.cursor', 'mcp.json');
  const root = projectRoot(cfg, cwd);
  const project = path.join(root, '.mcp.json');
  const user = path.join(home, '.claude.json');
  for (const f of [project, user]) {
    try { if (fs.existsSync(f) && findEntry(readDoc(f).doc, root, f === user)) return f; } catch (_) {}
  }
  return project;
}

function recordFile(cfg) { return path.join(cfg.stateDir, 'mcp-proxy', 'installed.json'); }

// --- JSON configs (claude, cursor) -------------------------------------------------------------------------------
function editJson(raw, doc, o) {
  const notes = [];
  const claudeJson = path.basename(o.file) === '.claude.json';
  const hit = findEntry(doc, o.root, claudeJson);
  const key = `${path.resolve(o.file)}#${hit ? hit.where : 'mcpServers'}`;
  const rec = o.records[key];
  let upstream = '';
  if (o.install) {
    const c = hit || containers(doc, o.root, claudeJson).find(x => x.where === 'mcpServers');
    const servers = c.make();
    const cur = servers[NAME];
    upstream = urlOf(cur) || o.upstream;
    if (!isOurs(cur)) o.records[key] = { previous: cur === undefined ? null : cur, agent: o.agent, at: new Date().toISOString() };
    if (cur === undefined) notes.push(T('proxy.added', { file: o.file, upstream }));
    const args = proxyArgs(o.cfg, upstream);
    // Claude Code's per-server tool timeout (ms) must outlast the proxy's wait for the editor and the hook's gate.
    servers[NAME] = o.agent === 'claude'
      ? { type: 'stdio', command: 'node', args, timeout: Math.max(Number(cur && cur.timeout) || 0, TIMEOUT_SEC * 1000) }
      : { command: 'node', args };
  } else {
    const cur = hit && hit.get()[NAME];
    if (!isOurs(cur)) return { text: raw, notes: [T('proxy.nothing', { file: o.file })], changed: false };
    upstream = urlOf(cur);
    const prev = rec && rec.previous !== undefined ? rec.previous
      : upstream ? (o.agent === 'claude' ? { type: 'http', url: upstream } : { url: upstream }) : null;
    if (prev === null) delete hit.get()[NAME]; else hit.get()[NAME] = prev;
    delete o.records[key];
  }
  if (claudeJson) notes.push(T('proxy.claudeJson'));
  const text = JSON.stringify(doc, null, 2) + '\n';
  return { text, notes, changed: text !== raw, upstream };
}

// --- TOML (codex) ------------------------------------------------------------------------------------------------
const SECTION = /^\s*\[\s*mcp_servers\.(?:"unreal-mcp"|'unreal-mcp'|unreal-mcp)(?:\.[^\]]*)?\s*\]\s*(?:#.*)?$/;
const HEADER = /^\s*\[/;

// The lines without our block, with the entry it replaced put back.
function tomlStrip(lines) {
  const b = lines.indexOf(TOML_BEGIN), e = lines.indexOf(TOML_END);
  if (b < 0 || e < b) return { lines, ours: null };
  const block = lines.slice(b + 1, e);
  const saved = block.filter(l => l.startsWith(TOML_SAVED)).map(l => l.slice(TOML_SAVED.length));
  const url = (block.join('\n').match(/"--upstream",\s*"([^"]+)"/) || [])[1] || '';
  return { lines: [...lines.slice(0, b), ...saved, ...lines.slice(e + 1)], ours: { url } };
}

function editToml(raw, o) {
  const eol = /\r\n/.test(raw) ? '\r\n' : '\n';
  const st = tomlStrip(raw ? raw.split(/\r?\n/) : []);
  if (!o.install) {
    if (!st.ours) return { text: raw, notes: [T('proxy.nothing', { file: o.file })], changed: false };
    const text = st.lines.join(eol);
    return { text, notes: [], changed: text !== raw, upstream: st.ours.url };
  }
  const lines = st.lines;
  const notes = [];
  let a = lines.findIndex(l => SECTION.test(l)), z = a;
  if (a >= 0) { z = a + 1; while (z < lines.length && !(HEADER.test(lines[z]) && !SECTION.test(lines[z]))) z++; }
  const old = a >= 0 ? lines.slice(a, z) : [];
  while (old.length && !old[old.length - 1].trim()) { old.pop(); z--; }
  const oldText = old.join('\n');
  const upstream = (oldText.match(/^\s*url\s*=\s*["']([^"']+)["']/m) || [])[1] || (oldText.match(/https?:\/\/[^\s"',\]]+/) || [])[0] || o.upstream;
  if (a < 0) notes.push(T('proxy.added', { file: o.file, upstream }));
  const block = [TOML_BEGIN, ...old.map(l => TOML_SAVED + l), `[mcp_servers.${NAME}]`, 'command = "node"',
    `args = [${proxyArgs(o.cfg, upstream).map(x => JSON.stringify(x)).join(', ')}]`, `tool_timeout_sec = ${TIMEOUT_SEC}`, TOML_END];
  let out;
  if (a >= 0) out = [...lines.slice(0, a), ...block, ...lines.slice(z)];
  else {
    out = lines.slice();
    while (out.length && !out[out.length - 1].trim()) out.pop();
    out = [...out, ...(out.length ? [''] : []), ...block, ''];
  }
  const text = out.join(eol);
  return { text, notes, changed: text !== raw, upstream };
}

/**
 * opts: {agent, uninstall, dryRun, file, cfg, cwd}. Returns {file, text?, backup, notes, changed, upstream}.
 */
function run(opts) {
  const agent = opts.agent || 'claude';
  if (!['claude', 'codex', 'cursor'].includes(agent)) throw new Error(`unknown agent "${agent}" (claude, codex, cursor)`);
  const cfg = opts.cfg || C.load({ cwd: opts.cwd });
  const cwd = opts.cwd || process.cwd();
  const file = opts.file || defaultFile(agent, cfg, cwd);
  const install = !opts.uninstall;
  const MP = require('./mcp-proxy.cjs');
  const match = C.profileFor(cfg, cwd);
  const s = MP.settings(cfg, (match && match.profile) || cfg.profiles.unreal || {}, match);
  const records = U.readJson(recordFile(cfg)) || {};
  const o = { agent, install, file, cfg, root: projectRoot(cfg, cwd), upstream: s.upstream, records };
  let r;
  if (agent === 'codex') r = editToml(fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replace(/^﻿/, '') : '', o);
  else { const d = readDoc(file); r = editJson(d.raw, d.doc, o); }
  if (install) r.notes.push(T('proxy.reconnect'));
  if (opts.dryRun) return { file, text: r.text, notes: r.notes, changed: r.changed, upstream: r.upstream };
  if (!r.changed) return { file, notes: r.notes, changed: false, upstream: r.upstream };
  if (install) require('./hook.cjs').ensureShim(cfg);
  let backup = '';
  if (fs.existsSync(file)) {
    backup = `${file}.bak-agent-hub-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
    fs.copyFileSync(file, backup);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, r.text, 'utf8');
  if (agent !== 'codex') { try { U.writeJson(recordFile(cfg), records); } catch (_) {} }
  return { file, backup, notes: r.notes, changed: true, upstream: r.upstream };
}

module.exports = { run, editJson, editToml, defaultFile, isOurs, urlOf, NAME, TOML_BEGIN, TOML_END };
