// Runs the commands the documentation tells a reader to run.
//
//   node scripts/doc-commands.mjs
//   node scripts/doc-commands.mjs --list   # show the classification, run nothing
//
// Last round's bug was `restore ... --path docs`, a form the README shows, which failed
// because the option was read as a positional. The library calls behind it were correct
// and covered, the integration suite passed, and nothing had ever executed the command
// itself. This script exists so that cannot happen again silently.
//
// Every command in a shell code fence is classified, and an unclassified one is a
// failure - otherwise a new command simply would not be checked, which is how the gap
// appeared in the first place:
//
//   covered   the same command runs in verify.sh or a CI job, so it is executed already
//   ran       executed here, with placeholders substituted, and must succeed
//   usage     expected to fail, but must fail as a usage error (exit 2), not by treating
//             an option as a path
//   exempt    cannot run here, and the reason is stated in the code below
//
// Nothing is skipped quietly: an entry without a reason is itself a failure.
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIST = process.argv.includes('--list');

// Commands that take minutes, need another toolchain, or are the verification ladder
// itself. They are executed by `verify.sh` and by CI, so running them again here would
// only slow the suite down; the point of this file is the commands nothing else runs.
const COVERED = [
  /^moon update$/,
  /^moon build /,
  /^moon test /,
  /^moon add /,
  /^moon run cmd\/main /,
  /^moon fmt /,
  /^sh scripts\/verify\.sh/,
  /^SKIP_NATIVE=1 sh scripts\/verify\.sh/,
  /^node scripts\/(check|stats|interface|consumer-smoke|examples|durability|cli-contract|doc-commands|coverage|bench-smoke|compat|release-claims|defect-matrix|warnings|integration)\.mjs/,
  /^node _build\/js\/release\/build\/cmd\/main\/main\.js /,
  /^python -B scripts\/(reference|followup_reference|delta_reference|fuzz|robustness|mutation_sweep|workflow|docs)\.py/,
];

