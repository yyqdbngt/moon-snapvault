"""Independent oracle for format 3 deltas: the chain logic is re-derived here.

Everything below is computed from the snapshot JSON with hashlib/base64 only, so
a bug shared between the MoonBit resolver and the host adapter cannot hide here.
"""
import base64
import hashlib
import json
import subprocess
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
cli = root / '_build/js/debug/build/cmd/main/main.js'
if not cli.exists():
    cli = root / '_build/js/release/build/cmd/main/main.js'


def run(request, error=False):
    result = subprocess.run(
        ['node', str(cli), '-'], input=json.dumps(request),
        capture_output=True, text=True, encoding='utf-8', timeout=120,
    )
    if error:
        assert result.returncode == 1, (result.returncode, result.stdout[:200])
        return json.loads(result.stdout)
    assert result.returncode == 0, (result.returncode, result.stdout[:400])
    return json.loads(result.stdout)


def sha(data):
    """Digest of text or bytes, so callers need not care which they hold."""
    if isinstance(data, str):
        data = data.encode()
    return hashlib.sha256(data).hexdigest()


def key_order(key):
    """The project sorts canonical keys by length first, then by code unit.

    That is MoonBit's default `String::compare`, and it is the order every
    released snapshot checksum was computed with, so it cannot be changed
    without invalidating existing files.
    """
    return (len(key), key)


def canonical(value):
    """Mirror of the project's canonical JSON: keys by (length, code unit)."""
    if isinstance(value, dict):
        return '{' + ','.join(
            json.dumps(k) + ':' + canonical(value[k])
            for k in sorted(value, key=key_order)
        ) + '}'
    if isinstance(value, list):
        return '[' + ','.join(canonical(item) for item in value) + ']'
    return json.dumps(value, ensure_ascii=False)


def manifest_checksum(snapshot):
    version = snapshot['version']
    body = {'version': version, 'files': snapshot['files']}
    if version >= 3:
        body['parent'] = snapshot.get('parent')
    return sha(canonical(body))


def walk(snapshot, parents):
    """Yields the chain from the snapshot to the root, verifying each link."""
    available = {p['checksum']: p for p in parents}
    chain, seen = [], set()
    current = snapshot
    while True:
        assert manifest_checksum(current) == current['checksum'], 'manifest checksum'
        if current['checksum'] in seen:
            raise AssertionError('cycle')
        seen.add(current['checksum'])
        chain.append(current)
        parent = current.get('parent')
        if parent is None:
            return chain
        current = available[parent]


def resolve(chain, digest):
    for link in chain:
        if digest in link['objects']:
            raw = link['objects'][digest]
            payload = (
                base64.b64decode(raw, validate=True)
                if link['version'] >= 2
                else bytes(raw)
            )
            assert hashlib.sha256(payload).hexdigest() == digest, digest
            return payload
    raise AssertionError('unresolved ' + digest)


failures = 0


def check(name, ok, detail=''):
    global failures
    if not ok:
        failures += 1
        print(('FAIL ' + name + ' ' + detail).strip())
    else:
        print('PASS ' + name)


# --- base and delta ---------------------------------------------------------
shared = b'shared payload ' * 40
retired = b'retired payload ' * 40
fresh = b'fresh payload ' * 40
added = b'added payload ' * 40

base = run({'format': 3, 'files': [
    {'path': 'shared.txt', 'content_base64': base64.b64encode(shared).decode()},
    {'path': 'retired.txt', 'content_base64': base64.b64encode(retired).decode()},
]})['snapshot']
check('base is self contained', base['version'] == 3 and base.get('parent') is None)
check('base stores both objects', len(base['objects']) == 2, str(len(base['objects'])))
check('base checksum matches the oracle', manifest_checksum(base) == base['checksum'])

result = run({'format': 3, 'previous': base, 'files': [
    {'path': 'shared.txt', 'content_base64': base64.b64encode(shared).decode()},
    {'path': 'retired.txt', 'content_base64': base64.b64encode(fresh).decode()},
    {'path': 'added.txt', 'content_base64': base64.b64encode(added).decode()},
]})
delta = result['snapshot']
stats = result['statistics']
check('delta names its parent', delta['parent'] == base['checksum'])
check('delta stores only new content', sorted(delta['objects']) == sorted([
    sha(fresh.decode()), sha(added.decode()),
]), str(sorted(delta['objects'])))
check('delta statistics follow the oracle', (
    stats['new_object_bytes'] == len(fresh) + len(added)
    and stats['reused_object_bytes'] == len(shared)
    and stats['objects_stored'] == 2
    and stats['objects_reused'] == 1
), str(stats))

