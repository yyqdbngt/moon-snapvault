import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {engine, safeFile} from './engine.mjs';

function inside(child, parent) { return child === parent || child.startsWith(parent + path.sep); }
export function backup(source, destination, previous) {
  const base = fs.realpathSync(source);
  const parent = fs.realpathSync(path.dirname(path.resolve(destination)));
  const output = path.join(parent, path.basename(destination));
  if (inside(output, base)) throw new Error('Snapshot destination must be outside source');
  const files = [];
  let total = 0;
  function walk(directory, relative) {
    for (const item of fs.readdirSync(directory, {withFileTypes: true}).sort((a,b) => a.name.localeCompare(b.name))) {
      const name = relative ? relative + '/' + item.name : item.name;
      const absolute = safeFile(base, name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error('Symlinks are unsupported');
      if (stat.isDirectory()) walk(absolute, name);
      else if (stat.isFile()) {
        total += stat.size;
        if (total > 1024 * 1024) throw new Error('JSON snapshot adapter limit is 1 MiB per backup');
        files.push({path: name, bytes: [...fs.readFileSync(absolute)], mode: stat.mode & 0o777});
      } else throw new Error('Special files are unsupported');
    }
  }
  walk(base, '');
  const result = engine({operation: 'create', files,
    ...(previous ? {previous: JSON.parse(fs.readFileSync(previous, 'utf8'))} : {})});
  const tmp = output + '.' + randomUUID() + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(result.snapshot), {flag: 'wx'});
    // Exclusive publication prevents replacing an existing snapshot.
    fs.linkSync(tmp, output);
  } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
  return result.statistics;
}

export function restore(snapshotFile, destination) {
  // Verify every object before creating the destination.
  const snapshot = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));
  const verified = engine({operation: 'restore', snapshot});
  const parent = fs.realpathSync(path.dirname(path.resolve(destination)));
  const output = path.join(parent, path.basename(destination));
  fs.mkdirSync(output); // Must be a new directory; existing targets are rejected.
  try {
    for (const file of verified.files) {
      const absolute = safeFile(output, file.path);
      fs.mkdirSync(path.dirname(absolute), {recursive: true});
      fs.writeFileSync(absolute, Buffer.from(file.bytes), {flag: 'wx', mode: file.mode});
    }
  } catch (err) {
    // Retain the new partial destination for inspection; no original files are touched.
    throw new Error('Restore failed; partial destination retained: ' + err.message);
  }
  return {files: verified.files.length, verified: true};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [operation, source, destination, previous] = process.argv.slice(2);
    if (!source || !destination) throw new Error('Usage: filesystem.mjs backup|restore source destination [previous]');
    if (!['backup', 'restore'].includes(operation)) throw new Error('Unknown operation');
    console.log(JSON.stringify(operation === 'backup' ? backup(source, destination, previous) : restore(source, destination)));
  } catch (err) { console.error(err.message); process.exitCode = 1; }
}
