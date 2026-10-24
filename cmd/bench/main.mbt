///|
/// Micro-benchmarks for the primitives that dominate snapshot work, plus the
/// end-to-end engine at 8 MiB. Build with `moon build --target js --release`
/// before quoting figures; debug builds are several times slower.
extern "js" fn now_ms() -> Double =
  #| () => Date.now()

///|
fn measure(label : String, mebibytes : Double, run : () -> Unit) -> Unit {
  run()
  let started = now_ms()
  run()
  let elapsed = now_ms() - started
  println(
    label +
    ": " +
    elapsed.to_string() +
    " ms, " +
    (mebibytes * 1000.0 / elapsed).to_string() +
    " MiB/s",
  )
}

///|
fn run_quietly(request : Json) -> Unit {
  ignore(@engine.execute(request)) catch {
    _ => ()
  }
}

///|
fn main raise {
  let size = 8 * 1024 * 1024
  let bytes = Bytes::makei(size, fn(i) { (i % 251).to_byte() })
  let mebibytes = size.to_double() / 1048576.0
  measure("sha256 (this package)", mebibytes, fn() {
    ignore(@engine.digest(bytes))
  })
  let request = @json.parse(
    "{\"files\":[{\"path\":\"r.bin\",\"content_base64\":\"" +
    @base64.encode(bytes[:]) +
    "\"}]}",
  )
  measure("create 8 MiB (end to end)", mebibytes, fn() { run_quietly(request) })
  let snapshot = @engine.execute(request)
  let audit_request = Json::object({
    "operation": Json::string("audit"),
    "snapshot": match snapshot {
      Json::Object(fields) =>
        match fields.get("snapshot") {
          Some(value) => value
          None => Json::null()
        }
      _ => Json::null()
    },
  })
  measure("audit 8 MiB (end to end)", mebibytes, fn() {
    run_quietly(audit_request)
  })
}
