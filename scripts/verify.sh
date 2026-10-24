#!/usr/bin/env sh
# Runs the full local verification ladder in one command.
#
#   sh scripts/verify.sh              # four backends, then the host checks
#   SKIP_NATIVE=1 sh scripts/verify.sh
#
# Native builds need a C compiler. On hosts where `cc` is shadowed by a wrapper
# script, point MOON_CC at a real compiler, for example MOON_CC=/usr/bin/gcc.
set -eu
cd "$(dirname "$0")/.."

export MOON_HOME="${MOON_HOME:-$HOME/.moon}"
PATH="$MOON_HOME/bin:$PATH"
export PATH

echo "moon: $(moon version | head -1)"

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

moon build --target js >/dev/null
node scripts/stats.mjs
node scripts/check.mjs
python3 -B scripts/reference.py
python3 -B scripts/followup_reference.py
python3 -B scripts/delta_reference.py
node scripts/integration.mjs
moon fmt --check >/dev/null
echo "verify: ok"
