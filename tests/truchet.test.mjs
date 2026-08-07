// Curve continuity, over generated fields rather than over fixtures.
//
// The claim being tested is the one that is usually wrong in a Truchet implementation: the
// curves join. Every test here generates fields from the real placer and traces the result,
// and every positive test has a negative control beside it, because a continuity checker
// that returns an empty list unconditionally would pass all of the positive ones.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  arcField, freeQuarterArcField, diagonalField, freeDiagonalField, quarterArcEdges,
  checkArcContinuity, checkDiagonalContinuity, enumerateValidDiagonalFields,
} from '../src/truchet.mjs';
import { buildModel, checkModel, rollModel } from '../src/model.mjs';
import { buildPrimitives } from '../src/geometry.mjs';
import { getPalette, colourFor } from '../src/palette.mjs';
import { makeRng } from '../src/rng.mjs';

const SIZES = [[1, 1], [2, 2], [3, 7], [7, 3], [8, 8], [13, 11]];

test('Smith arc fields are continuous at every interior edge, open and wrapped', () => {
  let checked = 0;
  for (const [width, height] of SIZES) {
    for (const torus of [false, true]) {
      for (let seed = 0; seed < 5; seed++) {
        const rng = makeRng(`arc|${width}|${height}|${torus}|${seed}`);
        const field = arcField(width, height, rng);
        const violations = checkArcContinuity(field, width, height, { torus, family: 'arcs' });
        assert.equal(violations.length, 0,
          `${width}x${height} torus=${torus} seed ${seed}: ${JSON.stringify(violations[0])}`);
        checked += 1;
      }
    }
  }
  assert.ok(checked >= 50, `only ${checked} fields checked`);
});

test('the single quarter arc field is caught, which is what makes the checker real', () => {
  // The negative control for arcs. This family is the classic mistake: one arc in a random
  // corner touches two edges out of four, so endpoints meet blanks. If this ever comes back
  // clean, the arc checker has stopped looking and every positive test above is worthless.
  let totalViolations = 0;
  let fields = 0;
  for (const [width, height] of SIZES) {
    if (width * height < 4) continue;
    for (let seed = 0; seed < 5; seed++) {
      const rng = makeRng(`quarter|${width}|${height}|${seed}`);
      const field = freeQuarterArcField(width, height, rng);
      const violations = checkArcContinuity(field, width, height, { family: 'arcs-free' });
      assert.ok(violations.length > 0,
        `${width}x${height} seed ${seed} produced no dangling endpoint, so the checker is inert`);
      totalViolations += violations.length;
      fields += 1;
    }
  }
  // Roughly half of all interior edges should dangle. Asserting a floor as well as
  // "more than zero" catches a checker that only ever inspects one edge.
  assert.ok(totalViolations / fields > 5,
    `only ${(totalViolations / fields).toFixed(1)} violations per field on average`);
});

test('quarterArcEdges touches exactly two edges, and adjacent ones', () => {
  for (let corner = 0; corner < 4; corner++) {
    const edges = quarterArcEdges(corner);
    assert.equal(edges.filter(Boolean).length, 2, `corner ${corner} should touch two edges`);
    // North and south, or east and west, would be a half circle rather than a quarter arc.
    assert.ok(!(edges[0] && edges[2]), 'a quarter arc cannot touch both horizontal edges');
    assert.ok(!(edges[1] && edges[3]), 'a quarter arc cannot touch both vertical edges');
  }
  assert.throws(() => quarterArcEdges(4), /corner must be 0..3/);
});

test('constrained diagonal fields have no dangling end at any interior vertex', () => {
  let checked = 0;
  for (const [width, height] of SIZES) {
    for (const torus of [false, true]) {
      for (let seed = 0; seed < 5; seed++) {
        const rng = makeRng(`diag|${width}|${height}|${torus}|${seed}`);
        const field = diagonalField(width, height, rng);
        const violations = checkDiagonalContinuity(field, width, height, { torus });
        assert.equal(violations.length, 0,
          `${width}x${height} torus=${torus} seed ${seed}: ${JSON.stringify(violations[0])}`);
        checked += 1;
      }
    }
  }
  assert.ok(checked >= 50, `only ${checked} fields checked`);
});

