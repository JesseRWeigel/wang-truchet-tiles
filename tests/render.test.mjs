// Rendering, determinism, and the exact seamlessness test.
//
// "A named seed reproduces a tiling exactly" is a claim about bytes, so it is tested against
// bytes: the same options twice, in the same process and in two separate processes, and
// against a hash recorded in this file. The hash is what catches a change that is
// deterministic and different, which is the failure mode the same-run comparison cannot see.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

import { buildModel, checkModel, rollModel, DEFAULTS } from '../src/model.mjs';
import { buildPrimitives, bandRadii, assertSymmetricRadii, bandColourIndex } from '../src/geometry.mjs';
import { getPalette, colourFor, paletteNames, parseHex } from '../src/palette.mjs';
import { toSvg, num, arcPath } from '../src/svg.mjs';
import { rasterise, rollImage, imageDifference, insideTriangle } from '../src/raster.mjs';
import { encodePng, readPngHeader } from '../src/png.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function render(options, { cell = 100, printWidthMm = 200 } = {}) {
  const model = buildModel(options);
  const palette = getPalette(options.palette ?? DEFAULTS.palette);
  const scene = buildPrimitives(model, {
    palette, colourFor, cell, weight: model.weight, bands: model.bands,
  });
  return { model, scene, svg: toSvg(scene, { printWidthMm, title: 'test' }) };
}

const sha = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);

// Recorded from a real run. Regenerate deliberately if the geometry changes on purpose, and
// never by copying whatever the failing run printed without looking at the picture first.
const GOLDEN = {
  'wang stochastic-3 triangles': '285755d2305063d4',
  'wang full-2 arcs': 'f7bdd87d1baf35bb',
  arcs: '2097133a7163332d',
  diagonals: '60446dd6ee6f674e',
};

const GOLDEN_CASES = {
  'wang stochastic-3 triangles': {
    family: 'wang', set: 'stochastic-3', style: 'triangles', width: 6, height: 5,
    seed: 'golden', palette: 'indigo', bands: 1, weight: 0.16,
  },
  'wang full-2 arcs': {
    family: 'wang', set: 'full-2', style: 'arcs', width: 6, height: 5,
    seed: 'golden', palette: 'terracotta', bands: 3, weight: 0.14,
  },
  arcs: {
    family: 'arcs', width: 7, height: 4, seed: 'golden', palette: 'neon', bands: 5, weight: 0.1,
  },
  diagonals: {
    family: 'diagonals', width: 7, height: 4, seed: 'golden', palette: 'slate',
    bands: 1, weight: 0.2,
  },
};

test('the same seed gives byte for byte identical SVG, and a different seed does not', () => {
  for (const [name, options] of Object.entries(GOLDEN_CASES)) {
    const first = render(options).svg;
    const second = render({ ...options }).svg;
    assert.equal(first, second, `${name} rendered differently on the second call`);
    const other = render({ ...options, seed: `${options.seed}-x` }).svg;
    assert.notEqual(first, other, `${name} ignored the seed, so the seed is decorative`);
  }
});

test('a recorded seed still produces the recorded bytes', () => {
  for (const [name, options] of Object.entries(GOLDEN_CASES)) {
    assert.equal(sha(render(options).svg), GOLDEN[name],
      `${name} no longer reproduces its recorded rendering. If the geometry changed on `
      + 'purpose, look at the new picture and then update GOLDEN in this file.');
  }
});

