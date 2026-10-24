# Moon SnapVault

Content-addressed snapshots, implemented in MoonBit with a JSON CLI and reusable library API.

- Repository: [https://github.com/yyqdbngt/moon-snapvault](https://github.com/yyqdbngt/moon-snapvault)
- Published package: `yyqdbngt/moon_snapvault@0.2.0`
- Module in `main`: 0.3.0 (unreleased - see [the format note](#2026-10-24-format-2-and-audit-contract-unreleased))
- License: Apache-2.0
- Release scope: **0.2.0 is the published release**; `main` carries the unreleased 0.3.0 work described below. The broader competition proposal in `docs/proposal.md` is a reference design, not a claim that every planned capability is implemented.

## Implemented

SHA-256 object identities; byte, UTF-8 text or base64 inputs; deduplicated content stores; incremental snapshots that reference a parent chain instead of copying unchanged bytes, chain compaction and selective restore; manifest checksums; path/case/file-directory collision checks; incremental change reports and new-content statistics; object integrity audits that verify every stored object, referenced or not; verified restore plans that carry permission bits; retention reachability plans. Snapshots are written in the compact format 2, or as a format 3 delta when a previous snapshot is supplied; both older formats stay readable. `scripts/filesystem.mjs` creates snapshots from real directories and restores real files.

## Build and run

Use MoonBit (`moon` 0.1.20261012 or newer) and Node.js 24 for CI parity; Node.js 20.16+ works locally. The core library supports JS, wasm, wasm-gc and native; the filesystem/HTTP/process CLI is JS only.

```sh
moon update
moon build --target js --release   # the adapter prefers this build
moon run cmd/main --target js -- examples/scenario-1.json
node _build/js/release/build/cmd/main/main.js examples/incremental.json
```

[`examples/`](examples/README.md) holds one request per file covering every operation,
and `examples/expected/` holds the exact answer each one produces. Those files are
checked, so an example cannot quietly stop being true.

Pass `-` to read a UTF-8 JSON request from stdin. A single request must be at most 16 MiB. Successful requests print one JSON result. Every failure prints exactly one `{"error": "<message>"}` object on stdout and exits 1; usage errors exit 2. That contract also covers host-side failures (missing file, invalid UTF-8, oversize input), not just request validation, and it applies to both entry points: `scripts/filesystem.mjs` uses the same envelope and exit codes. The host runner is a separate process and does not edit the input request file.

## Library use

```sh
moon add yyqdbngt/moon_snapvault@0.2.0
```

In the consumer's `moon.pkg`:

```moonbit
import {
  "yyqdbngt/moon_snapvault" @engine,
  "moonbitlang/core/json",
}
```

```moonbit
fn example(request : Json) -> Json raise {
  @engine.execute(request)
}
```

Every exported function raises `InputError`, so a `main` that calls one must be
declared `fn main raise` (or catch it):

```moonbit
fn main raise {
  let snapshot = @engine.create_snapshot(files)
  println(@engine.Value::stringify(snapshot))
}
```

`execute(Json) -> Json raise` is the standard JSON boundary. `from_json`, `parse_value`, `Value::to_json`, and `run(Value) -> Value raise` provide a typed semantic value interface. Object ordering is not significant; numeric values use finite Double. Public domain functions are listed in `pkg.generated.mbti`.

## Tests

```sh
sh scripts/verify.sh          # four backends plus every host check
SKIP_NATIVE=1 sh scripts/verify.sh
```

`scripts/verify.sh` runs the ladder below. Native builds need a C compiler; when `cc` is shadowed by a wrapper script, set `MOON_CC` to a real compiler.

```sh
moon test --target js
moon test --target wasm
moon test --target wasm-gc
moon test --target native  # requires a C compiler
# CI also runs the host checks on macOS, whose default volume is case-insensitive
# and Unicode-normalising: that is where the path portability rules are exercised.
moon build --target js
node scripts/check.mjs
python -B scripts/reference.py
python -B scripts/followup_reference.py
python -B scripts/delta_reference.py
python -B scripts/fuzz.py 8
python -B scripts/robustness.py
python -B scripts/mutation_sweep.py
python -B scripts/workflow.py
node scripts/bench-smoke.mjs
python -B scripts/docs.py
node scripts/doc-commands.mjs
node scripts/coverage.mjs
node scripts/cli-contract.mjs
node scripts/compat.mjs
node scripts/examples.mjs
node scripts/durability.mjs
node scripts/stats.mjs
node scripts/interface.mjs
node scripts/consumer-smoke.mjs
node scripts/integration.mjs
moon fmt --check
```

There are 116 MoonBit test declarations and 79 checked fixture cases in `tests/cases.json`. Both are hand written: the fixtures run through the actual Node CLI in `scripts/check.mjs`, and matching white-box tests assert the same inputs in `*_wbtest.mbt`. Independent references use Python's standard library (`hashlib`, `base64`) or separately written chain and reachability logic. `scripts/fuzz.py` goes further: it generates seeded random trees and chains, recomputes every expected value from the snapshot JSON alone, and compares `create`, `audit`, `restore`, `diff`, `squash` and `retention` against that oracle, including a set of deliberate mutations whose verdict it predicts independently. `scripts/robustness.py` goes the other way and feeds structurally malformed snapshots and requests, asserting that each still yields exactly one JSON object and a clean exit rather than a crash or a hang. `scripts/mutation_sweep.py` mutates every field of a valid snapshot in turn and predicts what `audit` must conclude for each of the 197 results. Fixtures are synthetic and are not presented as production adoption evidence. See [input and output examples](docs/usage.md) and [current boundaries](docs/boundaries.md).

## Current boundaries

Each JSON snapshot is self contained, even when previous content is unchanged; `new_object_bytes` is a content statistic, not the physical archive size saved. Format 2 stores object bytes as base64, so a 1 MiB incompressible file becomes about 1.33 MiB of JSON (format 1 needed 3.6 MiB). The host adapter caps a backup at 8 MiB of source bytes by default, overridable with `SNAPVAULT_ADAPTER_LIMIT_BYTES`; the core JSON CLI caps input at 16 MiB. Regular files only: no symlinks, empty-directory preservation, timestamps, ACLs or special files, and a refusal names the entry it refused. Restore requires a new directory and validates all bytes first. Mode bits are applied with `chmod` after each write, so the process umask cannot clear them. Names that collide only after Unicode normalization or case folding, or that a platform cannot hold at all (Windows device names, `<>|?*`, a trailing dot), are rejected by the adapter before the destination is created; the core deliberately accepts such snapshots, because whether a name is usable depends on the destination filesystem, not on the data. A component longer than 255 bytes is refused by the core itself, since no supported filesystem can hold one. A failed write retains the new partial directory for inspection, and the error names the file it stopped at, so everything before it is complete and that file is truncated. Backup and restore both sync to disk before reporting success, so `verified` survives a power cut; `SNAPVAULT_NO_FSYNC=1` trades that for speed on a scratch copy and reports `durable: false`. Concurrent writers to the same snapshot path or restore destination are serialised by an exclusive create: one wins, the others are refused by name. Audits cover every stored object, so `create` with a `previous` snapshot and `restore` both pay for a full verification of that snapshot. Designed for trusted local directories; concurrent hostile filesystem changes are not isolated. Manifests are integrity checked, not authenticated/encrypted.

See [source and dependency attribution](THIRD_PARTY.md). This release does not establish competition eligibility or organizer acceptance.

## 2026-10-18 follow-up

新增 retention，对给定自包含快照及保留 ID 集合验证清单、引用对象和未引用对象，再计算共享对象可达性、可回收对象及字节数。默认保留所有给定快照；未知或重复保留 ID、损坏内容均拒绝。修复清单文件模式校验，避免重算校验和后夹带非法权限字段。

只生成计划，不删除任何文件。可回收范围仅限输入中提供的对象，不包含未提供的外部仓库；自包含快照的逻辑对象统计不等同于实际磁盘节省量，宿主备份的 1 MiB 上限仍保留。

Repository release: 0.2.0; published MoonCakes module: `yyqdbngt/moon_snapvault@0.2.0`. Earlier repository 1.0.0 labels are retained as history; the module uses the registry-compatible zero-major sequence.

## 2026-10-24 incremental snapshots (unreleased)

Format 3 lets a snapshot name the one it builds on and store only the payloads
the chain lacks. The manifest stays complete, so `diff` and `audit` still describe
the tree without walking the chain, and `parent` is bound into the checksum so a
delta cannot be re-pointed at a different base.

```sh
node scripts/filesystem.mjs backup  SOURCE current.json previous.json      # delta
node scripts/filesystem.mjs restore current.json DEST previous.json        # needs the chain
node scripts/filesystem.mjs restore current.json DEST --path docs          # subset only
node scripts/filesystem.mjs squash  current.json compact.json previous.json # fold the chain
```

A chain too large for one request is read through `locate` and `extract`, one link
at a time; the adapter does that automatically, so restore and squash work on any
chain size that fits in memory.

`squash` folds a chain into one self-contained snapshot, keeping each reachable
object once and dropping unreferenced ones; squashing to format 2 produces a file
byte-identical to creating the same tree directly.

A 3 MiB tree with one changed file: base snapshot 4.1 MB and 647 ms, delta 752 B
and 702 ms - 0.02% of the base on disk, but priced like a full backup in time
because the base is re-verified before the delta is written. A 7 MiB tree works
too: the adapter audits the chain in one request and sends a manifest-only parent
in a second, so the delta no longer has to carry the base's payloads. Reading a delta
without its chain fails with `missing parent snapshot` naming the checksum.
See `docs/incremental.md`.

## 2026-10-24 format 2 and audit contract (unreleased)

Snapshots are written as `"version": 2` with base64 object payloads. `"format": 1` still produces the old decimal layout, and both versions stay readable by `audit`, `restore`, `diff` and `retention`; a snapshot's version decides which payload encoding is accepted. `restore` reports `format` and `encoding`, and requests accept `content_base64` next to `text` and `bytes`.

Measured on the reference host (moon 0.1.20261023, Node 20, release build, fastest of five runs): 1 MiB incompressible file backs up in 296 ms and restores in 261 ms, snapshot 1.33 MiB. 8 MiB backs up in 1.42 s and restores in 1.30 s. Those figures include the `fsync` that makes a restore survive a power cut; with `SNAPVAULT_NO_FSYNC=1` the same runs are 3-5% faster, which is inside this host's noise. `scripts/perf-check.mjs` fails if any of them regresses by a factor of two. SHA-256 and base64 are implemented in this module now, at 61 MiB/s and about 300 ms per 8 MiB respectively. See `docs/snapshot-format.md` and `node scripts/bench.mjs`.

`audit` now verifies every stored object, referenced or not, and reports `objects_total`, `objects_checked`, `referenced_objects` and `unreferenced_objects`. Before this revision `audit` accepted a snapshot whose unreferenced object did not match its key, while `retention` refused the same bytes and `create(previous=…)` under-counted `new_object_bytes`. The three operations now agree.

The CLI reports host-side failures through the same JSON error envelope as request errors, restore applies permission bits with `chmod` so the umask cannot clear them, and the adapter refuses names that collide after Unicode normalization or case folding before it creates the destination directory. Path sorting is lexicographic (`StringView::lexical_compare`) instead of MoonBit's shortlex `String::compare`.

`moon build --target js` completes with zero warnings on moon 0.1.20261023. See `docs/audit-contract-20261024.md` for the evidence and `CHANGELOG.md` for the version note. These changes are not published to MoonCakes yet; `moon add` still resolves 0.2.0.
