# Moon SnapVault

Content-addressed snapshots, implemented in MoonBit with a JSON CLI and reusable library API.

- Repository: [https://github.com/yyqdbngt/moon-snapvault](https://github.com/yyqdbngt/moon-snapvault)
- Package: `yyqdbngt/moon_snapvault@0.1.0`
- License: Apache-2.0
- Release scope: **0.1.0 initial implementation**. The broader competition proposal in `docs/proposal.md` is a reference design, not a claim that every planned capability is implemented.

## Implemented

SHA-256 object identities; byte or UTF-8 text inputs; deduplicated content stores; manifest checksums; path/case/file-directory collision checks; incremental change reports and new-content statistics; full object integrity audits; verified restore plans. scripts/filesystem.mjs creates snapshots from real directories and restores real files.

## Build and run

Use MoonBit and Node.js 24. The core library supports JS, wasm, wasm-gc and native; the filesystem/HTTP/process CLI is JS only.

```sh
moon update
moon build --target js
moon run cmd/main --target js -- examples/scenario-1.json
node _build/js/debug/build/cmd/main/main.js examples/scenario-1.json
```

Pass `-` to read a UTF-8 JSON request from stdin. A single request must be at most 16 MiB. Successful requests print one JSON result; invalid requests exit nonzero. The host runner is a separate process and does not edit the input request file.

## Library use

```sh
moon add yyqdbngt/moon_snapvault@0.1.0
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

`execute(Json) -> Json raise` is the standard JSON boundary. `from_json`, `Value::to_json`, and `run(Value) -> Value raise` provide a typed semantic value interface. Object ordering is not significant; numeric values use finite Double. Public domain functions are listed in `pkg.generated.mbti`.

## Tests

```sh
moon test --target js
moon test --target wasm
moon test --target wasm-gc
moon test --target native  # requires a C compiler
moon build --target js
node scripts/check.mjs
python -B scripts/reference.py

node scripts/integration.mjs
```

There are 9 checked fixture cases in `tests/cases.json`, executed both in MoonBit white-box tests and through the actual Node CLI. Independent reference checks use Python's standard library or separately written algorithms. Fixtures are synthetic and are not presented as production adoption evidence. See [input and output examples](docs/usage.md) and [current boundaries](docs/boundaries.md).

## Current boundaries

Each JSON snapshot is self contained, even when previous content is unchanged; new_object_bytes is a content statistic, not the physical archive size saved. The host adapter caps a backup at 1 MiB of source bytes; the core JSON CLI caps input at 16 MiB. Regular files only: no symlinks, empty-directory preservation, timestamps, ACLs or special files. Restore requires a new directory and validates all bytes first. A failed write retains the new partial directory for inspection. Designed for trusted local directories; concurrent hostile filesystem changes are not isolated. Manifests are integrity checked, not authenticated/encrypted.

See [source and dependency attribution](THIRD_PARTY.md). This release does not establish competition eligibility or organizer acceptance.
