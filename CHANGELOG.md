# Changelog

## Unreleased - 0.3.0

Module version in `main` is 0.3.0; `moon add yyqdbngt/moon_snapvault` still
resolves the published 0.2.0 until a release is published.

### Incremental snapshots (format 3)

- A snapshot may declare `parent` and store only the objects its chain does not
  already hold. `create` with `previous` writes format 3; `format: 3` without
  `previous` starts a chain explicitly. `format: 2` refuses a parent instead of
  ignoring it.
- `parent` is part of the checksum for format 3, so a delta cannot be re-pointed
  at a different base. The manifest stays complete: only payloads are
  incremental, and `diff` is unchanged.
- `audit`, `restore` and `retention` accept `parents` and resolve the chain by
  checksum. `audit` reports `chain_depth`, `objects_inherited` and the parent;
  `valid` covers the whole chain. A missing link is an issue
  (`missing parent snapshot`), and `restore` refuses before writing anything.
- Chains are walked to 64 links with every manifest verified; a cycle or a
  deeper chain raises instead of looping.
- `create` reports `reused_object_bytes`, `objects_stored` and `objects_reused`.
- Adapter: `backup` writes a delta when given a previous snapshot and returns
  `format`, `parent` and `snapshot_bytes`; `restore` takes the chain. Requests
  are measured before they are sent, so a delta too large for the 16 MiB CLI cap
  fails with the split between source and parent instead of "input exceeds
  16 MiB".
- 3 MiB tree, one small file changed: base 4.1 MB / 611 ms, delta 752 B / 685 ms.

### The stale-build guard could not be satisfied

- The guard compared the artifact against the newest `.mbt` in the tree, test files included.
  `moon build --release` rebuilds nothing for a white-box test file, so touching or restoring
  one left the artifact older than its "source" and the guard failed permanently, with
  `SNAPVAULT_ALLOW_STALE=1` as the only way past it. Test files are compiled only by `moon test`
  and are now excluded.
- Two reporting fixes that came out of hitting it: a step now checks its prerequisite before
  using its output - the third occurrence of that shape in a check of mine - and an exit-code
  mismatch carries the tool's own message. Four identical "exit 1, wanted 0" lines had nothing
  in them about the stale build causing them.

### A snapshot crosses backends unchanged

- The library compiles for four backends, so a snapshot written on one can be read on another.
  Nothing tested that exchange: the CLI is JS only, so the fixtures never leave it and the
  per-backend tests only compared each to itself.
- `serialization_wbtest.mbt` now asserts a checksum taken from the published 0.2.0 for a
  three-file tree, and all four backends compute it on every build. Since the checksum hashes
  the canonical manifest, agreeing on it means agreeing on every byte the format depends on;
  since the constant came from MoonCakes, the one assertion covers the backends, the formats
  and the published version together.
- Verified: changing the expected value by one nibble fails the test on the backend that ran it.

### Zero warnings had been measured with a command that cannot see warnings

- `moon build` does not compile white-box test files. Every "0 warnings" claim in this repository
  came from `moon build` output, and a warning had been sitting in `coverage_wbtest.mbt` for
  several revisions: a lambda declared `-> String raise` whose body catches every error, so the
  `raise` was dead.
- `scripts/warnings.mjs` runs `moon check` - which compiles the test files - on all four targets
  and fails on any warning. It counts rather than matching text, because warning text changes
  between compiler releases and a check pinned to it would break on upgrade instead of on defect.

### Documentation-reading scripts are run on every platform

- `fields.mjs` and `doc-commands.mjs` are now in the `macos` and `windows` jobs, alongside
  `package-smoke.mjs` which already ran there. Reading UTF-8 documentation is exactly where the
  cp1252 defect hid, and running the readers on every platform is what finds that class.
- `workflow.py` enforces it: a script that reads markdown must appear in both platform jobs.
- The matcher was narrowed twice because it reported false problems. Substring matching on `docs/`
  flagged `mutation_sweep.py` and `robustness.py`, whose test snapshots contain a path `docs/b.md`
  - tests of the documentation rather than readers of it. Matching only named `.md` files missed
  `doc-commands.mjs`, which lists a directory and filters on the suffix.

### Documented examples now name what verifies them

- `docs/usage.md` has nine sections showing a case rather than a field table. Nothing connected
  them to a test, which is how `--path` came to be documented and unusable.
- `docs.py` now maps each section to the files that verify it, and checks both directions: a
  section with no entry fails, and an entry naming a removed section fails.
- The map is explicit rather than derived, because matching headings to test names reports false
  gaps: "unsafe path CON.txt" is verified in `engine_wbtest.mbt`, not in a fixture of that name.

### Four retention fields were never documented

- `live_bytes`, `collectible_bytes`, `plan_only` and `scope` had been in the retention plan's
  output for several releases and were named only inside an example JSON in the project proposal,
  which is not where a caller looks. They are now in the retention field table in
  `docs/usage.md`, with what each one counts.
- `scripts/fields.mjs` makes it a rule: eleven operations, every returned field including one
  level of nesting, and the documentation has to name each. 52 fields across 11 operations, and
  a field added without a doc line now fails the ladder.
- It checks presence rather than placement, because whether prose is adequate is not something a
  script can judge. That makes it a floor rather than a guarantee.

