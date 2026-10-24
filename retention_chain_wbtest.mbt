///|
/// base -> middle -> tip, one extra file per link, so every link stores
/// something the tip needs.
fn three_link_chain() -> Array[Value] raise {
  let base = get(
    create_snapshot(
      [record([("path", String("a.txt")), ("text", String("aaa"))])],
      format=3,
    ),
    "snapshot",
  )
  let middle = get(
    create_snapshot(
      [
        record([("path", String("a.txt")), ("text", String("aaa"))]),
        record([("path", String("b.txt")), ("text", String("bbb"))]),
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
        record([("path", String("b.txt")), ("text", String("bbb"))]),
        record([("path", String("c.txt")), ("text", String("ccc"))]),
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
fn plan_for(chain : Array[Value], keep : Array[String]) -> Value raise {
  retention_plan(
    record([
      (
        "snapshots",
        Array([
          record([("id", String("base")), ("snapshot", chain[0])]),
          record([
            ("id", String("middle")),
            ("snapshot", chain[1]),
            ("parents", Array([chain[0]])),
          ]),
          record([
            ("id", String("tip")),
            ("snapshot", chain[2]),
            ("parents", Array([chain[0], chain[1]])),
          ]),
        ]),
      ),
      ("keep", strings(keep)),
    ]),
  )
}

///|
test "keeping the tip promotes the whole chain" {
  let chain = three_link_chain()
  let plan = plan_for(chain, ["tip"])
  assert_eq(get(plan, "keep_snapshots"), strings(["tip"]))
  assert_eq(get(plan, "required_snapshots"), strings(["base", "middle"]))
  // Dropping either parent would leave the tip unreadable, so nothing is dropped.
  assert_eq(get(plan, "drop_snapshots"), strings([]))
  assert_eq(get(plan, "external_parents"), strings([]))
  assert_eq(get(plan, "collectible_objects"), strings([]))
  assert_eq(get(plan, "collectible_bytes"), Number(0.0))
}

///|
test "keeping one snapshot still frees what only the others referenced" {
  let chain = three_link_chain()
  let plan = plan_for(chain, ["base"])
  // The base needs no chain, so both descendants may go.
  assert_eq(get(plan, "keep_snapshots"), strings(["base"]))
  assert_eq(get(plan, "required_snapshots"), strings([]))
  assert_eq(get(plan, "drop_snapshots"), strings(["middle", "tip"]))
  // The base references a.txt only; b.txt and c.txt live in the dropped links.
  assert_eq(arr(get(plan, "reachable_objects")).length(), 1)
  assert_eq(arr(get(plan, "collectible_objects")).length(), 2)
  assert_eq(get(plan, "live_bytes"), Number(3.0))
  assert_eq(get(plan, "collectible_bytes"), Number(6.0))
}

///|
test "keeping a middle link promotes only what is below it" {
  let chain = three_link_chain()
  let plan = plan_for(chain, ["middle"])
  assert_eq(get(plan, "required_snapshots"), strings(["base"]))
  // The tip is above the middle link, so it is not needed to read it.
  assert_eq(get(plan, "drop_snapshots"), strings(["tip"]))
  // b.txt is referenced by the middle link and a.txt by the base.
  assert_eq(arr(get(plan, "reachable_objects")).length(), 2)
  assert_eq(get(plan, "live_bytes"), Number(6.0))
}

///|
test "a squashed snapshot releases its chain" {
  let chain = three_link_chain()
  let squashed = get(
    squash_with(chain[2], [chain[0], chain[1]], Some(3)),
    "snapshot",
  )
  let plan = retention_plan(
    record([
      (
        "snapshots",
        Array([
          record([("id", String("base")), ("snapshot", chain[0])]),
          record([
            ("id", String("tip")),
            ("snapshot", chain[2]),
            ("parents", Array([chain[0], chain[1]])),
          ]),
          record([("id", String("compact")), ("snapshot", squashed)]),
        ]),
      ),
      ("keep", strings(["compact"])),
    ]),
  )
  assert_eq(get(plan, "keep_snapshots"), strings(["compact"]))
  // Nothing is required: the compacted snapshot is self contained.
  assert_eq(get(plan, "required_snapshots"), strings([]))
  assert_eq(get(plan, "drop_snapshots"), strings(["base", "tip"]))
  // All three payloads stay live because the compacted snapshot stores them.
  assert_eq(arr(get(plan, "reachable_objects")).length(), 3)
  assert_eq(get(plan, "collectible_objects"), strings([]))
}

///|
test "a chain link with no listed identity is reported" {
  let chain = three_link_chain()
  // Only the tip is listed; its parents arrive through `parents`, so the plan
  // cannot report them as droppable but must say it still needs them.
  let plan = retention_plan(
    record([
      (
        "snapshots",
        Array([
          record([
            ("id", String("tip")),
            ("snapshot", chain[2]),
            ("parents", Array([chain[0], chain[1]])),
          ]),
        ]),
      ),
      ("keep", strings(["tip"])),
    ]),
  )
  assert_eq(get(plan, "required_snapshots"), strings([]))
  assert_eq(get(plan, "drop_snapshots"), strings([]))
  assert_eq(arr(get(plan, "external_parents")).length(), 2)
  assert_eq(get(plan, "external_parents") == strings([]), false)
}

///|
test "the plan never drops a link a kept snapshot names" {
  // Property-style check over every subset of the chain.
  let chain = three_link_chain()
  let ids = ["base", "middle", "tip"]
  for mask = 1; mask < 8; mask = mask + 1 {
    let keep : Array[String] = []
    for index = 0; index < 3; index = index + 1 {
      if mask / (1 << index) % 2 == 1 {
        keep.push(ids[index])
      }
    }
    let plan = plan_for(chain, keep)
    let dropped = get(plan, "drop_snapshots")
    let dropped_ids = match dropped {
      Array(items) => items.map(item => str(item))
      _ => []
    }
    // A dropped id may not appear in the chain of anything that stays.
    let staying = match get(plan, "keep_snapshots") {
      Array(items) => items.map(item => str(item))
      _ => []
    }
    let required = match get(plan, "required_snapshots") {
      Array(items) => items.map(item => str(item))
      _ => []
    }
    let kept_parents : Array[String] = []
    for id in staying {
      let mut index = 0
      for position = 0; position < ids.length(); position = position + 1 {
        if ids[position] == id {
          index = position
        }
      }
      for below = 0; below < index; below = below + 1 {
        kept_parents.push(ids[below])
      }
    }
    for id in dropped_ids {
      assert_eq(kept_parents.contains(id), false)
      assert_eq(required.contains(id), false)
    }
  }
}