# --- audit and restore ------------------------------------------------------
report = run({'operation': 'audit', 'snapshot': delta, 'parents': [base]})
chain = walk(delta, [base])
digests = {d for link in chain for d in link['objects']}
check('chain walk agrees on depth', report['chain_depth'] == len(chain) == 2, str(report['chain_depth']))
check('chain walk agrees on inherited objects', report['objects_inherited'] == 2, str(report['objects_inherited']))
check('chain walk agrees on checked objects', report['objects_checked'] == len(digests) == 4, str(report['objects_checked']))
check('audit is valid', report['valid'] is True, str(report['issues']))

restored = run({'operation': 'restore', 'snapshot': delta, 'parents': [base]})
expected = {
    'shared.txt': shared, 'retired.txt': fresh, 'added.txt': added,
}
actual = {
    f['path']: base64.b64decode(f['bytes'], validate=True) for f in restored['files']
}
check('restore matches the oracle', actual == expected)
check('restore reports the chain', restored['chain_depth'] == 2)

# --- three-link chain -------------------------------------------------------
second = run({'format': 3, 'previous': delta, 'parents': [base], 'files': [
    {'path': 'shared.txt', 'content_base64': base64.b64encode(shared).decode()},
    {'path': 'retired.txt', 'content_base64': base64.b64encode(fresh).decode()},
    {'path': 'added.txt', 'content_base64': base64.b64encode(added).decode()},
    {'path': 'later.txt', 'content_base64': base64.b64encode(b'later').decode()},
]})['snapshot']
third_chain = walk(second, [base, delta])
check('three links resolve', len(third_chain) == 3, str(len(third_chain)))
report = run({'operation': 'audit', 'snapshot': second, 'parents': [delta, base]})
check('three-link audit is valid', report['valid'] is True and report['chain_depth'] == 3)
restored = run({'operation': 'restore', 'snapshot': second, 'parents': [base, delta]})
check('three-link restore is complete', len(restored['files']) == 4)

# --- refusals ---------------------------------------------------------------
missing = run({'operation': 'audit', 'snapshot': delta}, error=False)
reasons = [issue['reason'] for issue in missing['issues']]
check('a delta alone is not valid', missing['valid'] is False and 'missing parent snapshot' in reasons, str(reasons))
refused = run({'operation': 'restore', 'snapshot': delta}, error=True)
check('restore without the chain is refused', 'error' in refused)

tampered = json.loads(json.dumps(base))
for key in tampered['objects']:
    tampered['objects'][key] = base64.b64encode(b'x' * 8).decode()
bad = run({'operation': 'audit', 'snapshot': delta, 'parents': [tampered]})
check('a corrupt parent is caught', bad['valid'] is False and any(
    issue['reason'] == 'digest mismatch' for issue in bad['issues']
), str(bad['issues']))

moved = json.loads(json.dumps(delta))
moved['parent'] = sha('some other snapshot')
bad = run({'operation': 'audit', 'snapshot': moved, 'parents': [base]}, error=True)
check('re-pointing a delta breaks its checksum',
      'checksum' in bad['error'], bad['error'])

legacy = run({'format': 2, 'files': [], 'previous': base}, error=True)
check('format 2 refuses a parent chain', 'error' in legacy)

# --- squash and selective restore ------------------------------------------
squashed = run({'operation': 'squash', 'snapshot': second, 'parents': [base, delta]})['snapshot']
check('squash drops the parent', squashed.get('parent') is None and squashed['version'] == 3)
check('squash checksum matches the oracle', manifest_checksum(squashed) == squashed['checksum'])
check('squash keeps the manifest', squashed['files'] == second['files'])
check('squash stores every reachable object', sorted(squashed['objects']) == sorted(
    {sha(d.decode()) for d in (shared, fresh, added, b'later')}
), str(sorted(squashed['objects'])))
report = run({'operation': 'audit', 'snapshot': squashed})
check('a squashed snapshot needs no chain', report['valid'] is True and report['chain_depth'] == 1)
restored = run({'operation': 'restore', 'snapshot': squashed})
actual = {f['path']: base64.b64decode(f['bytes'], validate=True) for f in restored['files']}
check('a squashed snapshot restores the same tree', actual == {
    'shared.txt': shared, 'retired.txt': fresh, 'added.txt': added, 'later.txt': b'later',
})

