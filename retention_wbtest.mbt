///|
test "retention keeps shared objects and identifies old exclusive bytes" {
  let first=get(create_snapshot([record([("path",String("shared")),("text",String("abc"))]),record([("path",String("old")),("text",String("old"))])]),"snapshot")
  let second=get(create_snapshot([record([("path",String("shared")),("text",String("abc"))]),record([("path",String("new")),("text",String("new"))])]),"snapshot")
  let request=record([("snapshots",Array([record([("id",String("one")),("snapshot",first)]),record([("id",String("two")),("snapshot",second)])])),("keep",strings(["two"]))])
  let result=retention_plan(request)
  assert_eq(get(result,"live_bytes"),Number(6.0))
  assert_eq(get(result,"collectible_bytes"),Number(3.0))
  assert_eq(arr(get(result,"reachable_objects")).length(),2)
  assert_eq(arr(get(result,"collectible_objects")).length(),1)
  assert_eq(get(result,"plan_only"),Bool(true))
}
