# Changelog

## Unreleased - 0.3.0

Module version in `main` is 0.3.0; `moon add yyqdbngt/moon_snapvault` still
resolves the published 0.2.0 until a release is published.

### Incremental snapshots (format 3)

- A snapshot may declare `parent` and store only the objects its chain does not
  already hold. `create` with `previous` writes format 3; `format: 3` without
  `previous` starts a chain explicitly. `format: 2` refuses a parent instead of
  ignoring it.
- `parent` is part of the checksum for format 3, so a delta cannot be re-pointed
  at a different base. The manifest stays complete: only payloads are
  incremental, and `diff` is unchanged.
- `audit`, `restore` and `retention` accept `parents` and resolve the chain by
  checksum. `audit` reports `chain_depth`, `objects_inherited` and the parent;
  `valid` covers the whole chain. A missing link is an issue
  (`missing parent snapshot`), and `restore` refuses before writing anything.
- Chains are walked to 64 links with every manifest verified; a cycle or a
  deeper chain raises instead of looping.
- `create` reports `reused_object_bytes`, `objects_stored` and `objects_reused`.
- Adapter: `backup` writes a delta when given a previous snapshot and returns
  `format`, `parent` and `snapshot_bytes`; `restore` takes the chain. Requests
  are measured before they are sent, so a delta too large for the 16 MiB CLI cap
  fails with the split between source and parent instead of "input exceeds
  16 MiB".
- 3 MiB tree, one small file changed: base 4.1 MB / 611 ms, delta 752 B / 685 ms.

### Backing up trees with platform-specific names

- Fixed: a directory containing a file named `con`, `a\b.txt` or `we:ird.txt` could
  not be backed up at all on Linux, where all three are ordinary names. The core's
  path rule rejected a union of every platform's restrictions, and the adapter's
  `safeFile` rejected two of them again.
- The core now accepts any path that is safe and possible somewhere: relative,
  no empty/`.`/`..` components, no control characters, every component within the
  255 bytes ext4, APFS and NTFS all allow. It gained that length limit, which it
  was missing: a 304-character component was reported `valid` by `audit` and then
  failed during restore with `ENAMETOOLONG`, leaving a partial directory.
- `portablePaths` refuses what the destination platform actually cannot hold:
  device names and `<>|?*` on Windows only, over-long paths everywhere, and case or
  normalisation collisions. The same snapshot now restores fully on Linux and is
  refused before anything is written when the destination is Windows.
- `backup` gained a per-problem warning for names that will not restore on every
  platform, instead of one opaque message.

### Backing up trees a case-insensitive volume cannot hold

- Fixed: a directory containing two names that differ only by case, such as
  `Report.txt` and `report.txt`, could not be backed up at all. The core folded case
  when validating a manifest and rejected the pair, while the adapter's own contract
  says such a backup proceeds with a portability warning and the restore is what
  refuses. On Linux this made ordinary directories impossible to snapshot.
- The core now rejects only structural contradictions - unwritable paths, exact
  duplicate paths, a path used as both a file and a directory - and leaves case and
  normalisation to the writer, which is the only layer that knows the destination
  filesystem. `audit` reports such a snapshot as valid, because it is.
- `portablePaths` became the sole enforcement point and grew the case it could not
  previously see: a file `A` alongside `a/b.txt` is fine on Linux and impossible on
  a case-insensitive volume, and that is now refused before the destination exists.
- CI gained a macOS job. Its default volume is both case-insensitive and
  normalising, so it is the only place the portability rules are exercised against a
  real filesystem rather than a constructed collision; the job first asserts those
  properties of the runner before relying on them.
- Integration tests gained a real Unicode round trip (composed, decomposed, CJK,
  emoji, RTL, zero-width joiner) and the case-collision restore refusal.

### Input robustness and selection cost

- `scripts/robustness.py`: structural fuzzing of the input boundary. 305 malformed
  snapshots and requests - wrong types, missing fields, absurd numbers, deep
  nesting, control characters, duplicate keys, hostile paths, unknown operations -
  must each produce exactly one JSON object and exit 0, 1 or 2. Wired into
  `verify.sh` and CI. No violations were found; the value is that the property is
  now checked rather than assumed.
