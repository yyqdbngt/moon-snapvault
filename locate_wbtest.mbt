///|
/// A chain whose links each store something the tip needs.
fn locate_chain() -> Array[Value] raise {
  let base = get(
    create_snapshot(
      [
        record([("path", String("a.txt")), ("text", String("aaa"))]),
        record([("path", String("docs/b.md")), ("text", String("bbb"))]),
      ],
      format=3,
    ),
    "snapshot",
  )
  let middle = get(
    create_snapshot(
      [
        record([("path", String("a.txt")), ("text", String("aaa"))]),
        record([("path", String("docs/b.md")), ("text", String("bbb"))]),
        record([("path", String("c.txt")), ("text", String("ccc"))]),
      ],
      previous=base,
      format=3,
    ),
    "snapshot",
  )
  let tip = get(
    create_snapshot(
      [
        record([("path", String("a.txt")), ("text", String("aaa"))]),
        record([("path", String("docs/b.md")), ("text", String("bbb"))]),
        record([("path", String("c.txt")), ("text", String("ccc"))]),
        record([("path", String("d.txt")), ("text", String("ddd"))]),
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
/// The manifest-only shape a caller sends when the chain is too large to ship.
fn manifest_only(snapshot : Value) -> Value raise {
  let stored : Array[Value] = []
  for digest, _ in obj(get(snapshot, "objects")) {
    stored.push(String(digest))
  }
  record([
    ("version", get(snapshot, "version")),
    ("parent", get(snapshot, "parent")),
    ("files", get(snapshot, "files")),
    ("checksum", get(snapshot, "checksum")),
    ("stored_digests", Array(stored)),
  ])
}

///|
/// Reads a JSON array of strings back as a MoonBit array, so an assertion can
/// compare plain values instead of Json constructors.
fn parse_json_strings(value : Value) -> Array[String] raise {
  arr(value).map(item => str(item))
}

///|
test "locate names the link that stores each payload" {
  let chain = locate_chain()
  let located = locate_with(
    manifest_only(chain[2]),
    [manifest_only(chain[0]), manifest_only(chain[1])],
    all_files,
  )
  assert_eq(get(located, "chain_depth"), Number(3.0))
  assert_eq(arr(get(located, "unresolved")).length(), 0)
  assert_eq(get(located, "missing_parent"), Null)
  // By path: the manifest is sorted, so positions are not the interesting part.
  let link_of : Map[String, String] = Map([])
  for entry in arr(get(located, "files")) {
    link_of[str(get(entry, "path"))] = str(get(entry, "link"))
  }
  assert_eq(link_of["a.txt"], str(get(chain[0], "checksum")))
  assert_eq(link_of["docs/b.md"], str(get(chain[0], "checksum")))
  assert_eq(link_of["c.txt"], str(get(chain[1], "checksum")))
  assert_eq(link_of["d.txt"], str(get(chain[2], "checksum")))
}

///|
test "locate needs no payloads at all" {
  let chain = locate_chain()
  // Every link is manifest-only: no `objects` member anywhere.
  for link in chain {
    assert_eq(get(manifest_only(link), "objects"), Null)
  }
  let located = locate_with(
    manifest_only(chain[2]),
    [manifest_only(chain[0]), manifest_only(chain[1])],
    all_files,
  )
  assert_eq(arr(get(located, "files")).length(), 4)
}

///|
test "locate honours a selection and refuses an unknown path" {
  let chain = locate_chain()
  let parents = [manifest_only(chain[0]), manifest_only(chain[1])]
  let located = locate_with(
    manifest_only(chain[2]),
    parents,
    selection_of(["docs"]),
  )
  assert_eq(arr(get(located, "files")).length(), 1)
  assert_eq(str(get(arr(get(located, "files"))[0], "path")), "docs/b.md")
  let unknown = try {
    ignore(
      locate_with(manifest_only(chain[2]), parents, selection_of(["nope"])),
    )
    false
  } catch {
    _ => true
  }
  assert_true(unknown)
}

///|
test "locate reports a missing link instead of failing" {
  let chain = locate_chain()
  let located = locate_with(
    manifest_only(chain[2]),
    [manifest_only(chain[0])],
    all_files,
  )
  assert_eq(get(located, "missing_parent"), get(chain[1], "checksum"))
  // The tip is the only link that could be walked before the gap.
  assert_eq(get(located, "chain_depth"), Number(1.0))
}

///|
test "locate reports digests no link stores" {
  // A manifest that names a digest nothing holds, with a checksum that matches.
  let phantom = digest_of("phantom")
  let files = [
    record([
      ("path", String("a.txt")),
      ("digest", String(digest_of("aaa"))),
      ("size", Number(3.0)),
      ("mode", Number(420.0)),
    ]),
    record([
      ("path", String("b.txt")),
      ("digest", String(phantom)),
      ("size", Number(7.0)),
      ("mode", Number(420.0)),
    ]),
  ]
  let held : Map[String, Value] = Map([])
  held[digest_of("aaa")] = String("YWFh")
  let forged = record([
    ("version", Number(3.0)),
    ("parent", Null),
    ("files", Array(files)),
    ("objects", Object(held)),
    ("checksum", String(checksum(3, None, files))),
  ])
  let located = locate_with(forged, [], all_files)
  assert_eq(parse_json_strings(get(located, "unresolved")), [phantom])
  assert_eq(arr(get(located, "files")).length(), 1)
}

///|
test "extract returns verified payloads" {
  let chain = locate_chain()
  let base = chain[0]
  let wanted = [digest_of("aaa"), digest_of("bbb")]
  let got = extract_with(base, wanted, None)
  assert_eq(get(got, "verified"), Bool(true))
  assert_eq(get(got, "encoding"), String("base64"))
  let objects = obj(get(got, "objects"))
  assert_eq(objects[digest_of("aaa")], String("YWFh"))
  assert_eq(objects[digest_of("bbb")], String("YmJi"))
  assert_eq(get(got, "bytes"), Number(6.0))
}

///|
test "extract refuses a payload that does not match its digest" {
  let chain = locate_chain()
  let base = obj(chain[0]).copy()
  let objects = obj(base["objects"]).copy()
  objects[digest_of("aaa")] = String("dGFtcGVyZWQ=")
  base["objects"] = Object(objects)
  let wrong = digest_of("aaa")
  let refused = try {
    ignore(extract_with(Object(base), [wrong], None))
    false
  } catch {
    _ => true
  }
  assert_true(refused)
}

///|
test "extract refuses an absent or malformed digest" {
  let chain = locate_chain()
  let base = chain[0]
  let absent = try {
    ignore(extract_with(base, [digest_of("not stored here")], None))
    false
  } catch {
    _ => true
  }
  assert_true(absent)
  let malformed = try {
    ignore(extract_with(base, ["nope"], None))
    false
  } catch {
    _ => true
  }
  assert_true(malformed)
  // A snapshot without payloads cannot serve an extract.
  let bare = try {
    ignore(extract_with(manifest_only(base), [digest_of("aaa")], None))
    false
  } catch {
    _ => true
  }
  assert_true(bare)
}

///|
test "extract re-encodes for the reader" {
  let legacy = get(
    create_snapshot(
      [record([("path", String("a.txt")), ("text", String("aaa"))])],
      format=1,
    ),
    "snapshot",
  )
  let wanted = [digest_of("aaa")]
  let as_one = extract_with(legacy, wanted, None)
  assert_eq(get(as_one, "encoding"), String("decimal"))
  let as_three = extract_with(legacy, wanted, Some(3))
  assert_eq(get(as_three, "encoding"), String("base64"))
  assert_eq(obj(get(as_three, "objects"))[digest_of("aaa")], String("YWFh"))
}

///|
test "locate then extract reproduces a restore" {
  let chain = locate_chain()
  let parents = [chain[0], chain[1]]
  let located = locate_with(
    manifest_only(chain[2]),
    parents.map(manifest_only),
    all_files,
  )
  let by_link : Map[String, Array[String]] = Map([])
  for entry in arr(get(located, "files")) {
    let link = str(get(entry, "link"))
    let digest = str(get(entry, "digest"))
    match by_link.get(link) {
      Some(items) => items.push(digest)
      None => by_link[link] = [digest]
    }
  }
  let payloads : Map[String, String] = Map([])
  for holder in parents + [chain[2]] {
    match by_link.get(str(get(holder, "checksum"))) {
      None => ()
      Some(wanted) => {
        let got = extract_with(holder, wanted, Some(3))
        for digest, payload in obj(get(got, "objects")) {
          payloads[digest] = str(payload)
        }
      }
    }
  }
  let direct = restore_with(chain[2], parents, all_files)
  for file in arr(get(direct, "files")) {
    assert_eq(payloads[str(get(file, "digest"))], str(get(file, "bytes")))
  }
  assert_eq(payloads.length(), 4)
}

///|
test "assemble computes the same checksum as create" {
  let chain = locate_chain()
  let tip = chain[2]
  let files = arr(get(tip, "files"))
  let assembled = assemble_with(files, 3)
  assert_eq(get(assembled, "format"), Number(3.0))
  // `assemble` produces the self-contained form: same manifest, no parent. The
  // tip's own checksum covers a parent, so it must differ.
  assert_eq(get(assembled, "checksum") == get(tip, "checksum"), false)
  let squashed = get(
    squash_with(tip, [chain[0], chain[1]], Some(3)),
    "snapshot",
  )
  assert_eq(get(assembled, "checksum"), get(squashed, "checksum"))
}

///|
test "assemble rejects a manifest create would reject" {
  let cases : Array[Array[Value]] = [
    [
      record([
        ("path", String("../escape")),
        ("digest", String(digest_of("a"))),
        ("size", Number(1.0)),
        ("mode", Number(420.0)),
      ]),
    ],
    [
      record([
        ("path", String("same.txt")),
        ("digest", String(digest_of("a"))),
        ("size", Number(1.0)),
        ("mode", Number(420.0)),
      ]),
      record([
        ("path", String("SAME.txt")),
        ("digest", String(digest_of("b"))),
        ("size", Number(1.0)),
        ("mode", Number(420.0)),
      ]),
    ],
    [
      record([
        ("path", String("a.txt")),
        ("digest", String(digest_of("a"))),
        ("size", Number(1.0)),
        ("mode", Number(512.0)),
      ]),
    ],
  ]
  for files in cases {
    let refused = try {
      ignore(assemble_with(files, 3))
      false
    } catch {
      _ => true
    }
    assert_true(refused)
  }
}
