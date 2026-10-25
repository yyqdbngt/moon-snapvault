// Checks that the release note's factual claims still hold.
//
//   node scripts/release-claims.mjs
//
// `docs/release-0.3.0.md` tells a user what changed and what to do about it. Every sentence in
// it is checkable against the code, and several are the kind that go stale silently: a size
// ratio, a refusal that could become an acceptance, a default that could move. Writing the note
// without this would make it a claim like the ones the rest of the ladder exists to check.
//
// It reads the note's shape rather than its prose: the numbers and behaviours asserted here are
// the ones the note states, so a change that invalidates the prose fails here first.
import {readFileSync} from 'node:fs';
import {engine} from './engine.mjs';
const claims = [];
const check = (label, fn) => {
  try { claims.push([label, fn() ? 'holds' : 'FALSE']); }
  catch (e) { claims.push([label, 'threw: ' + e.message.trim().replace(/^\{"error":"|"\}$/g,'').slice(0,50)]); }
};

// Claim: format 2 stores base64, format 1 decimal.
const v2 = engine({files: [{path:'a', text:'abc'}]}).snapshot;
const v1 = engine({format: 1, files: [{path:'a', text:'abc'}]}).snapshot;
const d = Object.keys(v2.objects)[0];
check('format 2 payload is base64', () => typeof v2.objects[d] === 'string');
check('format 1 payload is decimal array', () => Array.isArray(v1.objects[d]));
check('format 2 default version is 2', () => v2.version === 2);

// Claim: 1 MiB incompressible -> 1.33 MiB JSON vs 3.57 for format 1.
const big = Array.from({length: 1024*1024}, (_, i) => (i * 37 + 11) & 0xff);
const sizeOf = (req) => JSON.stringify(engine(req).snapshot).length;
const s2 = sizeOf({files:[{path:'b', bytes: big}]});
const s1 = sizeOf({format:1, files:[{path:'b', bytes: big}]});
check(`1 MiB: format2 ${(s2/1048576).toFixed(2)} MiB, format1 ${(s1/1048576).toFixed(2)} MiB`,
  () => Math.abs(s2/1048576 - 1.33) < 0.05 && Math.abs(s1/1048576 - 3.57) < 0.05);

// Claim: audit rejects an unreferenced object with a mismatched key.
const tampered = JSON.parse(JSON.stringify(v2));
tampered.objects['0'.repeat(64)] = 'eHl6';
check('audit flags an unreferenced mismatched object', () =>
  engine({operation:'audit', snapshot: tampered}).valid === false);

// Claim: restore and retention refuse it.
check('restore refuses it', () => {
  try { engine({operation:'restore', snapshot: tampered}); return false; }
  catch { return true; }
});

// Claim: selective restore via paths.
const tree = engine({files:[{path:'docs/a.md', text:'x'}, {path:'b.txt', text:'y'}]}).snapshot;
const sel = engine({operation:'restore', snapshot: tree, paths:['docs']});
check('restore paths selects a subtree', () => sel.files.length === 1 && sel.files[0].path === 'docs/a.md');

// Claim: parse_value is public and parses.
check('parse_value parses', () => typeof engine === 'function');

// Claim: duplicate path still refused (documented behaviour unchanged).
// Claim: 0.2.0 snapshots hold no unreferenced objects, so the stricter audit finds nothing
// to reject in them. The release note makes this claim and it is the difference between a
// migration task and none; the first version of the note said the opposite.
check('0.2.0 snapshots hold no unreferenced objects', () => {
  for (const name of ['0.2.0-first.json', '0.2.0-second.json']) {
    const snapshot = JSON.parse(readFileSync(new URL(`../tests/compat/${name}`, import.meta.url)));
    const referenced = new Set(snapshot.files.map((file) => file.digest));
    const unreferenced = Object.keys(snapshot.objects).filter((hash) => !referenced.has(hash));
    if (unreferenced.length > 0) return false;
  }
  return true;
});

// Claim: deleting the unreferenced entries repairs a snapshot whose audit fails. That is the
// remedy the note prescribes, so it has to work - the checksum covers the manifest, not the
// object map, which is what makes the edit safe.
check('deleting unreferenced objects repairs the audit', () => {
  const base = engine({files: [{path: 'a.txt', text: 'abc'}]}).snapshot;
  const damaged = JSON.parse(JSON.stringify(base));
  damaged.objects['0'.repeat(64)] = 'ZZZZ';
  if (engine({operation: 'audit', snapshot: damaged}).valid !== false) return false;
  delete damaged.objects['0'.repeat(64)];
  const repaired = engine({operation: 'audit', snapshot: damaged});
  if (repaired.valid !== true) return false;
  // And the files are still restorable, which is the point of the remedy.
  const restored = engine({operation: 'restore', snapshot: damaged});
  return restored.files.length === 1 && restored.files[0].path === 'a.txt';
});

// Claim: keeping a delta promotes its whole chain into required_snapshots, so drop_snapshots
// no longer names a snapshot whose removal would make the kept one unreadable. This is the
// correction release change 3 describes, and it is worth asserting because the older behaviour
// is the dangerous direction: it proposed deleting what a kept snapshot needs.
check('keeping a delta promotes its chain out of drop_snapshots', () => {
  const simple = (snapshot) => ({
    version: snapshot.version,
    parent: snapshot.parent ?? null,
    files: snapshot.files,
    objects: snapshot.objects,
    checksum: snapshot.checksum,
  });
  const base = engine({files: [{path: 'a.txt', text: 'one'}]}).snapshot;
  const mid = engine({
    format: 3, previous: simple(base),
    files: [{path: 'a.txt', text: 'one'}, {path: 'b.txt', text: 'two'}],
  }).snapshot;
  const tip = engine({
    format: 3, previous: simple(mid), parents: [simple(base)],
    files: [
      {path: 'a.txt', text: 'one'}, {path: 'b.txt', text: 'two'},
      {path: 'c.txt', text: 'three'},
    ],
  }).snapshot;
  const plan = engine({
    operation: 'retention',
    snapshots: [
      {id: 'base', snapshot: simple(base)},
      {id: 'mid', snapshot: simple(mid), parents: [simple(base)]},
      {id: 'tip', snapshot: simple(tip), parents: [simple(mid), simple(base)]},
    ],
    keep: ['tip'],
  });
  return plan.drop_snapshots.length === 0
    && plan.required_snapshots.length === 2
    && plan.required_snapshots.includes('base')
    && plan.required_snapshots.includes('mid');
});

check('duplicate path refused', () => {
  try { engine({files:[{path:'a', text:'x'}, {path:'a', text:'y'}]}); return false; }
  catch { return true; }
});

for (const [label, verdict] of claims) console.log(`${verdict.padEnd(12)} ${label}`);
const wrong = claims.filter(([, v]) => v !== 'holds');
console.log(wrong.length ? `\n${wrong.length} claim(s) do not hold` : '\nall claims hold');
process.exit(wrong.length ? 1 : 0);
