// Configuration, merged from three layers (top wins on conflicts, lists are joined):
//   1. plugin options  CLAUDE_PLUGIN_OPTION_<KEY> (role, node_id, hub_url, token) and UAH_* environment variables
//   2. project overlay  .unreal-agent-hub.json in the project root (found upwards from the chat's folder)
//   3. machine          ~/.unreal-agent-hub/config.json  (UAH_HOME moves the whole folder)
// Profiles come from the package's profiles/ folder and can be overridden by `profiles` in the machine config.
'use strict';
const fs = require('fs');
const path = require('path');
const { readJson, hostname, homeDir } = require('./util.cjs');

const PKG_ROOT = path.resolve(__dirname, '..');
const OVERLAY_NAME = '.unreal-agent-hub.json';

const DEFAULTS = {
  role: 'hub',
  roles: ['hub', 'build', 'workstation'],
  port: 8790,
  lang: 'en',
  name: 'Unreal Agent Hub',
  resources: [],
  nodes: [],
  priorities: { presence: 100, 'node-chat': 50, hold: 40, script: 30, gate: 30 },
  aging: { everyMin: 10, step: 10 },
  presenceTtlMin: 180,
  presence: { blocks: ['remote'] },
  handover: { ask: true, notify: ['board'], askAgainMin: 15, askAgain: true, skipGraceWhenAsked: true, restorePresence: true },
  share: { prompt: 'clip160' },
  ssh: { path: 'auto', connectTimeoutSec: 5 },
  gateWaitSec: 1500,
  defaultTtlMin: 60,
  holdTtlMin: 60,
  waitMin: 240,
  board: { allowHosts: [] },
  profile: '',
};

function home(env) {
  env = env || process.env;
  return path.resolve(env.UAH_HOME || path.join(homeDir(), '.unreal-agent-hub'));
}
function stateDir(env) { return path.join(home(env), 'state'); }

// The project overlay nearest to `cwd` (this folder or a parent).
function findOverlay(cwd) {
  if (!cwd) return null;
  for (let d = path.resolve(cwd); ; d = path.dirname(d)) {
    const f = path.join(d, OVERLAY_NAME);
    if (fs.existsSync(f)) return f;
    if (path.dirname(d) === d) return null;
  }
}

function loadProfiles(machineProfiles) {
  const out = {};
  for (const dir of [path.join(PKG_ROOT, 'profiles'), path.join(PKG_ROOT, 'profiles', 'examples')]) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch (_) { continue; }
    for (const n of names) {
      if (!n.endsWith('.json')) continue;
      const p = readJson(path.join(dir, n));
      if (p && p.name && !out[p.name]) out[p.name] = Object.assign(p, { example: dir.endsWith('examples') });
    }
  }
  for (const [name, p] of Object.entries(machineProfiles || {})) out[name] = Object.assign({}, out[name] || {}, p, { name });
  return out;
}

function pluginOption(env, key) {
  const v = env[`CLAUDE_PLUGIN_OPTION_${key.toUpperCase()}`];
  return v == null || v === '' ? undefined : v;
}

// Sanitized id usable in file names: letters, digits, dot, dash, underscore.
function safeId(s) { return String(s || '').trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64); }

/**
 * Loads the merged configuration.
 * @param {{cwd?: string, env?: object, machineFile?: string}} opts
 */
function load(opts) {
  opts = opts || {};
  const env = opts.env || process.env;
  const machineFile = opts.machineFile || path.join(home(env), 'config.json');
  const machine = readJson(machineFile) || {};
  const cfg = Object.assign({}, DEFAULTS, machine);
  for (const k of ['priorities', 'aging', 'handover', 'share', 'ssh', 'board', 'presence']) cfg[k] = Object.assign({}, DEFAULTS[k], machine[k] || {});
  cfg.id = safeId(machine.id || hostname());
  cfg.label = machine.label || cfg.id;
  cfg.home = home(env);
  cfg.stateDir = stateDir(env);
  cfg.machineFile = machineFile;
  cfg.machineFileExists = fs.existsSync(machineFile);

  // Plugin options and environment variables.
  const role = pluginOption(env, 'role') || env.UAH_ROLE;
  if (role) cfg.role = role;
  const nodeId = pluginOption(env, 'node_id') || env.UAH_NODE_ID;
  if (nodeId) cfg.id = safeId(nodeId);
  const hubUrl = pluginOption(env, 'hub_url') || env.UAH_HUB_URL;
  if (hubUrl) cfg.hubUrl = hubUrl;
  const token = pluginOption(env, 'token') || env.UAH_NODE_TOKEN;
  if (token) cfg.token = token;
  if (env.UAH_PORT) cfg.port = Number(env.UAH_PORT);
  if (env.UAH_LANG) cfg.lang = env.UAH_LANG;
  if (env.UAH_GATE_WAIT_SEC) cfg.gateWaitSec = Number(env.UAH_GATE_WAIT_SEC);

  cfg.profiles = loadProfiles(machine.profiles);
  cfg.resources = (cfg.resources || []).map(r => normalizeResource(r, 'machine'));
  cfg.nodes = (cfg.nodes || []).map(n => Object.assign({ roles: ['runner'], transport: 'ssh-reverse', profile: 'unreal' }, n, {
    id: safeId(n.id),
    resources: (n.resources && n.resources.length ? n.resources : [{ id: safeId(n.id) }])
      .map(r => normalizeResource(Object.assign({ ttlMin: 180, label: n.label || n.id, icon: 'machine' }, r), 'machine', n.id)),
  }));

  // Project overlay.
  const overlayFile = opts.overlayFile || findOverlay(opts.cwd);
  cfg.project = null;
  if (overlayFile) {
    const o = readJson(overlayFile) || {};
    const pid = safeId(o.project || path.basename(path.dirname(overlayFile)));
    cfg.project = {
      id: pid, root: path.dirname(overlayFile), file: overlayFile, label: o.label || o.project || pid,
      resources: (o.resources || []).map(r => normalizeResource(r, 'project', null, pid)),
      gates: o.gates || [], profile: o.profile || '', files: o.files,
    };
    if (o.labels) cfg.projectLabels = o.labels;
  }
  return cfg;
}

