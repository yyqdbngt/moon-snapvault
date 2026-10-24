# Source and verification statistics

Snapshot date: 2026-10-24. Module version: 0.3.0 in `main`; the published module is still 0.2.0.

| Category | Count |
|---|---:|
| Owned production MoonBit physical lines (root + CLI + codec) | 1943 |
| Nonblank, non-comment production lines | 1598 |
| MoonBit test declarations | 87 |
| CLI fixture cases | 69 |
| Generated fixture test declarations | 0 |

These numbers are checked by `node scripts/stats.mjs`, which recounts the same files and fails if
this table disagrees; `scripts/verify.sh` runs it. Update the table deliberately with
`node scripts/stats.mjs --write` rather than by hand.

The codec column covers `sha256.mbt` and `base64.mbt`, which are project code: the module has no
runtime dependency outside `moonbitlang/core`. Dependencies, tests, examples, documentation and
build outputs are excluded from the production line count. Test declarations are hand written and executable counts, not a claim of that many independent requirements. `tests/cases.json` fixtures are executed by `scripts/check.mjs` through the compiled CLI; the white-box tests assert the same inputs directly. CI and installed-package evidence are recorded separately after validation. Original planning line-count ranges are not completion results.
