// Fails when a documented performance figure has drifted by a factor, not by a percent.
//
//   node scripts/perf-check.mjs          # compare against the recorded figures
//   node scripts/perf-check.mjs --write  # re-record after a deliberate change
//
// Why this exists, and why the threshold is loose. Numbers like "1 MiB in 292 ms" are on a
// README page and were hand-copied from a benchmark run. Nothing checked them, so they
// survived a change that added an fsync to every write - the kind of change that could
// easily have made them ten times wrong. Re-measuring showed the effect was 3-5%, inside
// the noise of this host, so the documented figures were still true. That is luck, not
// process.
//
// A tight threshold would be worse than none: the same code varies by 10% run to run on a
// shared machine, so a strict check would fail randomly and be switched off within a week.
// This compares against a factor of 2, which catches an order-of-magnitude regression - the
// sort of thing that happens when an algorithm changes or a sync is added where none was
// expected - and ignores scheduler noise.
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baselinePath = path.join(root, 'tests', 'perf-baseline.json');
const WRITE = process.argv.includes('--write');
const FACTOR = 2;

function cliPath(mode) {
  const candidate = path.join(root, '_build/js', mode, 'build/cmd/main/main.js');
  return fs.existsSync(candidate) ? candidate : null;
}

const cli = cliPath('release') ?? cliPath('debug');
if (!cli) throw new Error('perf-check: build first (moon build --target js --release)');

// The smallest and largest sizes the README quotes, so the check covers the same ground.
const cases = [
  {name: 'backup 1 MiB', size: 1, operation: 'backup'},
  {name: 'restore 1 MiB', size: 1, operation: 'restore'},
  {name: 'backup 8 MiB', size: 8, operation: 'backup'},
  {name: 'restore 8 MiB', size: 8, operation: 'restore'},
];

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'snapvault-perf-'));
const measured = {};

function timeOne({size, operation}) {
  // Fresh tree each time, so a cached page cannot make one run look faster than the next.
  const dir = fs.mkdtempSync(path.join(work, 'run-'));
  const source = path.join(dir, 'src');
  fs.mkdirSync(source);
  const chunk = Buffer.alloc(1024 * 1024, 0x5a);
  for (let index = 0; index < size; index++) {
    chunk.writeUInt32LE(index, 0);
    fs.writeFileSync(path.join(source, `f${index}.bin`), chunk);
  }
  const snapshot = path.join(dir, 'snap.json');
  const filesystem = path.join(root, 'scripts/filesystem.mjs');
  const backup = spawnSync(process.execPath, [filesystem, 'backup', source, snapshot],
    {encoding: 'utf8', timeout: 300000});
  if (backup.status !== 0) {
    throw new Error(`perf-check: backup failed: ${(backup.stdout || backup.stderr).slice(0, 200)}`);
  }
  if (operation === 'backup') {
    // Time the backup again on a second destination, since the first one was the setup.
    const again = path.join(dir, 'snap2.json');
    const started = process.hrtime.bigint();
    const run = spawnSync(process.execPath, [filesystem, 'backup', source, again],
      {encoding: 'utf8', timeout: 300000});
    const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
    if (run.status !== 0) throw new Error('perf-check: second backup failed');
    fs.rmSync(dir, {recursive: true, force: true});
    return elapsed;
  }
  const started = process.hrtime.bigint();
  const run = spawnSync(process.execPath,
    [filesystem, 'restore', snapshot, path.join(dir, 'out')],
    {encoding: 'utf8', timeout: 300000});
  const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
  if (run.status !== 0) {
    throw new Error(`perf-check: restore failed: ${(run.stdout || run.stderr).slice(0, 200)}`);
  }
  fs.rmSync(dir, {recursive: true, force: true});
  return elapsed;
}

try {
  for (const item of cases) {
    // Three runs, take the fastest: the fastest is the least contaminated by whatever else
    // the machine was doing, and it is what a reader would see on an idle host.
    const runs = [];
    for (let attempt = 0; attempt < 3; attempt++) runs.push(timeOne(item));
    measured[item.name] = Math.round(Math.min(...runs));
  }
} finally {
  fs.rmSync(work, {recursive: true, force: true});
}

if (WRITE) {
  fs.mkdirSync(path.dirname(baselinePath), {recursive: true});
  fs.writeFileSync(baselinePath, JSON.stringify({
    note: 'Fastest of three runs, milliseconds, on this host. The check fails at a factor '
      + `of ${FACTOR}, not at a percentage, because that is the difference between a real `
      + 'regression and scheduler noise. Re-record with `node scripts/perf-check.mjs --write` '
      + 'after a deliberate change, and update the figures in README.md to match.',
    platform: process.platform,
    milliseconds: measured,
  }, null, 2) + '\n');
  console.log('Perf: recorded ' + Object.entries(measured)
    .map(([name, ms]) => `${name} ${ms} ms`).join(', '));
  process.exit(0);
}

if (!fs.existsSync(baselinePath)) {
  throw new Error('perf-check: no baseline; run with --write');
}
const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));

if (baseline.platform !== process.platform) {
  // Timings are not comparable across operating systems, and pretending they are would make
  // this check fail on every other platform for a reason that is not a regression.
  console.log(`Perf: skipped - the baseline was recorded on ${baseline.platform}, this is `
    + `${process.platform}; timings are not comparable across them`);
  process.exit(0);
}

const problems = [];
for (const [name, before] of Object.entries(baseline.milliseconds)) {
  const now = measured[name];
  if (now === undefined) {
    problems.push(`${name}: in the baseline but not measured now`);
    continue;
  }
  if (now > before * FACTOR) {
    problems.push(`${name}: ${before} ms -> ${now} ms, more than ${FACTOR}x slower`);
  }
}

if (problems.length) {
  for (const problem of problems) console.error('perf: ' + problem);
  console.error('perf: if this is deliberate, update README.md and re-record with --write');
  process.exit(1);
}
console.log('Perf: ' + Object.entries(measured)
  .map(([name, ms]) => `${name} ${ms} ms`).join(', ')
  + ` (no case is ${FACTOR}x slower than the baseline)`);
