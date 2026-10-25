#!/usr/bin/env sh
# Runs the full local verification ladder in one command.
#
#   sh scripts/verify.sh                    # four backends, then the host checks
#   SKIP_NATIVE=1 sh scripts/verify.sh
#   FUZZ_ITERATIONS=40 sh scripts/verify.sh # deeper randomized coverage
#
# Native builds need a C compiler. On hosts where `cc` is shadowed by a wrapper
# script, point MOON_CC at a real compiler, for example MOON_CC=/usr/bin/gcc.
set -eu
cd "$(dirname "$0")/.."

export MOON_HOME="${MOON_HOME:-$HOME/.moon}"
PATH="$MOON_HOME/bin:$PATH"
export PATH

echo "moon: $(moon version | head -1)"

# Formatting is checked first: it is the cheapest failure and it does not depend on
# which target was built last, so it should not wait behind four test runs.
moon fmt --check >/dev/null

for target in js wasm wasm-gc; do
  printf '%s: ' "$target"
  moon test --target "$target" | grep '^Total tests'
done

if [ "${SKIP_NATIVE:-0}" = "1" ]; then
  echo 'native: skipped (SKIP_NATIVE=1)'
else
  printf 'native: '
  moon test --target native | grep '^Total tests'
fi

# scripts/engine.mjs prefers a release artifact and falls back to debug, so both
# are built: the host checks then measure the same code the benchmarks quote.
moon build --target js >/dev/null
moon build --target js --release >/dev/null
node scripts/coverage.mjs
# Timings quoted in the docs: a factor-of-two drift fails, percentage noise does not.
node scripts/perf-check.mjs
# The benchmark binary prints the codec numbers the docs quote; nothing ran it before.
node scripts/bench-smoke.mjs
node scripts/stats.mjs
node scripts/interface.mjs
# A separate module compiled against the exported interface, which is the only way
# to see exactly what pkg.generated.mbti promises: `pub` is module-scoped, so a
# sub-package would see more than a real consumer.
node scripts/consumer-smoke.mjs
# The examples ship with the package and are the first thing README tells a reader
# to run, so their answers are pinned rather than assumed.
node scripts/cli-contract.mjs
# Snapshots written by the published 0.2.0, read by the current code.
node scripts/compat.mjs
# The release note tells users what changed; its factual claims are checked, not trusted.
node scripts/release-claims.mjs
# The defect matrix is a deliberate probe (minutes); its anchors are checked here so the
# entries cannot rot into reporting a gap that no longer exists.
node scripts/defect-matrix.mjs --check-anchors
# `moon build` does not compile white-box test files, so it reports zero warnings for a tree
# whose tests warn. `moon check` sees everything; this is the only step that uses it.
node scripts/warnings.mjs
node scripts/examples.mjs
# Backup and restore must sync before claiming success, and the opt-out must say so.
node scripts/durability.mjs
node scripts/check.mjs
python3 -B scripts/reference.py
python3 -B scripts/followup_reference.py
python3 -B scripts/delta_reference.py
# Structural robustness: malformed snapshots and requests must still produce one
# JSON object and a clean exit, never a crash or a hang.
python3 -B scripts/robustness.py
# Every field of a snapshot, mutated every way, with the verdict predicted rather than
# recorded: this is the claim `audit` exists to make.
python3 -B scripts/mutation_sweep.py
# The workflow file is checked too: CI is the only cross-platform evidence there is, so
# a step that silently stopped running would make the coverage claims fiction.
python3 -B scripts/workflow.py
# Links, anchors and the counts stated in the documents.
python3 -B scripts/docs.py
# Every command the documents tell a reader to run, executed.
node scripts/doc-commands.mjs
# Randomized differential test. FUZZ_ITERATIONS trades time for coverage; the
# default is small enough for CI and still exercises every seeded path.
python3 -B scripts/fuzz.py "${FUZZ_ITERATIONS:-6}"
node scripts/integration.mjs
echo "verify: ok"
