// Turn a set of options into a tiling, and say honestly how it was placed.
//
// The placement method is chosen from a property of the tile set rather than from a guess,
// and it is recorded in the model so the tool can tell the user which guarantee applies.
// There are three:
//
//   edges      a full colours^4 set contains every tile, so the grid of edge colours can be
//              chosen freely and the tiles read off. No search, cannot fail, and seamless
//              wrapping is exact because the last edge row is literally the first.
//   scanline   a complete set has a tile for every (north, west) pair, so one pass places
//              every cell and cannot strand. Verified by `completenessReport`, not assumed.
//   solver     anything else. Arc consistency plus backtracking, which reports sat, unsat
//              or capped, and never confuses the last two.
//
// The Jeandel-Rao set is aperiodic, so it admits no periodic tiling of any size at all, and
// asking for a seamless wrap of it is asking for something that provably does not exist.
// That is refused with an explanation rather than answered with a broken tiling.

import { makeRng } from './rng.mjs';
import {
  buildTileSet, completenessReport, alphabet, placeScanline, placeByEdges,
  solveConstrained, checkEdgeMatching, naiveScanlineTrial,
} from './wang.mjs';
import {
  arcField, freeQuarterArcField, diagonalField, freeDiagonalField,
  checkArcContinuity, checkDiagonalContinuity,
} from './truchet.mjs';

export const FAMILIES = {
  wang: {
    label: 'Wang tiles, edge matched',
    description: 'Unit squares with coloured edges, placed without rotation so that '
      + 'touching edges agree.',
  },
  arcs: {
    label: 'Truchet arcs (Smith)',
    description: 'Two quarter arcs on opposite corners. Every tile presents an endpoint at '
      + 'every edge midpoint, so the curves join whatever the orientation.',
  },
  'arcs-free': {
    label: 'Single quarter arc (broken on purpose)',
    description: 'One arc in a random corner. Touches two edges out of four, so most '
      + 'curves end in mid air. Kept as the counterexample the continuity check must catch.',
  },
  diagonals: {
    label: 'Truchet diagonals, continuous',
    description: 'Corner to corner diagonals constrained so every interior vertex has an '
      + 'even number of line ends. The valid fields are exactly a[row] xor b[column].',
  },
  'diagonals-free': {
    label: 'Unconstrained diagonals (broken on purpose)',
    description: 'Random diagonals with no constraint. Roughly half of all interior '
      + 'vertices end up odd, which is a dangling line end at each one.',
  },
};

export const DEFAULTS = {
  family: 'wang',
  set: 'stochastic-2',
  style: 'triangles',
  palette: 'indigo',
  width: 16,
  height: 16,
  seed: 'wang-1',
  torus: false,
  bands: 1,
  weight: 0.16,
};

export function normaliseOptions(options = {}) {
  const merged = { ...DEFAULTS, ...options };
  merged.width = Math.max(1, Math.round(Number(merged.width)));
  merged.height = Math.max(1, Math.round(Number(merged.height)));
  merged.bands = Math.max(1, Math.min(7, Math.round(Number(merged.bands))));
  merged.weight = Math.max(0.02, Math.min(0.45, Number(merged.weight)));
  merged.torus = Boolean(merged.torus);
  merged.seed = String(merged.seed);
  if (!FAMILIES[merged.family]) {
    throw new Error(`unknown family ${JSON.stringify(merged.family)}; `
      + `known families are ${Object.keys(FAMILIES).join(', ')}`);
  }
  return merged;
}

function buildWang(options) {
  const { set, width, height, seed, torus } = options;
  const tileSet = buildTileSet(set);
  const { tiles } = tileSet;
  const report = completenessReport(tiles);
  const colours = alphabet(tiles, 'n').length;
  const isFull = tiles.length === colours ** 4
    && ['n', 'e', 's', 'w'].every((d) => alphabet(tiles, d).length === colours);
  const rng = makeRng(`${seed}|${set}|${width}x${height}|${torus ? 'torus' : 'open'}`);

  let grid;
  let placement;
  if (isFull) {
    grid = placeByEdges(tiles, width, height, rng, { torus });
    placement = {
      method: 'edges',
      guarantee: 'cannot fail: a full set contains a tile for every combination of edge '
        + 'colours, so the edge colours are chosen directly and the tiles read off',
      steps: width * height,
    };
  } else if (report.complete && !torus) {
    grid = placeScanline(tiles, width, height, rng);
    placement = {
      method: 'scanline',
      guarantee: `cannot strand: every one of the ${report.pairs} (north, west) constraint `
        + `pairs has at least ${report.minChoices} admissible tile(s)`,
      steps: width * height,
    };
  } else {
    const maxSteps = Math.max(20000, width * height * 400);
    const result = solveConstrained(tiles, width, height, rng, { torus, maxSteps });
    if (result.status !== 'sat') {
      const why = result.status === 'unsat'
        ? 'the search was exhaustive and there is no tiling of this size'
        : `the search hit its budget of ${maxSteps} steps and does not know whether one exists`;
      throw new Error(`no tiling found for ${set} at ${width}x${height}`
        + `${torus ? ' on a torus' : ''}: ${why}`);
    }
    grid = result.grid;
    placement = {
      method: 'solver',
      guarantee: 'arc consistency plus backtracking; the set is not complete, so a single '
        + 'scanline pass would strand',
      steps: result.steps,
    };
  }
  return { tileSet, tiles, grid, placement, completeness: report, colours };
}

