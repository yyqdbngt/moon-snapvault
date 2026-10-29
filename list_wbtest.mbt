///|
test "list describes a tree without touching payloads" {
  let created = run(
    parse_value(
      "{\"files\":[{\"path\":\"docs/a.md\",\"text\":\"hello\"},{\"path\":\"b.bin\",\"bytes\":[1,2,3,4]}]}",
    ),
  )
  let listed = run(
    parse_value(
      "{\"operation\":\"list\",\"snapshot\":" +
      get(created, "snapshot").stringify() +
      "}",
    ),
  )
  assert_eq(test_at(listed, ["format"]), parse_value("2"))
  assert_eq(test_at(listed, ["parent"]), parse_value("null"))
  assert_eq(test_at(listed, ["selected"]), parse_value("2"))
  assert_eq(test_at(listed, ["total_files"]), parse_value("2"))
  assert_eq(test_at(listed, ["total_bytes"]), parse_value("9"))
  assert_eq(test_at(listed, ["files", "0", "path"]), parse_value("\"b.bin\""))
  assert_eq(
    test_at(listed, ["files", "1", "path"]),
    parse_value("\"docs/a.md\""),
  )
  assert_eq(test_at(listed, ["files", "1", "size"]), parse_value("5"))
  assert_eq(test_at(listed, ["files", "1", "mode"]), parse_value("420"))
}

///|
test "list selects whole components like restore" {
  let created = run(
    parse_value(
      "{\"files\":[{\"path\":\"docs/a.md\",\"text\":\"hello\"},{\"path\":\"docsx.txt\",\"text\":\"x\"},{\"path\":\"b.bin\",\"bytes\":[1]}]}",
    ),
  )
  let snapshot = get(created, "snapshot").stringify()
  let listed = run(
    parse_value(
      "{\"operation\":\"list\",\"snapshot\":" +
      snapshot +
      ",\"paths\":[\"docs\"]}",
    ),
  )
  assert_eq(test_at(listed, ["selected"]), parse_value("1"))
  assert_eq(test_at(listed, ["total_files"]), parse_value("3"))
  assert_eq(test_at(listed, ["total_bytes"]), parse_value("5"))
  let failed = try {
    ignore(
      run(
        parse_value(
          "{\"operation\":\"list\",\"snapshot\":" +
          snapshot +
          ",\"paths\":[\"missing\"]}",
        ),
      ),
    )
    false
  } catch {
    _ => true
  }
  assert_true(failed)
}

///|
test "list refuses a tampered manifest" {
  let created = run(
    parse_value("{\"files\":[{\"path\":\"a\",\"text\":\"abc\"}]}"),
  )
  let snapshot = obj(get(created, "snapshot")).copy()
  let original = arr(get(get(created, "snapshot"), "files"))
  snapshot["files"] = from_json(
    @json.parse(
      "[{\"path\":\"a\",\"size\":99,\"mode\":420,\"digest\":\"" +
      str(get(original[0], "digest")) +
      "\"}]",
    ),
  )
  let failed = try {
    ignore(
      run(
        parse_value(
          "{\"operation\":\"list\",\"snapshot\":" +
          Object(snapshot).stringify() +
          "}",
        ),
      ),
    )
    false
  } catch {
    _ => true
  }
  assert_true(failed)
}

///|
test "list reads a delta manifest without the chain" {
  let base = run(
    parse_value(
      "{\"files\":[{\"path\":\"a.txt\",\"text\":\"one\"}],\"format\":3}",
    ),
  )
  let delta = run(
    parse_value(
      "{\"files\":[{\"path\":\"a.txt\",\"text\":\"one\"},{\"path\":\"b.txt\",\"text\":\"two\"}],\"format\":3,\"previous\":" +
      get(base, "snapshot").stringify() +
      "}",
    ),
  )
  let listed = run(
    parse_value(
      "{\"operation\":\"list\",\"snapshot\":" +
      get(delta, "snapshot").stringify() +
      "}",
    ),
  )
  assert_eq(test_at(listed, ["format"]), parse_value("3"))
  assert_eq(test_at(listed, ["selected"]), parse_value("2"))
  assert_eq(
    test_at(listed, ["parent"]),
    parse_value("\"" + str(get(get(delta, "snapshot"), "parent")) + "\""),
  )
}