# Squashing to format 2 must equal creating the same tree directly.
direct = run({'format': 2, 'files': [
    {'path': 'shared.txt', 'content_base64': base64.b64encode(shared).decode()},
    {'path': 'retired.txt', 'content_base64': base64.b64encode(fresh).decode()},
    {'path': 'added.txt', 'content_base64': base64.b64encode(added).decode()},
    {'path': 'later.txt', 'content_base64': base64.b64encode(b'later').decode()},
]})['snapshot']
as_two = run({'operation': 'squash', 'snapshot': second, 'parents': [base, delta], 'format': 2})['snapshot']
check('squash to format 2 equals a direct create', (
    as_two['checksum'] == direct['checksum'] and as_two['objects'] == direct['objects']
), as_two['checksum'] + ' vs ' + direct['checksum'])

# Selective restore: a directory prefix, an exact file, and a miss.
partial = run({'operation': 'restore', 'snapshot': second, 'parents': [base, delta],
               'paths': ['added.txt']})
check('restore selects one file', [f['path'] for f in partial['files']] == ['added.txt'],
      str([f['path'] for f in partial['files']]))
check('restore reports the selection size',
      partial['selected'] == 1 and partial['total_files'] == 4, str(partial['selected']))
missing = run({'operation': 'restore', 'snapshot': second, 'parents': [base, delta],
               'paths': ['nope.txt']}, error=True)
check('restore refuses an unknown path', 'not found' in missing['error'], missing['error'])
unsafe = run({'operation': 'restore', 'snapshot': second, 'parents': [base, delta],
              'paths': ['../etc/passwd']}, error=True)
check('restore refuses an unsafe path', 'unsafe' in unsafe['error'], unsafe['error'])
nothing = run({'operation': 'restore', 'snapshot': second, 'parents': [base, delta],
               'paths': []}, error=True)
check('restore refuses an empty selection', 'at least one' in nothing['error'], nothing['error'])

# --- declared objects instead of carrying the parent ------------------------
# The adapter sends a manifest-only parent plus a digest list when a request
# would otherwise be too large, so that path has to produce the same snapshot.
slim_parent = {k: base[k] for k in ('version', 'files', 'checksum')}
slim_parent['parent'] = base.get('parent')
slim = run({'format': 3, 'previous': slim_parent, 'files': [
    {'path': 'shared.txt', 'content_base64': base64.b64encode(shared).decode()},
    {'path': 'retired.txt', 'content_base64': base64.b64encode(fresh).decode()},
    {'path': 'added.txt', 'content_base64': base64.b64encode(added).decode()},
], 'known_objects': sorted(base['objects'])})['snapshot']
check('a declared-objects delta equals the full-parent delta',
      slim['checksum'] == delta['checksum'] and slim['objects'] == delta['objects'],
      slim['checksum'] + ' vs ' + delta['checksum'])
check('the declared-objects delta reads through the chain',
      run({'operation': 'audit', 'snapshot': slim, 'parents': [base]})['valid'] is True)

# A claim the chain cannot honour must surface at read time, not silently.
lie = run({'format': 3, 'previous': slim_parent, 'files': [
    {'path': 'shared.txt', 'content_base64': base64.b64encode(shared).decode()},
    {'path': 'retired.txt', 'content_base64': base64.b64encode(fresh).decode()},
    {'path': 'added.txt', 'content_base64': base64.b64encode(added).decode()},
    {'path': 'invented.txt', 'content_base64': base64.b64encode(b'invented payload').decode()},
], 'known_objects': sorted(base['objects']) + [sha(b'invented payload')]})['snapshot']
check('a false declaration does not store the payload', sha(b'invented payload') not in lie['objects'])
bad = run({'operation': 'audit', 'snapshot': lie, 'parents': [base]})
check('a false declaration is reported as a missing object',
      bad['valid'] is False and any(i['reason'] == 'missing object' for i in bad['issues']),
      str(bad['issues']))
run({'operation': 'restore', 'snapshot': lie, 'parents': [base]}, error=True)
check('a false declaration cannot be restored', True)

print('Delta oracle: base/delta/three-link chains resolve, squash and refuse as expected'
      if not failures else 'Delta oracle: %d check(s) failed' % failures)
sys.exit(1 if failures else 0)
