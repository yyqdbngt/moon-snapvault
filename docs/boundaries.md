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

Note that `scripts/fault-probe.mjs` is deliberately outside `verify.sh`: it needs a
filesystem small enough to fill, which means root or a disk image. Claiming it as part
of the routine ladder would overstate what a green run covers.

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

### The documents are checked too

Prose drifts the same way code does. `scripts/docs.py` checks three kinds of claim that
nothing was watching: internal links resolve, `#anchors` name a heading that still
exists, and the counts stated in `README.md` and `PROJECT_STATS.md` both match the source
and agree with each other. It also requires every shipped script to be mentioned
somewhere, since a script nobody documents is a script nobody runs.

On its first run it found a real drift: `README.md` claimed 87 test declarations while
the source had 93. That number had been updated by hand through several releases and had
fallen three behind, because only `PROJECT_STATS.md` was machine-checked.

Numbers that legitimately vary - timings, peak memory - are deliberately not treated as
claims. A checker that fails when a machine is slower would be turned off within a week.

### The workflow itself is checked

CI is the only cross-platform evidence this project has: the macOS and Windows jobs
cannot be reproduced locally, and several claims above rest on them. That makes the
workflow file part of the evidence, and it was never checked - a step removed, an action
unpinned, or a `continue-on-error` added would have kept every run green while the
coverage it supposedly provided quietly stopped existing.

`scripts/workflow.py` parses `ci.yml` with PyYAML and asserts what makes a green run mean
something: every job has a runner and steps; no step may set `continue-on-error`, mask an
exit status with `|| true` or background its command; every action is pinned to a ref; the
matrix still covers all four backends; and the scripts named in `scripts/verify.sh` all
appear in the integration job, so the local and CI ladders cannot drift apart.

Five deliberate breakages were injected to confirm it fails: a step allowed to fail, a
masked exit status, an unpinned action, a backend dropped from the matrix, and a step
removed from CI only. Each was caught with a message naming the step.

PyYAML is not in the standard library, so the check skips loudly when it is absent rather
than failing a build for a missing optional dependency - and the skip is printed, because
a silent one would read as a pass.

### Cross-backend serialization is pinned, where all four backends run

The project claims byte-identical output across the JS, wasm, wasm-gc and native
backends, and this document leans on that claim when it justifies pinning whole
answers. It was never checked continuously: the CLI is JS only, and the fixture suite
compares exact strings only through it. `moon test --target native` ran the tests, but
no test there asserted serialized bytes.

`serialization_wbtest.mbt` closes that: it pins the exact spelling of numbers (including
`420` rather than `420.0`, `1e+21`, and `-0.0` collapsing to `0`), the escaping rules,
the difference between `stringify` (insertion order) and `canonical` (sorted), the
`canonical` key order itself, and two snapshot checksums. Because those constants are
asserted in a white-box test, all four targets check them on every build, and the check
rests on Python-computed constants rather than on values copied back from the
implementation.

Changing `canonical` to a plain lexicographic sort makes the test fail on every backend,
which is the failure mode the claim is about.

The library compiles for four backends, so a snapshot written by a program on one can be read
by a program on another. Nothing tested that exchange - the CLI is JS only, so the fixtures
never leave it. The closing test asserts a checksum that came from the *published* 0.2.0 for a
three-file tree, and every backend computes it: `9d28a7f6...`. Because the checksum hashes the
canonical manifest, agreement there means agreement on every byte the format depends on, and
because the constant came from MoonCakes rather than from this implementation, one assertion
covers three things - the four backends agree, the formats agree, and the current code agrees
with what was published.

### Every field, mutated every way

`robustness.py` asks whether an input yields one JSON object and a clean exit; it never
looks at `valid`. `fuzz.py` does check verdicts, but on a few randomly chosen mutations
per iteration. `scripts/mutation_sweep.py` closes that gap: it takes one valid snapshot,
mutates every field in turn - delete it, set it to each of eleven wrong types, or change
its value - and asserts the verdict every time.

