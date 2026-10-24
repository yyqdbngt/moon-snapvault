// Checks that the committed interface file describes the current source.
//
//   node scripts/interface.mjs          # compare, exit 1 on drift
//   node scripts/interface.mjs --write  # regenerate it
//
// `moon info` writes pkg.generated.mbti. It was stale once already: `known_objects`
// was added to create_snapshot and the file kept the old signature, so anyone reading
// the published interface saw a function that no longer matched the code. A published
// version cannot be corrected in place, which makes this worth checking mechanically.
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(root, 'pkg.generated.mbti');

function readInterface() {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

// `Int` and `Int32` name the same type; the formatter's spelling of it changed
// between toolchains, and this project supports a range of them. Comparing raw text
// would report drift on whichever version did not write the file, so the spelling is
// normalised out. Any other difference is still a real one.
const normalise = (text) => text.replace(/: Int\b/g, ': Int32');

const before = readInterface();
const result = spawnSync('moon', ['info'], {cwd: root, encoding: 'utf8'});
if (result.error) {
  console.error('interface: cannot run `moon info`: ' + result.error.message);
  process.exit(1);
}
if (result.status !== 0) {
  console.error('interface: `moon info` failed:\n' + (result.stdout || '') + (result.stderr || ''));
  process.exit(1);
}
const after = readInterface();

if (process.argv.includes('--write')) {
  console.log('interface: pkg.generated.mbti regenerated');
  process.exit(0);
}

if (normalise(before) !== normalise(after)) {
  const beforeLines = normalise(before).split('\n');
  const afterLines = normalise(after).split('\n');
  const onlyBefore = beforeLines.filter((line) => !afterLines.includes(line));
  const onlyAfter = afterLines.filter((line) => !beforeLines.includes(line));
  console.error('interface: pkg.generated.mbti is stale; `moon info` would change it');
  for (const line of onlyBefore) console.error('  - ' + line);
  for (const line of onlyAfter) console.error('  + ' + line);
  console.error('interface: run `node scripts/interface.mjs --write` and commit the result');
  process.exit(1);
}
if (before !== after) {
  console.log('Interface: pkg.generated.mbti matches the source '
    + '(apart from the Int/Int32 spelling, which differs by toolchain)');
} else {
  console.log('Interface: pkg.generated.mbti matches the source');
}
