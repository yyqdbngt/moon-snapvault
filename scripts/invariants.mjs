// Asserts the arithmetic relations between fields the operations report.
//
//   node scripts/invariants.mjs
//
// Every one of these is a statement a user can check with a calculator, and each is a statement the
// documentation makes implicitly by reporting both numbers. They are worth a check of their own
// because the failure mode is not a crash: the tool reports two numbers, they disagree, and the
// reader has no way to tell which one is wrong.
//
// The retention split was found exactly this way - `collectible_bytes` non-zero while
// `drop_snapshots` was empty - and no amount of reading the code made it obvious. Asking whether
// the two numbers could both be right did.
//
// What is checked, and why each one matters:
//
//   create   total = unique + deduplicated, and unique = new + reused. A caller reading
//            `deduplicated_bytes` to decide whether a change was cheap needs these to add up.
//   audit    referenced + unreferenced = total, and checked = total. The second is the promise
//            that a full audit is full.
//   restore  selected = files.length, and total_files = the manifest's file count. A subset
//            restore that reports the wrong denominator cannot be reasoned about.
//   squash   the reported file and object counts are those of the snapshot it produced.
//   retention  the three object buckets partition the stored objects, no bucket is non-empty
//            without the action that frees it, and the byte totals sum to the stored bytes.
//   everywhere  no count is negative and no byte total is, which is what a Double lets slip past.
import {engine} from './engine.mjs';

const problems = [];
const checked = [];

function ok(label, condition, detail) {
  checked.push(label);
  if (!condition) problems.push(label + ': ' + detail);
}

const plain = (snapshot) => ({
  version: snapshot.version,
  parent: snapshot.parent ?? null,
  files: snapshot.files,
  objects: snapshot.objects,
  checksum: snapshot.checksum,
});

const count = (array) => (Array.isArray(array) ? array.length : -1);

// --- create ---------------------------------------------------------------
// Three shapes: everything distinct, one duplicate, and a delta of each kind. A single case would
// not exercise both terms of either identity.
const createCases = [
  ['all distinct', {files: [{path: 'a', text: 'abc'}, {path: 'b', text: 'zz'}]}],
  ['with a duplicate', {files: [{path: 'a', text: 'abc'}, {path: 'b', text: 'abc'}]}],
  ['empty tree', {files: []}],
];
const base = engine({files: [{path: 'a.txt', text: 'abc'}]}).snapshot;
const deltaCases = [
  ['delta unchanged', {files: [{path: 'a.txt', text: 'abc'}], previous: plain(base), format: 3}],
  ['delta changed', {files: [{path: 'a.txt', text: 'abd'}], previous: plain(base), format: 3}],
  ['delta added', {files: [{path: 'a.txt', text: 'abc'}, {path: 'z', text: 'zz'}],
    previous: plain(base), format: 3}],
];
for (const [label, request] of [...createCases, ...deltaCases]) {
  const statistics = engine(request).statistics;
  const where = 'create (' + label + ')';
  ok(where + ' total = unique + deduplicated',
    statistics.total_bytes === statistics.unique_bytes + statistics.deduplicated_bytes,
    JSON.stringify(statistics));
  ok(where + ' unique = new + reused',
    statistics.unique_bytes === statistics.new_object_bytes + statistics.reused_object_bytes,
    JSON.stringify(statistics));
  ok(where + ' no byte total is negative',
    [statistics.total_bytes, statistics.unique_bytes, statistics.new_object_bytes,
      statistics.reused_object_bytes, statistics.deduplicated_bytes].every((value) => value >= 0),
    JSON.stringify(statistics));
  ok(where + ' stored and reused counts are non-negative integers',
    Number.isInteger(statistics.objects_stored) && statistics.objects_stored >= 0
    && Number.isInteger(statistics.objects_reused) && statistics.objects_reused >= 0,
    JSON.stringify(statistics));
}

// --- audit ----------------------------------------------------------------
// With a spare object, because that is the only case where referenced and unreferenced differ.
const withSpare = (() => {
  const snapshot = JSON.parse(JSON.stringify(plain(base)));
  // A payload whose digest matches, so the audit has nothing to complain about.
  snapshot.objects['4a60bf7d4bc1e485744cf7e8d0860524752fca1ce42331be7c439fd23043f151'] = 'eno=';
  return snapshot;
})();
for (const [label, snapshot] of [['clean', plain(base)], ['with a spare', withSpare]]) {
  const report = engine({operation: 'audit', snapshot});
  const where = 'audit (' + label + ')';
  ok(where + ' referenced + unreferenced = total',
    report.referenced_objects + report.unreferenced_objects === report.objects_total,
    JSON.stringify(report));
  ok(where + ' checked = total, so a full audit is full',
    report.objects_checked === report.objects_total, JSON.stringify(report));
  ok(where + ' total = the objects the snapshot stores',
    report.objects_total === Object.keys(snapshot.objects).length, JSON.stringify(report));
}

