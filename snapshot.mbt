///|
pub fn safe_path(path : String) -> Bool {
  if path == "" ||
    path.has_prefix("/") ||
    path.contains("\\") ||
    path.contains(":") {
    return false
  }
  for c in path {
    if c.to_int() < 32 || ['<', '>', '"', '|', '?', '*'].contains(c) {
      return false
    }
  }
  for part in path.split("/") {
    if part == "" ||
      part == "." ||
      part == ".." ||
      part.has_suffix(".") ||
      part.has_suffix(" ") {
      return false
    }
    let stem = part.to_owned().split(".").head().unwrap().to_owned().to_lower()
    if [
        "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6",
        "com7", "com8", "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7",
        "lpt8", "lpt9",
      ].contains(stem) {
      return false
    }
  }
  true
}

///|
fn path_of(file : Value) -> String {
  match file {
    Object(fields) =>
      match fields.get("path") {
        Some(String(path)) => path
        _ => ""
      }
    _ => ""
  }
}

///|
fn bytes_value(bytes : Bytes) -> Value {
  Array(bytes.iter().map(fn(b) { Number(b.to_int().to_double()) }).collect())
}

///|
fn is_byte(number : Double) -> Bool {
  !number.is_nan() &&
  !number.is_inf() &&
  number >= 0.0 &&
  number <= 255.0 &&
  number.floor() == number
}

///|
fn decode_bytes_opt(value : Value) -> Bytes? {
  match value {
    Array(values) => {
      let decoded = Some(
        Bytes::makei(values.length(), fn(i) raise {
          match values[i] {
            Number(number) if is_byte(number) => number.to_int().to_byte()
            _ => raise InputError("invalid byte value")
          }
        }),
      ) catch {
        _ => None
      }
      decoded
    }
    _ => None
  }
}

///|
fn decode_bytes(value : Value) -> Bytes raise {
  match decode_bytes_opt(value) {
    Some(bytes) => bytes
    None => raise InputError("invalid byte value")
  }
}

///|
/// Base64 is the compact wire form: one byte costs four characters instead of
/// the up to four characters of a decimal array, and it avoids materialising a
/// JSON array of numbers for every file.
fn base64_to_bytes(text : String) -> Bytes? {
  base64_decode(text)
}

///|
fn encode_object(version : Int32, bytes : Bytes) -> Value {
  if version == 1 {
    bytes_value(bytes)
  } else {
    String(base64_encode(bytes))
  }
}

///|
fn decode_object(version : Int32, raw : Value) -> Bytes? {
  if version == 1 {
    decode_bytes_opt(raw)
  } else {
    match raw {
      String(text) => base64_to_bytes(text)
      _ => None
    }
  }
}

///|
fn content(file : Value) -> Bytes raise {
  let text = get(file, "text")
  let bytes = get(file, "bytes")
  let encoded = get(file, "content_base64")
  let mut provided = 0
  if text != Null {
    provided += 1
  }
  if bytes != Null {
    provided += 1
  }
  if encoded != Null {
    provided += 1
  }
  if provided != 1 {
    raise InputError(
      "file must provide exactly one of text, bytes or content_base64",
    )
  }
  if text != Null {
    @utf8.encode(str(text))
  } else if bytes != Null {
    decode_bytes(bytes)
  } else {
    match base64_to_bytes(str(encoded)) {
      Some(decoded) => decoded
      None => raise InputError("invalid content_base64")
    }
  }
}

///|
fn checksum(version : Int32, files : Array[Value]) -> String {
  digest(
    @utf8.encode(
      canonical(
        record([
          ("version", Number(version.to_double())),
          ("files", Array(files)),
        ]),
      ),
    ),
  )
}

///|
/// Version 1 stores object payloads as arrays of decimal byte values; version 2
/// stores them as base64 text. Both are readable; `create` writes version 2
/// unless the request asks for `"format": 1`.
fn snapshot_version(snapshot : Value) -> Int32 raise {
  match get(snapshot, "version") {
    Number(n) if n == 1.0 => 1
    Number(n) if n == 2.0 => 2
    _ => raise InputError("unsupported snapshot version")
  }
}

