import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {engine, safeFile} from './engine.mjs';

// Format 2 carries base64, about 4/3 of the source size, so the adapter can take
// a larger tree while staying inside the core CLI's 16 MiB request cap.
const ADAPTER_LIMIT = Number(process.env.SNAPVAULT_ADAPTER_LIMIT_BYTES || 8 * 1024 * 1024);

function inside(child, parent) { return child === parent || child.startsWith(parent + path.sep); }

// A case-sensitive source can hold names that collide on a case-insensitive or
// normalizing target. Backing it up stays allowed; the snapshot is simply
// reported as not portable, and restore rejects it before writing.
function warnNonPortable(files) {
  try { portablePaths(files); }
  catch (err) { console.error('warning: snapshot is not portable: ' + err.message); }
}
export function backup(source, destination, previous) {
  const base = fs.realpathSync(source);
  const parent = fs.realpathSync(path.dirname(path.resolve(destination)));
  const output = path.join(parent, path.basename(destination));
  if (inside(output, base)) throw new Error('Snapshot destination must be outside source');
  const files = [];
  let total = 0;
  function walk(directory, relative) {
    for (const item of fs.readdirSync(directory, {withFileTypes: true}).sort((a,b) => a.name.localeCompare(b.name))) {
      const name = relative ? relative + '/' + item.name : item.name;
      const absolute = safeFile(base, name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error('Symlinks are unsupported');
      if (stat.isDirectory()) walk(absolute, name);
      else if (stat.isFile()) {
        total += stat.size;
        if (total > ADAPTER_LIMIT) throw new Error(`JSON snapshot adapter limit is ${ADAPTER_LIMIT / 1048576} MiB of source bytes per backup`);
        // Base64 keeps the request near 4/3 of the source size instead of the
        // up to 4x of a decimal byte array, and skips a 1M-element JSON array.
        files.push({path: name, content_base64: fs.readFileSync(absolute).toString('base64'), mode: stat.mode & 0o777});
      } else throw new Error('Special files are unsupported');
    }
  }
  walk(base, '');
  warnNonPortable(files);
  const result = engine({operation: 'create', files,
    ...(previous ? {previous: JSON.parse(fs.readFileSync(previous, 'utf8'))} : {})});
  const tmp = output + '.' + randomUUID() + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(result.snapshot), {flag: 'wx'});
    // Exclusive publication prevents replacing an existing snapshot.
    fs.linkSync(tmp, output);
  } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
  return result.statistics;
}

// Case and Unicode normalization are filesystem properties, not snapshot
// properties: a manifest can be valid and still contain names that collide once
// written to a case-insensitive or normalizing filesystem. Reject those pairs
// before anything is written so a restore never fails halfway through.
export function portablePaths(files) {
  const seen = new Map();
  for (const file of files) {
    const key = file.path.normalize('NFC').toLowerCase();
    const previous = seen.get(key);
    if (previous !== undefined && previous !== file.path) {
      throw new Error('Paths collide after Unicode normalization and case folding: ' + previous + ' vs ' + file.path);
    }
    seen.set(key, file.path);
  }
}

export function restore(snapshotFile, destination) {
  // Verify every object before creating the destination.
  const snapshot = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));
  const verified = engine({operation: 'restore', snapshot});
  portablePaths(verified.files);
  const parent = fs.realpathSync(path.dirname(path.resolve(destination)));
  const output = path.join(parent, path.basename(destination));
  fs.mkdirSync(output); // Must be a new directory; existing targets are rejected.
  let modes = 0;
  try {
    for (const file of verified.files) {
      const absolute = safeFile(output, file.path);
      const payload = verified.encoding === 'base64'
        ? Buffer.from(file.bytes, 'base64')
        : Buffer.from(file.bytes);
      fs.mkdirSync(path.dirname(absolute), {recursive: true});
      fs.writeFileSync(absolute, payload, {flag: 'wx', mode: file.mode});
      // writeFileSync applies the mode through the process umask; chmod restores
      // the recorded permission bits regardless of the umask.
      fs.chmodSync(absolute, file.mode);
      modes++;
    }
  } catch (err) {
    // Retain the new partial destination for inspection; no original files are touched.
    throw new Error('Restore failed; partial destination retained: ' + err.message);
  }
  return {
    files: verified.files.length,
    verified: true,
    encoding: verified.encoding,
    format: verified.format,
    modes_applied: modes,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [operation, source, destination, previous] = process.argv.slice(2);
    if (!source || !destination) throw new Error('Usage: filesystem.mjs backup|restore source destination [previous]');
    if (!['backup', 'restore'].includes(operation)) throw new Error('Unknown operation');
    console.log(JSON.stringify(operation === 'backup' ? backup(source, destination, previous) : restore(source, destination)));
  } catch (err) { console.error(err.message); process.exitCode = 1; }
}
