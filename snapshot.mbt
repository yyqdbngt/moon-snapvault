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
/// The manifest checksum. Format 3 binds the parent identity into it, so a delta
/// cannot be re-pointed at a different base without invalidating the checksum.
fn checksum(version : Int32, parent : String?, files : Array[Value]) -> String {
  let body = if version >= 3 {
    let parent_value = match parent {
      None => Null
      Some(hash) => String(hash)
    }
    record([
      ("version", Number(version.to_double())),
      ("parent", parent_value),
      ("files", Array(files)),
    ])
  } else {
    record([("version", Number(version.to_double())), ("files", Array(files))])
  }
  digest(@utf8.encode(canonical(body)))
}

///|
/// - 1: object payloads are arrays of decimal byte values, self contained.
/// - 2: payloads are base64 text, self contained.
/// - 3: payloads are base64, and `parent` may name the snapshot whose objects
///   this one reuses; a format 3 snapshot with no parent is self contained.
fn snapshot_version(snapshot : Value) -> Int32 raise {
  match get(snapshot, "version") {
    Number(n) if n == 1.0 => 1
    Number(n) if n == 2.0 => 2
    Number(n) if n == 3.0 => 3
    _ => raise InputError("unsupported snapshot version")
  }
}

///|
fn snapshot_parent(version : Int32, snapshot : Value) -> String? raise {
  match get(snapshot, "parent") {
    Null => None
    String(hash) => {
      if version < 3 {
        raise InputError("only format 3 snapshots may declare a parent")
      }
      if !is_object_id(hash) {
        raise InputError("invalid parent snapshot identifier")
      }
      Some(hash)
    }
    _ => raise InputError("invalid parent snapshot identifier")
  }
}

///|
/// Returns the snapshot format version, its optional parent identity and its
/// validated files.
fn manifest(snapshot : Value) -> (Int32, String?, Array[Value]) raise {
  let version = snapshot_version(snapshot)
  let parent = snapshot_parent(version, snapshot)
  let files = arr(get(snapshot, "files"))
  if get(snapshot, "checksum") != String(checksum(version, parent, files)) {
    raise InputError("manifest checksum mismatch")
  }
  // Only structural contradictions are rejected here: a path that cannot be
  // written anywhere, the same path listed twice, and a path that is both a file
  // and a directory. Whether two names collide after case folding or Unicode
  // normalisation depends on the destination filesystem, which this code cannot
  // see - a directory holding `Report.txt` and `report.txt` is legitimate on Linux
  // and refusing it here made such a directory impossible to back up at all. The
  // writer is what has to check, and `portablePaths` in the adapter does.
  let paths : Map[String, Bool] = Map([])
  for file in files {
    let path = str(get(file, "path"))
    if !safe_path(path) || paths.contains(path) {
      raise InputError("unsafe or duplicate snapshot path")
    }
    paths[path] = true
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
      if paths.contains(parent) {
        raise InputError("file/directory path collision")
      }
    }
  }
  (version, parent, files)
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
/// A validated snapshot in a parent chain: the version that decides its payload
/// encoding, and the objects it stores.
priv struct Link {
  /// The manifest checksum, which is how a reader names this link.
  checksum : String
  version : Int32
  objects : Map[String, Value]
}

///|
/// A chain deeper than this is refused rather than walked.
let max_chain_depth : Int32 = 64

