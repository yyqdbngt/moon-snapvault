///|
/// Concatenates two byte strings into one.
fn concat_bytes(left : Bytes, right : Bytes) -> Bytes {
  let merged : FixedArray[Byte] = FixedArray::make(
    left.length() + right.length(),
    b'\x00',
  )
  for i in 0..<left.length() {
    merged[i] = left[i]
  }
  for i in 0..<right.length() {
    merged[left.length() + i] = right[i]
  }
  Bytes::from_array(merged)
}

///|
/// HMAC-SHA256 over a message with a key, both as bytes (RFC 2104). A key
/// longer than the 64-byte block is condensed by hashing first, exactly as the
/// RFC requires; the hex digest is 64 characters, so the condensed key fits one
/// block. HMAC over this module\'s own SHA-256 keeps the dependency count at
/// zero, and the vectors in `hmac_wbtest.mbt` come from RFC 4231 rather than
/// from this implementation.
pub fn hmac_sha256(key : Bytes, message : Bytes) -> String {
  let block : FixedArray[Byte] = FixedArray::make(64, b'\x00')
  if key.length() > 64 {
    // The condensed key is the raw digest, not its hex spelling: the RFC pads
    // the L-byte hash result into the block.
    let condensed = digest_raw(key)
    for i in 0..<32 {
      block[i] = condensed[i]
    }
  } else {
    for i in 0..<key.length() {
      block[i] = key[i]
    }
  }
  let inner_pad : FixedArray[Byte] = FixedArray::make(64, b'\x00')
  let outer_pad : FixedArray[Byte] = FixedArray::make(64, b'\x00')
  for i in 0..<64 {
    inner_pad[i] = (block[i].to_int() ^ 0x36).to_byte()
    outer_pad[i] = (block[i].to_int() ^ 0x5C).to_byte()
  }
  let inner = digest_raw(concat_bytes(Bytes::from_array(inner_pad), message))
  digest(concat_bytes(Bytes::from_array(outer_pad), inner))
}
