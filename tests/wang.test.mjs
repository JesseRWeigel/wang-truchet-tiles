import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildTileSet, completenessReport, fullSet, reducedCompleteSet, jeandelRaoSet,
  placeScanline, placeByEdges, solveConstrained, checkEdgeMatching, naiveScanlineTrial,
  alphabet, TILE_SETS,
} from '../src/wang.mjs';
import { makeRng } from '../src/rng.mjs';

const COMPLETE_SETS = ['stochastic-2', 'stochastic-3', 'stochastic-4', 'full-2', 'full-3'];

test('completeness is checked pair by pair, not assumed', () => {
  for (const name of COMPLETE_SETS) {
    const { tiles } = buildTileSet(name);
    const report = completenessReport(tiles);

    // Recomputed here from the definition rather than trusting the report, so a bug in
    // completenessReport cannot make a set look complete in both places at once.
    const souths = [...new Set(tiles.map((t) => t.s))];
    const easts = [...new Set(tiles.map((t) => t.e))];
    for (const north of souths) {
      for (const west of easts) {
        const admissible = tiles.filter((t) => t.n === north && t.w === west);
        assert.ok(admissible.length >= 1,
          `${name} has no tile for north=${north} west=${west}, so a scanline placer stalls`);
      }
    }
    assert.equal(report.complete, true, `${name} should be complete`);
    assert.equal(report.pairs, souths.length * easts.length);
    assert.ok(report.minChoices >= 1);
  }
});

test('a reduced complete set has exactly the requested number of choices per pair', () => {
  for (const colours of [2, 3, 4]) {
    for (const choices of [1, 2, 3]) {
      if (choices > colours * colours) continue;
      const tiles = reducedCompleteSet(colours, choices);
      assert.equal(tiles.length, colours * colours * choices);
      const report = completenessReport(tiles);
      assert.equal(report.complete, true);
      assert.equal(report.minChoices, choices);
      assert.equal(report.maxChoices, choices);
      // Both derived alphabets must cover every colour, otherwise the "colours" claim is
      // wrong and some colour can never appear on an east or south edge.
      assert.deepEqual(alphabet(tiles, 'e'), [...Array(colours).keys()]);
      assert.deepEqual(alphabet(tiles, 's'), [...Array(colours).keys()]);
    }
  }
});

test('the Jeandel-Rao set is deliberately not complete', () => {
  const tiles = jeandelRaoSet();
  assert.equal(tiles.length, 11);
  const report = completenessReport(tiles);
  assert.equal(report.complete, false);
  assert.ok(report.missing.length > 0);
  assert.equal(report.minChoices, 0);
  // The transcription's shape, checked so a mistyped digit shows up as a failing test and
  // not as a subtly different tiling.
  assert.deepEqual(alphabet(tiles, 'e'), [0, 1, 2, 3]);
  assert.deepEqual(alphabet(tiles, 'w'), [0, 1, 2, 3]);
  assert.deepEqual(alphabet(tiles, 'n'), [0, 1, 2, 3, 4]);
  assert.deepEqual(alphabet(tiles, 's'), [0, 1, 2, 3, 4]);
});

test('a full set really contains every combination, with no duplicates', () => {
  for (const colours of [2, 3]) {
    const tiles = fullSet(colours);
    assert.equal(tiles.length, colours ** 4);
    const keys = new Set(tiles.map((t) => `${t.n},${t.e},${t.s},${t.w}`));
    assert.equal(keys.size, tiles.length, 'a full set must not repeat a tile');
  }
});

test('scanline placement leaves no unmatched interior edge, over many generated tilings', () => {
  let tilings = 0;
  for (const name of COMPLETE_SETS) {
    const { tiles } = buildTileSet(name);
    for (const size of [1, 2, 5, 13, 24]) {
      for (let seed = 0; seed < 6; seed++) {
        const rng = makeRng(`scanline|${name}|${size}|${seed}`);
        const grid = placeScanline(tiles, size, size, rng);
        const violations = checkEdgeMatching(tiles, grid, size, size);
        assert.equal(violations.length, 0,
          `${name} ${size}x${size} seed ${seed}: ${JSON.stringify(violations.slice(0, 3))}`);
        assert.ok(grid.every((index) => index >= 0 && index < tiles.length));
        tilings += 1;
      }
    }
  }
  assert.ok(tilings >= 100, `only generated ${tilings} tilings, that is not a sweep`);
});

test('non-square grids are placed correctly too', () => {
  const { tiles } = buildTileSet('stochastic-3');
  for (const [width, height] of [[1, 9], [9, 1], [3, 17], [17, 3]]) {
    const rng = makeRng(`rect|${width}|${height}`);
    const grid = placeScanline(tiles, width, height, rng);
    assert.equal(checkEdgeMatching(tiles, grid, width, height).length, 0);
  }
});