197 mutants, of which 161 are refused outright, 32 are reported invalid with the
predicted reason, and 4 are legitimately valid. Two properties are asserted:

- If a mutation changes content without recomputing the checksum, the answer may never
  be `valid: true`. That is the failure this project exists to prevent.
- Where the outcome is predictable, the exact verdict and the exact set of reasons must
  match, because an "invalid" for the wrong reason is a bug a reader would find much
  later.

Breaking the digest check makes 5 mutants pass; breaking the size check makes 1. Both
were verified by editing the core and watching the sweep fail.

The 4 valid mutants are worth naming, since they are the format's deliberate edges:
removing `parent` or setting it to `null` describes the same snapshot, because a format
3 canonical form always carries that key; a renamed path with a recomputed checksum is
a different but internally consistent snapshot; and a mode change with a recomputed
checksum is reported valid, which is the documented limit of an integrity check that is
not a signature.

### Performance figures are checked, loosely on purpose

The README quotes timings, which were hand-copied from a benchmark run and checked by
nothing. They survived a change that added an `fsync` to every write - exactly the kind of
change that could have made them ten times wrong. Re-measuring showed the effect was 3-5%,
inside this host's noise, so the quoted figures were still true. That was luck rather than
process, which is why `scripts/perf-check.mjs` now exists.

It compares four cases - backup and restore at 1 MiB and 8 MiB, the sizes the README quotes
- against a recorded baseline, and fails at a factor of two. A percentage threshold would be
worse than none: the same code varies by a tenth run to run on a shared machine, so a strict
check would fail at random and be turned off within a week. Two caught a real 2.2x and 3.5x
regression during testing; ten percent of noise would have caught neither.

Two limits are stated rather than hidden.

Baselines are recorded per platform, because the difference between them is larger than the
threshold: a 1 MiB backup takes 134 ms on macOS and 190 ms on the Linux runner, and 8 MiB
takes 320 ms against 750 ms. One shared baseline would have been wrong by a factor of two on
one of the platforms before any regression occurred.

Within a platform the baseline is the CI runner, not a workstation, because the runner is
where the gate actually runs and the two still differ by nearly a factor of two - the same
Linux backup is 190 ms on the runner and 343 ms on the development machine. That difference
is what the factor of two absorbs, and it is why the threshold cannot be tightened much
further without making the check machine-specific.

Enforcement is tied to the machine the baseline describes rather than to the platform. A
workstation is not the CI runner even when it runs the same operating system, and the
difference is not noise: with a load average of 11 the workstation measured 268 ms against a
130 ms runner baseline, and no amount of retrying fixes a busy host. So the check fails on CI,
where the numbers were recorded, and reports without failing elsewhere; `SNAPVAULT_ENFORCE_PERF=1`
overrides that for a deliberate local run. It also retries a measurement that exceeds the
threshold before believing it - three more attempts after the first - because a real regression
does not get faster when the load subsides. Verified: with a 300 ms per-file delay injected, the
retries exhaust and the failure is reported on 12 runs; without it, local runs report and pass.

When a platform has no baseline, the check measures and prints its numbers rather than
skipping silently, so the figures needed to record one appear in that platform's CI log. The
absence of a baseline is not a regression, so it exits 0.

All three platforms now have one, each recorded from its own CI runner rather than borrowed:
Windows measures 240/220/805/755 ms for the four cases, Linux 190/180/750/630, macOS
140/130/500/400. A borrowed baseline would have been wrong by up to a factor of two, which is
the entire margin the check allows. The recorded figures were each re-checked against a run
of the same job: macOS measured 145/141/480/383 against 140/130/500/400, which is the same
machine within noise. And the figures in `README.md` are copied by hand from a measurement, so
the script can catch a drift of a factor but not a stale sentence - updating the prose is
still a manual step, noted in the script's own output.

### Documentation-reading scripts run on every platform

