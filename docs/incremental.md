# Incremental snapshots (format 3)

Format 1 and 2 snapshots are self contained: every snapshot carries every object
it references, so ten daily backups of an unchanged 4 MiB tree are ten times
4 MiB. Format 3 breaks that by letting a snapshot name the one it builds on.

## Shape

```json
{
  "version": 3,
  "parent": "<checksum of the snapshot this one builds on, or null>",
  "files": [ ... full manifest, every path ... ],
  "objects": { "<sha256>": "<base64>" },
  "checksum": "<sha256 of canonical {version, parent, files}>"
}
```

Two rules make this safe and simple:

- **The manifest stays complete.** A delta lists every file, not just the ones
  that changed, so `diff`, `audit` and `retention` need no chain walking to
  describe the tree. Only the payloads are incremental.
- **`parent` is bound into the checksum.** Re-pointing a delta at a different
  base changes the bytes that get hashed, so the checksum no longer matches and
  the snapshot is refused instead of silently re-interpreted.

`objects` holds only the payloads the chain does not already have. Resolving a
digest walks from the snapshot towards the root and takes the first link that
stores it.

## Creating one

```json
{"format": 3, "previous": <base snapshot>, "parents": [], "files": [ ... ]}
```

`previous` becomes the parent; `parents` carries the rest of the chain when
`previous` is itself a delta. The base is verified before the delta is written,
so a chain is never extended over corruption. Statistics report both halves:

```json
{"total_bytes": 17, "new_object_bytes": 11, "reused_object_bytes": 6,
 "objects_stored": 1, "objects_reused": 1}
```

`format: 3` without `previous` is allowed and produces a self-contained snapshot
with `"parent": null`, which is a useful way to start a chain explicitly.

## Reading one

Every read operation takes the chain it needs as a list; entries are matched by
`checksum`, so order does not matter:

```json
{"operation": "audit",   "snapshot": <delta>, "parents": [<base>, ...]}
{"operation": "restore", "snapshot": <delta>, "parents": [<base>, ...]}
{"operation": "retention", "snapshots": [{"id": "d", "snapshot": <delta>,
                                          "parents": [<base>]}]}
```

- `audit` reports `chain_depth`, `objects_total` (stored here),
  `objects_inherited` (available from parents) and `objects_checked` (unique
  objects verified across the chain). `valid` covers the whole chain, so a
  corrupt grandparent makes the tip invalid.
- A link that is not supplied becomes a `missing parent snapshot` issue naming
  the checksum, not an exception; `restore` turns that into a refusal before it
  creates the destination directory.
- `restore` returns `chain_depth` and the payload in the snapshot's own
  encoding, whichever link stored the bytes.
- `retention` counts every object reachable from a retained snapshot, including
  inherited ones, and only proposes deletion for objects the request supplied.

Links are walked to a depth of 64 and each link's manifest checksum is verified,
so a chain cannot be looped or extended without bound. A true cycle is not
constructible - it would need a hash fixed point, because a checksum covers its
parent's identity - but the resolver refuses one anyway rather than trusting
that argument at runtime.

## Compacting a chain

Chains grow, and every restore needs every link. `squash` folds a chain into one
self-contained snapshot:

```json
{"operation": "squash", "snapshot": <tip>, "parents": [<base>, ...], "format": 2}
```

The result keeps the complete manifest, holds every object the manifest reaches
exactly once, has `"parent": null`, and needs no chain from then on. Objects the
chain accumulated but no file points at are dropped, so squashing is also how the
space that rewritten files leave behind is reclaimed. Without `format` the
snapshot keeps its own version, which leaves its checksum family intact;
`"format": 2` on a three-link chain produces a file byte-identical to creating
the same tree directly.

Squashing twice changes nothing, which the tests assert by comparing checksums.

## Selecting files to restore

`restore` takes an optional `paths` list. A path selects the entry with that name
and everything below it, matched on whole components - `docs` covers
`docs/a.md` but `doc` covers nothing.

```json
{"operation": "restore", "snapshot": <tip>, "parents": [<base>], "paths": ["docs", "notes.txt"]}
```

The response reports `selected` and `total_files`, and the payload still resolves
through the chain. A path that matches nothing fails with
`restore path not found in snapshot: <path>` rather than silently restoring less
than asked for; unsafe or empty selections are refused outright.

## Cost

| | base | delta |
|---|---:|---:|
| 3 MiB tree, one small file changed | 4.1 MB, 611 ms | 752 B, 685 ms |

The delta is 0.02% of the base on disk. It is not cheaper in time: the base is
re-verified before the delta is written, which is the same work as a full
backup, and the request carries the new tree and the parent snapshot together.

That last point is the practical limit. The core CLI caps a request at 16 MiB,
and a delta request holds both the source bytes (base64, ~1.33x) and the parent
snapshot. Roughly, `source * 1.33 + parent_snapshot + manifest <= 16 MiB`, so a
delta over an 8 MiB base is not possible in one request; the adapter reports the
exact split instead of failing with "input exceeds 16 MiB".

## Host adapter

```sh
node scripts/filesystem.mjs backup  SOURCE SNAPSHOT [PREVIOUS [PARENT...]]
node scripts/filesystem.mjs restore SNAPSHOT DEST [PARENT...]
```

`backup` with a `previous` writes a delta; without one it writes a self-contained
format 2 snapshot. `backup` returns `format`, `parent`, `snapshot_bytes` and the
object statistics, so a caller can see what it just wrote. `restore` accepts
`--path P` (repeatable) to write a subset, and `squash` compacts a chain:

```sh
node scripts/filesystem.mjs squash tip.json compact.json base.json middle.json --format 2
```

A practical rotation is: one self-contained base, a delta per backup, and a
squash whenever the chain gets uncomfortably long - the compacted file replaces
the chain as the new base.