### Python scripts read files in the platform's default encoding

- `docs.py` and `workflow.py` called `read_text()` without an encoding, which is UTF-8 on Linux
  and macOS but cp1252 on Windows. The documentation holds characters cp1252 cannot decode - `→`
  and the Chinese text in the project's proposal and follow-up notes - so `docs.py` raised
  `UnicodeDecodeError` on the Windows runner and took `verify.sh` with it.
- Found by the first run of `package-smoke.mjs` on Windows, in the step that runs the shipped
  documentation checks, which is the branch the platform requirement had just started executing.
- Every `read_text` in both files now names `encoding='utf-8'`; the other six Python scripts were
  audited and had none.

### A script in verify.sh runs on Linux only

- The `macos` and `windows` jobs list their steps explicitly, so a script added to `verify.sh`
  executes on Linux and nowhere else. `package-smoke.mjs` was added that way and its Windows
  branch - PowerShell instead of `unzip` - was never executed.
- `workflow.py` now requires any script whose source reads the platform name to appear in both
  platform jobs, with a reasoned exemption list. Adding it found a second case at once:
  `fault-probe.mjs` reports that it cannot build a small filesystem on Windows, and that report
  had never run on Windows. It is in the `windows` job now.
- The check flagged itself first, because its own source contained the string it looks for; the
  needle is built by concatenation.

### verify.sh could not run on the package it ships

- The archive contains `scripts/verify.sh`, documented as "one command runs everything", and
  running it inside an installed package failed at the CI-workflow step: `workflow.py` required
  `.github/workflows/ci.yml`, and `moon package` does not ship dotfile directories. The package
  could not verify itself.
- `workflow.py` now separates the cases. Absent `.github` and `.git` means a package: there is no
  CI configuration to check, it says so and exits 0. A checkout that lost its workflow still
  exits 1, because a deleted workflow passing silently is the failure that file prevents.
- `scripts/package-smoke.mjs` makes it permanent. Using only files inside the archive it runs the
  shipped CLI cold (which must ask for a build, since packaging ships no `_build`), builds, backs
  up and restores through `scripts/filesystem.mjs` comparing bytes, runs the shipped white-box
  tests and matches the count against `PROJECT_STATS.md`, and runs the shipped `docs.py`,
  `workflow.py` and `check.mjs`.
- Its first run found the defect above, via the shipped `docs.py`, which reported that the new
  script was not mentioned in any document - the shipped checks work inside the package.

### The consumer check now compiles against the package archive

- `consumer-smoke.mjs` copied the source tree into `.mooncakes`. The source tree is already
  covered by everything else; what a consumer actually downloads is the archive `moon package`
  produces, and that had never been compiled. It now runs `moon package`, unpacks the archive,
  and builds against it - verified by deleting `base64.mbt` from the unpacked tree.
- `moon package` also answers what would be published: 110 files, sources plus documentation,
  examples, host scripts and the 0.2.0 compatibility fixtures, and no build output or dependency
  directory.

### A defect matrix, and the gap it found

- `scripts/defect-matrix.mjs` injects sixteen realistic mistakes one at a time and records which
  check catches each. All sixteen are caught - but the matrix found a real gap on its second run.
- Nothing tested a path whose components are each legal yet whose total exceeds the platform
  limit. The core accepts such a snapshot, because its 255-byte rule is per component; only the
  adapter's whole-path check prevents a restore that dies halfway through and leaves a partial
  directory. The integration suite now builds one: components of 240 bytes, a path of 1,198, the
  macOS limit 1,024, refused with nothing created.
- Two fixes to the matrix itself: `integration.mjs` was left out of the check list for speed,
  which would have reported any defect only that suite catches as caught by nobody; and a defect
  gated on another platform is now recorded as not observable rather than as a gap.
- The full run takes six minutes, so `--check-anchors` runs in the ladder instead. It catches the
  failure mode that matters for a matrix: an entry whose code has moved, which would report a gap
  that no longer exists.

### The unreadable-file refusal is now exercised on Windows

- It had been skipped there since it was written, because `chmod 0o000` does not stop a read on
  NTFS. Windows has ACLs, so the case now uses `icacls /deny` and verifies the lock by
  attempting a read before including itself - an Administrator token can bypass the ACE, and the
  runner runs as Administrator.
- It works, and it found a difference: an ACL refusal arrives as EPERM where a Unix mode refusal
  arrives as EACCES, so the message reads `operation not permitted` on Windows and `permission
  denied` elsewhere. Both name the entry and neither leaks an errno; the first assertion
  hard-coded one wording and failed on the other.
- Two failures on the way, both recorded because they shaped the design: the deny ACE survived
  into `rmSync` and killed the job, and `icacls /remove:d` did not remove it. Unlocking now uses
  `/reset`, the case refuses to run if the unlock cannot be verified, and the shared cleanup
  resets ACLs and retries once.

### The performance gate was flaky, and is now honest about where it applies

- It failed at 288 ms against a 140 ms baseline while the host had a load average of 11. A
  check that fails because the machine is busy is a check that gets switched off, so a
  measurement over the threshold is now retried three more times before it is believed - a real
  regression does not get faster when the load subsides.
