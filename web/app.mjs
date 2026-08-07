// The page. Reads the same modules the command line reads, so the picture on screen is the
// picture the SVG writer would write, and the invariant reported here is the invariant the
// test suite asserts.
//
// Two things this deliberately does not do. It does not carry its own copy of the geometry,
// because two copies drift. And it does not hide a failed invariant: the counterexample
// families report a failure in red, because the page claiming everything is fine whatever it
// draws would make the whole readout decorative.

import { buildModel, checkModel, FAMILIES, DEFAULTS } from '../src/model.mjs';
import { TILE_SETS, completenessReport } from '../src/wang.mjs';
import { buildPrimitives } from '../src/geometry.mjs';
import { getPalette, colourFor, PALETTE_DATA } from '../src/palette.mjs';
import { toSvg } from '../src/svg.mjs';
import { drawScene, drawTile } from '../src/canvas.mjs';

const $ = (id) => document.getElementById(id);
const CELL = 100;
const PRINT_DPI = 300;
const PRINT_CELL_MM = 12;

const state = { ...DEFAULTS };

// ------------------------------------------------------------------------------ theme

const THEMES = ['auto', 'light', 'dark'];
const THEME_LABEL = { auto: 'Auto', light: 'Light', dark: 'Dark' };

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $('theme-label').textContent = THEME_LABEL[theme];
  try { localStorage.setItem('wt-theme', theme); } catch { /* private mode, no matter */ }
}

$('theme-toggle').addEventListener('click', () => {
  const current = document.documentElement.dataset.theme || 'auto';
  applyTheme(THEMES[(THEMES.indexOf(current) + 1) % THEMES.length]);
});

let storedTheme = null;
try { storedTheme = localStorage.getItem('wt-theme'); } catch { storedTheme = null; }
applyTheme(THEMES.includes(storedTheme) ? storedTheme : 'auto');

// --------------------------------------------------------------------------- controls

for (const [name, entry] of Object.entries(FAMILIES)) {
  $('family').append(new Option(entry.label, name));
}
for (const [name, entry] of Object.entries(TILE_SETS)) {
  $('set').append(new Option(entry.label, name));
}
for (const [name, entry] of Object.entries(PALETTE_DATA)) {
  $('palette').append(new Option(entry.label, name));
}

