///|
/// Builds a self-contained base snapshot with two files.
fn base_snapshot() -> Value raise {
  get(
    create_snapshot(
      [
        record([("path", String("shared.txt")), ("text", String("shared"))]),
        record([("path", String("old.txt")), ("text", String("old content"))]),
      ],
      format=3,
    ),
    "snapshot",
  )
}

///|
/// Builds a delta over `base` where `old.txt` was replaced and a file was added.
fn delta_snapshot(base : Value) -> Value raise {
  get(
    create_snapshot(
      [
        record([("path", String("shared.txt")), ("text", String("shared"))]),
        record([("path", String("old.txt")), ("text", String("new content"))]),
        record([("path", String("added.txt")), ("text", String("added"))]),
      ],
      previous=base,
      format=3,
    ),
    "snapshot",
  )
}

///|
fn digest_of(text : String) -> String {
  digest(@utf8.encode(text))
}

///|
/// "Restore everything", the selection a request without `paths` produces.
let all_files : Selection = { prefixes: None, }

///|
test "a delta stores only the objects its parent lacks" {
  let base = base_snapshot()
  let delta = delta_snapshot(base)
  assert_eq(get(delta, "version"), Number(3.0))
  assert_eq(get(delta, "parent"), get(base, "checksum"))
  let stored = obj(get(delta, "objects"))
  let shared = digest_of("shared")
  let added = digest_of("added")
  let replaced = digest_of("new content")
  let retired = digest_of("old content")
  assert_eq(stored.length(), 2)
  assert_true(stored.contains(added))
  assert_true(stored.contains(replaced))
  assert_true(!stored.contains(shared))
  assert_true(!stored.contains(retired))
  // The manifest still lists every file, so this snapshot diffs on its own.
  assert_eq(arr(get(delta, "files")).length(), 3)
}

///|
test "create reports what a delta reused" {
  let base = base_snapshot()
  let result = create_snapshot(
    [
      record([("path", String("shared.txt")), ("text", String("shared"))]),
      record([("path", String("old.txt")), ("text", String("new content"))]),
    ],
    previous=base,
    format=3,
  )
  let statistics = get(result, "statistics")
  assert_eq(get(statistics, "total_bytes"), Number(17.0))
  assert_eq(get(statistics, "new_object_bytes"), Number(11.0))
  assert_eq(get(statistics, "reused_object_bytes"), Number(6.0))
  assert_eq(get(statistics, "objects_stored"), Number(1.0))
  assert_eq(get(statistics, "objects_reused"), Number(1.0))
}

///|
test "audit resolves a parent chain" {
  let base = base_snapshot()
  let delta = delta_snapshot(base)
  let report = audit_with(delta, [base])
  assert_eq(get(report, "valid"), Bool(true))
  assert_eq(get(report, "format"), Number(3.0))
  assert_eq(get(report, "parent"), get(base, "checksum"))
  assert_eq(get(report, "chain_depth"), Number(2.0))
  assert_eq(get(report, "files"), Number(3.0))
  assert_eq(get(report, "objects_total"), Number(2.0))
  // The parent contributes "shared" and the retired "old content": both are
  // stored there and neither is stored in the delta.
  assert_eq(get(report, "objects_inherited"), Number(2.0))
  assert_eq(get(report, "objects_checked"), Number(4.0))
}

///|
test "a delta without its parent is not valid" {
  let base = base_snapshot()
  let delta = delta_snapshot(base)
  let report = audit_with(delta, [])
  assert_eq(get(report, "valid"), Bool(false))
  assert_eq(get(report, "chain_depth"), Number(1.0))
  let reasons : Array[String] = arr(get(report, "issues")).map(item => {
    str(get(item, "reason"))
  })
  assert_true(reasons.contains("missing parent snapshot"))
  assert_true(reasons.contains("missing object"))
  let objects : Array[String] = arr(get(report, "issues")).map(item => {
    str(get(item, "object"))
  })
  assert_true(objects.contains(str(get(base, "checksum"))))
  let refused = try {
    ignore(restore_with(delta, [], all_files))
    false
  } catch {
    _ => true
  }
  assert_true(refused)
}

///|
test "restore reads inherited objects" {
  let base = base_snapshot()
  let delta = delta_snapshot(base)
  let restored = restore_with(delta, [base], all_files)
  assert_eq(get(restored, "verified"), Bool(true))
  assert_eq(get(restored, "chain_depth"), Number(2.0))
  assert_eq(get(restored, "encoding"), String("base64"))
  let files = arr(get(restored, "files"))
  assert_eq(files.length(), 3)
  // shared.txt is not stored in the delta; its payload comes from the parent.
  let shared = files[2]
  assert_eq(str(get(shared, "path")), "shared.txt")
  assert_eq(get(shared, "bytes"), String("c2hhcmVk"))
}

