// Draw the primitives into a pixel buffer, analytically and with supersampling.
//
// This exists so the command line can emit a PNG without a browser and without a drawing
// library. It reads the same shape list the SVG writer reads, which is the point: if the
// two ever disagreed, one of them would be lying about what the tiling looks like.
//
// Coverage is estimated by sampling on a regular grid inside each pixel and averaging.
// Shapes are bucketed by cell first, so a sample tests four or five shapes rather than the
// tens of thousands in the scene.

import { parseHex } from './palette.mjs';

function shapeBounds(shape) {
  if (shape.kind === 'polygon') {
    const xs = shape.points.map((p) => p[0]);
    const ys = shape.points.map((p) => p[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }
  const pad = shape.width / 2 + 1e-6;
  if (shape.kind === 'arc') {
    return [shape.cx - shape.r - pad, shape.cy - shape.r - pad,
      shape.cx + shape.r + pad, shape.cy + shape.r + pad];
  }
  return [Math.min(shape.x1, shape.x2) - pad, Math.min(shape.y1, shape.y2) - pad,
    Math.max(shape.x1, shape.x2) + pad, Math.max(shape.y1, shape.y2) + pad];
}

function translateShape(shape, dx, dy) {
  if (dx === 0 && dy === 0) return shape;
  if (shape.kind === 'polygon') {
    return { ...shape, points: shape.points.map(([x, y]) => [x + dx, y + dy]) };
  }
  if (shape.kind === 'arc') return { ...shape, cx: shape.cx + dx, cy: shape.cy + dy };
  return {
    ...shape, x1: shape.x1 + dx, y1: shape.y1 + dy, x2: shape.x2 + dx, y2: shape.y2 + dy,
  };
}

/**
 * @param wrap when true the scene is treated as a torus, so a shape that spills past an
 *             edge is also drawn against the opposite edge.
 *
 * Without this a round line cap sitting on the boundary is clipped rather than wrapped, and
 * the texture has a visible nick at every edge crossing. The exact shift test found it: the
 * diagonal family disagreed with itself on 720 bytes at a worst channel delta of 213, which
 * is a whole pixel of stroke present on one side of the seam and missing on the other.
 */
function bucketShapes(scene, wrap) {
  const cols = Math.ceil(scene.width / scene.cell);
  const rows = Math.ceil(scene.height / scene.cell);
  const buckets = Array.from({ length: cols * rows }, () => []);
  const offsets = wrap
    ? [[0, 0], [-scene.width, 0], [scene.width, 0], [0, -scene.height], [0, scene.height],
      [-scene.width, -scene.height], [scene.width, -scene.height],
      [-scene.width, scene.height], [scene.width, scene.height]]
    : [[0, 0]];
  for (const shape of scene.shapes) {
    const rgb = parseHex(shape.fill ?? shape.stroke);
    for (const [dx, dy] of offsets) {
      const moved = translateShape(shape, dx, dy);
      const [x0, y0, x1, y1] = shapeBounds(moved);
      if (x1 < 0 || y1 < 0 || x0 > scene.width || y0 > scene.height) continue;
      const c0 = Math.max(0, Math.floor(x0 / scene.cell));
      const c1 = Math.min(cols - 1, Math.floor(x1 / scene.cell));
      const r0 = Math.max(0, Math.floor(y0 / scene.cell));
      const r1 = Math.min(rows - 1, Math.floor(y1 / scene.cell));
      const entry = { ...moved, rgb };
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) buckets[r * cols + c].push(entry);
      }
    }
  }
  return { buckets, cols, rows };
}

function insideTriangle(px, py, points) {
  const [[ax, ay], [bx, by], [cx, cy]] = points;
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const negative = (d1 < 0) || (d2 < 0) || (d3 < 0);
  const positive = (d1 > 0) || (d2 > 0) || (d3 > 0);
  return !(negative && positive);
}

function onArc(px, py, shape) {
  const dx = px - shape.cx;
  const dy = py - shape.cy;
  const dist = Math.hypot(dx, dy);
  const half = shape.width / 2;
  if (Math.abs(dist - shape.r) <= half) {
    let angle = (Math.atan2(dy, dx) * 180) / Math.PI;
    while (angle < shape.from) angle += 360;
    if (angle <= shape.to) return true;
  }
  // Round caps at both ends.
  for (const degrees of [shape.from, shape.to]) {
    const radians = (degrees * Math.PI) / 180;
    const ex = shape.cx + shape.r * Math.cos(radians);
    const ey = shape.cy + shape.r * Math.sin(radians);
    if (Math.hypot(px - ex, py - ey) <= half) return true;
  }
  return false;
}

function onSegment(px, py, shape) {
  const vx = shape.x2 - shape.x1;
  const vy = shape.y2 - shape.y1;
  const lengthSquared = vx * vx + vy * vy;
  let t = lengthSquared === 0 ? 0 : ((px - shape.x1) * vx + (py - shape.y1) * vy) / lengthSquared;
  t = Math.max(0, Math.min(1, t));
  const dx = px - (shape.x1 + t * vx);
  const dy = py - (shape.y1 + t * vy);
  return Math.hypot(dx, dy) <= shape.width / 2;
}