The encoding defect fixed above was found by running a documentation-reading script on Windows.
`workflow.py` now requires any script that reads markdown to appear in both platform jobs, for the
same reason the platform-branch rule exists: the only way a decoding difference is noticed is by
decoding the file there. Three scripts qualify - `fields.mjs`, `doc-commands.mjs` and
`package-smoke.mjs` - and all three run on macOS and Windows.

The matcher had to be narrowed twice, both times because it reported the wrong thing. Matching
`docs/` or `README.md` as substrings flagged `mutation_sweep.py` and `robustness.py`, which hold a
snapshot whose paths happen to be `docs/b.md` - tests of the documentation, not readers of it. And
matching only named `.md` files missed `doc-commands.mjs`, which finds them by listing a directory
and filtering on the suffix. A rule that reports false problems gets turned off.

### Every documented example names what verifies it

`docs/usage.md` has nine sections that show a case rather than a field table - an unsafe path, a
deduplication, a case collision. Each is a claim about behaviour, and a claim with no test behind
it is how the `--path` flag came to be documented and unusable.

Matching headings to test names does not work. "unsafe path CON.txt" is verified in
`engine_wbtest.mbt` and `tests/cases.json`; "case collision" in `scripts/integration.mjs` and
`engine_wbtest.mbt`. A name match reported three gaps that were not gaps, which is the failure
mode worth avoiding here: a false gap costs someone an afternoon.

So `docs.py` carries an explicit map from section to witness, and both directions are checked - a
section shown without an entry fails, and an entry naming a section that no longer exists fails.
Verified by adding an "empty filename" section, which is reported, and by deleting an entry,
which is reported.

### Every output field is named in the documentation

`scripts/fields.mjs` runs eleven operations with fixed inputs, collects every field they return -
including one level of nesting, so `files[].mode` and `issues[].reason` count - and fails if the
documentation never names one.

Four were missing: `live_bytes`, `collectible_bytes`, `plan_only` and `scope`, all in the
retention plan. They had been in the output for several releases and appeared only inside an
example JSON in the project proposal, which is not where a caller looks. A field a caller
receives and the documentation never names is one they have to read the source to understand.

Two details the check needed. `extract` returns `objects` keyed by digest, and taking those keys
as field names reported a 64-character hash as undocumented. And the probe requests have to match
the real API: the first version guessed `before`/`after` for `diff` and `snapshots` for `locate`,
where the fixtures show `old`/`new` and a single `snapshot`. Reading the fixtures rather than the
interface would have saved that, which is worth remembering about the order to consult them in.

It checks presence, not placement: a field named anywhere in the documentation counts, because
whether prose is adequate is not something a script can judge. That makes it a floor.

### Files are read as UTF-8, not as whatever the platform defaults to

`docs.py` and `workflow.py` called `read_text()` without an encoding, which uses the platform
default: UTF-8 on Linux and macOS, cp1252 on Windows. The documentation contains characters
cp1252 cannot decode - `→`, and the Chinese text the project's own proposal and follow-up notes
are written in - so `docs.py` raised `UnicodeDecodeError` on Windows and took `verify.sh` with it.

That was found by the first run of the package check on the Windows runner, in the step that runs
the shipped documentation checks, which is exactly the branch that had never executed. Every
`read_text` in both files now names `encoding='utf-8'`; the other six Python scripts were checked
and had none.

Worth stating plainly: the encoding bug was invisible on the two platforms every local run used.
It is the second defect the platform-branch requirement found, after its own self-match.

### A platform branch is tested only by running it there

The `macos` and `windows` jobs list their steps explicitly rather than running `verify.sh`, because
there is no `sh` guarantee and the two platforms do not need every check. That means a script
added to `verify.sh` runs on Linux and nowhere else. `package-smoke.mjs` was added that way, and
its Windows branch - PowerShell instead of `unzip` - was never executed, in a check whose whole
purpose was to prove the shipped artifact works.

