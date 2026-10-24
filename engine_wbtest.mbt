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
test "a device name is a portability question, not a validity one" {
  // Linux can hold a file called CON.txt, so the manifest has to be able to
  // describe one; the writer refuses it on Windows. See `portablePaths`.
  let result = run(
    parse_value("{\"files\":[{\"path\":\"CON.txt\",\"text\":\"x\"}]}"),
  )
  assert_eq(arr(get(get(result, "snapshot"), "files")).length(), 1)
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
test "a colon is a portability question, not a validity one" {
  let result = run(
    parse_value("{\"files\":[{\"path\":\"C:/x\",\"text\":\"x\"}]}"),
  )
  assert_eq(arr(get(get(result, "snapshot"), "files")).length(), 1)
}

///|
test "a name longer than any filesystem allows is refused" {
  // NAME_MAX is 255 bytes on ext4, APFS and NTFS, so a 256-byte component
  // describes a tree nothing can hold. Catching it here means a restore does not
  // fail halfway through with ENAMETOOLONG.
  let long = "a".repeat(256)
  let failed = try {
    ignore(
      run(
        record([
          (
            "files",
            Array([record([("path", String(long)), ("text", String("x"))])]),
          ),
        ]),
      ),
    )
    false
  } catch {
    _ => true
  }
  assert_true(failed)
  // Exactly at the limit is still accepted.
  let at_limit = "a".repeat(255)
  let ok = run(
    record([
      (
        "files",
        Array([record([("path", String(at_limit)), ("text", String("x"))])]),
      ),
    ]),
  )
  assert_eq(arr(get(get(ok, "snapshot"), "files")).length(), 1)
  // Bytes, not characters: 128 two-byte characters is 256 bytes.
  let wide = "\u00e9".repeat(128)
  let wide_failed = try {
    ignore(
      run(
        record([
          (
            "files",
            Array([record([("path", String(wide)), ("text", String("x"))])]),
          ),
        ]),
      ),
    )
    false
  } catch {
    _ => true
  }
  assert_true(wide_failed)
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
test "case collision is a portability question, not a validity one" {
  // `A` and `a` are two files on Linux, so the snapshot has to be able to hold
  // both; refusing them here made such a directory impossible to back up. The
  // writer rejects the pair instead, because only it knows the destination
  // filesystem.
  let result = run(
    parse_value(
      "{\"files\":[{\"path\":\"A\",\"text\":\"x\"},{\"path\":\"a\",\"text\":\"y\"}]}",
    ),
  )
  let snapshot = get(result, "snapshot")
  assert_eq(arr(get(snapshot, "files")).length(), 2)
  assert_eq(get(audit_snapshot(snapshot), "valid"), Bool(true))
  // An exact duplicate is still a contradiction and is still refused.
  let failed = try {
    ignore(
      run(
        parse_value(
          "{\"files\":[{\"path\":\"A\",\"text\":\"x\"},{\"path\":\"A\",\"text\":\"y\"}]}",
        ),
      ),
    )
    false
  } catch {
    _ => true
  }
  assert_true(failed)
}
