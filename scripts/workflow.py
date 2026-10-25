"""Checks the CI workflow against the invariants that decide whether a green run means
anything.

    python3 -B scripts/workflow.py

CI is the only cross-platform evidence this project has: the macOS and Windows jobs
cannot be reproduced locally, and the coverage claims in the docs rest on them. A
workflow that silently stops running a step, or that is allowed to fail, would turn
those claims into fiction while every run stayed green - which is exactly the class of
problem this suite exists to catch elsewhere.

So the file itself is checked:

  - it parses as YAML, and every job has a runner and at least one step;
  - no step may be allowed to fail (`continue-on-error`), and no command may mask its
    exit status with `|| true`, since either makes a job green for the wrong reason;
  - every action is pinned to a ref, because an unpinned action is a supply-chain
    dependency that changes without a commit here;
  - the matrix actually covers the four backends, and every reference to it resolves;
  - the steps named in `scripts/verify.sh` all appear in the job that runs the host
    checks, so the local and CI ladders cannot drift apart;
  - `verify.sh` and CI agree on which scripts exist.

It deliberately does not run the workflow. That needs GitHub, so the file is checked and
the run is read afterwards; the two together are what justify saying CI covers something.
"""
import re
import sys
from pathlib import Path

try:
    import yaml
except ImportError:
    # PyYAML is not part of the standard library and CI images differ. Skipping loudly
    # is better than failing a build on a missing optional dependency, but the skip has
    # to be visible: a silent one would look like a passing check.
    print('Workflow: skipped - PyYAML is not installed (pip install pyyaml)')
    print('  ci.yml was not validated on this machine')
    sys.exit(0)

root = Path(__file__).resolve().parents[1]
workflow_path = root / '.github/workflows/ci.yml'
# Absent is only a defect inside a checkout. `moon package` does not ship dotfile directories,
# so an installed package has no `.github` at all, and `sh scripts/verify.sh` - which the README
# offers as "one command runs everything" - failed on the very artifact it ships. The two cases
# are distinguishable: a checkout that lost its workflow still has a `.github` directory, or a
# `.git` one. Treating both as "missing" would either break the package or let a deleted
# workflow pass, and the second is the failure this file exists to prevent.
if not workflow_path.exists():
    looks_like_a_checkout = (root / '.github').exists() or (root / '.git').exists()
    if looks_like_a_checkout:
        sys.exit('workflow: .github/workflows/ci.yml is missing')
    print('Workflow: not a checkout (no .github and no .git), so there is no CI configuration '
          'to check here')
    sys.exit(0)

text = workflow_path.read_text()
problems = []

try:
    workflow = yaml.safe_load(text)
except yaml.YAMLError as exc:
    sys.exit(f'workflow: ci.yml does not parse: {exc}')

if not isinstance(workflow, dict):
    sys.exit('workflow: ci.yml is not a mapping')

# --- triggers ---------------------------------------------------------------
triggers = workflow.get('on', workflow.get(True))
if not triggers:
    problems.append('no `on:` trigger, so the workflow never runs')
elif isinstance(triggers, dict):
    if 'push' not in triggers and 'pull_request' not in triggers:
        problems.append('neither `push` nor `pull_request` is a trigger')
else:
    problems.append(f'`on:` is {triggers!r}, expected push/pull_request')

# --- jobs -------------------------------------------------------------------
jobs = workflow.get('jobs')
if not isinstance(jobs, dict) or not jobs:
    sys.exit('workflow: no jobs')

for name, job in jobs.items():
    if not isinstance(job, dict):
        problems.append(f'{name}: job is not a mapping')
        continue
    if 'runs-on' not in job:
        problems.append(f'{name}: no runs-on, so there is nowhere to run')
    steps = job.get('steps')
    if not isinstance(steps, list) or not steps:
        problems.append(f'{name}: no steps')
        continue
    for index, step in enumerate(steps):
        label = f'{name}[{index}] {step.get("name") or step.get("uses") or step.get("run", "")[:40]}'
        if not isinstance(step, dict):
            problems.append(f'{name}[{index}]: step is not a mapping')
            continue
        if 'uses' not in step and 'run' not in step:
            problems.append(f'{label}: neither uses nor run')
        if step.get('continue-on-error') is True:
            problems.append(f'{label}: allowed to fail, so the job proves nothing')
        if 'uses' in step and '@' not in str(step['uses']):
            problems.append(f'{label}: action {step["uses"]!r} is not pinned to a ref')
        if 'run' in step:
            body = str(step['run'])
            if re.search(r'\|\|\s*true', body):
                problems.append(f'{label}: masks an exit status with `|| true`')
            if body.strip().endswith('&'):
                problems.append(f'{label}: backgrounds its command, so the step cannot fail')
    # A matrix that is referenced but never defined. The reference is `${{ matrix.NAME }}`; a
    # bare `matrix.` also matches a file called `defect-matrix.mjs`, which is how this check
    # first produced a false positive against a step that has nothing to do with matrices.
    rendered = yaml.safe_dump(job)
    uses_matrix = re.search(r'\$\{\{\s*matrix\.', rendered) is not None
    defines_matrix = 'matrix' in job.get('strategy', {})
    if uses_matrix and not defines_matrix:
        problems.append(f'{name}: references matrix.* without defining a matrix')

# --- the four backends ------------------------------------------------------
core = jobs.get('core')
if isinstance(core, dict):
    targets = core.get('strategy', {}).get('matrix', {}).get('target')
    if not targets:
        problems.append('core: no target matrix, so the backends are not covered')
    else:
        wanted = {'js', 'wasm', 'wasm-gc', 'native'}
        missing = wanted - set(targets)
        if missing:
            problems.append(f'core: matrix does not cover {sorted(missing)}')
else:
    problems.append('no `core` job for the library backends')

# --- local and CI ladders must agree ---------------------------------------
def scripts_in(text):
    return set(re.findall(r'scripts/([A-Za-z0-9_]+\.(?:mjs|py))', text))

verify_path = root / 'scripts/verify.sh'
verify_scripts = scripts_in(verify_path.read_text()) if verify_path.exists() else set()
# `engine.mjs` is imported by the others, not a step of its own.
implied = {'engine.mjs'}
verify_steps = verify_scripts - implied

host_job = jobs.get('integration')
if not isinstance(host_job, dict):
    problems.append('no `integration` job for the host-side checks')
else:
    ci_steps = scripts_in(yaml.safe_dump(host_job))
    for script in sorted(verify_steps - ci_steps):
        problems.append(f'{script} runs in verify.sh but not in the integration job')
    for script in sorted(ci_steps - verify_steps - implied):
        problems.append(f'{script} runs in CI but not in verify.sh')

# --- the reference ladder ---------------------------------------------------
for job_name in ['integration', 'macos', 'windows']:
    job = jobs.get(job_name)
    if job is None:
        problems.append(f'no `{job_name}` job')
        continue
    rendered = yaml.safe_dump(job)
    for required in ['scripts/check.mjs', 'scripts/integration.mjs']:
        if required not in rendered:
            problems.append(f'{job_name}: does not run {required}')

if problems:
    print(f'Workflow: {len(problems)} problem(s) in ci.yml')
    for problem in problems:
        print('  ' + problem)
    sys.exit(1)

print(f'Workflow: ci.yml parses, {len(jobs)} jobs, '
      f'{len(verify_steps)} host checks agree with verify.sh, no step can pass silently')
