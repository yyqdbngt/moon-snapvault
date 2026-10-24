///|
/// A three-link chain: base -> delta -> tip, with one file added per link.
fn chain_of_three() -> Array[Value] raise {
  let base = get(
    create_snapshot(
      [
        record([("path", String("docs/a.md")), ("text", String("alpha"))]),
        record([("path", String("docs/b.md")), ("text", String("beta"))]),
      ],
      format=3,
    ),
    "snapshot",
  )
  let middle = get(
    create_snapshot(
      [
        record([("path", String("docs/a.md")), ("text", String("alpha"))]),
        record([("path", String("docs/b.md")), ("text", String("beta"))]),
        record([("path", String("notes.txt")), ("text", String("note"))]),
      ],
      previous=base,
      format=3,
    ),
    "snapshot",
  )
  let tip = get(
    create_snapshot(
      [
        record([("path", String("docs/a.md")), ("text", String("alpha"))]),
        record([("path", String("docs/b.md")), ("text", String("beta"))]),
        record([("path", String("notes.txt")), ("text", String("note"))]),
        record([("path", String("top.txt")), ("text", String("top"))]),
      ],
      previous=middle,
      parents=[base],
      format=3,
    ),
    "snapshot",
  )
  [base, middle, tip]
}

///|
fn paths_of(files : Array[Value]) -> Array[String] raise {
  files.map(file => str(get(file, "path")))
}

///|
test "squash turns a chain into one self-contained snapshot" {
  let chain = chain_of_three()
  let tip = chain[2]
  let result = squash_with(tip, [chain[0], chain[1]], Some(3))
  let squashed = get(result, "snapshot")
  let statistics = get(result, "statistics")
  assert_eq(get(squashed, "version"), Number(3.0))
  assert_eq(get(squashed, "parent"), Null)
  assert_eq(get(statistics, "chain_depth"), Number(3.0))
  assert_eq(get(statistics, "files"), Number(4.0))
  assert_eq(get(statistics, "objects"), Number(4.0))
  assert_eq(get(statistics, "bytes"), Number(16.0))
  // Every payload is present, including the ones the tip inherited.
  assert_eq(obj(get(squashed, "objects")).length(), 4)
  // The squashed snapshot needs no chain from here on.
  let report = audit_with(squashed, [])
  assert_eq(get(report, "valid"), Bool(true))
  assert_eq(get(report, "chain_depth"), Number(1.0))
  assert_eq(get(report, "objects_inherited"), Number(0.0))
}

///|
test "squash keeps the manifest byte for byte" {
  let chain = chain_of_three()
  let tip = chain[2]
  let squashed = get(
    squash_with(tip, [chain[0], chain[1]], Some(2)),
    "snapshot",
  )
  assert_eq(canonical(get(squashed, "files")), canonical(get(tip, "files")))
  // A format 2 squash is byte-identical to creating the same tree directly.
  let direct = get(
    create_snapshot(
      [
        record([("path", String("docs/a.md")), ("text", String("alpha"))]),
        record([("path", String("docs/b.md")), ("text", String("beta"))]),
        record([("path", String("notes.txt")), ("text", String("note"))]),
        record([("path", String("top.txt")), ("text", String("top"))]),
      ],
      format=2,
    ),
    "snapshot",
  )
  assert_eq(str(get(squashed, "checksum")), str(get(direct, "checksum")))
  assert_eq(
    canonical(get(squashed, "objects")),
    canonical(get(direct, "objects")),
  )
}

///|
test "squash drops objects no file references" {
  let chain = chain_of_three()
  let tip = obj(chain[2]).copy()
  let objects = obj(tip["objects"]).copy()
  // A stale payload the manifest does not point at.
  objects[digest_of("orphan")] = String("b3JwaGFu")
  tip["objects"] = Object(objects)
  let stale = Object(tip)
  let squashed = get(
    squash_with(stale, [chain[0], chain[1]], Some(3)),
    "snapshot",
  )
  assert_eq(obj(get(squashed, "objects")).length(), 4)
  assert_true(!obj(get(squashed, "objects")).contains(digest_of("orphan")))
  // The source snapshot still carries it, which is why squashing is worth doing.
  assert_eq(obj(get(stale, "objects")).length(), 2)
}