test('a full set wraps seamlessly, wrap edges included', () => {
  for (const name of ['full-2', 'full-3']) {
    const { tiles } = buildTileSet(name);
    for (const size of [2, 3, 8, 15]) {
      const rng = makeRng(`torus|${name}|${size}`);
      const grid = placeByEdges(tiles, size, size, rng, { torus: true });
      assert.equal(checkEdgeMatching(tiles, grid, size, size, { torus: true }).length, 0,
        `${name} ${size}x${size} does not wrap`);
    }
  }
});

test('the reduced complete sets wrap seamlessly through the solver', () => {
  for (const name of ['stochastic-2', 'stochastic-3']) {
    const { tiles } = buildTileSet(name);
    for (const size of [4, 7, 12]) {
      const rng = makeRng(`solvertorus|${name}|${size}`);
      const result = solveConstrained(tiles, size, size, rng, { torus: true, maxSteps: 100000 });
      assert.equal(result.status, 'sat', `${name} ${size}x${size}: ${result.status}`);
      assert.equal(checkEdgeMatching(tiles, result.grid, size, size, { torus: true }).length, 0);
    }
  }
});

// ------------------------------------------------------------------- the negative control

test('the edge-match checker catches a single corrupted placement', () => {
  const { tiles } = buildTileSet('stochastic-3');
  const size = 8;
  const rng = makeRng('negative-control');
  const grid = placeScanline(tiles, size, size, rng);
  assert.equal(checkEdgeMatching(tiles, grid, size, size).length, 0, 'baseline must be clean');

  // Swap one interior cell for a tile that genuinely disagrees with a neighbour. Picking a
  // replacement at random would sometimes pick a tile that happens to match, and the test
  // would pass or fail depending on the seed.
  const row = 4;
  const column = 4;
  const index = row * size + column;
  const west = tiles[grid[row * size + (column - 1)]].e;
  const replacement = tiles.findIndex((t) => t.w !== west);
  assert.ok(replacement >= 0, 'the set should contain a tile that does not fit here');

  const corrupted = grid.slice();
  corrupted[index] = replacement;
  const violations = checkEdgeMatching(tiles, corrupted, size, size);
  assert.ok(violations.length > 0, 'a corrupted placement went unnoticed, so the checker is inert');
  const touched = violations.some((v) => (v.row === row && v.column === column)
    || (v.row === row && v.column === column - 1)
    || (v.row === row - 1 && v.column === column));
  assert.ok(touched, `violations should name the corrupted cell: ${JSON.stringify(violations)}`);
});

test('every single-cell corruption that touches a constrained edge is caught', () => {
  // The check above proves the checker can fire. This proves it fires everywhere, which is
  // the property that matters: a checker that only inspects the first row would pass it.
  //
  // The qualifier is not a let-out. On an open boundary the outer edges of the grid face
  // nothing, so a replacement that changes only the north edge of a cell in the top row
  // changes nothing any checker could see, and demanding it be caught would be demanding a
  // false positive. So each corruption is classified first, by comparing edge by edge
  // against the neighbours that exist, and then both directions are asserted: every
  // corruption that moves a constrained edge is caught, and every corruption that does not
  // is passed. The second half is what keeps this from being satisfied by a checker that
  // simply reports a violation for everything.
  const { tiles } = buildTileSet('stochastic-2');
  const size = 5;
  const rng = makeRng('sweep-control');
  const grid = placeScanline(tiles, size, size, rng);
  let observable = 0;
  let caught = 0;
  let unobservable = 0;
  let falsePositives = 0;
  for (let cell = 0; cell < size * size; cell++) {
    const row = (cell / size) | 0;
    const column = cell % size;
    const original = tiles[grid[cell]];
    for (let replacement = 0; replacement < tiles.length; replacement++) {
      if (replacement === grid[cell]) continue;
      const swapped = tiles[replacement];
      // A replacement can legitimately still fit; only count the ones that do not.
      const fits = swapped.n === original.n && swapped.e === original.e
        && swapped.s === original.s && swapped.w === original.w;
      if (fits) continue;
      const moves = (swapped.n !== original.n && row > 0)
        || (swapped.w !== original.w && column > 0)
        || (swapped.e !== original.e && column + 1 < size)
        || (swapped.s !== original.s && row + 1 < size);
      const corrupted = grid.slice();
      corrupted[cell] = replacement;
      const violations = checkEdgeMatching(tiles, corrupted, size, size);
      if (moves) {
        observable += 1;
        if (violations.length > 0) caught += 1;
      } else {
        unobservable += 1;
        if (violations.length > 0) falsePositives += 1;
      }
    }
  }
  assert.ok(observable > 100, `only ${observable} observable corruptions tried`);
  assert.equal(caught, observable,
    `${observable - caught} of ${observable} observable corruptions were missed`);
  assert.ok(unobservable > 0,
    'no corruption landed on a boundary edge, so the classification was never exercised');
  assert.equal(falsePositives, 0,
    `${falsePositives} corruptions of an unconstrained boundary edge were reported as violations`);
});