- Retrying alone was not enough, because the load persisted. The baseline belongs to the CI
  runner, not to whatever machine runs the ladder, so enforcement now follows that: it fails on
  CI and reports without failing elsewhere, with `SNAPVAULT_ENFORCE_PERF=1` to override.
- Two bugs in the retry itself: it ran after the scratch directory had been removed, and it
  reused a helper that assumed that directory still existed. Verified both ways with a 300 ms
  per-file delay injected - local reports, CI fails on the best of 12 runs.

### Backward compatibility with the published 0.2.0

- `tests/compat/` holds two snapshots produced by `yyqdbngt/moon_snapvault@0.2.0` from
  MoonCakes and committed unchanged; `scripts/compat.mjs` reads them with the current code and
  checks audit, restore, diff and retention. They are `"version": 1` with decimal byte arrays,
  a shape nothing else in the suite produces.
- Two facts about the published version came out of building them: its `previous=` parameter
  changed only the statistics, so its deltas were self-contained and there is no 0.2.0 chain to
  extend; and it writes format 1 only, format 2 having been added after publication.
- The reverse direction is now asserted as well, and it is the stronger claim: asking the
  current code for `format: 1` produces the same snapshot 0.2.0 produced from the same tree,
  checksum `9d28a7f6...` and matching canonical forms. A file written today is therefore
  indistinguishable from one written by the published version.
- Verified three ways: disabling the format 1 payload decoder makes the fixtures unreadable,
  dropping `version` from the format 1 checksum body makes every old file report a mismatch,
  and writing base64 for format 1 trips the decimal assertion. Each yields named findings.
- Fixed a flaw in the first version: a refusal in the diff block escaped as an exception, so a
  broken build printed a stack trace instead of findings.

### Documented timings, re-measured and then guarded

- The README's performance figures were hand-copied from a benchmark and checked by nothing.
  They had survived the `fsync` change, which could plausibly have made them ten times wrong.
  Re-measured, the effect was 3-5% - inside this host's noise - so the figures were still
  true, and they are now stated with their measurement conditions.
- `scripts/perf-check.mjs` compares backup and restore at 1 MiB and 8 MiB against a recorded
  baseline and fails at a factor of two, which distinguishes a real regression from scheduler
  noise. Verified by adding a per-file delay: 331 -> 741 ms and 1287 -> 4455 ms were reported.
- Baselines are per platform, because the platforms differ by more than the threshold: 1 MiB
  backs up in 134 ms on macOS and 190 ms on the Linux runner, 8 MiB in 320 ms against 750 ms.
  A shared baseline would have been wrong by a factor of two on one of them before any
  regression happened. The check now runs on macOS too, not only on Linux.
- Within a platform the baseline is the CI runner rather than a workstation, since the same
  Linux backup is 190 ms there and 343 ms here. The factor of two absorbs that, which is why
  the threshold cannot be tightened much further without making the check machine-specific.
- A platform with no baseline gets its numbers measured and printed rather than a silent skip,
  so they appear in that platform's CI log. Windows was in that state for one run - it
  printed 240/220/805/755 ms - and now has the same treatment as the others, recorded from its
  own runner rather than borrowed. A borrowed baseline would have been wrong by up to a factor
  of two, which is the entire margin the check allows.
- Both recorded baselines were checked against their runners: macOS measures 145/141/480/383
  ms against a recorded 140/130/500/400, which is the same machine within noise.
  `README.md` prose still has to be updated by hand, and the script says so when it fails.

### Coverage, third pass: the remainder is defensive

- Three more reachable arms tested: an object reused within one format 2 request, a file
  entry with no `mode` (defaults to 0644), an absent `digests` member, and a manifest-only
  parent - which `locate` reads happily while `audit` refuses it, because the latter needs
  payloads.
- A fourth guard confirmed unreachable rather than untested: the `format < 3` reuse arm
  needs a `previous` snapshot in an old format, and that is refused before the walk at
  `a parent chain requires format 3`. Both the refusal and the reachable format 2 dedup path
  are now asserted.
- 116 declarations, 894 of 953 lines (93.8%). The remaining 59 are statement lines with no
  branch, arms behind a check that runs first, and the two measured base64 refusals. Going
  further would mean contriving inputs the format forbids or deleting defensive code.

### Coverage, second pass: three guards that cannot fire

- Following the coverage report turned up more unexecuted branches: the accessors that turn
  wrongly-typed JSON into named refusals, `retention`'s refusal to plan over a corrupt
  snapshot, `locate`'s depth limit, `extract`'s format check, the duplicate-digest path, and
  `locate`'s handling of a link carrying payloads. Tests for those took the library from 878
  to 893 executed lines (93.7%), 110 declarations.
- Verified rather than argued that two base64 refusals are unreachable: an exhaustive search
  over 472k strings up to length six left the report at 53/55. A bounded version of that
  search (4,681 candidates, both counts pinned) is now a test, so the claim is rechecked on
  every build.
- Three guards are unreachable by construction and the docs now say so, alongside what
  actually protects the caller: `locate`'s cycle check needs a hash fixed point, and a
  manifest naming an absent parent is reported as `missing_parent` instead; `retention`'s
  `missing parent` arm sits behind the audit, which resolves the chain first.

### Coverage measured; six untested branches found

