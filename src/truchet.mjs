// Truchet tiles: the arc family, the diagonal family, and what continuity actually costs.
//
// Two families live here and they behave very differently, which is the interesting part.
//
// SMITH ARCS. Cyril Stanley Smith's 1987 variant of Truchet's tile draws two quarter arcs
// of radius 1/2 centred on opposite corners. In orientation 0 the centres are north-west
// and south-east; in orientation 1 they are north-east and south-west. Either way the four
// arc endpoints land on the midpoints of all four edges. Every tile therefore presents a
// curve endpoint at every edge, so any orientation meets any neighbour and continuity is
// structural. Random placement is safe.
//
// A QUARTER ARC PER TILE is the version that does not work, and it is the usual bug. One
// arc in a randomly chosen corner touches only two of the four edges, so a neighbour that
// offers an endpoint on the shared edge frequently meets one that does not, and the curves
// end in mid air. `freeQuarterArcField` builds exactly that, on purpose, so the continuity
// checker has something it must reject. A checker that only ever sees valid input proves
// nothing.
//
// DIAGONALS. Truchet's original tile is split by a diagonal, and here the endpoints sit at
// the corners rather than the edge midpoints. Four cells meet at every interior vertex, and
// each contributes an endpoint there or not:
//
//   degree = (1 - x[r-1][c-1]) + x[r-1][c] + x[r][c-1] + (1 - x[r][c])
//
// writing x = 1 for the south-west to north-east diagonal. An odd degree leaves a line
// ending in mid air, so continuity requires every interior vertex to be even, which reduces
// to the xor of every 2x2 block of the field being zero. That has a complete and rather
// pretty solution: x[r][c] = a[r] xor b[c] for a row vector a and a column vector b, and
// nothing else. The count agrees, 2^(H+W-1) configurations for both, and
// `enumerateValidDiagonalFields` checks it exhaustively on small grids in the test suite.
//
// So unconstrained random diagonals are broken almost everywhere, and the fix is not a
// repair pass. The valid configurations form a thin, highly structured subset of all of
// them, and generating from a and b lands inside it by construction. It also makes the
// seamless case free, since a and b wrap with no extra condition.

export const ARC_ORIENTATIONS = 2;

/** Smith arcs. Any orientation meets any neighbour, so this needs no constraint at all. */
export function arcField(width, height, rng) {
  const field = new Uint8Array(width * height);
  for (let i = 0; i < field.length; i++) field[i] = rng.int(ARC_ORIENTATIONS);
  return field;
}

/**
 * One quarter arc per tile in a random corner: 0 north-west, 1 north-east, 2 south-east,
 * 3 south-west. Included because it is the shape of the mistake, not because it is useful.
 */
export function freeQuarterArcField(width, height, rng) {
  const field = new Uint8Array(width * height);
  for (let i = 0; i < field.length; i++) field[i] = rng.int(4);
  return field;
}

/** Which two edges a quarter arc in `corner` touches, as booleans in n, e, s, w order. */
export function quarterArcEdges(corner) {
  switch (corner) {
    case 0: return [true, false, false, true];   // north-west: north and west midpoints
    case 1: return [true, true, false, false];   // north-east
    case 2: return [false, true, true, false];   // south-east
    case 3: return [false, false, true, true];   // south-west
    default: throw new Error(`corner must be 0..3, got ${corner}`);
  }
}

/**
 * A diagonal field with no dangling endpoints anywhere, seamless included.
 *
 * Every such field is x[r][c] = a[r] xor b[c], so drawing a and b at random draws uniformly
 * from the valid set. The map is two to one, since (a, b) and (a xor 1, b xor 1) describe
 * the same field, which is why 2^(height + width) draws give 2^(height + width - 1) fields.
 */
export function diagonalField(width, height, rng) {
  const rows = new Uint8Array(height);
  const cols = new Uint8Array(width);
  for (let r = 0; r < height; r++) rows[r] = rng.int(2);
  for (let c = 0; c < width; c++) cols[c] = rng.int(2);
  const field = new Uint8Array(width * height);
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) field[r * width + c] = rows[r] ^ cols[c];
  }
  return field;
}

/** Unconstrained random diagonals: the version with broken curves. */
export function freeDiagonalField(width, height, rng) {
  const field = new Uint8Array(width * height);
  for (let i = 0; i < field.length; i++) field[i] = rng.int(2);
  return field;
}

