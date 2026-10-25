///|
/// Shared fixtures for the 0.3.0 audit-contract regressions. The same inputs are
/// executed through the Node CLI in `tests/cases.json`.
fn corrupt_snapshot() -> Value raise {
  from_json(
    @json.parse(
      "{\"version\":1,\"files\":[],\"objects\":{\"0000000000000000000000000000000000000000000000000000000000000000\":[1,2,3]},\"checksum\":\"e5eccfdf0ce59ef36eb6f436f75e124e7979c91641945c21fbccdf585f335c56\"}",
    ),
  )
}

///|
fn spare_object_snapshot() -> Value raise {
  from_json(
    @json.parse(
      "{\"version\":1,\"files\":[{\"path\":\"a\",\"digest\":\"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad\",\"size\":3,\"mode\":420}],\"objects\":{\"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad\":[97,98,99],\"4a60bf7d4bc1e485744cf7e8d0860524752fca1ce42331be7c439fd23043f151\":[122,122]},\"checksum\":\"0a40f4e35fc7f7c8c9a84d28fdca50f28f20aba51cf413b930517168b07547a8\"}",
    ),
  )
}

///|
test "audit covers unreferenced objects" {
  let report = audit_snapshot(corrupt_snapshot())
  assert_eq(get(report, "valid"), Bool(false))
  assert_eq(get(report, "objects_total"), Number(1.0))
  assert_eq(get(report, "objects_checked"), Number(1.0))
  assert_eq(get(report, "referenced_objects"), Number(0.0))
  assert_eq(get(report, "unreferenced_objects"), Number(1.0))
  assert_eq(
    test_at(report, ["issues", "0", "reason"]),
    String("digest mismatch"),
  )
  assert_eq(test_at(report, ["issues", "0", "path"]), Null)
}

///|
test "audit and retention agree on a spare object" {
  let snapshot = spare_object_snapshot()
  let report = audit_snapshot(snapshot)
  assert_eq(get(report, "valid"), Bool(true))
  assert_eq(get(report, "objects_total"), Number(2.0))
  assert_eq(get(report, "objects_checked"), Number(2.0))
  assert_eq(get(report, "unreferenced_objects"), Number(1.0))
  let plan = retention_plan(
    record([
      (
        "snapshots",
        Array([record([("id", String("one")), ("snapshot", snapshot)])]),
      ),
    ]),
  )
  // The spare object is stored inside the one snapshot the plan keeps, so no deletion frees it:
  // it is stranded rather than collectible. This assertion used to say the opposite, which is how
  // the defect was written down as expected behaviour - the plan reported bytes as reclaimable
  // while naming no snapshot whose removal would reclaim them.
  assert_eq(get(plan, "collectible_objects"), strings([]))
  assert_eq(get(plan, "collectible_bytes"), Number(0.0))
  assert_eq(
    get(plan, "stranded_objects"),
    strings(["4a60bf7d4bc1e485744cf7e8d0860524752fca1ce42331be7c439fd23043f151"]),
  )
  assert_eq(get(plan, "stranded_bytes"), Number(2.0))
  assert_eq(get(plan, "live_bytes"), Number(3.0))
  // And the three buckets partition the object set, so no byte escapes the accounting: every
  // object is either needed, freed by deleting a named snapshot, or stored where only a squash
  // reaches it. A fourth possibility would mean a byte nobody can account for.
  let count = fn(field : String) -> Int32 {
    match get(plan, field) {
      Array(items) => items.length()
      _ => -1
    }
  }
  assert_eq(
    count("reachable_objects") +
    count("collectible_objects") +
    count("stranded_objects"),
    2,
  )
}

///|
test "audit refusals are consistent across operations" {
  let restorable = try {
    ignore(
      run(
        record([
          ("operation", String("restore")),
          ("snapshot", corrupt_snapshot()),
        ]),
      ),
    )
    true
  } catch {
    _ => false
  }
  assert_false(restorable)
  let creatable = try {
    ignore(create_snapshot([], previous=corrupt_snapshot()))
    true
  } catch {
    _ => false
  }
  assert_false(creatable)
}

///|
test "manifest order is lexicographic" {
  let result = create_snapshot([
    record([("path", String("c")), ("text", String("x"))]),
    record([("path", String("b/x")), ("text", String("x"))]),
    record([("path", String("a")), ("text", String("x"))]),
  ])
  let files = arr(get(get(result, "snapshot"), "files"))
  assert_eq(str(get(files[0], "path")), "a")
  assert_eq(str(get(files[1], "path")), "b/x")
  assert_eq(str(get(files[2], "path")), "c")
}

///|
test "restore reports verified bytes and mode" {
  let snapshot = from_json(
    @json.parse(
      "{\"version\":1,\"files\":[{\"path\":\"a\",\"digest\":\"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad\",\"size\":3,\"mode\":493}],\"objects\":{\"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad\":[97,98,99]},\"checksum\":\"0c6a1352b6da89074a45eb31249271483236991bbcc154f54e35e5e36a0bb765\"}",
    ),
  )
  let result = run(
    record([("operation", String("restore")), ("snapshot", snapshot)]),
  )
  assert_eq(get(result, "verified"), Bool(true))
  assert_eq(test_at(result, ["files", "0", "mode"]), Number(493.0))
  assert_eq(test_at(result, ["files", "0", "bytes", "0"]), Number(97.0))
  assert_eq(test_at(result, ["files", "0", "bytes", "2"]), Number(99.0))
}

///|
test "parse_value exposes the JSON boundary" {
  let value = parse_value("{\"a\":1}")
  assert_eq(get(value, "a"), Number(1.0))
  assert_eq(value.stringify(), "{\"a\":1}")
}
