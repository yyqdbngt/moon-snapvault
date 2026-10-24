# Snapshots written by the published 0.2.0

These files were produced by `yyqdbngt/moon_snapvault@0.2.0` from MoonCakes, not by the
current code, and are committed unchanged. They exist so that backward compatibility is
tested against the real thing rather than against a reconstruction of it.

`0.2.0-first.json` and `0.2.0-second.json` are two snapshots of a three-file tree, the second
built with `previous=` so that it reuses a shared object. Both are `"version": 1` with decimal
byte arrays, because 0.2.0 predates format 2 and has no `format` parameter at all.

Two properties of the published version are worth recording, because they are easy to assume
wrongly:

- **Its deltas are self-contained.** `previous=` affects only the statistics - `objects_stored`,
  `objects_reused`, `changes` - and never the stored bytes. The second file below stores all
  three objects, not just the new one. Real incremental storage arrived with format 3.
- **It writes format 1 only.** There is no way to ask 0.2.0 for the base64 layout; that is
  format 2, added after publication.

`scripts/compat.mjs` reads these files with the current code and asserts they still audit,
restore and diff correctly. Regenerate only if the fixtures are found to be corrupt: they are
a record of what was published, so replacing them with current output would defeat the point.