test('two separate node processes agree byte for byte', () => {
  // The in-process comparison cannot see a dependence on module load order, on a cached
  // value, or on anything else that survives inside one process. This can.
  const dir = mkdtempSync(join(tmpdir(), 'wt-determinism-'));
  try {
    const digests = [];
    for (const attempt of [0, 1]) {
      const out = join(dir, `run-${attempt}.svg`);
      execFileSync(process.execPath, [
        join(root, 'src', 'cli.mjs'), 'svg', '--out', out,
        '--family', 'wang', '--set', 'stochastic-4', '--width', '9', '--height', '7',
        '--seed', 'cross-process', '--bands', '3',
      ], { cwd: root, stdio: 'pipe' });
      digests.push(sha(readFileSync(out, 'utf8')));
    }
    assert.equal(digests[0], digests[1], 'two processes disagreed about the same seed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the number formatter is stable and refuses what it cannot format', () => {
  assert.equal(num(0), '0');
  assert.equal(num(-0), '0');
  assert.equal(num(1), '1');
  assert.equal(num(1.5), '1.5');
  assert.equal(num(100), '100');
  assert.equal(num(1 / 3), '0.3333');
  assert.equal(num(0.00001), '0');
  assert.equal(num(-2.25), '-2.25');
  // 10 must not lose its zero to the trailing-zero strip, which is the bug this catches.
  assert.equal(num(10), '10');
  assert.equal(num(1000), '1000');
  assert.throws(() => num(NaN), /cannot format/);
  assert.throws(() => num(Infinity), /cannot format/);
});

test('band radii are symmetric about half a cell, and asymmetry is refused', () => {
  for (const bands of [1, 2, 3, 4, 5, 6, 7]) {
    const radii = bandRadii(100, bands);
    assert.equal(radii.length, bands);
    assert.ok(assertSymmetricRadii(radii, 100));
    for (const r of radii) assert.ok(r > 0 && r < 100, `radius ${r} leaves the cell`);
  }
  // The guard has to fire, or an asymmetric set would draw curves that stop short at every
  // edge and nothing would say so.
  assert.throws(() => assertSymmetricRadii([10, 20, 30], 100), /symmetric about half a cell/);
  assert.throws(() => assertSymmetricRadii([49], 100), /symmetric about half a cell/);
});

test('band colours pair across an edge so a curve keeps its colour', () => {
  // Band j on one side of an edge meets band (count - 1 - j) on the other. Colouring by the
  // raw index would change colour at every edge crossing, which looks like a broken curve
  // even when the geometry is exact.
  for (const count of [1, 2, 3, 5, 7]) {
    for (let j = 0; j < count; j++) {
      assert.equal(bandColourIndex(j, count), bandColourIndex(count - 1 - j, count),
        `band ${j} of ${count} does not share a colour with the band it meets`);
    }
  }
});

test('an arc path starts and ends on the circle it names', () => {
  for (const from of [0, 90, 180, 270]) {
    const path = arcPath({ cx: 50, cy: 50, r: 50, from, to: from + 90 });
    const numbers = path.match(/-?\d+(\.\d+)?/g).map(Number);
    const [x1, y1] = numbers;
    const [x2, y2] = numbers.slice(-2);
    assert.ok(Math.abs(Math.hypot(x1 - 50, y1 - 50) - 50) < 1e-3, `start is off the circle: ${path}`);
    assert.ok(Math.abs(Math.hypot(x2 - 50, y2 - 50) - 50) < 1e-3, `end is off the circle: ${path}`);
  }
});

test('the SVG carries physical units and the whole picture inside the viewBox', () => {
  const { svg, scene } = render(GOLDEN_CASES.arcs);
  assert.match(svg, /width="200mm"/);
  assert.match(svg, /viewBox="0 0 700 400"/);
  assert.ok(!svg.includes('<use'), 'a <use> would hide the geometry from the independent check');
  assert.ok(!svg.includes('transform='), 'a transform would hide the geometry from the check');
  const coordinates = svg.match(/-?\d+(\.\d+)?/g).map(Number);
  assert.ok(coordinates.length > 100);
  assert.ok(scene.shapes.length > 0);
});

test('a palette that cannot colour a tile set says so instead of reusing a colour', () => {
  for (const name of paletteNames()) {
    const palette = getPalette(name);
    assert.ok(palette.colours.length >= 6,
      `${name} has only ${palette.colours.length} colours, too few for the Jeandel-Rao set`);
    for (const hex of [...palette.colours, palette.background, palette.ink]) {
      const rgb = parseHex(hex);
      assert.equal(rgb.length, 3);
      for (const channel of rgb) assert.ok(channel >= 0 && channel <= 255);
    }
    assert.throws(() => colourFor(palette, palette.colours.length), /has no colour/);
    assert.throws(() => colourFor(palette, -1), /has no colour/);
  }
  assert.throws(() => getPalette('nope'), /unknown palette/);
});

test('the Jeandel-Rao set renders, which is what the six colour floor is for', () => {
  const { scene } = render({
    family: 'wang', set: 'jeandel-rao', style: 'triangles', width: 6, height: 6, seed: 'jr',
  });
  const fills = new Set(scene.shapes.map((s) => s.fill));
  assert.ok(fills.size >= 5, `only ${fills.size} distinct colours, the five labels must differ`);
});

// --------------------------------------------------------------- the exact seamless test

test('a wrapped tiling renders seamlessly, byte for byte under a whole cell shift', () => {
  // The test that actually settles it. On a torus, shifting the tiling by one cell gives
  // another valid tiling of the same torus, so its rendering must equal the original
  // rendering shifted by one cell of pixels. No tolerance, no threshold.
  const cases = [
    { family: 'wang', set: 'full-2', style: 'triangles', width: 4, height: 4, seed: 's1' },
    { family: 'wang', set: 'full-2', style: 'arcs', width: 4, height: 4, seed: 's2', bands: 3 },
    { family: 'arcs', width: 4, height: 4, seed: 's3', bands: 3 },
    { family: 'diagonals', width: 4, height: 4, seed: 's4' },
  ];
  for (const base of cases) {
    const options = { ...base, torus: true };
    const { model, scene } = render(options);
    assert.equal(checkModel(model).violations.length, 0);
    const pixelWidth = model.width * 25;
    const image = rasterise(scene, { pixelWidth, samples: 4, wrap: true });

    const rolled = rollModel(model, 1, 1);
    const rolledScene = buildPrimitives(rolled, {
      palette: getPalette(options.palette ?? DEFAULTS.palette),
      colourFor, cell: 100, weight: model.weight, bands: model.bands,
    });
    const rolledImage = rasterise(rolledScene, { pixelWidth, samples: 4, wrap: true });
    const expected = rollImage(image, pixelWidth / model.width, pixelWidth / model.width);
    const diff = imageDifference(rolledImage, expected);
    assert.equal(diff.differingBytes, 0,
      `${base.family} ${base.style ?? ''}: ${diff.differingBytes} of ${diff.totalBytes} bytes `
      + `differ, worst channel delta ${diff.worstChannelDelta}`);
  }
});

test('the seam test can fail, so its passing means something', () => {
  // Without a torus the same comparison must fail, otherwise the test above is satisfied by
  // any tiling at all and proves nothing about wrapping.
  const options = { family: 'diagonals', width: 4, height: 4, seed: 'open', torus: false };
  const { model, scene } = render(options);
  const pixelWidth = 100;
  const image = rasterise(scene, { pixelWidth, samples: 4, wrap: false });
  const rolled = rollModel(model, 1, 1);
  const rolledScene = buildPrimitives(rolled, {
    palette: getPalette('indigo'), colourFor, cell: 100, weight: model.weight, bands: 1,
  });
  const rolledImage = rasterise(rolledScene, { pixelWidth, samples: 4, wrap: false });
  const diff = imageDifference(rolledImage, rollImage(image, 25, 25));
  assert.ok(diff.differingBytes > 0,
    'an open boundary tiling passed the seam test, so the seam test is inert');
});

test('the rasteriser refuses a sample count that would break translation invariance', () => {
  const { scene } = render({ family: 'arcs', width: 2, height: 2, seed: 'r' });
  assert.throws(() => rasterise(scene, { pixelWidth: 32, samples: 3 }), /power of two/);
  assert.throws(() => rasterise(scene, { pixelWidth: 0 }), /pixelWidth/);
});

test('the four quadrants of a cell partition it, with no point claimed twice or not at all', () => {
  // The property the fill rule exists for. Under the obvious inclusive test a point lying on
  // an internal diagonal is inside two quadrants at once, and which one wins is decided by
  // paint order rather than by geometry. That is invisible in a picture and fatal to any
  // claim that translating the scene translates the rendering.
  //
  // Sample points are chosen to land exactly on the diagonals rather than near them, because
  // near is where the naive rule is already correct.
  const cell = 100;
  const quadrant = (r, c) => {
    const x = c * cell;
    const y = r * cell;
    const mid = [x + cell / 2, y + cell / 2];
    return {
      n: [[x, y], [x + cell, y], mid],
      e: [[x + cell, y], [x + cell, y + cell], mid],
      s: [[x + cell, y + cell], [x, y + cell], mid],
      w: [[x, y + cell], [x, y], mid],
    };
  };
  const quadrants = quadrant(0, 0);
  const points = [];
  for (let t = 1; t < cell; t++) {
    points.push([t, t]);             // the north-west to south-east diagonal
    points.push([t, cell - t]);      // the other one
    points.push([t, cell / 2]);      // the horizontal through the centre
    points.push([cell / 2, t]);
    points.push([t + 0.5, t / 3 + 7]);
  }
  points.push([cell / 2, cell / 2]);
  let claimedOnce = 0;
  for (const [x, y] of points) {
    const owners = Object.entries(quadrants)
      .filter(([, triangle]) => insideTriangle(x, y, triangle))
      .map(([name]) => name);
    assert.equal(owners.length, 1,
      `the point ${x},${y} is claimed by ${owners.length} quadrants (${owners.join(', ')}), `
      + 'so the four of them do not partition the cell');
    claimedOnce += 1;
  }
  assert.ok(claimedOnce > 300, `only ${claimedOnce} points tested`);

  // And across a shared edge: exactly one of the eight quadrants of two neighbouring cells
  // claims a point sitting on the boundary between them.
  const left = quadrant(0, 0);
  const right = quadrant(0, 1);
  for (let t = 1; t < cell; t++) {
    const owners = [...Object.values(left), ...Object.values(right)]
      .filter((triangle) => insideTriangle(cell, t, triangle));
    assert.equal(owners.length, 1,
      `the point on the shared edge at height ${t} is claimed ${owners.length} times`);
  }
});

test('a wrapped render refuses a pixel grid that does not land on the cell grid', () => {
  // 96 pixels over 4 cells is 24 per cell, and 24 pixel widths of 100/24 units come to
  // 100.00000000000001, so a whole cell shift is not a whole pixel shift and the seam test
  // silently measures rounding. The guard has to fire, and it must fire only for a wrapped
  // render, because an ordinary export at an arbitrary size is perfectly fine.
  const { scene } = render({ family: 'arcs', width: 4, height: 4, seed: 'align', torus: true });
  assert.throws(() => rasterise(scene, { pixelWidth: 96, samples: 4, wrap: true }),
    /land on the cell grid/);
  assert.throws(() => rasterise(scene, { pixelWidth: 150, samples: 2, wrap: true }),
    /land on the cell grid/);
  for (const pixelWidth of [4, 100, 160, 200, 400]) {
    assert.ok(rasterise(scene, { pixelWidth, samples: 1, wrap: true }).width === pixelWidth,
      `${pixelWidth} pixels over 4 cells should be an acceptable wrapped size`);
  }
  assert.equal(rasterise(scene, { pixelWidth: 96, samples: 1, wrap: false }).width, 96,
    'an unwrapped render at the same size makes no seamlessness claim and must be allowed');
});

// ------------------------------------------------------------------------------ the PNG

test('the PNG is a real PNG and its pixels are the pixels that were rasterised', () => {
  const { scene } = render({ family: 'arcs', width: 3, height: 2, seed: 'png', bands: 3 });
  const image = rasterise(scene, { pixelWidth: 60, samples: 2 });
  const bytes = encodePng(image, { dpi: 300 });

  const header = readPngHeader(bytes);
  assert.equal(header.width, image.width);
  assert.equal(header.height, image.height);
  assert.equal(header.bitDepth, 8);
  assert.equal(header.colourType, 2);

  // Decode independently of the encoder: walk the chunks, inflate IDAT, undo filter 0, and
  // compare against the buffer that went in. An encoder that wrote the rows in the wrong
  // order would still produce a file with a correct header.
  const view = Buffer.from(bytes);
  let offset = 8;
  const chunks = new Map();
  while (offset < view.length) {
    const length = view.readUInt32BE(offset);
    const type = view.toString('ascii', offset + 4, offset + 8);
    chunks.set(type, view.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  assert.ok(chunks.has('IHDR') && chunks.has('IDAT') && chunks.has('IEND'));

  const phys = chunks.get('pHYs');
  assert.ok(phys, 'no pHYs chunk, so a print workflow has to guess the resolution');
  const perMetre = phys.readUInt32BE(0);
  const dpi = Math.round(perMetre * 0.0254);
  assert.equal(dpi, 300, `pHYs says ${dpi} dpi`);

  const raw = inflateSync(chunks.get('IDAT'));
  const stride = image.width * 3;
  assert.equal(raw.length, (stride + 1) * image.height);
  for (let y = 0; y < image.height; y++) {
    assert.equal(raw[y * (stride + 1)], 0, `row ${y} is not filter type 0`);
    for (let x = 0; x < stride; x++) {
      assert.equal(raw[y * (stride + 1) + 1 + x], image.data[y * stride + x],
        `pixel byte ${x} of row ${y} does not survive the round trip`);
    }
  }
});

test('the PNG encoder refuses a buffer that is the wrong size', () => {
  assert.throws(() => encodePng({ width: 4, height: 4, data: new Uint8Array(10) }), /expected 48/);
  assert.throws(() => readPngHeader(new Uint8Array(32)), /not a PNG/);
});

test('a print sized PNG really is that many pixels', () => {
  // 300 dpi over a 12 mm cell is 141.7 pixels per cell, so a 16 cell wide tiling is 2268
  // pixels. The claim in the README is arithmetic, and arithmetic can be checked.
  const cells = 16;
  const dpi = 300;
  const cellMm = 12;
  const expected = Math.round((cells * cellMm / 25.4) * dpi);
  assert.equal(expected, 2268);
  const { scene } = render({ family: 'diagonals', width: cells, height: 1, seed: 'print' });
  const image = rasterise(scene, { pixelWidth: expected, samples: 1 });
  assert.equal(image.width, 2268);
  assert.equal(image.height, Math.round(2268 / cells));
});
