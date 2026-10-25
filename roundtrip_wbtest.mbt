///|
/// The serializer has one law that everything else rests on: text the core writes can be read
/// back as the value it came from. A snapshot written today is re-read tomorrow by `audit`,
/// `restore`, `retention` and the checksum, and every one of those goes through this path. It had
/// been checked by a single assertion in `consumer-smoke.mjs`, on one small value.
///
/// What makes it worth a corpus rather than an example is that the failure is silent. A string
/// that loses a character, or a number that gains a decimal point, produces a snapshot that parses
/// without complaint and hashes to something different - so the failure surfaces as "this snapshot
/// is corrupt", with no hint that the serializer was the cause.
///
/// The corpus is chosen by class, not by taste: every scalar the type allows, every escape JSON
/// requires, the unicode forms that are equal-looking but not equal, and the number spellings that
/// boundary. Anything the core emits lands in one of those classes.
test "parse_value and stringify round-trip every scalar class" {
  let scalars : Array[Value] = [
    Null,
    Bool(true),
    Bool(false),
    Number(0.0),
    // -0.0 is equal to 0.0 and spells as `0`, so it round-trips as a value while its text
    // changes. The value is what the law is about; the spelling is pinned in
    // `serialization_wbtest.mbt`.
    Number(-0.0),
    Number(1.5),
    Number(-1.5),
    Number(0.1),
    Number(1.0e21),
    Number(1.0e-21),
    // The largest integer a double represents exactly.
    Number(9007199254740992.0),
    Number(1.7976931348623157e308),
    String(""),
    String("plain"),
    // The two characters JSON must escape wherever they appear.
    String("quote\" backslash\\ slash/"),
    // The whitespace escapes.
    String("tab\tnl\ncr\r"),
    // Control characters below 0x20 have no literal form in JSON.
    String("\u{08}\u{0C}\u{01}\u{1F}"),
    // DEL is not required to be escaped; this pins that it survives either way.
    String("\u{007F}"),
    // Precomposed versus decomposed: different byte sequences, so different values that look
    // identical. A serializer that normalised would break checksums written by another machine.
    String("\u{00E9}"),
    String("\u{0065}\u{0301}"),
    String("\u{4E2D}\u{6587}"),
    // An astral character is a surrogate pair in UTF-16 and must not be split.
    String("\u{1F600}"),
    // Zero-width characters are invisible and must survive.
    String("\u{200B}\u{200D}"),
  ]
  for value in scalars {
    let text = value.stringify()
    let back = parse_value(text)
    // Reported with the input, because this version of `assert_eq` has no message parameter and a
    // bare failure would not say which scalar broke.
    if back != value {
      abort("round trip changed the value spelled " + text)
    }
    // The stronger form: a snapshot is written, read, and written again, and the checksum is taken
    // over the canonical text both times. Equal values are not enough if the spelling drifts.
    if canonical(back) != canonical(value) {
      abort("canonical text changed across a write and read of " + text)
    }
  }
}

///|
/// Nesting, empty containers, and key order. `parse_value` must not reorder or drop anything, for
/// the same checksum reason: `canonical` sorts, but `stringify` is what gets written to disk.
test "round trip preserves structure, empty containers and insertion order" {
  let nested : Value = Object(
    Map([
      ("a", Array([Null, Bool(false), Number(2.0), String("x")])),
      ("b", Object(Map([("c", Array([])), ("d", Object(Map([])))]))),
      ("e", Array([Array([Array([String("deep")])])])),
      // Keys given out of sorted order, so a reordering serializer would show up.
      ("z", Number(1.0)),
      ("m", Number(2.0)),
    ]),
  )
  let text = nested.stringify()
  let back = parse_value(text)
  if back != nested {
    abort("round trip changed a nested structure")
  }
  if canonical(back) != canonical(nested) {
    abort("canonical text changed for a nested structure")
  }
  // `stringify` keeps the order the object was built with, which is what makes the written bytes
  // predictable; `canonical` starts from the same first key here because it happens to sort first.
  if !text.has_prefix("{\"a\":") {
    abort("stringify reordered the object it was given")
  }
  if !canonical(nested).has_prefix("{\"a\":") {
    abort("canonical did not put the shortest key first")
  }
}

