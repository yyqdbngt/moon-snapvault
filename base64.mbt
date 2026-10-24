///|
/// RFC 4648 base64 over preallocated buffers.
///
/// `moonbitlang/core/encoding/base64` walks the input by slicing a view per
/// three-byte group and appends through `StringBuilder`, which costs 1665 ms for
/// 8 MiB on the JS backend. Snapshots are dominated by base64 at that size, so
/// encoding and decoding are done here over index arithmetic.
/// `base64_crosscheck_wbtest.mbt` compares both directions against that package.
let base64_alphabet : FixedArray[Byte] = {
  let codes = FixedArray::make(64, b'A')
  let letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".to_array()
  for i = 0; i < 64; i = i + 1 {
    codes[i] = letters[i].to_int().to_byte()
  }
  codes
}

///|
/// Reverse table: 0..63 for alphabet bytes, -1 for anything else.
let base64_reverse : FixedArray[Int32] = {
  let values = FixedArray::make(256, -1)
  for i = 0; i < 64; i = i + 1 {
    values[base64_alphabet[i].to_int()] = i
  }
  values
}

///|
fn base64_encode(bytes : Bytes) -> String {
  let length = bytes.length()
  let groups = length / 3
  let remainder = length - groups * 3
  let encoded_length = groups * 4 + (if remainder == 0 { 0 } else { 4 })
  let out : FixedArray[Byte] = FixedArray::make(encoded_length, b'=')
  let mut source = 0
  let mut target = 0
  for group = 0; group < groups; group = group + 1 {
    let triple = (bytes[source].to_int() << 16) |
      (bytes[source + 1].to_int() << 8) |
      bytes[source + 2].to_int()
    out[target] = base64_alphabet[(triple >> 18) & 0x3F]
    out[target + 1] = base64_alphabet[(triple >> 12) & 0x3F]
    out[target + 2] = base64_alphabet[(triple >> 6) & 0x3F]
    out[target + 3] = base64_alphabet[triple & 0x3F]
    source += 3
    target += 4
  }
  if remainder == 1 {
    let first = bytes[source].to_int()
    out[target] = base64_alphabet[(first >> 2) & 0x3F]
    out[target + 1] = base64_alphabet[(first << 4) & 0x3F]
  } else if remainder == 2 {
    let first = bytes[source].to_int()
    let second = bytes[source + 1].to_int()
    out[target] = base64_alphabet[(first >> 2) & 0x3F]
    out[target + 1] = base64_alphabet[((first << 4) | (second >> 4)) & 0x3F]
    out[target + 2] = base64_alphabet[(second << 2) & 0x3F]
  }
  // Base64 output is ASCII, so the bytes are already valid UTF-8. Filling a
  // byte array and decoding once is about twice as fast as appending chars.
  @utf8.decode_lossy(Bytes::from_array(out[:])[:])
}

///|
/// Decodes strict RFC 4648 base64; `None` for any malformed input, including
/// non-zero trailing bits and padding in the middle.
fn base64_decode(text : String) -> Bytes? {
  let length = text.length()
  if length == 0 {
    let empty : Bytes = Default::default()
    return Some(empty)
  }
  let mut padding = 0
  if text[length - 1].to_int() == 61 {
    padding = 1
    if length >= 2 && text[length - 2].to_int() == 61 {
      padding = 2
    }
  }
  let data = length - padding
  if padding > 0 && length % 4 != 0 {
    return None
  }
  let rem = data - data / 4 * 4
  if rem == 1 {
    return None
  }
  let decoded_length = data / 4 * 3 + (if rem == 0 { 0 } else { rem - 1 })
  let out : FixedArray[Byte] = FixedArray::make(decoded_length, b'\x00')
  let mut accumulator = 0
  let mut bits = 0
  let mut written = 0
  for i = 0; i < data; i = i + 1 {
    let code = text[i].to_int()
    if code > 255 {
      return None
    }
    let value = base64_reverse[code]
    if value < 0 {
      return None
    }
    accumulator = ((accumulator << 6) | value) & 0xFFFFFF
    bits += 6
    if bits >= 8 {
      bits -= 8
      out[written] = ((accumulator >> bits) & 0xFF).to_byte()
      written += 1
    }
  }
  if written != decoded_length {
    return None
  }
  // Canonical form requires the unused trailing bits to be zero.
  if bits > 0 && (accumulator & ((1 << bits) - 1)) != 0 {
    return None
  }
  for i = data; i < length; i = i + 1 {
    if text[i].to_int() != 61 {
      return None
    }
  }
  Some(Bytes::from_array(out[:]))
}