///|
/// Walks the parent links of `snapshot`, matching each link against `parents` by
/// manifest checksum. Returns the links in order (this snapshot first) and, when
/// a link cannot be resolved, the identity that is missing.
fn resolve_chain(
  snapshot : Value,
  parents : Array[Value],
) -> (Array[Link], String?) raise {
  let available : Map[String, Value] = Map([])
  for candidate in parents {
    match get(candidate, "checksum") {
      String(id) =>
        if is_object_id(id) && !available.contains(id) {
          available[id] = candidate
        }
      _ => ()
    }
  }
  let links : Array[Link] = []
  let visited : Map[String, Bool] = Map([])
  let mut current = snapshot
  let mut depth = 0
  let mut missing : String? = None
  while true {
    let (version, parent, _) = manifest(current)
    let id = str(get(current, "checksum"))
    if visited.contains(id) {
      raise InputError("parent snapshot chain contains a cycle")
    }
    if depth >= max_chain_depth {
      raise InputError("parent snapshot chain is too deep")
    }
    visited[id] = true
    links.push({ checksum: id, version, objects: obj(get(current, "objects")), })
    match parent {
      None => break
      Some(hash) =>
        match available.get(hash) {
          None => {
            missing = Some(hash)
            break
          }
          Some(next) => current = next
        }
    }
    depth += 1
  }
  (links, missing)
}

///|
fn object_payload(links : Array[Link], hash : String) -> (Int32, Value)? {
  for link in links {
    match link.objects.get(hash) {
      Some(raw) => return Some((link.version, raw))
      None => ()
    }
  }
  None
}

///|
/// The payload for a reader that expects `target_version`'s encoding.
///
/// When the payload is already base64 and the reader wants base64, the stored
/// text is handed back unchanged: the audit has verified those bytes, and
/// decoding then re-encoding them would be pure work on every restore.
fn payload_for(
  links : Array[Link],
  hash : String,
  target_version : Int32,
) -> Value? {
  match object_payload(links, hash) {
    None => None
    Some((source_version, raw)) =>
      if source_version >= 2 && target_version >= 2 {
        Some(raw)
      } else {
        match decode_object(source_version, raw) {
          None => None
          Some(bytes) => Some(encode_object(target_version, bytes))
        }
      }
  }
}

///|
/// `parents` supplies the chain for a format 3 delta; it is empty for a self
/// contained snapshot.
fn audit_with(snapshot : Value, parents : Array[Value]) -> Value raise {
  let (version, parent, files) = manifest(snapshot)
  let (links, missing) = resolve_chain(snapshot, parents)
  let issues : Array[Value] = []
  let referenced : Map[String, Bool] = Map([])
  for file in files {
    referenced[str(get(file, "digest"))] = true
  }
  // Every object in the chain is verified, referenced or not, so `valid` covers
  // the bytes this snapshot depends on and not just the ones it stores.
  let checked : Map[String, Bool] = Map([])
  let sizes : Map[String, Double] = Map([])
  let inherited : Map[String, Bool] = Map([])
  let local_objects = obj(get(snapshot, "objects"))
  let mut checked_count = 0
  for index, link in links {
    for hash, raw in link.objects {
      if !is_object_id(hash) {
        issues.push(issue(Null, hash, "invalid object identifier"))
        continue
      }
      if index > 0 && !local_objects.contains(hash) {
        inherited[hash] = true
      }
      if checked.contains(hash) {
        continue
      }
      match decode_object(link.version, raw) {
        None => issues.push(issue(Null, hash, "invalid object encoding"))
        Some(bytes) => {
          checked[hash] = true
          checked_count += 1
          sizes[hash] = bytes.length().to_double()
          if digest(bytes) != hash {
            issues.push(issue(Null, hash, "digest mismatch"))
          }
        }
      }
    }
  }
  let mut unreferenced = 0
  for hash, _ in local_objects {
    if !referenced.contains(hash) {
      unreferenced += 1
    }
  }
  for file in files {
    let hash = str(get(file, "digest"))
    let path = String(str(get(file, "path")))
    match sizes.get(hash) {
      None => issues.push(issue(path, hash, "missing object"))
      Some(size) =>
        if Number(size) != get(file, "size") {
          issues.push(issue(path, hash, "size mismatch"))
        }
    }
  }
  match missing {
    Some(hash) => issues.push(issue(Null, hash, "missing parent snapshot"))
    None => ()
  }
  record([
    ("valid", Bool(issues.is_empty())),
    ("issues", Array(issues)),
    ("format", Number(version.to_double())),
    (
      "parent",
      match parent {
        None => Null
        Some(hash) => String(hash)
      },
    ),
    ("chain_depth", Number(links.length().to_double())),
    ("files", Number(files.length().to_double())),
    ("objects_total", Number(local_objects.length().to_double())),
    ("objects_inherited", Number(inherited.length().to_double())),
    ("objects_checked", Number(checked_count.to_double())),
    ("referenced_objects", Number(referenced.length().to_double())),
    ("unreferenced_objects", Number(unreferenced.to_double())),
  ])
}

