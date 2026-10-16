// Platform glue: open a URL with the system handler, start a detached process.
'use strict';
const cp = require('child_process');

function openUrl(url) {
  try {
    if (process.platform === 'win32') {
      // ShellExecute through rundll32: no shell, so "&" in the URL needs no quoting. explorer.exe <url> ignored
      // custom schemes in testing; rundll32 url.dll,FileProtocolHandler did not.
      cp.spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } else if (process.platform === 'darwin') {
      cp.spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      cp.spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
}

function spawnDetached(cmd, args, opts) {
  const child = cp.spawn(cmd, args, Object.assign({ detached: true, windowsHide: true, stdio: 'ignore' }, opts || {}));
  child.unref();
  return child.pid;
}

module.exports = { openUrl, spawnDetached };
