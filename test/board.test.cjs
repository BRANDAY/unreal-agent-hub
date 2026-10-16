// The board's HTTP surface: Host check (DNS rebinding), page actions only with X-Agent-Hub, node token, state.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { tempHome, loadCfg, rm } = require('./helpers.cjs');
const { createBoard } = require('../lib/server/board.cjs');

function req(port, method, path, headers, body) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const r = http.request({ host: '127.0.0.1', port, method, path, headers: Object.assign(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}, headers || {}) }, res => {
      let d = '';
      res.on('data', c => { d += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    r.on('error', reject);
    r.end(data);
  });
}

test('board: Host check, actions, node token', async () => {
  const port = 18000 + Math.floor(Math.random() * 1000);
  const home = tempHome({ id: 'studio', label: 'Studio', port, resources: [{ id: 'cpp', label: 'C++ build' }],
    nodes: [{ id: 'laptop', label: 'Laptop', ssh: 'laptop', tunnelPort: port + 1, token: 'secret-token', resources: [{ id: 'laptop' }] }] });
  const cfg = loadCfg(home);
  const b = createBoard(cfg, { noTunnels: true, log: false });
  await b.listen();
  try {
    const own = { Host: `127.0.0.1:${port}` };
    assert.equal((await req(port, 'GET', '/state', { Host: 'evil.example:80' })).status, 421, 'a foreign Host is refused');
    assert.equal((await req(port, 'GET', '/state', { Host: `localhost:${port}` })).status, 200);
    assert.equal((await req(port, 'GET', '/state', { Host: `127.0.0.1:${port + 1}` })).status, 200, 'the tunnel port is one of our addresses');
    const st = JSON.parse((await req(port, 'GET', '/state', own)).body);
    assert.deepEqual(st.resources.map(r => r.key).sort(), ['cpp', 'laptop']);
    assert.equal(st.nodes[0].insecure, false);
    assert.equal((await req(port, 'GET', '/', own)).status, 200);
    assert.equal((await req(port, 'GET', '/vendor/react@18.3.1.production.min.js', own)).status, 200);
    assert.equal((await req(port, 'GET', '/i18n/en.json', own)).status, 200);
    assert.equal((await req(port, 'GET', '/../package.json', own)).status, 404);
    // Page actions need the header and a matching Origin.
    assert.equal((await req(port, 'POST', '/api/presence', own, { node: 'laptop', on: true })).status, 403);
    assert.equal((await req(port, 'POST', '/api/presence', Object.assign({ 'X-Agent-Hub': '1', Origin: 'http://evil.example' }, own), { node: 'laptop', on: true })).status, 403);
    const ok = await req(port, 'POST', '/api/presence', Object.assign({ 'X-Agent-Hub': '1', Origin: `http://127.0.0.1:${port}` }, own), { node: 'laptop', on: true });
    assert.equal(ok.status, 200, ok.body);
    assert.equal(b.store.readLock('laptop').mode, 'presence');
    // Node agents: a wrong or missing token is refused.
    const ev = { session: 'n-1', event: 'SessionStart', state: 'idle', title: 'node chat' };
    assert.equal((await req(port, 'POST', '/api/node/event', Object.assign({ 'X-Agent-Hub-Node': 'laptop' }, own), ev)).status, 401);
    assert.equal((await req(port, 'POST', '/api/node/event', Object.assign({ 'X-Agent-Hub-Node': 'laptop', Authorization: 'Bearer nope' }, own), ev)).status, 401);
    const good = await req(port, 'POST', '/api/node/event', Object.assign({ 'X-Agent-Hub-Node': 'laptop', Authorization: 'Bearer secret-token' }, own), ev);
    assert.equal(good.status, 200);
    // The node's own chat passes the person's presence on that machine.
    const hold = JSON.parse((await req(port, 'POST', '/api/node/hold', Object.assign({ 'X-Agent-Hub-Node': 'laptop', Authorization: 'Bearer secret-token' }, own), Object.assign({ tool: 'Bash: UnrealEditor' }, ev))).body);
    assert.equal(hold.ok, true);
    assert.equal(hold.presence, true);
  } finally {
    await b.close();
    rm(home);
  }
});
