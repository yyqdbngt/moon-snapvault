import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {backup, restore} from './filesystem.mjs';
import {engine} from './engine.mjs';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'snapvault-integration-'));
try {
  const source = path.join(base, 'source');
  fs.mkdirSync(source);
  fs.mkdirSync(path.join(source, 'nested'));
  fs.writeFileSync(path.join(source, 'nested/a.bin'), Buffer.from([0, 255, 1, 2]));
  fs.writeFileSync(path.join(source, 'copy.bin'), Buffer.from([0, 255, 1, 2]));
  const one = path.join(base, 'one.json');
  const stats = backup(source, one);
  assert.equal(stats.deduplicated_bytes, 4);
  const restored = path.join(base, 'restored');
  restore(one, restored);
  assert.deepEqual(fs.readFileSync(path.join(restored, 'nested/a.bin')), fs.readFileSync(path.join(source, 'nested/a.bin')));
  assert.throws(() => restore(one, restored));
  assert.throws(() => backup(source, one));
  assert.throws(() => backup(source, path.join(source, 'bad.json')));

  fs.writeFileSync(path.join(source, 'copy.bin'), 'changed');
  const two = path.join(base, 'two.json');
  backup(source, two, one);
  const snapshot = JSON.parse(fs.readFileSync(two, 'utf8'));
  const diff = engine({operation: 'diff', old: JSON.parse(fs.readFileSync(one, 'utf8')), new: snapshot});
  assert.equal(diff.modified.length, 1);

  const digest = snapshot.files[0].digest;
  snapshot.objects[digest][0] ^= 1;
  assert.equal(engine({operation: 'audit', snapshot}).valid, false);
  const corrupt = path.join(base, 'corrupt.json');
  fs.writeFileSync(corrupt, JSON.stringify(snapshot));
  const untouched = path.join(base, 'untouched');
  assert.throws(() => restore(corrupt, untouched));
  assert.equal(fs.existsSync(untouched), false);

  // An unreferenced object that does not match its key is corruption too, and
  // restore must not create the destination for it.
  const valid = JSON.parse(fs.readFileSync(two, 'utf8'));
  valid.objects['0'.repeat(64)] = [1, 2, 3];
  const spareCorrupt = path.join(base, 'spare-corrupt.json');
  fs.writeFileSync(spareCorrupt, JSON.stringify(valid));
  assert.equal(engine({operation: 'audit', snapshot: valid}).valid, false);
  const spareTarget = path.join(base, 'spare-target');
  assert.throws(() => restore(spareCorrupt, spareTarget));
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

  console.log('Snapshot integration: binary restore, dedup, incremental diff, no overwrite, containment, unreferenced corruption, umask-independent modes and portable-path rejection passed');
} finally {
  fs.rmSync(base, {recursive: true, force: true});
}
