# Version 0.3.0 boundaries

Each JSON snapshot is self contained, even when previous content is unchanged; `new_object_bytes` is a content statistic, not the physical archive size saved. Format 2 stores object bytes as base64 and format 1 as decimal numbers, so a 1 MiB random file produces roughly 1.33 MiB or 3.57 MiB of JSON respectively. Both are read; `create` writes format 2 by default.

The host adapter caps a backup at 8 MiB of source bytes by default (`SNAPVAULT_ADAPTER_LIMIT_BYTES` overrides it); the core JSON CLI caps input at 16 MiB. Regular files only: no symlinks, empty-directory preservation, timestamps, ACLs or special files.

Audits cover every stored object, referenced or not, and cross-check each key against its SHA-256. `valid` therefore means "this snapshot's bytes are internally consistent", not "this snapshot is authentic": manifests are integrity checked, not authenticated or encrypted.

A format 3 delta stores only the payloads its chain lacks, but its manifest is
still complete, so the snapshot describes its tree without the chain. Reading a
delta needs every link: `audit`, `restore` and `retention` take the chain as a
list, match it by checksum, verify every link, and walk at most 64 links. A
missing link is reported as `missing parent snapshot`; a cycle is refused.

Randomized differential testing (`scripts/fuzz.py`) covers the operations and the
mutations listed in [incremental snapshots](incremental.md), but it never sends
malformed input, so it is not a proof of robustness.

That gap is covered separately by `scripts/robustness.py`, which mutates the
structure of snapshots and requests - wrong types, missing fields, absurd numbers,
2000-deep nesting, control characters, duplicate keys, hostile paths, unknown
operations - and asserts the one property a command-line tool must hold: every
input produces exactly one JSON object on stdout and exit 0, 1 or 2. A crash, an
abort, a hang, a stack trace or partial output fails the run. 305 cases pass.

What that does not establish is that a structurally invalid snapshot is always
*refused* rather than merely answered; several such inputs are answered with a
`valid: false` report, which is the intended behaviour for `audit` and means a
caller must read the report rather than rely on the exit code alone.

Selection matching is linear in files and paths. It used to compare every requested
path against every file, which a request well inside the size cap could push into
minutes: 8000 paths against 8000 files took 5.9 s and grew quadratically. Each file
is now matched by looking up its component prefixes, so the same case takes 0.69 s
and grows with the tree rather than with the product.

A chain larger than one request is read through `locate` and `extract`, one link at
a time. That keeps restores possible, but the payloads are still held in memory
before anything is written, so a restore needs room for the whole tree.

### How much the fixtures actually pin

Each fixture pins something different, and the difference matters when reading a
green run:

- A field fixture pins one value by path and says nothing about anything it does not
  name.
- `"exact": true` pins the whole answer, including field order. Ten fixtures do this,
  one or more per operation, so a field appearing, disappearing, being renamed or
  moving is a failure rather than silence. That is consistent with the project's
  claim of byte-identical output between backends.
- `"error": "text"` pins a message. `"error": true` accepts any message and is only
  used where the message genuinely does not matter; none currently do.

The first version had only the field form and no error text at all, which meant a
fixture could pass for the wrong reason. One did: `create refuses a corrupt previous
snapshot` never reached the corruption check, because the request also failed the
format-3 requirement, and would have kept passing if corruption detection had been
deleted. Both that fixture and the checker were fixed.

### Stale builds are refused, not tolerated

The harness prefers a release artifact and falls back to debug. It caught itself out
while this was being written: after editing source and running `moon build --target
js`, the checker silently used the older release binary and reported three deliberate
regressions as passing. `scripts/engine.mjs` now compares the artifact's modification
time against the newest `.mbt` and refuses to run against a stale build, naming the
build mode and the age. `SNAPVAULT_ALLOW_STALE=1` overrides it for the rare case where
that is intended.

### The public interface is tested from outside

`pub` in MoonBit is module-scoped, so none of the in-module tests can tell whether
an external consumer can actually use the exported functions: they are inside the
module and see more. `scripts/consumer-smoke.mjs` closes that gap by creating a
separate module, installing this source into its `.mooncakes`, and compiling and
running a program that calls every exported function - typed construction, the JSON
`execute` boundary, `run`, `safe_path`, `digest`, `parse_value`, and matching a
raised `InputError`. It fails if an export is renamed or its signature changes, which
is a different failure from the in-module tests, and it is part of `verify.sh` and CI.

### Release readiness

`scripts/verify.sh` is run against the pushed tree from a fresh clone before a
release, not only against a working copy, because that is the artifact users get.
Two checks exist specifically because a released version cannot be corrected in
place: `scripts/stats.mjs` for the counts in `PROJECT_STATS.md`, and
`scripts/interface.mjs` for `pkg.generated.mbti`. The latter was stale once already,
describing `create_snapshot` without a parameter that had been added three commits
earlier.

### Validity is not portability

The same reasoning applies to every other platform-specific naming rule. The core
accepts a path if it is safe and structurally possible *anywhere*: a relative path
whose components are neither empty, `.` nor `..`, with no control characters, and
no component longer than the 255 bytes every supported filesystem allows. It does
not care about backslashes, colons, `<>"|?*`, device names or trailing dots,
because a Linux directory may legitimately contain all of them - and refusing them
in the core meant such a directory could not be backed up at all.

