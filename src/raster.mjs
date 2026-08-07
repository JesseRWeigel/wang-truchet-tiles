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

/**
 * Point in triangle under the top-left fill rule.
 *
 * The obvious test treats a point exactly on an edge as inside, and that is what the first
 * version did. It is wrong here for a reason that took a failing seam test to find. Two
 * triangles that share an edge then both claim a sample lying on it, the tie is broken by
 * whichever shape was painted last, and paint order is the order of the scene. Shift the
 * tiling by one cell on a torus and a pair that used to resolve one way resolves the other,
 * so a genuinely seamless tiling rendered 146 pixels differently from itself. The deltas
 * were single samples, up to 16 of 255, which is invisible to the eye and fatal to a byte
 * for byte test. Adding a tolerance to the test would have hidden the only check that can
 * catch a real seam.
 *
 * The fix is the standard rasteriser rule: a point on a shared edge belongs to exactly one
 * of the two triangles, decided by the direction of the edge rather than by paint order.
 * An edge that goes down is a left edge and keeps its boundary; a horizontal edge that goes
 * leftwards is a top edge and keeps its boundary; everything else gives it up. Coverage then
 * depends only on the geometry, so translating the whole scene translates the coverage.
 */
export function insideTriangle(px, py, points) {
  let [[ax, ay], [bx, by], [cx, cy]] = points;
  // Normalise the winding so "inside" is consistently the non-negative side. In screen
  // coordinates, with y increasing downwards, that is clockwise on screen.
  const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  if (area === 0) return false;
  if (area < 0) { [bx, by, cx, cy] = [cx, cy, bx, by]; }
  const edges = [[ax, ay, bx, by], [bx, by, cx, cy], [cx, cy, ax, ay]];
  for (const [x0, y0, x1, y1] of edges) {
    const value = (x1 - x0) * (py - y0) - (y1 - y0) * (px - x0);
    if (value > 0) continue;
    if (value < 0) return false;
    // Exactly on the line. Keep it only for a top or a left edge.
    const isLeft = y1 > y0;
    const isTop = y1 === y0 && x1 < x0;
    if (!isLeft && !isTop) return false;
  }
  return true;
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
  // A wrapped render claims the image tiles seamlessly, and the only exact test of that is
  // to shift the tiling by a whole cell and the image by the corresponding whole number of
  // pixels. That comparison is only meaningful when the two shifts are the same shift. At
  // 96 pixels over 4 cells of 100 units the unit width of a pixel is 100/24, and 24 of them
  // come to 100.00000000000001 rather than 100, so a sample near a cell boundary lands on
  // one side before the shift and the other side after it. The tiling was seamless and the
  // rendering disagreed with itself on 146 pixels. Rather than let the caller find that as a
  // mysterious failure, require the alignment and name the fix.
  if (wrap) {
    const pixelsPerCell = scene.cell / unitsPerPixel;
    const cells = scene.width / scene.cell;
    // Two conditions, and the second is the one that is easy to miss. A whole number of
    // pixels per cell is necessary and not sufficient: at 96 pixels over 4 cells the unit
    // width of a pixel is 100/24, which is 4.166666666666667 in binary, and although
    // 24 x 4.166666666666667 comes to exactly 100, the sample coordinate is computed as
    // (pixel + offset) x unitWidth, and that product rounds differently at different pixels.
    // The result was a genuinely seamless tiling whose rendering disagreed with itself by one
    // sample on 146 pixels. So the unit width has to be a dyadic rational, which is exactly
    // the condition under which every one of those products is exact.
    const dyadic = (() => {
      for (let power = 0; power <= 24; power++) {
        if (Number.isInteger(unitsPerPixel * 2 ** power)) return true;
      }
      return false;
    })();
    if (!Number.isInteger(pixelsPerCell) || !dyadic) {
      throw new Error('a wrapped render needs the pixel grid to land on the cell grid: '
        + `${pixelWidth} pixels over ${cells} cells is ${pixelsPerCell} pixels per cell of `
        + `${unitsPerPixel} units each, and a shift by one cell is then not a shift by a whole `
        + 'number of pixels. Use a pixel width of cells x n with n one of '
        + '1, 2, 4, 5, 8, 10, 16, 20, 25, 32, 40, 50, 64, 80, 100.');
    }
  }
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
