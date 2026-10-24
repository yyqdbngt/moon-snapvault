import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {backup, restore, squash, deltaFromDigests, resolveInPieces, squashInPieces, manifestOnly} from './filesystem.mjs';
import {engine} from './engine.mjs';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'snapvault-integration-'));
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
try {
  const source = path.join(base, 'source');
  fs.mkdirSync(source);
  fs.mkdirSync(path.join(source, 'nested'));
  fs.writeFileSync(path.join(source, 'nested/a.bin'), Buffer.from([0, 255, 1, 2]));
  fs.writeFileSync(path.join(source, 'copy.bin'), Buffer.from([0, 255, 1, 2]));
  // A payload big enough that reusing it is visible in the file size.
  fs.writeFileSync(path.join(source, 'nested/big.bin'), crypto.randomBytes(64 * 1024));
  const one = path.join(base, 'one.json');
  const stats = backup(source, one);
  assert.equal(stats.deduplicated_bytes, 4);
  assert.equal(stats.format, 2, 'a backup without a previous snapshot is self contained');
  const restored = path.join(base, 'restored');
  restore(one, restored);
  assert.deepEqual(fs.readFileSync(path.join(restored, 'nested/a.bin')), fs.readFileSync(path.join(source, 'nested/a.bin')));
  assert.throws(() => restore(one, restored));
  assert.throws(() => backup(source, one));
  assert.throws(() => backup(source, path.join(source, 'bad.json')));

  // A backup with a previous snapshot is a format 3 delta: it stores only the
  // objects the chain does not already hold.
  fs.writeFileSync(path.join(source, 'copy.bin'), 'changed');
  const two = path.join(base, 'two.json');
  const deltaStats = backup(source, two, one);
  const delta = read(two);
  assert.equal(delta.version, 3);
  assert.equal(delta.parent, read(one).checksum);
  assert.equal(deltaStats.parent, read(one).checksum);
  assert.equal(Object.keys(delta.objects).length, 1, 'only the changed file is stored');
  assert.equal(deltaStats.reused_object_bytes, 64 * 1024 + 4);
  // The same tree written self contained carries the big payload twice.
  const selfContained = path.join(base, 'self-contained.json');
  const fullStats = backup(source, selfContained);
  assert.ok(
    deltaStats.snapshot_bytes < fullStats.snapshot_bytes / 2,
    `delta ${deltaStats.snapshot_bytes} should be far smaller than ${fullStats.snapshot_bytes}`,
  );

  const diff = engine({operation: 'diff', old: read(one), new: delta});
  assert.deepEqual(diff.modified, ['copy.bin']);

  // Restoring a delta needs its chain, and refuses to run without one.
  assert.throws(() => restore(two, path.join(base, 'no-chain')), /corrupted/);
  assert.equal(fs.existsSync(path.join(base, 'no-chain')), false);
  const deltaTarget = path.join(base, 'delta-out');
  const deltaResult = restore(two, deltaTarget, [one]);
  assert.equal(deltaResult.chain_depth, 2);
  assert.equal(fs.readFileSync(path.join(deltaTarget, 'copy.bin'), 'utf8'), 'changed');
  assert.deepEqual(fs.readFileSync(path.join(deltaTarget, 'nested/a.bin')), fs.readFileSync(path.join(source, 'nested/a.bin')));

  // A delta of a delta resolves through the whole chain.
  fs.writeFileSync(path.join(source, 'nested/a.bin'), Buffer.from([9, 9, 9]));
  const three = path.join(base, 'three.json');
  backup(source, three, two, [one]);
  const third = read(three);
  assert.equal(third.version, 3);
  assert.equal(third.parent, delta.checksum);
  const chainTarget = path.join(base, 'chain-out');
  const chainResult = restore(three, chainTarget, [one, two]);
  assert.equal(chainResult.chain_depth, 3);
  assert.deepEqual(fs.readFileSync(path.join(chainTarget, 'nested/a.bin')), Buffer.from([9, 9, 9]));

  // A delta whose parent is corrupt must not restore.
  const brokenParent = read(one);
  for (const key of Object.keys(brokenParent.objects)) {
    brokenParent.objects[key] = Buffer.from('corrupted').toString('base64');
  }
  const brokenFile = path.join(base, 'broken-parent.json');
  fs.writeFileSync(brokenFile, JSON.stringify(brokenParent));
  assert.equal(engine({operation: 'audit', snapshot: third, parents: [brokenParent, read(two)]}).valid, false);
  const brokenTarget = path.join(base, 'broken-out');
  assert.throws(() => restore(three, brokenTarget, [brokenFile, two]));
  assert.equal(fs.existsSync(brokenTarget), false);

  // The path the adapter takes when a delta request would not fit: a manifest-only
  // parent plus the chain's digests has to produce the same snapshot as sending
  // the parent whole, and it has to restore through the chain.
  const slimFiles = [];
  (function walk(directory, relative) {
    for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
      const name = relative ? relative + '/' + entry.name : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute, name);
      else if (entry.isFile()) {
        slimFiles.push({
          path: name,
          content_base64: fs.readFileSync(absolute).toString('base64'),
          mode: fs.statSync(absolute).mode & 0o777,
        });
      }
    }
  })(source, '');
  const slimStats = deltaFromDigests(slimFiles, read(two), [read(one)]);
  const withParent = engine({
    operation: 'create', format: 3, previous: read(two), parents: [read(one)], files: slimFiles,
  });
  assert.equal(slimStats.snapshot.checksum, withParent.snapshot.checksum,
    'the digest path must build the same snapshot');
  assert.equal(JSON.stringify(slimStats.snapshot.objects),
    JSON.stringify(withParent.snapshot.objects));
  // The core could not verify the base, and says so instead of claiming it did.
  assert.equal(slimStats.statistics.base_verified, false);
  assert.equal(withParent.statistics.base_verified, true);
  const slimFile = path.join(base, 'slim.json');
  fs.writeFileSync(slimFile, JSON.stringify(slimStats.snapshot));
  const slimTarget = path.join(base, 'slim-out');
  const slimRestored = restore(slimFile, slimTarget, [two, one]);
  assert.equal(slimRestored.chain_depth, 3);
  assert.deepEqual(fs.readFileSync(path.join(slimTarget, 'nested/a.bin')), Buffer.from([9, 9, 9]));

  // A digest the chain does not have must fail at read time, not silently.
  // deltaFromDigests only ever declares what the chain really holds, so the claim
  // is forged here to exercise the reader's defence.
  const parentFile = read(two);
  const invented = crypto.createHash('sha256').update('never stored').digest('hex');
  const lie = engine({
    operation: 'create', format: 3, files: [
      ...slimFiles,
      {path: 'invented.bin', content_base64: Buffer.from('never stored').toString('base64'), mode: 0o644},
    ],
    previous: {version: parentFile.version, parent: parentFile.parent ?? null,
      files: parentFile.files, checksum: parentFile.checksum},
    parents: [read(one)],
    known_objects: [
      ...Object.keys(parentFile.objects), ...Object.keys(read(one).objects), invented,
    ],
  });
  assert.equal(invented in lie.snapshot.objects, false);
  const lieFile = path.join(base, 'lie.json');
  fs.writeFileSync(lieFile, JSON.stringify(lie.snapshot));
  assert.equal(engine({operation: 'audit', snapshot: lie.snapshot, parents: [read(two), read(one)]}).valid, false);
  assert.throws(() => restore(lieFile, path.join(base, 'lie-out'), [two, one]));
  assert.equal(fs.existsSync(path.join(base, 'lie-out')), false);

  // The piecewise paths: locating and extracting per link has to produce exactly
  // what a single fit-in-one-request restore produces.
  const chainSnapshots = [read(three), read(two), read(one)];
  const wholeRestore = engine({operation: 'restore', snapshot: chainSnapshots[0],
    parents: [chainSnapshots[1], chainSnapshots[2]]});
  const pieces = resolveInPieces(chainSnapshots[0], [chainSnapshots[1], chainSnapshots[2]]);
  const asMap = (list) => Object.fromEntries(list.map((f) => [f.path, Buffer.from(f.bytes, 'base64').toString('hex')]));
  assert.deepEqual(asMap(pieces.files), asMap(wholeRestore.files));
  assert.equal(pieces.piecewise, true);
  assert.equal(pieces.chain_depth, 3);
  // A selection works through the piecewise path too.
  const subset = resolveInPieces(chainSnapshots[0], [chainSnapshots[1], chainSnapshots[2]], ['nested']);
  assert.deepEqual(subset.files.map((f) => f.path).sort(), ['nested/a.bin', 'nested/big.bin']);
  // A link that is not supplied is reported, not written around.
  assert.throws(() => resolveInPieces(chainSnapshots[0], [chainSnapshots[2]]), /missing a parent/);

  const piecewiseSquash = squashInPieces(chainSnapshots[0], [chainSnapshots[1], chainSnapshots[2]], 3);
  assert.equal(piecewiseSquash.audited, true);
  const directSquash = engine({operation: 'squash', snapshot: chainSnapshots[0],
    parents: [chainSnapshots[1], chainSnapshots[2]], format: 3});
  assert.equal(piecewiseSquash.snapshot.checksum, directSquash.snapshot.checksum,
    'the piecewise squash must equal the one-request squash');
  assert.deepEqual(piecewiseSquash.snapshot.objects, directSquash.snapshot.objects);
  assert.deepEqual(manifestOnly(chainSnapshots[1]).files, chainSnapshots[1].files);

  // Squashing compacts the whole chain into one self-contained file that no
  // longer needs its parents, and selects on the way out.
  const squashedFile = path.join(base, 'squashed.json');
  const squashStats = squash(three, squashedFile, [one, two]);
  assert.equal(squashStats.chain_depth, 3);
  assert.equal(read(squashedFile).parent, null);
  const squashedTarget = path.join(base, 'squashed-out');
  const squashedResult = restore(squashedFile, squashedTarget);
  assert.equal(squashedResult.chain_depth, 1);
  assert.deepEqual(fs.readFileSync(path.join(squashedTarget, 'nested/a.bin')), Buffer.from([9, 9, 9]));
  // Squashing is idempotent: doing it again changes nothing.
  const twiceFile = path.join(base, 'squashed-twice.json');
  squash(squashedFile, twiceFile, []);
  assert.equal(read(twiceFile).checksum, read(squashedFile).checksum);

  // Selective restore writes only the requested subtree.
  const partialTarget = path.join(base, 'partial-out');
  const partial = restore(three, partialTarget, [one, two], ['nested']);
  // nested/a.bin and nested/big.bin; copy.bin sits at the root and is skipped.
  assert.equal(partial.files, 2);
  assert.equal(partial.total_files, 3);
  assert.ok(fs.existsSync(path.join(partialTarget, 'nested/a.bin')));
  assert.equal(fs.existsSync(path.join(partialTarget, 'copy.bin')), false);
  assert.throws(() => restore(three, path.join(base, 'partial-miss'), [one, two], ['nope']), /not found/);
  assert.equal(fs.existsSync(path.join(base, 'partial-miss')), false);

  // Corruption inside the delta itself is caught the same way as before: swap
  // the stored payload for a different byte sequence so only the digest notices.
  const tampered = read(two);
  const localDigest = Object.keys(tampered.objects)[0];
  tampered.objects[localDigest] = Buffer.from('not the original bytes').toString('base64');
  assert.equal(engine({operation: 'audit', snapshot: tampered, parents: [read(one)]}).valid, false);
  const corrupt = path.join(base, 'corrupt.json');
  fs.writeFileSync(corrupt, JSON.stringify(tampered));
  const untouched = path.join(base, 'untouched');
  assert.throws(() => restore(corrupt, untouched, [one]));
  assert.equal(fs.existsSync(untouched), false);

  // An unreferenced object that does not match its key is corruption too, and
  // restore must not create the destination for it.
  const valid = read(two);
  valid.objects['0'.repeat(64)] = [1, 2, 3]; // decimal payload under a base64 format
  const spareCorrupt = path.join(base, 'spare-corrupt.json');
  fs.writeFileSync(spareCorrupt, JSON.stringify(valid));
  assert.equal(engine({operation: 'audit', snapshot: valid, parents: [read(one)]}).valid, false);
  const spareTarget = path.join(base, 'spare-target');
  assert.throws(() => restore(spareCorrupt, spareTarget, [one]));
  assert.equal(fs.existsSync(spareTarget), false);

  // Permission bits survive the process umask.
  fs.writeFileSync(path.join(source, 'run.sh'), '#!/bin/sh\n');
  fs.chmodSync(path.join(source, 'run.sh'), 0o777);
  const withMode = path.join(base, 'mode.json');
  backup(source, withMode);
  const previousUmask = process.umask(0o077);
  const modeTarget = path.join(base, 'mode-out');
  const modeResult = restore(withMode, modeTarget);
  process.umask(previousUmask);
  assert.equal(fs.statSync(path.join(modeTarget, 'run.sh')).mode & 0o777, 0o777);
  assert.equal(modeResult.modes_applied, modeResult.files);

  // Names that collide only after Unicode normalization cannot be restored to a
  // normalizing filesystem; the adapter refuses before writing anything.
  const colliding = engine({files: [
    {path: 'caf\u00e9.txt', text: 'nfc'},
    {path: 'cafe\u0301.txt', text: 'nfd'},
  ]}).snapshot;
  const collidingFile = path.join(base, 'colliding.json');
  fs.writeFileSync(collidingFile, JSON.stringify(colliding));
  assert.equal(engine({operation: 'audit', snapshot: colliding}).valid, true);
  const collidingTarget = path.join(base, 'colliding-out');
  assert.throws(() => restore(collidingFile, collidingTarget), /Unicode normalization/);
  assert.equal(fs.existsSync(collidingTarget), false);

  console.log('Snapshot integration: base and delta snapshots, declared-objects deltas, piecewise restore and squash, chain restore, squash, selective restore, dedup, incremental diff, no overwrite, containment, corruption rejection, umask-independent modes and portable-path rejection passed');
} finally {
  fs.rmSync(base, {recursive: true, force: true});
}
