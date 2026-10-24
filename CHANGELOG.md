# Changelog

## Unreleased - audit contract

Not published to MoonCakes yet; `moon add` still resolves 0.2.0.

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