- `moon test --target js --enable-coverage` had never been run. It showed four arms of
  `run`'s dispatch table (`assemble`, `locate`, `extract`, `squash`) that no test executed -
  only the Node CLI reached them, and `moon test` does not run it - plus the base64 guard
  against a code unit above 255, and the JSON-to-`Value` conversion for `null` and numbers.
- Tests added for all of them, written from the coverage report rather than the code:
  102 declarations, 888 -> 931 executed lines.
- `scripts/coverage.mjs` gates on the recorded baseline: uncovered lines may not grow per
  file, which catches a deleted test and new code without one. It does not target a
  percentage, since that would reward deleting code.
- `cmd/bench` turned out to be a different case: nothing ran it at all. The numbers in the
  docs come from `scripts/bench.mjs`, which measures the adapter. `scripts/bench-smoke.mjs`
  now runs the binary and checks that each line is a label, a positive duration and a finite
  throughput - not that the timings are any particular value, which is `perf-check.mjs`'s job
  and varies by host. Breaking the output format makes it fail.
- Excluded and printed rather than hidden: `cmd/main` and `cmd/bench` are binaries that
  `moon test` never runs, so their lines stay at 0/38 and 0/34 by construction. Verified that
  this is a tooling limit and not a gap in the tests: `moon coverage analyze` reports the same
  72 lines as `test` plus `report`, `moon build --enable-coverage` emits no trace, and the two
  functions worth testing inside the CLI package are `extern "js"` shims that would read the
  test runner's argv. `cli-contract.mjs` runs the CLI six times from outside, which is where
  that behaviour belongs.
- Two base64 refusals are unreachable by construction and stay as defensive code with the
  count pinned.

### Every documented command is now executed

- `scripts/doc-commands.mjs` parses the shell blocks in `README.md`, `docs/*.md` and
  `examples/README.md`, classifies every command, and runs the ones nothing else runs:
  7 executed with placeholders substituted, 41 covered by the verify ladder, 2 argument
  shapes, 35 lines that are results rather than commands. An unclassified command fails
  the check, so a new line in a README cannot go unrehearsed.
- The seven include `restore current.json DEST --path docs`, the form that was broken last
  round. Reinstating the bug makes this script fail and nothing else does.
- Corrected two stale lines in `docs/audit-contract-20261024.md` that presented
  `{"error":"ENOENT: ..."}` and `usage line, exit 2` as observed behaviour; both had been
  made false by the error-contract change, and the record is now marked as revised.

### Two documented flags were unreachable

- Fixed: `restore ... --path docs` and `squash ... --format 2` - both the forms the README
  shows - failed with `Snapshot file does not exist: --path`. The parser took the fourth
  argument as the parent snapshot and only looked for options after it, so the flags bound
  to a filename. Selective restore and choosing the output format were therefore not
  reachable from the adapter at all, though the library functions behind them were correct
  and covered.
- Options are now extracted from the whole argument list before anything is read
  positionally, so they may appear anywhere. A missing value, an out-of-range `--format`
  and an unknown option are each named and exit 2.
- The CLI contract test now runs the documented forms and the three refusals; confirmed to
  fail when `--path` is treated as a positional again, and when `--format` stops being
  validated.

### One error contract, for both entry points

- `scripts/filesystem.mjs` printed failures as free text on stderr and exited 1 for a
  usage mistake, while the core CLI printed `{"error": ...}` on stdout and exited 2. A
  caller shelling out to both had to parse two shapes from two streams. Both now use the
  same envelope and the same exit codes.
- The core CLI's usage path printed free text too, so a caller that parsed stdout as JSON
  had exactly one path where it was not JSON - the one that reports a usage error.
- Host-side failures in the core CLI no longer pass Node's message through: a missing file
  is `the file does not exist`, not `ENOENT: no such file or directory, open '/x/y.json'`,
  which named an errno and repeated the path the caller had just typed.
- `scripts/cli-contract.mjs` asserts the whole contract over both entry points - success,
  failure, usage, and that no message contains a `CODE: ` prefix. Verified to fail when
  the adapter goes back to stderr, and when a usage mistake returns 1.

### A refusal has to say what it refused

- Fixed: five source-side refusals either named no file (`Special files are unsupported`,
  `Symbolic links are unsupported`) or leaked a raw Node error (`EACCES: permission
  denied, open '/private/.../locked.txt'`). In a tree of ten thousand files neither tells
  the caller what to fix.
- They now name the relative path - the same string that appears in the snapshot - and a
  single `reason()` turns errno codes into words so the same problem reads the same way
  wherever it is met. The size-limit message also reports how far it had got.
- The integration suite asserts, for a symlink, a fifo, and an unreadable file, that the
  message names the entry and is not a raw errno. Both assertions were verified to fail
  when the old wording is restored.
- The Windows job caught the first version of those tests: `chmod 0o000` does not make a
  file unreadable on NTFS, so the scenario cannot be built there. It is skipped with the
  reason recorded, in the same spirit as `modes_exact`.

### Durability was never asked for

- Measured: neither backup nor restore called `fsync`. `writeFileSync` returns once the
  bytes are in the page cache, so a power cut could leave a snapshot whose name exists and
  whose length is zero, and a restore that had already said `verified: true`. Silent, and
  the exact failure the project exists to prevent.
