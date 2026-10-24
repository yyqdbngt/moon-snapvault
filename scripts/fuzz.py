"""Randomized differential test: the MoonBit core against an independent oracle.

    python3 -B scripts/fuzz.py [iterations] [--seed N]

Every expected value below is recomputed from the snapshot JSON with hashlib and
base64 only, so a bug that lives in both the core and the host adapter cannot
hide here. Iterations are seeded and the seed is printed, so a failure is
reproducible with `--seed`.

What is covered per iteration:
  * create  - object set, statistics and checksum, for self-contained and delta
  * audit   - verdict and issue reasons for a set of deliberate mutations
  * restore - exact bytes, for the whole tree and for a random selection
  * squash  - reachable object set, checksum, idempotence, restore equality
  * retention - keep/drop/reachable/collectible sets and byte totals
"""
import base64
import hashlib
import json
import random
import subprocess
import sys
from collections import Counter
from pathlib import Path

root = Path(__file__).resolve().parents[1]
candidates = [
    root / '_build/js/release/build/cmd/main/main.js',
    root / '_build/js/debug/build/cmd/main/main.js',
]
cli = next((path for path in candidates if path.exists()), None)
if cli is None:
    sys.exit('fuzz: build the JS target first (moon build --target js)')


def call(request, expect_error=False, label='request'):
    """Runs one request. Returns (value, error_message)."""
    result = subprocess.run(
        ['node', str(cli), '-'], input=json.dumps(request),
        capture_output=True, text=True, encoding='utf-8', timeout=120,
    )
    payload = json.loads(result.stdout) if result.stdout.strip() else {}
    if expect_error:
        if result.returncode != 1:
            raise AssertionError('%s: expected an error, got exit %d: %s'
                                 % (label, result.returncode, result.stdout[:200]))
        return None, payload.get('error', '')
    if result.returncode != 0:
        raise AssertionError('%s: unexpected error exit %d: %s'
                            % (label, result.returncode,
                               payload.get('error', result.stdout[:200])))
    return payload, None


# --- oracle -----------------------------------------------------------------

def key_order(key):
    """MoonBit's default String::compare: length first, then code unit."""
    return (len(key), key)


def canonical(value):
    if isinstance(value, dict):
        return '{' + ','.join(
            json.dumps(k, ensure_ascii=False) + ':' + canonical(value[k])
            for k in sorted(value, key=key_order)
        ) + '}'
    if isinstance(value, list):
        return '[' + ','.join(canonical(item) for item in value) + ']'
    return json.dumps(value, ensure_ascii=False)


def sha(text):
    return hashlib.sha256(text.encode() if isinstance(text, str) else text).hexdigest()


def manifest_checksum(snapshot):
    version = snapshot['version']
    body = {'version': version, 'files': snapshot['files']}
    if version >= 3:
        body['parent'] = snapshot.get('parent')
    return sha(canonical(body))


def object_digests(snapshot):
    """Digest set a snapshot stores, keyed by whatever the payload decodes to."""
    return set(snapshot['objects'])


def payload_of(snapshot, digest):
    raw = snapshot['objects'][digest]
    return bytes(raw) if snapshot['version'] == 1 else base64.b64decode(raw, validate=True)


def walk(snapshot, parents):
    available = {p['checksum']: p for p in parents}
    chain, seen = [], set()
    current = snapshot
    while True:
        if current['checksum'] in seen:
            raise AssertionError('cycle')
        seen.add(current['checksum'])
        chain.append(current)
        parent = current.get('parent')
        if parent is None:
            return chain
        if parent not in available:
            return chain
        current = available[parent]


def resolve(chain, digest):
    for link in chain:
        if digest in link['objects']:
            payload = payload_of(link, digest)
            if hashlib.sha256(payload).hexdigest() != digest:
                raise AssertionError('payload does not match its own digest')
            return payload
    return None


