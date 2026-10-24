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
  // Two separate questions: does this tree restore *here*, and would it restore
  // anywhere. Only the second belongs in a backup warning.
  try { portablePaths(files); }
  catch (err) { console.error('warning: snapshot is not portable: ' + err.message); return; }
  const notes = portabilityNotes(files);
  if (notes.length) {
    console.error('warning: snapshot will not restore on every platform:');
    for (const note of notes) console.error('  ' + note);
  }
}

// Reading a snapshot is the one step where the input is a file the user named, so a
// failure here should say which file and why rather than leaking a raw ENOENT.
function readSnapshot(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    const reason = err.code === 'ENOENT' ? 'does not exist'
      : err.code === 'EACCES' ? 'cannot be read: permission denied'
        : 'cannot be read: ' + err.message;
    throw new Error('Snapshot file ' + reason + ': ' + file);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error('Snapshot file is not valid JSON: ' + file + ' (' + err.message + ')');
  }
}

// The chain is whatever the caller names: a delta only knows the checksum of its
// parent, so the files themselves have to be supplied on both sides.
function readChain(files) {
  return files.filter(Boolean).map(readSnapshot);
}

// The parts of a snapshot a reader needs in order to resolve digests: no payloads.
// Durability helpers.
//
// `writeFileSync` returns once the data is in the page cache, which is not the same as
// on the disk: a power cut can lose it. That matters more here than in most tools,
// because the whole product is the claim that a snapshot exists and can be restored, and
// the failure mode is silent - the file is there, its length is zero.
//
// fsync is called on files before they are depended on and on directories after their
// entries change, since a rename or a link is a metadata change that needs the directory
// synced to survive.
// Durability costs a disk round-trip per file, which is negligible for a few large files
// and dominated by latency for many small ones: 200 files of 1 KiB go from 79 ms to
// 852 ms, about eleven times slower. That is the price of the guarantee, so it is the
// default; the escape hatch exists because a scratch copy onto the same disk does not
// need it, and because a knob that is not honoured visibly would be worse than none.
// When it is used, the report says `durable: false` rather than staying silent.
const FSYNC = process.env.SNAPVAULT_NO_FSYNC !== '1';

