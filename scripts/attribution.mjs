// Checks the claims that only matter once the package is published.
//
//   node scripts/attribution.mjs
//
// Every other check in the ladder is about behaviour. These are about the facts a consumer relies
// on before running anything: what they are licensed to do, whose code is inside, and whether the
// module pulls anything in. They are checked here because they are the claims that go stale
// without anything failing - adding a dependency, editing a license line, or dropping a file from
// `third_party/` produces no failing test, only a package that says something untrue.
//
// `THIRD_PARTY.md` is not aspirational: it names specific versions of the code this module was
// derived from, promises the license texts ship in `third_party/`, and states there is no runtime
// dependency outside `moonbitlang/core`. Each of those is checkable, and each is checked.
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {unpack} from './unpack.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const notes = [];

function read(relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

// --- the license the module declares is the license it ships ----------------
const declared = read('moon.mod').match(/^license\s*=\s*"([^"]+)"/m)?.[1];
if (!declared) {
  problems.push('moon.mod declares no license');
} else {
  const text = read('LICENSE');
  // Matching the text rather than the filename: a file called LICENSE that holds the wrong text
  // grants the wrong rights, and nobody reads it closely enough to notice.
  const recognised = {
    'Apache-2.0': /Apache License\s*\n?\s*Version 2\.0/,
    MIT: /MIT License|Permission is hereby granted, free of charge/,
    'BSD-3-Clause': /BSD 3-Clause|Redistribution and use in source and binary forms/,
  };
  const pattern = recognised[declared];
  if (!pattern) {
    problems.push(`moon.mod declares ${declared}, which this check does not know how to verify`);
  } else if (!pattern.test(text)) {
    problems.push(`moon.mod declares ${declared} but LICENSE does not contain that license text`);
  } else {
    notes.push(`LICENSE is ${declared}, as moon.mod declares`);
  }
}

// --- no runtime dependency, as claimed -------------------------------------
const tree = spawnSync('moon', ['tree'], {cwd: root, encoding: 'utf8', timeout: 300000});
if (tree.error || tree.status !== 0) {
  problems.push('moon tree failed, so the dependency claim cannot be checked:\n'
    + ((tree.stdout || '') + (tree.stderr || '')).trim());
} else {
  const output = tree.stdout || '';
  const outsideCore = output.split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[└├]─/.test(line))
    .map((line) => line.replace(/^[└├]─\s*/, ''))
    .filter((line) => !line.startsWith('moonbitlang/'));
  if (outsideCore.length > 0) {
    problems.push('THIRD_PARTY.md says there is no runtime dependency outside moonbitlang/core, '
      + 'but the module resolves: ' + outsideCore.join(', '));
  } else {
    notes.push('no runtime dependency outside moonbitlang/core, as claimed');
  }
}

// --- the attribution names code it actually describes ----------------------
// `THIRD_PARTY.md` names the versions this module was derived from. Those are facts about the
// published history, so the checkable part is that they are well formed and that the claim about
// the current release matches: a rewritten codec means the module must not still depend on the
// thing it was rewritten from.
const attribution = read('THIRD_PARTY.md');
for (const match of attribution.matchAll(/`(gmlewis\/[a-z0-9]+)@([0-9.]+)`/g)) {
  const [, module, version] = match;
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    problems.push(`THIRD_PARTY.md names ${module}@${version}, which is not a version number`);
  }
  notes.push(`attributes ${module}@${version} as historical`);
}

// Paths promised to exist. Backticked names with a slash or a known extension are the ones a
// reader would go looking for.
for (const match of attribution.matchAll(/`((?:third_party|scripts|docs)\/[A-Za-z0-9._/-]+)`/g)) {
  const promised = match[1];
  if (!fs.existsSync(path.join(root, promised))) {
    problems.push(`THIRD_PARTY.md points at ${promised}, which does not exist`);
  }
}

// --- and those paths reach the consumer ------------------------------------
// Decided from the archive, not from `moon package --list`. The listing names top-level entries
// only, so asking it whether `third_party/sha256-LICENSE.txt` ships answers no even when it does -
// which is what the first version of this check reported. The archive is the thing a consumer
// receives, so the archive is what gets inspected.
const licenses = fs.existsSync(path.join(root, 'third_party'))
  ? fs.readdirSync(path.join(root, 'third_party'))
  : [];
if (licenses.length === 0) {
  problems.push('third_party/ is empty, but THIRD_PARTY.md says the license texts are there');
}

const packaged = spawnSync('moon', ['package'], {cwd: root, encoding: 'utf8', timeout: 600000});
if (packaged.error || packaged.status !== 0) {
  problems.push('moon package failed, so what ships cannot be checked:\n'
    + ((packaged.stdout || '') + (packaged.stderr || '')).trim());
} else {
  const version = read('moon.mod').match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  const name = read('moon.mod').match(/^name\s*=\s*"([^"]+)"/m)?.[1];
  const archive = path.join(root, '_build', 'publish',
    `${name.replace('/', '-')}-${version}.zip`);
  if (!fs.existsSync(archive)) {
    problems.push(`moon package wrote no archive at ${archive}`);
  } else {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'snapvault-attribution-'));
    try {
      unpack(archive, scratch);
      for (const name of licenses) {
        if (!fs.existsSync(path.join(scratch, 'third_party', name))) {
          problems.push(`third_party/${name} is in the repository but not in the archive, so the `
            + 'attribution points at a file the consumer does not receive');
        }
      }
      if (!fs.existsSync(path.join(scratch, 'THIRD_PARTY.md'))) {
        problems.push('THIRD_PARTY.md is not in the archive, so the attribution is not shipped');
      } else if (licenses.every((name) => fs.existsSync(path.join(scratch, 'third_party', name)))) {
        notes.push(`${licenses.length} attribution license file(s) ship with the package`);
      }
    } finally {
      fs.rmSync(scratch, {recursive: true, force: true});
    }
  }
}

if (problems.length) {
  console.error(`Attribution: ${problems.length} problem(s)`);
  for (const problem of problems) console.error('  ' + problem);
  console.error('These only fail once someone installs the package, which is the worst time to '
    + 'find out.');
  process.exit(1);
}

for (const note of notes) console.log('  ' + note);
console.log(`Attribution: ${notes.length} claim(s) about license, dependencies and shipped `
  + 'notices hold');
