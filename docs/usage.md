# Request and result guide

Every example below is an executable fixture. Assertions cover the listed result fields; additional output fields are documented by the API and other fixtures. Error cases intentionally reject the request.

## SHA256 known vector

```json
{
  "files": [
    {
      "path": "hello.txt",
      "text": "abc"
    }
  ]
}
```

Expected result fields:

```json
{
  "snapshot/files/0/digest": "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  "statistics/total_bytes": 3
}
```

## content deduplication

```json
{
  "files": [
    {
      "path": "a",
      "text": "abc"
    },
    {
      "path": "b",
      "text": "abc"
    }
  ]
}
```

Expected result fields:

```json
{
  "statistics/unique_bytes": 3,
  "statistics/deduplicated_bytes": 3
}
```

## binary zeros

```json
{
  "files": [
    {
      "path": "zero.bin",
      "bytes": [
        0,
        255,
        0
      ]
    }
  ]
}
```

Expected result fields:

```json
{
  "statistics/total_bytes": 3
}
```

## unsafe path ../escape

```json
{
  "files": [
    {
      "path": "../escape",
      "text": "x"
    }
  ]
}
```

Expected: nonzero exit with an input error.

## unsafe path CON.txt

```json
{
  "files": [
    {
      "path": "CON.txt",
      "text": "x"
    }
  ]
}
```

Expected: nonzero exit with an input error.

## unsafe path a//b

```json
{
  "files": [
    {
      "path": "a//b",
      "text": "x"
    }
  ]
}
```

Expected: nonzero exit with an input error.

## unsafe path C:/x

```json
{
  "files": [
    {
      "path": "C:/x",
      "text": "x"
    }
  ]
}
```

Expected: nonzero exit with an input error.

## unsafe path a/../b

```json
{
  "files": [
    {
      "path": "a/../b",
      "text": "x"
    }
  ]
}
```

Expected: nonzero exit with an input error.

## case collision

```json
{
  "files": [
    {
      "path": "A",
      "text": "x"
    },
    {
      "path": "a",
      "text": "y"
    }
  ]
}
```

Expected: nonzero exit with an input error.

## Host adapter

```sh
node scripts/filesystem.mjs backup SOURCE_DIR NEW_SNAPSHOT.json [PREVIOUS.json]
node scripts/filesystem.mjs restore SNAPSHOT.json NEW_DIRECTORY
```

Read the current boundaries before using this adapter.
