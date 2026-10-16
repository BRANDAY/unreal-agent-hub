// Detector "processes": which processes of a profile run on this machine, and whether a person started them.
//   Windows  tasklist /fo csv: a process in a desktop session (Session# != 0) counts as "a person uses it";
//            the hub's own ssh runs live in session 0 and do not count.
//   POSIX    ps -eo: a process with a terminal or under a graphical session counts; processes whose session
//            leader is sshd do not (best effort, see docs/PROFILES.md).
'use strict';
const cp = require('child_process');
const { globToRe } = require('../util.cjs');

function listWindows() {
  let out = '';
  try { out = cp.execFileSync('tasklist', ['/fo', 'csv', '/nh'], { encoding: 'latin1', windowsHide: true, timeout: 15000 }); } catch (_) { return []; }
  const rows = [];
  for (const line of out.split(/\r?\n/)) {
    // "Image Name","PID","Session Name","Session#","Mem Usage"; Session# is not localized, memory is.
    const m = line.match(/^"([^"]*)","(\d+)","[^"]*","(\d+)","([^"]*)"/);
    if (m) rows.push({ name: m[1], pid: +m[2], desktop: +m[3] !== 0, memMB: Math.round((+m[4].replace(/\D/g, '') || 0) / 1024) });
  }
  return rows;
}

function listPosix() {
  let out = '';
  try { out = cp.execFileSync('ps', ['-eo', 'pid=,sess=,tty=,rss=,comm='], { encoding: 'utf8', timeout: 10000 }); } catch (_) { return []; }
  const sshSessions = new Set();
  const rows = [];
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.+)$/);
    if (!m) continue;
    const r = { pid: +m[1], sess: +m[2], tty: m[3], memMB: Math.round(+m[4] / 1024), name: m[5].split('/').pop() };
    if (/^sshd/.test(r.name)) sshSessions.add(r.sess);
    rows.push(r);
  }
  return rows.map(r => ({ name: r.name, pid: r.pid, memMB: r.memMB, desktop: !sshSessions.has(r.sess) }));
}

function list() { return process.platform === 'win32' ? listWindows() : listPosix(); }

/** Processes matching the profile's patterns, split into {desktop, remote}. */
function match(patterns, rows) {
  const res = (patterns || []).map(p => globToRe(p, process.platform === 'win32' ? '(\\.exe)?' : ''));
  rows = rows || list();
  const hits = rows.filter(r => res.some(re => re.test(r.name)));
  return { desktop: hits.filter(r => r.desktop), remote: hits.filter(r => !r.desktop) };
}

module.exports = { list, match, listWindows, listPosix };
