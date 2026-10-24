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
  #|     // The docs promise a plain reason, not a Node error. "ENOENT: no such file or
  #|     // directory, open '/x/y.json'" names an errno and repeats the path the caller
  #|     // just typed; say it in words instead, and only fall back to the raw text for
  #|     // codes this list does not cover.
  #|     const reasons = {
  #|       ENOENT: 'the file does not exist',
  #|       EACCES: 'permission denied',
  #|       EPERM: 'operation not permitted',
  #|       EISDIR: 'it is a directory',
  #|       ENOTDIR: 'a path component is not a directory',
  #|       ELOOP: 'too many symbolic links',
  #|       ENAMETOOLONG: 'the name is too long',
  #|       EMFILE: 'too many open files',
  #|       ENFILE: 'too many open files',
  #|       ENOSPC: 'no space left on device',
  #|       EIO: 'an I/O error occurred',
  #|     };
  #|     const code = err && err.code;
  #|     const message = reasons[code]
  #|       || (err && err.message ? err.message : String(err));
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
    // A usage mistake goes through the same envelope as every other failure. It used to
    // print free text, so a caller that parsed stdout as JSON had one path where it was
    // not JSON - and `docs/usage.md` says usage errors exit 2, which is only useful if the
    // exit code and the body agree about what happened.
    fail(
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
