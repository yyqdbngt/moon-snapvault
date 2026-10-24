///|
/// base with two files; the delta adds a third and reuses both.
fn slim_base() -> Value raise {
  get(
    create_snapshot(
      [
        record([("path", String("a.txt")), ("text", String("alpha"))]),
        record([("path", String("b.txt")), ("text", String("beta"))]),
      ],
      format=3,
    ),
    "snapshot",
  )
}

///|
fn slim_files() -> Array[Value] {
  [
    record([("path", String("a.txt")), ("text", String("alpha"))]),
    record([("path", String("b.txt")), ("text", String("beta"))]),
    record([("path", String("c.txt")), ("text", String("gamma"))]),
  ]
}

///|
fn digests_of(snapshot : Value) -> Array[String] raise {
  obj(get(snapshot, "objects")).keys().collect()
}

///|
/// A copy of `known` with one more digest, since `Array::append` returns Unit.
fn plus(known : Array[String], extra : String) -> Array[String] {
  let out : Array[String] = []
  for digest in known {
    out.push(digest)
  }
  out.push(extra)
  out
}

///|
test "declaring known objects gives the same snapshot as sending the parent" {
  let base = slim_base()
  let full = get(
    create_snapshot(slim_files(), previous=base, format=3),
    "snapshot",
  )
  let slim = get(
    create_snapshot(
      slim_files(),
      previous=manifest_only(base),
      known_objects=digests_of(base),
      format=3,
    ),
    "snapshot",
  )
  assert_eq(canonical(slim), canonical(full))
  assert_eq(obj(get(slim, "objects")).length(), 1)
  assert_eq(get(slim, "parent"), get(base, "checksum"))
}

///|
test "a manifest-only parent is reported as unverified" {
  let base = slim_base()
  let full = create_snapshot(slim_files(), previous=base, format=3)
  let slim = create_snapshot(
    slim_files(),
    previous=manifest_only(base),
    known_objects=digests_of(base),
    format=3,
  )
  assert_eq(get(get(full, "statistics"), "base_verified"), Bool(true))
  // The core never saw the parent's payloads, so it cannot claim to have checked
  // them; it says so rather than pretending.
  assert_eq(get(get(slim, "statistics"), "base_verified"), Bool(false))
}

///|
test "a slim delta restores through the chain" {
  let base = slim_base()
  let slim = get(
    create_snapshot(
      slim_files(),
      previous=manifest_only(base),
      known_objects=digests_of(base),
      format=3,
    ),
    "snapshot",
  )
  let restored = restore_with(slim, [base], all_files)
  assert_eq(paths_of(arr(get(restored, "files"))), ["a.txt", "b.txt", "c.txt"])
  assert_eq(get(arr(get(restored, "files"))[0], "bytes"), String("YWxwaGE="))
}

///|
test "a manifest-only parent needs its digests" {
  let base = slim_base()
  let refused = try {
    ignore(
      create_snapshot(slim_files(), previous=manifest_only(base), format=3),
    )
    false
  } catch {
    _ => true
  }
  assert_true(refused)
}

///|
test "known objects need a parent to point at" {
  let base = slim_base()
  let refused = try {
    ignore(
      create_snapshot(slim_files(), known_objects=digests_of(base), format=3),
    )
    false
  } catch {
    _ => true
  }
  assert_true(refused)
  // A parent chain implies format 3, so declaring digests for format 2 fails too.
  let legacy = try {
    ignore(
      create_snapshot(
        slim_files(),
        previous=base,
        known_objects=digests_of(base),
        format=2,
      ),
    )
    false
  } catch {
    _ => true
  }
  assert_true(legacy)
}

///|
test "a malformed known digest is refused" {
  let base = slim_base()
  let cases : Array[Array[String]] = [
    ["not-a-digest"],
    [""],
    ["ABCDEF0123456789abcdef0123456789abcdef0123456789abcdef0123456789"],
    [digest_of("alpha")[:63].to_owned()],
  ]
  for known in cases {
    let refused = try {
      ignore(
        create_snapshot(
          slim_files(),
          previous=manifest_only(base),
          known_objects=known,
          format=3,
        ),
      )
      false
    } catch {
      _ => true
    }
    assert_true(refused)
  }
}

///|
test "a false claim fails closed when the snapshot is read" {
  let base = slim_base()
  // Claim the chain already holds a payload it has never seen, so the delta
  // omits it. Nothing detects this at write time; the reader must.
  let slim = get(
    create_snapshot(
      slim_files(),
      previous=manifest_only(base),
      known_objects=plus(digests_of(base), digest_of("gamma")),
      format=3,
    ),
    "snapshot",
  )
  assert_eq(obj(get(slim, "objects")).length(), 0)
  let report = audit_with(slim, [base])
  assert_eq(get(report, "valid"), Bool(false))
  let reasons : Array[String] = arr(get(report, "issues")).map(item => {
    str(get(item, "reason"))
  })
  assert_true(reasons.contains("missing object"))
  let refused = try {
    ignore(restore_with(slim, [base], all_files))
    false
  } catch {
    _ => true
  }
  assert_true(refused)
}

///|
test "declaring a digest the chain really has adds no objects" {
  let base = slim_base()
  let slim = get(
    create_snapshot(
      slim_files(),
      previous=manifest_only(base),
      // One extra digest the base does not have and nothing references: harmless,
      // because an unreferenced digest is never read.
      known_objects=plus(digests_of(base), digest_of("unused")),
      format=3,
    ),
    "snapshot",
  )
  let report = audit_with(slim, [base])
  assert_eq(get(report, "valid"), Bool(true))
  assert_eq(obj(get(slim, "objects")).length(), 1)
}
