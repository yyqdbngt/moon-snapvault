// Reads snapshots written by the published 0.2.0 with the current code.
//
//   node scripts/compat.mjs
//
// The fixtures in `tests/compat/` were produced by `yyqdbngt/moon_snapvault@0.2.0` from
// MoonCakes and committed unchanged, so this tests against the real published output rather
// than against a reconstruction of it.
//
// Why it matters: 0.2.0 is the version `moon add` resolves. Anyone who used it has snapshots
// on disk. Those files are `"version": 1` with decimal byte arrays, and nothing else in the
// suite produces that shape - the format-1 fixtures are written by hand from the current code,
// which is exactly the circularity this check avoids.
//
// It asserts the four things a user would do with an old file: audit it, restore it, diff two
// of them, and plan retention over them. It deliberately does not assert that a 0.2.0 file can
// be extended, because it cannot: `previous=` was accepted there but what it wrote was
// self-contained, so there is no chain to extend.
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = path.join(root, 'tests/compat');
const cli = [
  path.join(root, '_build/js/release/build/cmd/main/main.js'),
  path.join(root, '_build/js/debug/build/cmd/main/main.js'),
].find((candidate) => fs.existsSync(candidate));
if (!cli) throw new Error('compat: build first (moon build --target js --release)');

function read(name) {
  return JSON.parse(fs.readFileSync(path.join(fixtures, name), 'utf8'));
}

// A refusal is a finding, not an exception: it names which step stopped working, which is what
// someone reading a failed run needs. Throwing here instead produced a stack trace with the
// message buried in it, as the format-1 experiment showed.
function ask(label, request) {
  const result = spawnSync(process.execPath, [cli, '-'], {
    input: JSON.stringify(request), encoding: 'utf8', timeout: 120000,
  });
  const text = (result.stdout || '').trim();
  if (!text) {
    problems.push(`${label}: no answer (exit ${result.status}): `
      + (result.stderr || '').slice(0, 160));
    return null;
  }
  let answer;
  try {
    answer = JSON.parse(text);
  } catch (err) {
    problems.push(`${label}: answer is not JSON: ${text.slice(0, 160)}`);
    return null;
  }
  if (result.status !== 0) {
    problems.push(`${label}: refused with exit ${result.status}: `
      + JSON.stringify(answer).slice(0, 200));
    return null;
  }
  return answer;
}

const problems = [];
const first = read('0.2.0-first.json');
const second = read('0.2.0-second.json');

// The fixtures must still be what the published version wrote.
for (const [name, snapshot] of [['first', first], ['second', second]]) {
  if (snapshot.version !== 1) {
    problems.push(`${name}: version is ${snapshot.version}, but 0.2.0 only wrote 1`);
  }
  const objectValues = Object.values(snapshot.objects ?? {});
  if (!objectValues.every((value) => Array.isArray(value))) {
    problems.push(`${name}: objects are not decimal arrays, so this did not come from 0.2.0`);
  }
}

// 1. Audit.
for (const [name, snapshot] of [['first', first], ['second', second]]) {
  const report = ask(`${name}: audit`, {operation: 'audit', snapshot});
  if (report === null) continue;
  if (report.valid !== true) {
    problems.push(`${name}: a published snapshot no longer audits clean: `
      + JSON.stringify(report.issues).slice(0, 200));
  }
  if (report.format !== 1) problems.push(`${name}: reported format ${report.format}, wanted 1`);
}

// 2. Restore, and check the bytes are what was stored.
const restored = ask('restore', {operation: 'restore', snapshot: first});
if (restored !== null) {
if (restored.files.length !== first.files.length) {
  problems.push(`restore returned ${restored.files.length} files, the manifest lists `
    + first.files.length);
}
for (const file of restored.files) {
  const listed = first.files.find((entry) => entry.path === file.path);
  if (!listed) {
    problems.push(`restore returned ${file.path}, which is not in the manifest`);
    continue;
  }
  // Format 1 reports its bytes as a decimal array; three values is the 3-byte "abc".
  const bytes = Array.isArray(file.bytes) ? file.bytes : null;
  if (bytes === null) {
    problems.push(`${file.path}: payload is not a decimal array (encoding ${restored.encoding})`);
  } else if (bytes.length !== listed.size) {
    problems.push(`${file.path}: ${bytes.length} bytes restored, manifest says ${listed.size}`);
  }
}
}

// 3. Diff two published snapshots.
const diff = ask('diff', {operation: 'diff', old: first, new: second});
if (diff === null) {
  // Reported already.
} else if (!Array.isArray(diff.added) || !diff.added.includes('new.txt')) {
  problems.push('diff did not report new.txt as added: ' + JSON.stringify(diff).slice(0, 160));
}
if (!Array.isArray(diff.removed) || !diff.removed.includes('docs/b.md')) {
  problems.push('diff did not report docs/b.md as removed');
}

// 4. Retention over published snapshots.
const plan = ask('retention', {
  operation: 'retention',
  snapshots: [{id: 'old', snapshot: first}, {id: 'newer', snapshot: second}],
  keep: ['newer'],
});
if (plan !== null && (!Array.isArray(plan.drop_snapshots) || plan.drop_snapshots[0] !== 'old')) {
  problems.push('retention did not plan to drop the unreferenced published snapshot: '
    + JSON.stringify(plan.drop_snapshots));
}

if (problems.length) {
  for (const problem of problems) console.error('compat: ' + problem);
  process.exit(1);
}
console.log('Compat: snapshots written by the published 0.2.0 still audit, restore, diff and '
  + 'plan retention');
