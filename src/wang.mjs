// Edge-coloured Wang tiles: the tile sets, the completeness invariant, and the placers.
//
// A Wang tile is a unit square whose four edges carry colours. Tiles are placed on a grid
// without rotation and without reflection, and two tiles may sit side by side only if the
// colours on the edge they share are equal. Allowing rotation is a different problem with
// different answers, so nothing here ever rotates a tile.
//
// The property that makes a set usable for scanline placement is completeness: for every
// pair (a, b) where a is the south colour of some tile and b is the east colour of some
// tile, the set must contain at least one tile with north = a and west = b. Those are
// exactly the constraints a left-to-right, top-to-bottom placer can meet, so a complete set
// never strands the placer, and an incomplete one eventually will. `completenessReport`
// checks that pair by pair, and the test suite asserts it.
//
// The Jeandel-Rao set is deliberately not complete. It is aperiodic, which means it tiles
// the plane but admits no periodic tiling at all, and no scanline placer can handle it. It
// gets the backtracking solver instead.

const DIRS = ['n', 'e', 's', 'w'];

export function tile(n, e, s, w) {
  return { n, e, s, w };
}

// ---------------------------------------------------------------- tile set construction

/** Every tile over `colours` colours: colours^4 of them. Trivially complete. */
export function fullSet(colours) {
  const tiles = [];
  for (let n = 0; n < colours; n++)
    for (let e = 0; e < colours; e++)
      for (let s = 0; s < colours; s++)
        for (let w = 0; w < colours; w++)
          tiles.push(tile(n, e, s, w));
  return tiles;
}

/**
 * A reduced complete set: colours^2 * choices tiles, with exactly `choices` tiles for
 * every (north, west) constraint pair.
 *
 * This is the shape used for stochastic texture tiling, where the point is to have enough
 * freedom at each step to avoid visible repetition without carrying the whole colours^4
 * set. With 2 colours and 2 choices it is the familiar 8 tile set.
 */
export function reducedCompleteSet(colours, choices) {
  const combos = [];
  for (let e = 0; e < colours; e++)
    for (let s = 0; s < colours; s++)
      combos.push([e, s]);
  if (choices < 1 || choices > combos.length) {
    throw new Error(`choices must be between 1 and ${combos.length} for ${colours} colours`);
  }
  const tiles = [];
  let pair = 0;
  for (let n = 0; n < colours; n++) {
    for (let w = 0; w < colours; w++) {
      for (let k = 0; k < choices; k++) {
        const [e, s] = combos[(pair * choices + k) % combos.length];
        tiles.push(tile(n, e, s, w));
      }
      pair++;
    }
  }
  return tiles;
}

/**
 * The Jeandel-Rao aperiodic set of 11 Wang tiles.
 *
 * Source: Emmanuel Jeandel and Michael Rao, "An aperiodic set of 11 Wang tiles",
 * arXiv:1506.06492. The numbers below are transcribed from Sebastien Labbe's `slabbe`
 * documentation (labri.fr/perso/slabbe/docs/0.7/wang_tiles.html), which gives each tile as
 * (right, top, left, bottom).
 *
 * Aperiodicity was proven by Jeandel and Rao, not here. What this project verifies
 * computationally is weaker and is stated as such: the set tiles large squares, and it
 * admits no tiling of any torus up to a bound the tests search exhaustively. Both are
 * necessary conditions for aperiodicity, and both would fail on a mistranscription. An
 * earlier draft of this file had one digit wrong and the 12x12 search proved unsatisfiable,
 * which is how the error was found.
 */
export function jeandelRaoSet() {
  const raw = [
    [2, 4, 2, 1], [2, 2, 2, 0], [1, 1, 3, 1], [1, 2, 3, 2], [3, 1, 3, 3], [0, 1, 3, 1],
    [0, 0, 0, 1], [3, 1, 0, 2], [0, 2, 1, 2], [1, 2, 1, 4], [3, 3, 1, 2],
  ];
  return raw.map(([right, top, left, bottom]) => tile(top, right, bottom, left));
}