`workflow.py` now enforces the invariant that would have caught it: a script whose source reads
the platform name has a branch per platform, and the only way that branch is tested is by running
the script there, so such a script must appear in both platform jobs. Exemptions carry a reason,
the same discipline the command classifier uses.

Adding the check found a second case immediately: `fault-probe.mjs` reports that it cannot build a
small filesystem on Windows, and that report had never been run on Windows. It is now in the
`windows` job. The check also flagged itself - its own source contains the string it searches for
- which is why the needle is built by concatenation.

### The archive is usable as a distribution, not only as a library

`consumer-smoke.mjs` proves the archive can be compiled against. `package-smoke.mjs` proves the
other half: that what a consumer installs is usable the way the README says. It unpacks the
archive into a temporary directory and, using only files inside it,

- runs the shipped CLI cold and checks it asks for a build rather than crashing on a missing
  artifact - packaging ships no `_build`, so a first run has nothing to run;
- builds, then backs up and restores a tree through `scripts/filesystem.mjs`, comparing every
  restored file byte for byte;
- runs `moon test` there, because the archive ships the white-box tests and the fixtures, and
  the count has to match what `PROJECT_STATS.md` claims;
- runs the shipped `docs.py`, `workflow.py` and `check.mjs`.

That last one found a real defect. `sh scripts/verify.sh` is documented as "one command runs
everything", and the archive ships it - but running it inside a package failed, because
`workflow.py` demanded `.github/workflows/ci.yml` and `moon package` does not ship dotfile
directories. The ladder could not run on the artifact it ships.

`workflow.py` now distinguishes the two cases: no `.github` and no `.git` means this is a package,
which has no CI configuration to check, and it says so and succeeds. A checkout that has lost its
workflow still fails, because a deleted workflow silently passing is exactly what that file
exists to prevent.

### The published artifact is what gets tested

`scripts/consumer-smoke.mjs` used to copy the source tree into a consumer's `.mooncakes` and
compile against that. The source tree is what the rest of the ladder already covers; what a
consumer downloads is the archive `moon package` produces, and nothing tested it. The two can
differ - a file the module needs that packaging leaves out - and the difference would surface on
the version that ships. The check now runs `moon package`, unpacks the archive, and compiles
against that. Verified by deleting `base64.mbt` from the unpacked tree, which fails at the remove
of the first export.

The archive holds 110 files: the MoonBit sources, `moon.mod`, `moon.pkg`,
`pkg.generated.mbti`, the documentation, `examples/`, `scripts/` and `tests/`. Including the host
scripts and the compatibility fixtures is deliberate - they are what makes `scripts/filesystem.mjs`
and the 0.2.0 fixtures usable by someone who installed the package - and it does mean the package
carries development tooling. That is a size judgement, not a correctness one.

### Warnings are measured with the command that can see them

`moon build` does not compile white-box test files, so it reports zero warnings for a tree whose
tests warn. Every "zero warnings" claim in this repository had been made from `moon build` output.
A warning did sit in `coverage_wbtest.mbt` for several revisions - a lambda declared
`-> String raise` whose body catches every error, so the `raise` was dead - and `moon build` never
saw it.

`scripts/warnings.mjs` runs `moon check` on all four targets, which compiles everything without
emitting object files, and fails on any warning. It counts rather than matching text: warning
text is a compiler detail that changes between releases, so pinning it would break on upgrade
rather than on defect. Four targets rather than one because a warning can be backend-specific.

### The safety net is tested, not just the code

`scripts/defect-matrix.mjs` injects sixteen realistic mistakes one at a time - a missing
`fsync`, a format 1 payload written as base64, a checksum that ignores `version`, `--path` parsed
as a positional, an audit that skips unreferenced objects, a restore that allows an existing
destination - and records which check catches each. Coverage answers which code the tests
execute; this answers would a mistake be noticed, which is the question a user has.

