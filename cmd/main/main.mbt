///|
/// Reads the request file (or stdin for `-`) and always returns a JSON
/// envelope. Host-side failures such as a missing file or invalid UTF-8 are
/// reported through the envelope so the CLI keeps a single error contract.
extern "js" fn read_input(path : String) -> String =
  #| (path) => {
  #|   const fs = process.getBuiltinModule('node:fs');
  #|   try {
  #|     const bytes = fs.readFileSync(path === '-' ? 0 : path);
  #|     if (bytes.length > 16777216) {
  #|       return JSON.stringify({ok: false, error: 'input exceeds 16 MiB'});
  #|     }
  #|     const text = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  #|     return JSON.stringify({ok: true, text});
  #|   } catch (err) {
  #|     const message = err && err.message ? err.message : String(err);
  #|     return JSON.stringify({ok: false, error: message});
  #|   }
  #| }

///|
extern "js" fn status(code : Int32) -> Unit =
  #| (code) => { process.exitCode = code; }

///|
priv enum Loaded {
  Loaded(String)
  Failed(String)
}

///|
fn load_input(path : String) -> Loaded {
  let invalid = Failed("host adapter returned an invalid envelope")
  try {
    match @json.parse(read_input(path)) {
      Json::Object(fields) =>
        match fields.get("ok") {
          Some(Json::True) =>
            match fields.get("text") {
              Some(Json::String(text)) => Loaded(text)
              _ => invalid
            }
          _ =>
            match fields.get("error") {
              Some(Json::String(message)) => Failed(message)
              _ => Failed("host adapter failed")
            }
        }
      _ => invalid
    }
  } catch {
    _ => invalid
  }
}

///|
fn fail(message : String) -> Unit {
  println(Json::object({ "error": Json::string(message) }).stringify())
  status(1)
}

///|
fn main {
  let args = @env.args()
  if args.length() != 3 {
    println(
      "Usage: moon run cmd/main --target js -- request.json (or - for stdin)",
    )
    status(2)
  } else {
    match load_input(args[2]) {
      Failed(message) => fail(message)
      Loaded(text) =>
        try {
          let output = @engine.execute(@json.parse(text))
          println(output.stringify(indent=2))
        } catch {
          // InputError and Json::ParseError both render a plain message.
          error => fail(error.to_string())
        }
    }
  }
}
