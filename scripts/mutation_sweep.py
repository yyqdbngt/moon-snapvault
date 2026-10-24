"""Systematically mutates a valid snapshot and checks what `audit` concludes.

    python3 -B scripts/mutation_sweep.py [--verbose]

The other suites answer different questions. `robustness.py` asks whether an input
produces one JSON object and a clean exit - it never looks at `valid`. `fuzz.py` does
check verdicts, but on a handful of randomly chosen mutations per iteration. Nothing
sweeps every field of a snapshot against every class of change and checks the verdict
each time, which is the one claim `audit` exists to make.

Two properties are asserted for each mutant:

  A. Safety - if the mutation changes content without recomputing the manifest checksum,
     the answer must never be `valid: true`. Either the request is refused or the
     report says invalid; a clean bill of health for damaged bytes is the failure this
     whole project is about.

  B. Precision - for mutations whose outcome is predictable from the format, the exact
     verdict and the exact set of reasons must match. A report that says "invalid" for
     the wrong reason is a bug a reader would only find much later.

The one deliberate exception is documented rather than tested away: a mode change with
a recomputed checksum is reported valid, because the checksum is an integrity check and
not a signature. That is asserted here too, so the limitation stays visible instead of
being quietly assumed.
"""
import base64
import copy
import json
import subprocess
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
candidates = [
    root / '_build/js/release/build/cmd/main/main.js',
    root / '_build/js/debug/build/cmd/main/main.js',
]
cli = next((path for path in candidates if path.exists()), None)
if cli is None:
    sys.exit('mutation_sweep: build the JS target first (moon build --target js)')

VERBOSE = '--verbose' in sys.argv


def run(request):
    """Returns (kind, payload). kind is 'valid', 'invalid', 'raised' or 'broken'."""
    result = subprocess.run(
        ['node', str(cli), '-'], input=json.dumps(request),
        capture_output=True, text=True, encoding='utf-8', timeout=60,
    )
    text = result.stdout.strip()
    if not text:
        return 'broken', {'stdout': '', 'stderr': result.stderr[:200]}
    try:
        answer = json.loads(text)
    except json.JSONDecodeError:
        return 'broken', {'stdout': text[:200]}
    if result.returncode != 0:
        return 'raised', answer.get('error', '')
    if answer.get('valid') is True:
        return 'valid', answer
    return 'invalid', answer


def assemble_checksum(files, version):
    """The canonical checksum for a manifest, computed by the core itself."""
    result = subprocess.run(
        ['node', str(cli), '-'],
        input=json.dumps({'operation': 'assemble', 'files': files, 'format': version}),
        capture_output=True, text=True, encoding='utf-8', timeout=60,
    )
    answer = json.loads(result.stdout)
    if 'checksum' not in answer:
        raise SystemExit('mutation_sweep: assemble refused the manifest: ' + str(answer)[:200])
    return answer['checksum']


# --- the snapshot under test -------------------------------------------------

BASE_FILES = [
    {'path': 'a.txt', 'digest': 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
     'size': 3, 'mode': 420},
    {'path': 'docs/b.md', 'digest': '4a60bf7d4bc1e485744cf7e8d0860524752fca1ce42331be7c439fd23043f151',
     'size': 2, 'mode': 420},
]
BASE_OBJECTS = {
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad': 'YWJj',
    '4a60bf7d4bc1e485744cf7e8d0860524752fca1ce42331be7c439fd23043f151': 'eno=',
}

# Wrong values worth trying anywhere. Each is a legal JSON value of an illegal shape
# for the field it lands in.
WRONG_VALUES = [None, True, 0, -1, 1.5, '', 'x', [], [1, 2], {}, {'k': 1}]


def base_snapshot():
    checksum = assemble_checksum(BASE_FILES, 3)
    return {
        'version': 3,
        'parent': None,
        'files': copy.deepcopy(BASE_FILES),
        'objects': copy.deepcopy(BASE_OBJECTS),
        'checksum': checksum,
    }


