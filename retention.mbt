///|
pub fn retention_plan(request : Value) -> Value raise {
  let snapshots = arr(get(request, "snapshots"))
  let by_id : Map[String, Value] = Map([])
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
  }
  let retained = if get(request, "keep") == Null {
    by_id.keys().collect()
  } else {
    string_list(get(request, "keep"))
  }
  let selected : Map[String, Bool] = Map([])
  let reachable : Map[String, Bool] = Map([])
  for id in retained {
    if selected.contains(id) || !by_id.contains(id) {
      raise InputError("duplicate or unknown retained snapshot")
    }
    selected[id] = true
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
  let dropped = by_id.keys().filter(fn(id) { !selected.contains(id) }).collect()
  sort_strings(dropped)
  record([
    ("keep_snapshots", strings(kept_snapshots)),
    ("drop_snapshots", strings(dropped)),
    ("reachable_objects", strings(kept)),
    ("collectible_objects", strings(collectible)),
    ("live_bytes", Number(live_bytes)),
    ("collectible_bytes", Number(collectible_bytes)),
    ("plan_only", Bool(true)),
    (
      "scope",
      String(
        "objects supplied by these self-contained snapshots; no files are deleted",
      ),
    ),
  ])
}