- Fixed: selection matching was O(paths x files). 8000 paths against 8000 files took
  5.9 s and quadrupled when either side doubled, so a request well inside the 16 MiB
  cap could hang for minutes. Files are now matched through their component
  prefixes, which takes the same case to 0.69 s and grows with the tree. A test
  compares the new rule against the old definition on 121 prefix pairs and 13 paths,
  so the change is provably a speedup and not a semantic change.

### Long chains

- Fixed: adding a third large link to a chain failed with `input exceeds 16 MiB`.
  The declared-objects path audited the entire chain in one request, which is the
  one thing that cannot fit; three links of 8 MiB were enough to hit it. Each link
  is now verified in its own request, batched by the payload sizes its manifest
  already states. The integration test builds that exact chain and fails on the
  previous code.
- The adapter decides between the one-request and declared-objects paths from file
  sizes, so a chain that plainly will not fit is never read into memory first, and
  the fallback holds one link at a time.
- Measured and documented: peak memory is a small multiple of the tree because every
  exchange is one JSON document with base64 payloads. Streaming inside the adapter
  lowered the heap floor from 64-80 MiB to 56-64 MiB while being 16% slower and
  giving up the verify-before-write guarantee, so it was not shipped.

### Reading a chain that is larger than one request

- `locate` answers which link stores each payload using manifests only, so a
  request that carries a whole chain as manifests stays small.
- `extract` returns the payloads of one link, re-hashing each against its digest
  and re-encoding to the caller's `format`.
- `assemble` computes the canonical checksum of a manifest without payloads, and
  keeps only the four manifest fields so extra ones cannot change the checksum.
- Adapter: `restore` and `squash` fall back to those operations when the chain
  would not fit. Both verify the whole chain before creating anything. A 19 MB
  chain of three links restored and squashed successfully where a single request
  refused; the piecewise squash checksum equals the one-request result.
- Fixed: the declared-objects delta path stripped only the parent's payloads, so a
  third link in the chain pushed the request over the cap. Every link now travels
  as a manifest with its digests declared.

### Deltas over a large base

- `create` accepts `known_objects`, a list of digests the chain already stores,
  and a `previous` with no `objects` member. Together they let a delta be built
  without sending the parent's payloads, which lifts the ceiling the 16 MiB
  request cap put on incremental backups. The result is byte-identical to the
  full-parent delta.
- `statistics.base_verified` says whether the core could check the base. It is
  `false` for the declared-objects path rather than a claim of verification.
- A false declaration fails closed: `audit` reports `missing object` and
  `restore` refuses, so nothing is silently lost.
- Adapter: when a delta request would exceed the cap, it audits the chain in one
  request and sends the manifest-only parent in a second. A 7 MiB tree with one
  changed file now produces a 1267-byte delta (9.8 MB base) and restores
  verified; previously that delta was rejected outright.

### Retention and restore correctness

- `retention` no longer proposes deleting a snapshot that a kept snapshot's chain
  requires. Such a link is promoted into the new `required_snapshots` field, and a
  link with no listed identity is reported under `external_parents`. Previously a
  plan could say "keep the delta, drop its base", which left the kept snapshot
  unreadable while every object it needed was still present.
- `restore` passes a base64 payload straight through when the reader wants base64,
  instead of decoding it to verify and re-encoding it to return. Restore of an
  8 MiB snapshot: 1660 -> 1261 ms; 4 MiB 912 -> 696 ms.
- `scope` in the retention plan now describes what the plan actually covers.

This is a behaviour change for callers that read `drop_snapshots` alone: the field
is now narrower, and the identities removed from it appear in
`required_snapshots`.

### Verification

- `scripts/fuzz.py`: seeded differential test against an independent oracle
  covering `create`, `audit`, `restore`, `diff`, `squash`, `retention` and eight
  mutation classes, with reproducible seeds. Wired into `verify.sh` and CI.
- `restore` strips trailing separators from `paths`, so `--path docs/` selects
  `docs` instead of failing as unsafe; traversal and absolute paths are still
  refused.

### Chain management

- `squash` compacts a chain into one self-contained snapshot in any of the three
  formats, keeping every reachable object exactly once and dropping the rest.
  Without `format` the snapshot keeps its own. Squashing twice is a no-op, and
  squashing to format 2 equals creating the same tree directly, byte for byte.
