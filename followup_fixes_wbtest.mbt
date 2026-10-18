///|
test "recomputed checksum cannot legitimize an invalid file mode" {
  let request = record([
    ("files", Array([record([("path", String("a")), ("text", String("abc"))])])),
  ])
  let snapshot = obj(get(run(request), "snapshot")).copy()
  let files = arr(snapshot["files"])
  let first = obj(files[0]).copy()
  first["mode"] = Number(512.0)
  files[0] = Object(first)
  snapshot["checksum"] = String(checksum(files))
  let bad = try {
    ignore(audit_snapshot(Object(snapshot)))
    false
  } catch {
    _ => true
  }
  assert_true(bad)
}
