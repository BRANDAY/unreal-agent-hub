// Detector "markers": does a folder belong to a profile? A chat takes part when its folder, a parent or a direct
// child folder holds a marker file (for the unreal profile: *.uproject). Results are cached per process.
'use strict';
const fs = require('fs');
const path = require('path');
const { globToRe } = require('../util.cjs');

const cache = new Map();

function findMarker(cwd, markers, search) {
  if (!cwd || !markers || !markers.length) return null;
  search = search && search.length ? search : ['self', 'parents', 'children'];
  const key = `${path.resolve(cwd)}|${markers.join(',')}|${search.join(',')}`;
  if (cache.has(key)) return cache.get(key);
  const res = markers.map(m => globToRe(m));
  const hit = dir => {
    try { const f = fs.readdirSync(dir).find(n => res.some(re => re.test(n))); return f ? path.join(dir, f) : null; } catch (_) { return null; }
  };
  let found = null;
  const start = path.resolve(cwd);
  if (search.includes('self')) found = hit(start);
  if (!found && search.includes('parents')) {
    for (let d = path.dirname(start); ; d = path.dirname(d)) {
      found = hit(d);
      if (found || path.dirname(d) === d) break;
    }
  }
  if (!found && search.includes('children')) {
    try {
      for (const e of fs.readdirSync(start, { withFileTypes: true })) {
        if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
        found = hit(path.join(start, e.name));
        if (found) break;
      }
    } catch (_) {}
  }
  cache.set(key, found);
  return found;
}

module.exports = { findMarker };
