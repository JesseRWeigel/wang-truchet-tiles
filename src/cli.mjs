#!/usr/bin/env node
// Command line front end.
//
//   node src/cli.mjs svg    --out out.svg [options]
//   node src/cli.mjs png    --out out.png [options]
//   node src/cli.mjs check  [options]
//   node src/cli.mjs report
//
// `report` prints the measurements the README quotes: which sets are complete, how often a
// naive scanline pass strands itself on each of them, and the exhaustive torus search that
// is the computational evidence for the aperiodic set.

import { writeFileSync } from 'node:fs';
import {
  buildModel, checkModel, measureScanlineFailureRate, rollModel, FAMILIES, DEFAULTS,
} from './model.mjs';
import { buildTileSet, completenessReport, solveConstrained, TILE_SETS, alphabet } from './wang.mjs';
import { buildPrimitives } from './geometry.mjs';
import { getPalette, colourFor, paletteNames } from './palette.mjs';
import { toSvg } from './svg.mjs';
import { rasterise, rollImage, imageDifference } from './raster.mjs';
import { encodePng } from './png.mjs';
import { makeRng } from './rng.mjs';

const FLAG_KEYS = new Set(['torus', 'help']);

export function parseArgs(argv) {
  const options = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const key = arg.slice(2).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
    if (FLAG_KEYS.has(key)) { options[key] = true; continue; }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`--${arg.slice(2)} needs a value`);
    }
    options[key] = value;
    i++;
  }
  return { command: positional[0], options };
}

function sceneFor(options) {
  const model = buildModel(options);
  const palette = getPalette(options.palette ?? DEFAULTS.palette);
  const scene = buildPrimitives(model, {
    palette,
    colourFor,
    cell: 100,
    weight: model.weight,
    bands: model.bands,
  });
  return { model, palette, scene };
}

function describe(model) {
  const check = checkModel(model);
  const ok = check.expectClean ? check.violations.length === 0 : check.violations.length > 0;
  return { check, ok };
}

function commandSvg(options) {
  const { model, scene } = sceneFor(options);
  const { check, ok } = describe(model);
  const out = options.out;
  if (!out) throw new Error('svg needs --out');
  const svg = toSvg(scene, {
    printWidthMm: Number(options.printMm ?? 200),
    title: `${model.family} ${model.width}x${model.height} seed ${model.seed}`,
    metadata: {
      family: model.family,
      set: model.family === 'wang' ? model.set : 'n/a',
      style: model.family === 'wang' ? model.style : 'n/a',
      seed: model.seed,
      grid: `${model.width}x${model.height}`,
      seamless: String(model.torus),
      placement: model.placement.method,
      invariant: `${check.kind}: ${check.violations.length} violation(s)`,
    },
  });
  writeFileSync(out, svg);
  console.log(`wrote ${out}, ${svg.length} bytes`);
  console.log(`  placement   ${model.placement.method}: ${model.placement.guarantee}`);
  console.log(`  ${check.kind}  ${check.violations.length} violation(s), `
    + `${ok ? 'as expected' : 'NOT as expected'}`);
  return ok ? 0 : 1;
}