///|
test "a chain of deltas resolves to the oldest base" {
  let first = base_snapshot()
  let second = delta_snapshot(first)
  let third = get(
    create_snapshot(
      [
        record([("path", String("shared.txt")), ("text", String("shared"))]),
        record([("path", String("old.txt")), ("text", String("new content"))]),
        record([("path", String("added.txt")), ("text", String("added"))]),
        record([("path", String("third.txt")), ("text", String("third"))]),
      ],
      previous=second,
      parents=[first],
      format=3,
    ),
    "snapshot",
  )
  assert_eq(obj(get(third, "objects")).length(), 1)
  let report = audit_with(third, [first, second])
  assert_eq(get(report, "valid"), Bool(true))
  assert_eq(get(report, "chain_depth"), Number(3.0))
  assert_eq(get(report, "objects_inherited"), Number(4.0))
  let restored = restore_with(third, [second, first], all_files)
  let files = arr(get(restored, "files"))
  assert_eq(files.length(), 4)
  // third.txt comes from the newest link, shared.txt from the base.
  assert_eq(get(files[3], "bytes"), String("dGhpcmQ="))
  assert_eq(get(files[2], "bytes"), String("c2hhcmVk"))
}

///|
test "a corrupted parent is refused" {
  let base = base_snapshot()
  let delta = delta_snapshot(base)
  let tampered = obj(base).copy()
  let objects = obj(tampered["objects"]).copy()
  objects[digest_of("shared")] = String("dGFtcGVyZWQ=")
  tampered["objects"] = Object(objects)
  let report = audit_with(delta, [Object(tampered)])
  assert_eq(get(report, "valid"), Bool(false))
  let reasons : Array[String] = arr(get(report, "issues")).map(item => {
    str(get(item, "reason"))
  })
  assert_true(reasons.contains("digest mismatch"))
}

///|
test "a self-referential parent terminates" {
  // A true cycle would need a hash fixed point, because a snapshot's checksum
  // covers its parent identity. A forged self-reference must still terminate
  // and be reported rather than walked forever.
  let base = base_snapshot()
  let forged = obj(base).copy()
  let own = str(get(base, "checksum"))
  forged["parent"] = String(own)
  forged["checksum"] = String(checksum(3, Some(own), arr(forged["files"])))
  let report = audit_with(Object(forged), [Object(forged)])
  assert_eq(get(report, "valid"), Bool(false))
  let reasons : Array[String] = arr(get(report, "issues")).map(item => {
    str(get(item, "reason"))
  })
  assert_true(reasons.contains("missing parent snapshot"))
}

///|
test "a chain deeper than the limit is refused" {
  let chain : Array[Value] = []
  let mut current = get(
    create_snapshot(
      [record([("path", String("a")), ("text", String("a"))])],
      format=3,
    ),
    "snapshot",
  )
  let mut refused = false
  let mut step = 0
  while step < 80 && !refused {
    try {
      let next = get(
        create_snapshot(
          [
            record([("path", String("a")), ("text", String("a"))]),
            record([
              ("path", String("b" + step.to_string())),
              ("text", String("b")),
            ]),
          ],
          previous=current,
          parents=chain,
          format=3,
        ),
        "snapshot",
      )
      chain.push(current)
      current = next
    } catch {
      _ => refused = true
    }
    step = step + 1
  }
  assert_true(refused)
  assert_true(chain.length() <= 65)
}

///|
test "a self-contained format 3 snapshot has no parent" {
  let snapshot = base_snapshot()
  assert_eq(get(snapshot, "parent"), Null)
  let report = audit_with(snapshot, [])
  assert_eq(get(report, "valid"), Bool(true))
  assert_eq(get(report, "chain_depth"), Number(1.0))
  assert_eq(get(report, "objects_inherited"), Number(0.0))
  // Formats 1 and 2 may not declare a parent at all.
  for legacy in [1, 2] {
    let bad = try {
      let forged = obj(snapshot).copy()
      forged["version"] = Number(legacy.to_double())
      ignore(manifest(Object(forged)))
      false
    } catch {
      _ => true
    }
    assert_true(bad)
  }
}

///|
test "retention counts inherited objects" {
  let base = base_snapshot()
  let delta = delta_snapshot(base)
  let plan = retention_plan(
    record([
      (
        "snapshots",
        Array([
          record([("id", String("base")), ("snapshot", base)]),
          record([
            ("id", String("delta")),
            ("snapshot", delta),
            ("parents", Array([base])),
          ]),
        ]),
      ),
      ("keep", strings(["delta"])),
    ]),
  )
  assert_eq(get(plan, "keep_snapshots"), strings(["delta"]))
  // The delta cannot be read without its parent, so the base is promoted rather
  // than dropped even though it was not requested.
  assert_eq(get(plan, "required_snapshots"), strings(["base"]))
  assert_eq(get(plan, "drop_snapshots"), strings([]))
  // Keeping the delta keeps the base as well, so both manifests are live: shared,
  // old content, new content and added are all reachable and nothing is
  // collectible. The retired payload the base stored is still referenced by the
  // base's own manifest, which has to stay valid.
  assert_eq(arr(get(plan, "reachable_objects")).length(), 4)
  assert_eq(arr(get(plan, "collectible_objects")).length(), 0)
  // shared (6) + old content (11) + new content (11) + added (5)
  assert_eq(get(plan, "live_bytes"), Number(33.0))
  assert_eq(get(plan, "collectible_bytes"), Number(0.0))
  assert_eq(get(plan, "plan_only"), Bool(true))
}
