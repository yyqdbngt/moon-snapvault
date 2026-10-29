# Request and result guide

Every example below is an executable fixture. Assertions cover the listed result fields; additional output fields are documented by the API and other fixtures. Error cases intentionally reject the request.

## Exit codes and the error contract

| Situation | stdout | exit code |
|---|---|---:|
| Valid request | one JSON result | 0 |
| Invalid request, missing file, invalid UTF-8, input over 16 MiB | `{"error": "<message>"}` | 1 |
| Wrong number of arguments | usage line | 2 |

The contract is the same for every failure, including host-side ones, so a caller can always parse stdout as JSON - and it holds for both entry points. `scripts/filesystem.mjs`, which works on real directories, used to print a bare reason on stderr and exit 1 for a usage mistake; it now uses the same envelope and the same codes, because a caller shelling out to both should not parse two shapes from two streams. `scripts/cli-contract.mjs` asserts this over both.

Messages are the plain reason (`unsafe source path`, `manifest checksum mismatch`); they do not expose MoonBit type names, errno codes or the path the caller just typed. A missing input file reads `the file does not exist`, not `ENOENT: no such file or directory, open '/x/y.json'`.

## Snapshot formats

`create` writes format 2 unless the request says `"format": 1`.

| Request | Result |
|---|---|
| `{"files": [{"path": "a", "text": "abc"}]}` | `"version": 2`, object stored as `"YWJj"` |
| `{"files": [{"path": "a", "text": "abc"}], "format": 1}` | `"version": 1`, object stored as `[97, 98, 99]` |
| `{"files": [{"path": "a", "content_base64": "YWJj"}]}` | identical object to the `text` form |
| `{"files": [{"path": "a", "text": "x", "content_base64": "eA=="}]}` | error: exactly one content form |

`restore` echoes the format and encoding it validated:

```json
{"format": 2, "encoding": "base64", "verified": true,
 "files": [{"path": "a", "digest": "...", "size": 3, "mode": 420, "bytes": "YWJj"}]}
```

The core keeps the payload in its stored encoding; `scripts/filesystem.mjs` turns
`base64` into a buffer directly and only expands `decimal` arrays for format 1
snapshots. The format and its compatibility rules are described in
[snapshot format](snapshot-format.md).

## Comparing two snapshots

`diff` compares manifests only, so it works between any two snapshots whatever
format or chain they belong to. Paths are compared exactly; a file whose digest,
size or mode differs counts as modified.

| Request | Result |
|---|---|
| `{"operation": "diff", "old": <snapshot>, "new": <snapshot>}` | `added`, `removed`, `modified`, each sorted |
| `{"operation": "diff", "old": s, "new": s}` | three empty lists |

Both snapshots are validated first, so a broken checksum is an error rather than a
misleading comparison.

## Reading a chain in pieces

| Request | Result |
|---|---|
| `{"operation": "locate", "snapshot": <manifest-only>, "parents": [...]}` | `files[i].link` names the snapshot holding that payload |
| `{"operation": "locate", ..., "paths": ["docs"]}` | the same, limited to the selection |
| `{"operation": "extract", "snapshot": <one link>, "digests": [...]}` | those payloads, `verified: true` |
| `{"operation": "extract", ..., "format": 2}` | the same payloads re-encoded |
| `{"operation": "assemble", "files": [...], "format": 3}` | the canonical `checksum` for a manifest |

`locate` reports `missing_parent` and `unresolved` instead of raising; `extract`
raises on a digest it does not hold or one whose payload does not match.

On the command line the flag repeats: `restore SNAPSHOT DEST --path docs --path src`.
It does not take several values after one flag, because the arguments after it are where
parent snapshots go.

## Authenticating a snapshot

A manifest checksum needs no secret: anyone who rewrites a snapshot can recompute
it. `create` accepts a `key` (1..1024 bytes) and stores an authentication block
that no one without the key can forge:

| Field | Meaning |
|---|---|
| key | the create/audit/restore request field, 1..1024 bytes |
| auth | the block create writes: `{"scheme": "hmac-sha256", "hmac": <hex>}` |
| auth/scheme | always `hmac-sha256`; anything else is refused |
| auth/hmac | HMAC-SHA256 (RFC 2104) over exactly the bytes the checksum covers |
| authenticated | audit report: `true` verified with the key, `false` a mismatch, `null` nothing to verify or no key supplied |

`audit` and `restore` accept the same `key`. A mismatch is an issue
(`authentication failed`), makes `audit` return `valid: false`, and makes
`restore` refuse before writing anything. Every link of a chain that carries a
block is verified with the key, and one failing link fails the chain. Auditing
without a key still checks integrity and reports `authenticated: null` - the
report says what was verified and what was not, rather than pretending.

The block is written after the checksum and is not part of what it authenticates,
so readers from before the field existed ignore it and keep working.

