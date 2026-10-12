/** RIPEMD-128 — нужен только для расшифровки индекса MDX (Encrypted=2). */
const RL = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
  7, 4, 13, 1, 10, 6, 15, 3, 12, 0, 9, 5, 2, 14, 11, 8,
  3, 10, 14, 4, 9, 15, 8, 1, 2, 7, 0, 6, 13, 11, 5, 12,
  1, 9, 11, 10, 0, 8, 12, 4, 13, 3, 7, 15, 14, 5, 6, 2,
];
const RR = [
  5, 14, 7, 0, 9, 2, 11, 4, 13, 6, 15, 8, 1, 10, 3, 12,
  6, 11, 3, 7, 0, 13, 5, 10, 14, 15, 8, 12, 4, 9, 1, 2,
  15, 5, 1, 3, 7, 14, 6, 9, 11, 8, 12, 2, 10, 0, 4, 13,
  8, 6, 4, 1, 3, 11, 15, 0, 5, 12, 2, 13, 9, 7, 10, 14,
];
const SL = [
  11, 14, 15, 12, 5, 8, 7, 9, 11, 13, 14, 15, 6, 7, 9, 8,
  7, 6, 8, 13, 11, 9, 7, 15, 7, 12, 15, 9, 11, 7, 13, 12,
  11, 13, 6, 7, 14, 9, 13, 15, 14, 8, 13, 6, 5, 12, 7, 5,
  11, 12, 14, 15, 14, 15, 9, 8, 9, 14, 5, 6, 8, 6, 5, 12,
];
const SR = [
  8, 9, 9, 11, 13, 15, 15, 5, 7, 7, 8, 11, 14, 14, 12, 6,
  9, 13, 15, 7, 12, 8, 9, 11, 7, 7, 12, 7, 6, 15, 13, 11,
  9, 7, 15, 11, 8, 6, 6, 14, 12, 13, 5, 14, 13, 13, 7, 5,
  15, 5, 8, 11, 14, 14, 6, 14, 6, 9, 12, 9, 12, 5, 15, 8,
];
const KL = [0x00000000, 0x5a827999, 0x6ed9eba1, 0x8f1bbcdc];
const KR = [0x50a28be6, 0x5c4dd124, 0x6d703ef3, 0x00000000];

const rol = (x: number, n: number) => (x << n) | (x >>> (32 - n));
function f(round: number, x: number, y: number, z: number): number {
  switch (round) {
    case 0: return x ^ y ^ z;
    case 1: return (x & y) | (~x & z);
    case 2: return (x | ~y) ^ z;
    default: return (x & z) | (y & ~z);
  }
}

export function ripemd128(data: Uint8Array): Uint8Array {
  const n = data.length;
  const padded = new Uint8Array(((n + 8) >> 6 << 6) + 64);
  padded.set(data);
  padded[n] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, (n << 3) >>> 0, true);
  dv.setUint32(padded.length - 4, Math.floor(n / 0x20000000), true);

  let h0 = 0x67452301, h1 = 0xefcdab89 | 0, h2 = 0x98badcfe | 0, h3 = 0x10325476;
  const X = new Int32Array(16);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) X[i] = dv.getInt32(off + i * 4, true);
    let a = h0, b = h1, c = h2, d = h3;
    let a2 = h0, b2 = h1, c2 = h2, d2 = h3;
    for (let j = 0; j < 64; j++) {
      const r = j >> 4;
      let t = rol((a + f(r, b, c, d) + X[RL[j]] + KL[r]) | 0, SL[j]);
      a = d; d = c; c = b; b = t;
      t = rol((a2 + f(3 - r, b2, c2, d2) + X[RR[j]] + KR[r]) | 0, SR[j]);
      a2 = d2; d2 = c2; c2 = b2; b2 = t;
    }
    const t = (h1 + c + d2) | 0;
    h1 = (h2 + d + a2) | 0;
    h2 = (h3 + a + b2) | 0;
    h3 = (h0 + b + c2) | 0;
    h0 = t;
  }
  const out = new Uint8Array(16);
  const ov = new DataView(out.buffer);
  [h0, h1, h2, h3].forEach((h, i) => ov.setInt32(i * 4, h, true));
  return out;
}
