///|
/// Digests a snapshot stores, without reading any payload. A snapshot that carries
/// only a manifest contributes none, which is what lets a long chain travel as
/// manifests: locating a digest never needs its bytes.
fn stored_digests(snapshot : Value) -> Map[String, Bool] raise {
  let out : Map[String, Bool] = Map([])
  match get(snapshot, "objects") {
    Null => ()
    Object(fields) =>
      for hash, _ in fields {
        out[hash] = true
      }
    _ => raise InputError("snapshot objects must be an object")
  }
  if out.is_empty() {
    // A link that travelled as a manifest names its payloads instead of carrying
    // them. The name is deliberately not `objects`, so a digest list can never be
    // read as payload bytes.
    match get(snapshot, "stored_digests") {
      Null => ()
      Array(items) =>
        for item in items {
          let hash = str(item)
          if !is_object_id(hash) {
            raise InputError("invalid declared digest")
          }
          out[hash] = true
        }
      _ => raise InputError("stored_digests must be an array")
    }
  }
  out
}

///|
/// Which link of the chain stores each selected file's payload.
///
/// A restore has to hold the whole chain to resolve digests, and a chain of a few
/// large snapshots does not fit in one request. This operation answers the same
/// question from manifests alone, so a reader can then ask for the payloads one
/// link at a time. It reports rather than raises when something cannot be found,
/// because the caller needs to know which part is missing.
fn locate_with(
  snapshot : Value,
  parents : Array[Value],
  selection : Selection,
) -> Value raise {
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
  let home : Map[String, String] = Map([])
  let visited : Map[String, Bool] = Map([])
  let mut current = snapshot
  let mut depth = 0
  let mut missing : String? = None
  while true {
    let (_, parent, _) = manifest(current)
    let id = str(get(current, "checksum"))
    if visited.contains(id) {
      raise InputError("parent snapshot chain contains a cycle")
    }
    if depth >= max_chain_depth {
      raise InputError("parent snapshot chain is too deep")
    }
    visited[id] = true
    for hash, _ in stored_digests(current) {
      if !home.contains(hash) {
        home[hash] = id
      }
    }
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
  let (version, _, listed) = manifest(snapshot)
  let unresolved_selection_paths = unresolved_selection(selection, listed)
  if !unresolved_selection_paths.is_empty() {
    raise InputError(
      "restore path not found in snapshot: " + unresolved_selection_paths[0],
    )
  }
  let entries : Array[Value] = []
  let unresolved : Array[String] = []
  for file in listed {
    let path = str(get(file, "path"))
    if selects(selection, path) {
      let digest = str(get(file, "digest"))
      match home.get(digest) {
        Some(link) =>
          entries.push(
            record([
              ("path", String(path)),
              ("digest", String(digest)),
              ("size", get(file, "size")),
              ("mode", get(file, "mode")),
              ("link", String(link)),
            ]),
          )
        None => unresolved.push(digest)
      }
    }
  }
  sort_strings(unresolved)
  record([
    ("format", Number(version.to_double())),
    ("encoding", String(if version == 1 { "decimal" } else { "base64" })),
    ("chain_depth", Number(visited.length().to_double())),
    ("files", Array(entries)),
    ("unresolved", strings(unresolved)),
    (
      "missing_parent",
      match missing {
        None => Null
        Some(hash) => String(hash)
      },
    ),
  ])
}

///|
/// Verifies the requested payloads against one link and returns them in that
/// link's encoding. This is the other half of `locate`: the caller sends only the
/// one snapshot that holds the digests it is about to write, so neither the
/// request nor the response has to carry the rest of the chain.
fn extract_with(
  snapshot : Value,
  digests : Array[String],
  requested : Int32?,
) -> Value raise {
  let (version, _, _) = manifest(snapshot)
  // The payload comes back in the caller's encoding, not this link's, so a chain
  // that mixes formats still yields one encoding for the whole restore.
  let target = match requested {
    None => version
    Some(value) => value
  }
  if target != 1 && target != 2 && target != 3 {
    raise InputError("unsupported snapshot format")
  }
  let objects = match stored_objects(snapshot) {
    Some(fields) => fields
    None => raise InputError("extract needs the snapshot's objects")
  }
  let out : Map[String, Value] = Map([])
  let mut bytes_total = 0.0
  // `wanted` rather than `digest`, so the hashing function stays callable.
  for wanted in digests {
    if !is_object_id(wanted) {
      raise InputError("invalid object identifier")
    }
    if out.contains(wanted) {
      continue
    }
    match objects.get(wanted) {
      None => raise InputError("object not stored in this snapshot: " + wanted)
      Some(raw) =>
        match decode_object(version, raw) {
          None => raise InputError("invalid object encoding")
          Some(bytes) =>
            if digest(bytes) != wanted {
              raise InputError("digest mismatch for " + wanted)
            } else {
              out[wanted] = encode_object(target, bytes)
              bytes_total += bytes.length().to_double()
            }
        }
    }
  }
  record([
    ("encoding", String(if target == 1 { "decimal" } else { "base64" })),
    ("format", Number(target.to_double())),
    ("objects", Object(out)),
    ("bytes", Number(bytes_total)),
    ("verified", Bool(true)),
  ])
}

///|
/// The checksum a manifest would carry, without any payload. A caller that has
/// verified the payloads itself (through `extract`) and wants to write a
/// self-contained snapshot still needs the project's canonical checksum, and this
/// keeps that computation in one place instead of reimplementing it per host.
fn assemble_with(files : Array[Value], format : Int32) -> Value raise {
  if format != 1 && format != 2 && format != 3 {
    raise InputError("unsupported snapshot format")
  }
  // Only the four manifest fields are kept. `locate` returns entries that also
  // carry the link that stores them, and a caller passing those straight through
  // must not end up with that field inside the manifest and its checksum.
  let manifest_files : Array[Value] = []
  for file in files {
    manifest_files.push(
      record([
        ("path", get(file, "path")),
        ("digest", get(file, "digest")),
        ("size", get(file, "size")),
        ("mode", get(file, "mode")),
      ]),
    )
  }
  let fields : Array[(String, Value)] = [
    ("version", Number(format.to_double())),
  ]
  if format >= 3 {
    fields.push(("parent", Null))
  }
  fields.push(("files", Array(manifest_files)))
  fields.push(("objects", Object(Map([]))))
  fields.push(("checksum", String(checksum(format, None, manifest_files))))
  // Reuse the manifest rules so an assembled snapshot is checked exactly like a
  // created one: unsafe or duplicate paths, bad sizes and modes all fail here.
  let (version, _, listed) = manifest(record(fields))
  record([
    ("format", Number(version.to_double())),
    ("files", Array(listed)),
    ("checksum", String(checksum(version, None, listed))),
  ])
}
