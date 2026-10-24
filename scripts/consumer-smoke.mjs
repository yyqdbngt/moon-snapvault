// Builds a separate module against this one and runs it, so the exported interface
// is exercised the way a consumer sees it.
//
//   node scripts/consumer-smoke.mjs
//
// Why a separate module: `pub` in MoonBit is module-scoped, so a sub-package of this
// repository would see more than a real consumer can. Only a different module sees
// exactly the public interface, which is what `pkg.generated.mbti` promises.
//
// Every call in the consumer below is one of the exported functions listed in that
// file. If a signature changes without the interface being regenerated, or an
// exported function stops working when called from outside, this fails where the
// in-module tests cannot.
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const moduleName = 'yyqdbngt/moon_snapvault';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {encoding: 'utf8', ...options});
  if (result.error) throw new Error(`${command} could not start: ${result.error.message}`);
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`${command} ${args.join(' ')} failed:\n${result.stdout || ''}${result.stderr || ''}`);
  }
  return result;
}

const consumerSource = `///|
/// Written against the published interface only: every call is one of the exported
/// functions, and nothing here can reach a package-private item.
fn main raise {
  let files : Array[@vault.Value] = [
    @vault.Object(Map([
      ("path", @vault.String("docs/readme.md")),
      ("text", @vault.String("hello")),
    ])),
    @vault.Object(Map([
      ("path", @vault.String("data.bin")),
      ("bytes", @vault.Array([
        @vault.Number(0.0), @vault.Number(255.0), @vault.Number(7.0),
      ])),
    ])),
  ]
  let created = @vault.create_snapshot(files)
  let snapshot = match created {
    @vault.Object(fields) =>
      match fields.get("snapshot") {
        Some(value) => value
        None => abort("create_snapshot returned no snapshot")
      }
    _ => abort("create_snapshot did not return an object")
  }
  println("create_snapshot: ok")

  let valid = match @vault.audit_snapshot(snapshot) {
    @vault.Object(fields) => fields.get("valid") == Some(@vault.Bool(true))
    _ => false
  }
  if not(valid) {
    abort("audit_snapshot did not report the fresh snapshot as valid")
  }
  println("audit_snapshot: valid")

  let restored = @vault.run(
    @vault.Object(Map([
      ("operation", @vault.String("restore")),
      ("snapshot", snapshot),
    ])),
  )
  let count = match restored {
    @vault.Object(fields) =>
      match fields.get("files") {
        Some(@vault.Array(items)) => items.length()
        _ => -1
      }
    _ => -1
  }
  if count != 2 {
    abort("run(restore) returned " + count.to_string() + " files, wanted 2")
  }
  println("run: restored 2 files")

  let answer = @vault.execute(
    Json::object({
      "operation": Json::string("audit"),
      "snapshot": snapshot.to_json(),
    }),
  )
  if answer.stringify().length() == 0 {
    abort("execute returned nothing")
  }
  println("execute: answered")

  if not(@vault.safe_path("a/b.txt")) || @vault.safe_path("../x") {
    abort("safe_path disagrees with its contract")
  }
  println("safe_path: ok")

  if @vault.digest(@utf8.encode("abc")) !=
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" {
    abort("digest does not match the SHA-256 of abc")
  }
  println("digest: ok")

  if @vault.Value::stringify(@vault.parse_value("{\\"a\\":1}")) != "{\\"a\\":1}" {
    abort("parse_value and stringify do not round-trip")
  }
  println("parse_value: ok")

  let failure = try {
    ignore(
      @vault.create_snapshot([
        @vault.Object(Map([
          ("path", @vault.String("../escape")),
          ("text", @vault.String("x")),
        ])),
      ]),
    )
    "no error"
  } catch {
    @vault.InputError(_) => "InputError"
    _ => "other error"
  }
  if failure != "InputError" {
    abort("an unsafe path did not raise InputError, got: " + failure)
  }
  println("InputError: raised and matched")
}
`;

const consumerPackage = `import {
  "yyqdbngt/moon_snapvault" @vault,
  "moonbitlang/core/json",
  "moonbitlang/core/encoding/utf8",
}

pkgtype(kind: "executable")
`;

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'snapvault-consumer-'));
try {
  const version = fs.readFileSync(path.join(root, 'moon.mod'), 'utf8')
    .match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  if (!version) throw new Error('cannot read the version from moon.mod');

  // A consumer resolves a dependency by asking the registry. When this version is
  // not published yet, the graph cannot be solved at all, so the check pins the
  // most recent published version and then puts *this* tree in `.mooncakes`. The
  // compiler sees the current source either way, which is what is being tested; the
  // version string only exists to make the graph resolvable offline.
  const consumer = path.join(work, 'consumer');
  run('moon', ['new', '--user', 'demo', 'consumer'], {cwd: work});

  let pinned = version;
  let resolved = run('moon', ['add', `${moduleName}@${version}`],
    {cwd: consumer, allowFailure: true});
  if (resolved.status !== 0) {
    pinned = '0.2.0';
    const fallback = run('moon', ['add', `${moduleName}@${pinned}`],
      {cwd: consumer, allowFailure: true});
    if (fallback.status !== 0) {
      throw new Error('cannot resolve a registry version to base the check on:\n'
        + (fallback.stdout || '') + (fallback.stderr || ''));
    }
  }

  const installed = path.join(consumer, '.mooncakes', ...moduleName.split('/'));
  fs.rmSync(installed, {recursive: true, force: true});
  fs.cpSync(root, installed, {
    recursive: true,
    filter: (source) => !/\/(_build|\.git|\.mooncakes|node_modules)(\/|$)/.test(source),
  });
  // Keep the graph resolvable while the source stays current.
  const installedManifest = path.join(installed, 'moon.mod');
  fs.writeFileSync(installedManifest, fs.readFileSync(installedManifest, 'utf8')
    .replace(/^version\s*=\s*"[^"]+"/m, `version = "${pinned}"`));

  for (const stale of fs.readdirSync(consumer)) {
    if (stale.endsWith('.mbt') || stale === 'README.mbt.md') {
      fs.rmSync(path.join(consumer, stale), {recursive: true, force: true});
    }
  }
  fs.writeFileSync(path.join(consumer, 'main.mbt'), consumerSource);
  fs.writeFileSync(path.join(consumer, 'moon.pkg'), consumerPackage);

  run('moon', ['build', '--target', 'js'], {cwd: consumer});

  const built = [
    path.join(consumer, '_build/js/debug/build/main/main.js'),
    path.join(consumer, '_build/js/debug/build/consumer.js'),
  ].find((candidate) => fs.existsSync(candidate));
  if (!built) throw new Error('the consumer built but produced no runnable artifact');

  const executed = run('node', [built]);
  const lines = executed.stdout.trim().split('\n');
  if (lines.length < 8) {
    throw new Error('the consumer printed less than expected:\n' + executed.stdout);
  }
  for (const line of lines) console.log('  ' + line);
  console.log(`Consumer: a separate module compiled and ran against the public interface `
    + `(${lines.length} checks)`);
} finally {
  fs.rmSync(work, {recursive: true, force: true});
}