test('unconstrained diagonals dangle, and the checker says where', () => {
  // The negative control for diagonals.
  let fields = 0;
  let odd = 0;
  let interior = 0;
  for (const [width, height] of [[4, 4], [8, 8], [11, 7]]) {
    for (let seed = 0; seed < 8; seed++) {
      const rng = makeRng(`freediag|${width}|${height}|${seed}`);
      const field = freeDiagonalField(width, height, rng);
      const violations = checkDiagonalContinuity(field, width, height);
      assert.ok(violations.length > 0,
        `${width}x${height} seed ${seed} came back clean, so the diagonal checker is inert`);
      for (const violation of violations) {
        assert.ok(violation.degree % 2 === 1, 'a reported vertex must actually be odd');
        assert.ok(violation.vertexRow >= 1 && violation.vertexRow < height);
        assert.ok(violation.vertexColumn >= 1 && violation.vertexColumn < width);
      }
      odd += violations.length;
      interior += (width - 1) * (height - 1);
      fields += 1;
    }
  }
  // Each interior vertex is odd with probability 1/2 under a uniform field, so the observed
  // fraction should sit near a half. A checker that fires on everything would read 1.0.
  const fraction = odd / interior;
  assert.ok(fraction > 0.35 && fraction < 0.65,
    `${(fraction * 100).toFixed(1)}% of interior vertices were odd across ${fields} fields, `
    + 'which is not the coin flip an unconstrained field should give');
});

test('the closed form generates exactly the valid diagonal fields, counted by brute force', () => {
  // Ground truth by enumeration over all 2^(w*h) fields, which shares no code with the
  // generator. Both the count and the membership are checked: a generator that produced one
  // valid field forever would satisfy membership alone.
  for (const [width, height] of [[2, 2], [3, 3], [4, 3], [4, 4]]) {
    const valid = new Set(enumerateValidDiagonalFields(width, height));
    assert.equal(valid.size, 2 ** (width + height - 1),
      `${width}x${height}: brute force found ${valid.size} valid fields, `
      + `the closed form predicts ${2 ** (width + height - 1)}`);

    const produced = new Set();
    for (let seed = 0; seed < 400; seed++) {
      const field = diagonalField(width, height, makeRng(`enum|${width}|${height}|${seed}`));
      let mask = 0;
      for (let i = 0; i < field.length; i++) if (field[i]) mask |= 1 << i;
      assert.ok(valid.has(mask),
        `${width}x${height} seed ${seed} generated a field brute force calls invalid`);
      produced.add(mask);
    }
    // With 400 draws over at most 128 fields, coverage should be most of the space. This is
    // the guard against a generator that is valid and nearly constant.
    assert.ok(produced.size > valid.size * 0.6,
      `${width}x${height}: only ${produced.size} of ${valid.size} valid fields were reachable`);
  }
});

test('rolling a wrapped field gives another field the checker accepts', () => {
  // A torus tiling shifted by whole cells is still a tiling of the same torus. If it were
  // not, the exact seamlessness test in the raster suite would be comparing two different
  // things and its byte equality would mean nothing.
  for (const family of ['arcs', 'diagonals']) {
    const model = buildModel({ family, width: 9, height: 6, seed: 'roll', torus: true });
    assert.equal(checkModel(model).violations.length, 0);
    for (const [dr, dc] of [[1, 0], [0, 1], [3, 5], [-2, -4]]) {
      const rolled = rollModel(model, dr, dc);
      assert.equal(checkModel(rolled).violations.length, 0,
        `${family} shifted by ${dr},${dc} stopped being continuous`);
    }
  }
});

test('a corrupted diagonal field is caught wherever the corruption lands', () => {
  // The sweep form of the negative control: flip one cell of a valid field and the vertices
  // around it must go odd. Every cell is tried, so a checker looking only at the first row
  // fails here even though it would pass the single-corruption test.
  const width = 6;
  const height = 5;
  const base = diagonalField(width, height, makeRng('corrupt'));
  assert.equal(checkDiagonalContinuity(base, width, height).length, 0);
  for (let cell = 0; cell < width * height; cell++) {
    const corrupted = Uint8Array.from(base);
    corrupted[cell] ^= 1;
    const violations = checkDiagonalContinuity(corrupted, width, height);
    assert.ok(violations.length > 0,
      `flipping cell ${cell} went unnoticed by the interior vertex check`);
    // A single flip touches the up to four vertices at its own corners and nothing else.
    const row = (cell / width) | 0;
    const column = cell % width;
    for (const violation of violations) {
      assert.ok(Math.abs(violation.vertexRow - row) <= 1 && Math.abs(violation.vertexColumn - column) <= 1,
        `flipping cell ${row},${column} reported a violation at `
        + `${violation.vertexRow},${violation.vertexColumn}, which it cannot have caused`);
    }
  }
});