- Publication is now one shared function - both backup and squash carried their own copy
  of the same sequence - that syncs the temporary file, links it, then syncs the
  directory. Restore syncs each file it writes and each directory it touched before
  returning, and reports `durable` and `synced_directories`.
- `scripts/durability.mjs` asserts the calls happen by patching `fs` in a child process.
  Confirmed to fail when either sync is removed, and when the opt-out stops being reported.
- Cost, measured: 1 MiB restore 74 → 80 ms; 200 files of 1 KiB 79 → 852 ms. Durability is
  the default anyway; `SNAPVAULT_NO_FSYNC=1` is for scratch copies and reports
  `durable: false` rather than weakening the guarantee silently.

### The documents are checked

- `scripts/docs.py`: internal links must resolve, `#anchors` must name a heading that
  exists, and the counts stated in `README.md` and `PROJECT_STATS.md` must match the
  source and each other. Every shipped script must be mentioned somewhere.
- Found a real drift on its first run: `README.md` claimed 87 test declarations while the
  source had 93. That number had been maintained by hand through several releases and had
  fallen three behind, because only `PROJECT_STATS.md` was machine-checked.
- Verified with five injected failures: a broken link, a broken anchor, a renamed heading,
  an undocumented script, and a stale count. Each was reported with the file named.
- Timings and peak-memory figures are deliberately not treated as claims, since they vary
  by machine and a checker that fails on a slower host gets switched off.

### The disk-full probe runs on macOS, and in CI

- The probe needed root for a Linux tmpfs, so it was documented as a deliberate manual
  check and its macOS side never ran. That was wrong twice over: macOS can create and
  mount a 2 MiB APFS image with `hdiutil` and no privileges at all, and I had not tried.
- The probe now picks a method per platform - tmpfs on Linux, `hdiutil` on macOS, an
  explicit skip on Windows - and runs in the macOS CI job on every push. The Linux path
  stays manual because it really does need root.
- The claim holds on both: the partial directory is retained, the error names the file it
  stopped at, and that file is the truncated one. The named file differs (`f0.bin` on
  APFS, `f2.bin` on tmpfs) only because the volumes fill at different points.

### The CI workflow is validated, not trusted

- `scripts/workflow.py` parses `ci.yml` and checks the properties that decide whether a
  green run is evidence: no step may be allowed to fail, mask its exit status or
  background its command; actions must be pinned; the matrix must still cover four
  backends; and every script in `verify.sh` must appear in the integration job.
- Confirmed by injecting five breakages - `continue-on-error`, `|| true`, an unpinned
  action, a missing backend, a step removed from CI alone - each of which was reported
  with the offending step named.
- Also checked, since it was an open question: `moon update` in CI fetches nothing for
  this module, which has no registry dependencies. CI therefore builds the checked-out
  tree, not a cached copy.

### Byte-identical output across backends, finally checked

- The claim that the four backends serialize identically was justified by one manual
  comparison and a single `stringify` assertion. The CLI is JS only, so the fixtures
  could not check it either: `moon test --target native` ran the tests but none of them
  asserted bytes.
- `serialization_wbtest.mbt` pins number spelling (`420`, `1e+21`, `-0.0` as `0`),
  escaping, the difference between `stringify` and `canonical`, the `canonical` key
  order, and the checksums of the same tree in format 2 and format 3. All four targets
  now check them on every build, against constants computed with Python's `hashlib`
  rather than copied from the implementation.
- Verified load-bearing: replacing the length-first key order with a plain sort fails the
  test on every backend.
- Also pinned as a side effect: `create_snapshot` defaults to format 2, and the two
  formats produce different checksums for identical file lists because the checksum
  covers `version`.

### A systematic mutation sweep over `audit`

- `scripts/mutation_sweep.py`: mutates every field of a valid snapshot in turn - missing,
  eleven wrong types, or a changed value - and predicts the verdict instead of recording
  it. 197 mutants: 161 refused, 32 reported invalid with the expected reason, 4
  legitimately valid.
- The safety property it enforces: content changed without a recomputed checksum may
  never come back `valid: true`. Verified the sweep is load-bearing by removing the digest
  check (5 mutants slip through) and the size check (1 slips through).
- It also pins three deliberate edges of the format that were previously only implied:
  `parent` absent and `parent: null` are the same snapshot in format 3, a renamed path
  with a recomputed checksum is a valid snapshot, and a mode change with a recomputed
  checksum is reported valid - the documented boundary between integrity and
  authentication.

### Failure messages, and the partial directory claim

- The claim that a failed restore retains its partial directory had never been tested.
  Verified against a 2 MiB tmpfs and a 5.33 MiB snapshot: three of four entries survive,
  the one being written is present and truncated. `scripts/fault-probe.mjs` reproduces
  it; it needs root, so it is run deliberately and is not in `verify.sh`.
- A mid-restore failure now names the file it stopped at, because files are written in
  manifest order and the retained directory is only interpretable if the reader knows
  where the boundary is.
- Host-side failures no longer leak raw Node codes for the cases a user actually hits:
  a missing snapshot says `Snapshot file does not exist: ...`, malformed JSON says it is
  not valid JSON, and a destination that cannot be created is explained the same way an
  existing one is. All three are covered by the integration suite on every platform.

### Concurrent publication