function commandPng(options) {
  const { model, scene } = sceneFor(options);
  const { check, ok } = describe(model);
  const out = options.out;
  if (!out) throw new Error('png needs --out');
  const dpi = Number(options.dpi ?? 300);
  const cellMm = Number(options.cellMm ?? 12);
  const explicit = options.pixelWidth ? Number(options.pixelWidth) : null;
  const pixelWidth = explicit ?? Math.round((model.width * cellMm / 25.4) * dpi);
  const samples = Number(options.samples ?? 4);
  const image = rasterise(scene, { pixelWidth, samples, wrap: model.torus });
  const bytes = encodePng(image, { dpi });
  writeFileSync(out, bytes);
  console.log(`wrote ${out}, ${image.width}x${image.height} at ${dpi} dpi, ${bytes.length} bytes`);
  console.log(`  ${check.kind}  ${check.violations.length} violation(s), `
    + `${ok ? 'as expected' : 'NOT as expected'}`);

  let seamOk = true;
  if (model.torus) {
    const perCell = image.width / model.width;
    // The rasteriser refuses a wrapped render whose pixel grid does not land on the cell
    // grid, so reaching here means it does. The shift test needs the same property, and
    // failing rather than skipping is the point: a "not tested" line and an "ok" line read
    // the same way in a log a week later.
    if (!Number.isInteger(perCell)) {
      console.log(`  seamless      NOT TESTED, which is a failure: ${image.width} pixels over `
        + `${model.width} cells is not a whole number, so the shift test cannot be exact. `
        + `Use --pixel-width a multiple of ${model.width}.`);
      seamOk = false;
    } else {
      const rolled = rollModel(model, 1, 1);
      const rolledScene = buildPrimitives(rolled, {
        palette: getPalette(options.palette ?? DEFAULTS.palette),
        colourFor,
        cell: 100,
        weight: model.weight,
        bands: model.bands,
      });
      const rolledImage = rasterise(rolledScene, { pixelWidth, samples, wrap: true });
      const expected = rollImage(image, perCell, perCell);
      const diff = imageDifference(rolledImage, expected);
      seamOk = diff.differingBytes === 0;
      console.log(`  seamless      shifting the tiling one cell and shifting the image one `
        + `cell agree on ${diff.totalBytes - diff.differingBytes}/${diff.totalBytes} bytes`
        + `${seamOk ? '' : `, worst channel delta ${diff.worstChannelDelta}`}`);
    }
  } else {
    console.log('  seamless      not requested (--torus wraps the tiling)');
  }
  return ok && seamOk ? 0 : 1;
}

function commandCheck(options) {
  const model = buildModel(options);
  const { check, ok } = describe(model);
  console.log(`${model.family} ${model.width}x${model.height} seed ${JSON.stringify(model.seed)}`
    + `${model.torus ? ' seamless' : ''}`);
  console.log(`  placement  ${model.placement.method} in ${model.placement.steps} step(s)`);
  console.log(`  ${check.kind}: ${check.violations.length} violation(s)`);
  for (const violation of check.violations.slice(0, 5)) {
    console.log(`    ${JSON.stringify(violation)}`);
  }
  if (check.violations.length > 5) console.log(`    ... and ${check.violations.length - 5} more`);
  console.log(check.expectClean
    ? (ok ? '  PASS: clean, as this family requires' : '  FAIL: this family must be clean')
    : (ok ? '  PASS: broken, as this counterexample family requires'
      : '  FAIL: the counterexample produced no violations, so the checker is inert'));
  return ok ? 0 : 1;
}

