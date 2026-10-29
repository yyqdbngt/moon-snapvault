///|
fn auth_create(key : String) -> Value raise {
  let request = parse_value(
    "{\"files\":[{\"path\":\"a.txt\",\"text\":\"one\"}],\"key\":\"" +
    key +
    "\"}",
  )
  run(request)
}

///|
fn auth_audit(snapshot : Value, key : String?) -> Value raise {
  let key_part = match key {
    Some(text) => ",\"key\":\"" + text + "\""
    None => ""
  }
  run(
    parse_value(
      "{\"operation\":\"audit\",\"snapshot\":" +
      snapshot.stringify() +
      key_part +
      "}",
    ),
  )
}

///|
test "create with a key authenticates and audit with it verifies" {
  let created = auth_create("hunter2")
  let snapshot = get(created, "snapshot")
  assert_eq(
    test_at(snapshot, ["auth", "scheme"]),
    parse_value("\"hmac-sha256\""),
  )
  let hex = str(get(get(snapshot, "auth"), "hmac"))
  assert_eq(hex.length(), 64)
  let verified = auth_audit(snapshot, Some("hunter2"))
  assert_eq(test_at(verified, ["valid"]), parse_value("true"))
  assert_eq(test_at(verified, ["authenticated"]), parse_value("true"))
}

///|
test "a wrong key reports authentication failed" {
  let snapshot = get(auth_create("hunter2"), "snapshot")
  let report = auth_audit(snapshot, Some("wrong"))
  assert_eq(test_at(report, ["valid"]), parse_value("false"))
  assert_eq(test_at(report, ["authenticated"]), parse_value("false"))
  assert_eq(
    test_at(report, ["issues", "0", "reason"]),
    parse_value("\"authentication failed\""),
  )
  let refused = try {
    ignore(
      run(
        parse_value(
          "{\"operation\":\"restore\",\"snapshot\":" +
          snapshot.stringify() +
          ",\"key\":\"wrong\"}",
        ),
      ),
    )
    false
  } catch {
    _ => true
  }
  assert_true(refused)
}

///|
test "auditing without a key leaves the block unverified" {
  let snapshot = get(auth_create("hunter2"), "snapshot")
  let report = auth_audit(snapshot, None)
  assert_eq(test_at(report, ["valid"]), parse_value("true"))
  assert_eq(test_at(report, ["authenticated"]), parse_value("null"))
}

///|
test "a recomputed checksum cannot forge the block" {
  let created = auth_create("hunter2")
  let snapshot = obj(get(created, "snapshot")).copy()
  // The attacker rewrites content and recomputes the checksum, which needs no
  // secret. The stale auth block is what exposes the edit.
  snapshot["files"] = from_json(
    @json.parse(
      "[{\"path\":\"a.txt\",\"digest\":\"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad\",\"size\":3,\"mode\":420}]",
    ),
  )
  snapshot["objects"] = from_json(
    @json.parse(
      "{\"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad\":\"YmFy\"}",
    ),
  )
  snapshot["checksum"] = String(
    digest(
      @utf8.encode(
        canonical(
          record([("version", Number(2)), ("files", snapshot["files"])]),
        ),
      ),
    ),
  )
  let report = auth_audit(Object(snapshot), Some("hunter2"))
  assert_eq(test_at(report, ["valid"]), parse_value("false"))
  assert_eq(test_at(report, ["authenticated"]), parse_value("false"))
}

///|
test "an unauthed snapshot audits with a key as authenticated null" {
  let created = run(
    parse_value("{\"files\":[{\"path\":\"a.txt\",\"text\":\"one\"}]}"),
  )
  let report = auth_audit(get(created, "snapshot"), Some("hunter2"))
  assert_eq(test_at(report, ["valid"]), parse_value("true"))
  assert_eq(test_at(report, ["authenticated"]), parse_value("null"))
}

