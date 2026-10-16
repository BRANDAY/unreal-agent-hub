// Shared test helpers: an isolated home folder per test (UAH_HOME), never the real ~/.unreal-agent-hub.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

function tempHome(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uah-test-'));
  if (config) fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config, null, 2));
  return dir;
}

function loadCfg(home, extra) {
  const C = require('../lib/config.cjs');
  return C.load(Object.assign({ env: { UAH_HOME: home } }, extra || {}));
}

function fixture(agent, name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', agent, name + '.json'), 'utf8'));
}

function rm(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} }

module.exports = { tempHome, loadCfg, fixture, rm };