def evaluate(snapshot, parents):
    """Independent verdict: (valid, set of issue reasons, checksum_ok)."""
    reasons = set()
    if manifest_checksum(snapshot) != snapshot['checksum']:
        return None, {'manifest checksum mismatch'}
    version = snapshot['version']
    for file in snapshot['files']:
        path = file.get('path', '')
        if not isinstance(path, str) or path.startswith('/') or '\\' in path:
            return None, {'unsafe path'}
    chain = walk(snapshot, parents)
    chain_complete = True
    parent = snapshot.get('parent')
    if parent is not None and parent not in {p['checksum'] for p in parents}:
        chain_complete = False
        reasons.add('missing parent snapshot')
    seen = {}
    for link in chain:
        for digest, raw in link['objects'].items():
            if not (isinstance(digest, str) and len(digest) == 64
                    and all(c in '0123456789abcdef' for c in digest)):
                reasons.add('invalid object identifier')
                continue
            if digest in seen:
                continue
            try:
                payload = payload_of(link, digest)
            except Exception:
                reasons.add('invalid object encoding')
                continue
            seen[digest] = payload
            if hashlib.sha256(payload).hexdigest() != digest:
                reasons.add('digest mismatch')
    for file in snapshot['files']:
        digest = file['digest']
        if digest not in seen:
            reasons.add('missing object')
        elif len(seen[digest]) != file['size']:
            reasons.add('size mismatch')
    return (not reasons and chain_complete), reasons


def diff_of(before, after):
    """Path-level comparison of two manifests."""
    left = {f['path']: f for f in before}
    right = {f['path']: f for f in after}
    added = sorted(set(right) - set(left))
    removed = sorted(set(left) - set(right))
    modified = sorted(p for p in set(left) & set(right) if left[p] != right[p])
    return {'added': added, 'removed': removed, 'modified': modified}


def sources_of(files):
    return {f['path']: (base64.b64decode(f['content_base64']), f.get('mode', 420))
            for f in files}


# --- fixtures ---------------------------------------------------------------

def make_tree(rng):
    """A small tree: a couple of directories, a duplicate, mixed sizes."""
    if rng.random() < 0.12:
        return []
    paths = ['a.txt', 'docs/one.md', 'docs/two.md']
    if rng.random() < 0.7:
        paths.append('docs/deep/three.bin')
    if rng.random() < 0.5:
        paths.append('dup.txt')
    if rng.random() < 0.25:
        paths.append('docs/deep/deeper/four.txt')
    files = []
    shared = bytes(rng.randrange(256) for _ in range(rng.randrange(0, 40)))
    for path in paths:
        if path == 'dup.txt':
            content = shared
        else:
            content = bytes(rng.randrange(256) for _ in range(rng.randrange(0, 64)))
        files.append({
            'path': path,
            'content_base64': base64.b64encode(content).decode(),
            'mode': rng.choice([0o644, 0o600, 0o755, 0o444]),
        })
    return files


def mutate_payload(snapshot, rng):
    """Rewrites one stored payload into a different byte string of equal length."""
    digest = rng.choice(sorted(snapshot['objects']))
    payload = payload_of(snapshot, digest)
    if not payload:
        return None
    replacement = bytes((byte + 1) % 256 for byte in payload)
    mutant = json.loads(json.dumps(snapshot))
    mutant['objects'][digest] = (list(replacement) if snapshot['version'] == 1
                                 else base64.b64encode(replacement).decode())
    return mutant, 'digest mismatch'


def mutate_decimal_in_base64(snapshot):
    digest = sorted(snapshot['objects'])[0]
    mutant = json.loads(json.dumps(snapshot))
    mutant['objects'][digest] = [1, 2, 3]
    return mutant, 'invalid object encoding'


def mutate_drop_object(snapshot):
    """Removes the payload a file needs, leaving the manifest intact."""
    digest = snapshot['files'][0]['digest']
    mutant = json.loads(json.dumps(snapshot))
    for link in [mutant]:
        link['objects'].pop(digest, None)
    return mutant, 'missing object'


def mutate_orphan(snapshot, rng, valid_payload):
    # An unreferenced object: its key is the digest of its own payload when the
    # mutation is meant to be well formed, and a deliberate mismatch otherwise.
    payload = bytes(rng.randrange(256) for _ in range(rng.randrange(1, 12)))
    digest = sha(payload) if valid_payload else sha(b'something else entirely')
    mutant = json.loads(json.dumps(snapshot))
    mutant['objects'][digest] = (list(payload) if snapshot['version'] == 1
                                 else base64.b64encode(payload).decode())
    return mutant, None if valid_payload else 'digest mismatch'


def mutate_bad_key(snapshot):
    mutant = json.loads(json.dumps(snapshot))
    mutant['objects']['not-a-digest'] = 'AAAA'
    return mutant, 'invalid object identifier'