///|
test "malformed authentication blocks are refused" {
  let snapshot = get(auth_create("hunter2"), "snapshot")
  let wrong_scheme = obj(snapshot).copy()
  wrong_scheme["auth"] = from_json(
    @json.parse("{\"scheme\":\"md5\",\"hmac\":\"" + "a".repeat(64) + "\"}"),
  )
  let scheme = try {
    ignore(auth_audit(Object(wrong_scheme), Some("hunter2")))
    false
  } catch {
    _ => true
  }
  assert_true(scheme)
  let wrong_hex = obj(snapshot).copy()
  wrong_hex["auth"] = from_json(
    @json.parse("{\"scheme\":\"hmac-sha256\",\"hmac\":\"nothex\"}"),
  )
  let hex = try {
    ignore(auth_audit(Object(wrong_hex), Some("hunter2")))
    false
  } catch {
    _ => true
  }
  assert_true(hex)
}

///|
test "a chain is authenticated link by link" {
  let base = get(auth_create("hunter2"), "snapshot")
  let delta = match
    run(
      parse_value(
        "{\"files\":[{\"path\":\"a.txt\",\"text\":\"one\"},{\"path\":\"b.txt\",\"text\":\"two\"}],\"format\":3,\"key\":\"hunter2\",\"previous\":" +
        base.stringify() +
        "}",
      ),
    ) {
    Object(fields) => fields.get("snapshot").unwrap()
    _ => abort("missing snapshot")
  }
  let verified = run(
    parse_value(
      "{\"operation\":\"audit\",\"snapshot\":" +
      delta.stringify() +
      ",\"parents\":[" +
      base.stringify() +
      "],\"key\":\"hunter2\"}",
    ),
  )
  assert_eq(test_at(verified, ["valid"]), parse_value("true"))
  assert_eq(test_at(verified, ["authenticated"]), parse_value("true"))
  // Tamper with the tip and recompute only its checksum: the chain still
  // resolves because the parent is untouched, and the stale block on the tip
  // is what the audit catches.
  let forged = obj(delta).copy()
  forged["files"] = from_json(
    @json.parse(
      "[{\"path\":\"a.txt\",\"digest\":\"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad\",\"size\":3,\"mode\":420}]",
    ),
  )
  forged["objects"] = from_json(
    @json.parse(
      "{\"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad\":\"YmFy\"}",
    ),
  )
  forged["checksum"] = String(
    digest(
      @utf8.encode(
        canonical(
          record([
            ("version", Number(3)),
            ("parent", get(base, "checksum")),
            ("files", forged["files"]),
          ]),
        ),
      ),
    ),
  )
  let link_report = run(
    parse_value(
      "{\"operation\":\"audit\",\"snapshot\":" +
      Object(forged).stringify() +
      ",\"parents\":[" +
      base.stringify() +
      "],\"key\":\"hunter2\"}",
    ),
  )
  assert_eq(test_at(link_report, ["valid"]), parse_value("false"))
  assert_eq(test_at(link_report, ["authenticated"]), parse_value("false"))
}

///|
test "key validation refuses wrong types and oversized keys" {
  let wrong_type = try {
    ignore(
      run(
        parse_value(
          "{\"files\":[{\"path\":\"a.txt\",\"text\":\"one\"}],\"key\":42}",
        ),
      ),
    )
    false
  } catch {
    _ => true
  }
  assert_true(wrong_type)
  let mut oversized = "\"files\":[{\"path\":\"a.txt\",\"text\":\"one\"}],\"key\":\""
  for _ in 0..<1025 {
    oversized += "k"
  }
  oversized += "\""
  let too_long = try {
    ignore(run(parse_value("{" + oversized + "}")))
    false
  } catch {
    _ => true
  }
  assert_true(too_long)
  let created = run(
    parse_value("{\"files\":[{\"path\":\"a.txt\",\"text\":\"one\"}]}"),
  )
  // A parent that never joins the chain carries no verified block: auditing a
  // chain whose tip has no auth reports null even with a key supplied.
  let report = run(
    parse_value(
      "{\"operation\":\"audit\",\"snapshot\":" +
      get(created, "snapshot").stringify() +
      ",\"parents\":[],\"key\":\"hunter2\"}",
    ),
  )
  assert_eq(test_at(report, ["authenticated"]), parse_value("null"))
}