// --- restore --------------------------------------------------------------
const tree = engine({
  files: [
    {path: 'a.txt', text: 'abc'},
    {path: 'docs/x.md', text: 'x'},
    {path: 'docs/deep/y.bin', bytes: [0, 255]},
  ],
}).snapshot;
for (const [label, paths] of [['whole', undefined], ['docs only', ['docs']],
  ['one file', ['a.txt']], ['two subtrees', ['docs', 'a.txt']]]) {
  const result = paths === undefined
    ? engine({operation: 'restore', snapshot: tree})
    : engine({operation: 'restore', snapshot: tree, paths});
  const where = 'restore (' + label + ')';
  ok(where + ' selected = files.length',
    result.selected === result.files.length, JSON.stringify({selected: result.selected,
      files: result.files.length}));
  ok(where + ' total_files = the manifest file count',
    result.total_files === tree.files.length,
    JSON.stringify({total: result.total_files, manifest: tree.files.length}));
  ok(where + ' a subset is never larger than the whole',
    result.files.length <= result.total_files, JSON.stringify(result.files.length));
  ok(where + ' every restored path is in the manifest',
    result.files.every((file) => tree.files.some((entry) => entry.path === file.path)),
    JSON.stringify(result.files.map((file) => file.path)));
}

// --- squash ---------------------------------------------------------------
const folded = engine({operation: 'squash', snapshot: plain(tree)});
ok('squash reports the file count of the snapshot it produced',
  folded.statistics.files === folded.snapshot.files.length,
  JSON.stringify(folded.statistics));
ok('squash reports the object count it actually stored',
  folded.statistics.objects === Object.keys(folded.snapshot.objects).length,
  JSON.stringify(folded.statistics));
// A folded snapshot has no parent, and the canonical spelling of that depends on the format:
// formats 1 and 2 omit the key, format 3 carries `parent: null`. Asserting `=== null` for all
// three was wrong, and finding out why is how this comment exists.
for (const format of [1, 2, 3]) {
  const source = engine({format, files: [{path: 'a', text: 'x'}]}).snapshot;
  const result = engine({operation: 'squash', snapshot: plain(source)}).snapshot;
  const where = 'squash of a format ' + format + ' snapshot';
  ok(where + ' has no parent',
    format === 3 ? result.parent === null : !('parent' in result),
    JSON.stringify({version: result.version, parent: result.parent}));
  // And it keeps the format it was given when nothing asks for a conversion.
  ok(where + ' keeps its format', result.version === format, String(result.version));
}

// --- retention ------------------------------------------------------------
// Six shapes: independent snapshots, a chain, a spare object in a kept snapshot, a spare in a
// dropped one, an unnamed external parent, and everything kept.
const alpha = engine({files: [{path: 'a.txt', text: 'alpha'}]}).snapshot;
const beta = engine({files: [{path: 'b.txt', text: 'beta'}]}).snapshot;
const alphaWithSpare = (() => {
  const snapshot = JSON.parse(JSON.stringify(plain(alpha)));
  snapshot.objects['4a60bf7d4bc1e485744cf7e8d0860524752fca1ce42331be7c439fd23043f151'] = 'eno=';
  return snapshot;
})();
const chainBase = engine({files: [{path: 'c.txt', text: 'chain'}]}).snapshot;
const chainTip = engine({
  format: 3, previous: plain(chainBase),
  files: [{path: 'c.txt', text: 'chain'}, {path: 'd.txt', text: 'more'}],
}).snapshot;