All sixteen are caught. What the matrix did find was a gap, on its second run: nothing tested a
path whose components are each legal but whose total exceeds what the platform can hold. The core
accepts such a snapshot - the 255-byte limit it enforces is per component - and only the adapter's
whole-path check stops a restore from dying halfway through with a partial directory. Every
component under 255 bytes, the path 1,198, the macOS limit 1,024: no test built one. The
integration suite does now.

Two design points came out of running it. The first version left `integration.mjs` out of the
check list because it is slow, which would have reported any defect only that suite catches as
caught by nobody - the worst error here, since a false gap sends someone hunting a hole that is
not there. And a defect gated on another platform cannot be judged on this one: `windowsProblems`
is not consulted on macOS or Linux, so "Windows device names accepted" is recorded as not
observable rather than a gap.

The full matrix takes about six minutes, so it is a deliberate probe rather than part of the
ladder. `--check-anchors` runs there instead: it verifies that every entry's text still occurs
exactly once, because a stale entry is what would turn a working matrix into a false gap.

### Coverage is measured, and may only widen

`moon test --target js --enable-coverage` reports which lines the white-box tests execute.
The first run was informative: four arms of `run`'s dispatch table - `assemble`, `locate`,
`extract`, `squash` - had never been executed by any test, because the only thing reaching
them was the Node CLI, which `moon test` does not run. Neither had the base64 guard against
a code unit above 255, or the JSON-to-`Value` conversion for `null` and numbers. Nothing
was wrong; nothing would have noticed if it had been.

Those are now tested, written from the report rather than from the code, and the numbers
went from 888 to 931 executed lines. `scripts/coverage.mjs` records the result in
`tests/coverage-baseline.json` and fails if any file's uncovered lines grow, which catches
both a deleted test and new code without one. It deliberately does not chase a percentage:
a target would reward deleting code.

Two files are excluded because `moon test` does not run binaries: `cmd/main/main.mbt` and
`cmd/bench/main.mbt` sit at 0/38 and 0/34. Their behaviour is covered - `cli-contract.mjs`
runs the CLI six times and the benchmark is run by hand - but their lines cannot be measured
this way, and the check prints both with that reason rather than quietly omitting them.

`cmd/bench` was a different case: nothing ran it at all. The numbers in the docs came from
`scripts/bench.mjs`, which measures the adapter, not from this binary - so a bug in the
benchmark's own reporting would have gone unnoticed until someone quoted it.
`scripts/bench-smoke.mjs` now runs it and checks that every line is shaped like a
measurement: a label, a positive duration and a finite throughput. It does not assert timings,
which vary by host and are `perf-check.mjs`'s job. Breaking the format - dropping one comma -
makes it fail.

That is a limit of the tooling rather than of the tests, and it was checked rather than
assumed. `moon coverage analyze` reports the same 72 uncovered lines as `test` followed by
`report`, so the two paths measure the same thing; `moon build --enable-coverage` produces no
trace at all, so an instrumented binary run by the contract test would emit nothing. A test
inside the package cannot help either: the two functions worth testing there are `extern "js"`
shims onto the Node process, and calling them from a test would read the test runner's argv
and set its exit code. The lines are unreachable for measurement, not untested.

A second pass with the report in hand turned up more of the same: the accessors that turn
wrongly-typed JSON into named refusals, `retention`'s guard against planning over a corrupt
snapshot, `locate`'s depth limit, `extract`'s format check, and the duplicate-digest path.
Tests for all of those took the library from 878 to 893 executed lines.

Two of the guards turned out to be unreachable rather than merely untested, and saying so
is more useful than leaving them as silent gaps:

- `base64_decode`'s `written != decoded_length` check and its padding re-check cannot fail
  given how `data` and `padding` are derived. This was argued first and then measured: an
  exhaustive search over 472k strings up to length six left the report at 53/55. A bounded
  version of that search is now a test, so the claim is rechecked on every build.
- `locate`'s cycle guard needs a link whose checksum is also an ancestor's, which is a hash
  fixed point. What happens instead - and what is asserted - is that a manifest naming an
  absent parent is reported as `missing_parent` rather than followed.
