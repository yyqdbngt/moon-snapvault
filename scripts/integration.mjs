import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {backup, restore, squash, deltaFromDigests, resolveInPieces, squashInPieces, manifestOnly} from './filesystem.mjs';
import {engine} from './engine.mjs';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'snapvault-integration-'));
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
try {
  const source = path.join(base, 'source');
  fs.mkdirSync(source);
  fs.mkdirSync(path.join(source, 'nested'));
  fs.writeFileSync(path.join(source, 'nested/a.bin'), Buffer.from([0, 255, 1, 2]));
  fs.writeFileSync(path.join(source, 'copy.bin'), Buffer.from([0, 255, 1, 2]));
  // A payload big enough that reusing it is visible in the file size.
  fs.writeFileSync(path.join(source, 'nested/big.bin'), crypto.randomBytes(64 * 1024));
  const one = path.join(base, 'one.json');
  const stats = backup(source, one);
  assert.equal(stats.deduplicated_bytes, 4);
  assert.equal(stats.format, 2, 'a backup without a previous snapshot is self contained');
  const restored = path.join(base, 'restored');
  restore(one, restored);
  assert.deepEqual(fs.readFileSync(path.join(restored, 'nested/a.bin')), fs.readFileSync(path.join(source, 'nested/a.bin')));
  assert.throws(() => restore(one, restored));
  assert.throws(() => backup(source, one));
  assert.throws(() => backup(source, path.join(source, 'bad.json')));

  // A backup with a previous snapshot is a format 3 delta: it stores only the
  // objects the chain does not already hold.
  fs.writeFileSync(path.join(source, 'copy.bin'), 'changed');
  const two = path.join(base, 'two.json');
  const deltaStats = backup(source, two, one);
  const delta = read(two);
  assert.equal(delta.version, 3);
  assert.equal(delta.parent, read(one).checksum);
  assert.equal(deltaStats.parent, read(one).checksum);
  assert.equal(Object.keys(delta.objects).length, 1, 'only the changed file is stored');
  assert.equal(deltaStats.reused_object_bytes, 64 * 1024 + 4);
  // The same tree written self contained carries the big payload twice.
  const selfContained = path.join(base, 'self-contained.json');
  const fullStats = backup(source, selfContained);
  assert.ok(
    deltaStats.snapshot_bytes < fullStats.snapshot_bytes / 2,
    `delta ${deltaStats.snapshot_bytes} should be far smaller than ${fullStats.snapshot_bytes}`,
  );

  const diff = engine({operation: 'diff', old: read(one), new: delta});
  assert.deepEqual(diff.modified, ['copy.bin']);

  // Restoring a delta needs its chain, and refuses to run without one.
  assert.throws(() => restore(two, path.join(base, 'no-chain')), /corrupted/);
  assert.equal(fs.existsSync(path.join(base, 'no-chain')), false);
  const deltaTarget = path.join(base, 'delta-out');
  const deltaResult = restore(two, deltaTarget, [one]);
  assert.equal(deltaResult.chain_depth, 2);
  assert.equal(fs.readFileSync(path.join(deltaTarget, 'copy.bin'), 'utf8'), 'changed');
  assert.deepEqual(fs.readFileSync(path.join(deltaTarget, 'nested/a.bin')), fs.readFileSync(path.join(source, 'nested/a.bin')));

  // A delta of a delta resolves through the whole chain.
  fs.writeFileSync(path.join(source, 'nested/a.bin'), Buffer.from([9, 9, 9]));
  const three = path.join(base, 'three.json');
  backup(source, three, two, [one]);
  const third = read(three);
  assert.equal(third.version, 3);
  assert.equal(third.parent, delta.checksum);
  const chainTarget = path.join(base, 'chain-out');
  const chainResult = restore(three, chainTarget, [one, two]);
  assert.equal(chainResult.chain_depth, 3);
  assert.deepEqual(fs.readFileSync(path.join(chainTarget, 'nested/a.bin')), Buffer.from([9, 9, 9]));

  // A delta whose parent is corrupt must not restore.
  const brokenParent = read(one);
  for (const key of Object.keys(brokenParent.objects)) {
    brokenParent.objects[key] = Buffer.from('corrupted').toString('base64');
  }
  const brokenFile = path.join(base, 'broken-parent.json');
  fs.writeFileSync(brokenFile, JSON.stringify(brokenParent));
  assert.equal(engine({operation: 'audit', snapshot: third, parents: [brokenParent, read(two)]}).valid, false);
  const brokenTarget = path.join(base, 'broken-out');
  assert.throws(() => restore(three, brokenTarget, [brokenFile, two]));
  assert.equal(fs.existsSync(brokenTarget), false);

  // The path the adapter takes when a delta request would not fit: a manifest-only
  // parent plus the chain's digests has to produce the same snapshot as sending
  // the parent whole, and it has to restore through the chain.
  const slimFiles = [];
  (function walk(directory, relative) {
    for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
      const name = relative ? relative + '/' + entry.name : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute, name);
      else if (entry.isFile()) {
        slimFiles.push({
          path: name,
          content_base64: fs.readFileSync(absolute).toString('base64'),
          mode: fs.statSync(absolute).mode & 0o777,
        });
      }
    }
  })(source, '');
  // Signature takes paths now: it reads and verifies one link at a time.
  const slimStats = deltaFromDigests(slimFiles, [two, one]);
  const withParent = engine({
    operation: 'create', format: 3, previous: read(two), parents: [read(one)], files: slimFiles,
  });
  assert.equal(slimStats.snapshot.checksum, withParent.snapshot.checksum,
    'the digest path must build the same snapshot');
  assert.equal(JSON.stringify(slimStats.snapshot.objects),
    JSON.stringify(withParent.snapshot.objects));
  // The core could not verify the base, and says so instead of claiming it did.
  assert.equal(slimStats.statistics.base_verified, false);
  assert.equal(withParent.statistics.base_verified, true);
  const slimFile = path.join(base, 'slim.json');
  fs.writeFileSync(slimFile, JSON.stringify(slimStats.snapshot));
  const slimTarget = path.join(base, 'slim-out');
  const slimRestored = restore(slimFile, slimTarget, [two, one]);
  assert.equal(slimRestored.chain_depth, 3);
  assert.deepEqual(fs.readFileSync(path.join(slimTarget, 'nested/a.bin')), Buffer.from([9, 9, 9]));

  // A digest the chain does not have must fail at read time, not silently.
  // deltaFromDigests only ever declares what the chain really holds, so the claim
  // is forged here to exercise the reader's defence.
  const parentFile = read(two);
  const invented = crypto.createHash('sha256').update('never stored').digest('hex');
  const lie = engine({
    operation: 'create', format: 3, files: [
      ...slimFiles,
      {path: 'invented.bin', content_base64: Buffer.from('never stored').toString('base64'), mode: 0o644},
    ],
    previous: {version: parentFile.version, parent: parentFile.parent ?? null,
      files: parentFile.files, checksum: parentFile.checksum},
    parents: [read(one)],
    known_objects: [
      ...Object.keys(parentFile.objects), ...Object.keys(read(one).objects), invented,
    ],
  });
  assert.equal(invented in lie.snapshot.objects, false);
  const lieFile = path.join(base, 'lie.json');
  fs.writeFileSync(lieFile, JSON.stringify(lie.snapshot));
  assert.equal(engine({operation: 'audit', snapshot: lie.snapshot, parents: [read(two), read(one)]}).valid, false);
  assert.throws(() => restore(lieFile, path.join(base, 'lie-out'), [two, one]));
  assert.equal(fs.existsSync(path.join(base, 'lie-out')), false);

  // The piecewise paths: locating and extracting per link has to produce exactly
  // what a single fit-in-one-request restore produces.
  const chainSnapshots = [read(three), read(two), read(one)];
  const wholeRestore = engine({operation: 'restore', snapshot: chainSnapshots[0],
    parents: [chainSnapshots[1], chainSnapshots[2]]});
  const pieces = resolveInPieces(chainSnapshots[0], [chainSnapshots[1], chainSnapshots[2]]);
  const asMap = (list) => Object.fromEntries(list.map((f) => [f.path, Buffer.from(f.bytes, 'base64').toString('hex')]));
  assert.deepEqual(asMap(pieces.files), asMap(wholeRestore.files));
  assert.equal(pieces.piecewise, true);
  assert.equal(pieces.chain_depth, 3);
  // A selection works through the piecewise path too.
  const subset = resolveInPieces(chainSnapshots[0], [chainSnapshots[1], chainSnapshots[2]], ['nested']);
  assert.deepEqual(subset.files.map((f) => f.path).sort(), ['nested/a.bin', 'nested/big.bin']);
  // A link that is not supplied is reported, not written around.
  assert.throws(() => resolveInPieces(chainSnapshots[0], [chainSnapshots[2]]), /missing a parent/);

  const piecewiseSquash = squashInPieces(chainSnapshots[0], [chainSnapshots[1], chainSnapshots[2]], 3);
  assert.equal(piecewiseSquash.audited, true);
  const directSquash = engine({operation: 'squash', snapshot: chainSnapshots[0],
    parents: [chainSnapshots[1], chainSnapshots[2]], format: 3});
  assert.equal(piecewiseSquash.snapshot.checksum, directSquash.snapshot.checksum,
    'the piecewise squash must equal the one-request squash');
  assert.deepEqual(piecewiseSquash.snapshot.objects, directSquash.snapshot.objects);
  assert.deepEqual(manifestOnly(chainSnapshots[1]).files, chainSnapshots[1].files);

  // Extending a chain to a third large link is the case that used to fail: the
  // declared-objects path audited the whole chain in one request, so link 2 was
  // rejected with "input exceeds 16 MiB". Three links of 8 MiB put the chain past
  // the cap while each link still fits the adapter's per-backup limit.
  {
    const chainDir = path.join(base, 'long-chain');
    const chainSrc = path.join(chainDir, 'src');
    fs.mkdirSync(chainSrc, {recursive: true});
    const writeRound = () => {
      for (let i = 0; i < 8; i++) {
        fs.writeFileSync(path.join(chainSrc, `f${i}.bin`), crypto.randomBytes(1024 * 1024));
      }
    };
    writeRound();
    const links = [path.join(chainDir, 'l0.json')];
    backup(chainSrc, links[0]);
    for (let n = 1; n < 3; n++) {
      writeRound();
      const next = path.join(chainDir, `l${n}.json`);
      const stats = backup(chainSrc, next, links[n - 1], links.slice(0, n - 1));
      assert.equal(stats.format, 3);
      assert.equal(stats.chain_verified, true);
      links.push(next);
    }
    const chainTotal = links.reduce((sum, f) => sum + fs.statSync(f).size, 0);
    assert.ok(chainTotal > 16 * 1024 * 1024, `chain should exceed the cap, was ${chainTotal}`);
    const longTarget = path.join(chainDir, 'out');
    const longResult = restore(links[2], longTarget, [links[1], links[0]]);
    assert.equal(longResult.chain_depth, 3);
    assert.equal(longResult.files, 8);
    // Byte-for-byte against the last round the source held.
    for (let i = 0; i < 8; i++) {
      assert.deepEqual(fs.readFileSync(path.join(longTarget, `f${i}.bin`)),
        fs.readFileSync(path.join(chainSrc, `f${i}.bin`)));
    }
    const squashed = squash(links[2], path.join(chainDir, 'flat.json'), [links[1], links[0]]);
    assert.equal(squashed.chain_depth, 3);
    const flatTarget = path.join(chainDir, 'flat-out');
    assert.equal(restore(path.join(chainDir, 'flat.json'), flatTarget).chain_depth, 1);
    for (let i = 0; i < 8; i++) {
      assert.deepEqual(fs.readFileSync(path.join(flatTarget, `f${i}.bin`)),
        fs.readFileSync(path.join(chainSrc, `f${i}.bin`)));
    }
  }

  // Concurrent publication. The claim is that a destination is created exclusively,
  // so racing processes produce one snapshot and clear failures rather than a mixed
  // file. That was never exercised: the code comment asserted it and nothing tested
  // it. Both operations are checked because both write into a name that must not
  // already exist.
  {
    const raceDir = path.join(base, 'race');
    const raceSrc = path.join(raceDir, 'src');
    fs.mkdirSync(raceSrc, {recursive: true});
    for (let i = 0; i < 4; i++) {
      fs.writeFileSync(path.join(raceSrc, `f${i}.bin`), Buffer.alloc(150000, i));
    }
    const filesystem = fileURLToPath(new URL('./filesystem.mjs', import.meta.url));
    const spawnOne = (args) => new Promise((resolve) => {
      const child = spawn(process.execPath, [filesystem, ...args]);
      let err = '';
      child.stderr.on('data', (chunk) => err += chunk);
      child.on('close', (code) => resolve({code, err}));
    });

    const racedSnapshot = path.join(raceDir, 'raced.json');
    const backups = await Promise.all(
      Array.from({length: 6}, () => spawnOne(['backup', raceSrc, racedSnapshot])));
    assert.equal(backups.filter((r) => r.code === 0).length, 1,
      'exactly one concurrent backup may publish');
    const backupLosers = backups.filter((r) => r.code !== 0);
    assert.equal(backupLosers.length, 5);
    for (const loser of backupLosers) {
      assert.match(loser.err, /already exists at .*; snapshots are never replaced/,
        'a lost publication race must say what happened, not leak EEXIST');
    }
    assert.equal(fs.readdirSync(raceDir).filter((n) => n.includes('.tmp')).length, 0,
      'no temporary file may survive a lost race');
    const published = read(racedSnapshot);
    assert.equal(published.files.length, 4, 'the published snapshot must be complete');
    assert.equal(engine({operation: 'audit', snapshot: published}).valid, true,
      'the published snapshot must be intact');

    // The same for restore, whose destination must also be new.
    const raceTarget = path.join(raceDir, 'raced-out');
    const restores = await Promise.all(
      Array.from({length: 6}, () => spawnOne(['restore', racedSnapshot, raceTarget])));
    assert.equal(restores.filter((r) => r.code === 0).length, 1,
      'exactly one concurrent restore may create the destination');
    for (const loser of restores.filter((r) => r.code !== 0)) {
      assert.match(loser.err, /destination already exists/i,
        'a lost restore race must name the destination');
    }
    const restoredNames = fs.readdirSync(raceTarget).sort();
    assert.equal(restoredNames.length, 4, 'the winning restore must be complete');
    for (const name of restoredNames) {
      assert.deepEqual(fs.readFileSync(path.join(raceTarget, name)),
        fs.readFileSync(path.join(raceSrc, name)),
        'no file may be a mixture of two concurrent restores');
    }
  }

  // Squashing compacts the whole chain into one self-contained file that no
  // longer needs its parents, and selects on the way out.
  const squashedFile = path.join(base, 'squashed.json');
  const squashStats = squash(three, squashedFile, [one, two]);
  assert.equal(squashStats.chain_depth, 3);
  assert.equal(read(squashedFile).parent, null);
  const squashedTarget = path.join(base, 'squashed-out');
  const squashedResult = restore(squashedFile, squashedTarget);
  assert.equal(squashedResult.chain_depth, 1);
  assert.deepEqual(fs.readFileSync(path.join(squashedTarget, 'nested/a.bin')), Buffer.from([9, 9, 9]));
  // Squashing is idempotent: doing it again changes nothing.
  const twiceFile = path.join(base, 'squashed-twice.json');
  squash(squashedFile, twiceFile, []);
  assert.equal(read(twiceFile).checksum, read(squashedFile).checksum);

  // Selective restore writes only the requested subtree.
  const partialTarget = path.join(base, 'partial-out');
  const partial = restore(three, partialTarget, [one, two], ['nested']);
  // nested/a.bin and nested/big.bin; copy.bin sits at the root and is skipped.
  assert.equal(partial.files, 2);
  assert.equal(partial.total_files, 3);
  assert.ok(fs.existsSync(path.join(partialTarget, 'nested/a.bin')));
  assert.equal(fs.existsSync(path.join(partialTarget, 'copy.bin')), false);
  assert.throws(() => restore(three, path.join(base, 'partial-miss'), [one, two], ['nope']), /not found/);
  assert.equal(fs.existsSync(path.join(base, 'partial-miss')), false);

  // Corruption inside the delta itself is caught the same way as before: swap
  // the stored payload for a different byte sequence so only the digest notices.
  const tampered = read(two);
  const localDigest = Object.keys(tampered.objects)[0];
  tampered.objects[localDigest] = Buffer.from('not the original bytes').toString('base64');
  assert.equal(engine({operation: 'audit', snapshot: tampered, parents: [read(one)]}).valid, false);
  const corrupt = path.join(base, 'corrupt.json');
  fs.writeFileSync(corrupt, JSON.stringify(tampered));
  const untouched = path.join(base, 'untouched');
  assert.throws(() => restore(corrupt, untouched, [one]));
  assert.equal(fs.existsSync(untouched), false);

  // An unreferenced object that does not match its key is corruption too, and
  // restore must not create the destination for it.
  const valid = read(two);
  valid.objects['0'.repeat(64)] = [1, 2, 3]; // decimal payload under a base64 format
  const spareCorrupt = path.join(base, 'spare-corrupt.json');
  fs.writeFileSync(spareCorrupt, JSON.stringify(valid));
  assert.equal(engine({operation: 'audit', snapshot: valid, parents: [read(one)]}).valid, false);
  const spareTarget = path.join(base, 'spare-target');
  assert.throws(() => restore(spareCorrupt, spareTarget, [one]));
  assert.equal(fs.existsSync(spareTarget), false);

  // Permission bits survive the process umask where the platform has them. NTFS
  // does not: chmod there only toggles the read-only bit, so the recorded mode
  // cannot come back and claiming otherwise would be false.
  fs.writeFileSync(path.join(source, 'run.sh'), '#!/bin/sh\n');
  fs.chmodSync(path.join(source, 'run.sh'), 0o777);
  const withMode = path.join(base, 'mode.json');
  backup(source, withMode);
  const previousUmask = process.umask(0o077);
  const modeTarget = path.join(base, 'mode-out');
  const modeResult = restore(withMode, modeTarget);
  process.umask(previousUmask);
  const restoredMode = fs.statSync(path.join(modeTarget, 'run.sh')).mode & 0o777;
  if (process.platform === 'win32') {
    // What Windows can represent: the file is writable, so the read-only bit is
    // clear. The execute bits are not a Windows concept at all.
    assert.equal(restoredMode & 0o200, 0o200, 'restored file should be writable');
    assert.equal(modeResult.modes_applied, modeResult.files);
  } else {
    assert.equal(restoredMode, 0o777);
    assert.equal(modeResult.modes_applied, modeResult.files);
  }

  // Names Windows forbids are ordinary Linux file names. The snapshot must be able
  // to hold them and restore them here; only the writer's portability check, which
  // runs against the actual destination, decides otherwise. Refusing them in the
  // core made such a directory impossible to back up at all.
  if (process.platform !== 'win32') {
    // Skipped on Windows: `con` and `we:ird.txt` cannot exist there, which is the
    // whole point of the portability check below.
    const nativeDir = path.join(base, 'native-names');
    const nativeSrc = path.join(nativeDir, 'src');
    fs.mkdirSync(nativeSrc, {recursive: true});
    const nativeNames = ['con', 'nul.txt', 'a\\b.txt', 'we:ird.txt', 'normal.txt'];
    for (const name of nativeNames) fs.writeFileSync(path.join(nativeSrc, name), 'content of ' + name);
    const nativeSnap = path.join(nativeDir, 's.json');
    backup(nativeSrc, nativeSnap);
    assert.equal(read(nativeSnap).files.length, nativeNames.length);
    const nativeOut = path.join(nativeDir, 'out');
    const nativeResult = restore(nativeSnap, nativeOut);
    assert.equal(nativeResult.files, nativeNames.length);
    assert.deepEqual(fs.readdirSync(nativeOut).sort(), fs.readdirSync(nativeSrc).sort());
    for (const name of nativeNames) {
      assert.equal(fs.readFileSync(path.join(nativeOut, name), 'utf8'),
        'content of ' + name);
    }
    // The same snapshot is described, truthfully, as unable to restore everywhere.
    assert.equal(engine({operation: 'audit', snapshot: read(nativeSnap)}).valid, true);
  }

  // Paths that resolve outside the destination must be refused wherever they can be
  // written at all. On Windows a drive-letter or drive-relative path is the live
  // case; on Linux and macOS there is no path of that shape, and the core's rules
  // already reject an absolute one.
  for (const hostile of ['C:/tmp/escape', 'c:escape', 'a:../escape', '/tmp/escape',
                         '../escape', '../../escape']) {
    assert.throws(
      () => restore(one, path.join(base, 'escape-' + hostile.replace(/\W/g, '')),
        [], [hostile]),
      /not found|unsafe|leaves|collide/i,
      'a selection of ' + hostile + ' must be refused');
  }

  // A colon inside a file name is a Windows alternate data stream rather than a
  // regular file: it would be written, would not appear in a directory listing, and
  // would silently not be the file the manifest describes. Windows refuses it; the
  // platforms where `:` is an ordinary character restore it as one.
  {
    const colonFiles = [...slimFiles, {path: 'ads.txt:hidden', content_base64: 'eA==', mode: 0o644}];
    const colonSnap = engine({operation: 'create', format: 3, files: colonFiles}).snapshot;
    assert.equal(engine({operation: 'audit', snapshot: colonSnap}).valid, true,
      'a colon is valid data');
    const colonFile = path.join(base, 'colon.json');
    fs.writeFileSync(colonFile, JSON.stringify(colonSnap));
    const colonTarget = path.join(base, 'colon-out');
    if (process.platform === 'win32') {
      assert.throws(() => restore(colonFile, colonTarget), /Windows reserves/);
      assert.equal(fs.existsSync(colonTarget), false);
    } else {
      restore(colonFile, colonTarget);
      assert.ok(fs.readdirSync(colonTarget).includes('ads.txt:hidden'),
        'on this platform the colon is part of an ordinary name');
    }
  }

  // A name longer than any filesystem allows is refused by the core, so a restore
  // cannot fail halfway through with ENAMETOOLONG and leave a partial directory.
  assert.throws(
    () => engine({files: [{path: 'x'.repeat(300) + '.txt', text: 'x'}]}),
    /unsafe/i);
  const longTarget = path.join(base, 'long-name-out');
  assert.equal(fs.existsSync(longTarget), false);

  // A real tree of unicode names has to round-trip. This runs on whatever
  // filesystem the tests are on, so on a normalising volume it also proves that
  // recording NFD names and writing them back is faithful rather than lossy.
  {
    const uniDir = path.join(base, 'unicode');
    const uniSrc = path.join(uniDir, 'src');
    fs.mkdirSync(uniSrc, {recursive: true});
    // One spelling per distinct name: a tree holding both NFC and NFD of the same
    // name is the portability collision tested separately below, not a round trip.
    const uniNames = [
      'caf\u00e9.txt',            // composed
      'n\u0303o.txt',              // decomposed, a different name
      '\u4e2d\u6587.txt',          // CJK
      '\ud83c\udf89 party.txt',    // emoji, outside the BMP
      '\u05e9\u05dc\u05d5\u05dd.txt', // RTL
      'a\u200db.txt',              // zero-width joiner
      'sp ace.txt', 'UPPER.txt', '\u00c4rger.txt',
    ];
    for (const name of uniNames) fs.writeFileSync(path.join(uniSrc, name), 'content of ' + name);
    const uniSnap = path.join(uniDir, 's.json');
    backup(uniSrc, uniSnap);
    const uniOut = path.join(uniDir, 'out');
    restore(uniSnap, uniOut);
    const contents = (dir) => fs.readdirSync(dir)
      .map((name) => fs.readFileSync(path.join(dir, name)).toString()).sort();
    assert.deepEqual(contents(uniOut), contents(uniSrc), 'unicode tree must round-trip by content');
    // Names may be normalised by the volume on the way in, so compare after NFC.
    const folded = (dir) => fs.readdirSync(dir).map((name) => name.normalize('NFC')).sort();
    assert.deepEqual(folded(uniOut), folded(uniSrc), 'unicode tree must round-trip by name');
  }

  // Two files that differ only in case are two files on Linux and one on a
  // case-insensitive volume. Restoring must refuse rather than let one overwrite
  // the other; the contents differ so an overwrite would be visible data loss.
  const casePair = engine({files: [
    {path: 'Report.txt', text: 'upper version'},
    {path: 'report.txt', text: 'lower version'},
  ]}).snapshot;
  assert.equal(engine({operation: 'audit', snapshot: casePair}).valid, true,
    'a case-differing pair is a valid snapshot');
  const casePairFile = path.join(base, 'case-pair.json');
  fs.writeFileSync(casePairFile, JSON.stringify(casePair));
  const casePairTarget = path.join(base, 'case-pair-out');
  assert.throws(() => restore(casePairFile, casePairTarget), /Case folding|normalization/i);
  assert.equal(fs.existsSync(casePairTarget), false, 'nothing may be written for a case collision');

  // Names that collide only after Unicode normalization cannot be restored to a
  // normalizing filesystem; the adapter refuses before writing anything.
  const colliding = engine({files: [
    {path: 'caf\u00e9.txt', text: 'nfc'},
    {path: 'cafe\u0301.txt', text: 'nfd'},
  ]}).snapshot;
  const collidingFile = path.join(base, 'colliding.json');
  fs.writeFileSync(collidingFile, JSON.stringify(colliding));
  assert.equal(engine({operation: 'audit', snapshot: colliding}).valid, true);
  const collidingTarget = path.join(base, 'colliding-out');
  assert.throws(() => restore(collidingFile, collidingTarget), /Unicode normalization/);
  assert.equal(fs.existsSync(collidingTarget), false);

  console.log('Snapshot integration: base and delta snapshots, declared-objects deltas, piecewise restore and squash, three-link 8 MiB chains, chain restore, squash, selective restore, dedup, incremental diff, no overwrite, containment, corruption rejection, umask-independent modes, unicode round-trips, native-name round-trips, containment and alternate-stream rejection, over-long name rejection, case and normalization collision rejection, concurrent publication and restore passed');
} finally {
  fs.rmSync(base, {recursive: true, force: true});
}
