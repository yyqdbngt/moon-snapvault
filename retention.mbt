///|
pub fn retention_plan(request : Value) -> Value raise {
  let snapshots = arr(get(request, "snapshots"))
  let by_id : Map[String, Value] = Map([])
  let objects : Map[String, Value] = Map([])
  for entry in snapshots {
    let id = str(get(entry, "id"))
    if id == "" || by_id.contains(id) {
      raise InputError("duplicate or empty snapshot identity")
    }
    let snapshot = get(entry, "snapshot")
    if get(audit_snapshot(snapshot), "valid") != Bool(true) {
      raise InputError("retention refuses a corrupt snapshot")
    }
    // audit_snapshot has already verified every stored object, referenced or not.
    for hash, raw in obj(get(snapshot, "objects")) {
      match objects.get(hash) {
        Some(existing) =>
          if existing != raw {
            raise InputError("inconsistent shared content")
          }
        None => objects[hash] = raw
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
    for file in manifest(by_id[id]) {
      reachable[str(get(file, "digest"))] = true
    }
  }
  let kept : Array[String] = []
  let collectible : Array[String] = []
  let mut live_bytes = 0.0
  let mut collectible_bytes = 0.0
  for hash, bytes in objects {
    let size = arr(bytes).length().to_double()
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
