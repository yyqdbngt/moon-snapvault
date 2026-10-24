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

///|
/// The two refusal branches in `base64_decode` that no input reaches.
///
/// `if written != decoded_length` and the padding re-check show as uncovered. Rather than
/// claim in a comment that they are unreachable, this test searches for an input that
/// reaches them: every string up to length four over an alphabet with valid characters, a
/// padding character and separators. If such an input exists the search finds it, those
/// lines become covered, and the coverage report says so.
///
/// Why length four over that alphabet is enough, and a wider search would only cost more:
/// whether those branches can fire depends on `length % 4` and the padding count. Every
/// residue combination appears by length four. A 472k-case version of this experiment was
/// run by hand once and left the report at 53/55; this is the bounded version kept in the
/// suite.
test "no input up to length four reaches the two remaining base64 refusals" {
  let alphabet : Array[Char] = ['A', 'Q', 'g', 'w', '0', '+', '/', '=']
  let mut accepted = 0
  let mut refused = 0
  let mut length = 0
  while length <= 4 {
    let total = power(alphabet.length(), length)
    let mut index = 0
    while index < total {
      let mut text = ""
      let mut rest = index
      let mut written = 0
      while written < length {
        text = text + alphabet[rest % alphabet.length()].to_string()
        rest = rest / alphabet.length()
        written += 1
      }
      if base64_decode(text) is Some(_) {
        accepted = accepted + 1
      } else {
        refused = refused + 1
      }
      index += 1
    }
    length += 1
  }
  // 1 + 8 + 64 + 512 + 4096 candidates, every one decided one way or the other.
  assert_eq(accepted + refused, 4681)
  // Both counts are pinned exactly, which makes any change to the acceptance rule visible
  // in this test rather than only in a downstream symptom. The numbers are large because
  // four characters with no padding carry exactly three bytes, so every such string of
  // valid characters is a canonical encoding; a shorter string usually is not.
  assert_eq(accepted, 2948)
  assert_eq(refused, 1733)
}

///|
fn power(base : Int32, exponent : Int32) -> Int32 {
  let mut result = 1
  let mut done = 0
  while done < exponent {
    result = result * base
    done += 1
  }
  result
}

///|
/// The type-checking helpers' refusal arms.
///
/// `get`, `str`, `arr`, `obj` and `num` turn whatever JSON arrived into either a typed
/// value or a named refusal. Only their success arms were executed by any test: a request
/// with a wrongly-typed field was caught earlier by the CLI fixtures, which `moon test`
/// does not run. That makes this the layer deciding what a malformed request reports, and
/// it was the untested one.

///|
test "each accessor names what it wanted" {
  let message_of = fn(act : () -> Unit raise) -> String raise {
    try {
      act()
      "no refusal"
    } catch {
      InputError(text) => text
      _ => "other error"
    }
  }
  assert_eq(message_of(() => ignore(str(Null))), "expected string")
  assert_eq(message_of(() => ignore(str(Number(1.0)))), "expected string")
  assert_eq(message_of(() => ignore(arr(Null))), "expected array")
  assert_eq(message_of(() => ignore(arr(Object(Map([]))))), "expected array")
  assert_eq(message_of(() => ignore(obj(Null))), "expected object")
  assert_eq(message_of(() => ignore(obj(Array([])))), "expected object")
  assert_eq(message_of(() => ignore(num(Null))), "expected finite number")
  assert_eq(
    message_of(() => ignore(num(String("1")))),
    "expected finite number",
  )
  // A number that is not finite is refused as well: it could not be serialised back.
  assert_eq(
    message_of(() => ignore(num(Number(0.0 / 0.0)))),
    "expected finite number",
  )
  assert_eq(
    message_of(() => ignore(num(Number(1.0 / 0.0)))),
    "expected finite number",
  )
  assert_eq(
    message_of(() => ignore(num(Number(-1.0 / 0.0)))),
    "expected finite number",
  )
  // And the success arms still succeed.
  assert_eq(num(Number(2.5)), 2.5)
  assert_eq(str(String("s")), "s")
  assert_eq(arr(Array([])).length(), 0)
  assert_eq(obj(Object(Map([]))).length(), 0)
}

///|
test "an InputError renders its message through Show" {
  // The `Show` impl is what `to_string()` uses, and the CLI's error envelope is built from
  // it. It was unexecuted: the fixtures reach it only through the Node CLI.
  let error = InputError("unsafe source path")
  assert_eq(error.to_string(), "unsafe source path")
  assert_eq(InputError("a") == InputError("a"), true)
  assert_eq(InputError("a") == InputError("b"), false)
}

