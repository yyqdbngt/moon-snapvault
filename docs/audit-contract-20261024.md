# Audit contract revision - 2026-10-24

Unreleased work on `main`. The published module stays at 0.2.0 until a release is
tagged; `moon add yyqdbngt/moon_snapvault@0.2.0` still resolves the previous code.

## What was wrong

1. `audit_snapshot` walked only the objects referenced by the manifest. An object
   whose key did not match its bytes was reported as `valid: true` as long as no
   manifest entry pointed at it, while `retention` refused the same snapshot and
   `restore` happily restored it.
2. `create(previous=…)` trusted that `audit` result. A previous snapshot claiming
   `objects[sha256("abc")] = [0,0,0]` made the next snapshot report
   `new_object_bytes: 0` for real new content.
3. The CLI's `extern "js" fn read_input` threw inside JavaScript. MoonBit `catch`
   cannot intercept a JS exception, so a missing file, invalid UTF-8 or an
   over-limit input printed a Node stack trace instead of `{"error": ...}`.
4. `restore` created files with `writeFileSync(..., {mode})`, which the process
   umask filters: a 0777 entry came back as 0755 (umask 022) or 0700 (umask 077)
   while the call still returned `verified: true`.
5. Path validation folded ASCII case only. `Ä.txt`/`ä.txt` and the two Unicode
   forms of `café.txt` were accepted, then failed halfway through a restore with
   `EEXIST` and a retained partial directory.
6. Documentation still said `0.1.0`, claimed "full" object audits, and described
   fixture tests as "generated" while `PROJECT_STATS.md` reported zero generated
   declarations.

## What changed

| Area | Change |
|---|---|
| Audit | Verifies every stored object; `objects_total`, `objects_checked`, `referenced_objects`, `unreferenced_objects`; `issues` entries carry `object` and `path` (null when unreferenced) |
| Consistency | `audit`, `retention`, `restore` and `create(previous=…)` agree on the same bytes |
| CLI | One error envelope for every failure; `InputError` renders a plain message; exit 2 for usage |
| Restore | `chmod` after write, `modes_applied` in the adapter result |
| Portability | `portablePaths` rejects NFC/case collisions before the destination is created; `backup` warns |
| Ordering | Lexicographic `StringView::lexical_compare` instead of shortlex `String::compare` |
| Hygiene | Dead `truth` removed, `parse_value` made public, unused `core/math` dropped, deprecation warnings migrated, zero-warning build |

Behavioural note for consumers: `InputError` keeps `Show` (so `to_string()` still
compiles) but now prints only the message. `Value` and `InputError` also expose
`equal`, `not_equal` and `to_repr`.

## Evidence

Run on the V100 server host (Ubuntu 22.04, gcc 12.3, Node 20.20.2) with
moon 0.1.20261023; `MOON_CC=/usr/bin/gcc` because `cc` on that host is a wrapper
script rather than a compiler.

```
sh scripts/verify.sh
  js: Total tests: 19, passed: 19, failed: 0.
  wasm: Total tests: 19, passed: 19, failed: 0.
  wasm-gc: Total tests: 19, passed: 19, failed: 0.
  native: Total tests: 19, passed: 19, failed: 0.
  CLI fixture cases passed: 18
  Python hashlib oracle: 30 binary inputs, SHA256, audit and verified restore passed
  Audit oracle: unreferenced objects verified, retention and audit agree, corrupt input refused
  CLI oracle: host-side failures report {"error": ...} on stdout with exit code 1, usage exits 2
  Retention: 10 independent SHA-256 reachability sets and corruption rejection passed
  Snapshot integration: ... umask-independent modes and portable-path rejection passed
  verify: ok
```

Targeted checks against the compiled CLI:

```
audit(snapshot with objects["000...0"] = [1,2,3])
  -> {"valid":false,"issues":[{"path":null,"object":"000...0","reason":"digest mismatch"}],
      "files":2,"objects_total":2,"objects_checked":2,"referenced_objects":1,"unreferenced_objects":1}
retention(same snapshot) -> InputError (refused)
restore(same snapshot)   -> InputError (refused)

create with previous.objects[sha256("abc")] = [0,0,0]
  -> InputError("previous snapshot is corrupted")

node main.js /missing.json      -> {"error":"the file does not exist"} exit 1
node main.js /invalid-utf8.bin  -> {"error":"The encoded data was not valid for encoding utf-8"} exit 1
node main.js /17MiB.json        -> {"error":"input exceeds 16 MiB"} exit 1
node main.js (no arguments)     -> {"error":"Usage: ..."} exit 2

restore of mode 0700 entry under umask 077 -> 0700 (was 0700 by luck), 0777 -> 0777 (was 0700)
restore of manifest holding cafe<U+0301>.txt and café.txt -> refused before mkdir, destination absent
```

The first and last of those four lines were revised later: the message became
`the file does not exist` when raw Node text was replaced with a reason, and the usage
error moved into the JSON envelope. The rest of this record is the state on the date it
was written.

Cross-backend output for `create`, `diff` and `retention` requests is byte
identical between the JS and native backends.

## Not changed

`retention` still only plans; nothing is deleted. Snapshots stay self contained,
so `new_object_bytes` remains a content statistic. The 1 MiB adapter and 16 MiB
CLI caps, the regular-files-only rule, and the "trusted local directory" model
are unchanged. All-object audits make `create(previous=…)` and `restore` pay for
a full verification of the input snapshot.
