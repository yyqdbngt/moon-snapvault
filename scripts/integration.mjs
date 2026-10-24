import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {backup, restore} from './filesystem.mjs';
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

  console.log('Snapshot integration: base and delta snapshots, chain restore, dedup, incremental diff, no overwrite, containment, corruption rejection, umask-independent modes and portable-path rejection passed');
} finally {
  fs.rmSync(base, {recursive: true, force: true});
}
