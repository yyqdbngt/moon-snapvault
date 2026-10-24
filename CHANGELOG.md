# Changelog

## Unreleased - 0.3.0

Module version in `main` is 0.3.0; `moon add yyqdbngt/moon_snapvault` still
resolves the published 0.2.0 until a release is published.

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