- `restore` accepts `paths` and selects entries by whole component (`docs` covers
  `docs/a.md`, `doc` covers nothing), reporting `selected` and `total_files`. A
  path that matches nothing is an error, not a quiet partial restore.
- Adapter: `squash` and `restore --path` subcommands.

### Snapshot format 2

- Object payloads are base64 text instead of arrays of decimal byte values. A
  1 MiB incompressible file now produces a 1.33 MiB snapshot instead of
  3.57 MiB, and the same 1 MiB backup drops from 2396 ms to 649 ms on the
  reference host because the request no longer carries a million-element JSON
  array in either direction.
- `create` writes format 2 by default; `"format": 1` still produces the
  previous layout byte for byte. Format 1 snapshots remain readable by
  `audit`, `restore`, `diff` and `retention`, and a snapshot's version decides
  which payload encoding is accepted, so a decimal payload inside a format-2
  snapshot is reported as `invalid object encoding`.
- Requests accept `content_base64` alongside `text` and `bytes`; exactly one
  content form must be present.
- `restore` returns `format` and `encoding` (`base64` or `decimal`) and keeps
  the payload in the encoding it validated, so the adapter decodes with the
  matching call instead of re-expanding decimal arrays.
- `audit` reports `format`.
- `retention` counts decoded bytes, so byte totals stay correct for base64
  payloads, and snapshots of different formats can be planned together when the
  digests match.
- The host adapter sends base64 and raises its per-backup source cap from 1 MiB
  to 8 MiB (10.7 MiB of JSON for incompressible data, still inside the 16 MiB
  request cap). `SNAPVAULT_ADAPTER_LIMIT_BYTES` overrides the limit.

### Performance

- SHA-256 is implemented in `sha256.mbt` over whole 64-byte blocks with a reusable schedule: 61
  MiB/s instead of 21 MiB/s for the byte-at-a-time package that was used before, identical output.
- base64 is implemented in `base64.mbt`: encoding fills a byte array and decodes once, which takes
  8 MiB in 8 MiB numbers from 1445 ms to about 300 ms; decoding is ours as well.
- `scripts/engine.mjs` prefers a release build and falls back to debug; `MOON_BUILD` selects one.
- Through the adapter on the reference host, a 1 MiB incompressible backup went from 2396 ms to
  292 ms and restore from 2081 ms to 300 ms; 8 MiB backs up in 1387 ms and restores in 1523 ms.
  `scripts/bench.mjs` and `cmd/bench` reproduce the numbers.
- The module no longer depends on `gmlewis/sha256`; `moonbitlang/core` is the only dependency.

### Audit contract (also unreleased)

- `audit` verifies every stored object, referenced or not, and reports `objects_total`, `objects_checked`, `referenced_objects` and `unreferenced_objects`; `issues` entries now always carry `object` and use `path: null` when no file references the object.
- `audit`, `retention` and `restore` agree on the same snapshot: a corrupt unreferenced object is refused by all three, and `create(previous=…)` no longer under-counts `new_object_bytes` when the previous snapshot claims content it cannot prove.
- CLI: host-side failures (missing file, invalid UTF-8, oversize input) return the same `{"error": ...}` envelope as request errors with exit code 1; error text no longer exposes MoonBit type names.
- `restore` applies manifest permission bits with `chmod` and returns `modes_applied`; adapter refuses paths that collide after Unicode normalization/case folding before creating the destination, and warns when a backup is not portable.
- Path sorting in manifests and reports is lexicographic; previously MoonBit's shortlex `String::compare` ordered `c` before `b/x`.
- Public API: added `parse_value(StringView) -> Value raise`; `InputError` keeps `Show` (plain message) and moves to `derive(Eq, Debug)`; `moonbitlang/core/math` is no longer imported. Builds with zero warnings on moon 0.1.20261023.
- Added `scripts/verify.sh`, four audit-contract fixtures, six white-box tests, and CLI/audit oracles in `scripts/reference.py`.

## 0.2.0 — 2026-10-18

Registry version: 0.2.0.

新增 retention，对给定自包含快照及保留 ID 集合验证清单、引用对象和未引用对象，再计算共享对象可达性、可回收对象及字节数。默认保留所有给定快照；未知或重复保留 ID、损坏内容均拒绝。修复清单文件模式校验，避免重算校验和后夹带非法权限字段。
