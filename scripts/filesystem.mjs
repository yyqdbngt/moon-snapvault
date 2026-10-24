import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {engine, engineText, checkRequestSize, REQUEST_LIMIT, safeFile} from './engine.mjs';

// Format 3 carries base64, about 4/3 of the source size, so the adapter can take
// a larger tree while staying inside the core CLI's 16 MiB request cap.
const ADAPTER_LIMIT = Number(process.env.SNAPVAULT_ADAPTER_LIMIT_BYTES || 8 * 1024 * 1024);

// A delta request carries the new tree *and* the parent snapshot it diffs
// against, so the 16 MiB request cap binds before the source cap does. Measure
// what is actually sent rather than guessing.
function send(request, parts) {
  return engineText(checkRequestSize(JSON.stringify(request), parts));
}

function inside(child, parent) { return child === parent || child.startsWith(parent + path.sep); }

// A case-sensitive source can hold names that collide on a case-insensitive or
// normalizing target. Backing it up stays allowed; the snapshot is simply
// reported as not portable, and restore rejects it before writing.
function warnNonPortable(files) {
  try { portablePaths(files); }
  catch (err) { console.error('warning: snapshot is not portable: ' + err.message); }
}

function readSnapshot(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// The chain is whatever the caller names: a delta only knows the checksum of its
// parent, so the files themselves have to be supplied on both sides.
function readChain(files) {
  return files.filter(Boolean).map(readSnapshot);
}

// A delta normally carries the new tree *and* the parent it reuses, which is what
// puts a ceiling on how large a base one request can cover. The parent's payloads
// are the expensive half, and the core needs only the digests that already exist,
// so this path sends a manifest-only parent plus a digest list.
//
// The chain is audited in its own request first: the base is still verified before
// a delta is built on it, which the core cannot do for a manifest-only parent.
export function deltaFromDigests(files, parentSnapshot, parents, sourceBytes = 0) {
  engineText(JSON.stringify({
    operation: 'audit', snapshot: parentSnapshot, parents,
  }));
  const known = [...new Set([
    ...Object.keys(parentSnapshot.objects || {}),
    ...parents.flatMap((item) => Object.keys(item.objects || {})),
  ])];
  const slim = {
    version: parentSnapshot.version,
    parent: parentSnapshot.parent ?? null,
    files: parentSnapshot.files,
    checksum: parentSnapshot.checksum,
  };
  const text = JSON.stringify({
    operation: 'create', format: 3, files, previous: slim, parents, known_objects: known,
  });
  return engineText(checkRequestSize(text, {
    source: sourceBytes,
    // Only the digests travel, at 64 bytes each plus a separator.
    digests: known.length * 67,
  }));
}

// `chain` lists the snapshots this one builds on, oldest or newest first; the
// engine matches them by checksum. Passing `previous` makes the new snapshot a
// format 3 delta that stores only objects the chain does not already hold.
export function backup(source, destination, previous, chain = []) {
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
  const parentSnapshot = previous ? readSnapshot(previous) : null;
  const parents = readChain(chain);
  const request = {
    operation: 'create',
    format: previous ? 3 : 2,
    files,
    ...(previous ? {previous: parentSnapshot, parents} : {}),
  };
  const sourceBytes = files.reduce((sum, file) => sum + file.content_base64.length, 0);
  const parentBytes = parentSnapshot ? JSON.stringify(parentSnapshot).length : 0;
  const chainBytes = parents.reduce((sum, item) => sum + JSON.stringify(item).length, 0);
  const result = JSON.stringify(request).length <= REQUEST_LIMIT
    ? engineText(JSON.stringify(request))
    : deltaFromDigests(files, parentSnapshot, parents, sourceBytes);
  const tmp = output + '.' + randomUUID() + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(result.snapshot), {flag: 'wx'});
    // Exclusive publication prevents replacing an existing snapshot.
    fs.linkSync(tmp, output);
  } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
  return {
    ...result.statistics,
    format: result.snapshot.version,
    parent: result.snapshot.parent ?? null,
    snapshot_bytes: fs.statSync(output).size,
    // The core reports false when a delta was built from a digest list instead of
    // the parent's payloads. The chain was still audited first, so the adapter can
    // say so; the pair is what a caller should look at, not either field alone.
    chain_verified: parentSnapshot !== null,
  };
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

// Compacts a chain into one self-contained snapshot file. Only reachable objects
// survive, so this is also the way to recover the space deltas leave behind.
export function squash(snapshotFile, destination, chain = [], format = 3) {
  const snapshot = readSnapshot(snapshotFile);
  const parents = readChain(chain);
  const result = send({operation: 'squash', snapshot, parents, format}, {
    snapshot: JSON.stringify(snapshot).length,
    chain: parents.reduce((sum, item) => sum + JSON.stringify(item).length, 0),
  });
  const parent = fs.realpathSync(path.dirname(path.resolve(destination)));
  const output = path.join(parent, path.basename(destination));
  const tmp = output + '.' + randomUUID() + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(result.snapshot), {flag: 'wx'});
    fs.linkSync(tmp, output);
  } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
  return {
    ...result.statistics,
    snapshot_bytes: fs.statSync(output).size,
  };
}

export function restore(snapshotFile, destination, chain = [], paths = []) {
  // Verify the whole chain before creating the destination.
  const snapshot = readSnapshot(snapshotFile);
  const parents = readChain(chain);
  const requested = paths.length ? paths : undefined;
  const verified = send({operation: 'restore', snapshot, parents, paths: requested}, {
    snapshot: JSON.stringify(snapshot).length,
    chain: parents.reduce((sum, item) => sum + JSON.stringify(item).length, 0),
  });
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
    total_files: verified.total_files,
    verified: true,
    encoding: verified.encoding,
    format: verified.format,
    chain_depth: verified.chain_depth,
    modes_applied: modes,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [operation, source, destination, previous, ...rest] = process.argv.slice(2);
    if (!source || !destination) {
      throw new Error([
        'Usage:',
        '  filesystem.mjs backup  SOURCE SNAPSHOT [PREVIOUS [PARENT...]]',
        '  filesystem.mjs restore SNAPSHOT DEST [PARENT...] [--path P ...]',
        '  filesystem.mjs squash  SNAPSHOT DEST [PARENT...] [--format N]',
      ].join('\n'));
    }
    const paths = [];
    let format = 3;
    const chain = [];
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--path') paths.push(rest[++i]);
      else if (rest[i] === '--format') format = Number(rest[++i]);
      else chain.push(rest[i]);
    }
    if (operation === 'backup') {
      console.log(JSON.stringify(backup(source, destination, previous, chain)));
    } else if (operation === 'restore') {
      // For restore the fourth argument starts the chain, not a previous file.
      console.log(JSON.stringify(restore(source, destination, [previous, ...chain], paths)));
    } else if (operation === 'squash') {
      console.log(JSON.stringify(squash(source, destination, [previous, ...chain], format)));
    } else {
      throw new Error('Unknown operation: ' + operation);
    }
  } catch (err) { console.error(err.message); process.exitCode = 1; }
}
