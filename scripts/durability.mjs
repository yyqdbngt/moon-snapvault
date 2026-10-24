// Checks that the adapter syncs what it later claims is safe.
//
//   node scripts/durability.mjs
//
// The product is a claim that a snapshot exists and can be restored. `writeFileSync`
// returns when the bytes reach the page cache, so without `fsync` a power cut can leave
// a snapshot whose name exists and whose length is zero - silent, and exactly the failure
// the project exists to prevent. Neither backup nor restore synced anything until this
// was measured, which is why the claim is now asserted rather than assumed.
//
// Counting calls cannot prove the disk honoured them; only cutting power can. What it does
// prove is that the code asks, which is the part under its control.
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const spy = path.join(root, 'scripts/fsync-spy.cjs');
const filesystem = path.join(root, 'scripts/filesystem.mjs');

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'snapvault-durability-'));
const problems = [];

function run(script, env, args) {
  const log = path.join(work, 'fsync-' + Math.random().toString(36).slice(2) + '.log');
  const result = spawnSync(process.execPath, ['--require', spy, script, ...args], {
    encoding: 'utf8',
    env: {...process.env, ...env, FSYNC_LOG: log},
  });
  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').length : 0;
  return {result, calls};
}

try {
  const workDir = path.join(work, 'work');
  const src = path.join(workDir, 'src');
  fs.mkdirSync(src, {recursive: true});
  for (let i = 0; i < 3; i++) fs.writeFileSync(path.join(src, `f${i}.bin`), `content ${i}`);
  const snapshot = path.join(workDir, 'snap.json');

  // 1. backup must sync the snapshot before publishing it.
  const backup = run(filesystem, {}, ['backup', src, snapshot]);
  if (backup.result.status !== 0) {
    problems.push('backup failed: ' + (backup.result.stderr || '').slice(0, 200));
  } else if (backup.calls < 2) {
    problems.push(`backup made ${backup.calls} sync call(s); a durable one needs the file `
      + 'and its directory');
  }

  // 2. restore must sync every file it writes, plus the directories it touched.
  const target = path.join(workDir, 'out');
  const restore = run(filesystem, {}, ['restore', snapshot, target]);
  if (restore.result.status !== 0) {
    problems.push('restore failed: ' + (restore.result.stderr || '').slice(0, 200));
  } else {
    const reported = JSON.parse(restore.result.stdout);
    if (reported.durable !== true) {
      problems.push('restore did not report durable: true');
    }
    if (restore.calls < 4) {
      problems.push(`restore made ${restore.calls} sync call(s) for 3 files; expected at `
        + 'least one per file plus the directory');
    }
  }

  // 3. The opt-out must work, and must be visible in the report rather than silent.
  const target2 = path.join(workDir, 'out2');
  const skipped = run(filesystem, {SNAPVAULT_NO_FSYNC: '1'}, ['restore', snapshot, target2]);
  if (skipped.result.status !== 0) {
    problems.push('restore with SNAPVAULT_NO_FSYNC=1 failed: '
      + (skipped.result.stderr || '').slice(0, 200));
  } else {
    if (skipped.calls !== 0) {
      problems.push(`SNAPVAULT_NO_FSYNC=1 still made ${skipped.calls} sync call(s)`);
    }
    const reported = JSON.parse(skipped.result.stdout);
    if (reported.durable !== false) {
      problems.push('the opt-out did not report durable: false, so a caller cannot tell');
    }
  }

  // 4. The restored contents must be right in both modes; durability must not change data.
  for (const directory of [target, target2]) {
    if (!fs.existsSync(directory)) continue;
    for (let i = 0; i < 3; i++) {
      const text = fs.readFileSync(path.join(directory, `f${i}.bin`), 'utf8');
      if (text !== `content ${i}`) {
        problems.push(`${path.basename(directory)}/f${i}.bin is ${JSON.stringify(text)}`);
      }
    }
  }
} finally {
  fs.rmSync(work, {recursive: true, force: true});
}

if (problems.length) {
  for (const problem of problems) console.error('durability: ' + problem);
  process.exit(1);
}
console.log('Durability: backup and restore sync before reporting, the opt-out is reported honestly');
