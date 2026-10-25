"""Randomized histories: many operations in sequence, each answer predicted independently.

    python3 -B scripts/history.py [histories] [--seed N] [--steps N]

`fuzz.py` runs one request at a time. Real use is a sequence: back up, change the tree, back up
again, fold the chain when it gets long, keep going. A defect that only appears on the eleventh
operation, or only after a fold, is invisible to a suite that resets between cases - the fixed
five-step history in `integration.mjs` was written because of that, and it found two defects the
first time it ran.

A fixed history is still one path. This walks many: each is a random sequence of edits with random
folds, and every snapshot it produces is checked against the oracle in `fuzz.py` rather than
against a recorded answer. The two questions a history can get wrong that a single operation
cannot:

  * the tree at each step - restore the tip and every earlier link, compare with the oracle's
    reconstruction, including after the chain has been folded and extended again
  * the size of each delta - a snapshot that reports a parent but stores the whole tree is
    still correct to restore and no longer incremental

Folds are modelled the way the core does them: the folded snapshot is self-contained, so it starts
a new chain, and the links it folded away remain readable through their own chain. The oracle
reconstructs both.

Failures print the seed and the step, so a failure is reproducible: `--seed N --steps M`.
"""
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
# The oracle lives with the per-request fuzz test, and reusing it is the point: an independent
# reimplementation written twice would drift, and two copies of one mistake agree with each other.
import fuzz  # noqa: E402


WORDS = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta']


def random_content(rng, step):
    """A file body that changes on every write, so a stale payload would be visible."""
    kind = rng.choice(['text', 'binary', 'empty'])
    if kind == 'empty':
        return b''
    if kind == 'binary':
        return bytes([step % 256, rng.randrange(256), 0, 255, rng.randrange(256)])
    return ('revision %d %s' % (step, rng.choice(WORDS))).encode('utf-8')


def apply_edit(tree, rng, step):
    """One random change to the tree: add, modify, remove, or rename."""
    choice = rng.choices(['add', 'modify', 'remove', 'rename'], weights=[4, 4, 2, 1])[0]
    if choice == 'add' or not tree:
        depth = rng.choice([0, 0, 1])
        name = 'file-%d-%s.txt' % (step, rng.choice(WORDS))
        path = ('dir-%d/' % rng.randrange(2) if depth else '') + name
        tree[path] = random_content(rng, step)
        return 'add ' + path
    target = rng.choice(sorted(tree))
    if choice == 'modify':
        tree[target] = random_content(rng, step)
        return 'modify ' + target
    if choice == 'remove':
        del tree[target]
        return 'remove ' + target
    replacement = target.rsplit('/', 1)
    new_path = (replacement[0] + '/' if len(replacement) == 2 else '') \
        + 'renamed-%d-%s.txt' % (step, rng.choice(WORDS))
    if new_path in tree:
        tree[target] = random_content(rng, step)
        return 'modify ' + target
    tree[new_path] = tree.pop(target)
    return 'rename %s -> %s' % (target, new_path)


def files_request(tree, mode=0o644):
    """The `files` array the core expects, in a fixed order so the checksum is predictable."""
    files = []
    for path in sorted(tree):
        payload = tree[path]
        files.append({
            'path': path,
            'content_base64': fuzz.base64.b64encode(payload).decode('ascii'),
            'mode': mode,
        })
    return files


def manifest_of(snapshot):
    """The five manifest fields, which is what a later request may send as a parent."""
    # A format 1 or 2 snapshot has no `parent` key at all, and the canonical form of a format 3
    # one always has it - so `parent: null` is the same manifest as no key, which is what the core
    # asserts elsewhere. Using `.get` keeps the oracle from caring which spelling it received.
    return {
        'version': snapshot['version'],
        'parent': snapshot.get('parent'),
        'files': snapshot['files'],
        'objects': snapshot['objects'],
        'checksum': snapshot['checksum'],
    }


def oracle_tree(snapshot, parents):
    """The tree the oracle says a snapshot describes: every file resolved through its chain."""
    chain = fuzz.walk(snapshot, parents)
    tree = {}
    for file in snapshot['files']:
        payload = fuzz.resolve(chain, file['digest'])
        if payload is None:
            return None
        if len(payload) != file['size']:
            raise AssertionError('payload length does not match the recorded size')
        tree[file['path']] = payload
    return tree


