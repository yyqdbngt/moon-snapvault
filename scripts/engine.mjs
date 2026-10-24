import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// A release build is several times faster on the same input; the debug build is
// used only when no release artifact exists. MOON_BUILD selects one explicitly.
const BUILD_MODES = process.env.MOON_BUILD ? [process.env.MOON_BUILD] : ['release', 'debug'];

function cliPath() {
  for (const mode of BUILD_MODES) {
    const candidate = path.join(root, '_build/js', mode, 'build/cmd/main/main.js');
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error('Run `moon build --target js --release` first (or set MOON_BUILD=debug)');
}

export function engine(request) {
  const cli = cliPath();
  const result = spawnSync(process.execPath, [cli, '-'], {
    input: JSON.stringify(request), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    timeout: 60000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stdout || result.stderr);
  return JSON.parse(result.stdout);
}
export function safeFile(base, name) {
  if (!name || name.includes('\\') || name.includes(':') || name.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('Unsafe relative path');
  const absolute = path.resolve(base, name);
  if (!absolute.startsWith(base + path.sep)) throw new Error('Path leaves workspace');
  let current = base;
  for (const part of name.split('/')) {
    current = path.join(current, part);
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Symbolic links are unsupported'); }
    catch (err) { if (err.code !== 'ENOENT') throw err; }
  }
  return absolute;
}
