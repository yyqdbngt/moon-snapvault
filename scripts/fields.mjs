// Every field an operation returns must be named in the documentation.
//
//   node scripts/fields.mjs            # check
//   node scripts/fields.mjs --list     # print the inventory
//
// The documentation describes the JSON an operation returns, field by field, in tables under
// headings like "Retention plan fields". That is the only thing a caller has to go on: the
// interface file describes MoonBit signatures, and the README describes the CLI, but neither says
// what `collectible_bytes` means or that `plan_only` is always true.
//
// A field added without a doc line is invisible to a reader who does not read the source. Four
// were: `live_bytes`, `collectible_bytes`, `plan_only` and `scope`, all in the retention plan.
// They had been in the output for several releases and appeared only in an example JSON inside
// the project proposal.
//
// What this checks is presence, not placement. A field named anywhere in the documentation counts
// as documented, because deciding whether prose is "good enough" is not something a script can
// do. That makes it a floor, not a guarantee, and the doc is where the meaning lives.
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIST = process.argv.includes('--list');

// Fixed inputs, so the inventory is a property of the code and not of the run. Each entry names
// the operation, a request that exercises it, and - for operations whose output nests an object
// the documentation describes - the nested keys worth checking too.
const base = {files: [{path: 'a.txt', text: 'abc'}, {path: 'b.txt', text: 'xyz'}]};
const plain = (snapshot) => ({
  version: snapshot.version,
  parent: snapshot.parent ?? null,
  files: snapshot.files,
  objects: snapshot.objects,
  checksum: snapshot.checksum,
});

// Built at run time: every request after the first needs a snapshot from an earlier one.
function inventory(engine) {
  const plainSnapshot = engine(base).snapshot;
  const third = engine({...base, format: 3}).snapshot;
  const parent = plain(plainSnapshot);

  const requests = [
    ['create', base],
    ['audit', {operation: 'audit', snapshot: plainSnapshot}],
    ['audit (corrupt)', {operation: 'audit', snapshot: damage(plainSnapshot)}],
    ['restore', {operation: 'restore', snapshot: plainSnapshot}],
    ['restore (selected)', {operation: 'restore', snapshot: plainSnapshot, paths: ['a.txt']}],
    // `diff` takes `old` and `new`; `locate` and `squash` take one `snapshot`. The first version
    // of this inventory guessed `before`/`after` and `snapshots`, which the fixtures would have
    // shown me had I read them rather than the interface.
    ['diff', {operation: 'diff', old: parent, new: parent}],
    ['retention', {operation: 'retention',
      snapshots: [{id: 'a', snapshot: parent}, {id: 'b', snapshot: parent}], keep: ['a']}],
    ['locate', {operation: 'locate', snapshot: parent}],
    ['extract', {operation: 'extract', snapshot: parent, digests: Object.keys(plainSnapshot.objects)}],
    ['assemble', {operation: 'assemble', files: plainSnapshot.files}],
    ['squash', {operation: 'squash', snapshot: plain(third)}],
  ];

  const found = new Map();
  for (const [name, request] of requests) {
    let answer;
    try {
      answer = engine(request);
    } catch (error) {
      found.set(name, {keys: [], error: String(error.message).slice(0, 120)});
      continue;
    }
    const keys = new Set(Object.keys(answer));
    // One level of nesting, because the documentation documents these too.
    for (const [field, value] of Object.entries(answer)) {
      if (Array.isArray(value) && value.length > 0 && value[0] && typeof value[0] === 'object'
        && !Array.isArray(value[0])) {
        for (const key of Object.keys(value[0])) keys.add(key);
      } else if (value && typeof value === 'object' && !Array.isArray(value)) {
        // `extract` returns `objects` keyed by digest: those keys are data, not field names, and
        // taking them as fields reported a 64-character hash as an undocumented field.
        const isMapOfDigests = Object.keys(value).every((key) => /^[0-9a-f]{64}$/.test(key));
        if (isMapOfDigests) {
          for (const inner of Object.values(value)) {
            if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
              for (const key of Object.keys(inner)) keys.add(key);
            }
          }
        } else {
          for (const key of Object.keys(value)) keys.add(key);
        }
        // `field` is deliberately unused here; the map's keys are not names.
        void field;
      }
    }
    found.set(name, {keys: [...keys].sort()});
  }
  return found;
}

function damage(snapshot) {
  const copy = JSON.parse(JSON.stringify(snapshot));
  const first = Object.keys(copy.objects)[0];
  copy.objects[first] = 'AAAA';
  return copy;
}

const probe = await import('./engine.mjs');
const inventoryResult = inventory(probe.engine);

if (LIST) {
  for (const [name, {keys, error}] of inventoryResult) {
    console.log(`${name}: ${error ? 'ERROR ' + error : keys.join(' ')}`);
  }
  process.exit(0);
}

const documented = [
  path.join(root, 'README.md'),
  ...fs.readdirSync(path.join(root, 'docs'))
    .filter((name) => name.endsWith('.md'))
    .map((name) => path.join(root, 'docs', name)),
].map((file) => fs.readFileSync(file, 'utf8')).join('\n');

const problems = [];
for (const [name, {keys, error}] of inventoryResult) {
  if (error) {
    // A probe that cannot run is a broken check, not a passing one.
    problems.push(`${name}: the probe request failed (${error})`);
    continue;
  }
  const missing = keys.filter((key) => !documented.includes(key));
  if (missing.length) problems.push(`${name}: undocumented ${missing.join(', ')}`);
}

if (problems.length) {
  console.error(`Fields: ${problems.length} problem(s)`);
  for (const problem of problems) console.error('  ' + problem);
  console.error('A field a caller receives and the documentation never names is one they have '
    + 'to read the source to understand.');
  process.exit(1);
}

const total = new Set([...inventoryResult.values()].flatMap((entry) => entry.keys)).size;
console.log(`Fields: all ${total} distinct output fields across `
  + `${inventoryResult.size} operations are named in the documentation`);
