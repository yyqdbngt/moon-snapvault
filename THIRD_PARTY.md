# Attribution

The domain code in this repository was implemented for this project with AI coding assistance. Shared JSON-value/CLI scaffolding is used across the October projects; it is infrastructure rather than nine independent domain algorithms.

## Design references

- [https://github.com/gmlewis/moonbit-sha256](https://github.com/gmlewis/moonbit-sha256)
- [https://www.rfc-editor.org/rfc/rfc6234](https://www.rfc-editor.org/rfc/rfc6234)

References inform formats and algorithms; they are not claims of interoperability with every feature of the referenced systems. MoonBit core is a toolchain dependency. Python standard-library and Node built-in APIs are used by host adapters and test oracles. No prior September project implementation was copied into this domain core.

## SHA-256 dependency

`gmlewis/sha256@0.17.33` is an external implementation, under Apache-2.0 with upstream Go BSD notices. It depends on `gmlewis/base64@0.16.12`. This cryptographic implementation is not counted as project-owned source. See `third_party/` for upstream license texts.
