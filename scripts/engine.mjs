import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// A release build is several times faster on the same input; the debug build is
// used only when no release artifact exists. MOON_BUILD selects one explicitly.
const BUILD_MODES = process.env.MOON_BUILD ? [process.env.MOON_BUILD] : ['release', 'debug'];

// Newest modification time among the sources a build depends on.
// White-box test files are compiled only by `moon test`, never linked into an executable, so
// a change to one cannot make the CLI stale. Counting them made the guard permanently
// unfixable: touching a test file leaves the artifact older than the source, and
// `moon build --release` answers "no work to do" because nothing it builds depends on it.
const isSource = (name) => name.endsWith('.mbt') && !name.endsWith('_wbtest.mbt');

function newestSource() {
  let newest = 0;
  for (const entry of fs.readdirSync(root, {withFileTypes: true})) {
    if (!entry.isFile() || !isSource(entry.name)) continue;
    newest = Math.max(newest, fs.statSync(path.join(root, entry.name)).mtimeMs);
  }
  for (const sub of ['cmd/main']) {
    const directory = path.join(root, sub);
    if (!fs.existsSync(directory)) continue;
    for (const name of fs.readdirSync(directory)) {
      if (isSource(name)) {
        newest = Math.max(newest, fs.statSync(path.join(directory, name)).mtimeMs);
      }
    }
  }
  return newest;
}

// A stale artifact silently tests code that is no longer the code on disk, and the
// harness prefers release over debug, so `moon build --target js` after an edit is
// not enough. That produced a false clean run while this check was being added, so
// it is now an explicit failure rather than a footgun.
function assertFresh(artifact, mode) {
  const built = fs.statSync(artifact).mtimeMs;
  const source = newestSource();
  if (built >= source) return;
  const stale = ((source - built) / 1000).toFixed(1);
  if (process.env.SNAPVAULT_ALLOW_STALE === '1') {
    console.error(`warning: using a ${mode} build that is ${stale}s older than the source`);
    return;
  }
  throw new Error(
    `The ${mode} build is ${stale}s older than the source, so it would test code that `
    + 'is no longer on disk. Rebuild with `moon build --target js --release` '
    + '(and `moon build --target js` for the debug fallback), or set '
    + 'SNAPVAULT_ALLOW_STALE=1 to use it anyway.');
}

function cliPath() {
  for (const mode of BUILD_MODES) {
    const candidate = path.join(root, '_build/js', mode, 'build/cmd/main/main.js');
    if (!fs.existsSync(candidate)) continue;
    assertFresh(candidate, mode);
    return candidate;
  }
  throw new Error('Run `moon build --target js --release` first (or set MOON_BUILD=debug)');
}

// The core CLI rejects a request over 16 MiB. Callers that build large payloads
// stringify once, check the size, and hand the text over here.
export const REQUEST_LIMIT = 16 * 1024 * 1024;

// The human-readable part of a failure, from either stream. A malformed or absent body is
// reported as-is rather than parsed hopefully: the caller needs something to show, and a parse
// failure inside the error path would replace a real message with a TypeError.
function messageOf(stream) {
  const text = (stream || '').trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed.error === 'string') return parsed.error;
  } catch { /* not JSON: fall through to the raw text */ }
  return text;
}

export function engineText(text) {
  const cli = cliPath();
  const result = spawnSync(process.execPath, [cli, '-'], {
    input: text, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    timeout: 120000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    // The CLI answers failures with the same envelope as successes - `{"error": "..."}` on stdout -
    // so the message is the value of that field, not the envelope. Throwing `result.stdout` whole
    // made every downstream handler wrap a JSON document in a sentence, and a user who hit a
    // corrupted snapshot saw:
    //
    //   {"error":"{\"error\":\"cannot restore corrupted snapshot\"}\n"}
    //
    // Text that has to be unescaped in your head is not an error message.
    throw new Error(messageOf(result.stdout) ?? messageOf(result.stderr) ?? 'the core failed');
  }
  return JSON.parse(result.stdout);
}

export function engine(request) {
  return engineText(JSON.stringify(request));
}

// Reports the request size against the cap with the two halves that dominate it,
// so a failing backup says what to do instead of "input exceeds 16 MiB".
export function checkRequestSize(text, parts) {
  if (text.length <= REQUEST_LIMIT) return text;
  const detail = Object.entries(parts)
    .map(([label, bytes]) => `${label} ${(bytes / 1048576).toFixed(2)} MiB`)
    .join(' + ');
  throw new Error(
    `Snapshot request would be ${(text.length / 1048576).toFixed(2)} MiB, over the 16 MiB CLI cap (${detail}). ` +
    'Lower SNAPVAULT_ADAPTER_LIMIT_BYTES or back up a smaller tree per snapshot.',
  );
}
// The security boundary is containment plus the symlink walk below, not the
// character set: `a\b.txt` and `we:ird.txt` are ordinary Linux file names, and
// refusing them here meant such a directory could not be backed up at all. On
// Windows those characters are separators or illegal, and `portablePaths` refuses
// them there.
export function safeFile(base, name) {
  if (!name || name.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('Unsafe relative path');
  const absolute = path.resolve(base, name);
  if (!absolute.startsWith(base + path.sep)) throw new Error('Path leaves workspace');
  let current = base;
  for (const part of name.split('/')) {
    current = path.join(current, part);
    // A link anywhere along the path is refused, and the message names the link rather
    // than the whole path: the point is to tell the user which entry to remove.
    try {
      if (fs.lstatSync(current).isSymbolicLink()) {
        throw new Error('Symbolic link in the path: ' + path.relative(base, current));
      }
    } catch (err) {
      // ENOENT is expected for a part that does not exist yet; the walk reports those
      // itself, with the entry named.
      if (err.code !== 'ENOENT') throw err;
    }
  }
  return absolute;
}
