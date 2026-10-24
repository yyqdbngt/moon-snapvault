# Source and verification statistics

Snapshot date: 2026-10-24. Module version: 0.2.0 (published); `main` carries the unreleased audit-contract revision.

| Category | Count |
|---|---:|
| Owned production MoonBit physical lines (root + CLI) | 724 |
| Nonblank, non-comment production lines | 624 |
| MoonBit test declarations | 19 |
| CLI fixture cases | 18 |
| Generated fixture test declarations | 0 |

Dependencies, tests, examples, documentation and build outputs are excluded from the production line count. Test declarations are hand written and executable counts, not a claim of that many independent requirements. `tests/cases.json` fixtures are executed by `scripts/check.mjs` through the compiled CLI; the white-box tests assert the same inputs directly. CI and installed-package evidence are recorded separately after validation. Original planning line-count ranges are not completion results.
