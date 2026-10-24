///|
/// Resolves the snapshots a plan may delete.
///
/// `keep` names the snapshots the caller wants. A format 3 snapshot is only
/// readable while every link of its chain exists, because its manifest names the
/// parent by checksum and a read walks that chain. So a snapshot that is a link
/// of a kept snapshot cannot be dropped even when the caller did not list it:
/// the objects may all still be present and the kept snapshot would still be
/// unreadable. Those links are promoted into `required` and reported, and the
/// only way to genuinely retire a parent is to `squash` its child first.
pub fn retention_plan(request : Value) -> Value raise {
  let snapshots = arr(get(request, "snapshots"))
  let by_id : Map[String, Value] = Map([])
  let parents_of : Map[String, Array[Value]] = Map([])
  let objects : Map[String, Bool] = Map([])
  let sizes : Map[String, Double] = Map([])
  for entry in snapshots {
    let id = str(get(entry, "id"))
    if id == "" || by_id.contains(id) {
      raise InputError("duplicate or empty snapshot identity")
    }
    let snapshot = get(entry, "snapshot")
    let parents = match get(entry, "parents") {
      Array(items) => items
      _ => {
        let empty : Array[Value] = []
        empty
      }
    }
    if get(audit_with(snapshot, parents), "valid") != Bool(true) {
      raise InputError("retention refuses a corrupt snapshot")
    }
    // The audit has verified every object in the chain, referenced or not, so a
    // digest names the same bytes wherever it is stored. Decoded lengths are what
    // the plan reports: a base64 payload is longer than the bytes it represents.
    let (links, missing) = resolve_chain(snapshot, parents)
    match missing {
      Some(hash) =>
        raise InputError("retention refuses a missing parent " + hash)
      None => ()
    }
    for link in links {
      for hash, raw in link.objects {
        if !sizes.contains(hash) {
          match decode_object(link.version, raw) {
            Some(bytes) => {
              objects[hash] = true
              sizes[hash] = bytes.length().to_double()
            }
            None => raise InputError("retention refuses an undecodable object")
          }
        }
      }
    }
    by_id[id] = snapshot
    parents_of[id] = parents
  }
  let retained = if get(request, "keep") == Null {
    by_id.keys().collect()
  } else {
    string_list(get(request, "keep"))
  }
  // Checksum to identity, so a chain link can be traced back to a listed entry.
  let id_by_checksum : Map[String, String] = Map([])
  for id, snapshot in by_id {
    id_by_checksum[str(get(snapshot, "checksum"))] = id
  }
  let selected : Map[String, Bool] = Map([])
  for id in retained {
    if selected.contains(id) || !by_id.contains(id) {
      raise InputError("duplicate or unknown retained snapshot")
    }
    selected[id] = true
  }
  // Promote every link a kept snapshot needs. Chains are walked here rather than
  // trusted from the request, and a link with no listed identity is reported
  // separately because the caller cannot name it in `keep`.
  let required : Map[String, Bool] = Map([])
  let external : Map[String, Bool] = Map([])
  for id in retained {
    let (links, missing) = resolve_chain(by_id[id], parents_of[id])
    match missing {
      Some(_) => raise InputError("retention refuses a missing parent")
      None => ()
    }
    for link in links {
      if link.checksum == str(get(by_id[id], "checksum")) {
        continue
      }
      match id_by_checksum.get(link.checksum) {
        Some(parent_id) =>
          if !selected.contains(parent_id) {
            required[parent_id] = true
          }
        None => external[link.checksum] = true
      }
    }
  }
  let live : Map[String, Bool] = Map([])
  for id in retained {
    live[id] = true
  }
  for id, _ in required {
    live[id] = true
  }
  let reachable : Map[String, Bool] = Map([])
  for id, _ in live {
    for file in manifest(by_id[id]).2 {
      reachable[str(get(file, "digest"))] = true
    }
  }
  let kept : Array[String] = []
  let collectible : Array[String] = []
  let mut live_bytes = 0.0
  let mut collectible_bytes = 0.0
  for hash, _ in objects {
    let size = sizes[hash]
    if reachable.contains(hash) {
      kept.push(hash)
      live_bytes += size
    } else {
      collectible.push(hash)
      collectible_bytes += size
    }
  }
  sort_strings(kept)
  sort_strings(collectible)
  let kept_snapshots = selected.keys().collect()
  sort_strings(kept_snapshots)
  let required_snapshots = required.keys().collect()
  sort_strings(required_snapshots)
  let external_parents = external.keys().collect()
  sort_strings(external_parents)
  let dropped = by_id
    .keys()
    .filter(fn(id) { !selected.contains(id) && !required.contains(id) })
    .collect()
  sort_strings(dropped)
  record([
    ("keep_snapshots", strings(kept_snapshots)),
    ("required_snapshots", strings(required_snapshots)),
    ("external_parents", strings(external_parents)),
    ("drop_snapshots", strings(dropped)),
    ("reachable_objects", strings(kept)),
    ("collectible_objects", strings(collectible)),
    ("live_bytes", Number(live_bytes)),
    ("collectible_bytes", Number(collectible_bytes)),
    ("plan_only", Bool(true)),
    (
      "scope",
      String(
        "objects and chain links these snapshots need; no files are deleted",
      ),
    ),
  ])
}
