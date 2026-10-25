// Runs every file in examples/ through the real CLI and pins the answer.
//
//   node scripts/examples.mjs          # check
//   node scripts/examples.mjs --write  # regenerate the pinned answers
//
// These files ship with the package and are the first thing README tells a reader
// to run, yet nothing executed them: a semantics change could break every one of
// them and the suite would stay green. Pinning the answers also makes them act as
// hand-readable documentation of what each operation returns, which is more useful
// than a walkthrough that claims an output nobody checked.
//
// An example named `*.error.json` is expected to fail; its pinned file records the
// message, so the failure mode is documented and tested rather than implied.
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const examples = path.join(root, 'examples');
const expected = path.join(examples, 'expected');

function cliPath() {
  for (const mode of ['release', 'debug']) {
    const candidate = path.join(root, '_build/js', mode, 'build/cmd/main/main.js');
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error('build the JS target first: moon build --target js --release');
}

function newestSource() {
  let newest = 0;
  const roots = [root, path.join(root, 'cmd/main')];
  for (const directory of roots) {
    if (!fs.existsSync(directory)) continue;
    for (const name of fs.readdirSync(directory)) {
      // White-box test files are not linked into the executable; see engine.mjs.
      if (!name.endsWith('.mbt') || name.endsWith('_wbtest.mbt')) continue;
      const stat = fs.statSync(path.join(directory, name));
      if (stat.isFile()) newest = Math.max(newest, stat.mtimeMs);
    }
  }
  return newest;
}

const cli = cliPath();
if (fs.statSync(cli).mtimeMs < newestSource()) {
  throw new Error('the build is older than the source; rebuild before checking examples');
}

const write = process.argv.includes('--write');
const files = fs.readdirSync(examples)
  .filter((name) => name.endsWith('.json'))
  .sort();

if (!files.length) throw new Error('no examples found');
if (write) fs.mkdirSync(expected, {recursive: true});

const problems = [];
let checked = 0;
for (const name of files) {
  const request = fs.readFileSync(path.join(examples, name), 'utf8');
  const shouldFail = name.endsWith('.error.json');
  const result = spawnSync(process.execPath, [cli, '-'], {
    input: request, encoding: 'utf8', timeout: 120000,
  });
  if (result.error) {
    problems.push(`${name}: could not run: ${result.error.message}`);
    continue;
  }
  let answer;
  try {
    answer = JSON.parse(result.stdout);
  } catch (err) {
    problems.push(`${name}: stdout is not one JSON object (exit ${result.status}): `
      + result.stdout.slice(0, 160));
    continue;
  }
  if (shouldFail) {
    if (result.status !== 1 || typeof answer.error !== 'string') {
      problems.push(`${name}: named *.error.json but exited ${result.status} `
        + `with ${JSON.stringify(answer).slice(0, 120)}`);
      continue;
    }
  } else if (result.status !== 0 || answer.error !== undefined) {
    problems.push(`${name}: exited ${result.status}: `
      + JSON.stringify(answer).slice(0, 200));
    continue;
  }

  const pinnedPath = path.join(expected, name);
  const rendered = JSON.stringify(answer, null, 2) + '\n';
  if (write) {
    fs.writeFileSync(pinnedPath, rendered);
  } else if (!fs.existsSync(pinnedPath)) {
    problems.push(`${name}: no pinned answer; run with --write to create `
      + `examples/expected/${name}`);
    continue;
  } else {
    const pinned = fs.readFileSync(pinnedPath, 'utf8');
    if (pinned !== rendered) {
      problems.push(`${name}: the answer changed\n    pinned   `
        + `${pinned.trim().slice(0, 300)}\n    actual   ${rendered.trim().slice(0, 300)}`);
      continue;
    }
  }
  checked++;
}

const stale = fs.existsSync(expected)
  ? fs.readdirSync(expected).filter((name) => !files.includes(name))
  : [];
for (const name of stale) {
  problems.push(`examples/expected/${name} has no matching example`);
}
const unpinned = files.filter((name) => !fs.existsSync(path.join(expected, name)));
for (const name of unpinned) {
  problems.push(`examples/${name} has no pinned answer`);
}

// examples/README.md lists every example in a table. A table that drifts from the
// directory is the same class of stale documentation this check exists to prevent,
// so the two are compared.
const readme = path.join(examples, 'README.md');
if (fs.existsSync(readme)) {
  const listed = [...fs.readFileSync(readme, 'utf8')
    .matchAll(/^\| `([^`]+\.json)` \|/gm)].map((match) => match[1]);
  for (const name of files) {
    if (!listed.includes(name)) {
      problems.push(`examples/README.md does not list ${name}`);
    }
  }
  for (const name of listed) {
    if (!files.includes(name)) {
      problems.push(`examples/README.md lists ${name}, which does not exist`);
    }
  }
}

if (problems.length) {
  for (const problem of problems) console.error('example: ' + problem);
  console.error(`example: ${problems.length} of ${files.length} examples failed`);
  process.exit(1);
}
if (write) {
  console.log(`Examples: wrote ${checked} pinned answers`);
} else {
  console.log(`Examples: ${checked} shipped examples reproduce their pinned answers`);
}