- `retention`'s `missing parent` arm is behind the audit, which resolves the chain first and
  refuses on its verdict. The assertion pins that verdict, which is the protection a caller
  actually gets.

A third pass reached 894 of 953. The remaining 59 lines are worth naming rather than
chasing, because they are almost all one of three things:

- statement lines that carry no branch, which the coverage tool counts as uncovered because
  the expression on them never completed - a `let size = num(...)` whose failure path raises
  earlier will show as unexecuted even when the code after it runs;
- arms behind a check that runs first: the `format < 3` reuse path needs a previous snapshot
  in an old format, and that combination is refused at `a parent chain requires format 3`
  before the walk begins;
- the two base64 refusals already measured as unreachable.

The library sits at 93.8%: 894 of 953 lines. Further gains would mean either contriving
inputs the format forbids or deleting defensive code, and neither would make the program
more correct. Most of the remainder is defensive: the padding
re-check and the `written != decoded_length` check in base64 decoding cannot fail given how
`data` and `padding` are derived, and they stay as defensive code with the count pinned.

### Backward compatibility is tested against the published version

`0.2.0` is what `moon add` resolves, so anyone who used it has snapshots on disk.
`tests/compat/` holds two of them, produced by that published version from MoonCakes and
committed unchanged, and `scripts/compat.mjs` reads them with the current code: audit,
restore, diff and retention. The fixtures are `"version": 1` with decimal byte arrays, a
shape nothing else in the suite produces - the format-1 fixtures are written by hand from the
current code, which is exactly the circularity this avoids.

Two facts about the published version came out of building the fixtures, and both were
assumptions I would otherwise have got wrong:

- **Its deltas are self-contained.** `previous=` was accepted and changed only the statistics;
  the bytes written were the whole tree. Real incremental storage arrived with format 3, so
  there is no 0.2.0 chain to extend.
- **It writes format 1 only.** There is no way to ask it for the base64 layout; that is format
  2, added after publication. So "both older formats stay readable" in the README refers to
  files the current code can write, plus these real ones.

The reverse direction is tested too, and it is the stronger claim: the current code asked for
`format: 1` must produce the same snapshot 0.2.0 produced from the same tree. It does - the
checksum is `9d28a7f6...` from both, and the canonical forms match - so a file written today is
indistinguishable from one written by the published version. The comparison is on the canonical
form rather than raw JSON, because that is what the checksum covers; comparing raw text would
fail on key order and would be testing the serializer rather than the format.

Verified load-bearing three ways: disabling the format 1 payload decoder makes the fixtures
unreadable, dropping `version` from the format 1 checksum body makes every old file report a
checksum mismatch, and writing base64 for format 1 trips the decimal-array assertion. Each
produces named findings rather than a stack trace.

One mistake worth recording: the first version of this script let a refusal escape as an
exception in the diff block, so a broken build printed a stack trace instead of four findings.
Every assertion now guards on its answer existing.

### Documentation commands are executed, not just written

`scripts/doc-commands.mjs` parses every shell block in the documentation, classifies each
command, and runs the ones nothing else runs. An unclassified command is a failure, because
a new line in a README would otherwise be checked by nobody - which is exactly how the
`--path` bug got in.

Current split: 7 documented invocations executed with placeholders substituted, 41 covered
by the verify ladder, 2 argument shapes, and 35 lines that are results rather than
commands. The exemption list is in the script with a stated reason per entry; a line
without one fails.

The seven include `restore current.json DEST --path docs`, the form that was broken.
Restoring the bug - reading the third argument positionally again - makes this script fail
and nothing else does.

Writing it also turned up two stale lines in `docs/audit-contract-20261024.md`, a record
that presented `{"error":"ENOENT: ..."}` and `usage line, exit 2` as observed behaviour.
Both had been made false by the error-contract change. The record is corrected and marked
as revised, because evidence that quietly stops being true is worse than no record.

### A documented invocation has to work

