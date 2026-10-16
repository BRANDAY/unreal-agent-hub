// Small shared helpers: JSON files, atomic writes, processes, time. No dependencies.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch (_) { return null; }
}

// Write through a temp file and a rename, so a reader never sees half a file.
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${rand(4)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  try { fs.renameSync(tmp, file); } catch (e) { try { fs.unlinkSync(tmp); } catch (_) {} throw e; }
}

// Create `file` with the full content, or fail with EEXIST if it is already there. The record is written to a
// temp file first and then hard-linked into place: link() is atomic and never overwrites, so a reader sees either
// no file or the whole record. Volumes without hard links (some network shares) fall back to O_EXCL.
function createExclusive(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const data = JSON.stringify(obj, null, 2);
  const tmp = `${file}.${process.pid}.${rand(4)}.new`;
  fs.writeFileSync(tmp, data, 'utf8');
  try {
    fs.linkSync(tmp, file);
  } catch (e) {
    if (e.code === 'EEXIST') { safeUnlink(tmp); throw e; }
    safeUnlink(tmp);
    fs.writeFileSync(file, data, { encoding: 'utf8', flag: 'wx' });
    return;
  }
  safeUnlink(tmp);
}

function safeUnlink(file) { try { fs.unlinkSync(file); return true; } catch (_) { return false; } }

function appendLine(file, line) {
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, line + '\n', 'utf8'); } catch (_) {}
}

function rand(bytes) { return crypto.randomBytes(bytes || 6).toString('hex'); }
function newToken() { return rand(6); }

function pidAlive(pid) {
  pid = Number(pid);
  if (!pid || pid < 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// Start time of a process in ms since the epoch, or 0 when unknown. Cached per pid: a live pid keeps its start.
const startCache = new Map();
function procStart(pid) {
  pid = Number(pid);
  if (!pid) return 0;
  if (startCache.has(pid)) return startCache.get(pid);
  let ms = 0;
  try {
    const cp = require('child_process');
    if (process.platform === 'win32') {
      const out = cp.execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`],
      { encoding: 'utf8', windowsHide: true, timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] });
      ms = Date.parse(out.trim()) || 0;
    } else if (process.platform === 'linux') {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const ticks = Number(fields[19]);
      const btime = Number((fs.readFileSync('/proc/stat', 'utf8').match(/^btime (\d+)/m) || [])[1]);
      if (ticks && btime) ms = Math.round(btime * 1000 + ticks * 10);
    } else {
      const out = cp.execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000 });
      ms = Date.parse(out.trim()) || 0;
    }
  } catch (_) { ms = 0; }
  if (ms) startCache.set(pid, ms);
  return ms;
}

// Alive and, when its start time is known, still the same process (pids get reused).
function sameProcessAlive(pid, start) {
  if (!pidAlive(pid)) return false;
  if (!start) return true;
  const now = procStart(pid);
  if (!now) return true;
  return Math.abs(now - Number(start)) < 2000;
}

function clip(s, n) { return s ? String(s).replace(/\s+/g, ' ').trim().slice(0, n) : ''; }

function hostname() { return (process.env.COMPUTERNAME || os.hostname() || 'machine').toLowerCase(); }

function homeDir() { return process.env.USERPROFILE || process.env.HOME || os.homedir(); }

// "13:04" in local time.
function hm(ms) { const d = new Date(Number(ms)); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; }

function stamp(ms) {
  const d = new Date(ms == null ? Date.now() : ms), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function readStdin(timeoutMs) {
  return new Promise(resolve => {
    let data = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try { resolve(JSON.parse(data.replace(/^﻿/, '') || '{}')); } catch (_) { resolve({}); }
    };
    if (process.stdin.isTTY) return resolve({});
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', c => { data += c; });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
    setTimeout(finish, timeoutMs || 3000).unref();
  });
}

// A simple glob ("*.uproject", "UnrealEditor*") as a case-insensitive RegExp.
function globToRe(g, suffix) {
  return new RegExp('^' + String(g).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + (suffix || '') + '$', 'i');
}

module.exports = {
  readJson, writeJson, createExclusive, safeUnlink, appendLine, rand, newToken, pidAlive, procStart,
  sameProcessAlive, clip, hostname, homeDir, hm, stamp, sleep, readStdin, globToRe,
};
