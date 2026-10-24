# Attribution

The domain code in this repository was implemented for this project with AI coding assistance. Shared JSON-value/CLI scaffolding is used across the October projects; it is infrastructure rather than nine independent domain algorithms.

## Design references

- [FIPS 180-4](https://csrc.nist.gov/pubs/fips/180-4/upd1/final) - SHA-256 constants and padding
- [RFC 6234](https://www.rfc-editor.org/rfc/rfc6234) - SHA-256 reference description
- [RFC 4648](https://www.rfc-editor.org/rfc/rfc4648) - base64 alphabet and padding

References inform formats and algorithms; they are not claims of interoperability with every feature of the referenced systems. MoonBit core is a toolchain dependency. Python standard-library and Node built-in APIs are used by host adapters and test oracles. No prior September project implementation was copied into this domain core.

## Codec code

`sha256.mbt` and `base64.mbt` are project-owned implementations written for this release, so the
module has no runtime dependency outside `moonbitlang/core`. Both are checked against values
produced by Python's `hashlib` and `base64` modules (`scripts/reference.py` and
`encoding_vectors_wbtest.mbt`), and against the FIPS 180-4 and RFC 4648 vectors.

Earlier releases used `gmlewis/sha256@0.17.33` (Apache-2.0 with upstream Go BSD notices, plus
`gmlewis/base64@0.16.12`). Its per-byte `HashFunc::write` was the dominant cost of every operation
at 21 MiB/s, so the compression function was reimplemented over a reusable schedule. The license
texts remain in `third_party/` because that code informed the reimplementation.

This project is not a hardened cryptographic library: it implements SHA-256 for content addressing
and does no secret-key operations.
