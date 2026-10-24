///|
/// The dispatch table in `run`, covered from the inside.
///
/// `run` is the entry the JSON CLI and any embedder go through, and four of its arms -
/// `assemble`, `locate`, `extract`, `squash` - were only ever reached through the Node
/// CLI, which `moon test` does not measure. Coverage made that visible: those branches
/// showed as never executed even though the fixtures exercise them.
///
/// These tests call each operation through `run` with the same shapes the fixtures use,
/// so the entry point is covered where the compiler can see it, and so the defaulting
/// rules inside the arms (an absent `format` meaning 2, an absent `paths` meaning all)
/// are asserted rather than assumed.
fn via_run(request : Value) -> Value raise {
  run(request)
}

///|
fn files_for_dispatch() -> Array[Value] {
  [
    record([("path", String("a.txt")), ("text", String("abc"))]),
    record([("path", String("docs/b.md")), ("text", String("de"))]),
  ]
}

///|
test "run dispatch: create is the default operation" {
  let explicit = via_run(
    record([
      ("operation", String("create")),
      ("files", Array(files_for_dispatch())),
    ]),
  )
  let implicit = via_run(record([("files", Array(files_for_dispatch()))]))
  assert_eq(
    str(get(get(explicit, "snapshot"), "checksum")),
    str(get(get(implicit, "snapshot"), "checksum")),
  )
}

///|
test "run dispatch: audit, diff, restore" {
  let created = get(
    via_run(record([("files", Array(files_for_dispatch()))])),
    "snapshot",
  )
  assert_eq(
    get(
      via_run(record([("operation", String("audit")), ("snapshot", created)])),
      "valid",
    ),
    Bool(true),
  )
  // Diff against itself is empty; the point is that the arm is reached and shaped.
  let diff = via_run(
    record([("operation", String("diff")), ("old", created), ("new", created)]),
  )
  assert_eq(arr(get(diff, "added")).length(), 0)
  let restored = via_run(
    record([("operation", String("restore")), ("snapshot", created)]),
  )
  assert_eq(arr(get(restored, "files")).length(), 2)
}

///|
/// `assemble` takes manifest entries, not content: it computes the checksum a manifest
/// would carry, so each entry needs `path`, `digest`, `size` and `mode`. `create` is the
/// operation that takes `text` or `bytes`. Writing this test with content-shaped files
/// was wrong and the core said so, which is the behaviour worth having.
fn manifest_entries() -> Array[Value] {
  [
    record([
      ("path", String("a.txt")),
      ("digest", String(digest(@utf8.encode("abc")))),
      ("size", Number(3.0)),
      ("mode", Number(420.0)),
    ]),
    record([
      ("path", String("docs/b.md")),
      ("digest", String(digest(@utf8.encode("de")))),
      ("size", Number(2.0)),
      ("mode", Number(420.0)),
    ]),
  ]
}

///|
test "run dispatch: assemble defaults to format 2" {
  let without = via_run(
    record([
      ("operation", String("assemble")),
      ("files", Array(manifest_entries())),
    ]),
  )
  assert_eq(get(without, "format"), Number(2.0))
  let with3 = via_run(
    record([
      ("operation", String("assemble")),
      ("files", Array(manifest_entries())),
      ("format", Number(3.0)),
    ]),
  )
  assert_eq(get(with3, "format"), Number(3.0))
  // Same manifest, different version: the checksums must differ, which is what keeps the
  // two formats distinguishable.
  assert_eq(str(get(without, "checksum")) == str(get(with3, "checksum")), false)
}

///|
test "run dispatch: locate, extract, squash" {
  let created = get(
    via_run(
      record([("files", Array(files_for_dispatch())), ("format", Number(3.0))]),
    ),
    "snapshot",
  )
  let checksum = str(get(created, "checksum"))
  // A manifest-only copy, which is what `locate` is for.
  let stored : Array[Value] = []
  for hash, _ in obj(get(created, "objects")) {
    stored.push(String(hash))
  }
  let manifest = record([
    ("version", get(created, "version")),
    ("parent", get(created, "parent")),
    ("files", get(created, "files")),
    ("checksum", String(checksum)),
    ("stored_digests", Array(stored)),
  ])

  let located = via_run(
    record([("operation", String("locate")), ("snapshot", manifest)]),
  )
  assert_eq(get(located, "chain_depth"), Number(1.0))
  assert_eq(get(located, "missing_parent"), Null)
  assert_eq(arr(get(located, "files")).length(), 2)

  // `locate` honours a selection through the same request field `restore` uses.
  let selected = via_run(
    record([
      ("operation", String("locate")),
      ("snapshot", manifest),
      ("paths", Array([String("docs")])),
    ]),
  )
  assert_eq(arr(get(selected, "files")).length(), 1)

  let digests : Array[Value] = []
  digests.push(String(str(get(arr(get(created, "files"))[0], "digest"))))
  let extracted = via_run(
    record([
      ("operation", String("extract")),
      ("snapshot", created),
      ("digests", Array(digests)),
    ]),
  )
  assert_eq(get(extracted, "verified"), Bool(true))
  assert_eq(obj(get(extracted, "objects")).length(), 1)

  // Squash of a self-contained snapshot keeps the manifest and drops the parent key's
  // meaning, so the result must be self-contained and readable. `audited` is the
  // adapter's word for the audit it runs afterwards; the core returns `statistics`.
  let squashed = via_run(
    record([
      ("operation", String("squash")),
      ("snapshot", created),
      ("format", Number(2.0)),
    ]),
  )
  assert_eq(get(get(squashed, "snapshot"), "version"), Number(2.0))
  assert_eq(get(get(squashed, "statistics"), "files"), Number(2.0))
  // The squashed snapshot must be readable on its own, without the original.
  let reread = via_run(
    record([
      ("operation", String("audit")),
      ("snapshot", get(squashed, "snapshot")),
    ]),
  )
  assert_eq(get(reread, "valid"), Bool(true))
}

///|
test "run dispatch: an unknown operation is refused by name" {
  let refused = try {
    ignore(via_run(record([("operation", String("frobnicate"))])))
    false
  } catch {
    _ => true
  }
  assert_true(refused)
}
