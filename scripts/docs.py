"""Checks the documentation against itself and against the source.

    python3 -B scripts/docs.py

Three kinds of claim live in the markdown and all three can go stale without anything
noticing:

  - internal links. A file renamed once leaves a dead link that only a reader finds.
  - anchors. `README.md` links to a heading in `CHANGELOG.md`; if the heading is edited
    the link still looks fine and lands at the top of the page.
  - counts. The README states how many test declarations and fixtures exist. Those were
    updated by hand through several releases and had already drifted: the README said 87
    while `PROJECT_STATS.md` said 93, because only the latter was machine-checked.

The counts are recomputed from the source with the same rules `scripts/stats.mjs` uses,
and both documents must agree with the source and with each other. Anything the checker
cannot verify is left alone rather than guessed at: prose about performance varies by
machine, so numbers like that are not treated as claims.
"""
import json
import re
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
problems = []

# --- collect the documents ---------------------------------------------------
docs = [root / 'README.md', root / 'PROJECT_STATS.md', root / 'CHANGELOG.md',
        root / 'THIRD_PARTY.md', root / 'LICENSE.md']
docs += sorted((root / 'docs').glob('*.md'))
docs += sorted((root / 'examples').glob('*.md'))
docs = [doc for doc in docs if doc.exists()]

if not docs:
    sys.exit('docs: no markdown found')


def slug(heading):
    """The anchor GitHub generates for a heading, near enough for our own headings."""
    text = heading.strip().lower()
    text = re.sub(r'[`*_]', '', text)
    text = re.sub(r'[^\w\s-]', '', text)
    return re.sub(r'\s+', '-', text)


def headings(path):
    found = set()
    in_code = False
    for line in path.read_text(encoding='utf-8').split('\n'):
        if line.startswith('```'):
            in_code = not in_code
            continue
        if in_code:
            continue
        match = re.match(r'^#{1,6}\s+(.*)$', line)
        if match:
            found.add(slug(match.group(1)))
    return found


# --- links and anchors -------------------------------------------------------
link_pattern = re.compile(r'\[[^\]]*\]\(([^)]+)\)')
for document in docs:
    for target in link_pattern.findall(document.read_text(encoding='utf-8')):
        if target.startswith(('http://', 'https://', 'mailto:')):
            continue
        path_part, _, anchor = target.partition('#')
        if path_part:
            resolved = (document.parent / path_part).resolve()
            if not resolved.exists():
                problems.append(f'{document.relative_to(root)}: link to {path_part} does not resolve')
                continue
        else:
            resolved = document
        if anchor:
            if not resolved.suffix == '.md':
                problems.append(f'{document.relative_to(root)}: anchor on a non-markdown file: {target}')
                continue
            available = headings(resolved)
            if anchor not in available:
                problems.append(f'{document.relative_to(root)}: {resolved.name} has no heading '
                                f'#{anchor}')

# --- counts ------------------------------------------------------------------
# Mirrors scripts/stats.mjs: test declarations are `test "..."` at the start of a line,
# fixtures are the entries in tests/cases.json.
tests = 0
for path in sorted(root.glob('*_wbtest.mbt')):
    tests += len(re.findall(r'^test "', path.read_text(encoding='utf-8'), re.M))
fixtures = len(json.loads((root / 'tests/cases.json').read_text(encoding='utf-8')))
examples = len([p for p in (root / 'examples').glob('*.json')])

expected = {'tests': tests, 'fixtures': fixtures, 'examples': examples}

readme = (root / 'README.md').read_text(encoding='utf-8')
match = re.search(r'There are (\d+) MoonBit test declarations and (\d+) checked fixture cases',
                  readme)
if not match:
    problems.append('README.md: the sentence stating test and fixture counts is gone')
else:
    stated_tests, stated_fixtures = int(match.group(1)), int(match.group(2))
    if stated_tests != tests:
        problems.append(f'README.md says {stated_tests} test declarations, source has {tests}')
    if stated_fixtures != fixtures:
        problems.append(f'README.md says {stated_fixtures} fixture cases, source has {fixtures}')

stats = (root / 'PROJECT_STATS.md').read_text(encoding='utf-8')


def stat_row(label):
    found = re.search(r'^\| ' + re.escape(label) + r' \| (\d+) \|', stats, re.M)
    return int(found.group(1)) if found else None


for label, key in [('MoonBit test declarations', 'tests'),
                   ('CLI fixture cases', 'fixtures')]:
    value = stat_row(label)
    if value is None:
        problems.append(f'PROJECT_STATS.md: no row for {label}')
    elif value != expected[key]:
        problems.append(f'PROJECT_STATS.md says {value} for {label}, source has {expected[key]}')
    elif match:
        # The two documents must agree with each other as well, not only with the source.
        other = int(match.group(1 if key == 'tests' else 2))
        if value != other:
            problems.append(f'README.md and PROJECT_STATS.md disagree on {label}: '
                            f'{other} vs {value}')

# --- every shipped script is mentioned somewhere -----------------------------
# A script nobody documents is a script nobody runs.
all_text = '\n'.join(doc.read_text(encoding='utf-8') for doc in docs)
for path in sorted(list((root / 'scripts').glob('*.mjs')) + list((root / 'scripts').glob('*.py'))):
    if path.name not in all_text:
        problems.append(f'scripts/{path.name} is not mentioned in any document')

if problems:
    print(f'Docs: {len(problems)} problem(s) across {len(docs)} documents')
    for problem in problems:
        print('  ' + problem)
    sys.exit(1)
print(f'Docs: {len(docs)} documents, links and anchors resolve, counts match the source '
      f'({tests} tests, {fixtures} fixtures, {examples} examples)')