export const TILE_SETS = {
  'stochastic-2': {
    label: 'Stochastic, 2 colours, 8 tiles',
    build: () => reducedCompleteSet(2, 2),
    note: 'Complete by construction: two tiles for every (north, west) pair.',
  },
  'stochastic-3': {
    label: 'Stochastic, 3 colours, 18 tiles',
    build: () => reducedCompleteSet(3, 2),
    note: 'Complete by construction: two tiles for every (north, west) pair.',
  },
  'stochastic-4': {
    label: 'Stochastic, 4 colours, 48 tiles',
    build: () => reducedCompleteSet(4, 3),
    note: 'Complete by construction: three tiles for every (north, west) pair.',
  },
  'full-2': {
    label: 'Full, 2 colours, 16 tiles',
    build: () => fullSet(2),
    note: 'Every tile over 2 colours. Any assignment of edge colours is realisable, '
      + 'so seamless wrapping needs no search.',
  },
  'full-3': {
    label: 'Full, 3 colours, 81 tiles',
    build: () => fullSet(3),
    note: 'Every tile over 3 colours. Any assignment of edge colours is realisable.',
  },
  'jeandel-rao': {
    label: 'Jeandel-Rao, 11 tiles, aperiodic',
    build: jeandelRaoSet,
    note: 'Aperiodic, proven by Jeandel and Rao (arXiv:1506.06492). Not complete, so it '
      + 'needs the backtracking solver, and it admits no seamless wrap because it admits '
      + 'no periodic tiling at all.',
  },
};

export function buildTileSet(name) {
  const entry = TILE_SETS[name];
  if (!entry) {
    throw new Error(`unknown tile set ${JSON.stringify(name)}; `
      + `known sets are ${Object.keys(TILE_SETS).join(', ')}`);
  }
  const tiles = entry.build();
  return { name, label: entry.label, note: entry.note, tiles };
}

// ------------------------------------------------------------------------ completeness

export function alphabet(tiles, dir) {
  return [...new Set(tiles.map((t) => t[dir]))].sort((a, b) => a - b);
}

/**
 * Check the invariant a scanline placer depends on, pair by pair.
 *
 * The constraint a placer meets at an interior cell is (north = south colour of the tile
 * above, west = east colour of the tile to the left). So the pairs that can arise are
 * exactly southAlphabet x eastAlphabet, and the set is complete when every one of them has
 * a tile. Reporting the minimum count as well as the boolean matters: a set with exactly
 * one tile per pair is complete but produces a single forced tiling, which is not what
 * anyone wants from a stochastic set.
 */
export function completenessReport(tiles) {
  const norths = alphabet(tiles, 's');
  const wests = alphabet(tiles, 'e');
  const counts = [];
  const missing = [];
  for (const n of norths) {
    for (const w of wests) {
      const count = tiles.filter((t) => t.n === n && t.w === w).length;
      counts.push({ north: n, west: w, count });
      if (count === 0) missing.push({ north: n, west: w });
    }
  }
  return {
    complete: missing.length === 0,
    pairs: counts.length,
    missing,
    minChoices: counts.length ? Math.min(...counts.map((c) => c.count)) : 0,
    maxChoices: counts.length ? Math.max(...counts.map((c) => c.count)) : 0,
    northAlphabet: norths,
    westAlphabet: wests,
    alphabets: Object.fromEntries(DIRS.map((d) => [d, alphabet(tiles, d)])),
  };
}

// ----------------------------------------------------------------------------- placers

function emptyGrid(width, height) {
  return new Int32Array(width * height).fill(-1);
}

/**
 * Left to right, top to bottom, one pass, no backtracking.
 *
 * On a complete set this cannot fail, and it throws rather than degrading if it somehow
 * does, because a placer that quietly leaves a hole produces output that looks fine at a
 * glance and violates the whole point of the exercise. On an incomplete set it will strand
 * itself, and `naiveScanlineTrial` exists to measure how often.
 */
export function placeScanline(tiles, width, height, rng) {
  const grid = emptyGrid(width, height);
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      const north = r > 0 ? tiles[grid[(r - 1) * width + c]].s : null;
      const west = c > 0 ? tiles[grid[r * width + (c - 1)]].e : null;
      const options = [];
      for (let i = 0; i < tiles.length; i++) {
        if (north !== null && tiles[i].n !== north) continue;
        if (west !== null && tiles[i].w !== west) continue;
        options.push(i);
      }
      if (options.length === 0) {
        throw new Error(`scanline stranded at row ${r} column ${c} with north=${north} `
          + `west=${west}; this tile set is not complete, use the backtracking solver`);
      }
      grid[r * width + c] = options[rng.int(options.length)];
    }
  }
  return grid;
}

/**
 * One scanline attempt that reports failure instead of throwing.
 *
 * Used to put a number on what happens when you point a naive placer at a set that does not
 * guarantee it can be placed. The answer for the Jeandel-Rao set is that it strands almost
 * immediately, and the README quotes the measurement rather than an adjective.
 */
export function naiveScanlineTrial(tiles, width, height, rng) {
  const grid = emptyGrid(width, height);
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      const north = r > 0 ? tiles[grid[(r - 1) * width + c]].s : null;
      const west = c > 0 ? tiles[grid[r * width + (c - 1)]].e : null;
      const options = [];
      for (let i = 0; i < tiles.length; i++) {
        if (north !== null && tiles[i].n !== north) continue;
        if (west !== null && tiles[i].w !== west) continue;
        options.push(i);
      }
      if (options.length === 0) {
        return { ok: false, placed: r * width + c, row: r, column: c };
      }
      grid[r * width + c] = options[rng.int(options.length)];
    }
  }
  return { ok: true, placed: width * height, grid };
}