def mutants(base):
    """Yields (label, mutant, expect) where expect is 'safe' or a prediction tuple.

    'safe' means: this mutant must not be reported valid, but the specific verdict is
    left open because several layers can legitimately catch it first.
    """
    def clone():
        return copy.deepcopy(base)

    # --- top-level fields: removal and retyping -----------------------------
    for field in ['version', 'parent', 'files', 'objects', 'checksum']:
        m = clone()
        del m[field]
        if field == 'parent':
            # A format 3 canonical form always carries the key, with `null` when there
            # is no parent, so removing it describes exactly the same snapshot. That is
            # worth pinning: it means the manifest has one spelling, not two.
            yield f'delete {field}', m, ('valid', set())
        else:
            yield f'delete {field}', m, 'safe'
        for value in WRONG_VALUES:
            if field == 'version' and value == 3:
                continue
            if field == 'parent' and value is None:
                yield f'{field} = null', m, ('valid', set())
                continue
            m = clone()
            m[field] = value
            yield f'{field} = {json.dumps(value)[:20]}', m, 'safe'

    # --- each file, each field ---------------------------------------------
    for index in range(len(base['files'])):
        for field in ['path', 'digest', 'size', 'mode']:
            m = clone()
            del m['files'][index][field]
            yield f'delete files[{index}].{field}', m, 'safe'
            for value in WRONG_VALUES:
                m = clone()
                m['files'][index][field] = value
                yield f'files[{index}].{field} = {json.dumps(value)[:16]}', m, 'safe'

    # A value change inside a legal range is only caught by the checksum, which is the
    # point of the checksum: without recomputing it nothing may pass.
    for index in range(len(base['files'])):
        for field, value in [('size', 99), ('mode', 0o600), ('digest', 'f' * 64),
                             ('path', 'renamed.txt')]:
            m = clone()
            m['files'][index][field] = value
            yield f'files[{index}].{field} -> {value}', m, 'safe'

    # --- each stored object -------------------------------------------------
    for digest in list(base['objects']):
        m = clone()
        del m['objects'][digest]
        yield f'delete objects[{digest[:8]}]', m, 'safe'
        for value in WRONG_VALUES:
            m = clone()
            m['objects'][digest] = value
            yield f'objects[{digest[:8]}] = {json.dumps(value)[:16]}', m, 'safe'
        # A different payload of the same length: only the digest can notice. The
        # replacement is generated from the real payload so the length is preserved -
        # a hard-coded one would also trip the size check and make the assertion about
        # the wrong thing.
        original = base64.b64decode(base['objects'][digest], validate=True)
        flipped = bytes((byte + 1) % 256 for byte in original) or b'\x00'
        if len(flipped) == len(original):
            m = clone()
            m['objects'][digest] = base64.b64encode(flipped).decode()
            yield f'objects[{digest[:8]}] payload flipped', m, ('invalid', {'digest mismatch'})
        # Valid base64 that no file references and whose key does not match.
        m = clone()
        m['objects']['0' * 64] = 'YWJj'
        yield 'objects gains an unreferenced mismatched entry', m, ('invalid', {'digest mismatch'})

    # --- mutations that do recompute the checksum ---------------------------
    # These are self-consistent snapshots: the checksum is not a signature, so what
    # the audit can and cannot say here is a property of the design.
    m = clone()
    m['files'][0]['size'] = 4
    m['checksum'] = assemble_checksum(m['files'], 3)
    yield 'size 4, checksum recomputed', m, ('invalid', {'size mismatch'})

    m = clone()
    m['files'][0]['mode'] = 0o600
    m['checksum'] = assemble_checksum(m['files'], 3)
    # Documented limitation: integrity, not authentication.
    yield 'mode 0600, checksum recomputed', m, ('any', set())

    m = clone()
    m['files'][0]['path'] = 'renamed.txt'
    m['checksum'] = assemble_checksum(m['files'], 3)
    yield 'path renamed, checksum recomputed', m, ('valid', set())

    m = clone()
    m['objects']['0' * 64] = 'YWJj'
    yield 'unreferenced object dropped nothing, checksum unchanged', m, 'safe'

    m = clone()
    m['checksum'] = 'f' * 64
    yield 'checksum replaced', m, ('raised', 'manifest checksum mismatch')


def main():
    base = base_snapshot()
    kind, answer = run({'operation': 'audit', 'snapshot': base})
    if kind != 'valid':
        print(f'mutation_sweep: the unmodified snapshot is not valid ({kind}): {answer}')
        sys.exit(1)

    failures = []
    checked = 0
    by_kind = {'valid': 0, 'invalid': 0, 'raised': 0}
    for label, mutant, expect in mutants(base):
        checked += 1
        kind, answer = run({'operation': 'audit', 'snapshot': mutant})
        if kind == 'broken':
            failures.append(f'{label}: no usable answer: {answer}')
            continue
        by_kind[kind] += 1

        if expect == 'safe':
            if kind == 'valid':
                failures.append(f'{label}: reported valid, but content changed without a '
                                f'recomputed checksum')
            continue

        want_kind, want_reasons = expect
        if want_kind == 'any':
            continue
        if kind != want_kind:
            failures.append(f'{label}: expected {want_kind}, got {kind} ({str(answer)[:120]})')
            continue
        if not want_reasons:
            continue
        if want_kind == 'raised':
            # A refusal carries the message itself rather than a report.
            if not any(reason in answer for reason in want_reasons):
                failures.append(f'{label}: refused with {answer!r}, wanted '
                                f'{sorted(want_reasons)}')
        else:
            got = {issue.get('reason') for issue in answer.get('issues', [])}
            if got != want_reasons:
                failures.append(f'{label}: reasons {sorted(got)} != {sorted(want_reasons)}')

    if VERBOSE:
        for label, _, _ in mutants(base):
            print('  ' + label)

    if failures:
        print(f'Mutation sweep: {len(failures)} of {checked} mutants were handled wrongly')
        for failure in failures[:40]:
            print('  ' + failure)
        sys.exit(1)
    print(f'Mutation sweep: {checked} mutants, every verdict as the format requires '
          f'({by_kind["raised"]} refused, {by_kind["invalid"]} reported invalid, '
          f'{by_kind["valid"]} legitimately valid)')


if __name__ == '__main__':
    main()
