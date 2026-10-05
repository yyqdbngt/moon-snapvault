# Implemented architecture

## Core

SHA-256 object identities; byte or UTF-8 text inputs; deduplicated content stores; manifest checksums; path/case/file-directory collision checks; incremental change reports and new-content statistics; full object integrity audits; verified restore plans. scripts/filesystem.mjs creates snapshots from real directories and restores real files.

## Boundaries

Each JSON snapshot is self contained, even when previous content is unchanged; new_object_bytes is a content statistic, not the physical archive size saved. The host adapter caps a backup at 1 MiB of source bytes; the core JSON CLI caps input at 16 MiB. Regular files only: no symlinks, empty-directory preservation, timestamps, ACLs or special files. Restore requires a new directory and validates all bytes first. A failed write retains the new partial directory for inspection. Designed for trusted local directories; concurrent hostile filesystem changes are not isolated. Manifests are integrity checked, not authenticated/encrypted.

## Integration

The core accepts semantic values and returns deterministic JSON-shaped reports. Host adapters handle files, network or processes; they invoke the compiled MoonBit engine. The CLI package declares `supported_targets = "js"`; other backends test the portable core.

## Validation evidence

Fixture cases are hand-checked assertions. Independent reference checks and integration scripts are runnable from a clean checkout. CI executes four core backends and host checks. Historical proposal targets are not release results.
