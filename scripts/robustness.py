"""Structural robustness fuzzing of the input boundary.

    python3 -B scripts/robustness.py [cases] [--seed N]

`fuzz.py` deliberately never sends malformed JSON. This does the opposite: it
mutates snapshot and request structures - wrong types, missing fields, absurd
numbers, deep nesting, control characters, duplicate keys - and asserts the one
property a command-line tool must hold no matter what it is fed:

    every input produces exactly one JSON object on stdout, and exit 0, 1 or 2

A crash, an abort, a hang, a stack trace, or partial output is a failure. The point
is not that these inputs mean anything, but that a corrupt snapshot file on disk is
a realistic input and must be refused rather than crash the process.

Failures print the seed and the case index, so each one is reproducible.
"""
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
    sys.exit('robustness: build the JS target first (moon build --target js)')

TIMEOUT = 30
failures = []


def run(raw):
    """Feeds `raw` on stdin. Returns (exit, stdout, stderr, timed_out)."""
    try:
        result = subprocess.run(
            ['node', str(cli), '-'], input=raw, capture_output=True, text=True,
            encoding='utf-8', errors='replace', timeout=TIMEOUT,
        )
    except subprocess.TimeoutExpired:
        return None, '', '', True
    return result.returncode, result.stdout, result.stderr, False


def check(label, raw):
    code, out, err, timed_out = run(raw)
    if timed_out:
        failures.append(f'{label}: hung for more than {TIMEOUT}s')
        return
    if code not in (0, 1, 2):
        failures.append(f'{label}: exit {code} (expected 0, 1 or 2); '
                        f'stderr {err.strip()[:160]!r}')
        return
    if not out.strip():
        failures.append(f'{label}: exit {code} with empty stdout; '
                        f'stderr {err.strip()[:160]!r}')
        return
    try:
        parsed = json.loads(out)
    except json.JSONDecodeError as exc:
        failures.append(f'{label}: stdout is not JSON ({exc}); {out[:120]!r}')
        return
    if not isinstance(parsed, dict):
        failures.append(f'{label}: stdout is a JSON {type(parsed).__name__}, not an object')
        return
    # The project's own contract: exit 0 carries a result, exit 1/2 carries "error".
    if code == 0 and 'error' in parsed:
        failures.append(f'{label}: exit 0 but reported an error')
    if code != 0 and 'error' not in parsed:
        failures.append(f'{label}: exit {code} without an error message: {out[:120]!r}')
    if parsed.get('error') is not None and not isinstance(parsed['error'], str):
        failures.append(f'{label}: error field is not a string')


# --- a valid snapshot to mutate ----------------------------------------------

BASE_FILES = [
    {'path': 'a.txt', 'digest': 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
     'size': 3, 'mode': 420},
    {'path': 'docs/b.md', 'digest': '4a60bf7d4bc1e485744cf7e8d0860524752fca1ce42331be7c439fd23043f151',
     'size': 2, 'mode': 420},
]
BASE = {
    'version': 3,
    'parent': None,
    'files': BASE_FILES,
    'objects': {
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad': 'YWJj',
        '4a60bf7d4bc1e485744cf7e8d0860524752fca1ce42331be7c439fd23043f151': 'eno=',
    },
    'checksum': '00ec7c4e1840003c752a6f234882320de66a05c59a5326c2cc9131605e267b9f',
}
DIGEST_A = BASE_FILES[0]['digest']
DIGEST_B = BASE_FILES[1]['digest']

MISSING = object()
TYPES = [None, True, False, 0, -1, 1.5, 1e308, -1e308, '', 'x', [], [1, 2], {}, {'k': 1}]


def audit_case(snapshot):
    return json.dumps({'operation': 'audit', 'snapshot': snapshot})


def with_field(path, value):
    """A copy of BASE with `path` replaced (or removed when value is MISSING)."""
    doc = json.loads(json.dumps(BASE))
    node = doc
    for key in path[:-1]:
        node = node[key]
    if value is MISSING:
        del node[path[-1]]
    else:
        node[path[-1]] = value
    return doc