function commandReport() {
  let failures = 0;
  console.log('tile sets and the completeness invariant');
  console.log('  every (north, west) constraint pair must have at least one tile, or a');
  console.log('  scanline placer can strand itself with nowhere to go.');
  console.log('');
  console.log(`  ${'set'.padEnd(14)}${'tiles'.padStart(6)}${'pairs'.padStart(7)}`
    + `${'min'.padStart(8)}${'complete'.padStart(10)}  note`);
  for (const name of Object.keys(TILE_SETS)) {
    const { tiles } = buildTileSet(name);
    const report = completenessReport(tiles);
    console.log(`  ${name.padEnd(14)}${String(tiles.length).padStart(6)}`
      + `${String(report.pairs).padStart(7)}${String(report.minChoices).padStart(8)}`
      + `${String(report.complete).padStart(10)}  `
      + `alphabets n=${report.alphabets.n.length} e=${report.alphabets.e.length} `
      + `s=${report.alphabets.s.length} w=${report.alphabets.w.length}`);
  }

  console.log('');
  console.log('naive scanline, no backtracking, 200 trials on a 16x16 grid');
  console.log('  this is what happens if you skip the solver.');
  for (const name of Object.keys(TILE_SETS)) {
    const measured = measureScanlineFailureRate(name, 16, 16, 200);
    const percent = (measured.failureRate * 100).toFixed(1);
    const where = measured.firstFailure
      ? `first strand at row ${measured.firstFailure.row} column ${measured.firstFailure.column}`
      : 'never stranded';
    console.log(`  ${name.padEnd(14)} failure rate ${percent.padStart(6)}%  `
      + `mean cells placed ${measured.meanCellsPlaced.toFixed(1)}/${measured.cells}  ${where}`);
  }

  console.log('');
  console.log('Jeandel-Rao: computational evidence, not a proof');
  console.log('  aperiodicity was proven by Jeandel and Rao (arXiv:1506.06492).');
  console.log('  what is checked here is that the transcription behaves like their set.');
  const jr = buildTileSet('jeandel-rao');
  console.log(`  ${jr.tiles.length} tiles, horizontal labels `
    + `{${alphabet(jr.tiles, 'e').join(',')}} union {${alphabet(jr.tiles, 'w').join(',')}}, `
    + `vertical labels {${alphabet(jr.tiles, 'n').join(',')}} union `
    + `{${alphabet(jr.tiles, 's').join(',')}}`);
  for (const size of [8, 16, 24]) {
    const rng = makeRng(`report|${size}`);
    const result = solveConstrained(jr.tiles, size, size, rng, { maxSteps: 200000 });
    console.log(`  ${size}x${size} open boundary: ${result.status} in ${result.steps} step(s)`);
    if (result.status !== 'sat') failures += 1;
  }
  let periodic = 0;
  for (let h = 1; h <= 5; h++) {
    for (let w = 1; w <= 5; w++) {
      const rng = makeRng(`torus|${h}|${w}`);
      const result = solveConstrained(jr.tiles, w, h, rng, { torus: true, maxSteps: 400000 });
      if (result.status === 'sat') { periodic += 1; console.log(`  torus ${h}x${w}: SAT`); }
      if (result.status === 'capped') { failures += 1; console.log(`  torus ${h}x${w}: capped`); }
    }
  }
  console.log(`  exhaustive torus search 1x1 through 5x5: ${periodic} periodic tiling(s) found`);
  if (periodic !== 0) failures += 1;

  console.log('');
  console.log('Truchet diagonals: the valid fields counted two ways');
  for (const [w, h] of [[3, 3], [4, 3], [4, 4]]) {
    const closedForm = 2 ** (w + h - 1);
    console.log(`  ${w}x${h}: closed form a[row] xor b[column] gives ${closedForm} fields`);
  }

  return failures === 0 ? 0 : 1;
}

function usage() {
  console.log('usage: node src/cli.mjs <svg|png|check|report> [options]');
  console.log('');
  console.log('options');
  console.log(`  --family     ${Object.keys(FAMILIES).join(' | ')}`);
  console.log(`  --set        ${Object.keys(TILE_SETS).join(' | ')}  (wang only)`);
  console.log('  --style      triangles | arcs  (wang only)');
  console.log(`  --palette    ${paletteNames().join(' | ')}`);
  console.log('  --width      cells across, default 16');
  console.log('  --height     cells down, default 16');
  console.log('  --seed       any string, default "wang-1"');
  console.log('  --torus      wrap seamlessly');
  console.log('  --bands      concentric arcs per corner, 1 to 7');
  console.log('  --weight     stroke width as a fraction of a cell');
  console.log('  --out        output path (svg and png)');
  console.log('  --print-mm   physical width of the SVG in millimetres, default 200');
  console.log('  --dpi        PNG resolution, default 300');
  console.log('  --cell-mm    physical cell size for the PNG, default 12');
  console.log('  --pixel-width  override the PNG width in pixels');
  console.log('  --samples    supersampling per axis, a power of two, default 4');
}

export function main(argv) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    console.error(`error: ${error.message}`);
    return 2;
  }
  const { command, options } = parsed;
  if (!command || options.help) { usage(); return command ? 0 : 2; }
  try {
    switch (command) {
      case 'svg': return commandSvg(options);
      case 'png': return commandPng(options);
      case 'check': return commandCheck(options);
      case 'report': return commandReport();
      default:
        console.error(`unknown command ${JSON.stringify(command)}`);
        usage();
        return 2;
    }
  } catch (error) {
    console.error(`error: ${error.message}`);
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