function fsyncDirectory(directory) {
  let descriptor;
  try {
    descriptor = fs.openSync(directory, 'r');
    fs.fsyncSync(descriptor);
  } catch (err) {
    // Some filesystems and platforms refuse to open or sync a directory. Losing the
    // directory sync weakens durability but says nothing about the data, so it must not
    // fail a restore that is otherwise correct.
    if (err.code !== 'EISDIR' && err.code !== 'EPERM' && err.code !== 'EACCES'
        && err.code !== 'EINVAL' && err.code !== 'EBADF') {
      throw err;
    }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

// Publication, in one place: write a temporary file, make it durable, link it into the
// destination so an existing name cannot be replaced, then make the link durable.
// Both backup and squash used to carry their own copy of this sequence, and neither
// synced anything.
function publishSnapshot(snapshot, output) {
  const tmp = output + '.' + randomUUID() + '.tmp';
  try {
    const text = JSON.stringify(snapshot);
    const descriptor = fs.openSync(tmp, 'wx');
    try {
      fs.writeFileSync(descriptor, text);
      if (FSYNC) fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    try {
      fs.linkSync(tmp, output);
    } catch (err) {
      if (err.code === 'EEXIST') {
        throw new Error('A snapshot already exists at ' + output
          + '; snapshots are never replaced');
      }
      throw err;
    }
    if (FSYNC) fsyncDirectory(path.dirname(output));
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
}

export function manifestOnly(snapshot) {
  return {
    version: snapshot.version,
    parent: snapshot.parent ?? null,
    files: snapshot.files,
    checksum: snapshot.checksum,
    // Which payloads this link holds, by name rather than as a fake `objects`
    // map: `locate` needs the digests, and nothing should mistake these for bytes.
    stored_digests: Object.keys(snapshot.objects || {}),
  };
}

// A delta normally carries the new tree *and* the parent it reuses, which is what
// puts a ceiling on how large a base one request can cover. The parent's payloads
// are the expensive half, and the core needs only the digests that already exist,
// so this path sends a manifest-only parent plus a digest list.
//
// The chain is audited in its own request first: the base is still verified before
// a delta is built on it, which the core cannot do for a manifest-only parent.
// Verifies one link's own payloads, in batches small enough to stay under the
// request cap. Auditing the whole chain at once would put every payload of every
// link into a single request, which is exactly what does not fit for a long chain.
function verifyLink(link, budget = 8 * 1024 * 1024) {
  const digests = Object.keys(link.objects || {});
  if (!digests.length) return 0;
  // The manifest already states each payload's size, so batches can be sized
  // before anything is read.
  const sizes = new Map();
  for (const file of link.files || []) sizes.set(file.digest, file.size || 0);
  let batch = [];
  let used = 0;
  let verified = 0;
  const flush = () => {
    if (!batch.length) return;
    const got = engineText(JSON.stringify({
      operation: 'extract', snapshot: link, digests: batch, format: link.version,
    }));
    if (got.verified !== true) throw new Error('a link failed verification');
    verified += batch.length;
    batch = [];
  };
  for (const digest of digests) {
    const size = sizes.get(digest) ?? 0;
    if (used + size > budget) { flush(); used = 0; }
    batch.push(digest);
    used += size;
  }
  flush();
  return verified;
}

// `linkFiles` are snapshot paths; each is read, verified and released in turn, so
// building a delta needs room for one link rather than for the whole chain.
export function deltaFromDigests(files, linkFiles, sourceBytes = 0) {
  const known = new Set();
  for (const file of linkFiles) {
    const link = readSnapshot(file);
    verifyLink(link);
    for (const digest of Object.keys(link.objects || {})) known.add(digest);
  }
  const parentSnapshot = readSnapshot(linkFiles[0]);
  const text = JSON.stringify({
    operation: 'create',
    format: 3,
    files,
    previous: manifestOnly(parentSnapshot),
    // The rest of the chain is just as expensive as the parent, and locating a
    // digest needs no payload either, so every link travels as a manifest.
    parents: linkFiles.slice(1).map((file) => manifestOnly(readSnapshot(file))),
    known_objects: [...known],
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
  const sourceBytes = files.reduce((sum, file) => sum + file.content_base64.length, 0);
  const linkPaths = previous ? [previous, ...chain] : [];
  // Deciding on file sizes avoids reading the chain at all in the common case
  // where it plainly will not fit: the request only ever gets bigger than the
  // files it is built from.
  const linkBytes = linkPaths.reduce((sum, file) => sum + fs.statSync(file).size, 0);
  const fitsOneRequest = sourceBytes + linkBytes + 4096 <= REQUEST_LIMIT;
  let result;
  if (fitsOneRequest) {
    const parentSnapshot = previous ? readSnapshot(previous) : null;
    result = engineText(JSON.stringify({
      operation: 'create',
      format: previous ? 3 : 2,
      files,
      ...(previous ? {previous: parentSnapshot, parents: readChain(chain)} : {}),
    }));
  } else {
    // One link is read, verified and released at a time, so a chain of any length
    // costs the largest link rather than the sum of them.
    result = deltaFromDigests(files, linkPaths, sourceBytes);
  }
  // A hard link is the publication step: it fails if the name exists, so two processes
  // racing to the same destination produce one snapshot and one clear failure rather
  // than a mixed file.
  publishSnapshot(result.snapshot, output);
  return {
    ...result.statistics,
    format: result.snapshot.version,
    parent: result.snapshot.parent ?? null,
    snapshot_bytes: fs.statSync(output).size,
    // The core reports false when a delta was built from a digest list instead of
    // the parent's payloads. The chain was still audited first, so the adapter can
    // say so; the pair is what a caller should look at, not either field alone.
    chain_verified: previous !== null && previous !== undefined,
  };
}

// Case and Unicode normalization are filesystem properties, not snapshot
// properties. A manifest holding `Report.txt` and `report.txt` is two files on
// Linux and one on a case-insensitive volume, so the snapshot is valid either way
// and only the writer can decide. This is that decision, and it is the only place
// it is made: reject before anything is written so a restore never fails halfway
// through and never lets one file overwrite another.
const fold = (name) => name.normalize('NFC').toLowerCase();

// Names Windows cannot hold, after stripping the trailing spaces and dots Win32
// strips itself: `NUL`, `nul.txt` and `NUL .txt` all reach the device.
const RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  ...Array.from({length: 9}, (_, i) => 'com' + (i + 1)),
  ...Array.from({length: 9}, (_, i) => 'lpt' + (i + 1)),
]);
const FORBIDDEN = /[:"<>|?*\\]/;

// The reasons a name cannot be written on Windows, or [] when it can. Written as a
// list so a warning can name every problem rather than only the first.
function windowsProblems(part) {
  const problems = [];
  if (FORBIDDEN.test(part)) problems.push('contains a character Windows reserves');
  if (/[. ]$/.test(part)) problems.push('ends with a dot or space, which Windows strips');
  // Trailing spaces and dots come off before Windows decides about a device name.
  if (RESERVED.has(part.split('.')[0].replace(/[. ]+$/, '').toLowerCase())) {
    problems.push('is a Windows device name');
  }
  return problems;
}

function maxPathBytes() {
  if (process.platform === 'darwin') return 1024;
  return process.platform === 'win32' ? 260 : 4096;
}

// Paths that cannot be written *here*. Each platform is checked for what it
// actually cannot hold, so a Linux tree holding `con` or `a\b.txt` still restores
// on Linux - and the same snapshot is refused up front, not halfway through, when
// the destination is Windows. Case folding is checked everywhere: macOS volumes are
// usually case-insensitive and Windows always is, and a refusal on the rare
// case-sensitive Linux setup is a warning the reader can see rather than data loss.
export function portablePaths(files) {
  const folded = new Map();
  const limit = maxPathBytes();
  for (const file of files) {
    for (const part of file.path.split('/')) {
      if (process.platform === 'win32') {
        const problems = windowsProblems(part);
        if (problems.length) throw new Error('Path ' + problems.join(' and ') + ': ' + part);
      }
    }
    if (Buffer.byteLength(file.path, 'utf8') > limit) {
      throw new Error(
        `Path is longer than ${limit} bytes on this platform: ${file.path.slice(0, 60)}...`);
    }
    const key = fold(file.path);
    const previous = folded.get(key);
    if (previous !== undefined) {
      throw new Error('Paths collide after Unicode normalization and case folding: '
        + previous + ' vs ' + file.path);
    }
    folded.set(key, file.path);
  }
  // The core rejects a file that is also a directory by exact name; case folding
  // can create that conflict where the exact names differ, so it is checked again
  // on the folded form.
  for (const [key, original] of folded) {
    const parts = key.split('/');
    let prefix = '';
    for (let index = 0; index < parts.length - 1; index++) {
      prefix = prefix ? prefix + '/' + parts[index] : parts[index];
      if (folded.has(prefix)) {
        throw new Error('Paths collide after Unicode normalization and case folding: '
          + folded.get(prefix) + ' is a file and ' + original + ' needs it as a directory');
      }
    }
  }
}

// What would have to change for this tree to be restorable on *any* platform.
// `backup` reports it as a warning: the snapshot is a faithful record either way,
// and refusing to take it would be the mistake this project already made once.
function portabilityNotes(files) {
  const notes = new Set();
  for (const file of files) {
    for (const part of file.path.split('/')) {
      for (const problem of windowsProblems(part)) {
        notes.add('Path ' + problem + ': ' + part);
      }
    }
    if (Buffer.byteLength(file.path, 'utf8') > 260) {
      notes.add('Path is longer than the 260 bytes Windows allows: ' + file.path.slice(0, 60));
    }
  }
  return [...notes];
}

// Compaction of a chain too large for one request: locate the payloads, extract
// them per link (already verified against their digests), then ask the core for
// the canonical checksum of the assembled manifest.
export function squashInPieces(snapshot, parents, format = 3) {
  const located = send({
    operation: 'locate', snapshot: manifestOnly(snapshot), parents: parents.map(manifestOnly),
  }, {manifests: [snapshot, ...parents].reduce(
    (sum, item) => sum + JSON.stringify(manifestOnly(item)).length, 0)});
  if (located.missing_parent !== null) {
    throw new Error('the chain is missing a parent snapshot: ' + located.missing_parent);
  }
  if (located.unresolved.length) {
    throw new Error('the chain does not store ' + located.unresolved.length + ' required object(s)');
  }
  const digests = [...new Set(located.files.map((file) => file.digest))];
  const byLink = new Map();
  for (const file of located.files) {
    if (!byLink.has(file.link)) byLink.set(file.link, []);
    byLink.get(file.link).push(file.digest);
  }
  const objects = {};
  let bytes = 0;
  for (const [link, wanted] of byLink) {
    const holder = [snapshot, ...parents].find((item) => item.checksum === link);
    if (!holder) throw new Error('the chain is missing the snapshot ' + link);
    const overhead = JSON.stringify({
      operation: 'extract', snapshot: holder, digests: [], format,
    }).length;
    const budget = Math.max(REQUEST_LIMIT - overhead - 1024, 4096);
    let batch = [];
    const flush = () => {
      if (!batch.length) return;
      const got = engineText(JSON.stringify({
        operation: 'extract', snapshot: holder, digests: batch, format,
      }));
      Object.assign(objects, got.objects);
      bytes += got.bytes;
      batch = [];
    };
    let used = 0;
    for (const digest of [...new Set(wanted)]) {
      if (used + 67 > budget) { flush(); used = 0; }
      batch.push(digest);
      used += 67;
    }
    flush();
  }
  if (Object.keys(objects).length !== digests.length) {
    throw new Error('only ' + Object.keys(objects).length + ' of ' + digests.length + ' payloads resolved');
  }
  // The manifest, without the `link` field `locate` adds for the caller's use.
  const manifestFiles = located.files.map(({path, digest, size, mode}) => ({path, digest, size, mode}));
  const assembled = send({operation: 'assemble', files: manifestFiles, format}, {
    files: located.files.reduce((sum, file) => sum + 96, 0),
  });
  const parent = format >= 3 ? null : undefined;
  const built = {
    version: assembled.format,
    ...(format >= 3 ? {parent} : {}),
    files: assembled.files,
    objects,
    checksum: assembled.checksum,
  };
  // The assembled snapshot is audited when it fits, which re-checks every payload
  // against its digest and every file against its size.
  const text = JSON.stringify(built);
  if (text.length <= REQUEST_LIMIT) {
    const report = engineText(JSON.stringify({operation: 'audit', snapshot: built}));
    if (!report.valid) throw new Error('the assembled snapshot failed its audit');
    return {
      snapshot: built,
      audited: true,
      statistics: {
        format, chain_depth: located.chain_depth, files: report.files,
        objects: Object.keys(objects).length, bytes,
      },
    };
  }
  // Larger than one request, so the audit has to come from reading it back later.
  return {
    snapshot: built,
    audited: false,
    statistics: {
      format, chain_depth: located.chain_depth, files: built.files.length,
      objects: Object.keys(objects).length, bytes,
    },
  };
}

export function squash(snapshotFile, destination, chain = [], format = 3) {
  const snapshot = readSnapshot(snapshotFile);
  const parents = readChain(chain);
  const request = {operation: 'squash', snapshot, parents, format};
  const text = JSON.stringify(request);
  const result = text.length <= REQUEST_LIMIT
    ? engineText(text)
    : squashInPieces(snapshot, parents, format);
  const parent = fs.realpathSync(path.dirname(path.resolve(destination)));
  const output = path.join(parent, path.basename(destination));
  publishSnapshot(result.snapshot, output);
  const statistics = result.statistics ?? {
    format,
    chain_depth: result.chain_depth ?? null,
    files: result.snapshot.files.length,
    objects: result.objects,
    bytes: null,
  };
  return {
    ...statistics,
    audited: result.audited ?? true,
    snapshot_bytes: fs.statSync(output).size,
  };
}

// Resolves a chain that is too large for one request: `locate` answers which link
// stores each payload from manifests alone, then one `extract` per link returns
// and verifies the bytes. The result is shaped like a `restore` response so the
// writing code does not care which path produced it.
export function resolveInPieces(snapshot, parents, paths = []) {
  const located = send({
    operation: 'locate',
    snapshot: manifestOnly(snapshot),
    parents: parents.map(manifestOnly),
    paths: paths.length ? paths : undefined,
  }, {
    manifests: [snapshot, ...parents].reduce(
      (sum, item) => sum + JSON.stringify(manifestOnly(item)).length, 0),
  });
  if (located.missing_parent !== null) {
    throw new Error('the chain is missing a parent snapshot: ' + located.missing_parent);
  }
  if (located.unresolved.length) {
    throw new Error('the chain does not store ' + located.unresolved.length + ' required object(s)');
  }
  // Only the links that actually hold a selected payload are read.
  const filesByLink = new Map();
  for (const file of located.files) {
    if (!filesByLink.has(file.link)) filesByLink.set(file.link, []);
    filesByLink.get(file.link).push(file.digest);
  }
  const payloads = new Map();
  for (const [link, wanted] of filesByLink) {
    const holder = [snapshot, ...parents].find((item) => item.checksum === link);
    if (!holder) throw new Error('the chain is missing the snapshot ' + link);
    // Split the digest list so that no request approaches the cap.
    const overhead = JSON.stringify({operation: 'extract', snapshot: holder, digests: []}).length;
    const budget = Math.max(REQUEST_LIMIT - overhead - 1024, 4096);
    let batch = [];
    const flush = () => {
      if (!batch.length) return;
      const got = engineText(JSON.stringify({
        operation: 'extract', snapshot: holder, digests: batch, format: located.format,
      }));
      for (const [digest, payload] of Object.entries(got.objects)) payloads.set(digest, payload);
      batch = [];
    };
    let used = 0;
    for (const digest of wanted) {
      // 67 bytes covers a 64-character digest plus quotes and a comma.
      if (used + 67 > budget) { flush(); used = 0; }
      batch.push(digest);
      used += 67;
    }
    flush();
  }
  const files = located.files.map((file) => ({
    path: file.path,
    digest: file.digest,
    size: file.size,
    mode: file.mode,
    bytes: payloads.get(file.digest),
  }));
  for (const file of files) {
    if (file.bytes === undefined) throw new Error('no payload resolved for ' + file.path);
  }
  return {
    files,
    format: located.format,
    encoding: located.encoding,
    chain_depth: located.chain_depth,
    selected: files.length,
    total_files: files.length,
    verified: true,
    piecewise: true,
  };
}

// The whole chain is verified before the destination exists, on both paths.
function resolveRestore(snapshot, parents, paths) {
  const request = {
    operation: 'restore', snapshot, parents, paths: paths.length ? paths : undefined,
  };
  const text = JSON.stringify(request);
  if (text.length <= REQUEST_LIMIT) {
    return engineText(checkRequestSize(text, {
      snapshot: JSON.stringify(snapshot).length,
      chain: parents.reduce((sum, item) => sum + JSON.stringify(item).length, 0),
    }));
  }
  return resolveInPieces(snapshot, parents, paths);
}

export function restore(snapshotFile, destination, chain = [], paths = []) {
  // Verify the whole chain before creating the destination.
  const snapshot = readSnapshot(snapshotFile);
  const parents = readChain(chain);
  const verified = resolveRestore(snapshot, parents, paths);
  portablePaths(verified.files);
  const parent = fs.realpathSync(path.dirname(path.resolve(destination)));
  const output = path.join(parent, path.basename(destination));
  // The destination must be new. Creating it exclusively means a concurrent restore
  // to the same path cannot interleave two trees, and EEXIST is that check firing.
  try {
    fs.mkdirSync(output);
  } catch (err) {
    // Both outcomes are about the destination, so both read the same way. A raw
    // EACCES from Node tells a user nothing about which argument was wrong.
    const reason = err.code === 'EEXIST'
      ? 'already exists'
      : err.code === 'EACCES' || err.code === 'EPERM'
        ? 'cannot be created: permission denied'
        : err.code === 'ENOSPC'
          ? 'cannot be created: no space left on device'
          : 'cannot be created: ' + err.message;
    throw new Error('The destination ' + reason + ': ' + output
      + '; restore requires a new directory that it can write to');
  }
  let modes = 0;
  let current = null;
  // Directories whose entries changed; each is synced once at the end rather than once
  // per file, so a tree of many files in one directory pays one directory sync.
  const touched = new Set([output]);
  try {
    for (const file of verified.files) {
      current = file.path;
      const absolute = safeFile(output, file.path);
      const payload = verified.encoding === 'base64'
        ? Buffer.from(file.bytes, 'base64')
        : Buffer.from(file.bytes);
      fs.mkdirSync(path.dirname(absolute), {recursive: true});
      const descriptor = fs.openSync(absolute, 'wx', file.mode);
      try {
        fs.writeFileSync(descriptor, payload);
        // Durable before it is reported: a restore that says `verified` while the bytes
        // are still in the page cache is a lie if the machine loses power a moment later.
        if (FSYNC) fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
      // writeFileSync applies the mode through the process umask; chmod restores
      // the recorded permission bits regardless of the umask.
      fs.chmodSync(absolute, file.mode);
      touched.add(path.dirname(absolute));
      modes++;
    }
  } catch (err) {
    // The partial directory is retained for inspection, but "for inspection" is only
    // actionable if the reader knows where it stopped: files are written in manifest
    // order, so everything before `file` is complete and `file` itself is not.
    const at = current === null ? '' : ' at ' + current;
    throw new Error('Restore failed' + at
      + '; the partial destination is retained for inspection: ' + err.message);
  }
  // File data is already durable; the directory entries that name those files are not
  // until this runs.
  if (FSYNC) {
    for (const directory of touched) fsyncDirectory(directory);
  }
  return {
    files: verified.files.length,
    total_files: verified.total_files,
    piecewise: verified.piecewise === true,
    verified: true,
    encoding: verified.encoding,
    format: verified.format,
    chain_depth: verified.chain_depth,
    modes_applied: modes,
    durable: FSYNC,
    synced_directories: FSYNC ? touched.size : 0,
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
