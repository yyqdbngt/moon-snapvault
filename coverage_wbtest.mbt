///|
/// Branches that coverage showed no test reached.
///
/// `moon test` does not run the JSON CLI, so anything exercised only through the fixtures
/// looks untouched to the coverage report. That is a measurement artefact for `cmd/main`,
/// but it was also hiding real gaps: the guard against a code unit above 255 in base64
/// decoding, and the JSON-to-`Value` conversion for `null` and numbers, were both
/// unexecuted by any white-box test. Neither was wrong; nothing would have noticed if it
/// had been.
///
/// Written from the coverage report rather than from the code, which is the point: the
/// list of what is untested came first.

///|
test "base64 decoding refuses a code unit above 255 without reading out of bounds" {
  // A CJK character is a code unit above 255. The decoder indexes a 256-entry reverse
  // table, so without the guard this is an out-of-bounds read rather than a refusal.
  assert_eq(base64_decode("\u4e2d\u6587"), None)
  assert_eq(base64_decode("\u4e2d"), None)
  // An emoji arrives as a surrogate pair; both halves are above 255.
  assert_eq(base64_decode("\u{1F389}"), None)
  // And a byte-range character that is simply not in the alphabet is refused too, by the
  // reverse table rather than the range check.
  assert_eq(base64_decode("\u00e9"), None)
}

///|
test "base64 decoding accepts only the canonical form" {
  // Every one of these differs from a canonical encoding in a way the decoder has to
  // notice; together they exercise each refusal in the decode path.
  assert_eq(base64_decode("YWJj"), Some(b"abc"))
  // Unpadded input is normalised, not rejected.
  assert_eq(base64_decode("YQ"), Some(b"a"))
  assert_eq(base64_decode("YWI"), Some(b"ab"))
  // A single character cannot encode anything.
  assert_eq(base64_decode("Y"), None)
  // Three characters with padding is not a multiple of four.
  assert_eq(base64_decode("YWJ="), None)
  // Padding may only appear at the end.
  assert_eq(base64_decode("YQ==YWJj"), None)
  // Trailing bits must be zero, or two different strings would decode to the same bytes.
  assert_eq(base64_decode("YR=="), None)
  // "YWJ" is not the canonical encoding of "ab" - the canonical form is "YWI" - because
  // its trailing bits are not zero. The decoder refuses it rather than accepting two
  // spellings of one payload, which is what keeps a snapshot's digest single-valued.
  assert_eq(base64_decode("YWJ"), None)
  assert_eq(base64_decode("YWI"), Some(b"ab"))
  // Whitespace is not part of the alphabet.
  assert_eq(base64_decode("YW Jj"), None)
  assert_eq(base64_decode("YWJj\n"), None)
  // The empty string is the empty payload.
  assert_eq(base64_decode(""), Some(b""))
}

///|
test "json to Value covers every json kind" {
  // These lines were uncovered: `null` and numbers were never converted from JSON in a
  // white-box test, only through the CLI.
  assert_eq(from_json(Json::null()), Null)
  assert_eq(from_json(Json::boolean(true)), Bool(true))
  assert_eq(from_json(Json::boolean(false)), Bool(false))
  assert_eq(from_json(Json::number(3.5)), Number(3.5))
  assert_eq(from_json(Json::string("x")), String("x"))
  assert_eq(from_json(Json::array([Json::null()])), Array([Null]))
  let object = from_json(Json::object({ "k": Json::null() }))
  assert_eq(object, Object(Map([("k", Null)])))
  // Round trip: to_json then from_json must return the same value, which is what makes
  // the JSON boundary lossless for the shapes a snapshot uses.
  for
    value in [
      Null,
      Bool(true),
      Number(1.5),
      String("a"),
      Array([Null]),
      Object(Map([("k", Number(2.0))])),
    ] {
    assert_eq(from_json(value.to_json()), value)
  }
}

///|
test "format selection covers each accepted value and refuses the rest" {
  // `optional_format` decides what an absent `format` means, per operation.
  assert_eq(optional_format(record([])), None)
  assert_eq(optional_format(record([("format", Number(1.0))])), Some(1))
  assert_eq(optional_format(record([("format", Number(2.0))])), Some(2))
  assert_eq(optional_format(record([("format", Number(3.0))])), Some(3))
  // Anything else is a refusal, including a fractional or a string format.
  for
    bad in [
      Number(4.0),
      Number(0.0),
      Number(1.5),
      String("2"),
      Bool(true),
      Null,
    ] {
    if bad == Null {
      assert_eq(optional_format(record([("format", bad)])), None)
      continue
    }
    let refused = try {
      ignore(optional_format(record([("format", bad)])))
      false
    } catch {
      _ => true
    }
    assert_true(refused)
  }
}
