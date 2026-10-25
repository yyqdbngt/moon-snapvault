// Runs the examples in `docs/usage.md` and compares the fields the document says they produce.
//
//   node scripts/doc-examples.mjs
//
// The usage document states results in a machine-readable shape:
//
//   ```json
//   { "statistics/unique_bytes": 3, "statistics/deduplicated_bytes": 3 }
//   ```
//
// which is a claim about what the core returns for the request above it. Nothing executed these.
// The document is where a reader goes first, and an example that no longer matches the code is
// worse than no example: it is a wrong answer with the authority of documentation.
//
// Two shapes are recognised:
//
//   Expected result fields   a map of slash-separated paths to expected values
//   Expected: nonzero exit   the request must be refused
//
// Both are checked against the real CLI. Anything else - prose, a partial example - is skipped and
// counted, so the coverage of this check is visible rather than assumed.
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const usagePath = path.join(root, 'docs/usage.md');
const cli = [
  path.join(root, '_build/js/release/build/cmd/main/main.js'),
  path.join(root, '_build/js/debug/build/cmd/main/main.js'),
].find((candidate) => fs.existsSync(candidate));
if (!cli) {
  console.error('doc-examples: build the JS target first (moon build --target js)');
  process.exit(1);
}

function invoke(request) {
  const result = spawnSync('node', [cli, '-'], {
    input: JSON.stringify(request), encoding: 'utf8', timeout: 120000,
  });
  if (result.error) throw new Error('the CLI could not start: ' + result.error.message);
  return {status: result.status, stdout: result.stdout, stderr: result.stderr};
}

// Follows a slash path through a decoded answer. `null` means absent, which is different from a
// present value that happens to be null.
function resolve(answer, dotted) {
  let current = answer;
  for (const part of dotted.split('/')) {
    if (current === null || typeof current !== 'object' || !(part in current)) return undefined;
    current = current[part];
  }
  return current;
}

const text = fs.readFileSync(usagePath, 'utf8');
// Sections, so a failure names where to look.
const sections = text.split(/^## /m).slice(1);
const problems = [];
const counts = {checked: 0, refused: 0, skipped: 0};
const checkedSections = [];

for (const section of sections) {
  const title = section.split('\n', 1)[0].trim();
  const blocks = [...section.matchAll(/```json\n([\s\S]*?)```/g)].map((match) => match[1]);
  // The request is the first block that parses; the expectation is a later block, or a sentence.
  let request = null;
  let expectation = null;
  let refused = false;
  for (const block of blocks) {
    let parsed;
    try {
      parsed = JSON.parse(block);
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    // An expectation uses slash paths as keys; a request has ordinary field names.
    const isExpectation = Object.keys(parsed).some((key) => key.includes('/'));
    if (isExpectation) {
      expectation = parsed;
    } else if (request === null) {
      request = parsed;
    } else if (expectation === null) {
      expectation = parsed;
    }
  }
  if (/Expected:?\s+nonzero exit/i.test(section)) refused = true;
  if (request === null) {
    counts.skipped += 1;
    continue;
  }

  if (refused) {
    const result = invoke(request);
    counts.checked += 1;
    counts.refused += 1;
    checkedSections.push(title + ' (refused)');
    if (result.status === 0) {
      problems.push(`${title}: the document says this is refused, the CLI accepted it: `
        + result.stdout.trim().slice(0, 120));
    } else if (result.status !== 1 && result.status !== 2) {
      problems.push(`${title}: refused with exit ${result.status}, wanted 1 or 2`);
    }
    continue;
  }

  if (expectation === null) {
    counts.skipped += 1;
    continue;
  }

  const result = invoke(request);
  counts.checked += 1;
  checkedSections.push(title);
  if (result.status !== 0) {
    problems.push(`${title}: the request the document shows is refused: `
      + (result.stdout || result.stderr).trim().slice(0, 160));
    continue;
  }
  let answer;
  try {
    answer = JSON.parse(result.stdout);
  } catch {
    problems.push(`${title}: the CLI did not answer with one JSON object`);
    continue;
  }
  for (const [dotted, expected] of Object.entries(expectation)) {
    const actual = resolve(answer, dotted);
    if (actual === undefined) {
      problems.push(`${title}: ${dotted} is not in the answer`);
      continue;
    }
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      problems.push(`${title}: ${dotted} is ${JSON.stringify(actual)}, the document says `
        + JSON.stringify(expected));
    }
  }
}

if (problems.length) {
  console.error(`Doc examples: ${problems.length} problem(s) in ${counts.checked} checked `
    + `example(s) of ${sections.length} sections`);
  for (const problem of problems) console.error('  ' + problem);
  console.error('An example that no longer matches the code is a wrong answer carrying the '
    + 'authority of documentation.');
  process.exit(1);
}

console.log(`Doc examples: ${counts.checked} example(s) in docs/usage.md produce what the `
  + `document says (${counts.refused} refusals, ${counts.skipped} section(s) with no machine-`
  + 'checkable expectation)');
