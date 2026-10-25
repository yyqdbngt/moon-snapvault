// Fails if the source produces any compiler warning.
//
//   node scripts/warnings.mjs
//
// Why a script and not a grep of the build log. `moon build` does not compile white-box test
// files, so it reports zero warnings for a tree whose tests warn - and "zero warnings" had been
// claimed on exactly that basis. A warning did sit in `coverage_wbtest.mbt` for several
// revisions: a lambda declared `-> String raise` whose body catches every error, so the `raise`
// was dead. `moon build` never saw it; `moon check` did, and nobody ran `moon check`.
//
// `moon check` compiles everything without emitting object files, which is what this needs. It
// runs per target because a warning can be backend-specific: an integer overflow check that
// only fires where `Int` is 32 bits, for instance.
//
// The count is checked, not the text, for a reason: warning text is a compiler detail that
// changes between releases, and a check that pins it breaks on upgrade rather than on defect.
// The text is printed when there is something to print.
import {spawnSync} from 'node:child_process';

const TARGETS = ['js', 'wasm', 'wasm-gc', 'native'];

let total = 0;
const failures = [];

for (const target of TARGETS) {
  const result = spawnSync('moon', ['check', '--target', target],
    {encoding: 'utf8', timeout: 600000});
  const output = (result.stdout || '') + (result.stderr || '');
  if (result.error) {
    failures.push(`${target}: could not run moon check: ${result.error.message}`);
    continue;
  }
  // A compile error is not a warning, and must not be counted as one: the message would then
  // say "1 warning" for a tree that does not build.
  if (result.status !== 0) {
    failures.push(`${target}: moon check failed\n${output.trim()}`);
    continue;
  }
  const warnings = output.split('\n').filter((line) => /^Warning:/.test(line));
  if (warnings.length > 0) {
    total += warnings.length;
    failures.push(`${target}: ${warnings.length} warning(s)\n` + output.trim());
  }
}

if (failures.length) {
  for (const failure of failures) console.error(failure + '\n');
  console.error(`Warnings: ${total} across ${TARGETS.length} targets. A warning is a defect that `
    + 'has not happened yet; the tree is kept at zero, and this is the only command that can '
    + 'see warnings in the test files.');
  process.exit(1);
}
console.log(`Warnings: 0 across ${TARGETS.length} targets (moon check compiles the test files, `
  + 'moon build does not)');
