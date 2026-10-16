// Transport D (stub): a synced folder (OneDrive, Syncthing, SMB) shared by the hub and a node. The node's agent
// writes <folder>/<node>/probe.json and <folder>/<node>/chats/<session>.json; the hub reads them. No ssh, ports or
// tokens: access to the folder is the access control. Holds of the node's resource by its chats would go as a
// request file and an answer file (slow, seconds to a minute). Only the read side is built: see docs/TRANSPORTS.md.
'use strict';
const fs = require('fs');
const path = require('path');
const { readJson, writeJson } = require('../util.cjs');

function create(cfg, node) {
  const dir = node.folder ? path.join(node.folder, node.id) : '';
  return {
    kind: 'folder',
    async probe() {
      if (!dir) return { probe: null, error: 'folder transport: node.folder is not set' };
      const p = readJson(path.join(dir, 'probe.json'));
      return p ? { probe: p, error: '' } : { probe: null, error: `no probe.json in ${dir}` };
    },
    async dump() {
      if (!dir) return { chats: [], error: 'node.folder is not set' };
      let names = [];
      try { names = fs.readdirSync(path.join(dir, 'chats')); } catch (_) {}
      return { chats: names.filter(n => n.endsWith('.json')).map(n => readJson(path.join(dir, 'chats', n))).filter(Boolean), error: '' };
    },
    tunnel() { return () => {}; },
  };
}

// The node side: called by the agent after each probe or chat event when its transport is "folder".
function publish(folder, nodeId, kind, rec) {
  const dir = path.join(folder, nodeId);
  if (kind === 'probe') writeJson(path.join(dir, 'probe.json'), rec);
  else if (kind === 'chat' && rec.session) writeJson(path.join(dir, 'chats', `${rec.session}.json`), rec);
}

module.exports = { create, publish };