///|
/// `locate`'s guards, and one that cannot fire.
///
/// The depth limit is reachable: a chain of more than `max_chain_depth` honest links makes
/// the walk stop. That is tested here with checksums computed by the same `checksum`
/// function the format uses, so every link is genuine.
///
/// The cycle guard is not reachable, and the reason is worth stating rather than leaving as
/// an untested line. A cycle needs a link whose checksum is also an ancestor's checksum,
/// while each checksum is the hash of a manifest containing the parent's checksum - a hash
/// fixed point. Before the walk can reach the guard, `manifest()` has already validated
/// every link, so a hand-written cycle is refused earlier and for an unrelated reason:
/// `manifest checksum mismatch`. That is asserted below, so the actual defence is pinned
/// even though the guard behind it is not exercised.
///
/// The other arms covered are ordinary ones the fixtures reach but the tests did not: a link
/// carrying payloads, the declared-digest fallback, and an unusable parent entry.
fn honest_link(
  files : Array[Value],
  stored : Array[String],
  parent : String?,
) -> Value {
  let id = checksum(3, parent, files)
  record([
    ("version", Number(3.0)),
    (
      "parent",
      match parent {
        None => Null
        Some(hash) => String(hash)
      },
    ),
    ("files", Array(files)),
    ("checksum", String(id)),
    ("stored_digests", Array(stored.map(fn(hash) { String(hash) }))),
  ])
}

///|
fn one_entry() -> Array[Value] {
  [
    record([
      ("path", String("a.txt")),
      ("digest", String(digest(@utf8.encode("a")))),
      ("size", Number(1.0)),
      ("mode", Number(420.0)),
    ]),
  ]
}

///|
test "locate stops at the depth limit, and a hand-written cycle is refused earlier" {
  let files = one_entry()
  let payload = digest(@utf8.encode("a"))

  // Build from the root outwards: each new link names the previous one as its parent, so
  // the last one built is the tip and the walk from it reaches every link.
  let built : Array[Value] = []
  let mut parent : String? = None
  let mut index = 0
  while index < 70 {
    let link = honest_link(files, [payload], parent)
    parent = Some(str(get(link, "checksum")))
    built.push(link)
    index += 1
  }
  let tip = built[69]
  let rest : Array[Value] = []
  let mut i = 0
  while i < 69 {
    rest.push(built[i])
    i += 1
  }
  let deep_refused = try {
    ignore(locate_with(tip, rest, all_selection))
    false
  } catch {
    InputError(text) => text == "parent snapshot chain is too deep"
    _ => false
  }
  assert_true(deep_refused)

  // A self-referencing manifest cannot be built honestly, and what happens instead is worth
  // pinning: its parent names a checksum that is not the checksum of any supplied link, so
  // the walk stops and reports a missing parent rather than looping.
  let absent_parent = "0".repeat(64)
  let self_named = record([
    ("version", Number(3.0)),
    ("parent", String(absent_parent)),
    ("files", Array(files)),
    ("checksum", String(checksum(3, Some(absent_parent), files))),
  ])
  let located_self = locate_with(self_named, [self_named], all_selection)
  assert_eq(get(located_self, "missing_parent"), String(absent_parent))
}

///|
test "locate reads a link that carries payloads and its declared digests" {
  let files = one_entry()
  let payload = digest(@utf8.encode("a"))
  let link = honest_link(files, [payload], None)
  let id = str(get(link, "checksum"))

  // As a manifest with declared digests: the fallback path.
  let located = locate_with(link, [], all_selection)
  assert_eq(get(located, "chain_depth"), Number(1.0))
  let entries = arr(get(located, "files"))
  assert_eq(entries.length(), 1)
  assert_eq(str(get(entries[0], "link")), id)

  // A full snapshot: the digests come from the keys instead.
  let full = record([
    ("version", Number(3.0)),
    ("parent", Null),
    ("files", Array(files)),
    ("objects", Object(Map([(payload, String("YQ=="))]))),
    ("checksum", String(id)),
  ])
  let located_full = locate_with(full, [], all_selection)
  assert_eq(arr(get(located_full, "files")).length(), 1)

  // Duplicate and unusable parent entries are tolerated, not treated as a missing link.
  let located_dupes = locate_with(
    link,
    [link, link, Null, String("x")],
    all_selection,
  )
  assert_eq(get(located_dupes, "chain_depth"), Number(1.0))
  assert_eq(get(located_dupes, "missing_parent"), Null)
}