///|
/// JSON has no spelling for NaN or an infinity, so `stringify` cannot produce a JSON document for
/// them: it emits the JavaScript tokens `NaN` and `Infinity`, which `parse_value` refuses. This is
/// a boundary rather than a defect, and it is pinned here so that it stays deliberate.
///
/// The core never produces such a number. Every place one could enter a manifest refuses it -
/// `num` requires a finite value, a byte list refuses anything outside 0..255, a file mode must be
/// an integer in range, and a size that is not a number cannot match a length - so no snapshot can
/// hold one and no response can contain one. What a caller can do is build a `Value` themselves
/// and stringify it, which is what these lines describe.
test "a non-finite number has no JSON spelling, and the parser refuses it" {
  assert_eq(Number(0.0 / 0.0).stringify(), "NaN")
  assert_eq(Number(1.0 / 0.0).stringify(), "Infinity")
  assert_eq(Number(-1.0 / 0.0).stringify(), "-Infinity")
  for token in ["NaN", "Infinity", "-Infinity"] {
    let refused = try {
      ignore(parse_value(token))
      false
    } catch {
      _ => true
    }
    if !refused {
      abort("parse_value accepted " + token + ", which is not JSON")
    }
  }
}

///|
/// And the claim in the test above: a non-finite number cannot get into a manifest. Each entry
/// point is exercised where a caller supplies a number directly.
test "a non-finite number cannot enter a manifest" {
  let nan = 0.0 / 0.0
  let infinity = 1.0 / 0.0
  let as_byte = try {
    ignore(
      create_snapshot([
        Object(Map([("path", String("a")), ("bytes", Array([Number(nan)]))])),
      ]),
    )
    false
  } catch {
    _ => true
  }
  if !as_byte {
    abort("a nan was accepted as a byte value")
  }
  let as_infinite_mode = try {
    ignore(
      create_snapshot([
        Object(
          Map([
            ("path", String("a")),
            ("text", String("x")),
            ("mode", Number(infinity)),
          ]),
        ),
      ]),
    )
    false
  } catch {
    _ => true
  }
  if !as_infinite_mode {
    abort("an infinity was accepted as a file mode")
  }
  let as_nan_mode = try {
    ignore(
      create_snapshot([
        Object(
          Map([
            ("path", String("a")),
            ("text", String("x")),
            ("mode", Number(nan)),
          ]),
        ),
      ]),
    )
    false
  } catch {
    _ => true
  }
  if !as_nan_mode {
    abort("a nan was accepted as a file mode")
  }
  // `format` needs no case: it is an `Int`, so a non-finite value cannot be written at all. The
  // other numeric inputs are doubles and have to be checked at run time.
  //
  // `size` needs no refusal either, and for a better reason: `create` computes it from the content
  // and ignores whatever the caller passes. Writing it here rather than asserting an error is the
  // point - a snapshot cannot be lied to about how long its files are. Verified by passing 999 for
  // a one-byte file and reading back 1.
  let made = create_snapshot([
    Object(
      Map([
        ("path", String("a")),
        ("text", String("x")),
        ("size", Number(999.0)),
      ]),
    ),
  ])
  let manifest = match made {
    Object(fields) => fields.get("snapshot").unwrap_or(Null)
    _ => Null
  }
  let recorded = match manifest {
    Object(fields) => fields.get("files").unwrap_or(Null)
    _ => Null
  }
  if recorded.stringify().contains("\"size\":999") {
    abort(
      "create honoured a size the caller supplied instead of measuring the content",
    )
  }
  if !recorded.stringify().contains("\"size\":1") {
    abort("create did not record the measured size: " + recorded.stringify())
  }
  // And a nan in a size field that *is* read is refused by `assemble`, which is where a manifest
  // entry gets validated. Not by a mismatch report: the field is rejected as "expected finite
  // number" before any comparison happens, which is the stronger outcome - a manifest with a nan
  // size cannot be constructed at all, so no code downstream has to cope with one.
  //
  // Found by writing this the other way round first. `create` ignores a supplied size rather than
  // refusing it, because it measures the content, and the first version of this test asserted a
  // refusal there and failed. Looking at why led to `assemble`, which does refuse it.
  let files = match manifest {
    Object(fields) => fields.get("files").unwrap_or(Null)
    _ => Null
  }
  let tampered_files = match files {
    Array(items) =>
      Array(
        items.map(fn(item) {
          match item {
            Object(fields) => {
              // Rebuilt entry by entry: a map is set with `m[k] = v` in this version, and
              // writing the size is the point of the exercise.
              let built : Map[String, Value] = Map([])
              built["path"] = fields["path"]
              built["digest"] = fields["digest"]
              built["size"] = Number(nan)
              built["mode"] = fields["mode"]
              Object(built)
            }
            _ => item
          }
        }),
      )
    _ => files
  }
  let assembled_refused = try {
    ignore(
      run(
        Object(
          Map([("operation", String("assemble")), ("files", tampered_files)]),
        ),
      ),
    )
    false
  } catch {
    _ => true
  }
  if !assembled_refused {
    abort("assemble accepted a nan file size")
  }
}
