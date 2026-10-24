///|
pub fn digest(bytes : Bytes) -> String {
  let state = @sha256.Digest::new()
  for byte in bytes {
    state.write(byte)
  }
  state.check_sum()
}

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
      let bytes : Array[Byte] = []
      for item in values {
        match item {
          Number(number) if is_byte(number) =>
            bytes.push(number.to_int().to_byte())
          _ => return None
        }
      }
      Some(Bytes::from_array(bytes))
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
fn content(file : Value) -> Bytes raise {
  let text = get(file, "text")
  let bytes = get(file, "bytes")
  if text != Null && bytes != Null {
    raise InputError("file cannot provide text and bytes together")
  }
  if text != Null {
    @utf8.encode(str(text))
  } else {
    decode_bytes(bytes)
  }
}

///|
fn checksum(files : Array[Value]) -> String {
  digest(
    @utf8.encode(
      canonical(record([("version", Number(1.0)), ("files", Array(files))])),
    ),
  )
}

///|
fn manifest(snapshot : Value) -> Array[Value] raise {
  if get(snapshot, "version") != Number(1.0) {
    raise InputError("unsupported snapshot version")
  }
  let files = arr(get(snapshot, "files"))
  if get(snapshot, "checksum") != String(checksum(files)) {
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
  files
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
  let files = manifest(snapshot)
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
    match decode_bytes_opt(raw) {
      None => issues.push(issue(Null, hash, "invalid byte encoding"))
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
        match decode_bytes_opt(raw) {
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
  for file in manifest(old) {
    before[str(get(file, "path"))] = file
  }
  for file in manifest(new) {
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
) -> Value raise {
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
      objects[hash] = bytes_value(bytes)
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
    ("version", Number(1.0)),
    ("files", Array(files)),
    ("objects", Object(objects)),
    ("checksum", String(checksum(files))),
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
pub fn run(request : Value) -> Value raise {
  match optional_str(get(request, "operation"), "create") {
    "retention" => retention_plan(request)
    "create" =>
      create_snapshot(
        arr(get(request, "files")),
        previous=get(request, "previous"),
      )
    "audit" => audit_snapshot(get(request, "snapshot"))
    "diff" => diff_snapshots(get(request, "old"), get(request, "new"))
    "restore" => {
      let snapshot = get(request, "snapshot")
      let report = audit_snapshot(snapshot)
      if get(report, "valid") != Bool(true) {
        raise InputError("cannot restore corrupted snapshot")
      }
      let objects = obj(get(snapshot, "objects"))
      let files = manifest(snapshot).map(file => {
        let result = obj(file).copy()
        result["bytes"] = objects[str(get(file, "digest"))]
        Object(result)
      })
      record([("files", Array(files)), ("verified", Bool(true))])
    }
    _ => raise InputError("unknown snapshot operation")
  }
}