- The claim that a destination is created exclusively was asserted in a code comment
  and tested nowhere. The integration suite now races six processes at one snapshot
  path and six at one restore destination, and checks that exactly one wins, the rest
  are refused, no temporary file survives and the restored tree is byte-identical to
  its source. Replacing the hard link with a copy makes the suite fail.
- Losing that race used to surface as a raw `EEXIST` from Node. The two cases now say
  what happened: `A snapshot already exists at ...; snapshots are never replaced` and
  `The destination already exists: ...; restore requires a new directory`.

### Shipped examples were never run

- `examples/` had four files and nothing executed any of them, including the one the
  README tells a reader to run first. They are now covered by `scripts/examples.mjs`,
  which runs each through the real CLI and compares against a pinned answer in
  `examples/expected/`; `--write` regenerates. Part of `verify.sh` and CI.
- Nine examples were added so that every operation has one: incremental format 3 with
  an inline parent, audit, restore, diff, squash, retention showing a parent being
  promoted to `required_snapshots`, locate, extract, and one refused request. Three
  operations were documented by example before; eleven now are.
- Verified the check catches drift: renaming a statistics key broke two examples and
  changing a message broke the error example, both of which were invisible before.

### Fixtures now pin what they claim to

- `scripts/check.mjs` grew two forms it should have had from the start. `"error": "text"`
  requires the message to contain that text, and `"exact": true` pins the whole answer
  including field order. All 25 error fixtures now pin their message, and 10 fixtures -
  at least one per operation - pin a complete answer.
- Fixed: `create refuses a corrupt previous snapshot` never tested corruption. Its
  request also violated the format-3 requirement, so it failed earlier for an unrelated
  reason and would have kept passing if the corruption check were deleted. Caught by
  pinning the message rather than merely asserting that something failed.
- These three regressions were all invisible before and now fail the suite: changed
  error text, a dropped output field, two output fields reordered.
- `scripts/engine.mjs` refuses to run against a build older than the source. Editing,
  running `moon build --target js`, and then checking silently used the stale release
  artifact and reported three deliberate regressions as passing; the guard names the
  build mode and the age, and `SNAPVAULT_ALLOW_STALE=1` overrides it.

### The library was never used from outside

- `scripts/consumer-smoke.mjs`: a separate module that installs this source and calls
  every exported function - typed `create_snapshot`, `audit_snapshot`, `run`,
  `execute(Json)`, `safe_path`, `digest`, `parse_value`, and a matched `InputError`.
  No in-module test can do this, because `pub` is module-scoped and a sub-package
  would see more than a consumer does. It fails when an export is renamed, which the
  in-module suite does not notice.
- README now says a caller's `main` must be `fn main raise`, because every exported
  function raises; writing `fn main` is a compile error, which the smoke test found
  the hard way.

### Windows path forms, tested rather than reasoned about

- Integration tests now assert containment for every hostile selection shape the core
  accepts, including Windows drive-letter and drive-relative paths (`c:escape`,
  `a:../escape`), which resolve against another drive's current directory. They were
  refused already; the point is that a test says so.
- A colon inside a file name is an alternate data stream on NTFS: written, but absent
  from a directory listing, so the restored tree would silently differ from the
  manifest. Windows refuses such a name; the platforms where `:` is ordinary restore
  it as an ordinary file. Both branches are now covered.

### `diff` had no regression coverage

- `diff` was the one operation with no fixture and no entry in the usage table, so
  nothing but the fuzz oracle compared its output against an expectation. It now has
  three fixtures - added/removed/modified, a self-comparison, and a refusal on a
  broken checksum - and a documented request shape.

### Published interface was stale

- Fixed: `pkg.generated.mbti` still described `create_snapshot` without
  `known_objects`, three commits after that parameter was added. Anyone reading the
  published interface saw a function that no longer matched the code, and a released
  version cannot be corrected in place. `scripts/interface.mjs` now compares the
  committed file against `moon info` and fails on drift; it is part of `verify.sh`
  and CI. It normalises the `Int`/`Int32` spelling, which differs between supported
  toolchains without meaning anything.

### Windows, verified rather than assumed

- CI gained a Windows job, and it immediately found something the Linux and macOS
  jobs could not: `restore` claimed to preserve permission bits, but NTFS has none.
  `chmod` there toggles the read-only flag only, so a recorded `0755` comes back as
  `0666`. `restore` now also reports `modes_exact`, which is `false` on Windows, so a
  caller is not told the recorded mode is back when it is not.
- The MoonBit toolchain, all four core targets, the fixture CLI, the statistics check
  and the rest of the integration suite run on `windows-latest` unchanged.

### Backing up trees with platform-specific names

- Fixed: a directory containing a file named `con`, `a\b.txt` or `we:ird.txt` could
  not be backed up at all on Linux, where all three are ordinary names. The core's
  path rule rejected a union of every platform's restrictions, and the adapter's
  `safeFile` rejected two of them again.
- The core now accepts any path that is safe and possible somewhere: relative,
  no empty/`.`/`..` components, no control characters, every component within the
  255 bytes ext4, APFS and NTFS all allow. It gained that length limit, which it
  was missing: a 304-character component was reported `valid` by `audit` and then
  failed during restore with `ENAMETOOLONG`, leaving a partial directory.