## Listing a snapshot's tree

```json
{
  "operation": "list",
  "snapshot": {"version": 2, "files": [], "objects": {}, "checksum": "..."}
}
```

`list` verifies the manifest checksum and structure, then reports the tree. It
reads no payload and walks no chain: a format 3 manifest is complete, so listing
a delta needs no parents. That is what makes it affordable where `audit` is not.

| Field | Meaning |
|---|---|
| format | the snapshot's format (1, 2 or 3) |
| parent | the parent checksum of a format 3 delta, else null |
| files | every selected entry - path, size, mode, digest - in manifest order |
| selected | how many entries the selection kept |
| total_files | entries in the whole manifest |
| total_bytes | the summed size of the listed entries |

`paths` selects by the same whole-component rule as restore, and a selection
that matches nothing is an error naming the path, not a quiet empty list. A
checksum mismatch raises `manifest checksum mismatch` instead of listing
anything, so a successful list is a statement that the manifest is intact.

## Retention plan fields

| Field | Meaning |
|---|---|
| `keep_snapshots` | the identities the request asked to keep |
| `required_snapshots` | identities promoted because a kept snapshot's chain names them |
| `external_parents` | chain links a kept snapshot needs that the request did not list |
| `drop_snapshots` | identities that are neither kept nor required |
| `reachable_objects` | objects referenced by any surviving snapshot |
| `collectible_objects` | objects no surviving snapshot references |
| `live_bytes` | bytes held by the reachable objects, counted once each |
| `collectible_bytes` | bytes held by the collectible objects, counted once each |
| `stranded_objects` | objects no surviving file references that are stored inside a snapshot this plan keeps |
| `stranded_bytes` | bytes held by the stranded objects, counted once each |
| `plan_only` | always `true`: the plan describes deletions and performs none |
| `scope` | what the byte counts cover, as a sentence, so a reader need not infer it |

`collectible` means freed by deleting the snapshots named in `drop_snapshots`, which is not the
same as "no surviving file references it". An object nothing points at can still be stored inside
a snapshot the plan keeps, and deleting snapshots does nothing for it - it is reported as
`stranded` instead, and `squash` is what drops it, because squashing rebuilds the manifest from the
files it lists. The three buckets partition the stored objects, so every byte has exactly one
action: keep it, delete the named snapshots, or squash the snapshot holding it.

Keeping a delta keeps its parent: deleting the parent leaves the delta's manifest
pointing at a checksum nothing provides, and `restore` then fails even though
every object still exists. The plan promotes the parent rather than proposing that
deletion, and `squash` is how a chain is genuinely shortened.

## Incremental snapshots

`create` with a `previous` snapshot writes a format 3 delta that stores only the
objects the chain lacks; the manifest still lists every path.

| Request | Result |
|---|---|
| `{"format": 3, "previous": <base>, "files": [...]}` | delta: `parent` set, `objects` holds only new payloads |
| `{"format": 3, "files": [...]}` | self-contained format 3, `"parent": null` |
| `{"format": 2, "previous": <base>, "files": [...]}` | error: a parent chain needs format 3 |
| `{"operation": "audit", "snapshot": <delta>, "parents": [<base>]}` | `chain_depth: 2`, `objects_inherited` |
| `{"operation": "audit", "snapshot": <delta>}` | `valid: false`, `missing parent snapshot` |
| `{"operation": "restore", "snapshot": <delta>, "parents": [<base>]}` | payload resolved through the chain |
| `{"operation": "restore", "snapshot": <delta>}` | error: cannot restore corrupted snapshot |

| `{"operation": "squash", "snapshot": <delta>, "parents": [<base>]}` | self-contained snapshot, `parent: null` |
| `{"operation": "squash", ..., "format": 2}` | same, re-encoded as format 2 |

Omitting `format` keeps the format the snapshot already has, so the result is the same
snapshot with the chain folded in and its checksum unchanged. `filesystem.mjs squash`
follows the same rule: `--format` converts only when it is given by name. It used to
default to 3, which turned a format 2 snapshot into a different one.
| `{"operation": "restore", ..., "paths": ["docs"]}` | only `docs` and below, `selected`/`total_files` |
| `{"operation": "restore", ..., "paths": ["nope"]}` | error: `restore path not found in snapshot` |

| `{"format": 3, "previous": <manifest-only>, "known_objects": [...]}` | same delta without the parent payloads; reports `base_verified: false` |
| `{"format": 3, "previous": <manifest-only>, "files": [...]}` | error: the digests have to be declared |
| `{"format": 3, "files": [...], "known_objects": [...]}` | error: declared digests need a parent to point at |

`parents` may be supplied in any order; links are matched by checksum. See
[incremental snapshots](incremental.md).

## Audit report fields

`{"operation": "audit", "snapshot": ...}` verifies every stored object, referenced or not.

