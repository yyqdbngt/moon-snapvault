// Unpacks the package archive and proves it is usable on its own.
//
//   node scripts/package-smoke.mjs
//
// `consumer-smoke.mjs` answers whether the archive can be *compiled against* as a library: it
// unpacks it, writes a separate module that calls the exported functions, and builds. This
// answers the other half, about the archive as a *distribution*: the command-line tool the
// README documents is inside it, and so is the ladder that claims to verify it.
//
// Three claims, each one something the project asserts and none of which was checked:
//
//   the shipped CLI runs     `scripts/filesystem.mjs` needs `_build`, which packaging does not
//                            ship, so a first run has to say so and a build has to make it work
//   the shipped tests pass   `_wbtest.mbt` files and `tests/` fixtures are in the archive, so
//                            `moon test` has to pass there and not only in the checkout
//   the shipped ladder works `verify.sh` is in the archive and documented as "one command runs
//                            everything"; it used to fail on the artifact it ships, because
//                            `workflow.py` demanded a `.github` directory that packaging omits
//
// It is deliberately not the whole ladder: the full run inside the package takes minutes and
// mostly repeats what the checkout already runs against identical bytes. What it adds is that
// the bytes in the archive are the ones working.
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const moduleName = 'yyqdbngt/moon_snapvault';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {encoding: 'utf8', timeout: 600000, ...options});
  const output = (result.stdout || '') + (result.stderr || '');
  if (result.error) throw new Error(`${command} could not start: ${result.error.message}`);
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`${command} ${args.join(' ')} failed:\n${output.trim()}`);
  }
  return {...result, output};
}

function unpack(archivePath, destination) {
  const attempts = process.platform === 'win32'
    ? [['powershell', ['-NoProfile', '-Command',
      `Expand-Archive -Force -LiteralPath '${archivePath}' -DestinationPath '${destination}'`]]]
    : [['unzip', ['-q', '-o', archivePath, '-d', destination]]];
  const problems = [];
  for (const [command, args] of attempts) {
    const result = spawnSync(command, args, {encoding: 'utf8'});
    if (!result.error && result.status === 0) return;
    problems.push(`${command}: ${result.error ? result.error.message : (result.stderr || result.stdout)}`);
  }
  throw new Error('cannot extract ' + archivePath + ':\n' + problems.join('\n'));
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'snapvault-package-'));
const checks = [];
try {
  const version = fs.readFileSync(path.join(root, 'moon.mod'), 'utf8')
    .match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  if (!version) throw new Error('cannot read the version from moon.mod');

  run('moon', ['package'], {cwd: root});
  const archive = path.join(root, '_build', 'publish',
    `${moduleName.replace('/', '-')}-${version}.zip`);
  if (!fs.existsSync(archive)) throw new Error(`moon package wrote no archive at ${archive}`);

  const unpacked = path.join(scratch, 'package');
  fs.mkdirSync(unpacked, {recursive: true});
  unpack(archive, unpacked);

  // The archive is the only thing the checks below are allowed to touch, so nothing can be
  // satisfied by a file that exists in the checkout and not in the package.
  const shipped = (relative) => path.join(unpacked, relative);
  for (const required of ['moon.mod', 'moon.pkg', 'scripts/filesystem.mjs', 'scripts/verify.sh',
    'README.md', 'tests/compat']) {
    if (!fs.existsSync(shipped(required))) {
      throw new Error(`the archive does not ship ${required}, so it cannot be used as documented`);
    }
  }
  checks.push('the archive ships the CLI, the ladder and the fixtures');

  // Before building, the CLI has to explain the missing artifact rather than crash on it.
  fs.mkdirSync(shipped('source'));
  fs.writeFileSync(shipped('source/a.txt'), 'hello');
  const cold = run('node', ['scripts/filesystem.mjs', 'backup', 'source', 'unused.json'],
    {cwd: unpacked, allowFailure: true});
  if (cold.status === 0) throw new Error('the CLI ran before the package was built');
  if (!/moon build/i.test(cold.output)) {
    throw new Error('a first run should say to build first, said: ' + cold.output.trim());
  }
  checks.push('a cold run says to build first');

  run('moon', ['build', '--target', 'js', '--release'], {cwd: unpacked});

  // Backup and restore through the shipped CLI, and compare the bytes of every file: a package
  // that loses a file, or a mode, in its own restore is not a distribution of this project.
  const source = shipped('source');
  fs.mkdirSync(path.join(source, 'nested'), {recursive: true});
  fs.writeFileSync(path.join(source, 'nested/b.bin'), Buffer.from([0, 1, 254, 255]));
  const snapshotPath = path.join(scratch, 'snapshot.json');
  const backed = JSON.parse(run('node',
    ['scripts/filesystem.mjs', 'backup', source, snapshotPath], {cwd: unpacked}).output);
  if (backed.objects_stored !== 2) {
    throw new Error(`expected 2 stored objects, got ${backed.objects_stored}`);
  }
  const target = path.join(scratch, 'restored');
  const restored = JSON.parse(run('node',
    ['scripts/filesystem.mjs', 'restore', snapshotPath, target], {cwd: unpacked}).output);
  if (restored.files !== 2 || restored.verified !== true) {
    throw new Error('restore did not report 2 verified files: ' + JSON.stringify(restored));
  }
  for (const relative of ['a.txt', 'nested/b.bin']) {
    const from = fs.readFileSync(path.join(source, relative));
    const to = fs.readFileSync(path.join(target, relative));
    if (!from.equals(to)) throw new Error(`restored ${relative} differs from the source`);
  }
  checks.push('backup and restore through the shipped CLI are byte-identical');

  // The archive ships the white-box tests and the fixtures, so they have to pass there. A
  // package whose tests fail is one nobody can check.
  const tested = run('moon', ['test', '--target', 'js'], {cwd: unpacked});
  const declared = fs.readFileSync(path.join(root, 'PROJECT_STATS.md'), 'utf8')
    .match(/\| Test declarations \| (\d+) \|/)?.[1];
  const passed = tested.output.match(/Total tests: (\d+), passed: (\d+), failed: (\d+)/);
  if (!passed) throw new Error('moon test printed no summary:\n' + tested.output.trim());
  if (passed[3] !== '0') throw new Error(`${passed[3]} shipped test(s) failed`);
  if (declared && passed[1] !== declared) {
    throw new Error(`the package runs ${passed[1]} tests, PROJECT_STATS says ${declared}`);
  }
  checks.push(`the shipped tests pass (${passed[1]})`);

  // The ladder steps that must work from a package. `workflow.py` used to exit 1 here because
  // packaging omits `.github`; it now says it is not a checkout and succeeds.
  for (const step of [['python3', ['-B', 'scripts/docs.py']],
    ['python3', ['-B', 'scripts/workflow.py']],
    ['node', ['scripts/check.mjs']]]) {
    run(step[0], step[1], {cwd: unpacked});
  }
  checks.push('the shipped documentation and fixtures check themselves');
} finally {
  fs.rmSync(scratch, {recursive: true, force: true});
}

for (const check of checks) console.log('  ' + check);
console.log(`Package: ${checks.length} checks against the artifact, not the source tree`);