function normalizeResource(r, defScope, nodeId, projectId) {
  const scope = r.scope || defScope;
  const out = Object.assign({ ttlMin: 60, label: r.id, icon: '' }, r, { id: safeId(r.id), scope });
  if (nodeId) { out.node = nodeId; out.kind = 'machine'; }
  if (scope === 'project') out.project = projectId;
  out.key = scope === 'project' ? `${projectId}~${out.id}` : out.id;
  return out;
}

// Every resource the hub knows: its own, every node's machine resource and every project overlay it has seen
// (state/projects/<id>.json is written whenever a chat or script of that project uses the hub).
function allResources(cfg) {
  const out = [...cfg.resources];
  for (const n of cfg.nodes) for (const r of n.resources) out.push(r);
  const seen = new Set(out.map(r => r.key));
  const projDir = path.join(cfg.stateDir, 'projects');
  let names = [];
  try { names = fs.readdirSync(projDir); } catch (_) {}
  const projects = names.filter(n => n.endsWith('.json')).map(n => readJson(path.join(projDir, n))).filter(Boolean);
  if (cfg.project) projects.push(cfg.project);
  for (const p of projects) {
    for (const r of p.resources || []) {
      const nr = normalizeResource(r, 'project', null, p.id);
      if (!seen.has(nr.key)) { seen.add(nr.key); out.push(Object.assign(nr, { projectLabel: p.label })); }
    }
  }
  return out;
}

// Records the current project's resources, so the board lists them even before anyone takes one.
function rememberProject(cfg) {
  if (!cfg.project || !cfg.project.resources.length) return;
  const file = path.join(cfg.stateDir, 'projects', `${cfg.project.id}.json`);
  const rec = { id: cfg.project.id, label: cfg.project.label, root: cfg.project.root,
    resources: cfg.project.resources.map(r => ({ id: r.id, ttlMin: r.ttlMin, label: r.label, icon: r.icon })) };
  const cur = readJson(file);
  if (cur && JSON.stringify(cur) === JSON.stringify(rec)) return;
  try { require('./util.cjs').writeJson(file, rec); } catch (_) {}
}

/**
 * Resolves a name the user typed to resource records:
 *   "cpp"            a machine resource or, when an overlay is active, a project resource of that id
 *   "proj~editor"    a project resource by its full key
 *   "@machine"       this machine's own machine resource (a node: its resource; the hub: hub.machineResource)
 *   "@node:laptop"   the machine resource of node "laptop"
 *   "role:runner"    every machine resource whose machine has the role (a pool: the first free one is taken)
 */
function resolve(cfg, name) {
  name = String(name || '').trim();
  const all = allResources(cfg);
  if (name.startsWith('role:')) {
    const role = name.slice(5);
    const out = [];
    for (const n of cfg.nodes) if ((n.roles || []).includes(role)) out.push(...n.resources);
    if ((cfg.roles || []).includes(role)) out.push(...all.filter(r => r.kind === 'machine' && !r.node));
    return out;
  }
  if (name === '@machine') {
    const own = cfg.role === 'node' ? cfg.nodeResource || cfg.id : cfg.machineResource;
    if (!own) return [];
    return all.filter(r => r.key === own).length ? all.filter(r => r.key === own)
      : [normalizeResource({ id: own, ttlMin: cfg.holdTtlMin }, 'machine', cfg.role === 'node' ? cfg.id : null)];
  }
  if (name.startsWith('@node:')) {
    const n = cfg.nodes.find(x => x.id === safeId(name.slice(6)));
    return n ? n.resources.slice(0, 1) : [];
  }
  if (cfg.project) {
    const pr = cfg.project.resources.find(r => r.id === name);
    if (pr) return [pr];
  }
  const hit = all.find(r => r.key === name) || all.find(r => r.id === name && r.scope !== 'project');
  if (hit) return [hit];
  if (cfg.allowUnknown) return [normalizeResource({ id: name, ttlMin: cfg.defaultTtlMin }, 'machine')];
  return [];
}

// The node that owns a machine resource key, if any.
function nodeOf(cfg, key) {
  for (const n of cfg.nodes) if (n.resources.some(r => r.key === key)) return n;
  return null;
}

// Which profile a folder belongs to: the first profile whose markers are found (self, parents, direct children).
function profileFor(cfg, cwd) {
  const { findMarker } = require('./detect/markers.cjs');
  const forced = (cfg.project && cfg.project.profile) || cfg.profile;
  // `generic` matches any project with an overlay, so it is tried last: a specific profile (a .uproject) wins.
  const list = Object.values(cfg.profiles).filter(p => !p.example || p.name === forced)
    .sort((a, b) => (a.name === 'generic') - (b.name === 'generic'));
  if (forced && cfg.profiles[forced]) list.unshift(cfg.profiles[forced]);
  for (const p of list) {
    if (!p.match || !(p.match.markers || []).length) continue;
    const hit = findMarker(cwd, p.match.markers, p.match.search);
    if (hit) return { profile: p, marker: hit };
  }
  return null;
}

module.exports = {
  PKG_ROOT, OVERLAY_NAME, DEFAULTS, home, stateDir, findOverlay, load, allResources, rememberProject, resolve,
  nodeOf, profileFor, safeId, normalizeResource, loadProfiles,
};