///|
test "squash refuses a broken chain and an unknown format" {
  let chain = chain_of_three()
  let tip = chain[2]
  let refused = try {
    ignore(squash_with(tip, [], Some(3)))
    false
  } catch {
    _ => true
  }
  assert_true(refused)
  let bad_format = try {
    ignore(squash_with(tip, [chain[0], chain[1]], Some(4)))
    false
  } catch {
    _ => true
  }
  assert_true(bad_format)
  let tampered = obj(chain[0]).copy()
  let objects = obj(tampered["objects"]).copy()
  objects[digest_of("alpha")] = String("dGFtcGVyZWQ=")
  tampered["objects"] = Object(objects)
  let corrupt = try {
    ignore(squash_with(tip, [Object(tampered), chain[1]], Some(3)))
    false
  } catch {
    _ => true
  }
  assert_true(corrupt)
}

///|
test "restore selects a directory prefix" {
  let chain = chain_of_three()
  let tip = chain[2]
  let parents = [chain[0], chain[1]]
  let selection : Selection = { prefixes: Some(["docs"]), }
  let restored = restore_with(tip, parents, selection)
  assert_eq(get(restored, "selected"), Number(2.0))
  assert_eq(get(restored, "total_files"), Number(4.0))
  assert_eq(paths_of(arr(get(restored, "files"))), ["docs/a.md", "docs/b.md"])
  // Payloads still resolve through the chain.
  let files = arr(get(restored, "files"))
  assert_eq(get(files[0], "bytes"), String("YWxwaGE="))
}

///|
test "restore selects an exact file and honours the component boundary" {
  let chain = chain_of_three()
  let tip = chain[2]
  let parents = [chain[0], chain[1]]
  let exact = restore_with(tip, parents, { prefixes: Some(["notes.txt"]), })
  assert_eq(paths_of(arr(get(exact, "files"))), ["notes.txt"])
  // "doc" is not a prefix of "docs/a.md": selections match whole components.
  let partial = try {
    ignore(restore_with(tip, parents, { prefixes: Some(["doc"]), }))
    false
  } catch {
    _ => true
  }
  assert_true(partial)
}

///|
test "restore merges several selections without duplicates" {
  let chain = chain_of_three()
  let tip = chain[2]
  let parents = [chain[0], chain[1]]
  let restored = restore_with(tip, parents, {
    prefixes: Some(["top.txt", "docs", "docs/a.md"]),
  })
  assert_eq(paths_of(arr(get(restored, "files"))), [
    "docs/a.md", "docs/b.md", "top.txt",
  ])
  assert_eq(get(restored, "selected"), Number(3.0))
}

///|
test "restore refuses an unknown or unsafe selection" {
  let chain = chain_of_three()
  let tip = chain[2]
  let parents = [chain[0], chain[1]]
  let unknown = try {
    ignore(restore_with(tip, parents, { prefixes: Some(["missing.txt"]), }))
    false
  } catch {
    _ => true
  }
  assert_true(unknown)
  let escaped = try {
    ignore(
      run(
        record([
          ("operation", String("restore")),
          ("snapshot", tip),
          ("parents", Array(parents)),
          ("paths", strings(["../escape"])),
        ]),
      ),
    )
    false
  } catch {
    _ => true
  }
  assert_true(escaped)
  let empty = try {
    ignore(
      run(
        record([
          ("operation", String("restore")),
          ("snapshot", tip),
          ("parents", Array(parents)),
          ("paths", strings([])),
        ]),
      ),
    )
    false
  } catch {
    _ => true
  }
  assert_true(empty)
}

///|
test "squash then restore needs no chain" {
  let chain = chain_of_three()
  let squashed = get(
    squash_with(chain[2], [chain[0], chain[1]], Some(3)),
    "snapshot",
  )
  let restored = restore_with(squashed, [], { prefixes: None, })
  assert_eq(get(restored, "chain_depth"), Number(1.0))
  assert_eq(paths_of(arr(get(restored, "files"))), [
    "docs/a.md", "docs/b.md", "notes.txt", "top.txt",
  ])
  // Selecting from a squashed snapshot behaves the same as from the chain.
  let selected = restore_with(squashed, [], { prefixes: Some(["notes.txt"]), })
  assert_eq(paths_of(arr(get(selected, "files"))), ["notes.txt"])
}

///|
test "squash compacts repeatedly without drift" {
  let chain = chain_of_three()
  let once = get(
    squash_with(chain[2], [chain[0], chain[1]], Some(2)),
    "snapshot",
  )
  let twice = get(squash_with(once, [], Some(2)), "snapshot")
  assert_eq(str(get(once, "checksum")), str(get(twice, "checksum")))
  assert_eq(canonical(get(once, "objects")), canonical(get(twice, "objects")))
  // Across formats the checksum changes but the payloads do not.
  let legacy = get(squash_with(once, [], Some(1)), "snapshot")
  assert_eq(obj(get(legacy, "objects")).length(), 4)
  assert_eq(
    digest_of("alpha"),
    str(get(arr(get(legacy, "files"))[0], "digest")),
  )
}
