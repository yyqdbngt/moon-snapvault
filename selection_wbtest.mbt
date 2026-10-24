///|
/// The rule a selection has to obey, written out independently of the
/// implementation: a path selects itself and everything below it, on whole
/// components.
fn reference_selects(prefixes : Array[String], path : String) -> Bool {
  for prefix in prefixes {
    if path == prefix || path.has_prefix(prefix + "/") {
      return true
    }
  }
  false
}

///|
test "component prefixes are the path and each directory above it" {
  assert_eq(component_prefixes("a/b/c"), ["a/b/c", "a/b", "a"])
  assert_eq(component_prefixes("a"), ["a"])
  // A leading separator is not a path this project accepts, but the helper is
  // total and must not lose a component.
  assert_eq(component_prefixes("a/"), ["a/", "a"])
}

///|
test "matching agrees with the definition on every case" {
  let paths = [
    "a", "b", "a/b", "a/b/c", "a/c", "ab", "a/bc", "docs/one.md", "docs/deep/two.md",
    "doc", "docs", "a.b", "a/b.txt",
  ]
  let prefixes_to_try = [
    "a", "b", "a/b", "a/b/c", "ab", "docs", "docs/one.md", "doc", "docs/deep", "a/bc",
    "a.b",
  ]
  for first in prefixes_to_try {
    for second in prefixes_to_try {
      let prefixes = [first, second]
      let selection = selection_of(prefixes)
      for path in paths {
        assert_eq(selects(selection, path), reference_selects(prefixes, path))
      }
    }
  }
}

///|
test "a single path selects itself and its descendants only" {
  let selection = selection_of(["docs"])
  assert_true(selects(selection, "docs"))
  assert_true(selects(selection, "docs/one.md"))
  assert_true(selects(selection, "docs/deep/two.md"))
  assert_false(selects(selection, "doc"))
  assert_false(selects(selection, "docsx"))
  assert_false(selects(selection, "docsx/one.md"))
  assert_false(selects(selection, "other/docs"))
}

///|
test "the empty selection selects everything" {
  assert_true(selects(all_selection, "anything"))
  assert_true(selects(all_selection, ""))
}

///|
test "unresolved paths are reported once each, sorted" {
  let listed : Array[Value] = [
    record([("path", String("docs/one.md"))]),
    record([("path", String("a.txt"))]),
  ]
  // "docs" is satisfied by docs/one.md; "zzz" and "aaa" are not.
  let missing = unresolved_selection(
    selection_of(["docs", "zzz", "aaa"]),
    listed,
  )
  assert_eq(missing, ["aaa", "zzz"])
  // Everything satisfied means nothing reported, including a parent of a file.
  assert_eq(
    unresolved_selection(selection_of(["docs", "for-docs"]), [
      record([("path", String("docs/one.md"))]),
      record([("path", String("for-docs/x"))]),
    ]),
    [],
  )
  // No selection means nothing to resolve.
  assert_eq(unresolved_selection(all_selection, []), [])
}

///|
test "matching stays linear in files and paths" {
  // This is a guard, not a benchmark: quadratic matching took seconds at this
  // size and minutes at the size a 16 MiB request allows. The assertion is on the
  // result, and the test simply has to finish quickly.
  let files : Array[Value] = []
  let prefixes : Array[String] = []
  for index = 0; index < 2000; index = index + 1 {
    files.push(record([("path", String("d" + index.to_string() + "/f.txt"))]))
    prefixes.push("x" + index.to_string())
  }
  // Nothing matches: every prefix has to be reported, which is the case that used
  // to require comparing each prefix against every file.
  assert_eq(unresolved_selection(selection_of(prefixes), files).length(), 2000)
  // And with one real match, only that one is dropped.
  prefixes.push("d1999")
  assert_eq(unresolved_selection(selection_of(prefixes), files).length(), 2000)
}
