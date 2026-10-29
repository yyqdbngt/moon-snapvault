///|
/// SHA-256 over whole blocks.
///
/// The published `gmlewis/sha256` package exposes only a byte-at-a-time
/// `HashFunc::write`, which costs a trait call and a bounds check per byte and
/// allocates a 64-word schedule for every 64-byte block. Hashing dominated every
/// operation in this project, so the compression function is implemented here
/// over a reusable schedule. `sha256_crosscheck_wbtest.mbt` compares this
/// implementation against that package on random inputs of every length class,
/// and the fixtures pin the FIPS 180-4 vectors.
let sha256_k : FixedArray[UInt32] = [
  0x428a2f98U, 0x71374491U, 0xb5c0fbcfU, 0xe9b5dba5U, 0x3956c25bU, 0x59f111f1U, 0x923f82a4U,
  0xab1c5ed5U, 0xd807aa98U, 0x12835b01U, 0x243185beU, 0x550c7dc3U, 0x72be5d74U, 0x80deb1feU,
  0x9bdc06a7U, 0xc19bf174U, 0xe49b69c1U, 0xefbe4786U, 0x0fc19dc6U, 0x240ca1ccU, 0x2de92c6fU,
  0x4a7484aaU, 0x5cb0a9dcU, 0x76f988daU, 0x983e5152U, 0xa831c66dU, 0xb00327c8U, 0xbf597fc7U,
  0xc6e00bf3U, 0xd5a79147U, 0x06ca6351U, 0x14292967U, 0x27b70a85U, 0x2e1b2138U, 0x4d2c6dfcU,
  0x53380d13U, 0x650a7354U, 0x766a0abbU, 0x81c2c92eU, 0x92722c85U, 0xa2bfe8a1U, 0xa81a664bU,
  0xc24b8b70U, 0xc76c51a3U, 0xd192e819U, 0xd6990624U, 0xf40e3585U, 0x106aa070U, 0x19a4c116U,
  0x1e376c08U, 0x2748774cU, 0x34b0bcb5U, 0x391c0cb3U, 0x4ed8aa4aU, 0x5b9cca4fU, 0x682e6ff3U,
  0x748f82eeU, 0x78a5636fU, 0x84c87814U, 0x8cc70208U, 0x90befffaU, 0xa4506cebU, 0xbef9a3f7U,
  0xc67178f2U,
]

///|
let sha256_init : FixedArray[UInt32] = [
  0x6a09e667U, 0xbb67ae85U, 0x3c6ef372U, 0xa54ff53aU, 0x510e527fU, 0x9b05688cU, 0x1f83d9abU,
  0x5be0cd19U,
]

///|
let sha256_digits : FixedArray[String] = [
  "0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "a", "b", "c", "d", "e", "f",
]

///|
fn sha256_rotr(value : UInt32, count : Int32) -> UInt32 {
  (value >> count) | (value << (32 - count))
}

///|
fn sha256_compress(state : FixedArray[UInt32], w : FixedArray[UInt32]) -> Unit {
  for i = 16; i < 64; i = i + 1 {
    let high = w[i - 2]
    let low = w[i - 15]
    let s1 = sha256_rotr(high, 17) ^ sha256_rotr(high, 19) ^ (high >> 10)
    let s0 = sha256_rotr(low, 7) ^ sha256_rotr(low, 18) ^ (low >> 3)
    w[i] = w[i - 16] + s0 + w[i - 7] + s1
  }
  let mut a = state[0]
  let mut b = state[1]
  let mut c = state[2]
  let mut d = state[3]
  let mut e = state[4]
  let mut f = state[5]
  let mut g = state[6]
  let mut h = state[7]
  for i = 0; i < 64; i = i + 1 {
    let s1 = sha256_rotr(e, 6) ^ sha256_rotr(e, 11) ^ sha256_rotr(e, 25)
    let choose = (e & f) ^ (e.lnot() & g)
    let t1 = h + s1 + choose + sha256_k[i] + w[i]
    let s0 = sha256_rotr(a, 2) ^ sha256_rotr(a, 13) ^ sha256_rotr(a, 22)
    let majority = (a & b) ^ (a & c) ^ (b & c)
    let t2 = s0 + majority
    h = g
    g = f
    f = e
    e = d + t1
    d = c
    c = b
    b = a
    a = t1 + t2
  }
  state[0] = state[0] + a
  state[1] = state[1] + b
  state[2] = state[2] + c
  state[3] = state[3] + d
  state[4] = state[4] + e
  state[5] = state[5] + f
  state[6] = state[6] + g
  state[7] = state[7] + h
}

///|
fn sha256_absorb(
  state : FixedArray[UInt32],
  w : FixedArray[UInt32],
  bytes : Bytes,
  offset : Int32,
) -> Unit {
  for i = 0; i < 16; i = i + 1 {
    let j = offset + i * 4
    w[i] = (bytes[j].to_int().reinterpret_as_uint() << 24) |
      (bytes[j + 1].to_int().reinterpret_as_uint() << 16) |
      (bytes[j + 2].to_int().reinterpret_as_uint() << 8) |
      bytes[j + 3].to_int().reinterpret_as_uint()
  }
  sha256_compress(state, w)
}

///|
/// Returns the lowercase hex SHA-256 of `bytes`.

///|
/// The 32 raw digest bytes. HMAC needs the raw output: hashing the hex text
/// would compute a different, incorrect construction.
pub fn digest_raw(bytes : Bytes) -> Bytes {
  let state = sha256_init.copy()
  let w = FixedArray::make(64, 0U)
  let length = bytes.length()
  let blocks = length / 64
  for i = 0; i < blocks; i = i + 1 {
    sha256_absorb(state, w, bytes, i * 64)
  }
  let remainder = length - blocks * 64
  // One or two trailing blocks: 0x80, zero padding, then the bit length.
  let tail_length = if remainder < 56 { 64 } else { 128 }
  let tail : FixedArray[Byte] = FixedArray::make(tail_length, b'\x00')
  for i = 0; i < remainder; i = i + 1 {
    tail[i] = bytes[blocks * 64 + i]
  }
  tail[remainder] = b'\x80'
  let bits = length.to_uint64() * 8UL
  for i = 0; i < 8; i = i + 1 {
    tail[tail_length - 8 + i] = ((bits >> ((7 - i) * 8)) & 0xFFUL)
      .to_int()
      .to_byte()
  }
  let padded = Bytes::from_array(tail[:])
  sha256_absorb(state, w, padded, 0)
  if tail_length == 128 {
    sha256_absorb(state, w, padded, 64)
  }
  let out : FixedArray[Byte] = FixedArray::make(32, b'\x00')
  for i in 0..<8 {
    let word = state[i]
    for step = 0; step < 4; step = step + 1 {
      out[i * 4 + step] = ((word >> (24 - step * 8)) & 0xFFU)
        .reinterpret_as_int()
        .to_byte()
    }
  }
  Bytes::from_array(out)
}

///|
pub fn digest(bytes : Bytes) -> String {
  let raw = digest_raw(bytes)
  let mut out = ""
  for i in 0..<32 {
    out += sha256_digits[raw[i].to_int() >> 4]
    out += sha256_digits[raw[i].to_int() & 0xF]
  }
  out
}