def run_history(rng, index, steps):
    """One random history. Raises AssertionError with the step number that diverged."""
    tree = {}
    # `chain` holds the manifests still reachable as a delta parent, newest last.
    chain = []
    history = []       # (snapshot, parents-at-the-time, oracle tree) for every snapshot made
    folded_away = []   # manifests a fold replaced, still readable through their own chain

    step = 0
    fold_at = rng.choice([3, 4, 5, 99])  # 99 means this history never folds
    while step < steps:
        step += 1
        action = apply_edit(tree, rng, step)

        if chain and step == fold_at:
            # Fold the whole chain into one self-contained snapshot, the way a user compacts.
            tip, parents = history[-1][0], history[-1][1]
            folded, error = fuzz.call(
                {'operation': 'squash', 'snapshot': manifest_of(tip),
                 'parents': [manifest_of(p) for p in parents]},
                label='squash in history step %d' % step)
            if error:
                raise AssertionError('step %d: squash refused: %s' % (step, error))
            snapshot = folded['snapshot']
            if snapshot['parent'] is not None:
                raise AssertionError('step %d: a folded snapshot still has a parent' % step)
            # The folded tree must be the tree the tip described, reconstructed independently.
            # Not the working tree: the edit for this step has already been applied to `tree`, and
            # the tip has not seen it yet - a first version compared against the edited tree and
            # reported a fold that had "changed" a file the snapshot never held.
            expected = oracle_tree(snapshot, [])
            if expected != history[-1][2]:
                raise AssertionError('step %d: fold changed the tree it folded' % step)
            # What it folded stays readable through its own chain, which is the property that
            # makes folding an addition rather than a replacement.
            folded_away.extend(chain)
            chain = []
            history.append((snapshot, [], expected))
            # A folded snapshot is itself a valid parent for the next backup.
            chain = [snapshot]
            continue

        parents = list(chain)
        request = {'operation': 'create', 'files': files_request(tree)}
        if parents:
            request['format'] = 3
            request['previous'] = manifest_of(parents[-1])
            request['parents'] = [manifest_of(p) for p in parents[:-1]]
        created, error = fuzz.call(request, label='create in history step %d' % step)
        if error:
            raise AssertionError('step %d: create refused after %s: %s' % (step, action, error))
        snapshot = created['snapshot']

        # The oracle's reconstruction must equal the tree, and the core's own restore must too.
        expected = oracle_tree(snapshot, parents)
        if expected != tree:
            raise AssertionError('step %d: the snapshot describes a different tree (%s)'
                                 % (step, action))

        # A delta may only store objects the chain does not already hold. A snapshot that reports
        # a parent but stores everything restores correctly and is no longer incremental, which no
        # single-operation check can notice.
        if parents:
            held = set()
            for link in fuzz.walk(snapshot, parents):
                if link is snapshot:
                    continue
                held.update(link['objects'])
            reused = held & set(snapshot['objects'])
            if reused:
                raise AssertionError('step %d: a delta re-stored %d object(s) its chain already '
                                     'holds' % (step, len(reused)))

        history.append((snapshot, parents, expected))
        chain.append(snapshot)

    # Every snapshot in the history still restores - including the ones whose chain was folded
    # away, because their own links remain on disk.
    for index_of, (snapshot, parents, expected) in enumerate(history):
        restored, error = fuzz.call(
            {'operation': 'restore', 'snapshot': manifest_of(snapshot),
             'parents': [manifest_of(p) for p in parents]},
            label='restore of history snapshot %d' % index_of)
        if error:
            raise AssertionError('snapshot %d stopped restoring after the history went on: %s'
                                 % (index_of, error))
        got = {}
        for file in restored['files']:
            raw = file['bytes']
            got[file['path']] = (fuzz.base64.b64decode(raw) if restored['encoding'] == 'base64'
                                 else bytes(raw))
        if got != expected:
            raise AssertionError('snapshot %d restored a different tree' % index_of)

    # And the tip, which is what a user checks most often.
    if history:
        snapshot, parents, expected = history[-1]
        verdict, reasons = fuzz.evaluate(snapshot, parents)
        if verdict is not True:
            raise AssertionError('the final snapshot does not audit as valid: %s' % sorted(reasons))
    return len(history)


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    seed = 1
    if '--seed' in sys.argv:
        seed = int(sys.argv[sys.argv.index('--seed') + 1])
        args = [a for a in args if a != str(seed)]
    steps = 8
    if '--steps' in sys.argv:
        steps = int(sys.argv[sys.argv.index('--steps') + 1])
        args = [a for a in args if a != str(steps)]
    histories = int(args[0]) if args else 6

    total = 0
    failures = []
    for index in range(histories):
        rng = random.Random(seed * 100003 + index)
        try:
            total += run_history(rng, index, steps)
        except AssertionError as err:
            failures.append('history %d: %s' % (index, err))

    if failures:
        print('History: %d failure(s) over %d histories (seed %d, %d steps)'
              % (len(failures), histories, seed, steps))
        for failure in failures[:20]:
            print('  ' + failure)
        sys.exit(1)
    print('History: %d randomized histories, %d snapshots, every tree, delta and restore '
          'agrees with the oracle (seed %d)' % (histories, total, seed))


if __name__ == '__main__':
    main()
