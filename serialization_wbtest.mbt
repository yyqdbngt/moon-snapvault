///|
/// Exact serialization, pinned.
///
/// The project claims byte-identical output between the JS, wasm, wasm-gc and native
/// backends, and `docs/boundaries.md` leans on that claim when it justifies pinning
/// whole answers. The CLI is JS only, so the claim can only be checked where all four
/// backends run: here, in the library. Every constant below is therefore a
/// cross-backend assertion - a backend that formats a number or escapes a string
/// differently fails on that backend alone.
///
/// These shapes are not arbitrary. Integral doubles printing as `420` rather than
/// `420.0`, and `1e21` printing as `1e+21`, both feed the canonical form that checksums
/// are computed over; a difference there would make snapshots silently incompatible
/// between backends rather than visibly broken.

///|
test "numbers serialize to one spelling per value" {
  let cases : Array[(Double, String)] = [
    (0.0, "0"),
    // -0.0 has no separate spelling: JSON has one zero.
    (-0.0, "0"),
    (1.0, "1"),
    (420.0, "420"),
    (-1.0, "-1"),
    (255.0, "255"),
    (1.5, "1.5"),
    (0.1, "0.1"),
    (1.0 / 3.0, "0.3333333333333333"),
    (1000000000000000000000.0, "1e+21"),
    (0.0000001, "1e-7"),
  ]
  for entry in cases {
    let (value, expected) = entry
    assert_eq(Number(value).stringify(), expected)
  }
}

///|
test "strings escape only what JSON requires" {
  // Quotes and backslashes are escaped; non-ASCII is passed through as characters,
  // which is what keeps a UTF-8 path readable in a snapshot.
  assert_eq(String("a\"b\\c").stringify(), "\"a\\\"b\\\\c\"")
  assert_eq(String("tab\there").stringify(), "\"tab\\there\"")
  assert_eq(String("caf\u00e9\u4e2d").stringify(), "\"caf\u00e9\u4e2d\"")
  assert_eq(String("").stringify(), "\"\"")
  assert_eq(String("\u0000").stringify(), "\"\\u0000\"")
}

///|
test "stringify preserves insertion order while canonical sorts" {
  // Two spellings, deliberately: `stringify` is for people and keeps the order the
  // object was built with, while `canonical` - which checksums are computed over - sorts
  // keys by length and then by code unit. If these were the same function, the checksum
  // would depend on construction order and two backends could disagree.
  let value = Object(
    Map([("b", Number(1.0)), ("a", Number(2.0)), ("cc", Number(3.0))]),
  )
  assert_eq(value.stringify(), "{\"b\":1,\"a\":2,\"cc\":3}")
  assert_eq(canonical(value), "{\"a\":2,\"b\":1,\"cc\":3}")
}

///|
test "canonical orders keys by length first, then code unit" {
  // This order is part of every released checksum and cannot change without
  // invalidating existing files, so it is pinned rather than described.
  let value = Object(
    Map([
      ("bbb", Number(1.0)),
      ("a", Number(2.0)),
      ("aa", Number(3.0)),
      ("b", Number(4.0)),
      ("Z", Number(5.0)),
    ]),
  )
  // Length 1: "Z" (0x5A) before "a" (0x61) before "b". Length 2: "aa". Length 3: "bbb".
  assert_eq(canonical(value), "{\"Z\":5,\"a\":2,\"b\":4,\"aa\":3,\"bbb\":1}")
}

///|
test "a snapshot's checksum is a fixed function of its manifest" {
  // The end-to-end consequence of the two tests above: the same input must produce the
  // same checksum on every backend, or a snapshot written by one would be rejected by
  // another. The constant was computed independently with Python's hashlib over the
  // canonical form, not copied from this implementation.
  let created = create_snapshot([
    Object(Map([("path", String("a.txt")), ("text", String("abc"))])),
  ])
  let snapshot = match created {
    Object(fields) =>
      match fields.get("snapshot") {
        Some(value) => value
        None => abort("no snapshot")
      }
    _ => abort("not an object")
  }
  // `create_snapshot` defaults to format 2, so this is the format 2 checksum. Both are
  // pinned because the checksum covers `version`, which is exactly what keeps a format
  // 2 and a format 3 snapshot distinguishable even when their files are identical.
  assert_eq(
    str(get(snapshot, "checksum")),
    "3630531bf4736575bd8ec04ca1aff730c1c7a10e9a55411b04bccff09557fb9d",
  )
  let explicit3 = create_snapshot(
    [Object(Map([("path", String("a.txt")), ("text", String("abc"))]))],
    format=3,
  )
  assert_eq(
    str(get(get(explicit3, "snapshot"), "checksum")),
    "ac1eb291ecaf8fa90c956c5ff745d60e697ae945d071f3eabaabc53776e178fa",
  )
  assert_eq(get(get(explicit3, "snapshot"), "version"), Number(3.0))
}

///|
test "digest of a canonical form is stable" {
  // SHA-256 itself is covered by FIPS vectors elsewhere; this pins the composition of
  // canonical + digest that identity depends on. Also computed with Python's hashlib.
  assert_eq(
    digest(@utf8.encode(canonical(Object(Map([("a", Number(1.0))]))))),
    "015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862",
  )
  assert_eq(canonical(Object(Map([("a", Number(1.0))]))), "{\"a\":1}")
}
