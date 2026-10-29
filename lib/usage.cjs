// What the Claude Code tokens of the chats would cost at API prices: a counter for the board. Many people pay by
// subscription; the number says "what this work would have cost", not a bill. Counted from the Claude Code journals
// (~/.claude/projects/<folder>/<session>.jsonl and their subagents): one response is an assistant line with `usage`;
// consecutive lines of the same message.id|requestId are one response (output = the largest). Prices: lib/prices.json
// or the machine config's `usage.prices` file (same shape).
//
// Which journals: the folders of the projects the hub knows (Claude Code names a folder after the chat's working
// directory with every character other than a letter or digit turned into "-", so a project root and its worktrees
// share a prefix), or `usage.match` (a regular expression over folder names; "*" = every folder).
//
// Incremental: for every journal file the cache (state/usage/<machine>.json) keeps the byte offset already read and
// token sums per day and model, so a pass reads only what was appended. `hub serve` scans this machine every
// `usage.everySec` (60 s) in a child process and each node over its transport every `usage.nodeEveryMin` (15 min)
// while nobody uses it and its resource is free; summarize() prices the sums of all machines for the board.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULTS = { enabled: true, everySec: 60, nodeEveryMin: 15, match: '', prices: '', root: '' }; // root: the journals (default ~/.claude/projects)
const PRICES_FILE = path.join(__dirname, 'prices.json');
const CHUNK = 8 << 20;
const USAGE = Buffer.from('"usage"');
const TITLE = Buffer.from('"custom-title"');
const USER = Buffer.from('"type":"user"');

function settings(cfg) { return Object.assign({}, DEFAULTS, (cfg && cfg.usage) || {}); }

/** The Claude Code journal folder name of a working directory. */
function folderOf(dir) { return String(dir || '').replace(/[^A-Za-z0-9]/g, '-'); }

/** A test over journal folder names: `match` (regex, "*" = all), else the roots of the projects the hub knows. */
function matcher(cfg, match) {
  const m = match != null ? match : settings(cfg).match;
  if (m === '*') return () => true;
  if (m) { const re = new RegExp(m, 'i'); return name => re.test(name); }
  const roots = new Set();
  const dir = path.join(cfg.stateDir, 'projects');
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) {}
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    try { const p = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); if (p && p.root) roots.add(folderOf(p.root).toLowerCase()); } catch (_) {}
  }
  if (cfg.project && cfg.project.root) roots.add(folderOf(cfg.project.root).toLowerCase());
  const list = [...roots];
  return name => { const l = String(name).toLowerCase(); return list.some(r => l === r || l.startsWith(r + '-')); };
}

// --- scanning --------------------------------------------------------------------------------------------------
function dayOf(ts, tzmin) {
  const t = Date.parse(ts);
  return Number.isFinite(t) ? new Date(t + tzmin * 60e3).toISOString().slice(0, 10) : '?';
}

// The price key of a model: the id without a date suffix, or its long-context variant (prices.longContext).
function modelOf(m, ctx, prices) {
  const k = String(m || '?').replace(/-\d{8}$/, '');
  const lc = prices && prices.longContext;
  if (lc) for (const [base, r] of Object.entries(lc)) if (k.startsWith(base) && ctx > Number(r.above)) return r.use;
  return k;
}

function addLine(rec, o, tzmin, prices) {
  const m = o.message;
  const u = m && m.usage;
  if (!u || typeof u !== 'object') return;
  let key = (m.id || '') + '|' + (o.requestId || '');
  if (key === '|') key = 'n' + rec.steps;
  const out = u.output_tokens || 0;
  const L = rec.last;
  if (L && L.key === key) {
    if (out > L.o) { rec.days[L.d][L.mk][4] += out - L.o; L.o = out; }
    return;
  }
  const cc = u.cache_creation || {};
  let w5 = cc.ephemeral_5m_input_tokens, w1 = cc.ephemeral_1h_input_tokens;
  if (w5 == null && w1 == null) { w5 = u.cache_creation_input_tokens || 0; w1 = 0; }
  const i = u.input_tokens || 0, cr = u.cache_read_input_tokens || 0;
  const mk = modelOf(m.model, i + (w5 || 0) + (w1 || 0) + cr, prices);
  const d = dayOf(o.timestamp, tzmin);
  const day = rec.days[d] || (rec.days[d] = {});
  const b = day[mk] || (day[mk] = [0, 0, 0, 0, 0]);
  b[0] += i; b[1] += w5 || 0; b[2] += w1 || 0; b[3] += cr; b[4] += out;
  rec.steps++;
  rec.last = { key, o: out, d, mk };
}