`--path` and `--format` were unreachable. The parser read the fourth argument as the
parent snapshot and only scanned for options *after* it, so the exact form the README
shows - `restore current.json DEST --path docs` - bound `--path` as a filename and failed
with `Snapshot file does not exist: --path`. The same held for `squash ... --format 2`.

That meant two documented capabilities, selective restore and choosing the output format,
could not be used from the adapter at all. The library functions behind them were correct
and covered; only the command line was not, and nothing tested a command line with a flag
in it.

Options are now pulled out of the whole argument list before anything is read
positionally, so they may appear anywhere. A missing value, a value out of range and an
unknown flag are each named and exit 2, since all three are usage mistakes. The CLI
contract test exercises the documented forms and each of those three refusals, and was
confirmed to fail when `--path` goes back to being a positional.

### Refusals name the entry

Walking a source tree can refuse five things: a symbolic link, a special file, an entry
that vanished, an entry that cannot be read, and the adapter's size limit. Each of those
used to be either a sentence with no file in it - `Special files are unsupported` - or a
raw `EACCES` from Node. In a tree of ten thousand files, both are unactionable: the caller
knows something is wrong and not what to fix.

They now name the relative path, which is the same string that appears in the snapshot:

| Situation | Message |
|---|---|
| symlink | `Symbolic link in the path: a-link` |
| fifo or socket | `Special file in source (not a regular file or directory): a-fifo` |
| unreadable | `Cannot read locked.txt: permission denied` |
| vanished | `Cannot inspect gone.txt: it no longer exists` |
| over the limit | `Source exceeds the 8 MiB per-backup limit at big.bin (8.01 MiB so far)` |

One `reason()` function turns errno codes into words, so the same problem does not read
two ways depending on where it was met. The integration suite asserts that each of these
messages names its entry and that none of them is a raw errno; both assertions were
confirmed to fail when the old wording is put back.

Building those scenarios needs different tools per platform, and the suite checks which ones
are available rather than assuming. `chmod 0o000` makes a file unreadable on a Unix filesystem;
NTFS has no such bits, so Windows uses an ACL - `icacls /deny` - and the case verifies the lock
by attempting a read before it is included, because an Administrator token can bypass the ACE.
It works: the Windows job now exercises the refusal, and reports it as `operation not permitted`
rather than `permission denied`, since an ACL refusal arrives as EPERM where a Unix mode refusal
arrives as EACCES. Both are translations of an errno and both name the entry, which is what the
assertion checks - its first version hard-coded one wording and failed on the other.

A symlink needs Developer Mode on Windows, so that case is skipped if creation fails rather than
claimed. And `restore` reports `modes_exact: false` there, for the same reason chmod cannot help:
permission bits are not something NTFS stores.

The first attempt at the Windows lock also failed, in a way worth recording: the lock worked and
the cleanup then could not delete the tree, because the deny ACE was still on the file. Unlocking
now uses `icacls /reset` and the case refuses to run at all if the unlock cannot be verified - a
test that strands a permission is worse than no test.

A source tree that changes while it is being read can still produce a snapshot of a state
that never existed as a whole. That is inherent - the walk is not a transaction - and it
stays documented rather than half-fixed. What is now true is that it fails *legibly*.

### Durability: what `verified` actually meant

Until this was measured, neither backup nor restore called `fsync` at all. `writeFileSync`
returns when the bytes reach the page cache, so a power cut could leave a snapshot whose
name exists and whose length is zero - and a restore that had already reported
`verified: true`. That is the silent version of the failure this project exists to prevent,
which made it worth an explicit check rather than an assumption.

Both paths now sync before they report: the snapshot file and its directory before
publication, every restored file and every touched directory before success. A test counts
the calls by patching `fs` in a child process, and was confirmed to fail when either sync
is removed or when the opt-out stops being reported.