def type_swap_cases():
    paths = [
        ['version'], ['parent'], ['files'], ['objects'], ['checksum'],
        ['files', 0], ['files', 0, 'path'], ['files', 0, 'digest'],
        ['files', 0, 'size'], ['files', 0, 'mode'],
    ]
    for path in paths:
        for value in TYPES + [MISSING]:
            label = 'types/{}={}'.format(
                '/'.join(str(part) for part in path),
                'MISSING' if value is MISSING else json.dumps(value)[:24])
            yield label, audit_case(with_field(path, value))


def object_key_cases():
    for key in ['', 'a', 'A' * 64, '0' * 64, '0' * 65, 'g' * 64,
                '\u00ff' * 64, '../' + '0' * 61, DIGEST_A.upper()]:
        doc = with_field(['objects'], {key: 'YWJj'})
        yield 'keys/' + repr(key[:12]), audit_case(doc)
        doc = with_field(['objects'], {DIGEST_A: 'YWJj', key: 'YWJj'})
        yield 'keys-extra/' + repr(key[:12]), audit_case(doc)


def path_cases():
    hostile = [
        '', '/', '//', '.', '..', '../a', 'a/../../b', './a', 'a/.', 'a/..',
        'a//b', '\\', 'C:\\x', 'a\\b', 'con', 'CON', 'com1', 'com1.txt',
        'a.', 'a ', ' a', '\x00', 'a\x00b', '\x1f', 'a\tb', 'a\nb',
        'a\u0085b', 'a\u2028b', '\u202eevil', 'a\u200bb', '\ufeffa',
        'a' * 4096, '/'.join(['d'] * 200),
        '...', 'a..b', '%2e%2e', '~', '~root', '$HOME', 'a:b',
    ]
    for path in hostile:
        files = [dict(BASE_FILES[0], path=path)]
        doc = dict(BASE, files=files)
        yield 'path/' + repr(path[:16]), audit_case(doc)


def numeric_cases():
    raw_numbers = ['1e400', '-1e400', '1e-400', '0.0', '-0', '1e16', '1e308',
                   '9007199254740993', '-9007199254740993', '0.1', 'NaN', 'Infinity']
    for field in ['version', 'mode', 'size']:
        for raw in raw_numbers:
            text = json.dumps(BASE).replace(
                '"{}": {}'.format(field, '420' if field == 'mode' else '3'),
                '"{}": {}'.format(field, raw), 1)
            if field == 'version':
                text = json.dumps(BASE).replace('"version": 3', '"version": ' + raw, 1)
            yield 'numbers/{}/{}'.format(field, raw), \
                '{"operation":"audit","snapshot":' + text + '}'


def structural_cases():
    yield 'raw/empty', ''
    yield 'raw/blank', '   '
    yield 'raw/null', 'null'
    yield 'raw/array', '[]'
    yield 'raw/number', '42'
    yield 'raw/string', '"x"'
    yield 'raw/broken', '{"operation":'
    yield 'raw/trailing', json.dumps({'operation': 'audit', 'snapshot': BASE}) + 'junk'
    yield 'raw/two', json.dumps({'operation': 'audit', 'snapshot': BASE}) * 2
    yield 'raw/bom', '\ufeff' + json.dumps({'operation': 'audit', 'snapshot': BASE})
    yield 'raw/deep', '{"operation":"audit","snapshot":' + '[' * 2000 + ']' * 2000 + '}'
    yield 'raw/deep-object', '{"operation":"audit","snapshot":' + '{"a":' * 500 + '1' + '}' * 500 + '}'
    yield 'raw/long-string', json.dumps({'operation': 'audit', 'snapshot': BASE})[:-1] + ',"x":"' + 'y' * 100000 + '"}'
    yield 'raw/duplicate', json.dumps({'operation': 'audit', 'snapshot': BASE})[:-1] + ',"operation":"restore"}'
    yield 'raw/proto', '{"operation":"audit","snapshot":{"__proto__":{"polluted":1},"version":3,"files":[],"objects":{},"checksum":""}}'
    yield 'raw/surrogate', '{"operation":"audit","snapshot":{"version":3,"files":[{"path":"\\ud800","digest":"' + DIGEST_A + '","size":3,"mode":420}],"objects":{},"checksum":"x"}}'


