// Writes ../web/THIRD-PARTY-LICENSES.txt: name, version, license and the full license text of every package that
// can end up in the built page (the production dependency tree of web-src). Run by `npm run build`.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const here = path.resolve(import.meta.dirname, '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const out = execFileSync(npm, ['ls', '--omit=dev', '--all', '--parseable'], { cwd: here, encoding: 'utf8', shell: process.platform === 'win32' });
const dirs = [...new Set(out.split(/\r?\n/).filter(Boolean).filter(d => path.resolve(d) !== here))];
const seen = new Set();
const parts = [];
for (const dir of dirs) {
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { continue; }
  const id = `${pkg.name}@${pkg.version}`;
  if (seen.has(id)) continue;
  seen.add(id);
  const file = fs.readdirSync(dir).find(n => /^(licen[cs]e|copying)(\..*)?$/i.test(n));
  const text = file ? fs.readFileSync(path.join(dir, file), 'utf8').trim() : '(no license file in the package; see its repository)';
  parts.push({ id, license: typeof pkg.license === 'string' ? pkg.license : JSON.stringify(pkg.license || ''), text });
}
parts.sort((a, b) => a.id.localeCompare(b.id));
const head = 'Third-party software bundled in web/assets/ (the board page, built from web-src/ with Vite).\n' +
  `${parts.length} packages: ${[...new Set(parts.map(p => p.license))].sort().join(', ')}.\n`;
const body = parts.map(p => `${'='.repeat(100)}\n${p.id}  (${p.license})\n${'='.repeat(100)}\n${p.text}\n`).join('\n');
fs.writeFileSync(path.resolve(here, '..', 'web', 'THIRD-PARTY-LICENSES.txt'), head + '\n' + body.replace(/\r\n/g, '\n'));
console.log(`THIRD-PARTY-LICENSES.txt: ${parts.length} packages`);
