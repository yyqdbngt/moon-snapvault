"""Independent Python standard library oracles; deterministic synthetic data."""
import base64
import hashlib
import json
import random
import subprocess
import tempfile
from pathlib import Path

root = Path(__file__).resolve().parents[1]
cli = root / '_build/js/debug/build/cmd/main/main.js'
random.seed(20261005)


def cli_run(args, stdin=None, timeout=60):
    return subprocess.run(
        ['node', str(cli), *args],
        input=stdin,
        capture_output=True,
        text=True,
        encoding='utf-8',
        timeout=timeout,
    )


def run(request):
    result = cli_run(['-'], stdin=json.dumps(request))
    if result.returncode:
        raise RuntimeError(result.stdout or result.stderr)
    return json.loads(result.stdout)


# --- digest and round trip -------------------------------------------------
files = [
    {'path': str(i) + '.bin', 'bytes': [random.randrange(256) for _ in range(random.randrange(256))]}
    for i in range(30)
]
result = run({'files': files})
expected = {f['path']: hashlib.sha256(bytes(f['bytes'])).hexdigest() for f in files}
for f in result['snapshot']['files']:
    assert f['digest'] == expected[f['path']]
def payload(restored):
    """Restore returns the payload in the snapshot's own encoding."""
    assert restored['encoding'] == 'base64', restored['encoding']
    return {f['path']: list(base64.b64decode(f['bytes'], validate=True)) for f in restored['files']}


restored = run({'operation': 'restore', 'snapshot': result['snapshot']})
assert payload(restored) == {f['path']: f['bytes'] for f in files}
report = run({'operation': 'audit', 'snapshot': result['snapshot']})
assert report['valid'] and report['format'] == 2, report
print('Python hashlib oracle: 30 binary inputs, SHA256, audit and verified restore passed')

# The previous on-disk format is still readable and still usable as input.
legacy = run({'format': 1, 'files': [{'path': 'legacy.bin', 'bytes': [0, 255, 7]}]})['snapshot']
assert legacy['version'] == 1, legacy['version']
assert legacy['objects'][legacy['files'][0]['digest']] == [0, 255, 7], legacy['objects']
legacy_restore = run({'operation': 'restore', 'snapshot': legacy})
assert legacy_restore['encoding'] == 'decimal', legacy_restore['encoding']
assert legacy_restore['files'][0]['bytes'] == [0, 255, 7]
assert run({'operation': 'audit', 'snapshot': legacy})['format'] == 1

# A version 2 snapshot stores base64 and rejects a decimal payload.
current = run({'files': [{'path': 'b64.bin', 'content_base64': 'AP8H'}]})['snapshot']
assert current['version'] == 2, current['version']
assert current['objects'] == {legacy['files'][0]['digest']: 'AP8H'}, current['objects']
mixed = json.loads(json.dumps(current))
mixed['objects'][legacy['files'][0]['digest']] = [0, 255, 7]
assert run({'operation': 'audit', 'snapshot': mixed})['valid'] is False
refused = cli_run(['-'], stdin=json.dumps({'operation': 'restore', 'snapshot': mixed}))
assert refused.returncode == 1, refused.returncode
print('Format oracle: v1 decimal and v2 base64 both audit and restore; mixed encodings are refused')

# --- audit covers every stored object, referenced or not -------------------
base = run({'files': [{'path': 'a', 'text': 'abc'}]})['snapshot']
assert base['files'][0]['digest'] == hashlib.sha256(b'abc').hexdigest()
spare = run({'files': [{'path': 'z', 'text': 'zz'}]})['snapshot']
spare_hash = spare['files'][0]['digest']
assert spare_hash == hashlib.sha256(b'zz').hexdigest()

with_spare = json.loads(json.dumps(base))
with_spare['objects'][spare_hash] = spare['objects'][spare_hash]
report = run({'operation': 'audit', 'snapshot': with_spare})
assert report['valid'] is True, report
assert report['objects_total'] == 2 and report['objects_checked'] == 2, report
assert report['referenced_objects'] == 1 and report['unreferenced_objects'] == 1, report
plan = run({'operation': 'retention', 'snapshots': [{'id': 'one', 'snapshot': with_spare}]})
assert plan['collectible_objects'] == [spare_hash], plan
assert plan['collectible_bytes'] == 2 and plan['live_bytes'] == 3, plan

corrupt = json.loads(json.dumps(base))
corrupt['objects']['0' * 64] = [1, 2, 3]
assert run({'operation': 'audit', 'snapshot': corrupt})['valid'] is False
for request in ({'operation': 'restore', 'snapshot': corrupt},
                {'files': [], 'previous': corrupt}):
    failed = cli_run(['-'], stdin=json.dumps(request))
    assert failed.returncode == 1, (request['operation'], failed.returncode)
print('Audit oracle: unreferenced objects verified, retention and audit agree, corrupt input refused')

# --- CLI error contract ----------------------------------------------------
with tempfile.TemporaryDirectory() as tmp:
    tmp = Path(tmp)
    junk = tmp / 'junk.json'
    junk.write_text('not json', encoding='utf-8')
    bad_utf8 = tmp / 'bad.bin'
    bad_utf8.write_bytes(b'\xff\xfe{"files":[]}')
    big = tmp / 'big.json'
    big.write_bytes(b'{"files":[]}' + b' ' * (17 * 1024 * 1024))
    cases = {
        'missing file': [str(tmp / 'absent.json')],
        'invalid utf-8': [str(bad_utf8)],
        'input over 16 MiB': [str(big)],
        'invalid json': [str(junk)],
    }
    for label, args in cases.items():
        result = cli_run(args, timeout=120)
        assert result.returncode == 1, (label, result.returncode, result.stderr[:200])
        payload = json.loads(result.stdout)  # a stack trace would not parse
        assert set(payload) == {'error'}, (label, payload)
        assert isinstance(payload['error'], str) and payload['error'], (label, payload)
        assert 'InputError(' not in payload['error'], (label, payload)
        assert '    at ' not in payload['error'], (label, payload)
    usage = cli_run([])
    assert usage.returncode == 2, usage.returncode
print('CLI oracle: host-side failures report {"error": ...} on stdout with exit code 1, usage exits 2')
