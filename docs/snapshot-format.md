# Snapshot format

A snapshot is one JSON object. Two versions exist; `create` writes version 2
unless the request asks for `"format": 1`.

## Version 2 (current)

```json
{
  "version": 2,
  "files": [
    {"path": "notes/a.md", "digest": "<sha256 hex>", "size": 12, "mode": 420}
  ],
  "objects": {
    "<sha256 hex>": "aGVsbG8gd29ybGQK"
  },
  "checksum": "<sha256 hex>"
}
```

`objects` maps a SHA-256 hex digest to the base64 text of that object's bytes.
`files` is the manifest: unique portable paths, the digest each path resolves to,
the byte length and the POSIX permission bits. `checksum` is
`SHA-256(canonical({"version": 2, "files": [...]}))`, so the manifest is bound to
the format that produced it.

## Version 1 (previous, still read)

```json
{
  "version": 1,
  "files": [
    {"path": "notes/a.md", "digest": "<sha256 hex>", "size": 12, "mode": 420}
  ],
  "objects": {
    "<sha256 hex>": [104, 101, 108, 108, 111, 32, 119, 111, 114, 108, 100, 10]
  },
  "checksum": "<sha256 hex>"
}
```

Identical except that each object is an array of decimal byte values, and the
checksum is computed with `"version": 1`.

## Why version 2

Decimal byte arrays cost up to four characters per byte (three digits plus a
comma) and force a million-element JSON array through the parser for every
mebibyte of content. Base64 costs four characters per three bytes, so the same
content is about 1.33x instead of 3.57x, and both the request and the response
carry text instead of numbers.

| 1 MiB incompressible file | format 1 | format 2 |
|---|---:|---:|
| Snapshot size | 3.57 MiB | 1.33 MiB |
| Backup (debug build) | 2396 ms | 649 ms |
| Restore (debug build) | 2081 ms | 423 ms |

Measured on the reference host with moon 0.1.20261023 and Node 20.20.2.

## Compatibility rules

- A snapshot's `version` decides the accepted encoding. A decimal array inside a
  version 2 snapshot is reported as `invalid object encoding`, not silently
  accepted, and a string inside a version 1 snapshot fails the same way.
- `audit`, `restore`, `diff` and `retention` read both versions. `restore`
  returns `format` and `encoding` (`base64` or `decimal`) with the payload in the
  encoding it validated.
- `retention` may plan across versions. Entries that share a digest carry the
  same bytes by construction, so the first encoding seen is kept and byte totals
  are computed from decoded lengths, never from the payload's text length.
- Creating with `"format": 1` reproduces the version 1 layout byte for byte,
  including its checksum, so existing tooling that pins version 1 keeps working.
