// Measures which lines the white-box tests execute, and refuses to let that shrink.
//
//   node scripts/coverage.mjs          # compare against the recorded baseline
//   node scripts/coverage.mjs --write  # record the current numbers
//
// Why this exists: the coverage report showed that four arms of `run`'s dispatch table
// were never executed by `moon test`, that the base64 guard against a code unit above 255
// was never executed, and that three base64 refusals had no test at all. None of them were
// wrong; nothing would have noticed if they had been. Tests are added when someone thinks
// of a case, and coverage is the only thing that says which cases nobody thought of.
//
// The invariant is "uncovered lines may not grow": adding code without a test fails, and
// so does deleting a test. Chasing a percentage would reward deleting code; this does not.
//
// Two files are excluded because `moon test` cannot run them at all - they are binaries,
// not libraries - and excluding them silently would be worse than the gap they represent,
// so their numbers are printed and the reason is stated below.
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baselinePath = path.join(root, 'tests', 'coverage-baseline.json');
const WRITE = process.argv.includes('--write');

// Compiled to an executable, run by the CLI contract tests and by hand, never by
// `moon test`. Their behaviour is covered; their lines cannot be measured this way.
const NOT_MEASURABLE = {
  'cmd/main/main.mbt': 'the CLI entry point; `moon test` does not run it',
  'cmd/bench/main.mbt': 'the benchmark entry point; `moon test` does not run it',
};

function run(command, args) {
  const result = spawnSync(command, args, {cwd: root, encoding: 'utf8'});
  if (result.error) throw new Error(`${command} could not start: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed:\n`
      + (result.stdout || '') + (result.stderr || ''));
  }
  return result.stdout;
}

run('moon', ['coverage', 'clean']);
const tested = run('moon', ['test', '--target', 'js', '--enable-coverage']);
const summary = run('moon', ['coverage', 'report', '-f', 'summary']);

const totalMatch = /^Total tests: (\d+), passed: (\d+), failed: (\d+)/m.exec(tested);
if (!totalMatch || totalMatch[3] !== '0') {
  throw new Error('coverage: the test run did not pass, so its coverage is not meaningful:\n'
    + tested.slice(-400));
}

const measured = {};
for (const line of summary.split('\n')) {
  const match = /^([\w./-]+\.mbt): (\d+)\/(\d+)$/.exec(line.trim());
  if (!match) continue;
  measured[match[1]] = {covered: Number(match[2]), total: Number(match[3])};
}
if (Object.keys(measured).length === 0) {
  throw new Error('coverage: could not parse the summary:\n' + summary.slice(0, 400));
}

const problems = [];
const excluded = [];
const rows = [];
for (const [file, {covered, total}] of Object.entries(measured).sort()) {
  const uncovered = total - covered;
  if (NOT_MEASURABLE[file]) {
    excluded.push(`${file} ${covered}/${total} (${NOT_MEASURABLE[file]})`);
    continue;
  }
  rows.push({file, covered, total, uncovered});
}

if (WRITE) {
  const baseline = {};
  for (const row of rows) baseline[row.file] = {covered: row.covered, total: row.total};
  fs.mkdirSync(path.dirname(baselinePath), {recursive: true});
  fs.writeFileSync(baselinePath, JSON.stringify({
    note: 'Covered/total lines per file, from `moon test --target js --enable-coverage`. '
      + 'Uncovered lines may not grow; regenerate with `node scripts/coverage.mjs --write`.',
    files: baseline,
  }, null, 2) + '\n');
  console.log(`Coverage: recorded ${rows.length} files, `
    + `${rows.reduce((sum, row) => sum + row.covered, 0)}/`
    + `${rows.reduce((sum, row) => sum + row.total, 0)} lines covered`);
  for (const line of excluded) console.log('  not measurable: ' + line);
  process.exit(0);
}

if (!fs.existsSync(baselinePath)) {
  throw new Error('coverage: no baseline; run `node scripts/coverage.mjs --write`');
}
const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8')).files;

for (const row of rows) {
  const before = baseline[row.file];
  if (!before) {
    problems.push(`${row.file}: not in the baseline; record it with --write once its `
      + 'tests are in place');
    continue;
  }
  const uncoveredBefore = before.total - before.covered;
  if (row.covered < before.covered) {
    problems.push(`${row.file}: covered lines fell from ${before.covered} to ${row.covered}`);
  }
  if (row.uncovered > uncoveredBefore) {
    problems.push(`${row.file}: uncovered lines grew from ${uncoveredBefore} to `
      + `${row.uncovered} (total ${before.total} -> ${row.total}); new code needs a test, `
      + 'or --write if the gap is deliberate');
  }
}
for (const file of Object.keys(baseline)) {
  if (!measured[file]) problems.push(`${file}: in the baseline but no longer measured`);
}

const covered = rows.reduce((sum, row) => sum + row.covered, 0);
const total = rows.reduce((sum, row) => sum + row.total, 0);

if (problems.length) {
  for (const problem of problems) console.error('coverage: ' + problem);
  process.exit(1);
}
console.log(`Coverage: ${covered}/${total} lines executed by the white-box tests `
  + `(${((covered / total) * 100).toFixed(1)}%), no file lost coverage`);
for (const line of excluded) console.log('  not measurable: ' + line);