`portablePaths` in the adapter is where the destination decides:

- Every platform refuses a component over 255 bytes and a path longer than the
  platform's own limit (1024 on macOS, 4096 elsewhere, 260 on Windows), plus names
  that collide after case folding or Unicode normalisation.
- Only Windows refuses reserved device names, `<>|?*` and a trailing dot or space -
  so the same snapshot restores fully on Linux and is refused up front when the
  destination is Windows.

`backup` still warns about anything that would not restore on every platform, naming
each problem, because that is useful to know when the snapshot is made. It does not
refuse, and the snapshot is not wrong: it faithfully records what the source held.

The consequence for a caller that writes the core's `restore` payloads itself is
unchanged: that check is theirs.

Two Windows specifics are worth naming because they are not visible from the path
syntax. A drive-relative path such as `c:escape` or `a:../escape` resolves against
the current directory *of that drive*, well outside the destination; containment
still catches it, and the integration suite asserts that rather than trusting it. And
a colon inside a name (`ads.txt:hidden`) is an alternate data stream on NTFS, not a
regular file: it is written but never appears in a directory listing, so the restored
tree would silently differ from the manifest. Windows refuses that name through
`portablePaths`; on Linux and macOS the colon is an ordinary character and the file
restores as an ordinary file.

Two files whose names differ only by case or normalisation form are two files on
Linux and one file on a case-insensitive or normalising volume. That is a property
of the destination filesystem, not of the snapshot, so the two checks live in
different places:

- The core rejects only structural contradictions: a path that cannot be written
  anywhere, the same path listed twice, and a path used as both a file and a
  directory.
- The adapter rejects case and normalisation collisions, including the file/directory
  variant that only appears after folding, before it creates the destination.

This split was a bug fix, not a design change. The core used to fold case as well,
which meant a directory holding `Report.txt` and `report.txt` - perfectly ordinary
on Linux - could not be backed up at all, while the adapter was already warning
that the snapshot "is not portable" and continuing. `audit` now reports such a
snapshot as valid, which is the point: the snapshot faithfully records what the
source held, and `restore` through the adapter still refuses to write it where the
names would collide.

The consequence to know about: a caller that takes the core's `restore` payloads and
writes them itself is responsible for that check. `portablePaths` in the adapter is
the reference implementation.

### Memory

Every exchange with the core is one JSON request and one JSON response, and base64
payloads pass through both. Peak resident memory is therefore a small multiple of
the tree, not a constant:

| Tree | Chain | Restore peak RSS | Heap floor |
|---|---|---|---|
| 16 MiB | 2 links | +136 MiB over baseline | between 64 and 80 MiB |
| 24 MiB | 3 links | +180 MiB over baseline | under 96 MiB |

Streaming inside the adapter was implemented and measured: writing each batch as it
arrives lowered the heap floor from between 64 and 80 MiB to between 56 and 64 MiB,
was 16% slower, and gave up the guarantee that nothing is written before every
payload verifies. That trade was rejected rather than shipped as an option.

A genuinely bounded restore needs the core to emit payloads incrementally instead
of one JSON document per request, which means changing the CLI protocol. Until
then, a tree has to fit in memory with room for its own base64 copy. Building a
delta does better: each link is read, verified and released in turn, so the cost is
the largest link rather than the whole chain.

A delta may be built from a manifest-only parent plus a `known_objects` digest
list, which is what keeps a large base inside one request. The core then cannot
verify the base and says so with `base_verified: false`; the claim is checked when
the snapshot is read, where a false declaration becomes `missing object`. Only the
adapter's two-request path both fits and verifies.

`retention` never plans to delete a snapshot that a kept snapshot's chain names:
the link is promoted into `required_snapshots` instead, because its manifest is
what makes the kept snapshot readable. A link supplied only through `parents`,
with no identity in the request, is listed under `external_parents` so the caller
knows a file it cannot name still has to exist. Genuinely retiring a parent means
`squash`ing its child first.

`squash` folds a chain into one self-contained snapshot and drops objects no file
references; it is the only way this project frees space, and `retention` still
only plans. `restore` takes an optional `paths` selection that must match at
least one file.

`restore` requires a new directory and validates every byte before writing. It applies permission bits with `chmod` after each write, so the process umask cannot clear them, and it reports `modes_applied` plus `modes_exact`.

`modes_exact` is `false` on Windows, which has no Unix permission bits: `chmod` there only toggles the read-only flag, so a recorded `0755` comes back as `0666`. The mode is still stored in the manifest and is applied faithfully everywhere else; the flag exists so a caller does not read `modes_applied` on Windows as "the recorded mode is back". On a case-insensitive or normalization-applying filesystem, names that differ only by Unicode case or normalization form cannot both exist; the adapter detects those collisions and refuses before creating the destination instead of failing halfway. A failed write retains the new partial directory for inspection.

Audits are all-object, so `create` with a `previous` snapshot and `restore` both pay for a full verification of that snapshot; hashing runs at about 61 MiB/s in this implementation. The adapter is designed for trusted local directories; concurrent hostile filesystem changes are not isolated. `retention` only plans: it never deletes files, and its reclaimable set is limited to the objects supplied in the request.