def resign(snapshot, files=None, parent='keep'):
    """Recomputes the checksum so only semantic rules can reject the mutant."""
    mutant = json.loads(json.dumps(snapshot))
    if files is not None:
        mutant['files'] = files
    if parent != 'keep':
        mutant['parent'] = parent
    mutant['checksum'] = manifest_checksum(mutant)
    return mutant


# --- checks -----------------------------------------------------------------

failures = []


def check(label, condition, detail=''):
    if not condition:
        failures.append(f'{label}: {detail}')


def run_iteration(rng, index):
    tag = f'iteration {index}'
    files = make_tree(rng)

    # --- create: self contained ---------------------------------------------
    # Format 1 keeps the decimal payload layout that older readers produce, so a
    # random share of the runs exercise that path rather than only base64.
    base_format = rng.choice([1, 2, 3])
    base_doc, _ = call({'format': base_format, 'files': files}, label='create-base')
    check(tag + ' create/format', base_doc['snapshot']['version'] == base_format)
    base = base_doc['snapshot']
    expected = sources_of(files)
    digests = {sha(content) for content, _ in expected.values()}
    check(tag + ' create/objects', set(base['objects']) == digests,
          f"{sorted(base['objects'])} != {sorted(digests)}")
    check(tag + ' create/checksum', manifest_checksum(base) == base['checksum'])
    stats = base_doc['statistics']
    check(tag + ' create/total', stats['total_bytes'] == sum(len(c) for c, _ in expected.values()))
    check(tag + ' create/unique', stats['unique_bytes'] == sum(
        len(next(c for c, _ in expected.values() if sha(c) == d)) for d in digests))

    # --- restore the whole tree ---------------------------------------------
    restored, _ = call({'operation': 'restore', 'snapshot': base}, label='restore-base')
    got = ({f['path']: base64.b64decode(f['bytes']) for f in restored['files']}
           if restored['encoding'] == 'base64'
           else {f['path']: bytes(f['bytes']) for f in restored['files']})
    check(tag + ' restore/bytes', got == {p: c for p, (c, _) in expected.items()})
    check(tag + ' restore/encoding',
          restored['encoding'] == ('decimal' if base_format == 1 else 'base64'),
          restored['encoding'])

    # --- create a delta ------------------------------------------------------
    changed = json.loads(json.dumps(files))
    if changed:
        replaced = bytes(rng.randrange(256) for _ in range(rng.randrange(1, 40)))
        changed[0]['content_base64'] = base64.b64encode(replaced).decode()
        if rng.random() < 0.4:
            changed.append({'path': 'late.txt', 'content_base64': 'bGF0ZQ==', 'mode': 0o644})
        if rng.random() < 0.3 and len(changed) > 1:
            changed.pop()
    delta_doc, _ = call({'format': 3, 'previous': base, 'files': changed}, label='create-delta')
    delta = delta_doc['snapshot']
    check(tag + ' delta/parent', delta['parent'] == base['checksum'])
    check(tag + ' delta/diff', call({'operation': 'diff', 'old': base, 'new': delta},
                                    label='diff')[0]
          == diff_of(base['files'], delta['files']), 'diff disagrees with the oracle')
    check(tag + ' delta/checksum', manifest_checksum(delta) == delta['checksum'])
    chain = walk(delta, [base])
    reachable = {f['digest'] for f in delta['files']}
    union = {d for link in chain for d in link['objects']}
    check(tag + ' delta/coverage', reachable <= union,
          f'{sorted(reachable - union)} unresolved')
    check(tag + ' delta/stored', set(delta['objects']) == reachable - set(base['objects']),
          f"{sorted(delta['objects'])} vs {sorted(reachable - set(base['objects']))}")
    stats = delta_doc['statistics']
    check(tag + ' delta/reused', stats['objects_reused'] == len(set(base['objects']) & reachable),
          f"{stats['objects_reused']}")

    # --- audit agrees with the oracle ---------------------------------------
    for label, mutant, parents in [
        ('valid', delta, [base]),
        ('valid-base', base, []),
    ]:
        report, _ = call({'operation': 'audit', 'snapshot': mutant, 'parents': parents},
                         label='audit-' + label)
        expected_valid, reasons = evaluate(mutant, parents)
        check(f'{tag} audit/{label}', report['valid'] == expected_valid,
              f"core {report['valid']} oracle {expected_valid} {sorted(reasons)}")

    # --- mutations ----------------------------------------------------------
    mutants = [('orphan-valid', mutate_orphan(delta, rng, True)),
               ('orphan-bad', mutate_orphan(delta, rng, False)),
               ('bad-key', mutate_bad_key(delta))]
    if delta['objects']:
        mutants.append(('payload', mutate_payload(delta, rng)))
        mutants.append(('decimal', mutate_decimal_in_base64(delta)))
    if delta['files']:
        mutants.append(('drop', mutate_drop_object(delta)))
    for label, mutated in mutants:
        if mutated is None:
            continue
        mutant, expected_reason = mutated
        report, _ = call({'operation': 'audit', 'snapshot': mutant, 'parents': [base]},
                         label='mutate-' + label)
        expected_valid, reasons = evaluate(mutant, [base])
        check(f'{tag} mutate/{label}', report['valid'] == expected_valid,
              f"core {report['valid']} oracle {expected_valid} {sorted(reasons)}")
        core_reasons = {issue['reason'] for issue in report['issues']}
        check(f'{tag} mutate/{label}/reasons', core_reasons == reasons,
              f'{sorted(core_reasons)} vs {sorted(reasons)}')
        if expected_reason:
            check(f'{tag} mutate/{label}/expected', expected_reason in core_reasons,
                  f'{expected_reason} not in {sorted(core_reasons)}')

    # --- a missing chain link -----------------------------------------------
    report, _ = call({'operation': 'audit', 'snapshot': delta}, label='audit-no-chain')
    check(tag + ' missing-chain', report['valid'] is False
          and 'missing parent snapshot' in {i['reason'] for i in report['issues']},
          str(report['issues']))

    # --- checksum binding ---------------------------------------------------
    # Each edit lands after the checksum was computed, so the manifest no longer
    # matches it. Re-signing instead would make the snapshot well formed and the
    # change invisible, which is exactly what the checksum is there to prevent.
    resigned = resign(delta, files=[dict(f) for f in delta['files']])
    moved = json.loads(json.dumps(delta))
    moved['parent'] = sha('elsewhere')
    binding = [('parent', moved)]
    if resigned['files']:
        # Only a manifest with at least one entry can carry a mode edit.
        resigned['files'][0]['mode'] = (resigned['files'][0]['mode'] + 1) % 0o1000
        binding.insert(0, ('mode', resigned))
    for label, mutant in binding:
        _, error = call({'operation': 'audit', 'snapshot': mutant},
                        expect_error=True, label='binding-' + label)
        check(f'{tag} binding/{label}', 'checksum' in error, error)

    # Re-signing after re-pointing makes it well formed but unresolvable, which is
    # reported as an issue rather than a parse error.
    repointed, _ = call({'operation': 'audit', 'snapshot': resign(delta, parent=sha('elsewhere'))},
                        label='binding-parent-resigned')
    check(f'{tag} binding/parent-resigned', repointed['valid'] is False
          and 'missing parent snapshot' in {i['reason'] for i in repointed['issues']},
          str(repointed['issues']))

    # --- semantic rejections after a correct re-sign ------------------------
    if delta['files']:
        duplicated = [dict(f) for f in delta['files']] + [dict(delta['files'][0])]
        _, error = call({'operation': 'audit', 'snapshot': resign(delta, files=duplicated)},
                        expect_error=True, label='semantic-duplicate')
        check(tag + ' semantic/duplicate', 'duplicate' in error, error)

        unsafe = [dict(f) for f in delta['files']]
        unsafe[0] = dict(unsafe[0], path='../escape')
        _, error = call({'operation': 'audit', 'snapshot': resign(delta, files=unsafe)},
                        expect_error=True, label='semantic-unsafe')
        check(tag + ' semantic/unsafe', 'unsafe' in error, error)

        wrong_size = [dict(f) for f in delta['files']]
        wrong_size[0] = dict(wrong_size[0], size=wrong_size[0]['size'] + 1)
        report, _ = call({'operation': 'audit', 'snapshot': resign(delta, files=wrong_size),
                          'parents': [base]}, label='semantic-size')
        check(tag + ' semantic/size', report['valid'] is False
              and 'size mismatch' in {i['reason'] for i in report['issues']},
              str(report['issues']))

    # --- selective restore --------------------------------------------------
    changed_paths = {f['path'] for f in changed}
    if not changed_paths:
        return
    prefix = rng.choice(sorted(changed_paths))
    selection, _ = call({'operation': 'restore', 'snapshot': delta, 'parents': [base],
                         'paths': [prefix]}, label='restore-selection')
    expected_paths = {p for p in changed_paths if p == prefix or p.startswith(prefix + '/')}
    check(tag + ' select/paths', {f['path'] for f in selection['files']} == expected_paths,
          f"{sorted(f['path'] for f in selection['files'])} vs {sorted(expected_paths)}")
    check(tag + ' select/counts', selection['selected'] == len(expected_paths)
          and selection['total_files'] == len(changed_paths),
          f"{selection['selected']}/{len(expected_paths)} {selection['total_files']}/{len(changed_paths)}")

    # --- squash -------------------------------------------------------------
    squashed_doc, _ = call({'operation': 'squash', 'snapshot': delta, 'parents': [base]},
                          label='squash')
    squashed = squashed_doc['snapshot']
    check(tag + ' squash/parent', squashed.get('parent') is None)
    check(tag + ' squash/checksum', manifest_checksum(squashed) == squashed['checksum'])
    check(tag + ' squash/objects', set(squashed['objects']) == reachable,
          f"{sorted(set(squashed['objects']) ^ reachable)}")
    check(tag + ' squash/files', canonical(squashed['files']) == canonical(delta['files']))
    squashed_restore, _ = call({'operation': 'restore', 'snapshot': squashed},
                              label='restore-squashed')
    squashed_bytes = {f['path']: base64.b64decode(f['bytes']) for f in squashed_restore['files']}
    delta_restore, _ = call({'operation': 'restore', 'snapshot': delta, 'parents': [base]},
                            label='restore-delta')
    delta_bytes = {f['path']: base64.b64decode(f['bytes']) for f in delta_restore['files']}
    check(tag + ' squash/restore', squashed_bytes == delta_bytes)

    # --- retention ----------------------------------------------------------
    keep = rng.choice([['base'], ['delta'], ['base', 'delta']])
    plan, _ = call({'operation': 'retention', 'keep': keep, 'snapshots': [
        {'id': 'base', 'snapshot': base},
        {'id': 'delta', 'snapshot': delta, 'parents': [base]},
    ]})
    if not keep:
        check(tag + ' retention/empty', False, 'random choice produced no ids')
    # Reachability comes from the kept snapshots only; dropped ones contribute
    # nothing, and every object either snapshot stores is a collection candidate.
    by_id = {'base': base, 'delta': delta}
    reachable = set()
    for snapshot_id in keep:
        reachable |= {f['digest'] for f in by_id[snapshot_id]['files']}
    supplied = set(base['objects']) | set(delta['objects'])
    check(tag + ' retention/reachable', set(plan['reachable_objects']) == reachable,
          f"{sorted(set(plan['reachable_objects']) ^ reachable)}")
    check(tag + ' retention/collectible',
          set(plan['collectible_objects']) == supplied - reachable,
          f"{sorted(set(plan['collectible_objects']) ^ (supplied - reachable))}")
    live = sum(len(resolve(walk(delta, [base]), d)) for d in reachable)
    check(tag + ' retention/live', plan['live_bytes'] == live,
          f"{plan['live_bytes']} vs {live}")
    collectible = sum(len(payload_of(base, d)) for d in supplied - reachable
                      if d in base['objects'])
    collectible += sum(len(payload_of(delta, d)) for d in supplied - reachable
                       if d in delta['objects'])
    check(tag + ' retention/collectible-bytes', plan['collectible_bytes'] == collectible,
          f"{plan['collectible_bytes']} vs {collectible}")
    check(tag + ' retention/drop',
          sorted(plan['drop_snapshots']) == sorted({'base', 'delta'} - set(keep)),
          str(plan['drop_snapshots']))


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    seed = 0
    if '--seed' in sys.argv:
        seed = int(sys.argv[sys.argv.index('--seed') + 1])
        args = [a for a in args if a != str(seed)] if str(seed) in args else args
    iterations = int(args[0]) if args else 25
    for index in range(iterations):
        rng = random.Random(seed * 100000 + index)
        try:
            run_iteration(rng, index)
        except AssertionError as err:
            failures.append(f'iteration {index}: {err}')
    if failures:
        print(f'Fuzz: {len(failures)} failure(s) over {iterations} iterations (seed {seed})')
        for failure in failures[:40]:
            print('  ' + failure)
        sys.exit(1)
    print(f'Fuzz: {iterations} seeded iterations agree with the oracle '
          f'(create, delta, audit, mutations, restore, selection, squash, retention), seed {seed}')


if __name__ == '__main__':
    main()
