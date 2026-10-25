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
  // Fresh tree each time, so a cached page cannot make one run look faster than the next. The
  // directory is created here rather than under `work`, because the retry loop runs after
  // `work` has been removed - which is a bug this function had when the retry was added.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapvault-perf-run-'));
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
    // Five runs, take the fastest. Taking the minimum is the point: it is the measurement least
    // contaminated by whatever else the machine is doing, and it is what a reader would see on
    // an idle host.
    const runs = [];
    for (let attempt = 0; attempt < 5; attempt++) runs.push(timeOne(item));
    measured[item.name] = Math.round(Math.min(...runs));
  }
} finally {
  fs.rmSync(work, {recursive: true, force: true});
}

if (WRITE) {
  fs.mkdirSync(path.dirname(baselinePath), {recursive: true});
  const existing = fs.existsSync(baselinePath)
    ? JSON.parse(fs.readFileSync(baselinePath, 'utf8'))
    : {};
  // Keep the other platforms: recording Linux must not discard the macOS numbers.
  const platforms = {...(existing.platforms ?? {})};
  // Carry an older single-platform file forward, whichever platform it happened to be.
  // Requiring it to match the current one silently dropped the other platform's numbers.
  if (existing.platform && existing.milliseconds && !platforms[existing.platform]) {
    platforms[existing.platform] = existing.milliseconds;
  }
  platforms[process.platform] = measured;
  fs.writeFileSync(baselinePath, JSON.stringify({
    note: 'Fastest of three runs, milliseconds, per platform. The check fails at a factor '
      + `of ${FACTOR}, not at a percentage, because that is the difference between a real `
      + 'regression and scheduler noise. Record on the CI runner for the platform, not on a '
      + 'workstation: the two differ by up to a factor of two, which the factor of two then '
      + 'has to absorb. Re-record with `node scripts/perf-check.mjs --write` after a '
      + 'deliberate change, and update the figures in README.md to match.',
    platforms,
  }, null, 2) + '\n');
  console.log('Perf: recorded ' + process.platform + ' - ' + Object.entries(measured)
    .map(([name, ms]) => `${name} ${ms} ms`).join(', '));
  process.exit(0);
}

if (!fs.existsSync(baselinePath)) {
  throw new Error('perf-check: no baseline; run with --write');
}
const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));

// One baseline per platform. Timings are not comparable across operating systems - a 1 MiB
// backup takes 134 ms on macOS and 190 ms on the Linux runner - and a check that fails for a
// reason that is not a regression gets deleted.
const recorded = baseline.platforms?.[process.platform]
  ?? (baseline.platform === process.platform ? baseline.milliseconds : null);

// Whether to fail or only report. The baseline belongs to the CI runner, not to whatever
// machine happens to run the ladder: a workstation with a load average of 11 measured 268 ms
// against a 130 ms runner baseline, which is not a regression and not something a retry can
// fix. Enforcing on CI - where the numbers were recorded - keeps the gate meaningful, and
// printing elsewhere keeps the local run informative without making it flaky.
const ENFORCE = process.env.CI === 'true' || process.env.CI === '1'
  || process.env.SNAPVAULT_ENFORCE_PERF === '1';

if (!recorded) {
  // Measure anyway and print, so the numbers needed to record a baseline appear in the CI
  // log of whichever job runs on that platform. Failing here would be wrong: the absence of
  // a baseline is not a regression.
  console.log('Perf: no baseline for ' + process.platform + ', measured '
    + Object.entries(measured).map(([name, ms]) => `${name} ${ms} ms`).join(', '));
  console.log('  record it with `node scripts/perf-check.mjs --write` on this platform');
  process.exit(0);
}

// A measurement over the threshold is retried before it is believed. On a loaded machine the
// fastest of five runs can still be twice the idle figure - this check failed at 288 ms against
// a 140 ms baseline while the host had a load average of 11 - and a check that fails because
// the machine is busy is a check that gets switched off. A real regression does not get faster
// when the load subsides, so retrying separates the two cases without weakening the threshold.
const ATTEMPTS = 3;
const problems = [];
for (const [name, before] of Object.entries(recorded)) {
  const now = measured[name];
  if (now === undefined) {
    problems.push(`${name}: in the baseline but not measured now`);
    continue;
  }
  if (now <= before * FACTOR) continue;

  const item = cases.find((candidate) => candidate.name === name);
  let best = now;
  let attempt = 0;
  while (attempt < ATTEMPTS - 1 && best > before * FACTOR) {
    attempt += 1;
    // Give the machine a moment; a transient compile or a neighbouring job is the usual cause.
    spawnSync('sleep', ['2']);
    best = Math.min(best, ...Array.from({length: 3}, () => Math.round(timeOne(item))));
  }
  if (best > before * FACTOR) {
    problems.push(`${name}: ${before} ms baseline, best of ${3 + ATTEMPTS * 3} runs ${best} ms, `
      + `more than ${FACTOR}x slower even after retries`);
  }
}

if (problems.length && !ENFORCE) {
  // Reported, not failed: this machine is not the one the baseline describes.
  for (const problem of problems) {
    console.log(`perf: not enforced here - ${problem}`);
  }
  console.log('perf: the baseline belongs to the CI runner; set CI=true or '
    + 'SNAPVAULT_ENFORCE_PERF=1 to enforce on this machine');
  process.exit(0);
}
if (problems.length) {
  for (const problem of problems) console.error('perf: ' + problem);
  console.error('perf: if this is deliberate, update README.md and re-record with --write');
  process.exit(1);
}
console.log('Perf: ' + process.platform + ' - ' + Object.entries(measured)
  .map(([name, ms]) => `${name} ${ms} ms`).join(', ')
  + ` (no case is ${FACTOR}x slower than the baseline)`);
