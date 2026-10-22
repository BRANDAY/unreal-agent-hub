// Translations (lib/i18n.cjs, web/i18n/<lang>.json): every language has every key with the same placeholders,
// messages render in the asked language with English fallback, and board-facing reasons travel as messages.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const I = require('../lib/i18n.cjs');

const read = l => JSON.parse(fs.readFileSync(path.join(I.DIR, l + '.json'), 'utf8'));
const holes = s => [...String(s).matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(',');

test('every language has every English key, with the same placeholders', () => {
  const en = read('en');
  for (const l of I.langs().filter(x => x !== 'en')) {
    const d = read(l);
    assert.deepStrictEqual(Object.keys(en).filter(k => !(k in d)), [], `${l}: missing keys`);
    for (const k of Object.keys(en)) assert.strictEqual(holes(d[k]), holes(en[k]), `${l}: placeholders of ${k}`);
  }
});

test('say() renders nested messages and arrays in the asked language, English for unknown keys', () => {
  const m = I.msg('err.busy', { key: 'cpp', why: I.msg('stale.ttl', { min: 5 }) });
  assert.strictEqual(I.say(m, 'en'), 'cpp is busy: TTL of 5 min is over');
  assert.strictEqual(I.say(m, 'ru'), 'cpp занят: TTL 5 мин истёк');
  assert.strictEqual(I.say([I.msg('busy.gpu', { used: 1, total: 2 }), 'x'], 'en'), 'GPU 1/2 MB · x');
  assert.strictEqual(I.say(I.msg('no.such.key'), 'ru'), 'no.such.key');
  assert.strictEqual(I.resolve('xx'), 'en');
  assert.strictEqual(I.fail('err.lockGone').errorMsg.k, 'err.lockGone');
});

test('a lock description and a busy machine come with a message the board can translate', () => {
  const { describeMsg } = require('../lib/store.cjs');
  const lock = { mode: 'hold', chat: 'Lights', since: Date.UTC(2026, 0, 1, 10, 0), expires: 0, note: '' };
  assert.match(I.say(describeMsg(lock), 'ru'), /^чат «Lights» \(/);
  const roles = require('../lib/roles.cjs');
  const cfg = { profiles: { unreal: {} } };
  const b = roles.humanBusy(cfg, { id: 'lap', label: 'Laptop', profile: 'unreal' }, { online: true, busy: true, desktop: [{ name: 'UnrealEditor.exe' }] });
  assert.strictEqual(b.text, I.say(b.msg));
  assert.match(I.say(b.msg, 'ru'), /^за Laptop кто-то работает \(UnrealEditor\)$/);
});