/**
 * Place a full colours^4 set by choosing the edge colours directly.
 *
 * For a full set every combination of four edge colours is a tile, so the grid of edge
 * colours can be chosen freely and the tiles read off afterwards. That makes seamless
 * wrapping exact and free: identify the last edge row with the first and the last edge
 * column with the first, and the tiling meets itself. No search, no failure mode.
 */
export function placeByEdges(tiles, width, height, rng, { torus = false } = {}) {
  const palette = alphabet(tiles, 'n');
  const size = palette.length;
  if (tiles.length !== size ** 4) {
    throw new Error(`placeByEdges needs a full set of ${size ** 4} tiles, got ${tiles.length}`);
  }
  const index = new Map();
  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i];
    index.set(`${t.n},${t.e},${t.s},${t.w}`, i);
  }
  // horizontal[r][c] is the colour of the horizontal edge above row r, for r in 0..height.
  const horizontal = [];
  for (let r = 0; r <= height; r++) {
    if (torus && r === height) { horizontal.push(horizontal[0].slice()); continue; }
    horizontal.push(Array.from({ length: width }, () => palette[rng.int(size)]));
  }
  // vertical[r][c] is the colour of the vertical edge left of column c, for c in 0..width.
  const vertical = [];
  for (let r = 0; r < height; r++) {
    const row = Array.from({ length: width + 1 }, () => palette[rng.int(size)]);
    if (torus) row[width] = row[0];
    vertical.push(row);
  }
  const grid = emptyGrid(width, height);
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      const key = `${horizontal[r][c]},${vertical[r][c + 1]},${horizontal[r + 1][c]},${vertical[r][c]}`;
      const found = index.get(key);
      if (found === undefined) throw new Error(`full set is missing tile ${key}`);
      grid[r * width + c] = found;
    }
  }
  return grid;
}

// ------------------------------------------------------- propagating backtracking solver

/**
 * Arc-consistent domains plus minimum-remaining-values backtracking.
 *
 * Needed for any set that is not complete, and for seamless wrapping of a set that is
 * complete but not full. The search is exhaustive within a step budget, so a result of
 * `unsat` means the solver looked everywhere and there is genuinely no tiling, while
 * `capped` means it ran out of budget and knows nothing. Collapsing those two into one
 * "no" would be the silent-failure pattern: the aperiodicity evidence in the test suite
 * depends on `unsat` meaning proven.
 */
