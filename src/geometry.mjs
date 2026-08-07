// One description of what to draw, consumed by the SVG writer, the PNG rasteriser and the
// browser canvas. Three renderers reading three descriptions is three chances to disagree.
//
// Coordinates are in user units with one cell equal to `cell`, origin at the top left, y
// increasing downwards, which is the SVG and canvas convention. Angles are degrees measured
// the same way, so a point at angle a sits at (cx + r cos a, cy + r sin a) and increasing a
// turns clockwise on screen.
//
// BAND RADII. Drawing several concentric arcs per corner is the classic woven Truchet
// look, and it has a condition attached that is easy to miss. An arc of radius r centred on
// a corner meets the two adjacent edges at distance r from that corner. Across a shared
// edge one cell measures that distance from the top corner and the other from the bottom,
// so the endpoint positions agree only when the radius set is symmetric about half a cell.
// `bandRadii` builds a symmetric set and `assertSymmetricRadii` refuses anything else,
// because an asymmetric set produces curves that visibly stop short at every edge.

export const CORNER_ANGLES = { nw: 0, ne: 90, se: 180, sw: 270 };

/** Corner offsets in cell units, in the same nw, ne, se, sw order. */
export const CORNER_OFFSETS = { nw: [0, 0], ne: [1, 0], se: [1, 1], sw: [0, 1] };

export function bandRadii(cell, bands) {
  const count = Math.max(1, Math.round(bands));
  if (count === 1) return [cell / 2];
  const spread = cell * 0.5;
  const step = spread / (count - 1);
  const radii = [];
  for (let j = 0; j < count; j++) radii.push(cell / 2 - spread / 2 + j * step);
  return radii;
}

export function assertSymmetricRadii(radii, cell) {
  const sorted = radii.slice().sort((a, b) => a - b);
  for (let i = 0, j = sorted.length - 1; i <= j; i++, j--) {
    if (Math.abs((sorted[i] + sorted[j]) - cell) > 1e-9) {
      throw new Error(`band radii must be symmetric about half a cell (${cell / 2}); `
        + `${sorted[i]} and ${sorted[j]} sum to ${sorted[i] + sorted[j]}, not ${cell}. `
        + 'An asymmetric set puts the two sides of an edge in different places and the '
        + 'curves stop short.');
    }
  }
  return true;
}

/**
 * Bands pair up across an edge: the arc at radius cell/2 + d meets the one at cell/2 - d.
 * Colouring by the distance from the middle therefore runs continuously along a curve,
 * where colouring by the band index would change colour at every edge.
 */
export function bandColourIndex(bandIndex, bandCount) {
  return Math.min(bandIndex, bandCount - 1 - bandIndex);
}

function arcShape(cx, cy, r, corner, stroke, width) {
  const from = CORNER_ANGLES[corner];
  return { kind: 'arc', cx, cy, r, from, to: from + 90, stroke, width };
}

function wangTriangles(x0, y0, cell, tile, colours) {
  const x1 = x0 + cell;
  const y1 = y0 + cell;
  const cx = x0 + cell / 2;
  const cy = y0 + cell / 2;
  return [
    { kind: 'polygon', points: [[x0, y0], [x1, y0], [cx, cy]], fill: colours(tile.n) },
    { kind: 'polygon', points: [[x1, y0], [x1, y1], [cx, cy]], fill: colours(tile.e) },
    { kind: 'polygon', points: [[x1, y1], [x0, y1], [cx, cy]], fill: colours(tile.s) },
    { kind: 'polygon', points: [[x0, y1], [x0, y0], [cx, cy]], fill: colours(tile.w) },
  ];
}

/**
 * Build the shape list for a model.
 *
 * `palette` supplies the colours; `colourFor` is passed in rather than imported so the
 * caller controls the failure behaviour when an edge label has no colour.
 */
export function buildPrimitives(model, options) {
  const { palette, colourFor, cell = 100 } = options;
  const weight = (options.weight ?? model.weight ?? 0.16) * cell;
  const bands = options.bands ?? model.bands ?? 1;
  const { width, height, family } = model;
  const shapes = [];
  const colours = (index) => colourFor(palette, index);

  const radii = bandRadii(cell, bands);
  assertSymmetricRadii(radii, cell);
  const strokeFor = (bandIndex) => colours(bandColourIndex(bandIndex, radii.length) % palette.colours.length);

  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      const x0 = c * cell;
      const y0 = r * cell;
      const index = r * width + c;

      if (family === 'wang') {
        const tile = model.tiles[model.grid[index]];
        if (model.style === 'arcs') {
          // The orientation has to be a function of the tile alone. A tile that draws
          // itself differently depending on where it sits is not a tile.
          const orientation = (tile.n + tile.e + tile.s + tile.w) % 2;
          shapes.push(...smithArcs(x0, y0, cell, orientation, radii, strokeFor, weight));
        } else {
          shapes.push(...wangTriangles(x0, y0, cell, tile, colours));
        }
        continue;
      }

      if (family === 'arcs') {
        shapes.push(...smithArcs(x0, y0, cell, model.field[index], radii, strokeFor, weight));
        continue;
      }

      if (family === 'arcs-free') {
        const corner = ['nw', 'ne', 'se', 'sw'][model.field[index]];
        const [ox, oy] = CORNER_OFFSETS[corner];
        for (let j = 0; j < radii.length; j++) {
          shapes.push(arcShape(x0 + ox * cell, y0 + oy * cell, radii[j], corner,
            strokeFor(j), weight));
        }
        continue;
      }

      // Both diagonal families draw the same way; only the field differs.
      // 1 is the south-west to north-east diagonal, 0 the other one.
      const slash = model.field[index] === 1;
      shapes.push({
        kind: 'segment',
        x1: x0,
        y1: slash ? y0 + cell : y0,
        x2: x0 + cell,
        y2: slash ? y0 : y0 + cell,
        stroke: colours(0),
        width: weight,
      });
    }
  }

  return {
    width: width * cell,
    height: height * cell,
    cell,
    background: palette.background,
    shapes,
  };
}

function smithArcs(x0, y0, cell, orientation, radii, strokeFor, weight) {
  const corners = orientation === 0 ? ['nw', 'se'] : ['ne', 'sw'];
  const out = [];
  for (const corner of corners) {
    const [ox, oy] = CORNER_OFFSETS[corner];
    for (let j = 0; j < radii.length; j++) {
      out.push(arcShape(x0 + ox * cell, y0 + oy * cell, radii[j], corner, strokeFor(j), weight));
    }
  }
  return out;
}
