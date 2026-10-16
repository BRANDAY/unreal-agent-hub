// A child process for the lock race test: takes the resource N times through the normal client, and inside the
// lock checks that nobody else is inside (a marker file), then releases.
'use strict';
const fs = require('fs');
const path = require('path');
const [home, rounds, tag] = process.argv.slice(2);
process.env.UAH_HOME = home;
const C = require('../lib/config.cjs');
const { Store } = require('../lib/store.cjs');
const client = require('../lib/lock-client.cjs');

(async () => {
  const cfg = C.load({ env: { UAH_HOME: home } });
  const store = new Store(cfg.stateDir, { machine: cfg.id });
  const marker = path.join(home, 'inside');
  let overlaps = 0;
  for (let i = 0; i < Number(rounds); i++) {
    const r = await client.acquire(cfg, store, 'res', { mode: 'script', script: tag, pollMs: 5, waitMin: 2, chat: tag, ownerPid: 0 });
    if (!r.ok) { process.stdout.write(JSON.stringify({ error: r.error })); process.exit(2); }
    try { fs.writeFileSync(marker, tag, { flag: 'wx' }); } catch (_) { overlaps++; }
    await new Promise(res => setTimeout(res, 2));
    try { fs.unlinkSync(marker); } catch (_) { overlaps++; }
    client.release(cfg, store, r.key, r.token, 'round done');
  }
  process.stdout.write(JSON.stringify({ overlaps }));
})();