function readHash() {
  const raw = window.location.hash.replace(/^#/, '');
  if (!raw) return;
  const params = new URLSearchParams(raw);
  for (const [key, value] of params) {
    if (!(key in DEFAULTS)) continue;
    if (key === 'torus') state.torus = value === '1';
    else if (typeof DEFAULTS[key] === 'number') state[key] = Number(value);
    else state[key] = value;
  }
}

function writeHash() {
  const params = new URLSearchParams();
  for (const key of Object.keys(DEFAULTS)) {
    const value = state[key];
    if (value === DEFAULTS[key]) continue;
    params.set(key, key === 'torus' ? (value ? '1' : '0') : String(value));
  }
  const next = params.toString();
  const url = `${window.location.pathname}${next ? `#${next}` : ''}`;
  window.history.replaceState(null, '', url);
}

function pushStateToControls() {
  $('family').value = state.family;
  $('set').value = state.set;
  $('style').value = state.style;
  $('palette').value = state.palette;
  $('seed').value = state.seed;
  $('width').value = String(state.width);
  $('height').value = String(state.height);
  $('bands').value = String(state.bands);
  $('weight').value = String(Math.round(state.weight * 100));
  $('torus').checked = state.torus;
  $('grid-value').textContent = `${state.width} x ${state.height}`;
  $('bands-value').textContent = String(state.bands);
  $('weight-value').textContent = `${Math.round(state.weight * 100)}% of a cell`;

  const isWang = state.family === 'wang';
  const usesBands = isWang ? state.style === 'arcs' : state.family.startsWith('arcs');
  $('set-field').hidden = !isWang;
  $('style-field').hidden = !isWang;
  $('bands-field').hidden = !usesBands;
  $('family-note').textContent = FAMILIES[state.family].description;
  $('set-note').textContent = isWang ? TILE_SETS[state.set].note : '';
}

function readControls() {
  state.family = $('family').value;
  state.set = $('set').value;
  state.style = $('style').value;
  state.palette = $('palette').value;
  state.seed = $('seed').value || 'wang-1';
  state.width = Number($('width').value);
  state.height = Number($('height').value);
  state.bands = Number($('bands').value);
  state.weight = Number($('weight').value) / 100;
  state.torus = $('torus').checked;
}

// ---------------------------------------------------------------------------- drawing

let current = null;

function buildScene() {
  const model = buildModel(state);
  const palette = getPalette(state.palette);
  const scene = buildPrimitives(model, {
    palette, colourFor, cell: CELL, weight: model.weight, bands: model.bands,
  });
  return { model, palette, scene, check: checkModel(model) };
}

function paint() {
  const canvas = $('canvas');
  const frame = canvas.parentElement;
  const available = Math.max(240, frame.clientWidth - 2);
  const ratio = Math.min(window.devicePixelRatio || 1, 3);
  const cssWidth = available;
  const cssHeight = Math.max(1, Math.round((cssWidth * current.scene.height) / current.scene.width));
  canvas.width = Math.round(cssWidth * ratio);
  canvas.height = Math.round(cssHeight * ratio);
  canvas.style.height = `${cssHeight}px`;
  const context = canvas.getContext('2d');
  context.setTransform(1, 0, 0, 1, 0, 0);
  drawScene(context, current.scene, { scale: (cssWidth * ratio) / current.scene.width });
}

function describePlacement(model) {
  const words = { edges: 'Direct, from the edge colours', scanline: 'One scanline pass',
    solver: 'Arc consistency and backtracking', free: 'Unconstrained, none is needed',
    xor: 'a[row] xor b[column]' };
  return words[model.placement.method] ?? model.placement.method;
}

function renderReadout({ model, check }) {
  const clean = check.violations.length === 0;
  const ok = check.expectClean ? clean : !clean;
  const verdict = $('invariant-verdict');
  verdict.className = `verdict ${ok ? 'pass' : 'fail'}`;
  const label = check.kind === 'edge-matching' ? 'Edge matching' : 'Curve continuity';
  verdict.textContent = `${ok ? 'PASS' : 'FAIL'}  ${label}, `
    + `${check.violations.length} violation${check.violations.length === 1 ? '' : 's'}`;
  const interiorEdges = check.kind === 'edge-matching'
    ? `${model.torus ? model.width * model.height * 2
      : (model.width - 1) * model.height + model.width * (model.height - 1)} interior edges`
    : null;
  if (check.expectClean) {
    $('invariant-detail').textContent = clean
      ? `Every one of the ${interiorEdges ?? 'interior meeting points'} checked, and every `
        + 'one agrees. Checked in this page, on this tiling, after this change.'
      : `This family must be clean and is not. First: ${JSON.stringify(check.violations[0])}`;
  } else {
    $('invariant-detail').textContent = clean
      ? 'This family is the counterexample and must produce violations. It produced none, '
        + 'which means the checker has stopped looking.'
      : 'This family is kept because it is broken. Curves end in mid air, the checker finds '
        + 'them, and that is how the checker is known to work at all.';
  }

  $('placement-verdict').textContent = describePlacement(model);
  $('placement-detail').textContent = `${model.placement.guarantee}. `
    + `${model.placement.steps} step${model.placement.steps === 1 ? '' : 's'} for `
    + `${model.width * model.height} cells.`;

  const inspector = $('inspector');
  if (model.family === 'wang') {
    const report = model.completeness ?? completenessReport(model.tiles);
    $('completeness-verdict').className = `verdict ${report.complete ? 'pass' : ''}`;
    $('completeness-verdict').textContent = report.complete
      ? `Complete, ${report.pairs} of ${report.pairs} constraint pairs covered`
      : `Not complete, ${report.missing.length} of ${report.pairs} pairs have no tile`;
    $('completeness-detail').textContent = report.complete
      ? `Every (north, west) pair has between ${report.minChoices} and ${report.maxChoices} `
        + 'admissible tiles, so a single scanline pass can never strand itself.'
      : 'A scanline pass would reach one of the uncovered pairs and have nowhere to go, so '
        + 'this set is placed by the backtracking solver instead.';
    inspector.hidden = false;
    $('inspector-note').textContent = `${model.tiles.length} tiles, `
      + `${model.colours} edge colour${model.colours === 1 ? '' : 's'}. North, east, south and `
      + 'west are the four triangles, reading clockwise from the top.';
    renderTiles(model);
  } else {
    $('completeness-verdict').className = 'verdict';
    $('completeness-verdict').textContent = 'Not applicable';
    $('completeness-detail').textContent = 'Completeness is a property of a Wang tile set. '
      + 'The Truchet families constrain the drawing rather than the edge labels.';
    inspector.hidden = true;
  }
}

function renderTiles(model) {
  const host = $('tiles');
  host.textContent = '';
  const palette = getPalette(state.palette);
  const colours = (index) => colourFor(palette, index);
  const ratio = Math.min(window.devicePixelRatio || 1, 3);
  const size = 46;
  model.tiles.forEach((tile, index) => {
    const figure = document.createElement('figure');
    const canvas = document.createElement('canvas');
    canvas.width = size * ratio;
    canvas.height = size * ratio;
    const context = canvas.getContext('2d');
    context.scale(ratio, ratio);
    drawTile(context, tile, size, colours);
    const caption = document.createElement('figcaption');
    caption.textContent = `${index}: ${tile.n}${tile.e}${tile.s}${tile.w}`;
    figure.append(canvas, caption);
    host.append(figure);
  });
}

function renderCaption({ model, check }) {
  const bits = [
    `<strong>${FAMILIES[model.family].label}</strong>`,
    model.family === 'wang' ? `${TILE_SETS[model.set].label}` : null,
    `${model.width} x ${model.height} cells`,
    `seed <strong>${escapeHtml(model.seed)}</strong>`,
    model.torus ? 'wrapped seamlessly' : 'open boundary',
    `${check.violations.length} violation${check.violations.length === 1 ? '' : 's'}`,
  ].filter(Boolean);
  $('caption').innerHTML = bits.join(' &middot; ');
}

function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function showError(message) {
  $('plate').classList.add('error');
  $('caption').textContent = message;
  const canvas = $('canvas');
  const context = canvas.getContext('2d');
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, canvas.width, canvas.height);
}