/**
 * Interior vertices whose diagonal endpoint count is odd, meaning a line dangles there.
 *
 * On a torus every vertex is interior, which is what makes a wrapped diagonal tiling
 * genuinely seamless rather than merely aligned.
 */
export function checkDiagonalContinuity(field, width, height, { torus = false } = {}) {
  const at = (r, c) => field[((r % height) + height) % height * width + ((c % width) + width) % width];
  const violations = [];
  const firstRow = torus ? 0 : 1;
  const firstCol = torus ? 0 : 1;
  for (let r = firstRow; r < height; r++) {
    for (let c = firstCol; c < width; c++) {
      const nw = at(r - 1, c - 1);
      const ne = at(r - 1, c);
      const sw = at(r, c - 1);
      const se = at(r, c);
      const degree = (1 - nw) + ne + sw + (1 - se);
      if (degree % 2 !== 0) {
        violations.push({ vertexRow: r, vertexColumn: c, degree });
      }
    }
  }
  return violations;
}

/**
 * Interior edges where the two sides disagree about whether a curve crosses.
 *
 * For Smith arcs this is always empty, and it is still worth computing: the claim "these
 * curves are continuous" should be a measurement rather than an argument, and the same
 * function has to reject the quarter arc field, which it does.
 */
export function checkArcContinuity(field, width, height, { torus = false, family = 'arcs' } = {}) {
  const touches = (index) => {
    if (family === 'arcs') return [true, true, true, true];
    return quarterArcEdges(field[index]);
  };
  const violations = [];
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      const here = touches(r * width + c);
      // A torus one cell wide glues a cell's east edge to its own west edge, which is a
      // constraint on the single cell rather than between two of them. The loop below never
      // sees it, because it compares a cell with a neighbour and here there is none, so it
      // is applied separately. Leaving it out made every 1xN and Nx1 torus report clean, and
      // the solver already carries the matching fix for the same reason.
      if (torus && width === 1 && here[1] !== here[3]) {
        violations.push({
          row: r, column: c, edge: 'east',
          detail: 'one cell wide on a torus: the east edge is glued to its own west edge and '
            + `they disagree (${here[1] ? 'endpoint' : 'blank'} against `
            + `${here[3] ? 'endpoint' : 'blank'})`,
        });
      }
      if (torus && height === 1 && here[2] !== here[0]) {
        violations.push({
          row: r, column: c, edge: 'south',
          detail: 'one cell tall on a torus: the south edge is glued to its own north edge '
            + `and they disagree (${here[2] ? 'endpoint' : 'blank'} against `
            + `${here[0] ? 'endpoint' : 'blank'})`,
        });
      }
      const hasEast = c + 1 < width || (torus && width > 1);
      if (hasEast) {
        const other = touches(r * width + ((c + 1) % width));
        if (here[1] !== other[3]) {
          violations.push({
            row: r, column: c, edge: 'east',
            detail: here[1] ? 'endpoint meets a blank edge' : 'blank edge meets an endpoint',
          });
        }
      }
      const hasSouth = r + 1 < height || (torus && height > 1);
      if (hasSouth) {
        const other = touches(((r + 1) % height) * width + c);
        if (here[2] !== other[0]) {
          violations.push({
            row: r, column: c, edge: 'south',
            detail: here[2] ? 'endpoint meets a blank edge' : 'blank edge meets an endpoint',
          });
        }
      }
    }
  }
  return violations;
}

/**
 * Every diagonal field on a small grid that has no dangling interior endpoint.
 *
 * Brute force over all 2^(width*height) fields. Only useful up to about 4x4, which is the
 * point: it is the ground truth the closed form is checked against, and it shares no code
 * with `diagonalField`.
 */
export function enumerateValidDiagonalFields(width, height) {
  const cells = width * height;
  if (cells > 20) throw new Error(`refusing to enumerate 2^${cells} fields`);
  const valid = [];
  for (let mask = 0; mask < (1 << cells); mask++) {
    const field = new Uint8Array(cells);
    for (let i = 0; i < cells; i++) field[i] = (mask >> i) & 1;
    if (checkDiagonalContinuity(field, width, height).length === 0) valid.push(mask);
  }
  return valid;
}
