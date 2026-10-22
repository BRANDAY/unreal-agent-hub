// Machine roles (docs/ROLES.md): build, workstation, runner, hub. A machine may have several.
//   - a runner's machine resource can be asked for by role ("role:runner"): the first free runner is taken;
//   - a workstation is busy while a person uses it: their presence mark, profile processes in a desktop session
//     (and `graceMin` after they close), or load above the profile's thresholds (other apps ate the machine).
// The probe of a node is cached in state/<node>.probe.json, shared by every client and the board.
'use strict';
const path = require('path');
const U = require('./util.cjs');
const { msg, say } = require('./i18n.cjs');

function rolesOf(cfg, machineId) {
  if (!machineId || machineId === cfg.id) return cfg.roles || [];
  const n = cfg.nodes.find(x => x.id === machineId);
  return n ? n.roles || [] : [];
}

function probeFile(cfg, id) { return path.join(cfg.stateDir, `${id}.probe.json`); }
function readProbe(cfg, id) { return U.readJson(probeFile(cfg, id)); }

// Keeps `lastBusyAt` across probes: the grace pause after a person closes Unreal is measured from it.
function saveProbe(cfg, id, p, error, by) {
  const prev = readProbe(cfg, id) || {};
  const rec = Object.assign({}, p || {}, {
    fetched: Date.now(), by: by || 'hub', online: !!p, error: error || '',
    lastBusyAt: p && p.busy && (p.reasons || []).includes('processes') ? p.at : prev.lastBusyAt || 0,
  });
  if (!p) Object.assign(rec, { at: prev.at || 0, desktop: prev.desktop || [], gpu: prev.gpu || null, busy: false });
  try { U.writeJson(probeFile(cfg, id), rec); } catch (_) {}
  return rec;
}

/** A fresh enough probe of node `id`: from the cache, or asked over its transport. */
async function getProbe(cfg, id, maxAgeSec) {
  const prev = readProbe(cfg, id);
  if (prev && prev.fetched && Date.now() - prev.fetched < (maxAgeSec || 30) * 1000) return prev;
  const node = cfg.nodes.find(n => n.id === id);
  if (!node) return null;
  const transport = require('./transport/index.cjs').forNode(cfg, node);
  const r = await transport.probe();
  return saveProbe(cfg, id, r.probe, r.error, 'hub');
}

/**
 * Why a person makes machine `id` busy for remote work, or null. `opts.skipGrace` drops the pause after they
 * closed Unreal (a pending handover request counts as "they agreed by closing it").
 */
function humanBusy(cfg, node, p, opts) {
  const human = m => ({ kind: 'human', text: say(m), msg: m });
  opts = opts || {};
  if (!p || !p.online) return null; // offline: the run fails on its own transport, the queue does not guess
  const prof = cfg.profiles[node.profile] || {};
  const grace = Number((prof.busy || {}).graceMin || 0);
  const label = node.label || node.id;
  if (p.busy) {
    const parts = [];
    const names = [...new Set((p.desktop || []).map(d => String(d.name).replace(/\.exe$/i, '')))];
    if (names.length) parts.push(names.join(', '));
    const projects = [...new Set((p.desktop || []).map(d => d.project).filter(Boolean))];
    if (projects.length) parts.push(projects.join(', '));
    if (p.load && p.load.busy) parts.push(...p.load.why);
    if (p.gpu && p.gpu.totalMB) parts.push(msg('busy.gpu', { used: p.gpu.usedMB, total: p.gpu.totalMB }));
    return human(msg('busy.using', { machine: label, parts }));
  }
  if (!opts.skipGrace && grace > 0 && p.lastBusyAt) {
    const ago = (Date.now() - Number(p.lastBusyAt)) / 60e3;
    if (ago < grace) return human(msg('busy.grace', { machine: label, ago: ago.toFixed(1), grace }));
  }
  return null;
}

module.exports = { rolesOf, probeFile, readProbe, saveProbe, getProbe, humanBusy };
