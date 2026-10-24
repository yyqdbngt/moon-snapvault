// Proves the failure behaviour that the docs promise, using a filesystem that is
// genuinely too small.
//
//   node scripts/fault-probe.mjs
//
// Why this is not part of `verify.sh`: it needs a filesystem it can fill. macOS has
// `hdiutil`, which needs no privileges; Linux needs root for a tmpfs; Windows has
// neither, so the probe skips there. Everything else about restore is covered by the
// integration suite; this probe exists for the two claims that only a real shortage can
// exercise:
//
//   1. a failed restore leaves the partial directory in place, and
//   2. the error names the file it stopped at, so the partial tree is interpretable.
//
// It is run deliberately, not on every build, and says so in docs/boundaries.md
// rather than implying coverage it does not have.
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {backup} from './filesystem.mjs';

const MB = 1024 * 1024;
const volumeSize = 2 * MB;

// Two ways to get a filesystem that is genuinely too small, because one is not portable:
// Linux has tmpfs and needs root, macOS has hdiutil and needs no privileges at all.
// Windows has neither, so the probe skips there and says so.
const platform = process.platform;
const image = path.join(os.tmpdir(), 'snapvault-fault-probe.dmg');
const mount = platform === 'darwin' ? '/Volumes/snapvault-fault-probe'
  : path.join(os.tmpdir(), 'snapvault-fault-probe');

function shell(command) {
  return spawnSync('/bin/sh', ['-c', command], {encoding: 'utf8'});
}

function mountTiny() {
  if (platform === 'darwin') {
    fs.rmSync(image, {force: true});
    const created = shell(`hdiutil create -size ${volumeSize / MB}m -fs APFS `
      + `-volname snapvault-fault-probe ${JSON.stringify(image)}`);
    if (created.status !== 0) {
      throw new Error('cannot create a disk image: ' + (created.stderr || '').trim());
    }
    const attached = shell(`hdiutil attach ${JSON.stringify(image)} -nobrowse`);
    if (attached.status !== 0) {
      throw new Error('cannot attach the disk image: ' + (attached.stderr || '').trim());
    }
    return;
  }
  fs.rmSync(mount, {recursive: true, force: true});
  fs.mkdirSync(mount, {recursive: true});
  const mounted = shell(`mount -t tmpfs -o size=${volumeSize} tmpfs ${mount}`);
  if (mounted.status !== 0) {
    throw new Error('cannot mount a small tmpfs (needs root): '
      + (mounted.stderr || '').trim());
  }
}

function unmount() {
  if (platform === 'darwin') {
    shell(`hdiutil detach ${JSON.stringify(mount)} -force`);
    fs.rmSync(image, {force: true});
    return;
  }
  shell(`umount ${mount}`);
  fs.rmSync(mount, {recursive: true, force: true});
}

const cli = path.resolve('scripts/filesystem.mjs');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'snapvault-fault-'));
const problems = [];

try {
  if (platform === 'win32') {
    console.log('Fault probe: skipped - no unprivileged way to make a small filesystem on Windows');
    process.exit(0);
  }
  try {
    mountTiny();
  } catch (err) {
    // Not being able to run this is not a failure of the project, and a stack trace
    // would suggest otherwise. Say what is missing and stop.
    console.log('Fault probe: skipped - ' + err.message);
    if (platform === 'linux') console.log('  Run as root: sudo -n node scripts/fault-probe.mjs');
    process.exit(0);
  }
  const free = Number(/^(\d+)/.exec(shell(`df -k ${mount}`).stdout.split('\n')[1])?.[1] ?? 0);
  console.log(`probe: ${volumeSize / MB} MiB volume at ${mount} (${platform})`);

  const src = path.join(work, 'src');
  fs.mkdirSync(src);
  // Distinct contents so the snapshot cannot deduplicate them away.
  for (let i = 0; i < 4; i++) {
    fs.writeFileSync(path.join(src, `f${i}.bin`), Buffer.alloc(MB, i));
  }
  const snapshot = path.join(work, 'snap.json');
  const stats = backup(src, snapshot);
  console.log(`probe: snapshot ${(stats.snapshot_bytes / MB).toFixed(2)} MiB`
    + `, target volume ${(free / 1024).toFixed(2)} MiB`);

  const destination = path.join(mount, 'restored');
  const result = spawnSync(process.execPath,
    [cli, 'restore', snapshot, destination], {encoding: 'utf8'});

  if (result.status === 0) {
    problems.push('the restore was expected to fail on a volume this small, but succeeded');
  }
  const message = (result.stderr || '').trim().split('\n')[0];
  console.log('probe: error is ' + JSON.stringify(message));

  if (!/partial destination is retained/i.test(message)) {
    problems.push('the message does not mention the retained partial destination');
  }
  if (!/Restore failed at \S+/.test(message)) {
    problems.push('the message does not name the file it stopped at');
  }
  if (/\n\s+at /.test(message)) {
    problems.push('the message leaks a stack trace');
  }

  if (!fs.existsSync(destination)) {
    problems.push('the partial destination was not retained');
  } else {
    const kept = fs.readdirSync(destination).sort();
    const named = /Restore failed at (\S+?);/.exec(message)?.[1];
    console.log(`probe: kept ${kept.length} of 4 entries` + (named ? `, stopped at ${named}` : ''));
    if (named && !kept.includes(named)) {
      problems.push(`the named file ${named} is not in the retained directory`);
    }
    // Everything before the named file must be complete; the named file must not be.
    const ordered = fs.readFileSync(snapshot, 'utf8');
    const complete = kept.filter((name) => name !== named);
    for (const name of complete) {
      const size = fs.statSync(path.join(destination, name)).size;
      if (size !== MB) {
        problems.push(`${name} precedes the failure point but is ${size} bytes, not ${MB}`);
      }
    }
    if (named && fs.existsSync(path.join(destination, named))) {
      const truncated = fs.statSync(path.join(destination, named)).size;
      console.log(`probe: the named file is ${truncated} of ${MB} bytes - truncated as expected`);
    }
    if (ordered.length === 0) problems.push('snapshot file is empty');
  }
} finally {
  try { unmount(); } catch { /* already gone */ }
  fs.rmSync(work, {recursive: true, force: true});
}

if (problems.length) {
  for (const problem of problems) console.error('fault-probe: ' + problem);
  process.exit(1);
}
console.log('Fault probe: a full device leaves an interpretable partial restore');