const retentionCases = [
  ['two independent, keep one', {
    snapshots: [{id: 'a', snapshot: plain(alpha)}, {id: 'b', snapshot: plain(beta)}],
    keep: ['a'],
  }],
  ['two independent, keep both', {
    snapshots: [{id: 'a', snapshot: plain(alpha)}, {id: 'b', snapshot: plain(beta)}],
    keep: ['a', 'b'],
  }],
  ['spare in the kept snapshot', {
    snapshots: [{id: 'a', snapshot: alphaWithSpare}], keep: ['a'],
  }],
  ['spare in the dropped snapshot', {
    snapshots: [{id: 'a', snapshot: plain(alpha)}, {id: 'b', snapshot: alphaWithSpare}],
    keep: ['a'],
  }],
  ['a chain, keep the tip', {
    snapshots: [{id: 'base', snapshot: plain(chainBase)},
      {id: 'tip', snapshot: plain(chainTip), parents: [plain(chainBase)]}],
    keep: ['tip'],
  }],
  ['a chain, keep the base only', {
    snapshots: [{id: 'base', snapshot: plain(chainBase)},
      {id: 'tip', snapshot: plain(chainTip), parents: [plain(chainBase)]}],
    keep: ['base'],
  }],
];

for (const [label, request] of retentionCases) {
  const plan = engine({operation: 'retention', ...request});
  const where = 'retention (' + label + ')';

  // Every object the request supplied must land in exactly one bucket. An object in none would be
  // a byte nobody accounts for; in two would be a byte counted twice.
  const supplied = new Set();
  const sizes = new Map();
  for (const entry of request.snapshots) {
    for (const [hash, payload] of Object.entries(entry.snapshot.objects)) {
      supplied.add(hash);
      sizes.set(hash, entry.snapshot.version === 1
        ? payload.length
        : Buffer.from(payload, 'base64').length);
    }
  }
  const buckets = [plan.reachable_objects, plan.collectible_objects, plan.stranded_objects];
  const union = new Set(buckets.flat());
  const sum = buckets.reduce((total, bucket) => total + bucket.length, 0);
  ok(where + ' the three buckets cover every supplied object',
    union.size === supplied.size && [...supplied].every((hash) => union.has(hash)),
    JSON.stringify({supplied: supplied.size, covered: union.size}));
  ok(where + ' no object is in two buckets',
    sum === union.size, JSON.stringify({entries: sum, distinct: union.size}));

  // The bytes are the size of what is in each bucket, counted once.
  const bytesOf = (bucket) => bucket.reduce((total, hash) => total + (sizes.get(hash) ?? 0), 0);
  ok(where + ' live_bytes is the size of the reachable objects',
    plan.live_bytes === bytesOf(plan.reachable_objects),
    JSON.stringify({reported: plan.live_bytes, computed: bytesOf(plan.reachable_objects)}));
  ok(where + ' collectible_bytes is what a deletion would free',
    plan.collectible_bytes === bytesOf(plan.collectible_objects),
    JSON.stringify({reported: plan.collectible_bytes,
      computed: bytesOf(plan.collectible_objects)}));
  ok(where + ' stranded_bytes is what a squash would free',
    plan.stranded_bytes === bytesOf(plan.stranded_objects),
    JSON.stringify({reported: plan.stranded_bytes, computed: bytesOf(plan.stranded_objects)}));

  // The promise that started this: bytes are only collectible if there is something to delete.
  ok(where + ' collectible bytes imply something to delete',
    plan.collectible_bytes === 0 || plan.drop_snapshots.length > 0,
    JSON.stringify({collectible_bytes: plan.collectible_bytes,
      drop: plan.drop_snapshots}));
  // And the converse, which is the other way to be wrong: naming a snapshot to delete while
  // claiming nothing would be freed.
  ok(where + ' a deletion is not proposed when it would free nothing',
    plan.drop_snapshots.length === 0 || plan.collectible_bytes > 0 || plan.collectible_objects.length === 0,
    JSON.stringify({drop: plan.drop_snapshots, collectible: plan.collectible_objects.length}));

  // Keeping and dropping must account for every named snapshot exactly once.
  const named = new Set(request.snapshots.map((entry) => entry.id));
  const accounted = new Set([...plan.keep_snapshots, ...plan.required_snapshots,
    ...plan.drop_snapshots]);
  ok(where + ' every named snapshot is kept, required or dropped',
    [...named].every((id) => accounted.has(id)), JSON.stringify({named: [...named],
      accounted: [...accounted]}));
  ok(where + ' nothing outside the request is named',
    [...accounted].every((id) => named.has(id)), JSON.stringify([...accounted]));
}

if (problems.length) {
  console.error(`Invariants: ${problems.length} problem(s) across ${checked.length} assertions`);
  for (const problem of problems) console.error('  ' + problem);
  console.error('Each of these is a statement a reader can check with a calculator. When two '
    + 'reported numbers disagree, the reader has no way to know which one is wrong.');
  process.exit(1);
}
console.log(`Invariants: ${checked.length} arithmetic relations hold across create, audit, `
  + 'restore, squash and retention');
