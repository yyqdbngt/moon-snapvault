// Counts fsync calls made by the adapter, for scripts/durability.mjs.
//
// Patching `require('fs')` reaches `import fs from 'node:fs'` as well, because the ESM
// default export for a builtin is that same object. Without this the only way to know
// whether data was synced would be to cut the power, which is exactly the kind of claim
// that otherwise goes untested.
const fs = require('node:fs');
const target = process.env.FSYNC_LOG;
if (target) {
  for (const name of ['fsyncSync', 'fdatasyncSync']) {
    const original = fs[name];
    if (typeof original !== 'function') continue;
    fs[name] = function patched(...args) {
      fs.appendFileSync(target, name + '\n');
      return original.apply(this, args);
    };
  }
}