function firstPrompt(o) {
  const c = o.message && o.message.content;
  const text = typeof c === 'string' ? c : Array.isArray(c) ? (c.find(b => b && b.type === 'text') || {}).text : '';
  if (!text || /^<(command|local-command|system-reminder)/.test(text.trim())) return '';
  return text.replace(/\s+/g, ' ').trim().slice(0, 160);
}

/** Reads what was appended to `file` since rec.off. Returns true when something was read. */
function scanFile(file, rec, tzmin, prices) {
  let st;
  try { st = fs.statSync(file); } catch (_) { return false; }
  if (st.size === rec.size) return false;
  if (st.size < rec.off) Object.assign(rec, { off: 0, steps: 0, days: {}, last: null }); // rewritten: start over
  const fd = fs.openSync(file, 'r');
  try {
    let pos = rec.off, start = rec.off, carry = null; // start: file offset of buf[0]
    while (pos < st.size) {
      const n = Math.min(CHUNK, st.size - pos);
      let buf = Buffer.allocUnsafe(n);
      const got = fs.readSync(fd, buf, 0, n, pos);
      if (got <= 0) break;
      pos += got;
      buf = carry ? Buffer.concat([carry, buf.subarray(0, got)]) : buf.subarray(0, got);
      let a = 0, nl;
      while ((nl = buf.indexOf(10, a)) >= 0) {
        const line = buf.subarray(a, nl);
        // A chat's name: its custom title, else its first prompt.
        const want = line.indexOf(USAGE) >= 0 || line.indexOf(TITLE) >= 0 || (!rec.first && line.indexOf(USER) >= 0);
        if (want) {
          let o = null;
          try { o = JSON.parse(line.toString('utf8')); } catch (_) {}
          if (!o) { /* a broken line */ } else if (o.type === 'assistant') addLine(rec, o, tzmin, prices);
          else if (o.type === 'custom-title' && o.customTitle) rec.title = String(o.customTitle).slice(0, 160);
          else if (o.type === 'user' && !rec.first) rec.first = firstPrompt(o);
        }
        a = nl + 1;
      }
      start += a;
      rec.off = start;
      carry = a < buf.length ? Buffer.from(buf.subarray(a)) : null;
    }
  } finally { fs.closeSync(fd); }
  rec.size = st.size;
  return true;
}

/** Every journal file of the matching folders: [{key, sid, folder, file}]; key = "<sid>/<agent|main>". */
function journals(root, test) {
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory() && test(d.name)); } catch (_) { return out; }
  for (const d of dirs) {
    const pdir = path.join(root, d.name);
    let names = [];
    try { names = fs.readdirSync(pdir); } catch (_) { continue; }
    for (const f of names) {
      if (!f.endsWith('.jsonl')) continue;
      const sid = f.slice(0, -6);
      out.push({ key: sid + '/main', sid, folder: d.name, file: path.join(pdir, f) });
      const walk = dir => {
        let es = [];
        try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
        for (const e of es) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) { if (e.name !== 'scripts') walk(p); continue; }
          if (e.name.endsWith('.jsonl') && e.name.startsWith('agent-')) out.push({ key: sid + '/' + e.name.slice(6, -6), sid, folder: d.name, file: p });
        }
      };
      walk(path.join(pdir, sid));
    }
  }
  return out;
}

function readCache(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; } }
function cacheFile(cfg, machine) { return path.join(cfg.stateDir, 'usage', `${machine}.json`); }

/**
 * One pass. opts: root (journals, default ~/.claude/projects), cache (file), test (folder filter), tzmin (day
 * boundaries; default this machine's), machine, prices. The cache is updated in place (temp file, then rename).
 */