///|
/// Returns the snapshot format version together with its validated files.
fn manifest(snapshot : Value) -> (Int32, Array[Value]) raise {
  let version = snapshot_version(snapshot)
  let files = arr(get(snapshot, "files"))
  if get(snapshot, "checksum") != String(checksum(version, files)) {
    raise InputError("manifest checksum mismatch")
  }
  let paths : Map[String, Bool] = Map([])
  let names : Map[String, String] = Map([])
  for file in files {
    let path = str(get(file, "path"))
    if !safe_path(path) || paths.contains(path.to_lower()) {
      raise InputError("unsafe or duplicate snapshot path")
    }
    paths[path.to_lower()] = true
    let mut prefix = ""
    for part in path.split("/") {
      prefix += (if prefix == "" { "" } else { "/" }) + part.to_owned()
      let key = prefix.to_lower()
      match names.get(key) {
        Some(existing) =>
          if existing != prefix {
            raise InputError("case-folded directory collision")
          }
        None => names[key] = prefix
      }
    }
    let size = num(get(file, "size"))
    if size < 0.0 || size.floor() != size {
      raise InputError("invalid file size")
    }
    let mode = num(get(file, "mode"))
    if mode < 0.0 || mode > 511.0 || mode.floor() != mode {
      raise InputError("invalid manifest file mode")
    }
    let hash = str(get(file, "digest"))
    if !is_object_id(hash) {
      raise InputError("invalid SHA-256 identifier")
    }
  }
  for file in files {
    let mut parent = str(get(file, "path"))
    while true {
      match parent.rev_split_once("/") {
        None => break
        Some((before, _)) => parent = before.to_owned()
      }
      if paths.contains(parent.to_lower()) {
        raise InputError("file/directory path collision")
      }
    }
  }
  (version, files)
}

