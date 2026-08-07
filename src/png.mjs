// A minimal PNG encoder. Node's zlib does the compression; everything else is the file
// format, which is short enough that a dependency would cost more than it saves.
//
// Colour type 2 (truecolour, 8 bits per channel), no interlacing, filter type 0 on every
// row. A pHYs chunk records the physical resolution so a print workflow knows the image is
// 300 dots per inch rather than guessing 72.

import { deflateSync } from 'node:zlib';

const SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, body) {
  const typeBytes = Uint8Array.from([...type].map((ch) => ch.charCodeAt(0)));
  const out = Buffer.alloc(12 + body.length);
  out.writeUInt32BE(body.length, 0);
  out.set(typeBytes, 4);
  out.set(body, 8);
  const check = crc32(Buffer.concat([Buffer.from(typeBytes), Buffer.from(body)]));
  out.writeUInt32BE(check, 8 + body.length);
  return out;
}

/**
 * @param image {{width,height,data}} 8 bit RGB, row major, from `rasterise`
 * @param dpi   dots per inch recorded in pHYs. PNG stores pixels per metre.
 */
export function encodePng(image, { dpi = 72 } = {}) {
  const { width, height, data } = image;
  if (data.length !== width * height * 3) {
    throw new Error(`expected ${width * height * 3} bytes of RGB, got ${data.length}`);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;      // bit depth
  ihdr[9] = 2;      // colour type 2, truecolour
  ihdr[10] = 0;     // deflate
  ihdr[11] = 0;     // adaptive filtering
  ihdr[12] = 0;     // no interlace

  const perMetre = Math.round((dpi / 0.0254) / 1);
  const phys = Buffer.alloc(9);
  phys.writeUInt32BE(perMetre, 0);
  phys.writeUInt32BE(perMetre, 4);
  phys[8] = 1;      // unit is the metre

  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;   // filter type 0, none
    raw.set(data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }

  return Buffer.concat([
    Buffer.from(SIGNATURE),
    chunk('IHDR', ihdr),
    chunk('pHYs', phys),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Read back width, height, bit depth and colour type from a PNG.
 *
 * Used by the verify script so the claim "this is a 1200 pixel truecolour PNG" is checked
 * against the bytes on disk rather than against the variable that was passed in.
 */
export function readPngHeader(bytes) {
  for (let i = 0; i < SIGNATURE.length; i++) {
    if (bytes[i] !== SIGNATURE[i]) throw new Error('not a PNG: signature mismatch');
  }
  const view = Buffer.from(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, bytes.length);
  const length = view.readUInt32BE(8);
  const type = view.toString('ascii', 12, 16);
  if (type !== 'IHDR') throw new Error(`expected IHDR first, found ${type}`);
  if (length !== 13) throw new Error(`IHDR should be 13 bytes, found ${length}`);
  return {
    width: view.readUInt32BE(16),
    height: view.readUInt32BE(20),
    bitDepth: view[24],
    colourType: view[25],
  };
}