test('the wrap edges are inspected only when asked, and they really are inspected', () => {
  // Continuity across the seam is an extra condition, so the torus check must see everything
  // the open check sees and more. Asserting containment as well as "more violations" catches
  // a torus mode that inspects the seam and forgets the interior.
  let extraOnBoundary = 0;
  for (const [width, height] of [[5, 4], [9, 6], [3, 8]]) {
    for (let seed = 0; seed < 6; seed++) {
      const field = freeQuarterArcField(width, height, makeRng(`wrap|${width}|${height}|${seed}`));
      const key = (v) => `${v.row},${v.column},${v.edge}`;
      const open = new Set(checkArcContinuity(field, width, height, { family: 'arcs-free' }).map(key));
      const wrapped = checkArcContinuity(field, width, height,
        { torus: true, family: 'arcs-free' }).map(key);
      const wrappedSet = new Set(wrapped);
      for (const violation of open) {
        assert.ok(wrappedSet.has(violation),
          `the torus check lost the interior violation at ${violation}`);
      }
      for (const violation of wrapped) {
        if (open.has(violation)) continue;
        const [row, column, edge] = violation.split(',');
        const onSeam = (edge === 'east' && Number(column) === width - 1)
          || (edge === 'south' && Number(row) === height - 1);
        assert.ok(onSeam, `the torus check invented an interior violation at ${violation}`);
        extraOnBoundary += 1;
      }
    }
  }
  assert.ok(extraOnBoundary > 0,
    'no seam violation was found in any field, so the wrap edges are not being inspected');
});

test('a torus one cell wide glues a cell to itself, and the check knows it', () => {
  // The unary case. The neighbour loop has no neighbour to compare against here, so without
  // an explicit self-check every 1xN and Nx1 torus reports clean whatever it contains.
  // Smith arcs survive it because every edge carries an endpoint; the quarter arc does not.
  for (const [width, height] of [[1, 1], [1, 7], [7, 1]]) {
    const arcs = arcField(width, height, makeRng(`unary|${width}|${height}`));
    assert.equal(checkArcContinuity(arcs, width, height, { torus: true, family: 'arcs' }).length, 0,
      'Smith arcs present an endpoint at all four edges, so gluing a cell to itself is fine');
  }
  // north-west, so north and west carry endpoints and east and south are blank.
  const single = Uint8Array.from([0]);
  const open = checkArcContinuity(single, 1, 1, { family: 'arcs-free' });
  assert.equal(open.length, 0, 'with no torus a single cell has no interior edge at all');
  const glued = checkArcContinuity(single, 1, 1, { torus: true, family: 'arcs-free' });
  assert.equal(glued.length, 2,
    `both the horizontal and the vertical gluing must be reported: ${JSON.stringify(glued)}`);
});

test('every family renders to primitives, and the counterexamples still render', () => {
  // A family that throws while drawing is a family the tool cannot show, and the whole point
  // of keeping the broken families is that a person can look at them.
  const palette = getPalette('indigo');
  for (const family of ['wang', 'arcs', 'arcs-free', 'diagonals', 'diagonals-free']) {
    const model = buildModel({ family, width: 5, height: 4, seed: 'render', bands: 3 });
    const scene = buildPrimitives(model, { palette, colourFor, cell: 100, bands: 3 });
    assert.equal(scene.width, 500);
    assert.equal(scene.height, 400);
    assert.ok(scene.shapes.length >= 20, `${family} produced only ${scene.shapes.length} shapes`);
    for (const shape of scene.shapes) {
      assert.ok(['polygon', 'arc', 'segment'].includes(shape.kind));
    }
  }
});
