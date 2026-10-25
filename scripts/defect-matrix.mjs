// Injects realistic defects one at a time and records which check catches each.
//
//   node scripts/defect-matrix.mjs            # run the matrix
//   node scripts/defect-matrix.mjs --list     # names only
//
// Why this exists. Coverage answers "which code did the tests execute"; it does not answer
// "would a mistake be noticed". Those are different questions, and the second one is the one a
// user cares about. A line can be executed by every test and still have its failure go
// unseen - a check that asserts the wrong field, a fixture that passes for an unrelated reason.
//
// Each entry below is a plausible mistake, not a random perturbation: the kind of edit someone
// makes in a hurry. For each, the script edits the source, rebuilds, runs the fast checks, and
// records which ones failed. Three outcomes matter:
//
//   caught by several   the net is redundant here, which is fine
//   caught by one       working as designed but brittle - worth knowing which
//   caught by none      a real gap, and the reason to run this at all
//
// It restores every file it touches, in a `finally`, and refuses to run on a dirty tree so a
// failure cannot leave a half-applied edit mixed with someone's work.
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIST = process.argv.includes('--list');

// Checks that run in a few seconds each. The full ladder takes two minutes; the matrix runs
// eleven times, so it uses the fast layer and says which layer caught what.
const FAST_CHECKS = [
  {name: 'unit', command: ['moon', ['test', '--target', 'js']], grep: /^Total tests: .*failed: (\d+)/},
  {name: 'fixtures', command: ['node', ['scripts/check.mjs']]},
  {name: 'cli-contract', command: ['node', ['scripts/cli-contract.mjs']]},
  {name: 'compat', command: ['node', ['scripts/compat.mjs']]},
  {name: 'claims', command: ['node', ['scripts/release-claims.mjs']]},
  {name: 'examples', command: ['node', ['scripts/examples.mjs']]},
  {name: 'durability', command: ['node', ['scripts/durability.mjs']]},
  // Slow, and left out of the first version of this matrix - which meant a defect only the
  // integration suite catches would have been reported as caught by nobody. That is the worst
  // possible error here: a false gap sends someone looking for a hole that is not there.
  {name: 'integration', command: ['node', ['scripts/integration.mjs']]},
];

// Each defect names the file, the exact text to replace, and what a reader would call the
// mistake. `old` must occur exactly once, or the matrix refuses - a silently unapplied defect
// would be recorded as "caught by nobody" and send someone hunting a non-existent gap.
const DEFECTS = [
  {
    name: 'publish without fsync',
    file: 'scripts/filesystem.mjs',
    old: "      if (FSYNC) fs.fsyncSync(descriptor);\n    } finally {\n      fs.closeSync(descriptor);\n    }\n    try {\n      fs.linkSync",
    new: "    } finally {\n      fs.closeSync(descriptor);\n    }\n    try {\n      fs.linkSync",
  },
  {
    name: 'restore without fsync',
    file: 'scripts/filesystem.mjs',
    old: '        if (FSYNC) fs.fsyncSync(descriptor);',
    new: '        if (false) fs.fsyncSync(descriptor);',
  },
  {
    name: 'format 1 written as base64',
    file: 'snapshot.mbt',
    old: '    bytes_value(bytes)\n  } else {',
    new: '    String(base64_encode(bytes))\n  } else {',
  },
  {
    name: 'checksum ignores version',
    file: 'snapshot.mbt',
    old: '    record([("version", Number(version.to_double())), ("files", Array(files))])',
    new: '    record([("files", Array(files))])',
  },
  {
    name: 'canonical sorts lexicographically',
    file: 'input.mbt',
    old: '      keys.sort()',
    new: '      keys.sort_by(fn(a, b) { lexical(a, b) })',
  },
  {
    name: 'restore selection treats a flag as a path',
    file: 'scripts/filesystem.mjs',
    old: "      if (argv[i] === '--path') {",
    new: "      if (false) {",
  },
  {
    name: 'adapter reports on stderr',
    file: 'scripts/filesystem.mjs',
    old: '    console.log(JSON.stringify({error: err.message}));',
    new: '    console.error(err.message);',
  },
  {
    name: 'usage errors exit 1',
    file: 'scripts/filesystem.mjs',
    old: '    process.exitCode = usage ? 2 : 1;',
    new: '    process.exitCode = 1;',
  },
  {
    name: 'audit skips unreferenced objects',
    file: 'snapshot.mbt',
    old: '          if digest(bytes) != hash {',
    new: '          if false {',
  },
  {
    name: 'safe_path accepts traversal',
    file: 'snapshot.mbt',
    old: '    if part == "" || part == "." || part == ".." {',
    new: '    if part == "" {',
  },
  {
    name: 'restore does not apply permission bits',
    file: 'scripts/filesystem.mjs',
    old: '      fs.chmodSync(absolute, file.mode);',
    new: '      if (false) fs.chmodSync(absolute, file.mode);',
  },
  {
    name: 'portablePaths skips the collision check',
    file: 'scripts/filesystem.mjs',
    old: "    const key = fold(file.path);",
    new: "    const key = 'fixed';",
  },
  {
    name: 'restore allows an existing destination',
    file: 'scripts/filesystem.mjs',
    old: '    fs.mkdirSync(output);',
    new: '    fs.mkdirSync(output, {recursive: true});',
  },
  {
    name: 'Windows device names accepted',
    file: 'scripts/filesystem.mjs',
    old: "      const problems = windowsProblems(part);",
    new: "      const problems = [];",
    // Only observable where the check runs. On macOS and Linux `windowsProblems` is not
    // consulted at all - a Linux tree holding `con` is meant to back up - so no check on those
    // platforms can see this defect. Recorded rather than removed, because on Windows the
    // integration suite does catch it and that is worth knowing.
    onlyOn: 'win32',
  },
  {
    name: 'path length limit removed',
    file: 'scripts/filesystem.mjs',
    old: '    if (Buffer.byteLength(file.path, \'utf8\') > limit) {',
    new: '    if (false) {',
  },
  {
    name: 'retention does not promote the chain',
    file: 'retention.mbt',
    old: '    if get(audit_with(snapshot, parents), "valid") != Bool(true) {',
    new: '    if false {',
  },
];

