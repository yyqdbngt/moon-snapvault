// Runs the benchmark and checks that it produced plausible numbers.
//
//   node scripts/bench-smoke.mjs
//
// `cmd/bench/main.mbt` sits at 0/34 in the coverage report because `moon test` does not run
// binaries, and unlike the CLI nothing ever ran it - the numbers in the docs came from
// `scripts/bench.mjs`, which measures the adapter, not this. So a bug in the benchmark's own
// reporting would have gone unnoticed until someone quoted it.
//
// This does not assert timings: they vary by host and that is what `perf-check.mjs` is for.
// It asserts that each line is shaped like a measurement - a label, a positive duration and a
// finite throughput - because a benchmark that prints nonsense is worse than none.
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binary = [
  path.join(root, '_build/js/release/build/cmd/bench/bench.js'),
  path.join(root, '_build/js/debug/build/cmd/bench/bench.js'),
].find((candidate) => fs.existsSync(candidate));
if (!binary) throw new Error('bench-smoke: build first (moon build --target js --release)');

const result = spawnSync(process.execPath, [binary], {encoding: 'utf8', timeout: 600000});
if (result.status !== 0) {
  throw new Error('bench-smoke: the benchmark exited ' + result.status + ':\n'
    + (result.stdout || '') + (result.stderr || ''));
}

const problems = [];
const lines = result.stdout.trim().split('\n').filter(Boolean);
if (lines.length < 3) {
  problems.push(`expected at least three measurements, got ${lines.length}`);
}
for (const line of lines) {
  // e.g. "sha256 (this package): 30 ms, 266.67 MiB/s"
  const match = /^(.+?): (\d+(?:\.\d+)?) ms, (\d+(?:\.\d+)?) MiB\/s$/.exec(line);
  if (!match) {
    problems.push('not a measurement: ' + JSON.stringify(line.slice(0, 90)));
    continue;
  }
  const [, label, milliseconds, throughput] = match;
  if (Number(milliseconds) <= 0) problems.push(`${label}: ${milliseconds} ms is not positive`);
  if (!Number.isFinite(Number(throughput)) || Number(throughput) <= 0) {
    problems.push(`${label}: throughput ${throughput} is not a positive number`);
  }
}

if (problems.length) {
  for (const problem of problems) console.error('bench-smoke: ' + problem);
  process.exit(1);
}
console.log('Bench: ' + lines.length + ' measurements, all shaped like numbers '
  + '(' + lines.map((line) => line.split(':')[0]).join(', ') + ')');
