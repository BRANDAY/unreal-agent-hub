// The node -> hub half of every transport: JSON over HTTP to `hubUrl` (through the reverse tunnel, a LAN or a
// tailnet), with the node's id and token. Any failure returns null, and callers fail open.
'use strict';
const http = require('http');
const https = require('https');

function post(cfg, route, body, timeoutMs) {
  return new Promise(resolve => {
    if (!cfg.hubUrl) return resolve(null);
    let u;
    try { u = new URL(route, cfg.hubUrl); } catch (_) { return resolve(null); }
    const data = Buffer.from(JSON.stringify(body || {}));
    const mod = u.protocol === 'https:' ? https : http;
    const headers = { 'Content-Type': 'application/json', 'Content-Length': data.length, 'X-Agent-Hub-Node': cfg.id };
    if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;
    const req = mod.request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST', timeout: timeoutMs || 1500, headers,
      rejectUnauthorized: cfg.tlsInsecure ? false : true }, res => {
      let d = '';
      res.on('data', c => { d += c; });
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (_) { resolve(null); } });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.end(data);
  });
}

module.exports = { post };
