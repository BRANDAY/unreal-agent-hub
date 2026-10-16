// Transport B (stub): the node's agent reaches the hub directly over a LAN or a Tailscale address
// (`hubUrl: "https://hub.tailnet:8790"`), always with its token. The node -> hub half already works through
// lib/transport/client.cjs: only the URL differs from transport A. The hub -> node half (probes on demand) needs
// a small long-poll loop in the agent and is not built yet; until then the hub uses the probe the agent sends
// with its own events. See docs/TRANSPORTS.md.
'use strict';

function create(cfg, node) {
  return {
    kind: 'http',
    async probe() {
      const prev = require('../roles.cjs').readProbe(cfg, node.id);
      if (prev && prev.pushed && Date.now() - prev.fetched < 5 * 60e3) return { probe: prev, error: '' };
      return { probe: null, error: 'http transport: no recent probe pushed by the node (on-demand probes are not built yet)' };
    },
    async dump() { return { chats: [], error: 'http transport: dump is not built yet' }; },
    tunnel() { return () => {}; },
  };
}

module.exports = { create };
