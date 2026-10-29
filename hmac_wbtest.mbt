///|
/// RFC 4231 test vectors, computed from the RFC rather than from this code.
/// The byte arrays are spelled out so the test does not depend on an encoder
/// that could share a defect with the code under test.
fn hmac_bytes(items : Array[Int32]) -> Bytes {
  let out : FixedArray[Byte] = FixedArray::make(items.length(), b'\x00')
  for i, item in items {
    out[i] = item.to_byte()
  }
  Bytes::from_array(out)
}

///|
fn text_bytes(text : String) -> Bytes {
  @utf8.encode(text)
}

///|
test "RFC 4231 test case 1" {
  let key = hmac_bytes(Array::make(20, 11))
  let data = text_bytes("Hi There")
  assert_eq(
    hmac_sha256(key, data),
    "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7",
  )
}

///|
test "RFC 4231 test case 2" {
  let key = text_bytes("Jefe")
  let data = text_bytes("what do ya want for nothing?")
  assert_eq(
    hmac_sha256(key, data),
    "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
  )
}

///|
test "RFC 4231 test case 6 condenses an oversized key" {
  let key = hmac_bytes(Array::make(131, 170))
  let data = text_bytes(
    "Test Using Larger Than Block-Size Key - Hash Key First",
  )
  assert_eq(
    hmac_sha256(key, data),
    "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54",
  )
}

///|
test "RFC 4231 test case 7 combines both edge cases" {
  let key = hmac_bytes(Array::make(131, 170))
  let data = text_bytes(
    "This is a test using a larger than block-size key and a larger than block-size data. The key needs to be hashed before being used by the HMAC algorithm.",
  )
  assert_eq(
    hmac_sha256(key, data),
    "9b09ffa71b942fcb27635fbcd5b0e944bfdc63644f0713938a7f51535c3a35e2",
  )
}