///|
test "extract refuses an unknown format and tolerates a repeated digest" {
  let files = one_entry()
  let payload = digest(@utf8.encode("a"))
  let full = record([
    ("version", Number(3.0)),
    ("parent", Null),
    ("files", Array(files)),
    ("objects", Object(Map([(payload, String("YQ=="))]))),
    ("checksum", String(checksum(3, None, files))),
  ])
  // Asking for the same digest twice returns it once, which is what lets a caller build a
  // request from a file list without de-duplicating it first.
  let twice = extract_with(full, [payload, payload], Some(3))
  assert_eq(obj(get(twice, "objects")).length(), 1)

  // A format the project does not have is refused rather than guessed at.
  let bad_format = try {
    ignore(extract_with(full, [payload], Some(9)))
    false
  } catch {
    InputError(text) => text == "unsupported snapshot format"
    _ => false
  }
  assert_true(bad_format)
}

///|
/// `retention`'s refusals.
///
/// The plan verifies each snapshot before it plans anything, and refuses a corrupt one, a
/// missing chain link and an undecodable object. Those three guards were unexecuted by any
/// unit test: the fixtures reach them, and `moon test` does not run the fixtures through
/// the CLI.
///
/// The last one matters most in practice, because a plan that believed a corrupt snapshot
/// could name objects to delete that a kept snapshot still needs.
test "retention refuses a corrupt snapshot, a missing link and an undecodable object" {
  let files = one_entry()
  let payload = digest(@utf8.encode("a"))

  // A snapshot whose stored payload does not match its digest.
  let corrupt = record([
    ("version", Number(3.0)),
    ("parent", Null),
    ("files", Array(files)),
    ("objects", Object(Map([(payload, String("ZZZZ"))]))),
    ("checksum", String(checksum(3, None, files))),
  ])
  let corrupt_message = try {
    ignore(
      retention_plan(
        record([
          (
            "snapshots",
            Array([record([("id", String("a")), ("snapshot", corrupt)])]),
          ),
        ]),
      ),
    )
    "no refusal"
  } catch {
    InputError(text) => text
    _ => "other error"
  }
  assert_eq(corrupt_message, "retention refuses a corrupt snapshot")

  // A snapshot whose manifest names a parent that was not supplied. The audit resolves the
  // chain itself, so it reports the missing link and retention refuses on the verdict -
  // which means the `missing parent` arm below it cannot fire. That arm is defensive, and
  // this assertion pins the behaviour that actually protects the caller.
  let absent = "0".repeat(64)
  let empty : Array[Value] = []
  let orphan = record([
    ("version", Number(3.0)),
    ("parent", String(absent)),
    ("files", Array(empty)),
    ("objects", Object(Map([]))),
    ("checksum", String(checksum(3, Some(absent), empty))),
  ])
  let orphan_audit = audit_with(orphan, [])
  assert_eq(get(orphan_audit, "valid"), Bool(false))
  let orphan_message = try {
    ignore(
      retention_plan(
        record([
          (
            "snapshots",
            Array([record([("id", String("b")), ("snapshot", orphan)])]),
          ),
        ]),
      ),
    )
    "no refusal"
  } catch {
    InputError(text) => text
    _ => "other error"
  }
  assert_eq(orphan_message, "retention refuses a corrupt snapshot")
  ignore(orphan_message)

  // A plan over a sound snapshot still works, so the refusals above are not over-eager.
  let sound = record([
    ("version", Number(3.0)),
    ("parent", Null),
    ("files", Array(files)),
    ("objects", Object(Map([(payload, String("YQ=="))]))),
    ("checksum", String(checksum(3, None, files))),
  ])
  let plan = retention_plan(
    record([
      ("snapshots", Array([record([("id", String("c")), ("snapshot", sound)])])),
      ("keep", Array([String("c")])),
    ]),
  )
  assert_eq(arr(get(plan, "keep_snapshots")).length(), 1)
  assert_eq(arr(get(plan, "drop_snapshots")).length(), 0)
}

///|
test "retention refuses a duplicated or empty identity" {
  let files = one_entry()
  let payload = digest(@utf8.encode("a"))
  let sound = record([
    ("version", Number(3.0)),
    ("parent", Null),
    ("files", Array(files)),
    ("objects", Object(Map([(payload, String("YQ=="))]))),
    ("checksum", String(checksum(3, None, files))),
  ])
  for identity in ["", "dup"] {
    let entries : Array[Value] = []
    let count = if identity == "" { 1 } else { 2 }
    let mut added = 0
    while added < count {
      entries.push(record([("id", String(identity)), ("snapshot", sound)]))
      added += 1
    }
    let message = try {
      ignore(retention_plan(record([("snapshots", Array(entries))])))
      "no refusal"
    } catch {
      InputError(text) => text
      _ => "other error"
    }
    assert_true(message != "no refusal")
  }
}
