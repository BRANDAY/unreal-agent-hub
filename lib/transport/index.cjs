// Transports between the hub and its nodes (docs/TRANSPORTS.md):
//   ssh-reverse  (A, default)  hub keeps `ssh -N -R`; probes over ssh
//   http         (B, partial)  node talks to the hub's address directly, with its token
//   folder       (D, partial)  a synced folder both sides read and write
// Remote Control messages (C) are not a transport: they only notify a person (lib/notify.cjs).
'use strict';

const KINDS = {
  'ssh-reverse': () => require('./ssh-reverse.cjs'),
  http: () => require('./http-direct.cjs'),
  folder: () => require('./folder.cjs'),
};

function forNode(cfg, node) {
  const k = KINDS[node.transport || 'ssh-reverse'] || KINDS['ssh-reverse'];
  return k().create(cfg, node);
}

module.exports = { forNode, KINDS };