export function buildModel(rawOptions = {}) {
  const options = normaliseOptions(rawOptions);
  const { family, width, height, seed, torus } = options;

  if (family === 'wang') {
    if (options.set === 'jeandel-rao' && torus) {
      throw new Error('the Jeandel-Rao set is aperiodic, so it admits no periodic tiling '
        + 'of any size and cannot be wrapped seamlessly. This is not a limitation of the '
        + 'solver; the tests search every torus up to 5x5 exhaustively and find none.');
    }
    const built = buildWang(options);
    return { ...options, ...built, field: null };
  }

  const rng = makeRng(`${seed}|${family}|${width}x${height}|${torus ? 'torus' : 'open'}`);
  let field;
  let placement;
  switch (family) {
    case 'arcs':
      field = arcField(width, height, rng);
      placement = {
        method: 'free',
        guarantee: 'every Smith arc tile has an endpoint at all four edge midpoints, so any '
          + 'orientation meets any neighbour and no constraint is needed',
        steps: width * height,
      };
      break;
    case 'arcs-free':
      field = freeQuarterArcField(width, height, rng);
      placement = {
        method: 'free',
        guarantee: 'none: this family is the counterexample and is expected to fail the '
          + 'continuity check',
        steps: width * height,
      };
      break;
    case 'diagonals':
      field = diagonalField(width, height, rng);
      placement = {
        method: 'xor',
        guarantee: 'drawn from a[row] xor b[column], which is exactly the set of diagonal '
          + 'fields with no dangling interior endpoint, wrapped or not',
        steps: width + height,
      };
      break;
    case 'diagonals-free':
      field = freeDiagonalField(width, height, rng);
      placement = {
        method: 'free',
        guarantee: 'none: this family is the counterexample and is expected to fail the '
          + 'continuity check',
        steps: width * height,
      };
      break;
    default:
      throw new Error(`family ${family} has no placer`);
  }
  return {
    ...options, tileSet: null, tiles: null, grid: null, field, placement,
    completeness: null, colours: 0,
  };
}

/**
 * Run every invariant that applies to this model and return the violations.
 *
 * The counterexample families are expected to produce violations. `expectClean` says
 * whether a clean result is the correct outcome, so a caller can turn this into a pass or
 * fail without hard-coding which families are which.
 */
export function checkModel(model) {
  const { family, width, height, torus } = model;
  if (family === 'wang') {
    return {
      kind: 'edge-matching',
      expectClean: true,
      violations: checkEdgeMatching(model.tiles, model.grid, width, height, { torus }),
    };
  }
  if (family === 'arcs' || family === 'arcs-free') {
    return {
      kind: 'curve-continuity',
      expectClean: family === 'arcs',
      violations: checkArcContinuity(model.field, width, height, { torus, family }),
    };
  }
  return {
    kind: 'curve-continuity',
    expectClean: family === 'diagonals',
    violations: checkDiagonalContinuity(model.field, width, height, { torus }),
  };
}

/**
 * Shift a tiling cyclically by whole cells.
 *
 * On a torus this maps a valid tiling to another valid tiling of the same torus, which is
 * the basis of the exact seamlessness test: the rendering of the shifted tiling has to be
 * the rendering of the original, shifted by the same number of cells worth of pixels. On an
 * open boundary it is meaningless and the caller should not ask.
 */
export function rollModel(model, rowShift, columnShift) {
  const { width, height } = model;
  const shift = (source) => {
    const out = source.constructor === Int32Array
      ? new Int32Array(source.length)
      : new Uint8Array(source.length);
    for (let r = 0; r < height; r++) {
      for (let c = 0; c < width; c++) {
        const sr = ((r + rowShift) % height + height) % height;
        const sc = ((c + columnShift) % width + width) % width;
        out[r * width + c] = source[sr * width + sc];
      }
    }
    return out;
  };
  return {
    ...model,
    grid: model.grid ? shift(model.grid) : null,
    field: model.field ? shift(model.field) : null,
  };
}

/**
 * How often a single naive scanline pass succeeds on a tile set.
 *
 * The honest answer to "what happens if you skip the solver". For a complete set this is
 * 100 percent by construction; for the aperiodic set it is not, and the README quotes the
 * measured number instead of describing it.
 */
export function measureScanlineFailureRate(setName, width, height, trials, seedPrefix = 'trial') {
  const { tiles } = buildTileSet(setName);
  let succeeded = 0;
  let totalPlaced = 0;
  let firstFailure = null;
  for (let i = 0; i < trials; i++) {
    const rng = makeRng(`${seedPrefix}|${setName}|${i}`);
    const result = naiveScanlineTrial(tiles, width, height, rng);
    if (result.ok) succeeded += 1;
    else if (!firstFailure) firstFailure = { row: result.row, column: result.column };
    totalPlaced += result.placed;
  }
  return {
    setName,
    trials,
    succeeded,
    failureRate: (trials - succeeded) / trials,
    meanCellsPlaced: totalPlaced / trials,
    cells: width * height,
    firstFailure,
  };
}