if (LIST) {
  for (const defect of DEFECTS) console.log(defect.name);
  process.exit(0);
}

// The full run takes minutes - a build and eight checks per defect - so it is a deliberate
// probe rather than part of the ladder. Its entries rot in a way that is worse than being
// stale: an anchor that no longer matches reports "caught by nobody", which reads as a gap and
// sends someone hunting a hole that is not there. `--check-anchors` is the cheap guard for
// that, and it does run in the ladder.
if (process.argv.includes('--check-anchors')) {
  const stale = [];
  for (const defect of DEFECTS) {
    const target = path.join(root, defect.file);
    if (!fs.existsSync(target)) {
      stale.push(`${defect.name}: ${defect.file} does not exist`);
      continue;
    }
    const occurrences = fs.readFileSync(target, 'utf8').split(defect.old).length - 1;
    if (occurrences !== 1) {
      stale.push(`${defect.name}: the text it edits occurs ${occurrences} times in `
        + `${defect.file}, expected 1`);
    }
  }
  if (stale.length) {
    console.error(`defect-matrix: ${stale.length} entr(y/ies) no longer match the source, so `
      + 'the matrix would misreport them as gaps:');
    for (const entry of stale) console.error('  ' + entry);
    process.exit(1);
  }
  console.log(`Defect matrix: all ${DEFECTS.length} entries still match the source `
    + '(run `node scripts/defect-matrix.mjs` to exercise them)');
  process.exit(0);
}

function run(command, args, timeout = 300000) {
  const result = spawnSync(command, args, {cwd: root, encoding: 'utf8', timeout});
  if (result.error) return {ok: false, output: String(result.error.message)};
  // `moon test` exits non-zero when tests fail, and prints the count; treat a failing count as
  // a failure even if the exit status were zero.
  if (command === 'moon') {
    const match = result.stdout.match(/failed: (\d+)/);
    const failed = match ? Number(match[1]) : 0;
    return {ok: result.status === 0 && failed === 0, output: result.stdout + result.stderr};
  }
  return {ok: result.status === 0, output: result.stdout + result.stderr};
}

// The files this will edit must be clean, or "restore what I touched" would discard someone's
// work. Only those files are checked: an untracked new script elsewhere is not a risk, and
// refusing for one made the guard fail on the very commit that added this file.
const touched = [...new Set(DEFECTS.map((defect) => defect.file))];
const status = spawnSync('git', ['status', '--porcelain', '--', ...touched],
  {cwd: root, encoding: 'utf8'});
if (status.stdout.trim() !== '') {
  console.error('defect-matrix: these files have uncommitted changes; commit or stash them '
    + 'first, because the matrix edits and restores them:\n' + status.stdout.trim());
  process.exit(2);
}

const results = [];

for (const defect of DEFECTS) {
  const target = path.join(root, defect.file);
  const original = fs.readFileSync(target, 'utf8');
  const occurrences = original.split(defect.old).length - 1;
  if (occurrences !== 1) {
    results.push({name: defect.name, caughtBy: [], note:
      `defect text occurs ${occurrences} times, expected 1 - the matrix entry is stale`});
    continue;
  }

  let caughtBy = [];
  try {
    fs.writeFileSync(target, original.replace(defect.old, defect.new));
    // Rebuild whatever the checks run against; a source edit that is never compiled is not a
    // defect at all.
    const built = run('moon', ['build', '--target', 'js', '--release']);
    if (!built.ok) {
      results.push({name: defect.name, caughtBy: ['build'], note: 'did not compile'});
      continue;
    }
    for (const check of FAST_CHECKS) {
      const outcome = run(check.command[0], check.command[1]);
      if (!outcome.ok) caughtBy.push(check.name);
    }
  } finally {
    fs.writeFileSync(target, original);
  }
  // A defect gated on another platform cannot be judged here. Saying so is the difference
  // between "no check covers this" and "this host cannot run the check", and only the first is a
  // gap.
  const skipped = defect.onlyOn && defect.onlyOn !== process.platform;
  results.push({name: defect.name, caughtBy, skipped: Boolean(skipped)});
}

// Leave the tree exactly as found: rebuilt, so the next command is not fighting a stale artifact.
run('moon', ['build', '--target', 'js', '--release']);

const gaps = results.filter((entry) => entry.caughtBy.length === 0 && !entry.skipped);
for (const entry of results) {
  let verdict;
  if (entry.skipped) verdict = `not observable on ${process.platform}`;
  else if (entry.caughtBy.length === 0) verdict = 'NO CHECK';
  else verdict = entry.caughtBy.join(', ');
  console.log(`${entry.name.padEnd(38)} ${verdict}${entry.note ? '  (' + entry.note + ')' : ''}`);
}
console.log('');
if (gaps.length) {
  console.log(`${gaps.length} defect(s) caught by nothing:`);
  for (const gap of gaps) console.log('  ' + gap.name);
  process.exit(1);
}
console.log(`${results.length} defects, each caught by at least one check`);
