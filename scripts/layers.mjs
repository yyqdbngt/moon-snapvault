// Checks that the adapter and the core give the same answer for the same input.
//
//   node scripts/layers.mjs
//
// The two layers are tested separately and well: the core by the white-box suite and the fixtures,
// the adapter by the integration suite and the CLI contract. Nothing compared them with each
// other, and that is exactly the gap `squash` fell through - the core kept a snapshot's format
// while the adapter forced 3, so the same input produced two different snapshots and two different
// checksums, and every test on both sides passed.
//
// Three comparisons, chosen because each can fail without either layer failing on its own:
//
//   backup vs create   the snapshot the adapter writes must be the one the core builds from the
//                      same files. The adapter reads the tree and picks modes and formats; if it
//                      records something the core would not, the file on disk is a snapshot
//                      nothing else in the project would produce.
//   restore vs restore the files the adapter writes must match the manifest the core reports, and
//                      the core's own restore must produce the same bytes. A disagreement here is
//                      silent data loss: the bytes look fine and are the wrong ones.
//   squash vs squash   compacting through either layer must leave the same snapshot, including its
//                      checksum. This is the one that caught the format default.
//
// It compares properties rather than raw output on purpose: the two layers report differently
// shaped envelopes - the adapter adds statistics, the core returns the operation's own fields - so
// byte equality is meaningless. What must agree is the snapshot, the files and the checksum.
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {engine} from './engine.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const adapter = path.join(root, 'scripts/filesystem.mjs');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'snapvault-layers-'));
const problems = [];

function cli(args, {expect = 0} = {}) {
  const result = spawnSync('node', [adapter, ...args], {encoding: 'utf8', cwd: work});
  const output = (result.stdout || '');
  if (result.status !== expect) {
    problems.push(`adapter ${args.join(' ')} exited ${result.status}, wanted ${expect}: `
      + (output + (result.stderr || '')).trim().slice(0, 200));
    return null;
  }
  try {
    return JSON.parse(output);
  } catch {
    problems.push(`adapter ${args.join(' ')} did not print one JSON object: `
      + output.trim().slice(0, 120));
    return null;
  }
}

