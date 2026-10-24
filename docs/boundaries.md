# Version 0.3.0 boundaries

Each JSON snapshot is self contained, even when previous content is unchanged; `new_object_bytes` is a content statistic, not the physical archive size saved. Format 2 stores object bytes as base64 and format 1 as decimal numbers, so a 1 MiB random file produces roughly 1.33 MiB or 3.57 MiB of JSON respectively. Both are read; `create` writes format 2 by default.

The host adapter caps a backup at 8 MiB of source bytes by default (`SNAPVAULT_ADAPTER_LIMIT_BYTES` overrides it); the core JSON CLI caps input at 16 MiB. Regular files only: no symlinks, empty-directory preservation, timestamps, ACLs or special files.

Audits cover every stored object, referenced or not, and cross-check each key against its SHA-256. `valid` therefore means "this snapshot's bytes are internally consistent", not "this snapshot is authentic": manifests are integrity checked, not authenticated or encrypted.

A format 3 delta stores only the payloads its chain lacks, but its manifest is
still complete, so the snapshot describes its tree without the chain. Reading a
delta needs every link: `audit`, `restore` and `retention` take the chain as a
list, match it by checksum, verify every link, and walk at most 64 links. A
missing link is reported as `missing parent snapshot`; a cycle is refused.

`squash` folds a chain into one self-contained snapshot and drops objects no file
references; it is the only way this project frees space, and `retention` still
only plans. `restore` takes an optional `paths` selection that must match at
least one file.

`restore` requires a new directory and validates every byte before writing. It applies permission bits with `chmod` after each write, so the process umask cannot clear them, and it reports `modes_applied`. On a case-insensitive or normalization-applying filesystem, names that differ only by Unicode case or normalization form cannot both exist; the adapter detects those collisions and refuses before creating the destination instead of failing halfway. A failed write retains the new partial directory for inspection.

Audits are all-object, so `create` with a `previous` snapshot and `restore` both pay for a full verification of that snapshot; hashing runs at about 61 MiB/s in this implementation. The adapter is designed for trusted local directories; concurrent hostile filesystem changes are not isolated. `retention` only plans: it never deletes files, and its reclaimable set is limited to the objects supplied in the request.
