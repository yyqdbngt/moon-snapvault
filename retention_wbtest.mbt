///|
test "retention keeps shared objects and identifies old exclusive bytes" {
  let first = get(
    create_snapshot([
      record([("path", String("shared")), ("text", String("abc"))]),
      record([("path", String("old")), ("text", String("old"))]),
    ]),
    "snapshot",
  )
  let second = get(
    create_snapshot([
      record([("path", String("shared")), ("text", String("abc"))]),
      record([("path", String("new")), ("text", String("new"))]),
    ]),
    "snapshot",
  )
  let request = record([
    (
      "snapshots",
      Array([
        record([("id", String("one")), ("snapshot", first)]),
        record([("id", String("two")), ("snapshot", second)]),
      ]),
    ),
    ("keep", strings(["two"])),
  ])
  let result = retention_plan(request)
  assert_eq(get(result, "live_bytes"), Number(6.0))
  assert_eq(get(result, "collectible_bytes"), Number(3.0))
  assert_eq(arr(get(result, "reachable_objects")).length(), 2)
  assert_eq(arr(get(result, "collectible_objects")).length(), 1)
  assert_eq(get(result, "plan_only"), Bool(true))
}

///|
/// The plan must never claim bytes a deletion cannot deliver, and every stored object must land in
/// exactly one bucket. Both halves are arithmetic, so they can be checked without knowing what the
/// plan is for - which is how the defect they guard against was found: `collectible_bytes` was
/// non-zero while `drop_snapshots` was empty, and no amount of reading the code made that obvious.
test "the three buckets partition the objects and only deletions deliver collectible bytes" {
  let plain = fn(blob : Value) -> Value {
    match blob {
      Object(fields) => {
        let out : Map[String, Value] = Map([])
        out["version"] = fields["version"]
        out["parent"] = fields.get("parent").unwrap_or(Null)
        out["files"] = fields["files"]
        out["objects"] = fields["objects"]
        out["checksum"] = fields["checksum"]
        Object(out)
      }
      _ => blob
    }
  }
  let make = fn(text : String) -> Value raise {
    let created = create_snapshot([
      Object(Map([("path", String("f-" + text)), ("text", String(text))])),
    ])
    match created {
      Object(fields) => fields.get("snapshot").unwrap_or(Null)
      _ => Null
    }
  }
  let alpha = make("alpha")
  let beta = make("beta")
  // Two snapshots, each with one object, keeping one: the other is genuinely collectible.
  let two = retention_plan(
    Object(
      Map([
        (
          "snapshots",
          Array([
            Object(Map([("id", String("a")), ("snapshot", plain(alpha))])),
            Object(Map([("id", String("b")), ("snapshot", plain(beta))])),
          ]),
        ),
        ("keep", Array([String("a")])),
      ]),
    ),
  )
  let count = fn(plan : Value, field : String) -> Int32 {
    match get(plan, field) {
      Array(items) => items.length()
      _ => -1
    }
  }
  let objects = fn(plan : Value) -> Int32 {
    count(plan, "reachable_objects") +
    count(plan, "collectible_objects") +
    count(plan, "stranded_objects")
  }
  assert_eq(objects(two), 2)
  assert_eq(count(two, "collectible_objects"), 1)
  assert_eq(count(two, "stranded_objects"), 0)
  // No bucket claims bytes without a snapshot to delete.
  if count(two, "collectible_objects") > 0 {
    assert_true(count(two, "drop_snapshots") > 0)
  }
  // A single snapshot holding a spare object: nothing to delete, so nothing is collectible.
  // The spare has to be placed by hand, with a correct digest so the audit still passes.
  let spare = "4a60bf7d4bc1e485744cf7e8d0860524752fca1ce42331be7c439fd23043f151"
  let with_spare = match plain(alpha) {
    Object(fields) => {
      let map : Map[String, Value] = Map([])
      for key, value in fields {
        map[key] = value
      }
      let kept : Map[String, Value] = match map["objects"] {
        Object(inner) => inner
        _ => Map([])
      }
      kept[spare] = String("eno=")
      map["objects"] = Object(kept)
      Object(map)
    }
    _ => Null
  }
  let one = retention_plan(
    Object(
      Map([
        (
          "snapshots",
          Array([Object(Map([("id", String("a")), ("snapshot", with_spare)]))]),
        ),
        ("keep", Array([String("a")])),
      ]),
    ),
  )
  assert_eq(objects(one), 2)
  assert_eq(count(one, "drop_snapshots"), 0)
  assert_eq(count(one, "collectible_objects"), 0)
  assert_eq(count(one, "stranded_objects"), 1)
  // And every byte is accounted for: the three byte totals are the sum of the object set.
  let bytes = fn(plan : Value, field : String) -> Double {
    match get(plan, field) {
      Number(value) => value
      _ => -1.0
    }
  }
  assert_eq(
    bytes(one, "live_bytes") +
    bytes(one, "collectible_bytes") +
    bytes(one, "stranded_bytes"),
    5.0 + 2.0,
  )
}