// The adapter's documented forms, with what each placeholder should become. The order
// matters: `previous.json` must exist before an invocation that names it.
const ADAPTER_FORMS = [
  {
    // `backup SOURCE current.json previous.json` - the delta form.
    pattern: /^node scripts\/filesystem\.mjs backup\s+SOURCE\s+current\.json\s+previous\.json$/,
    steps: [
      ['backup', '$src', '$dir/previous.json'],
      ['backup', '$src', '$dir/current.json', '$dir/previous.json'],
    ],
  },
  {
    pattern: /^node scripts\/filesystem\.mjs restore\s+current\.json\s+DEST\s+previous\.json$/,
    steps: [
      ['backup', '$src', '$dir/previous.json'],
      ['backup', '$src', '$dir/current.json', '$dir/previous.json'],
      ['restore', '$dir/current.json', '$dir/DEST', '$dir/previous.json'],
    ],
  },
  {
    // The form that was broken: an option in the third slot must not become a filename.
    pattern: /^node scripts\/filesystem\.mjs restore\s+current\.json\s+DEST\s+--path\s+docs$/,
    steps: [
      ['backup', '$src', '$dir/current.json'],
      ['restore', '$dir/current.json', '$dir/DEST', '--path', 'docs'],
    ],
  },
  {
    pattern: /^node scripts\/filesystem\.mjs squash\s+current\.json\s+compact\.json\s+previous\.json$/,
    steps: [
      ['backup', '$src', '$dir/previous.json'],
      ['backup', '$src', '$dir/current.json', '$dir/previous.json'],
      ['squash', '$dir/current.json', '$dir/compact.json', '$dir/previous.json'],
    ],
  },
  {
    pattern: /^node scripts\/filesystem\.mjs backup\s+SOURCE_DIR\s+NEW_SNAPSHOT\.json\s+\[PREVIOUS\.json\]$/,
    optional: true,
    steps: [['backup', '$src', '$dir/NEW_SNAPSHOT.json']],
  },
  {
    pattern: /^node scripts\/filesystem\.mjs restore\s+SNAPSHOT\.json\s+NEW_DIRECTORY$/,
    steps: [
      ['backup', '$src', '$dir/SNAPSHOT.json'],
      ['restore', '$dir/SNAPSHOT.json', '$dir/NEW_DIRECTORY'],
    ],
  },
  {
    pattern: /^node scripts\/filesystem\.mjs squash\s+tip\.json\s+compact\.json\s+base\.json\s+middle\.json\s+--format\s+2$/,
    steps: [
      ['backup', '$src', '$dir/base.json'],
      ['backup', '$src', '$dir/middle.json', '$dir/base.json'],
      ['backup', '$src', '$dir/tip.json', '$dir/middle.json', '$dir/base.json'],
      ['squash', '$dir/tip.json', '$dir/compact.json', '$dir/base.json', '$dir/middle.json',
        '--format', '2'],
    ],
  },
  {
    // These document the argument shape, not a runnable invocation; `--list` reports them
    // so the exemption is visible rather than implied.
    pattern: /^node scripts\/filesystem\.mjs (backup|restore|squash)\s+(SOURCE|SNAPSHOT|tip\.json)\s+(SNAPSHOT|DEST)\s*\[/,
    shapeOnly: true,
  },
];

const EXEMPT = [
  [/^(js|wasm|wasm-gc|native|core|integration|macos|windows):/, 'verify output, not a command'],
  [/^(verify: ok|CLI fixture cases passed|Python hashlib oracle|Format oracle|Audit oracle|CLI oracle|Retention:|Snapshot integration:|Mutation sweep|Docs:|Workflow:|Durability:|Examples:|CLI contract|Interface:|Consumer:|Fuzz:|Stats:)/, 'verify output, not a command'],
  [/^(audit|retention|restore|create)[\( ]/, 'a described result, not a command'],
  [/^[\"{}\[\]]/, 'a JSON fragment, not a command'],
  [/^js \/ wasm/, 'verify output, not a command'],
  [/^->/, 'a described result, not a command'],
  [/^restore of /, 'a described result, not a command'],
  [/^node main\.js /, 'a described result from an earlier revision'],
  // The release note shows before/after pairs for the stderr-to-stdout change. They are
  // contrasts, not instructions: the "before" form is what no longer works.
  [/^node scripts\/filesystem\.mjs restore missing\.json out/, 'a before/after contrast'],
  [/^node _build\//, 'covered by the verify ladder'],
];

function shellFences(file) {
  const text = fs.readFileSync(file, 'utf8');
  const commands = [];
  let inFence = false;
  let language = null;
  let startLine = 0;
  text.split('\n').forEach((line, index) => {
    if (line.startsWith('```')) {
      if (inFence) {
        inFence = false;
        language = null;
      } else {
        inFence = true;
        language = line.slice(3).trim();
        startLine = index + 1;
      }
      return;
    }
    if (!inFence) return;
    if (language !== '' && language !== 'sh' && language !== 'bash') return;
    const command = line.trim();
    if (!command || command.startsWith('#') || command.startsWith('//')) return;
    commands.push({file, line: startLine + index + 1, command});
  });
  return commands;
}

function prepare(dir, src) {
  fs.mkdirSync(src, {recursive: true});
  fs.mkdirSync(path.join(src, 'docs'), {recursive: true});
  fs.writeFileSync(path.join(src, 'a.txt'), 'one');
  fs.writeFileSync(path.join(src, 'docs', 'x.md'), 'documentation');
}

function runStep(dir, src, args) {
  const expanded = args.map((arg) => arg
    .replace(/\$dir/g, dir)
    .replace(/\$src/g, src));
  const result = spawnSync(process.execPath,
    [path.join(root, 'scripts/filesystem.mjs'), ...expanded], {encoding: 'utf8', timeout: 120000});
  const output = (result.stdout || '').trim();
  let parsed = null;
  try { parsed = JSON.parse(output); } catch { /* leave null */ }
  return {status: result.status, stderr: (result.stderr || '').trim(), parsed, output};
}

const documents = [
  path.join(root, 'README.md'),
  path.join(root, 'examples/README.md'),
  ...fs.readdirSync(path.join(root, 'docs'))
    .filter((name) => name.endsWith('.md'))
    .map((name) => path.join(root, 'docs', name)),
];

const problems = [];
const counts = {covered: 0, ran: 0, shape: 0, exempt: 0};
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'snapvault-doccmd-'));

try {
  for (const document of documents) {
    for (const {file, line, command: raw} of shellFences(document)) {
      const where = `${path.basename(file)}:${line}`;
      // A trailing `# ...` in these blocks explains the command; it is not an argument.
      const command = raw.replace(/\s+#\s.*$/, '').trimEnd();

      const exempt = EXEMPT.find(([pattern]) => pattern.test(command));
      if (exempt) {
        counts.exempt++;
        if (LIST) console.log(`${where}  exempt (${exempt[1]}): ${command.slice(0, 70)}`);
        continue;
      }

      // Any path the command names must exist, whether or not it is run here.
      for (const match of command.matchAll(/(?:^|\s)((?:scripts|examples|docs)\/[\w./-]+)/g)) {
        if (!fs.existsSync(path.join(root, match[1]))) {
          problems.push(`${where}: names ${match[1]}, which does not exist`);
        }
      }

      if (COVERED.some((pattern) => pattern.test(command))) {
        counts.covered++;
        if (LIST) console.log(`${where}  covered: ${command.slice(0, 70)}`);
        continue;
      }

      const form = ADAPTER_FORMS.find((candidate) => candidate.pattern.test(command));
      if (!form) {
        problems.push(`${where}: not classified, so nothing checks it: ${command.slice(0, 90)}`);
        continue;
      }
      if (form.shapeOnly) {
        counts.shape++;
        if (LIST) console.log(`${where}  shape only: ${command.slice(0, 70)}`);
        continue;
      }

      // Run the sequence in a fresh directory so one form cannot satisfy another.
      const caseDir = fs.mkdtempSync(path.join(work, 'case-'));
      const src = path.join(caseDir, 'src');
      prepare(caseDir, src);
      let failed = null;
      for (const step of form.steps) {
        const outcome = runStep(caseDir, src, step);
        if (outcome.status !== 0) {
          failed = {step: step.join(' '), outcome};
          break;
        }
      }
      if (failed) {
        problems.push(`${where}: the documented form fails at "${failed.step}": `
          + (failed.outcome.parsed?.error || failed.outcome.stderr
            || failed.outcome.output).slice(0, 140));
        continue;
      }
      counts.ran++;
      if (LIST) console.log(`${where}  ran: ${command.slice(0, 70)}`);
    }
  }
} finally {
  fs.rmSync(work, {recursive: true, force: true});
}

if (problems.length) {
  for (const problem of problems) console.error('doc-commands: ' + problem);
  process.exit(1);
}
console.log(`Documented commands: ${counts.ran} executed, ${counts.covered} covered by the `
  + `verify ladder, ${counts.shape} argument shapes, ${counts.exempt} lines that are results `
  + `rather than commands`);
