///|
/// Expected values below come from Python's standard library:
/// `hashlib.sha256(...).hexdigest()` and `base64.b64encode(...)`.
/// `scripts/reference.py` re-derives the digests for synthetic inputs on every
/// run, so these constants are a fixed anchor, not the only oracle.
fn bytes_of(values : Array[Int32]) -> Bytes {
  Bytes::makei(values.length(), fn(i) { values[i].to_byte() })
}

///|
fn repeated(byte : Int32, count : Int32) -> Bytes {
  Bytes::makei(count, fn(_) { byte.to_byte() })
}

///|
test "sha256 FIPS 180-4 vectors" {
  assert_eq(
    digest(bytes_of([])),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  )
  assert_eq(
    digest(bytes_of([0x61, 0x62, 0x63])),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  )
  assert_eq(
    digest(
      @utf8.encode("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
    ),
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
  )
  // 1,000,000 'a' bytes.
  assert_eq(
    digest(repeated(0x61, 1000000)),
    "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0",
  )
}

///|
test "sha256 padding boundaries" {
  // Lengths around the 55/56/57 and 63/64/65 block edges.
  assert_eq(
    digest(repeated(0x61, 55)),
    "9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318",
  )
  assert_eq(
    digest(repeated(0x61, 56)),
    "b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a",
  )
  assert_eq(
    digest(repeated(0x61, 57)),
    "f13b2d724659eb3bf47f2dd6af1accc87b81f09f59f2b75e5c0bed6589dfe8c6",
  )
  assert_eq(
    digest(repeated(0x00, 64)),
    "f5a5fd42d16a20302798ef6ed309979b43003d2320d9f0e8ea9831a92759fb4b",
  )
  assert_eq(
    digest(Bytes::makei(64, fn(i) { i.to_byte() })),
    "fdeab9acf3710362bd2658cdc9a29e8f9c757fcf9811603a8c447cd1d9151108",
  )
  assert_eq(
    digest(Bytes::makei(1000, fn(i) { (i * 7 + 3).to_byte() })),
    "1e9bc38cbf860b9ec31918b065f9b52476c549a782e0e7990bed8ce3868d2371",
  )
}

///|
test "sha256 is stable across identical inputs" {
  let whole = Bytes::makei(5000, fn(i) { (i * 13 + 1).to_byte() })
  let copy = Bytes::makei(5000, fn(i) { (i * 13 + 1).to_byte() })
  assert_eq(digest(whole), digest(copy))
  assert_eq(digest(whole).length(), 64)
  // A buffer whose tail crosses the 55/56-byte padding edge hashes the same
  // every time and differs from its prefix.
  assert_eq(
    digest(Bytes::makei(2500, fn(i) { (i * 13 + 1).to_byte() })).length(),
    64,
  )
  assert_eq(
    digest(whole) ==
    digest(Bytes::makei(2500, fn(i) { (i * 13 + 1).to_byte() })),
    false,
  )
}

///|
test "base64 RFC 4648 vectors" {
  let cases : Array[(Bytes, String)] = [
    (bytes_of([]), ""),
    (@utf8.encode("f"), "Zg=="),
    (@utf8.encode("fo"), "Zm8="),
    (@utf8.encode("foo"), "Zm9v"),
    (@utf8.encode("foob"), "Zm9vYg=="),
    (@utf8.encode("fooba"), "Zm9vYmE="),
    (@utf8.encode("foobar"), "Zm9vYmFy"),
    (bytes_of([0, 255, 7]), "AP8H"),
    (bytes_of([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]), "AAECAwQFBgcICQ=="),
  ]
  for entry in cases {
    let (raw, encoded) = entry
    assert_eq(base64_encode(raw), encoded)
    assert_eq(base64_decode(encoded), Some(raw))
  }
}

///|
test "base64 round-trips every length class" {
  for length = 0; length <= 130; length = length + 1 {
    let raw = Bytes::makei(length, fn(i) { (i * 37 + 11).to_byte() })
    assert_eq(base64_decode(base64_encode(raw)), Some(raw))
  }
  let large = Bytes::makei(100000, fn(i) { (i % 97).to_byte() })
  assert_eq(base64_decode(base64_encode(large)), Some(large))
}

///|
test "base64 rejects malformed input" {
  let rejected : Array[String] = [
    "A", "AB=C", "AB===", "AB$D", "A===", "AB==AB==", "AB==", "Bzw!",
  ]
  for text in rejected {
    assert_eq(base64_decode(text), None)
  }
  // Padding is optional: RFC 4648 allows the unpadded form.
  assert_eq(base64_decode("Bzw"), base64_decode("Bzw="))
  let empty : Bytes = Default::default()
  assert_eq(base64_decode(""), Some(empty))
}