def request_cases():
    valid = json.dumps({'operation': 'audit', 'snapshot': BASE})
    for operation in ['', 'AUDIT', 'audit ', 'unknown', '\u0000', 'restore']:
        doc = json.loads(valid)
        doc['operation'] = operation
        yield 'op/' + repr(operation[:12]), json.dumps(doc)
    # Wrong shapes for the containers each operation reads.
    for key, value in [('parents', 'x'), ('paths', 'x'), ('digests', 'x'),
                       ('known_objects', 'x'), ('files', 'x'), ('snapshots', 'x'),
                       ('keep', 'x'), ('format', 'x')]:
        doc = json.loads(valid)
        doc[key] = value
        yield 'req/' + key, json.dumps(doc)
    for operation in ['locate', 'extract', 'assemble', 'squash', 'restore', 'retention']:
        yield 'req/minimal-' + operation, json.dumps({'operation': operation})
    yield 'req/no-body', ''
    yield 'req/create-no-files', json.dumps({'operation': 'create'})
    yield 'req/create-files-scalar', json.dumps({'operation': 'create', 'files': 3})
    yield 'req/create-file-scalar', json.dumps({'operation': 'create', 'files': [3]})


def chain_cases():
    """A delta whose parent link is missing, cyclic, or the wrong snapshot."""
    base = json.loads(json.dumps(BASE))
    delta = {
        'version': 3,
        'parent': BASE['checksum'],
        'files': BASE_FILES,
        'objects': {},
        'checksum': 'f' * 64,
    }
    yield 'chain/missing-parent', json.dumps(
        {'operation': 'audit', 'snapshot': delta, 'parents': []})
    yield 'chain/self-parent', json.dumps(
        {'operation': 'audit', 'snapshot': delta, 'parents': [delta]})
    yield 'chain/duplicate-parents', json.dumps(
        {'operation': 'audit', 'snapshot': delta, 'parents': [base, base, base]})
    deep = base
    for _ in range(70):
        deep = {'version': 3, 'parent': deep['checksum'], 'files': [], 'objects': {},
                'checksum': 'e' * 64}
    yield 'chain/too-deep', json.dumps(
        {'operation': 'audit', 'snapshot': deep, 'parents': [base]})
    yield 'chain/parent-not-object', json.dumps(
        {'operation': 'audit', 'snapshot': delta, 'parents': [1, 'x', None]})


def retention_cases():
    for snapshots in [None, 'x', [], [1], [{}], [{'id': ''}],
                      [{'id': 'a'}, {'id': 'a'}],
                      [{'id': 'a', 'snapshot': {}}],
                      [{'id': 'a', 'snapshot': BASE, 'parents': 'x'}]]:
        request = {'operation': 'retention'}
        if snapshots is not None:
            request['snapshots'] = snapshots
        yield 'retention/snapshots=' + json.dumps(snapshots)[:20], json.dumps(request)
    for keep in [[], ['missing'], ['a', 'a'], 'x', 3, [1], [None]]:
        yield 'retention/keep=' + json.dumps(keep)[:16], json.dumps(
            {'operation': 'retention', 'keep': keep,
             'snapshots': [{'id': 'a', 'snapshot': BASE}]})


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    seed = 0
    if '--seed' in sys.argv:
        seed = int(sys.argv[sys.argv.index('--seed') + 1])
    limit = int(args[0]) if args else 0

    producers = [structural_cases, request_cases, chain_cases, retention_cases,
                 type_swap_cases, object_key_cases, path_cases, numeric_cases]
    seen = 0
    for produce in producers:
        for label, raw in produce():
            if limit and seen >= limit:
                break
            seen += 1
            check(label, raw)

    if failures:
        print(f'Robustness: {len(failures)} of {seen} cases broke the contract (seed {seed})')
        for failure in failures[:30]:
            print('  ' + failure)
        sys.exit(1)
    print(f'Robustness: {seen} malformed inputs all produced one JSON object '
          f'with exit 0, 1 or 2')


if __name__ == '__main__':
    main()
