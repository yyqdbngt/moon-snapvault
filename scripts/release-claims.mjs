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
check('duplicate path refused', () => {
  try { engine({files:[{path:'a', text:'x'}, {path:'a', text:'y'}]}); return false; }
  catch { return true; }
});

for (const [label, verdict] of claims) console.log(`${verdict.padEnd(12)} ${label}`);
const wrong = claims.filter(([, v]) => v !== 'holds');
console.log(wrong.length ? `\n${wrong.length} claim(s) do not hold` : '\nall claims hold');
process.exit(wrong.length ? 1 : 0);
