// Both command-line entry points must fail the same way.
//
//   node scripts/cli-contract.mjs
//
// There are two: the core JSON CLI, which reads a request from a file or stdin, and
// `scripts/filesystem.mjs`, which works on real directories. They used to disagree -
// the core printed `{"error": ...}` on stdout while the adapter printed a bare reason on
// stderr, and a usage mistake exited 1 in one and 2 in the other. A caller shelling out
// to both had to parse two shapes from two streams.
//
// The contract asserted here, for both:
//   - success: one JSON object on stdout, nothing on stderr, exit 0
//   - failure: one JSON object on stdout, nothing on stderr, exit 1
//   - usage mistake: the same, with exit 2
//   - messages are plain reasons, with no `CODE: ...` errno and no absolute path echoed
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const core = path.join(root, '_build/js/release/build/cmd/main/main.js');
const adapter = path.join(root, 'scripts/filesystem.mjs');
if (!fs.existsSync(core)) throw new Error('build first: moon build --target js --release');

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'snapvault-cli-'));
const problems = [];

function invoke(runner, args, options = {}) {
  const result = spawnSync(process.execPath, [runner, ...args], {
    encoding: 'utf8', timeout: 60000, ...options,
  });
  if (result.error) throw new Error('could not run: ' + result.error.message);
  return result;
}

function check(label, result, expectedCode, {allowEmptyStdout = false} = {}) {
  if (result.status !== expectedCode) {
    problems.push(`${label}: exit ${result.status}, wanted ${expectedCode}`);
    return null;
  }
  if (result.stderr.trim() !== '') {
    problems.push(`${label}: wrote to stderr: ${result.stderr.trim().slice(0, 120)}`);
  }
  const text = result.stdout.trim();
  if (!text) {
    if (!allowEmptyStdout) problems.push(`${label}: nothing on stdout`);
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    problems.push(`${label}: stdout is not one JSON object: ${text.slice(0, 120)}`);
    return null;
  }
  if (expectedCode !== 0) {
    if (typeof parsed.error !== 'string') {
      problems.push(`${label}: failure without an error string: ${text.slice(0, 120)}`);
      return null;
    }
    // A raw errno is not a reason, and echoing the caller's own path back adds nothing.
    if (/^[A-Z]+: /.test(parsed.error)) {
      problems.push(`${label}: message leaks an errno: ${parsed.error.slice(0, 120)}`);
    }
  }
  return parsed;
}

try {
  const source = path.join(work, 'src');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'a.txt'), 'hello');
  const snapshot = path.join(work, 'snap.json');

  // --- success, both tools ------------------------------------------------
  check('core: valid request', invoke(core, ['-'], {
    input: JSON.stringify({files: [{path: 'a.txt', text: 'abc'}]}),
  }), 0);
  check('adapter: backup', invoke(adapter, ['backup', source, snapshot]), 0);

  // --- failure, both tools ------------------------------------------------
  check('core: request that cannot be honoured', invoke(core, ['-'], {
    input: JSON.stringify({files: 'not an array'}),
  }), 1);
  check('core: missing input file', invoke(core, [path.join(work, 'absent.json')]), 1);
  check('core: directory instead of file', invoke(core, [work]), 1);
  check('adapter: missing snapshot', invoke(adapter,
    ['restore', path.join(work, 'absent.json'), path.join(work, 'out')]), 1);
  check('adapter: destination that already exists', invoke(adapter,
    ['restore', snapshot, source]), 1);

  // --- usage, both tools --------------------------------------------------
  check('core: no arguments', invoke(core, []), 2);
  check('adapter: no arguments', invoke(adapter, []), 2);
  check('adapter: unknown operation', invoke(adapter, ['nosuchop', 'a', 'b']), 2);

  // --- the same request through both entry points must agree --------------
  const viaCore = invoke(core, ['-'], {
    input: JSON.stringify({operation: 'audit', snapshot: JSON.parse(fs.readFileSync(snapshot))}),
  });
  check('core: audit of an adapter snapshot', viaCore, 0);
} finally {
  fs.rmSync(work, {recursive: true, force: true});
}

if (problems.length) {
  for (const problem of problems) console.error('cli-contract: ' + problem);
  process.exit(1);
}
console.log('CLI contract: both entry points answer with one JSON object on stdout, '
  + 'exit 0/1/2, and no errno in the message');
