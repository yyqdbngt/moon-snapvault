# 0.3.0 release notes

Not yet tagged or published. This document is the release note that will be used when it is,
written now so that publishing is a decision rather than a task.

The published version is 0.2.0. `moon add yyqdbngt/moon_snapvault@0.2.0` resolves it, and
`@0.3.0` will not resolve until the package is published.

## Who is affected

| You use | Impact |
|---|---|
| The library, through `run` or `execute` with JSON requests | Some requests that used to be accepted are now refused; see the next section |
| The library, calling `create_snapshot` directly | One call shape that 0.2.0 accepted is now refused |
| `scripts/filesystem.mjs` as a command | Error output moved from stderr to stdout, and usage errors now exit 2 |
| Snapshots written by 0.2.0 | Still readable, byte for byte; nothing to migrate |
| Snapshots you write from now on | Some shapes 0.2.0 wrote are now refused when read back, if they held unreferenced objects |

## Breaking changes, with what to do

### 1. A format 2 snapshot can no longer be passed as `previous`

0.2.0 accepted `create_snapshot(files, previous=someFormat2Snapshot)` and used it only to fill
in the statistics. That combination is now refused with `a parent chain requires format 3`,
because a parent now means a real chain and only format 3 carries one.

```moonbit
// 0.2.0: accepted, statistics only
let next = @vault.create_snapshot(files, previous=old)

// 0.3.0: ask for format 3 and pass the parent as usual
let base = @vault.create_snapshot(files, format=3)
let next = @vault.create_snapshot(files, previous=base)
```

If you only wanted the change report, use `diff_snapshots(old, new)` on the two snapshots
instead - it takes no chain and returns the same added/removed/modified lists.

`scripts/consumer-smoke.mjs` asserts this refusal, so it cannot regress into an acceptance by
accident.

### 2. `audit` verifies every stored object, not only referenced ones

A snapshot holding an object that no file references, and whose key does not match its bytes,
used to audit clean. It is now reported as `digest mismatch`, `audit` returns `valid: false`,
and `retention` and `restore` refuse that snapshot.

Before 0.3.0 the three disagreed: `audit` said valid, `retention` refused, and
`create(previous=...)` under-counted `new_object_bytes` because it believed a fake object was
already stored.

**What to do:** if a pre-0.3.0 snapshot now audits invalid, its unreferenced objects are
damaged. The files it names are still intact and can be restored by removing the offending
objects from `objects` - they are, by definition, not referenced. There is no tool command for
that; it is a small edit to the JSON.

### 3. `drop_snapshots` is narrower

`retention` no longer proposes dropping a snapshot that a kept snapshot's chain needs. Those
links are reported in `required_snapshots` instead. A caller that took `drop_snapshots` as the
complete list of reclaimable snapshots now sees fewer entries, and that is the correction: the
older behaviour made a kept delta unreadable.

**What to do:** nothing, if you only deleted what the plan named. If you relied on
`drop_snapshots` being exhaustive, check `required_snapshots` too. To genuinely retire a parent,
`squash` its child first.

### 4. Error output moved from stderr to stdout

`scripts/filesystem.mjs` printed failures as free text on stderr. It now prints
`{"error": "..."}` on stdout, with exit 2 for usage mistakes - the contract the core CLI always
had. A script that captured stderr now sees nothing there.

```sh
# before
node scripts/filesystem.mjs restore missing.json out 2>error.txt
# after
node scripts/filesystem.mjs restore missing.json out >error.json
```

### 5. Error messages are reasons, not Node errors

`{"error":"ENOENT: no such file or directory, open '/x/y.json'"}` is now
`{"error":"the file does not exist"}`. The path you typed is not echoed back, and no errno
appears. If you matched on message text, match on the new wording; the full list is in
`docs/usage.md`.

### 6. `InputError::to_string` renders the message alone

It used to render the constructor, `InputError("unsafe source path")`. Code that logged it
verbatim sees a shorter string.

```moonbit
@vault.InputError("x").to_string()  // was: InputError("x")  now: x
```

## Additions

None of these change existing behaviour.

- **Format 2** stores payloads as base64. A 1 MiB incompressible file becomes 1.33 MiB of JSON
  instead of 3.57 MiB. Format 1 keeps the decimal layout, and both stay readable.
- **Format 3** adds a parent chain, so a delta stores only the objects its parent lacks. A
  three-link chain of 8 MiB snapshots restores correctly.
- **`squash`** folds a chain into one self-contained snapshot.
- **Selective restore**: `restore` takes `paths`, and `--path` on the command line.
- **`locate`**, **`extract`**, **`assemble`**: read a chain one link at a time, so a chain larger
  than the 16 MiB request limit can still be restored and compacted.
- **`known_objects`**: pass a manifest-only parent plus the digests it holds, instead of the
  parent's payloads.
- **`durable`** and **`modes_exact`** in restore results, plus `SNAPVAULT_NO_FSYNC=1`.
- **`parse_value`** is now public.

## What the numbers mean

`scripts/perf-check.mjs` compares backup and restore at 1 MiB and 8 MiB against a recorded
baseline per platform and fails at a factor of two. The figures in `README.md` are the fastest
of five runs on the reference host.

## Verification

`sh scripts/verify.sh` runs the whole ladder: four backends of tests, the fixture suite, seven
independent Python oracles, structural robustness, a mutation sweep, coverage gate, per-platform
performance gate, the CLI contract, the published-0.2.0 compatibility check, documentation
checks, and the integration suite. GitHub Actions runs it on Linux, macOS and Windows.

## Known limits

- Restore holds the whole chain in memory. Segmenting it lifts the request-size limit, not the
  memory one; a genuinely bounded restore needs the core to emit payloads incrementally, which
  is a protocol change and not in this release.
- Windows cannot represent Unix permission bits, so `restore` reports `modes_exact: false`
  there.
- Manifests are integrity checked, not authenticated. A checksum mismatch is detected; a
  deliberate forgery by someone who can rewrite the file is not.
- The adapter is written for trusted local directories. A source tree that changes while it is
  being read can still produce a snapshot of a state that never existed as a whole.