function scan(opts) {
  const tzmin = opts.tzmin != null && opts.tzmin !== '' ? Number(opts.tzmin) : -new Date().getTimezoneOffset();
  let cache = readCache(opts.cache);
  if (!cache || cache.v !== 2 || cache.tzmin !== tzmin) cache = { v: 2, tzmin, files: {} };
  let changed = false;
  for (const j of journals(opts.root || path.join(os.homedir(), '.claude', 'projects'), opts.test || (() => true))) {
    const rec = cache.files[j.key] || (cache.files[j.key] = { sid: j.sid, folder: j.folder, off: 0, size: -1, steps: 0, days: {}, last: null });
    if (scanFile(j.file, rec, tzmin, opts.prices)) changed = true;
  }
  cache.machine = opts.machine || os.hostname();
  cache.at = Date.now();
  if (changed || !fs.existsSync(opts.cache)) {
    fs.mkdirSync(path.dirname(opts.cache), { recursive: true });
    const tmp = opts.cache + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cache));
    // Windows refuses the rename while another scan (the board's and a manual one) has the file open: retry briefly.
    for (let i = 0; ; i++) {
      try { fs.renameSync(tmp, opts.cache); break; } catch (e) {
        if (i < 40 && ['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); continue; }
        try { fs.unlinkSync(tmp); } catch (_) {}
        throw e;
      }
    }
  }
  return cache;
}

// --- pricing ---------------------------------------------------------------------------------------------------
function pricesFile(cfg) {
  const p = settings(cfg).prices;
  return p ? path.resolve(cfg.home || '.', p) : PRICES_FILE;
}
function loadPrices(cfg) { try { return JSON.parse(fs.readFileSync(pricesFile(cfg), 'utf8')); } catch (_) { return null; } }

function priceOf(prices, mk) {
  const M = prices.models || {};
  if (M[mk]) return M[mk];
  const k = Object.keys(M).sort((a, b) => b.length - a.length).find(x => mk.startsWith(x));
  return k ? M[k] : null;
}

const usd = (b, p) => (b[0] * p[0] + b[1] * p[1] + b[2] * p[2] + b[3] * p[3] + b[4] * p[4]) / 1e6;
const r2 = x => Math.round(x * 100) / 100;

/**
 * Machines' caches -> the board's numbers. A journal seen on two machines (a copied profile) counts once, the copy
 * with more responses. `today` is the hub's local date string.
 */
function summarize(caches, prices, today) {
  const files = new Map();
  for (const c of caches) for (const [k, r] of Object.entries((c && c.files) || {})) {
    const cur = files.get(k);
    if (!cur || r.steps > cur.steps) files.set(k, r);
  }
  const byDay = new Map(), bySid = new Map(), byModel = new Map(), names = new Map();
  for (const [k, r] of files) if (k.endsWith('/main') && (r.title || r.first)) names.set(r.sid, r.title || r.first);
  let total = 0, responses = 0;
  const unpriced = new Set();
  for (const r of files.values()) {
    responses += r.steps;
    for (const [d, models] of Object.entries(r.days || {})) {
      for (const [mk, b] of Object.entries(models)) {
        const p = priceOf(prices, mk);
        if (!p) { if (b[4] || b[0]) unpriced.add(mk); continue; }
        const x = usd(b, p);
        total += x;
        byDay.set(d, (byDay.get(d) || 0) + x);
        byModel.set(mk, (byModel.get(mk) || 0) + x);
        const s = bySid.get(r.sid) || { sid: r.sid, usd: 0, today: 0, last: '', folder: r.folder || '' };
        s.usd += x;
        if (d === today) s.today += x;
        if (d > s.last) s.last = d;
        bySid.set(r.sid, s);
      }
    }
  }
  const days = [...byDay.entries()].filter(([d]) => d !== '?').sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const sids = [...bySid.values()];
  const row = s => ({ sid: s.sid, name: names.get(s.sid) || '', folder: s.folder, usd: r2(s.usd), today: r2(s.today), last: s.last });
  return {
    total: r2(total), today: r2(byDay.get(today) || 0), responses, files: files.size, since: days.length ? days[0][0] : '',
    days: days.map(([date, v]) => ({ date, usd: r2(v) })),
    models: [...byModel.entries()].sort((a, b) => b[1] - a[1]).map(([model, v]) => ({ model, usd: r2(v) })),
    chats: sids.sort((a, b) => b.usd - a.usd).slice(0, 40).map(row),
    chatsToday: sids.filter(s => s.today > 0).sort((a, b) => b.today - a.today).slice(0, 20).map(row),
    unpriced: [...unpriced].filter(m => m !== '<synthetic>'),
    prices: { read: prices.read || '', source: prices.source || '' },
  };
}

function localDate(t) { return new Date(t - new Date(t).getTimezoneOffset() * 60e3).toISOString().slice(0, 10); }

module.exports = { DEFAULTS, settings, folderOf, matcher, scan, summarize, loadPrices, pricesFile, journals, readCache, cacheFile, modelOf, localDate };