test('the checker sees wrap edges only when asked', () => {
  const { tiles } = buildTileSet('full-2');
  const size = 4;
  const rng = makeRng('wrap-control');
  // An open-boundary tiling almost never happens to wrap, so asking the checker to inspect
  // the wrap edges must produce violations where the open check produced none.
  const grid = placeByEdges(tiles, size, size, rng, { torus: false });
  assert.equal(checkEdgeMatching(tiles, grid, size, size, { torus: false }).length, 0);
  const wrapped = checkEdgeMatching(tiles, grid, size, size, { torus: true });
  assert.ok(wrapped.length > 0,
    'an open-boundary tiling passed the wrap check, so the wrap check is not looking');
});

// -------------------------------------------------------------- the aperiodic tile set

test('the Jeandel-Rao set tiles large squares', () => {
  const tiles = jeandelRaoSet();
  for (const size of [8, 16, 24]) {
    const rng = makeRng(`jr|${size}`);
    const result = solveConstrained(tiles, size, size, rng, { maxSteps: 200000 });
    assert.equal(result.status, 'sat', `${size}x${size} came back ${result.status}`);
    assert.equal(checkEdgeMatching(tiles, result.grid, size, size).length, 0);
  }
});

test('the Jeandel-Rao set admits no torus tiling up to 5x5, searched exhaustively', () => {
  // Necessary condition for aperiodicity, and the check that caught a mistranscribed digit.
  // A set that admits a periodic tiling admits one on the torus of that period, so finding
  // any torus tiling here would disprove aperiodicity outright.
  //
  // This does not prove aperiodicity. Jeandel and Rao proved that (arXiv:1506.06492); what
  // is proven here is that this transcription has not silently become a different set.
  const tiles = jeandelRaoSet();
  const found = [];
  for (let height = 1; height <= 5; height++) {
    for (let width = 1; width <= 5; width++) {
      const rng = makeRng(`jrtorus|${height}|${width}`);
      const result = solveConstrained(tiles, width, height, rng,
        { torus: true, maxSteps: 500000 });
      assert.notEqual(result.status, 'capped',
        `the ${height}x${width} torus search ran out of budget, so it proves nothing`);
      if (result.status === 'sat') found.push(`${height}x${width}`);
    }
  }
  assert.deepEqual(found, [], `periodic tilings found: ${found.join(', ')}`);
});

test('the torus search can find a torus tiling when one exists', () => {
  // Without this the test above is satisfied by a search that always answers "unsat".
  const { tiles } = buildTileSet('full-2');
  for (const [width, height] of [[1, 1], [2, 3], [4, 4]]) {
    const rng = makeRng(`positive|${width}|${height}`);
    const result = solveConstrained(tiles, width, height, rng, { torus: true, maxSteps: 100000 });
    assert.equal(result.status, 'sat', `full-2 should tile a ${height}x${width} torus`);
    assert.equal(checkEdgeMatching(tiles, result.grid, width, height, { torus: true }).length, 0);
  }
});

test('a one-cell torus is only satisfiable by a self-consistent tile', () => {
  // The unary constraint the first version of the solver missed entirely.
  const tiles = jeandelRaoSet();
  const selfConsistent = tiles.filter((t) => t.e === t.w && t.n === t.s);
  assert.equal(selfConsistent.length, 0,
    'no Jeandel-Rao tile matches itself in both directions, so no 1x1 torus tiling exists');
  const result = solveConstrained(tiles, 1, 1, makeRng('one'), { torus: true });
  assert.equal(result.status, 'unsat');
});

test('naive scanline succeeds always on complete sets and never on the aperiodic one', () => {
  for (const name of COMPLETE_SETS) {
    const { tiles } = buildTileSet(name);
    for (let trial = 0; trial < 40; trial++) {
      const rng = makeRng(`naive|${name}|${trial}`);
      assert.equal(naiveScanlineTrial(tiles, 12, 12, rng).ok, true,
        `${name} stranded a naive scanline pass, so it is not complete after all`);
    }
  }
  const jr = jeandelRaoSet();
  let succeeded = 0;
  for (let trial = 0; trial < 200; trial++) {
    if (naiveScanlineTrial(jr, 16, 16, makeRng(`naivejr|${trial}`)).ok) succeeded += 1;
  }
  assert.equal(succeeded, 0,
    `naive scanline placed the aperiodic set ${succeeded}/200 times, which contradicts the `
    + 'claim that it needs the solver');
});

test('every named tile set builds and reports its own shape', () => {
  for (const name of Object.keys(TILE_SETS)) {
    const built = buildTileSet(name);
    assert.ok(built.tiles.length > 0);
    assert.ok(typeof built.label === 'string' && built.label.length > 0);
    assert.ok(typeof built.note === 'string' && built.note.length > 0);
  }
  assert.throws(() => buildTileSet('no-such-set'), /unknown tile set/);
});