| Field | Meaning |
|---|---|
| `valid` | no issue was found in this snapshot's bytes |
| `issues` | list of `{path, object, reason}`; `path` is `null` when no file references the object |
| `format` | snapshot format version that was validated |
| `parent` | checksum of the parent snapshot, or `null` |
| `chain_depth` | links walked, this snapshot counted first |
| `objects_inherited` | unique objects supplied by ancestors |
| `files` | number of manifest entries |
| `objects_total` | number of stored objects |
| `objects_checked` | objects whose bytes were decoded and hashed |
| `referenced_objects` | objects reachable from the manifest |
| `unreferenced_objects` | stored objects no manifest entry references |

`{path: "a", object: "<sha256>", reason: "digest mismatch"}` is what a corrupt unreferenced object looks like. `retention` refuses the same snapshot, and `restore` will not write it.

## Restore result fields

`{"operation": "restore", "snapshot": ...}` returns `format`, `encoding`, `files` (each with `path`, `digest`, `size`, `mode` and `bytes`), `selected`, `total_files` and `verified: true`; the filesystem adapter adds `modes_applied`. The core operation only plans the restore; `scripts/filesystem.mjs` writes the files and applies `mode` with `chmod`.

## SHA256 known vector

```json
{
  "files": [
    {
      "path": "hello.txt",
      "text": "abc"
    }
  ]
}
```

Expected result fields:

```json
{
  "snapshot/files/0/digest": "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  "statistics/total_bytes": 3
}
```

## content deduplication

```json
{
  "files": [
    {
      "path": "a",
      "text": "abc"
    },
    {
      "path": "b",
      "text": "abc"
    }
  ]
}
```

Expected result fields:

```json
{
  "statistics/unique_bytes": 3,
  "statistics/deduplicated_bytes": 3
}
```

## binary zeros

```json
{
  "files": [
    {
      "path": "zero.bin",
      "bytes": [
        0,
        255,
        0
      ]
    }
  ]
}
```

Expected result fields:

```json
{
  "statistics/total_bytes": 3
}
```

## unsafe path ../escape

```json
{
  "files": [
    {
      "path": "../escape",
      "text": "x"
    }
  ]
}
```

Expected: nonzero exit with an input error.

## unsafe path CON.txt

```json
{
  "files": [
    {
      "path": "CON.txt",
      "text": "x"
    }
  ]
}
```

Expected fields:

```json
{
  "snapshot/version": 2
}
```

`CON.txt` is a device name on Windows and an ordinary file everywhere else, so the core records it:
a snapshot of a Linux tree holding that name is a faithful record, and refusing it would make such
a tree unbackupable. The refusal belongs to the writer, which knows the destination - `backup`
warns, and `restore` on Windows rejects it before creating the directory. This section used to say
the core refused it, which was the behaviour before that separation.

## unsafe path a//b

```json
{
  "files": [
    {
      "path": "a//b",
      "text": "x"
    }
  ]
}
```

Expected: nonzero exit with an input error.

## unsafe path C:/x

```json
{
  "files": [
    {
      "path": "C:/x",
      "text": "x"
    }
  ]
}
```

Expected: nonzero exit with an input error.

## unsafe path a/../b

```json
{
  "files": [
    {
      "path": "a/../b",
      "text": "x"
    }
  ]
}
```

Expected: nonzero exit with an input error.

## case collision

```json
{
  "files": [
    {
      "path": "A",
      "text": "x"
    },
    {
      "path": "a",
      "text": "y"
    }
  ]
}
```

Expected fields:

```json
{
  "snapshot/version": 2
}
```

The core accepts this and records both names, because on a case-sensitive filesystem they are two
distinct files and a snapshot is a faithful record of what was there. Whether a tree can be
restored depends on the target volume, which the core does not know about, so the refusal belongs
to the writer: `scripts/filesystem.mjs restore` rejects it before creating the destination, and
`backup` warns without refusing. This section used to say the core refused it, which was true
before that separation and wrong after it.

## Host adapter

```sh
node scripts/filesystem.mjs backup SOURCE_DIR NEW_SNAPSHOT.json [PREVIOUS.json]
node scripts/filesystem.mjs restore SNAPSHOT.json NEW_DIRECTORY
```

`backup` sends file content as `content_base64`, refuses a destination inside the source, refuses to replace an existing snapshot, and prints a warning when the tree contains names that collide after Unicode normalization or case folding. The default source cap is 8 MiB of bytes per backup; `SNAPVAULT_ADAPTER_LIMIT_BYTES` overrides it. `restore` verifies every object first, rejects such collisions before creating the destination, writes with `flag: 'wx'`, and applies the recorded permission bits with `chmod`.

Read the current boundaries before using this adapter, and run `sh scripts/verify.sh` to reproduce the full check ladder.
