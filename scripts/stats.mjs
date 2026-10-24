// Checks that PROJECT_STATS.md still describes the source it claims to describe.
//
//   node scripts/stats.mjs          # report and compare
//   node scripts/stats.mjs --write  # refresh the numbers in PROJECT_STATS.md
//
// The counts follow the file's own stated rules: production code is the owned
// MoonBit under the module root plus the CLI, tests are `test "..."` declarations
// in `*_wbtest.mbt`, fixtures are entries in tests/cases.json. Comments are whole
// lines that start with `//`; blocks are not counted separately.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

function productionFiles() {
  const rootFiles = fs.readdirSync(root)
    .filter((name) => name.endsWith('.mbt') && !name.endsWith('_wbtest.mbt'))
    .sort();
  const cli = 'cmd/main/main.mbt';
  return [...rootFiles, cli];
}

function countLines(text) {
  const lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const nonblank = lines.filter((line) => line.trim() !== '');
  const noncomment = nonblank.filter((line) => !line.trim().startsWith('//'));
  return {physical: lines.length, noncomment: noncomment.length};
}

function measure() {
  let physical = 0;
  let noncomment = 0;
  for (const file of productionFiles()) {
    const counts = countLines(read(file));
    physical += counts.physical;
    noncomment += counts.noncomment;
  }
  const tests = fs.readdirSync(root)
    .filter((name) => name.endsWith('_wbtest.mbt'))
    .reduce((sum, name) => sum + (read(name).match(/^test "/gm) || []).length, 0);
  const fixtures = JSON.parse(read('tests/cases.json')).length;
  return {physical, noncomment, tests, fixtures};
}

// Each row is a markdown table cell pair; the label identifies the metric.
// Parsed by splitting on the pipes rather than by pattern matching the label,
// so parentheses and other regex metacharacters in a label are harmless.
const rows = {
  'Owned production MoonBit physical lines (root + CLI + codec)': 'physical',
  'Nonblank, non-comment production lines': 'noncomment',
  'MoonBit test declarations': 'tests',
  'CLI fixture cases': 'fixtures',
};

const actual = measure();
const file = 'PROJECT_STATS.md';
let text = read(file);

// Returns the table rows as [label, value] pairs.
function tableRows(source) {
  const parsed = [];
  for (const line of source.split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    if (cells.length === 2 && /^\d+$/.test(cells[1])) parsed.push(cells);
  }
  return parsed;
}

if (process.argv.includes('--write')) {
  for (const [label, key] of Object.entries(rows)) {
    const prefix = '| ' + label + ' | ';
    if (!text.includes(prefix)) throw new Error('row not found in PROJECT_STATS.md: ' + label);
    text = text.split('\n')
      .map((line) => line.startsWith(prefix) ? prefix + actual[key] + ' |' : line)
      .join('\n');
  }
  fs.writeFileSync(path.join(root, file), text);
  console.log('PROJECT_STATS.md updated:', JSON.stringify(actual));
  process.exit(0);
}

const found = new Map(tableRows(text));
const problems = [];
for (const [label, key] of Object.entries(rows)) {
  if (!found.has(label)) {
    problems.push(label + ': row missing from PROJECT_STATS.md');
  } else if (Number(found.get(label)) !== actual[key]) {
    problems.push(`${label}: PROJECT_STATS.md says ${found.get(label)}, source has ${actual[key]}`);
  }
}

if (problems.length) {
  for (const problem of problems) console.error('stats: ' + problem);
  console.error('stats: run `node scripts/stats.mjs --write` after updating the file deliberately');
  process.exit(1);
}
console.log(
  `Stats: PROJECT_STATS.md matches the source (${actual.physical} physical lines, ` +
  `${actual.noncomment} non-comment, ${actual.tests} tests, ${actual.fixtures} fixtures)`,
);
