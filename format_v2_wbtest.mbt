///|
/// A format-1 snapshot with one referenced object and one spare.
fn legacy_snapshot() -> Value raise {
  from_json(
    @json.parse(
      "{\"version\":1,\"files\":[{\"path\":\"a\",\"digest\":\"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad\",\"size\":3,\"mode\":420}],\"objects\":{\"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad\":[97,98,99],\"4a60bf7d4bc1e485744cf7e8d0860524752fca1ce42331be7c439fd23043f151\":[122,122]},\"checksum\":\"0a40f4e35fc7f7c8c9a84d28fdca50f28f20aba51cf413b930517168b07547a8\"}",
    ),
  )
}

///|
test "format 2 stores base64 and keeps the digest" {
  let result = create_snapshot([
    record([("path", String("a")), ("text", String("abc"))]),
  ])
  let snapshot = get(result, "snapshot")
  assert_eq(get(snapshot, "version"), Number(2.0))
  assert_eq(
    get(snapshot, "checksum"),
    String("a253b85efb3b34b8b08e9a56ffad86a275a0066f46ed52505b2bee9125422f51"),
  )
  let objects = obj(get(snapshot, "objects"))
  assert_eq(
    objects["ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
    String("YWJj"),
  )
}

///|
test "format 1 stays available and byte-identical to the old layout" {
  let result = create_snapshot(
    [record([("path", String("a")), ("text", String("abc"))])],
    format=1,
  )
  let snapshot = get(result, "snapshot")
  assert_eq(get(snapshot, "version"), Number(1.0))
  assert_eq(
    get(snapshot, "checksum"),
    String("0a40f4e35fc7f7c8c9a84d28fdca50f28f20aba51cf413b930517168b07547a8"),
  )
  let objects = obj(get(snapshot, "objects"))
  assert_eq(
    objects["ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
    Array([Number(97.0), Number(98.0), Number(99.0)]),
  )
}

///|
test "content_base64 decodes to the same object as text" {
  let encoded = create_snapshot([
    record([("path", String("z.bin")), ("content_base64", String("AP8H"))]),
  ])
  let files = arr(get(get(encoded, "snapshot"), "files"))
  assert_eq(
    str(get(files[0], "digest")),
    "92e469e6f34332f611f46cc5371592264628458db80d2a9c40310daec8384d23",
  )
  assert_eq(get(files[0], "size"), Number(3.0))
  let plain = create_snapshot([
    record([
      ("path", String("z.bin")),
      ("bytes", Array([Number(0.0), Number(255.0), Number(7.0)])),
    ]),
  ])
  assert_eq(arr(get(get(plain, "snapshot"), "files"))[0], files[0])
}

///|
test "restore advertises the snapshot encoding" {
  let base64 = get(
    create_snapshot([record([("path", String("a")), ("text", String("abc"))])]),
    "snapshot",
  )
  let restored = run(
    record([("operation", String("restore")), ("snapshot", base64)]),
  )
  assert_eq(get(restored, "encoding"), String("base64"))
  assert_eq(get(restored, "format"), Number(2.0))
  assert_eq(test_at(restored, ["files", "0", "bytes"]), String("YWJj"))
  let legacy = run(
    record([("operation", String("restore")), ("snapshot", legacy_snapshot())]),
  )
  assert_eq(get(legacy, "encoding"), String("decimal"))
  assert_eq(test_at(legacy, ["files", "0", "bytes", "0"]), Number(97.0))
}

///|
test "format 2 refuses a decimal payload" {
  let snapshot = obj(
    get(
      create_snapshot([record([("path", String("a")), ("text", String("abc"))])]),
      "snapshot",
    ),
  ).copy()
  let objects = obj(snapshot["objects"]).copy()
  objects["ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"] = Array([
      Number(97.0),
      Number(98.0),
      Number(99.0),
    ],
  )
  snapshot["objects"] = Object(objects)
  let report = audit_snapshot(Object(snapshot))
  assert_eq(get(report, "valid"), Bool(false))
  assert_eq(get(report, "format"), Number(2.0))
  assert_eq(
    test_at(report, ["issues", "0", "reason"]),
    String("invalid object encoding"),
  )
}

///|
test "retention mixes formats by digest" {
  let current = get(
    create_snapshot([record([("path", String("a")), ("text", String("abc"))])]),
    "snapshot",
  )
  let plan = retention_plan(
    record([
      (
        "snapshots",
        Array([
          record([("id", String("old")), ("snapshot", legacy_snapshot())]),
          record([("id", String("new")), ("snapshot", current)]),
        ]),
      ),
      ("keep", strings(["new"])),
    ]),
  )
  assert_eq(get(plan, "keep_snapshots"), strings(["new"]))
  assert_eq(get(plan, "drop_snapshots"), strings(["old"]))
  assert_eq(
    get(plan, "reachable_objects"),
    strings(["ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"]),
  )
  assert_eq(get(plan, "live_bytes"), Number(3.0))
  assert_eq(get(plan, "collectible_bytes"), Number(2.0))
}

///|
test "unsupported formats and content forms are refused" {
  let formats = try {
    ignore(create_snapshot([], format=4))
    false
  } catch {
    _ => true
  }
  assert_true(formats)
  // A parent chain needs format 3; format 2 rejects one instead of ignoring it.
  let chained = try {
    let previous = get(
      create_snapshot([record([("path", String("a")), ("text", String("x"))])]),
      "snapshot",
    )
    ignore(create_snapshot([], previous~, format=2))
    false
  } catch {
    _ => true
  }
  assert_true(chained)
  let both = try {
    ignore(
      create_snapshot([
        record([
          ("path", String("a")),
          ("text", String("x")),
          ("content_base64", String("eA==")),
        ]),
      ]),
    )
    false
  } catch {
    _ => true
  }
  assert_true(both)
  let bad_base64 = try {
    ignore(
      create_snapshot([
        record([
          ("path", String("a")),
          ("content_base64", String("not base64!")),
        ]),
      ]),
    )
    false
  } catch {
    _ => true
  }
  assert_true(bad_base64)
  let none = try {
    ignore(create_snapshot([record([("path", String("a"))])]))
    false
  } catch {
    _ => true
  }
  assert_true(none)
}