- `portablePaths` refuses what the destination platform actually cannot hold:
  device names and `<>|?*` on Windows only, over-long paths everywhere, and case or
  normalisation collisions. The same snapshot now restores fully on Linux and is
  refused before anything is written when the destination is Windows.
- `backup` gained a per-problem warning for names that will not restore on every
  platform, instead of one opaque message.

### Backing up trees a case-insensitive volume cannot hold

- Fixed: a directory containing two names that differ only by case, such as
  `Report.txt` and `report.txt`, could not be backed up at all. The core folded case
  when validating a manifest and rejected the pair, while the adapter's own contract
  says such a backup proceeds with a portability warning and the restore is what
  refuses. On Linux this made ordinary directories impossible to snapshot.
- The core now rejects only structural contradictions - unwritable paths, exact
  duplicate paths, a path used as both a file and a directory - and leaves case and
  normalisation to the writer, which is the only layer that knows the destination
  filesystem. `audit` reports such a snapshot as valid, because it is.
- `portablePaths` became the sole enforcement point and grew the case it could not
  previously see: a file `A` alongside `a/b.txt` is fine on Linux and impossible on
  a case-insensitive volume, and that is now refused before the destination exists.
- CI gained a macOS job. Its default volume is both case-insensitive and
  normalising, so it is the only place the portability rules are exercised against a
  real filesystem rather than a constructed collision; the job first asserts those
  properties of the runner before relying on them.
- Integration tests gained a real Unicode round trip (composed, decomposed, CJK,
  emoji, RTL, zero-width joiner) and the case-collision restore refusal.

### Input robustness and selection cost

- `scripts/robustness.py`: structural fuzzing of the input boundary. 305 malformed
  snapshots and requests - wrong types, missing fields, absurd numbers, deep
  nesting, control characters, duplicate keys, hostile paths, unknown operations -
  must each produce exactly one JSON object and exit 0, 1 or 2. Wired into
  `verify.sh` and CI. No violations were found; the value is that the property is
  now checked rather than assumed.
- Fixed: selection matching was O(paths x files). 8000 paths against 8000 files took
  5.9 s and quadrupled when either side doubled, so a request well inside the 16 MiB
  cap could hang for minutes. Files are now matched through their component
  prefixes, which takes the same case to 0.69 s and grows with the tree. A test
  compares the new rule against the old definition on 121 prefix pairs and 13 paths,
  so the change is provably a speedup and not a semantic change.

### Long chains

- Fixed: adding a third large link to a chain failed with `input exceeds 16 MiB`.
  The declared-objects path audited the entire chain in one request, which is the
  one thing that cannot fit; three links of 8 MiB were enough to hit it. Each link
  is now verified in its own request, batched by the payload sizes its manifest
  already states. The integration test builds that exact chain and fails on the
  previous code.
- The adapter decides between the one-request and declared-objects paths from file
  sizes, so a chain that plainly will not fit is never read into memory first, and
  the fallback holds one link at a time.
- Measured and documented: peak memory is a small multiple of the tree because every
  exchange is one JSON document with base64 payloads. Streaming inside the adapter
  lowered the heap floor from 64-80 MiB to 56-64 MiB while being 16% slower and
  giving up the verify-before-write guarantee, so it was not shipped.

### Reading a chain that is larger than one request

- `locate` answers which link stores each payload using manifests only, so a
  request that carries a whole chain as manifests stays small.
- `extract` returns the payloads of one link, re-hashing each against its digest
  and re-encoding to the caller's `format`.
- `assemble` computes the canonical checksum of a manifest without payloads, and
  keeps only the four manifest fields so extra ones cannot change the checksum.
- Adapter: `restore` and `squash` fall back to those operations when the chain
  would not fit. Both verify the whole chain before creating anything. A 19 MB
  chain of three links restored and squashed successfully where a single request
  refused; the piecewise squash checksum equals the one-request result.
- Fixed: the declared-objects delta path stripped only the parent's payloads, so a
  third link in the chain pushed the request over the cap. Every link now travels
  as a manifest with its digests declared.

### Deltas over a large base

- `create` accepts `known_objects`, a list of digests the chain already stores,
  and a `previous` with no `objects` member. Together they let a delta be built
  without sending the parent's payloads, which lifts the ceiling the 16 MiB
  request cap put on incremental backups. The result is byte-identical to the
  full-parent delta.
- `statistics.base_verified` says whether the core could check the base. It is
  `false` for the declared-objects path rather than a claim of verification.
- A false declaration fails closed: `audit` reports `missing object` and
  `restore` refuses, so nothing is silently lost.
- Adapter: when a delta request would exceed the cap, it audits the chain in one
  request and sends the manifest-only parent in a second. A 7 MiB tree with one
  changed file now produces a 1267-byte delta (9.8 MB base) and restores
  verified; previously that delta was rejected outright.

### Retention and restore correctness

- `retention` no longer proposes deleting a snapshot that a kept snapshot's chain
  requires. Such a link is promoted into the new `required_snapshots` field, and a
  link with no listed identity is reported under `external_parents`. Previously a
  plan could say "keep the delta, drop its base", which left the kept snapshot
  unreadable while every object it needed was still present.
- `restore` passes a base64 payload straight through when the reader wants base64,
  instead of decoding it to verify and re-encoding it to return. Restore of an
  8 MiB snapshot: 1660 -> 1261 ms; 4 MiB 912 -> 696 ms.