export function solveConstrained(tiles, width, height, rng, options = {}) {
  const { torus = false, maxSteps = 200000 } = options;
  const count = tiles.length;
  const words = Math.ceil(count / 32);
  const cells = width * height;

  // compat[dir] maps a tile index to the bitset of tiles allowed in that direction.
  const right = new Uint32Array(count * words);
  const left = new Uint32Array(count * words);
  const down = new Uint32Array(count * words);
  const up = new Uint32Array(count * words);
  for (let i = 0; i < count; i++) {
    for (let j = 0; j < count; j++) {
      if (tiles[i].e === tiles[j].w) {
        right[i * words + (j >> 5)] |= 1 << (j & 31);
        left[j * words + (i >> 5)] |= 1 << (i & 31);
      }
      if (tiles[i].s === tiles[j].n) {
        down[i * words + (j >> 5)] |= 1 << (j & 31);
        up[j * words + (i >> 5)] |= 1 << (i & 31);
      }
    }
  }

  // A torus one cell wide wraps a tile onto itself, which is a unary constraint rather than
  // a binary one: the tile's east edge must equal its own west edge. Arc consistency between
  // distinct cells never sees it, so it is applied to the starting domains instead. Leaving
  // it out made the 1xN and Nx1 torus searches vacuously satisfiable, which in turn made the
  // aperiodicity evidence report nine periodic tilings that do not exist.
  const selfAllowed = (i) => {
    if (torus && width === 1 && tiles[i].e !== tiles[i].w) return false;
    if (torus && height === 1 && tiles[i].s !== tiles[i].n) return false;
    return true;
  };
  const fullMask = new Uint32Array(words);
  for (let i = 0; i < count; i++) {
    if (selfAllowed(i)) fullMask[i >> 5] |= 1 << (i & 31);
  }
  if (fullMask.every((word) => word === 0)) {
    return { status: 'unsat', steps: 0, grid: null };
  }

  const neighbours = (k) => {
    const r = (k / width) | 0;
    const c = k % width;
    const out = [];
    if (c + 1 < width) out.push([k + 1, right]);
    else if (torus && width > 1) out.push([r * width, right]);
    if (c > 0) out.push([k - 1, left]);
    else if (torus && width > 1) out.push([r * width + width - 1, left]);
    if (r + 1 < height) out.push([k + width, down]);
    else if (torus && height > 1) out.push([c, down]);
    if (r > 0) out.push([k - width, up]);
    else if (torus && height > 1) out.push([(height - 1) * width + c, up]);
    return out;
  };
  const neighbourCache = Array.from({ length: cells }, (_, k) => neighbours(k));

  function propagate(dom, seeds) {
    const queue = seeds.slice();
    const allowed = new Uint32Array(words);
    while (queue.length) {
      const k = queue.pop();
      for (const [m, table] of neighbourCache[k]) {
        allowed.fill(0);
        for (let word = 0; word < words; word++) {
          let bits = dom[k * words + word];
          while (bits) {
            const bit = bits & -bits;
            const i = (word << 5) + (31 - Math.clz32(bit >>> 0));
            bits ^= bit;
            for (let x = 0; x < words; x++) allowed[x] |= table[i * words + x];
          }
        }
        let changed = false;
        let empty = true;
        for (let x = 0; x < words; x++) {
          const before = dom[m * words + x];
          const after = before & allowed[x];
          if (after !== before) { dom[m * words + x] = after; changed = true; }
          if (after !== 0) empty = false;
        }
        if (empty) return false;
        if (changed) queue.push(m);
      }
    }
    return true;
  }

  const popcount = (dom, k) => {
    let total = 0;
    for (let x = 0; x < words; x++) {
      let v = dom[k * words + x];
      v -= (v >>> 1) & 0x55555555;
      v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
      total += (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
    }
    return total;
  };

  const domain = new Uint32Array(cells * words);
  for (let k = 0; k < cells; k++) domain.set(fullMask, k * words);

  let steps = 0;
  let capped = false;

  function search(dom) {
    if (steps >= maxSteps) { capped = true; return null; }
    steps++;
    let best = -1;
    let bestCount = Infinity;
    for (let k = 0; k < cells; k++) {
      const n = popcount(dom, k);
      if (n > 1 && n < bestCount) { bestCount = n; best = k; }
    }
    if (best < 0) return dom;
    const options = [];
    for (let i = 0; i < count; i++) {
      if (dom[best * words + (i >> 5)] & (1 << (i & 31))) options.push(i);
    }
    for (const i of rng.shuffle(options)) {
      const next = dom.slice();
      next.fill(0, best * words, best * words + words);
      next[best * words + (i >> 5)] = 1 << (i & 31);
      if (propagate(next, [best])) {
        const result = search(next);
        if (result) return result;
      }
      if (capped) return null;
    }
    return null;
  }

  const seeds = Array.from({ length: cells }, (_, k) => k);
  if (!propagate(domain, seeds)) {
    return { status: 'unsat', steps: 0, grid: null };
  }
  const solved = search(domain);
  if (solved) {
    const grid = emptyGrid(width, height);
    for (let k = 0; k < cells; k++) {
      for (let i = 0; i < count; i++) {
        if (solved[k * words + (i >> 5)] & (1 << (i & 31))) { grid[k] = i; break; }
      }
    }
    return { status: 'sat', steps, grid };
  }
  return { status: capped ? 'capped' : 'unsat', steps, grid: null };
}

// ------------------------------------------------------------------- the matching check

/**
 * Every interior edge must have the same colour on both sides.
 *
 * Returns the list of violations rather than a boolean, so a caller can say what broke.
 * On a torus the wrap edges are interior too, which is exactly what makes the output
 * seamless, so they are checked the same way.
 */
export function checkEdgeMatching(tiles, grid, width, height, { torus = false } = {}) {
  const violations = [];
  const at = (r, c) => tiles[grid[r * width + c]];
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      const here = at(r, c);
      if (here === undefined) {
        violations.push({ row: r, column: c, edge: 'cell', detail: 'no tile placed' });
        continue;
      }
      const hasEast = c + 1 < width || (torus && width > 1);
      if (hasEast) {
        const other = at(r, (c + 1) % width);
        if (here.e !== other.w) {
          violations.push({
            row: r, column: c, edge: 'east',
            detail: `east ${here.e} against west ${other.w}`,
          });
        }
      }
      const hasSouth = r + 1 < height || (torus && height > 1);
      if (hasSouth) {
        const other = at((r + 1) % height, c);
        if (here.s !== other.n) {
          violations.push({
            row: r, column: c, edge: 'south',
            detail: `south ${here.s} against north ${other.n}`,
          });
        }
      }
    }
  }
  return violations;
}