///|
fn is_object_id(hash : String) -> Bool {
  hash.length() == 64 &&
  hash
  .to_array()
  .all(fn(c) { (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') })
}

///|
fn issue(path : Value, object : String, reason : String) -> Value {
  record([
    ("path", path),
    ("object", String(object)),
    ("reason", String(reason)),
  ])
}

///|
pub fn audit_snapshot(snapshot : Value) -> Value raise {
  let (version, files) = manifest(snapshot)
  let objects = obj(get(snapshot, "objects"))
  let issues : Array[Value] = []
  let referenced : Map[String, Bool] = Map([])
  for file in files {
    referenced[str(get(file, "digest"))] = true
  }
  // Every stored object is verified, referenced or not: a snapshot with a
  // corrupt unreferenced object is not reported as valid.
  let mut checked = 0
  let mut unreferenced = 0
  for hash, raw in objects {
    if !is_object_id(hash) {
      issues.push(issue(Null, hash, "invalid object identifier"))
      continue
    }
    if !referenced.contains(hash) {
      unreferenced += 1
    }
    match decode_object(version, raw) {
      None => issues.push(issue(Null, hash, "invalid object encoding"))
      Some(bytes) => {
        checked += 1
        if digest(bytes) != hash {
          issues.push(issue(Null, hash, "digest mismatch"))
        }
      }
    }
  }
  for file in files {
    let hash = str(get(file, "digest"))
    let path = String(str(get(file, "path")))
    match objects.get(hash) {
      None => issues.push(issue(path, hash, "missing object"))
      Some(raw) =>
        match decode_object(version, raw) {
          None => ()
          Some(bytes) =>
            if Number(bytes.length().to_double()) != get(file, "size") {
              issues.push(issue(path, hash, "size mismatch"))
            }
        }
    }
  }
  record([
    ("valid", Bool(issues.is_empty())),
    ("issues", Array(issues)),
    ("format", Number(version.to_double())),
    ("files", Number(files.length().to_double())),
    ("objects_total", Number(objects.length().to_double())),
    ("objects_checked", Number(checked.to_double())),
    ("referenced_objects", Number(referenced.length().to_double())),
    ("unreferenced_objects", Number(unreferenced.to_double())),
  ])
}

///|
pub fn diff_snapshots(old : Value, new : Value) -> Value raise {
  let before : Map[String, Value] = Map([])
  let after : Map[String, Value] = Map([])
  for file in manifest(old).1 {
    before[str(get(file, "path"))] = file
  }
  for file in manifest(new).1 {
    after[str(get(file, "path"))] = file
  }
  let added : Array[String] = []
  let removed : Array[String] = []
  let modified : Array[String] = []
  for path, file in after {
    match before.get(path) {
      None => added.push(path)
      Some(previous) => if previous != file { modified.push(path) }
    }
  }
  for path, _ in before {
    if !after.contains(path) {
      removed.push(path)
    }
  }
  sort_strings(added)
  sort_strings(removed)
  sort_strings(modified)
  record([
    ("added", strings(added)),
    ("removed", strings(removed)),
    ("modified", strings(modified)),
  ])
}

///|
pub fn create_snapshot(
  source : Array[Value],
  previous~ : Value = Null,
  format~ : Int32 = 2,
) -> Value raise {
  if format != 1 && format != 2 {
    raise InputError("unsupported snapshot format")
  }
  let objects : Map[String, Value] = Map([])
  let files : Array[Value] = []
  let mut bytes_total = 0.0
  let mut unique_bytes = 0.0
  let mut new_bytes = 0.0
  let prior = if previous == Null {
    Map([])
  } else {
    if get(audit_snapshot(previous), "valid") != Bool(true) {
      raise InputError("previous snapshot is corrupted")
    }
    obj(get(previous, "objects"))
  }
  for file in source {
    let path = str(get(file, "path"))
    if !safe_path(path) {
      raise InputError("unsafe source path")
    }
    let bytes = content(file)
    let hash = digest(bytes)
    bytes_total += bytes.length().to_double()
    if !objects.contains(hash) {
      unique_bytes += bytes.length().to_double()
      objects[hash] = encode_object(format, bytes)
      if !prior.contains(hash) {
        new_bytes += bytes.length().to_double()
      }
    }
    let mode = optional_num(get(file, "mode"), 420.0)
    if mode < 0.0 || mode > 511.0 || mode.floor() != mode {
      raise InputError("invalid file mode")
    }
    files.push(
      record([
        ("path", String(path)),
        ("digest", String(hash)),
        ("size", Number(bytes.length().to_double())),
        ("mode", Number(mode)),
      ]),
    )
  }
  files.sort_by(fn(a, b) { lexical(path_of(a), path_of(b)) })
  let snapshot = record([
    ("version", Number(format.to_double())),
    ("files", Array(files)),
    ("objects", Object(objects)),
    ("checksum", String(checksum(format, files))),
  ])
  ignore(manifest(snapshot))
  record([
    ("snapshot", snapshot),
    (
      "statistics",
      record([
        ("total_bytes", Number(bytes_total)),
        ("unique_bytes", Number(unique_bytes)),
        ("new_object_bytes", Number(new_bytes)),
        ("deduplicated_bytes", Number(bytes_total - unique_bytes)),
      ]),
    ),
    (
      "changes",
      if previous == Null {
        Null
      } else {
        diff_snapshots(previous, snapshot)
      },
    ),
  ])
}

///|
fn requested_format(request : Value) -> Int32 raise {
  match get(request, "format") {
    Null => 2
    Number(n) if n == 1.0 => 1
    Number(n) if n == 2.0 => 2
    _ => raise InputError("unsupported snapshot format")
  }
}

///|
pub fn run(request : Value) -> Value raise {
  match optional_str(get(request, "operation"), "create") {
    "retention" => retention_plan(request)
    "create" =>
      create_snapshot(
        arr(get(request, "files")),
        previous=get(request, "previous"),
        format=requested_format(request),
      )
    "audit" => audit_snapshot(get(request, "snapshot"))
    "diff" => diff_snapshots(get(request, "old"), get(request, "new"))
    "restore" => {
      let snapshot = get(request, "snapshot")
      let report = audit_snapshot(snapshot)
      if get(report, "valid") != Bool(true) {
        raise InputError("cannot restore corrupted snapshot")
      }
      let (version, listed) = manifest(snapshot)
      let objects = obj(get(snapshot, "objects"))
      // The payload keeps the encoding it was validated in, so the host adapter
      // never has to re-expand a decimal array it did not ask for.
      let files = listed.map(file => {
        let result = obj(file).copy()
        result["bytes"] = objects[str(get(file, "digest"))]
        Object(result)
      })
      record([
        ("format", Number(version.to_double())),
        ("encoding", String(if version == 1 { "decimal" } else { "base64" })),
        ("files", Array(files)),
        ("verified", Bool(true)),
      ])
    }
    _ => raise InputError("unknown snapshot operation")
  }
}
