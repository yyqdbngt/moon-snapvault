# Request and result guide

Every example below is an executable fixture. Assertions cover the listed result fields; additional output fields are documented by the API and other fixtures. Error cases intentionally reject the request.

## Exit codes and the error contract

| Situation | stdout | exit code |
|---|---|---:|
| Valid request | one JSON result | 0 |
| Invalid request, missing file, invalid UTF-8, input over 16 MiB | `{"error": "<message>"}` | 1 |
| Wrong number of arguments | usage line | 2 |

The contract is the same for every failure, including host-side ones, so a caller can always parse stdout as JSON. Messages are the plain reason (`unsafe source path`, `manifest checksum mismatch`); they do not expose MoonBit type names.

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

## Audit report fields

`{"operation": "audit", "snapshot": ...}` verifies every stored object, referenced or not.

| Field | Meaning |
|---|---|
| `valid` | no issue was found in this snapshot's bytes |
| `issues` | list of `{path, object, reason}`; `path` is `null` when no file references the object |
| `format` | snapshot format version that was validated |
| `files` | number of manifest entries |
| `objects_total` | number of stored objects |
| `objects_checked` | objects whose bytes were decoded and hashed |
| `referenced_objects` | objects reachable from the manifest |
| `unreferenced_objects` | stored objects no manifest entry references |

`{path: "a", object: "<sha256>", reason: "digest mismatch"}` is what a corrupt unreferenced object looks like. `retention` refuses the same snapshot, and `restore` will not write it.

## Restore result fields

`{"operation": "restore", "snapshot": ...}` returns `format`, `encoding`, `files` (each with `path`, `digest`, `size`, `mode` and `bytes`) and `verified: true`; the filesystem adapter adds `modes_applied`. The core operation only plans the restore; `scripts/filesystem.mjs` writes the files and applies `mode` with `chmod`.

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

Expected: nonzero exit with an input error.

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

Expected: nonzero exit with an input error.

## Host adapter

```sh
node scripts/filesystem.mjs backup SOURCE_DIR NEW_SNAPSHOT.json [PREVIOUS.json]
node scripts/filesystem.mjs restore SNAPSHOT.json NEW_DIRECTORY
```

`backup` sends file content as `content_base64`, refuses a destination inside the source, refuses to replace an existing snapshot, and prints a warning when the tree contains names that collide after Unicode normalization or case folding. The default source cap is 8 MiB of bytes per backup; `SNAPVAULT_ADAPTER_LIMIT_BYTES` overrides it. `restore` verifies every object first, rejects such collisions before creating the destination, writes with `flag: 'wx'`, and applies the recorded permission bits with `chmod`.

Read the current boundaries before using this adapter, and run `sh scripts/verify.sh` to reproduce the full check ladder.
