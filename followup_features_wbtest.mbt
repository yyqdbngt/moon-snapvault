///|
fn followup_at(value : Value, keys : Array[String]) -> Value raise {
  let mut current=value
  for key in keys { current=match current { Object(fields)=>fields[key]; Array(items)=> { let index=match @json.parse(key) { Json::Number(n, ..)=>n.to_int(); _=>raise InputError("invalid test index") }; items[index] }; _=>raise InputError("invalid test path") } }
  current
}

///|
test "followup empty retention plan" {
  let result=run(from_json(@json.parse("{\"operation\":\"retention\",\"snapshots\":[]}")))
  assert_eq(followup_at(result,["plan_only"]),from_json(@json.parse("true")))
  assert_eq(followup_at(result,["collectible_objects"]),from_json(@json.parse("[]")))
  assert_eq(followup_at(result,["live_bytes"]),from_json(@json.parse("0")))
}

///|
test "followup unknown retention identity" {
  let bad=try { ignore(run(from_json(@json.parse("{\"operation\":\"retention\",\"snapshots\":[],\"keep\":[\"missing\"]}")))); false } catch { _=>true }; assert_true(bad)
}