The cost is honest and uneven. A few large files barely change (1 MiB: 74 → 80 ms); many
small files are dominated by latency (200 files of 1 KiB: 79 → 852 ms, eleven times
slower). Durability is the default anyway, because a backup tool that is fast and wrong is
not a backup tool. `SNAPVAULT_NO_FSYNC=1` exists for a scratch copy and reports
`durable: false`, so nobody can end up without the guarantee and without knowing.

What this does not do: `fsync` protects against losing power on a filesystem that honours
it. It says nothing about a disk that fails, so it is not a substitute for redundancy.

### What a failed restore leaves behind

The documented promise is that a failed write retains the new partial directory for
inspection. That was untested, so it was verified against a filesystem that is
genuinely too small - a 2 MiB tmpfs, a 5.33 MiB snapshot - and it holds: three of four
entries survive, the file being written is present and truncated, the rest are absent.

"For inspection" is only actionable if the reader knows where it stopped, which the
error did not say. It now does: `Restore failed at f2.bin; the partial destination is
retained for inspection: ENOSPC: no space left on device, write`. Files are written in
manifest order, so everything before `f2.bin` is complete and `f2.bin` itself is not.

The probe makes a filesystem too small for the snapshot, and how it does that differs by
platform: Linux needs root for a tmpfs, macOS uses `hdiutil` and needs no privileges at
all, Windows has neither and the probe says so and exits. It therefore runs in the macOS
CI job on every push, which is the first time this branch has been covered continuously;
on Linux it stays a deliberate `sudo -n node scripts/fault-probe.mjs`.

The claim itself turned out to be platform-independent and true on both: the partial
directory is retained, the error names the file, and that file is the truncated one -
`f0.bin` on APFS, `f2.bin` on tmpfs, which differ only because the volumes fill at
different points. The failures that need nothing special -
a missing snapshot, malformed JSON, a destination that cannot be created - are in the
integration suite and run on all three platforms. All of them name the cause rather
than leaking `ENOENT`, `EACCES` or `EEXIST`.

### Concurrency

Two processes may race to the same snapshot path or the same restore destination. The
guarantee is narrow and therefore useful: one of them wins, the others fail with a
message naming the conflict, and no destination is ever a mixture of two results.

This holds because publication is a hard link, which fails when the name exists, and
because a restore destination is created with an exclusive `mkdir`. Both were
previously asserted in a comment and tested nowhere; the integration suite now races
six processes at each and checks one winner, five specific refusals, no surviving
temporary file, and byte equality between the restored tree and its source. Replacing
the hard link with a plain copy makes the suite fail.

What is not covered: concurrent *readers* of a snapshot being written, and a process
killed between the link and the temporary-file cleanup. The former is safe by
construction, since a name only ever refers to a complete snapshot; the latter can
leave a `*.tmp` file next to the snapshot, which nothing reads.

### Examples are executed, not illustrated

`examples/` ships with the package and every `*.json` in it is run by
`scripts/examples.mjs`, with the exact answer pinned under `examples/expected/`. Before
this they were never executed: the request README tells a reader to run first had no
test behind it, and the eleven operations were documented by example for three of them.
The pinned files double as documentation, since each one is the answer a user really
gets rather than one a walkthrough claims.

The check also refuses to run against a build older than the source, for the same
reason the fixture checker does: a stale artifact would test code that is no longer on
disk.

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

The guard counts only files that are linked into the artifact. Counting white-box test files
made it permanently unfixable: `moon build --release` does not rebuild anything for a change to
`*_wbtest.mbt`, so the artifact stays older than the source and the guard fails forever with no
way out except `SNAPVAULT_ALLOW_STALE=1`. Restoring a test file from a backup was enough to
trigger it. Test files are now excluded, which is correct because they are compiled only by
`moon test`.

Two improvements to how that failure is reported, both prompted by hitting it. A step that
assumes its prerequisite succeeded now checks first - the third occurrence of that shape in a
check of mine, after the compatibility and compatibility-diff cases - and a mismatch now carries
the tool's own message, because four identical "exit 1, wanted 0" lines said nothing about the
stale build behind them.

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
