# Examples

One request per file. Every one is executed by `scripts/examples.mjs`, and its answer
is pinned in `expected/`, so an example cannot silently stop being true. Run them with
the CLI:

```sh
node _build/js/release/build/cmd/main/main.js examples/scenario-1.json
```

| File | What it shows |
|---|---|
| `scenario-1.json` | the smallest snapshot: one text file |
| `scenario-2.json` | deduplication: two paths, one payload |
| `scenario-3.json` | binary content as decimal bytes |
| `incremental.json` | format 3: a delta that stores only the object its parent lacks, and reports what it reused |
| `audit.json` | the integrity report, including how many objects were checked |
| `restore.json` | the payloads a restore hands back, with `format` and `encoding` |
| `list.json` | the manifest described cheaply - no payload read, no chain walked |
| `diff.json` | added, removed and modified paths between two snapshots |
| `squash.json` | a chain folded into one self-contained snapshot |
| `retention.json` | keeping a delta promotes its parent to `required_snapshots`, because the delta cannot be read without it |
| `locate.json` | which link stores a payload, from manifests alone |
| `extract.json` | the verified payloads of one link |
| `unsafe-path.error.json` | a refused request: one JSON error object, exit 1 |
| `followup-20261018.json` | a retention plan over an empty set: every list is empty |

`scenario-*` are the originals and stay for continuity; they are still the shortest
possible demonstration of `create`. The rest were added because the package shipped
eleven operations and documented three of them by example.

The `expected/` files are generated - `node scripts/examples.mjs --write` - and should
not be edited by hand. They are worth reading: each one is the exact answer a user
gets, which is more useful than a walkthrough claiming an output nobody ran.

An example whose name ends in `.error.json` must fail; its expected file records the
message, so the failure mode is both documented and tested.

The deltas and squashes here carry their parent inline rather than referencing a file,
so each example is a single self-contained request. Real chains name the parent by
checksum and pass it alongside; see [incremental snapshots](../docs/incremental.md).