function readTree(directory) {
  const files = [];
  const walk = (relative) => {
    for (const entry of fs.readdirSync(path.join(directory, relative), {withFileTypes: true})) {
      const next = relative === '' ? entry.name : relative + '/' + entry.name;
      if (entry.isDirectory()) walk(next);
      else {
        files.push({
          path: next,
          bytes: fs.readFileSync(path.join(directory, next)),
          mode: fs.statSync(path.join(directory, next)).mode & 0o777,
        });
      }
    }
  };
  walk('');
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

// The same tree shape the other suites use: nesting, an empty file, a binary payload and a
// character that only survives a correct encoder.
const source = path.join(work, 'source');
fs.mkdirSync(path.join(source, 'nested'), {recursive: true});
fs.writeFileSync(path.join(source, 'a.txt'), 'abc');
fs.writeFileSync(path.join(source, 'empty.bin'), Buffer.alloc(0));
fs.writeFileSync(path.join(source, 'nested', 'zeros.bin'), Buffer.from([0, 0, 255, 0]));
fs.writeFileSync(path.join(source, 'unicode-\u00e9\u4e2d.txt'), 'text');
// A mode the umask would narrow. Without one, dropping the explicit chmod is invisible: the file
// is written through openSync with the recorded mode, and under a 022 umask a 0644 file arrives
// correct anyway - which is what the first version of this check failed to notice.
fs.writeFileSync(path.join(source, 'executable.sh'), '#!/bin/sh\nexit 0\n');
fs.chmodSync(path.join(source, 'executable.sh'), 0o777);

try {
  // --- backup vs create ----------------------------------------------------
  const written = path.join(work, 'snapshot.json');
  const backed = cli(['backup', source, written]);
  if (backed) {
    const onDisk = JSON.parse(fs.readFileSync(written, 'utf8'));
    // The core is given the same files, described the way the adapter recorded them, so any
    // difference is something the adapter did that the core would not have done.
    const files = onDisk.files.map((file) => ({
      path: file.path,
      content_base64: Buffer.from(
        typeof onDisk.objects[file.digest] === 'string'
          ? Buffer.from(onDisk.objects[file.digest], 'base64')
          : Buffer.from(onDisk.objects[file.digest]),
      ).toString('base64'),
      mode: file.mode,
    }));
    const created = engine({files, format: onDisk.version});
    if (created.snapshot.checksum !== onDisk.checksum) {
      problems.push('backup wrote checksum ' + onDisk.checksum.slice(0, 16)
        + ' where the core builds ' + created.snapshot.checksum.slice(0, 16)
        + ' from the same files; the adapter recorded something the core would not');
    }
    // And the format: `backup` with no previous is format 2, with one it is format 3, which is
    // what the core requires.
    if (onDisk.version !== 2 && onDisk.version !== 1) {
      problems.push('backup with no previous produced format ' + onDisk.version
        + '; the core uses 2');
    }
  }

  // --- restore vs restore --------------------------------------------------
  const throughAdapter = path.join(work, 'restored-adapter');
  if (backed) {
    cli(['restore', written, throughAdapter]);
    const snapshot = JSON.parse(fs.readFileSync(written, 'utf8'));
    const coreRestore = engine({operation: 'restore', snapshot});
    const adapterFiles = readTree(throughAdapter);
    const sourceFiles = readTree(source);
    if (adapterFiles.length !== sourceFiles.length) {
      problems.push(`adapter restore wrote ${adapterFiles.length} file(s), the source has `
        + sourceFiles.length);
    }
    // What the core says it would write must be what the adapter did write.
    const coreList = coreRestore.files.map((file) => file.path).sort();
    const adapterList = adapterFiles.map((file) => file.path).sort();
    if (JSON.stringify(coreList) !== JSON.stringify(adapterList)) {
      problems.push('the core and the adapter restored different path sets: '
        + JSON.stringify(coreList) + ' vs ' + JSON.stringify(adapterList));
    }
    for (const entry of coreRestore.files) {
      const onDiskNow = adapterFiles.find((file) => file.path === entry.path);
      if (!onDiskNow) continue;
      // `encoding` says how the core spelled the payload: base64 for format 2 and 3, a decimal
      // array for format 1. Decoding it the wrong way reported a byte disagreement for every
      // file, which is what the first version of this did.
      const coreBytes = coreRestore.encoding === 'base64'
        ? Buffer.from(entry.bytes, 'base64')
        : Buffer.from(entry.bytes.map((value) => value & 0xff));
      if (!coreBytes.equals(onDiskNow.bytes)) {
        problems.push('the core and the adapter disagree on the bytes of ' + entry.path);
      }
      if ((entry.mode & 0o777) !== (onDiskNow.mode & 0o777)) {
        problems.push(`the core reports mode ${(entry.mode & 0o777).toString(8)} for `
          + `${entry.path} and the adapter wrote ${(onDiskNow.mode & 0o777).toString(8)}`);
      }
    }
    for (const original of sourceFiles) {
      const back = adapterFiles.find((file) => file.path === original.path);
      if (!back || !back.bytes.equals(original.bytes)) {
        problems.push('adapter restore did not reproduce the bytes of ' + original.path);
      }
    }
  }

  // --- squash vs squash ----------------------------------------------------
  if (backed) {
    const foldedByAdapter = path.join(work, 'folded-adapter.json');
    const folded = cli(['squash', written, foldedByAdapter]);
    const snapshot = JSON.parse(fs.readFileSync(written, 'utf8'));
    const coreFolded = engine({operation: 'squash', snapshot});
    const adapterFolded = JSON.parse(fs.readFileSync(foldedByAdapter, 'utf8'));
    if (folded) {
      if (adapterFolded.version !== coreFolded.snapshot.version) {
        problems.push(`squash kept format ${coreFolded.snapshot.version} in the core and produced `
          + `${adapterFolded.version} through the adapter`);
      }
      if (adapterFolded.checksum !== coreFolded.snapshot.checksum) {
        problems.push('squash produced checksum ' + adapterFolded.checksum.slice(0, 16)
          + ' through the adapter and ' + coreFolded.snapshot.checksum.slice(0, 16)
          + ' from the core');
      }
      // Squashing a self-contained snapshot leaves it unchanged, so the original checksum must
      // survive both paths.
      if (adapterFolded.checksum !== snapshot.checksum) {
        problems.push('squashing a self-contained snapshot through the adapter changed its '
          + 'checksum');
      }
    }
  }

  // --- and the same comparison for a chain, where the format must become 3 -----
  {
    const base = path.join(work, 'chain-base.json');
    cli(['backup', source, base]);
    const delta = path.join(work, 'chain-delta.json');
    const deltaBacked = cli(['backup', source, delta, base]);
    if (deltaBacked) {
      const deltaOnDisk = JSON.parse(fs.readFileSync(delta, 'utf8'));
      if (deltaOnDisk.version !== 3) {
        problems.push('backup with a previous produced format ' + deltaOnDisk.version
          + '; a chain requires 3');
      }
      // A delta needs its parent, and the core must audit the pair the adapter wrote.
      const baseOnDisk = JSON.parse(fs.readFileSync(base, 'utf8'));
      const audit = engine({
        operation: 'audit',
        snapshot: deltaOnDisk,
        parents: [baseOnDisk],
      });
      if (audit.valid !== true) {
        problems.push('the delta the adapter wrote does not audit valid with its parent: '
          + JSON.stringify(audit.issues).slice(0, 160));
      }
    }
  }
} finally {
  fs.rmSync(work, {recursive: true, force: true});
}

if (problems.length) {
  console.error(`Layers: ${problems.length} disagreement(s) between the adapter and the core`);
  for (const problem of problems) console.error('  ' + problem);
  process.exit(1);
}
console.log('Layers: backup, restore and squash agree between the adapter and the core '
  + '(same snapshot, same files, same bytes, same checksum)');