function update() {
  readControls();
  pushStateToControls();
  writeHash();
  try {
    current = buildScene();
  } catch (error) {
    current = null;
    showError(error.message);
    return;
  }
  $('plate').classList.remove('error');
  paint();
  renderCaption(current);
  renderReadout(current);
  document.body.dataset.ready = 'yes';
}

// ------------------------------------------------------------------------------ export

function download(name, blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function slug() {
  const parts = [current.model.family, current.model.family === 'wang' ? current.model.set : null,
    `${current.model.width}x${current.model.height}`, current.model.seed];
  return parts.filter(Boolean).join('-').replace(/[^a-zA-Z0-9-]+/g, '_');
}

export function buildSvgText() {
  const { model, scene, check } = current;
  return toSvg(scene, {
    printWidthMm: (model.width * PRINT_CELL_MM),
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
}

$('download-svg').addEventListener('click', () => {
  if (!current) return;
  download(`${slug()}.svg`, new Blob([buildSvgText()], { type: 'image/svg+xml' }));
});

/**
 * Print resolution means a real number of pixels for a real physical size, so the width is
 * computed from the cell size in millimetres and the dots per inch rather than from whatever
 * the screen happens to be. A 16 cell tiling at 12 mm per cell and 300 dpi is 2268 pixels.
 */
export function printPixelWidth(model) {
  return Math.round(((model.width * PRINT_CELL_MM) / 25.4) * PRINT_DPI);
}

$('download-png').addEventListener('click', () => {
  if (!current) return;
  const { model, scene } = current;
  const width = printPixelWidth(model);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = Math.round((width * scene.height) / scene.width);
  drawScene(canvas.getContext('2d'), scene, { scale: width / scene.width });
  canvas.toBlob((blob) => { if (blob) download(`${slug()}-${PRINT_DPI}dpi.png`, blob); }, 'image/png');
});

$('copy-link').addEventListener('click', async () => {
  const button = $('copy-link');
  const previous = button.textContent;
  try {
    await navigator.clipboard.writeText(window.location.href);
    button.textContent = 'Copied';
  } catch {
    // Clipboard access can be refused, and pretending it worked would be a lie the user
    // discovers only when they paste nothing.
    button.textContent = 'Copy blocked';
  }
  setTimeout(() => { button.textContent = previous; }, 1600);
});

$('shuffle').addEventListener('click', () => {
  const words = ['ochre', 'lattice', 'kite', 'meander', 'stanza', 'thimble', 'cobble', 'quire',
    'plait', 'tessera', 'runnel', 'gable'];
  const pick = words[Math.floor(Math.random() * words.length)];
  $('seed').value = `${pick}-${Math.floor(Math.random() * 1000)}`;
  update();
});

for (const id of ['family', 'set', 'style', 'palette', 'seed', 'width', 'height', 'bands',
  'weight', 'torus']) {
  const element = $(id);
  element.addEventListener('input', update);
  element.addEventListener('change', update);
}

let resizeTimer = null;
window.addEventListener('resize', () => {
  if (!current) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(paint, 80);
});

readHash();
pushStateToControls();
update();

// The browser check reads these. Exposing the model rather than a screenshot is what makes
// it possible to assert that the script ran and that the tiling on screen is the tiling the
// invariants were computed over.
window.wangTruchet = {
  state,
  get model() { return current?.model ?? null; },
  get check() { return current?.check ?? null; },
  get sceneShapes() { return current?.scene.shapes.length ?? 0; },
  buildSvgText,
  printPixelWidth,
};
