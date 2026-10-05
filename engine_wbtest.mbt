///|
fn test_at(value : Value, parts : Array[String]) -> Value raise {
  let mut current = value
  for part in parts {
    current = match current {
      Object(fields) =>
        match fields.get(part) {
          Some(v) => v
          None => raise InputError("test key missing: " + part)
        }
      Array(items) => items[num(parse_value(part)).to_int()]
      _ => raise InputError("invalid test traversal")
    }
  }
  current
}

///|
test "SHA256 known vector" {
  let result = run(
    parse_value("{\"files\":[{\"path\":\"hello.txt\",\"text\":\"abc\"}]}"),
  )
  assert_eq(
    test_at(result, ["snapshot", "files", "0", "digest"]),
    parse_value(
      "\"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad\"",
    ),
  )
  assert_eq(test_at(result, ["statistics", "total_bytes"]), parse_value("3"))
}

///|
test "content deduplication" {
  let result = run(
    parse_value(
      "{\"files\":[{\"path\":\"a\",\"text\":\"abc\"},{\"path\":\"b\",\"text\":\"abc\"}]}",
    ),
  )
  assert_eq(test_at(result, ["statistics", "unique_bytes"]), parse_value("3"))
  assert_eq(
    test_at(result, ["statistics", "deduplicated_bytes"]),
    parse_value("3"),
  )
}

///|
test "binary zeros" {
  let result = run(
    parse_value("{\"files\":[{\"path\":\"zero.bin\",\"bytes\":[0,255,0]}]}"),
  )
  assert_eq(test_at(result, ["statistics", "total_bytes"]), parse_value("3"))
}

///|
test "unsafe path ../escape" {
  let failed = try {
    ignore(
      run(parse_value("{\"files\":[{\"path\":\"../escape\",\"text\":\"x\"}]}")),
    )
    false
  } catch {
    _ => true
  }
  assert_true(failed)
}

///|
test "unsafe path CON.txt" {
  let failed = try {
    ignore(
      run(parse_value("{\"files\":[{\"path\":\"CON.txt\",\"text\":\"x\"}]}")),
    )
    false
  } catch {
    _ => true
  }
  assert_true(failed)
}

///|
test "unsafe path a//b" {
  let failed = try {
    ignore(run(parse_value("{\"files\":[{\"path\":\"a//b\",\"text\":\"x\"}]}")))
    false
  } catch {
    _ => true
  }
  assert_true(failed)
}

///|
test "unsafe path C:/x" {
  let failed = try {
    ignore(run(parse_value("{\"files\":[{\"path\":\"C:/x\",\"text\":\"x\"}]}")))
    false
  } catch {
    _ => true
  }
  assert_true(failed)
}

///|
test "unsafe path a/../b" {
  let failed = try {
    ignore(
      run(parse_value("{\"files\":[{\"path\":\"a/../b\",\"text\":\"x\"}]}")),
    )
    false
  } catch {
    _ => true
  }
  assert_true(failed)
}

///|
test "case collision" {
  let failed = try {
    ignore(
      run(
        parse_value(
          "{\"files\":[{\"path\":\"A\",\"text\":\"x\"},{\"path\":\"a\",\"text\":\"y\"}]}",
        ),
      ),
    )
    false
  } catch {
    _ => true
  }
  assert_true(failed)
}
