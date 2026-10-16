// Transport A (default): the hub opens everything, the node opens nothing.
//   hub -> node   `ssh <alias> node .unreal-agent-hub/bin/hub.cjs probe|dump` (one fixed command, BatchMode)
//   node -> hub   HTTP to http://127.0.0.1:<tunnelPort> on the node, carried back by `ssh -N -R` that the hub
//                 keeps open; the node's agent adds its token (docs/SECURITY.md).
// No keys or authorized_keys are created or changed by this project: ssh must already work from hub to node.
'use strict';
const fs = require('fs');
const cp = require('child_process');

function sshPath(cfg) {
  const p = (cfg.ssh && cfg.ssh.path) || 'auto';
  if (p !== 'auto') return p;
  if (process.platform === 'win32') {
    const sys = 'C:\\Windows\\System32\\OpenSSH\\ssh.exe';
    if (fs.existsSync(sys)) return sys;
  }
  return 'ssh';
}

function baseArgs(cfg) {
  return ['-o', 'BatchMode=yes', '-o', `ConnectTimeout=${(cfg.ssh && cfg.ssh.connectTimeoutSec) || 5}`];
}

// The node's hub.cjs, relative to the node user's home folder: an ssh session starts there on every OS, and a
// relative path avoids "~", which Windows cmd.exe does not expand.
function remoteHub(node) { return node.hubPath || '.unreal-agent-hub/bin/hub.cjs'; }

function create(cfg, node) {
  const SSH = sshPath(cfg);
  function run(args, timeoutMs) {
    return new Promise(resolve => {
      cp.execFile(SSH, [...baseArgs(cfg), node.ssh || node.id, ...args], { timeout: timeoutMs || 30000, windowsHide: true, maxBuffer: 4 << 20 },
        (err, stdout) => resolve(err ? { error: String(err.message || err).split('\n')[0].slice(0, 200) } : { out: stdout }));
    });
  }
  async function json(cmd, timeoutMs) {
    const r = await run(['node', remoteHub(node), cmd], timeoutMs);
    if (r.error) return { error: r.error };
    try { return { data: JSON.parse(r.out) }; } catch (_) { return { error: `${cmd} printed no JSON` }; }
  }
  return {
    kind: 'ssh-reverse',
    async probe() { const r = await json('probe', 40000); return { probe: r.data || null, error: r.error || '' }; },
    async dump() { const r = await json('dump', 30000); return { chats: Array.isArray(r.data) ? r.data : [], error: r.error || '' }; },
    /** Keeps `ssh -N -R` open; calls onState({up, pid, error}). Returns a stop function. */
    tunnel(boardPort, onState, retryMs) {
      if (!node.tunnelPort) return () => {};
      let child = null, stopped = false, timer = null;
      const open = () => {
        if (stopped) return;
        const args = [...baseArgs(cfg), '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3',
          '-N', '-R', `${node.tunnelPort}:127.0.0.1:${boardPort}`, node.ssh || node.id];
        try { child = cp.spawn(SSH, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] }); } catch (e) {
          onState({ up: false, pid: 0, error: String(e.message || e) });
          timer = setTimeout(open, retryMs || 60e3);
          return;
        }
        let err = '';
        child.stderr.on('data', d => { err = (err + d).slice(-400); });
        const upTimer = setTimeout(() => onState({ up: true, pid: child.pid, error: '', since: Date.now() }), 5000);
        child.on('exit', code => {
          clearTimeout(upTimer);
          onState({ up: false, pid: 0, since: Date.now(), error: (err.trim().split('\n').pop() || `ssh exited ${code}`).slice(0, 200) });
          if (!stopped) timer = setTimeout(open, retryMs || 60e3);
        });
        onState({ up: false, pid: child.pid, error: '', opening: true });
      };
      open();
      return () => { stopped = true; clearTimeout(timer); if (child) try { child.kill(); } catch (_) {} };
    },
  };
}

module.exports = { create, sshPath, remoteHub };
