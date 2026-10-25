// A child process for the places race test: takes the resource "runs" (2 places) N times through the normal client,
// as one place (shared) or all of them (whole). Inside, a marker file per holder; it counts the moments when more
// holders were inside than the places allow.
'use strict';
const fs = require('fs');
const path = require('path');
const [home, rounds, tag, how] = process.argv.slice(2);
process.env.UAH_HOME = home;
const C = require('../lib/config.cjs');
const { Store } = require('../lib/store.cjs');
const client = require('../lib/lock-client.cjs');

(async () => {
  const cfg = C.load({ env: { UAH_HOME: home } });
  const store = new Store(cfg.stateDir, { machine: cfg.id });
  const inside = path.join(home, 'inside');
  fs.mkdirSync(inside, { recursive: true });
  const shared = how === 'shared';
  let overlaps = 0;
  for (let i = 0; i < Number(rounds); i++) {
    const r = await client.acquire(cfg, store, 'runs', { mode: 'script', script: tag, pollMs: 5, waitMin: 2, chat: tag, ownerPid: 0, shared });
    if (!r.ok) { process.stdout.write(JSON.stringify({ error: r.error })); process.exit(2); }
    const me = path.join(inside, `${shared ? 's' : 'w'}-${tag}-${i}`);
    fs.writeFileSync(me, '');
    const names = fs.readdirSync(inside);
    if (shared ? names.some(n => n.startsWith('w-')) || names.length > 2 : names.length > 1) overlaps++;
    await new Promise(res => setTimeout(res, 2));
    fs.unlinkSync(me);
    client.release(cfg, store, r.key, r.token, 'round done');
  }
  process.stdout.write(JSON.stringify({ overlaps }));
})();
