// A small deterministic PRNG, seeded from a string.
//
// Determinism is a product requirement here, not a convenience. A named seed has to
// reproduce a tiling exactly, in Node and in the browser, today and next year, because
// that is what makes an output shareable and what makes the tests meaningful. So this
// uses an explicit algorithm with 32 bit arithmetic rather than Math.random, and never
// touches Date, crypto, or any other ambient source.
//
// cyrb128 spreads a string into four 32 bit words; sfc32 is the generator. Both are
// public domain constructions widely used for exactly this purpose.

export function cyrb128(str) {
  let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  return [(h1 ^ h2 ^ h3 ^ h4) >>> 0, (h2 ^ h1) >>> 0, (h3 ^ h1) >>> 0, (h4 ^ h1) >>> 0];
}

export function makeRng(seed) {
  const [a0, b0, c0, d0] = cyrb128(String(seed));
  let a = a0, b = b0, c = c0, d = d0;

  // sfc32. Returns a float in [0, 1).
  function next() {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  }

  // Rejection sampling rather than a modulo, so every value of n is uniform. A modulo
  // biases the low outcomes, which for a 3 colour tile set is visible in the output.
  function int(n) {
    if (n <= 0) throw new Error(`int(${n}) needs a positive bound`);
    const limit = Math.floor(4294967296 / n) * n;
    for (;;) {
      const raw = Math.floor(next() * 4294967296);
      if (raw < limit) return raw % n;
    }
  }

  return {
    next,
    int,
    pick(items) { return items[int(items.length)]; },
    shuffle(items) {
      const out = items.slice();
      for (let i = out.length - 1; i > 0; i--) {
        const j = int(i + 1);
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    },
  };
}