///|
pub fn audit_snapshot(snapshot : Value) -> Value raise {
  audit_with(snapshot, [])
}

///|
pub fn diff_snapshots(old : Value, new : Value) -> Value raise {
  let before : Map[String, Value] = Map([])
  let after : Map[String, Value] = Map([])
  for file in manifest(old).2 {
    before[str(get(file, "path"))] = file
  }
  for file in manifest(new).2 {
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
/// The objects a snapshot stores, or `None` when the value carries no `objects`
/// member at all. A manifest-only snapshot is useful as a parent reference: its
/// checksum still verifies, because the checksum covers only the manifest.
fn stored_objects(snapshot : Value) -> Map[String, Value]? raise {
  match get(snapshot, "objects") {
    Null => None
    Object(fields) => Some(fields)
    _ => raise InputError("snapshot objects must be an object")
  }
}

///|
/// Digests a caller asserts are already stored somewhere in the chain. Each must
/// look like a SHA-256 identifier; whether the chain really holds them is checked
/// when the snapshot is read, because that is where the payloads actually arrive.
fn declared_objects(known : Array[String]) -> Map[String, Bool] raise {
  let declared : Map[String, Bool] = Map([])
  for digest in known {
    if !is_object_id(digest) {
      raise InputError("invalid known object identifier")
    }
    declared[digest] = true
  }
  declared
}

///|
pub fn create_snapshot(
  source : Array[Value],
  previous~ : Value = Null,
  parents~ : Array[Value] = [],
  known_objects~ : Array[String] = [],
  format~ : Int32 = 2,
) -> Value raise {
  if format != 1 && format != 2 && format != 3 {
    raise InputError("unsupported snapshot format")
  }
  let parent_id : String? = if previous == Null {
    None
  } else {
    Some(str(get(previous, "checksum")))
  }
  if parent_id is Some(_) && format < 3 {
    raise InputError("a parent chain requires format 3")
  }
  let objects : Map[String, Value] = Map([])
  let files : Array[Value] = []
  let mut bytes_total = 0.0
  let mut unique_bytes = 0.0
  let mut new_bytes = 0.0
  let mut reused_bytes = 0.0
  let mut objects_reused = 0
  // Digests the previous chain already stores. With format 3 those objects are
  // left out of the new snapshot entirely, which is what makes it incremental.
  let prior : Map[String, Bool] = Map([])
  let declared = declared_objects(known_objects)
  if !declared.is_empty() && parent_id is None {
    raise InputError("known_objects needs a previous snapshot to point at")
  }
  let mut base_verified = true
  if previous != Null {
    // A manifest-only parent cannot be audited here: its payloads never arrived,
    // which is the whole point of sending it that way. Its checksum is still
    // checked, so the link this snapshot records is meaningful, and the reader
    // verifies the payloads when it has the chain.
    let manifest_only = match stored_objects(previous) {
      Some(_) => false
      None => true
    }
    if manifest_only {
      let (_, _, parent_files) = manifest(previous)
      // An empty declaration is only wrong when the parent lists files: those
      // files have digests, so the payloads exist somewhere and the caller has
      // simply forgotten to say where. An empty parent has nothing to declare.
      if declared.is_empty() && !parent_files.is_empty() {
        raise InputError(
          "previous snapshot without objects needs known_objects",
        )
      }
      base_verified = false
    } else {
      if get(audit_with(previous, parents), "valid") != Bool(true) {
        raise InputError("previous snapshot is corrupted")
      }
      if format >= 3 {
        let (links, missing) = resolve_chain(previous, parents)
        match missing {
          Some(hash) => raise InputError("missing parent snapshot " + hash)
          None => ()
        }
        for link in links {
          for hash, _ in link.objects {
            prior[hash] = true
          }
        }
      } else {
        for hash, _ in obj(get(previous, "objects")) {
          prior[hash] = true
        }
      }
    }
  }
  for hash, _ in declared {
    prior[hash] = true
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
      if prior.contains(hash) {
        reused_bytes += bytes.length().to_double()
        objects_reused += 1
        if format < 3 {
          objects[hash] = encode_object(format, bytes)
        }
      } else {
        new_bytes += bytes.length().to_double()
        objects[hash] = encode_object(format, bytes)
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
  let fields : Array[(String, Value)] = [
    ("version", Number(format.to_double())),
  ]
  if format >= 3 {
    fields.push(
      (
        "parent",
        match parent_id {
          None => Null
          Some(hash) => String(hash)
        },
      ),
    )
  }
  fields.push(("files", Array(files)))
  fields.push(("objects", Object(objects)))
  fields.push(("checksum", String(checksum(format, parent_id, files))))
  let snapshot = record(fields)
  ignore(manifest(snapshot))
  record([
    ("snapshot", snapshot),
    (
      "statistics",
      record([
        ("total_bytes", Number(bytes_total)),
        ("unique_bytes", Number(unique_bytes)),
        ("new_object_bytes", Number(new_bytes)),
        ("reused_object_bytes", Number(reused_bytes)),
        ("deduplicated_bytes", Number(bytes_total - unique_bytes)),
        ("objects_stored", Number(objects.length().to_double())),
        ("objects_reused", Number(objects_reused.to_double())),
        ("base_verified", Bool(base_verified)),
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
  match optional_format(request) {
    None => 2
    Some(value) => value
  }
}

///|
/// `format` when the request names one; `None` lets the operation pick its own
/// default. `squash` keeps the snapshot's format, `create` writes format 2.
fn optional_format(request : Value) -> Int32? raise {
  match get(request, "format") {
    Null => None
    Number(n) if n == 1.0 => Some(1)
    Number(n) if n == 2.0 => Some(2)
    Number(n) if n == 3.0 => Some(3)
    _ => raise InputError("unsupported snapshot format")
  }
}

///|
/// `digests` names the payloads `extract` should return.
fn request_digests(request : Value) -> Array[String] raise {
  match get(request, "digests") {
    Null => []
    Array(items) => items.map(item => str(item))
    _ => raise InputError("digests must be an array of digests")
  }
}

///|
/// `known_objects` lists digests the chain already holds, so a delta does not have
/// to carry the payloads it reuses.
fn request_known_objects(request : Value) -> Array[String] raise {
  match get(request, "known_objects") {
    Null => []
    Array(items) => items.map(item => str(item))
    _ => raise InputError("known_objects must be an array of digests")
  }
}

///|
/// `parents` carries the chain a format 3 delta depends on. It is ignored when
/// the request has none, which is the self-contained case.
fn request_parents(request : Value) -> Array[Value] {
  match get(request, "parents") {
    Array(items) => items
    _ => {
      let empty : Array[Value] = []
      empty
    }
  }
}

///|
/// A restore selection: `None` means every file. A path selects the file with
/// that exact name and everything below it, so `docs` takes `docs/a.md` too.
///
/// `set` holds the same paths for lookup. Matching against the list would be
/// O(paths × files), which a request well inside the size cap can push into
/// minutes: 8000 paths against 8000 files already took six seconds.
priv struct Selection {
  prefixes : Array[String]?
  set : Map[String, Bool]
}

///|
/// Every file.
let all_selection : Selection = { prefixes: None, set: Map([]), }

///|
/// A selection over the given paths, already normalised by `request_selection`.
fn selection_of(paths : Array[String]) -> Selection raise {
  let set : Map[String, Bool] = Map([])
  for path in paths {
    if !safe_path(path) {
      raise InputError("unsafe restore path: " + path)
    }
    set[path] = true
  }
  { prefixes: Some(paths), set, }
}

///|
fn request_selection(request : Value) -> Selection raise {
  match get(request, "paths") {
    Null => all_selection
    Array(items) => {
      let prefixes : Array[String] = []
      for item in items {
        let raw = str(item)
        // A trailing separator is what shell completion produces; it selects the
        // same subtree, so it is stripped rather than rejected. Everything else
        // goes through the manifest rules unchanged.
        let mut normalized = raw
        while normalized.length() > 0 &&
              normalized.unsafe_get(normalized.length() - 1) == '/' {
          normalized = normalized[:normalized.length() - 1].to_owned()
        }
        if !safe_path(normalized) {
          raise InputError("unsafe restore path: " + raw)
        }
        prefixes.push(normalized)
      }
      if prefixes.is_empty() {
        raise InputError("paths must name at least one path")
      }
      selection_of(prefixes)
    }
    _ => raise InputError("paths must be an array of strings")
  }
}

///|
/// The path itself and each directory above it, longest first: `a/b/c` gives
/// `a/b/c`, `a/b`, `a`. A selection matches when any of these is selected, which
/// is the same rule as "the file is that path or sits below it".
fn component_prefixes(path : String) -> Array[String] {
  let out : Array[String] = [path]
  let mut current = path
  while true {
    match current.rev_split_once("/") {
      None => break
      Some((before, _)) => {
        current = before.to_owned()
        out.push(current)
      }
    }
  }
  out
}

///|
fn selects(selection : Selection, path : String) -> Bool {
  if selection.prefixes is None {
    return true
  }
  for candidate in component_prefixes(path) {
    if selection.set.contains(candidate) {
      return true
    }
  }
  false
}

///|
/// For each selected file, records which of the asked-for paths it satisfies.
/// One pass over the files, so the cost is files × depth rather than files ×
/// paths.
fn mark_matches(
  selection : Selection,
  listed : Array[Value],
  matched : Map[String, Bool],
) -> Unit raise {
  if selection.prefixes is None {
    return
  }
  for file in listed {
    for candidate in component_prefixes(str(get(file, "path"))) {
      if selection.set.contains(candidate) {
        matched[candidate] = true
      }
    }
  }
}

///|
fn unresolved_selection(
  selection : Selection,
  listed : Array[Value],
) -> Array[String] raise {
  let matched : Map[String, Bool] = Map([])
  mark_matches(selection, listed, matched)
  let missing : Array[String] = []
  match selection.prefixes {
    None => ()
    Some(prefixes) =>
      for prefix in prefixes {
        if !matched.contains(prefix) {
          missing.push(prefix)
        }
      }
  }
  sort_strings(missing)
  missing
}

///|
/// Resolves the selected files through the chain and returns the payload in this
/// snapshot's own encoding, so the host adapter decodes with one call.
fn restore_with(
  snapshot : Value,
  parents : Array[Value],
  selection : Selection,
) -> Value raise {
  let report = audit_with(snapshot, parents)
  if get(report, "valid") != Bool(true) {
    raise InputError("cannot restore corrupted snapshot")
  }
  let (version, _, listed) = manifest(snapshot)
  let missing = unresolved_selection(selection, listed)
  if !missing.is_empty() {
    raise InputError("restore path not found in snapshot: " + missing[0])
  }
  let (links, _) = resolve_chain(snapshot, parents)
  let files : Array[Value] = []
  for file in listed {
    let path = str(get(file, "path"))
    if selects(selection, path) {
      let hash = str(get(file, "digest"))
      let payload = match payload_for(links, hash, version) {
        Some(value) => value
        None => Null
      }
      let result = obj(file).copy()
      result["bytes"] = payload
      files.push(Object(result))
    }
  }
  record([
    ("format", Number(version.to_double())),
    ("encoding", String(if version == 1 { "decimal" } else { "base64" })),
    ("chain_depth", get(report, "chain_depth")),
    ("files", Array(files)),
    ("selected", Number(files.length().to_double())),
    ("total_files", Number(listed.length().to_double())),
    ("verified", Bool(true)),
  ])
}

///|
/// Compacts a chain into one self-contained snapshot. Only objects the manifest
/// reaches are kept, so payloads no file points at are dropped. The result has
/// no parent and can be read without the chain. Without an explicit `format` the
/// snapshot keeps its own, which leaves its checksum family intact.
fn squash_with(
  snapshot : Value,
  parents : Array[Value],
  requested : Int32?,
) -> Value raise {
  let format = match requested {
    None => snapshot_version(snapshot)
    Some(value) => value
  }
  if format != 1 && format != 2 && format != 3 {
    raise InputError("unsupported snapshot format")
  }
  let report = audit_with(snapshot, parents)
  if get(report, "valid") != Bool(true) {
    raise InputError("cannot squash corrupted snapshot")
  }
  let (_, _, listed) = manifest(snapshot)
  let (links, _) = resolve_chain(snapshot, parents)
  let objects : Map[String, Value] = Map([])
  let mut bytes = 0.0
  for file in listed {
    let hash = str(get(file, "digest"))
    if !objects.contains(hash) {
      match object_payload(links, hash) {
        None => raise InputError("cannot squash an unresolvable object")
        Some((link_version, raw)) =>
          match decode_object(link_version, raw) {
            None => raise InputError("cannot squash an undecodable object")
            Some(payload) => {
              objects[hash] = encode_object(format, payload)
              bytes += payload.length().to_double()
            }
          }
      }
    }
  }
  let fields : Array[(String, Value)] = [
    ("version", Number(format.to_double())),
  ]
  // A squashed chain is self contained by definition, so the parent is explicit
  // and empty rather than absent: readers can tell it was compacted.
  let body = fields
  if format >= 3 {
    body.push(("parent", Null))
  }
  body.push(("files", Array(listed)))
  body.push(("objects", Object(objects)))
  body.push(("checksum", String(checksum(format, None, listed))))
  let squashed = record(body)
  ignore(manifest(squashed))
  record([
    ("snapshot", squashed),
    (
      "statistics",
      record([
        ("format", Number(format.to_double())),
        ("chain_depth", get(report, "chain_depth")),
        ("files", Number(listed.length().to_double())),
        ("objects", Number(objects.length().to_double())),
        ("bytes", Number(bytes)),
      ]),
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
        parents=request_parents(request),
        known_objects=request_known_objects(request),
        format=requested_format(request),
      )
    "audit" => audit_with(get(request, "snapshot"), request_parents(request))
    "diff" => diff_snapshots(get(request, "old"), get(request, "new"))
    "restore" =>
      restore_with(
        get(request, "snapshot"),
        request_parents(request),
        request_selection(request),
      )
    "assemble" =>
      assemble_with(
        arr(get(request, "files")),
        match optional_format(request) {
          None => 2
          Some(value) => value
        },
      )
    "locate" =>
      locate_with(
        get(request, "snapshot"),
        request_parents(request),
        request_selection(request),
      )
    "extract" =>
      extract_with(
        get(request, "snapshot"),
        request_digests(request),
        optional_format(request),
      )
    "squash" =>
      squash_with(
        get(request, "snapshot"),
        request_parents(request),
        optional_format(request),
      )
    _ => raise InputError("unknown snapshot operation")
  }
}