function covers(px, py, shape) {
  if (shape.kind === 'polygon') return insideTriangle(px, py, shape.points);
  if (shape.kind === 'arc') return onArc(px, py, shape);
  if (shape.kind === 'segment') return onSegment(px, py, shape);
  throw new Error(`no rasteriser for shape kind ${shape.kind}`);
}

/**
 * @returns {{width:number,height:number,data:Uint8Array}} 8 bit RGB, row major.
 */
export function rasterise(scene, { pixelWidth, samples = 4, wrap = false } = {}) {
  if (!pixelWidth || pixelWidth < 1) throw new Error('pixelWidth is required and must be positive');
  // The sample offset inside a pixel is (index + 0.5) / samples, which is a binary fraction
  // only when samples is a power of two. With samples = 3 the offset is a sixth, the sample
  // coordinate picks up a rounding error, and the same geometry shifted by a whole cell
  // rasterises to slightly different bytes. That made the exact seamlessness test fail on a
  // tiling that was in fact seamless, which is worse than useless: it invites someone to add
  // a tolerance and lose the only test that would catch a real seam.
  if (![1, 2, 4, 8, 16].includes(samples)) {
    throw new Error(`samples must be a power of two up to 16, got ${samples}. `
      + 'Other values make the sample offsets non-dyadic and break translation invariance.');
  }
  const unitsPerPixel = scene.width / pixelWidth;
  const scale = pixelWidth / scene.width;
  const pixelHeight = Math.max(1, Math.round(scene.height * scale));
  const { buckets, cols, rows } = bucketShapes(scene, wrap);
  const background = parseHex(scene.background);
  const data = new Uint8Array(pixelWidth * pixelHeight * 3);
  const sampleCount = samples * samples;

  for (let py = 0; py < pixelHeight; py++) {
    for (let px = 0; px < pixelWidth; px++) {
      let red = 0;
      let green = 0;
      let blue = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const ux = (px + (sx + 0.5) / samples) * unitsPerPixel;
          const uy = (py + (sy + 0.5) / samples) * unitsPerPixel;
          const bucketColumn = Math.min(cols - 1, Math.max(0, Math.floor(ux / scene.cell)));
          const bucketRow = Math.min(rows - 1, Math.max(0, Math.floor(uy / scene.cell)));
          let rgb = background;
          for (const shape of buckets[bucketRow * cols + bucketColumn]) {
            if (covers(ux, uy, shape)) rgb = shape.rgb;
          }
          red += rgb[0];
          green += rgb[1];
          blue += rgb[2];
        }
      }
      const offset = (py * pixelWidth + px) * 3;
      data[offset] = Math.round(red / sampleCount);
      data[offset + 1] = Math.round(green / sampleCount);
      data[offset + 2] = Math.round(blue / sampleCount);
    }
  }
  return { width: pixelWidth, height: pixelHeight, data };
}

/** Cyclic shift of the pixels: out(x, y) = in((x + dx) mod width, (y + dy) mod height). */
export function rollImage(image, dx, dy) {
  const { width, height, data } = image;
  const out = new Uint8Array(data.length);
  for (let y = 0; y < height; y++) {
    const sourceY = ((y + dy) % height + height) % height;
    for (let x = 0; x < width; x++) {
      const sourceX = ((x + dx) % width + width) % width;
      const to = (y * width + x) * 3;
      const from = (sourceY * width + sourceX) * 3;
      out[to] = data[from];
      out[to + 1] = data[from + 1];
      out[to + 2] = data[from + 2];
    }
  }
  return { width, height, data: out };
}

/**
 * The number of bytes at which two images of the same size differ.
 *
 * Used for the seamlessness test, which is exact rather than photometric. Comparing the
 * first pixel column against the last was tried first and rejected: for arcs it reads near
 * zero because the curves cross an edge at a right angle, and for diagonals it reads about
 * eight percent because they cross at forty five degrees, so the same seamless tiling
 * scores well or badly depending only on the drawing style. A number whose threshold has to
 * be tuned per style is not measuring seamlessness.
 *
 * What is exact: on a torus, shifting the tiling by one cell gives another valid tiling of
 * the same torus, and its rendering must equal the original rendering shifted by one cell
 * worth of pixels. That is byte for byte, it holds for every style, and it fails loudly if
 * the wrap is wrong anywhere.
 */
export function imageDifference(a, b) {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`cannot compare ${a.width}x${a.height} against ${b.width}x${b.height}`);
  }
  let differing = 0;
  let worst = 0;
  for (let i = 0; i < a.data.length; i++) {
    const delta = Math.abs(a.data[i] - b.data[i]);
    if (delta !== 0) differing += 1;
    if (delta > worst) worst = delta;
  }
  return { differingBytes: differing, totalBytes: a.data.length, worstChannelDelta: worst };
}
