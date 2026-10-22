// Everything the hub says to a person goes through here: one dictionary per language in web/i18n/<lang>.json,
// shared with the board page. Text is built as a message {k, v} and rendered with say(); where it also reaches
// the board (why a run waits, why a lock is stale, why an action failed), the message travels next to the text,
// so the page renders it in the viewer's language rather than the hub's.
//   const { T, msg, say } = require('./i18n.cjs');
//   T('cli.released', { key })                -> "released cpp" in the hub's language (config `lang`, UAH_LANG)
//   const m = msg('busy.using', { machine }); -> { k, v }; say(m), say(m, 'ru')
// Values of v may be messages themselves or arrays of them (joined with " · "). A missing key falls back to
// English, then to the key itself. Log files and events.jsonl stay in English: they are for grep, not for people.
'use strict';
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'web', 'i18n');
const cache = new Map();
let current = 'en';

function dict(lang) {
  if (!cache.has(lang)) {
    let d = {};
    try { d = JSON.parse(fs.readFileSync(path.join(DIR, lang + '.json'), 'utf8')); } catch (_) {}
    cache.set(lang, d);
  }
  return cache.get(lang);
}

/** Languages with a dictionary, English first. */
function langs() {
  let list = [];
  try { list = fs.readdirSync(DIR).filter(f => /^[a-z]{2}\.json$/.test(f)).map(f => f.slice(0, 2)); } catch (_) {}
  return ['en', ...list.filter(l => l !== 'en').sort()];
}

/** `auto` (or nothing) reads the system locale; an unknown language falls back to English. */
function resolve(lang) {
  let l = String(lang || 'auto').toLowerCase();
  if (l === 'auto') {
    const env = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || '';
    let loc = env && env !== 'C' && env !== 'POSIX' ? env : '';
    if (!loc) try { loc = Intl.DateTimeFormat().resolvedOptions().locale; } catch (_) {}
    l = String(loc || 'en').toLowerCase();
  }
  l = l.slice(0, 2);
  return langs().includes(l) ? l : 'en';
}

function setLang(lang) { current = resolve(lang); return current; }
function getLang() { return current; }

const msg = (k, v) => ({ k, v: v || {} });
const isMsg = x => !!x && typeof x === 'object' && typeof x.k === 'string';

/** Text of a message (or a plain string, or an array of either) in `lang`, else the hub's language. */
function say(m, lang) {
  if (m == null) return '';
  if (Array.isArray(m)) return m.map(x => say(x, lang)).filter(Boolean).join(' · ');
  if (!isMsg(m)) return String(m);
  const L = lang || current;
  const d = dict(L), en = dict('en');
  let s = d[m.k] != null ? d[m.k] : en[m.k] != null ? en[m.k] : m.k;
  for (const [name, val] of Object.entries(m.v || {})) {
    s = s.split('{' + name + '}').join(isMsg(val) || Array.isArray(val) ? say(val, L) : val == null ? '' : String(val));
  }
  return s;
}

const T = (k, v, lang) => say(msg(k, v), lang);

/** `{ ok: false, error, errorMsg }` - the text in the hub's language and the message for the board. */
const fail = (k, v, extra) => Object.assign({ ok: false, error: T(k, v), errorMsg: msg(k, v) }, extra || {});

module.exports = { T, msg, say, isMsg, fail, langs, resolve, setLang, getLang, DIR };
