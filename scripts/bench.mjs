// Reproducible timings for the adapter on synthetic, deterministic trees.
//
//   node scripts/bench.mjs
//
// Numbers depend on the build mode: scripts/engine.mjs prefers a release build
// and falls back to debug. Build with `moon build --target js --release` before
// quoting figures.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {backup, restore} from './filesystem.mjs';

const sizes = [0.25, 1, 4, 8];
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'snapvault-bench-'));
const rows = [];
try {
  for (const mib of sizes) {
    const source = path.join(base, `bin-${mib}`);
    fs.mkdirSync(source);
    const bytes = Math.round(mib * 1024 * 1024);
    fs.writeFileSync(path.join(source, 'random.bin'), crypto.randomBytes(bytes));
    const snapshotFile = path.join(base, `bin-${mib}.json`);
    let started = Date.now();
    backup(source, snapshotFile);
    const backupMs = Date.now() - started;
    const snapshotBytes = fs.statSync(snapshotFile).size;
    started = Date.now();
    restore(snapshotFile, path.join(base, `bin-${mib}-out`));
    const restoreMs = Date.now() - started;
    rows.push({kind: 'incompressible', mib, backupMs, restoreMs, ratio: snapshotBytes / bytes});
  }

  const many = path.join(base, 'many');
  fs.mkdirSync(many);
  for (let i = 0; i < 200; i++) fs.writeFileSync(path.join(many, `f${i}.txt`), 'x'.repeat(1024));
  let started = Date.now();
  backup(many, path.join(base, 'many.json'));
  const manyBackup = Date.now() - started;
  started = Date.now();
  restore(path.join(base, 'many.json'), path.join(base, 'many-out'));
  rows.push({kind: '200x1KiB', mib: 1024 * 200 / 1048576, backupMs: manyBackup, restoreMs: Date.now() - started, ratio: null});

  const text = path.join(base, 'text');
  fs.mkdirSync(text);
  for (let i = 0; i < 50; i++) fs.writeFileSync(path.join(text, `m${i}.md`), ('line ' + i + '\n').repeat(200));
  const sourceBytes = fs.readdirSync(text).reduce((a, f) => a + fs.statSync(path.join(text, f)).size, 0);
  started = Date.now();
  backup(text, path.join(base, 'text.json'));
  const textBackup = Date.now() - started;
  rows.push({kind: '50 text files', mib: sourceBytes / 1048576, backupMs: textBackup, restoreMs: null, ratio: fs.statSync(path.join(base, 'text.json')).size / sourceBytes});
} finally {
  fs.rmSync(base, {recursive: true, force: true});
}

console.log('workload            source MiB  backup ms  restore ms  snapshot/source');
for (const row of rows) {
  const mib = row.mib < 1 ? row.mib.toFixed(2) : row.mib.toFixed(1);
  console.log(
    row.kind.padEnd(18),
    mib.padStart(10),
    String(row.backupMs).padStart(10),
    String(row.restoreMs ?? '-').padStart(11),
    (row.ratio === null ? '-' : row.ratio.toFixed(2) + 'x').padStart(16),
  );
}
