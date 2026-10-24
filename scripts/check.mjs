// Runs tests/cases.json through the real CLI and checks the answers.
//
//   node scripts/check.mjs            # every fixture
//   node scripts/check.mjs --list     # names only, no execution
//
// Two kinds of success fixture, and the difference matters:
//
//   "expected" pins individual fields by path. Good for one value deep inside a
//   large result, and it says nothing about anything it does not name.
//
//   "exact": true pins the *whole* answer, including field order. It is used for
//   fixtures that exist to hold an operation's output still, so that a field
//   appearing, disappearing, being renamed or moving is a failure rather than
//   silence. The project already claims byte-identical output between backends,
//   which makes pinning the bytes consistent with that claim.
//
//   "error": "text" means the request must fail with a message containing "text".
//   "error": true accepts any message and is only right where the message truly
//   does not matter. It used to be the only form, and that let a fixture pass for
//   the wrong reason: one named for corruption was in fact exercising a format
//   check and would have kept passing if the corruption check had been deleted.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {engine, root} from './engine.mjs';

const cases = JSON.parse(fs.readFileSync(path.join(root, 'tests/cases.json'), 'utf8'));

if (process.argv.includes('--list')) {
  for (const test of cases) console.log(test.name);
  process.exit(0);
}

let passed = 0;
const problems = [];

function resolvePath(result, key) {
  let actual = result;
  for (const part of key.split('/')) actual = actual?.[part];
  return actual;
}

// The CLI reports failures as {"error": "..."} on stdout; some callers see the
// raised value instead, so both forms are searched for the expected text.
function messageMatches(message, wanted) {
  if (message.includes(wanted)) return true;
  const envelope = message.trim().match(/^\{"error":(.*)\}$/s);
  return envelope ? envelope[1].includes(wanted) : false;
}

for (const test of cases) {
  if (test.error !== undefined && test.error !== false) {
    let message = null;
    try {
      const unexpected = engine(test.request);
      problems.push(`${test.name}: expected an error, got `
        + JSON.stringify(unexpected).slice(0, 120));
      continue;
    } catch (err) {
      message = err.message;
    }
    if (typeof test.error === 'string' && !messageMatches(message, test.error)) {
      problems.push(`${test.name}: error ${message.trim()} does not contain `
        + JSON.stringify(test.error));
      continue;
    }
    passed++;
    continue;
  }

  let result;
  try {
    result = engine(test.request);
  } catch (err) {
    problems.push(`${test.name}: unexpected error ${err.message.trim().slice(0, 160)}`);
    continue;
  }
  if (test.exact === true) {
    const rendered = JSON.stringify(result);
    const wanted = JSON.stringify(test.expected);
    if (rendered !== wanted) {
      problems.push(`${test.name}: the whole answer differs\n`
        + `    actual   ${rendered.slice(0, 500)}\n`
        + `    expected ${wanted.slice(0, 500)}`);
      continue;
    }
  } else {
    let fieldProblem = null;
    for (const [key, expected] of Object.entries(test.expected)) {
      try {
        assert.deepEqual(resolvePath(result, key), expected, key);
      } catch (err) {
        fieldProblem = `${test.name}: ${key}: ${err.message.split('\n')[0]}`;
        break;
      }
    }
    if (fieldProblem) {
      problems.push(fieldProblem);
      continue;
    }
  }
  passed++;
}

if (problems.length) {
  for (const problem of problems) console.error('fixture: ' + problem);
  console.error(`fixture: ${problems.length} of ${cases.length} cases failed`);
  process.exit(1);
}

const exact = cases.filter((test) => test.exact === true).length;
const pinned = cases.filter((test) => typeof test.error === 'string').length;
const anyError = cases.filter((test) => test.error === true).length;
console.log(`CLI fixture cases passed: ${passed} (${exact} pin the whole answer, `
  + `${pinned} pin an error message, ${anyError} accept any error)`);
