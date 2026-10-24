# Implemented architecture

## Core

SHA-256 object identities; byte, UTF-8 text or base64 inputs; deduplicated content stores; manifest checksums; path/case/file-directory collision checks; incremental change reports and new-content statistics; object integrity audits covering every stored object; verified restore plans that carry permission bits; retention reachability plans. Snapshots are written as format 2 (base64 payloads) and format 1 (decimal payloads) stays readable; see `docs/snapshot-format.md`. `scripts/filesystem.mjs` creates snapshots from real directories and restores real files.

## Boundaries

See `docs/boundaries.md`. In short: snapshots are self contained, the host adapter caps a backup at 1 MiB of source bytes, the core CLI caps input at 16 MiB, regular files only, restore needs a new directory, audits cover all objects, and manifests are integrity checked but not authenticated.

## Integration

The core accepts semantic values and returns deterministic JSON-shaped reports. Host adapters handle files, network or processes; they invoke the compiled MoonBit engine. The CLI package declares `supported_targets = "js"`; other backends test the portable core.

## Validation evidence

Fixture cases are hand-checked assertions, run through the real Node CLI. Independent reference checks and integration scripts are runnable from a clean checkout: `sh scripts/verify.sh` executes four backends plus every host check. CI executes the same ladder. Historical proposal targets are not release results.
