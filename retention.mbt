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
  // Object hashes per link checksum. Needed because "no surviving file references it" and
  // "deleting the named snapshots frees it" are different questions: an object stored inside a
  // snapshot the caller keeps is unreferenced and yet stays on disk, so counting it as
  // reclaimable promised bytes that no deletion could deliver.
  let stored_by : Map[String, Array[String]] = Map([])
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
      let link_checksum = link.checksum
      let holders : Array[String] = match stored_by.get(link_checksum) {
        Some(existing) => existing
        None => {
          let fresh : Array[String] = []
          stored_by[link_checksum] = fresh
          fresh
        }
      }
      for hash, raw in link.objects {
        holders.push(hash)
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
  // Which links survive, and which this plan deletes. A link whose checksum is in neither is a
  // parent the caller supplied but did not name: its bytes are outside the plan's reach because
  // the tool has no identity for it to delete.
  let live_checksums : Map[String, Bool] = Map([])
  for id, _ in live {
    live_checksums[str(get(by_id[id], "checksum"))] = true
  }
  let dropped_checksums : Map[String, Bool] = Map([])
  for id in dropped {
    dropped_checksums[str(get(by_id[id], "checksum"))] = true
  }
  let in_live : Map[String, Bool] = Map([])
  let in_dropped : Map[String, Bool] = Map([])
  let in_unnamed : Map[String, Bool] = Map([])
  for checksum, hashes in stored_by {
    let bucket = if live_checksums.contains(checksum) {
      in_live
    } else if dropped_checksums.contains(checksum) {
      in_dropped
    } else {
      in_unnamed
    }
    for hash in hashes {
      bucket[hash] = true
    }
  }
  let kept : Array[String] = []
  let collectible : Array[String] = []
  let stranded : Array[String] = []
  let mut live_bytes = 0.0
  let mut collectible_bytes = 0.0
  let mut stranded_bytes = 0.0
  for hash, _ in objects {
    let size = sizes[hash]
    if reachable.contains(hash) {
      kept.push(hash)
      live_bytes += size
    } else if in_live.contains(hash) || in_unnamed.contains(hash) {
      // Unreferenced, yet stored where this plan does not delete: the snapshot it lives in is
      // being kept. `squash` drops unreferenced objects, so that is the way to reclaim these.
      stranded.push(hash)
      stranded_bytes += size
    } else {
      // Unreferenced and only in snapshots this plan deletes.
      collectible.push(hash)
      collectible_bytes += size
    }
  }
  sort_strings(kept)
  sort_strings(collectible)
  sort_strings(stranded)
  record([
    ("keep_snapshots", strings(kept_snapshots)),
    ("required_snapshots", strings(required_snapshots)),
    ("external_parents", strings(external_parents)),
    ("drop_snapshots", strings(dropped)),
    ("reachable_objects", strings(kept)),
    ("collectible_objects", strings(collectible)),
    ("live_bytes", Number(live_bytes)),
    ("collectible_bytes", Number(collectible_bytes)),
    // Unreferenced bytes inside a snapshot this plan keeps. Reported separately because the
    // action differs: deleting the named snapshots does nothing for them, and `squash` does.
    ("stranded_objects", strings(stranded)),
    ("stranded_bytes", Number(stranded_bytes)),
    ("plan_only", Bool(true)),
    (
      "scope",
      String(
        "objects and chain links these snapshots need; no files are deleted; " +
        "collectible bytes are freed by deleting drop_snapshots; stranded bytes are stored " +
        "inside a snapshot this plan keeps and need that snapshot squashed",
      ),
    ),
  ])
}