- `scope` in the retention plan now describes what the plan actually covers.

This is a behaviour change for callers that read `drop_snapshots` alone: the field
is now narrower, and the identities removed from it appear in
`required_snapshots`.

### Verification

- `scripts/fuzz.py`: seeded differential test against an independent oracle
  covering `create`, `audit`, `restore`, `diff`, `squash`, `retention` and eight
  mutation classes, with reproducible seeds. Wired into `verify.sh` and CI.
- `restore` strips trailing separators from `paths`, so `--path docs/` selects
  `docs` instead of failing as unsafe; traversal and absolute paths are still
  refused.

### Chain management

- `squash` compacts a chain into one self-contained snapshot in any of the three
  formats, keeping every reachable object exactly once and dropping the rest.
  Without `format` the snapshot keeps its own. Squashing twice is a no-op, and
  squashing to format 2 equals creating the same tree directly, byte for byte.
- `restore` accepts `paths` and selects entries by whole component (`docs` covers
  `docs/a.md`, `doc` covers nothing), reporting `selected` and `total_files`. A
  path that matches nothing is an error, not a quiet partial restore.
- Adapter: `squash` and `restore --path` subcommands.

### Snapshot format 2

- Object payloads are base64 text instead of arrays of decimal byte values. A
  1 MiB incompressible file now produces a 1.33 MiB snapshot instead of
  3.57 MiB, and the same 1 MiB backup drops from 2396 ms to 649 ms on the
  reference host because the request no longer carries a million-element JSON
  array in either direction.
- `create` writes format 2 by default; `"format": 1` still produces the
  previous layout byte for byte. Format 1 snapshots remain readable by
  `audit`, `restore`, `diff` and `retention`, and a snapshot's version decides
  which payload encoding is accepted, so a decimal payload inside a format-2
  snapshot is reported as `invalid object encoding`.
- Requests accept `content_base64` alongside `text` and `bytes`; exactly one
  content form must be present.
- `restore` returns `format` and `encoding` (`base64` or `decimal`) and keeps
  the payload in the encoding it validated, so the adapter decodes with the
  matching call instead of re-expanding decimal arrays.
- `audit` reports `format`.
- `retention` counts decoded bytes, so byte totals stay correct for base64
  payloads, and snapshots of different formats can be planned together when the
  digests match.
- The host adapter sends base64 and raises its per-backup source cap from 1 MiB
  to 8 MiB (10.7 MiB of JSON for incompressible data, still inside the 16 MiB
  request cap). `SNAPVAULT_ADAPTER_LIMIT_BYTES` overrides the limit.

### Performance

- SHA-256 is implemented in `sha256.mbt` over whole 64-byte blocks with a reusable schedule: 61
  MiB/s instead of 21 MiB/s for the byte-at-a-time package that was used before, identical output.
- base64 is implemented in `base64.mbt`: encoding fills a byte array and decodes once, which takes
  8 MiB in 8 MiB numbers from 1445 ms to about 300 ms; decoding is ours as well.
- `scripts/engine.mjs` prefers a release build and falls back to debug; `MOON_BUILD` selects one.
- Through the adapter on the reference host, a 1 MiB incompressible backup went from 2396 ms to
  292 ms and restore from 2081 ms to 300 ms; 8 MiB backs up in 1387 ms and restores in 1523 ms.
  `scripts/bench.mjs` and `cmd/bench` reproduce the numbers.
- The module no longer depends on `gmlewis/sha256`; `moonbitlang/core` is the only dependency.

### Audit contract (also unreleased)

- `audit` verifies every stored object, referenced or not, and reports `objects_total`, `objects_checked`, `referenced_objects` and `unreferenced_objects`; `issues` entries now always carry `object` and use `path: null` when no file references the object.
- `audit`, `retention` and `restore` agree on the same snapshot: a corrupt unreferenced object is refused by all three, and `create(previous=…)` no longer under-counts `new_object_bytes` when the previous snapshot claims content it cannot prove.
- CLI: host-side failures (missing file, invalid UTF-8, oversize input) return the same `{"error": ...}` envelope as request errors with exit code 1; error text no longer exposes MoonBit type names.
- `restore` applies manifest permission bits with `chmod` and returns `modes_applied`; adapter refuses paths that collide after Unicode normalization/case folding before creating the destination, and warns when a backup is not portable.
- Path sorting in manifests and reports is lexicographic; previously MoonBit's shortlex `String::compare` ordered `c` before `b/x`.
- Public API: added `parse_value(StringView) -> Value raise`; `InputError` keeps `Show` (plain message) and moves to `derive(Eq, Debug)`; `moonbitlang/core/math` is no longer imported. Builds with zero warnings on moon 0.1.20261023.
- Added `scripts/verify.sh`, four audit-contract fixtures, six white-box tests, and CLI/audit oracles in `scripts/reference.py`.

## 0.2.0 — 2026-10-18

Registry version: 0.2.0.

新增 retention，对给定自包含快照及保留 ID 集合验证清单、引用对象和未引用对象，再计算共享对象可达性、可回收对象及字节数。默认保留所有给定快照；未知或重复保留 ID、损坏内容均拒绝。修复清单文件模式校验，避免重算校验和后夹带非法权限字段。
