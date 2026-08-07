// Primitives to SVG text.
//
// Two properties matter beyond looking right.
//
// Byte determinism. Every number is formatted through `num`, which rounds to a fixed number
// of decimals and strips a trailing ".0", so the same seed produces the same bytes on any
// machine. A test asserts it, because "shareable seed" is a claim about bytes.
//
// Readability by something that is not this program. `scripts/check_independent.py` parses
// the emitted file and re-derives the edge matching and the curve continuity from the
// geometry alone. That only works if the geometry is in the file rather than in a transform
// attribute or a symbol reference, so every shape is written out with absolute coordinates
// and no <use>, no <defs>, and no transforms.

const DECIMALS = 4;

export function num(value) {
  if (!Number.isFinite(value)) throw new Error(`cannot format ${value} into SVG`);
  const rounded = value.toFixed(DECIMALS).replace(/\.?0+$/, '');
  return rounded === '' || rounded === '-' ? '0' : rounded;
}

function polar(cx, cy, r, degrees) {
  const radians = (degrees * Math.PI) / 180;
  return [cx + r * Math.cos(radians), cy + r * Math.sin(radians)];
}

export function arcPath(shape) {
  const [x1, y1] = polar(shape.cx, shape.cy, shape.r, shape.from);
  const [x2, y2] = polar(shape.cx, shape.cy, shape.r, shape.to);
  const large = Math.abs(shape.to - shape.from) > 180 ? 1 : 0;
  const sweep = shape.to > shape.from ? 1 : 0;
  return `M ${num(x1)} ${num(y1)} A ${num(shape.r)} ${num(shape.r)} 0 ${large} ${sweep} `
    + `${num(x2)} ${num(y2)}`;
}

/**
 * @param scene       the object from buildPrimitives
 * @param printWidthMm physical width of the whole image. SVG is resolution independent, so
 *                     "print resolution" for a vector file means real physical units on the
 *                     root element with a matching viewBox, which is what a printer or a
 *                     cutter needs. A file with only pixel units prints at whatever the
 *                     application guesses.
 */
export function toSvg(scene, { printWidthMm = 200, title = 'tiling', metadata = {} } = {}) {
  const heightMm = (printWidthMm * scene.height) / scene.width;
  const lines = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(`<svg xmlns="http://www.w3.org/2000/svg" version="1.1" `
    + `width="${num(printWidthMm)}mm" height="${num(heightMm)}mm" `
    + `viewBox="0 0 ${num(scene.width)} ${num(scene.height)}">`);
  lines.push(`  <title>${escapeText(title)}</title>`);
  const keys = Object.keys(metadata).sort();
  if (keys.length) {
    lines.push('  <desc>');
    for (const key of keys) lines.push(`    ${escapeText(key)}: ${escapeText(String(metadata[key]))}`);
    lines.push('  </desc>');
  }
  lines.push(`  <rect x="0" y="0" width="${num(scene.width)}" height="${num(scene.height)}" `
    + `fill="${scene.background}"/>`);
  for (const shape of scene.shapes) {
    if (shape.kind === 'polygon') {
      const points = shape.points.map(([x, y]) => `${num(x)},${num(y)}`).join(' ');
      // shape-rendering crispEdges keeps the seam between two triangles of the same colour
      // from showing a hairline of background, which otherwise makes a correct tiling look
      // cracked at every edge.
      lines.push(`  <polygon points="${points}" fill="${shape.fill}" shape-rendering="crispEdges"/>`);
    } else if (shape.kind === 'arc') {
      lines.push(`  <path d="${arcPath(shape)}" fill="none" stroke="${shape.stroke}" `
        + `stroke-width="${num(shape.width)}" stroke-linecap="round"/>`);
    } else if (shape.kind === 'segment') {
      lines.push(`  <path d="M ${num(shape.x1)} ${num(shape.y1)} L ${num(shape.x2)} `
        + `${num(shape.y2)}" fill="none" stroke="${shape.stroke}" `
        + `stroke-width="${num(shape.width)}" stroke-linecap="round"/>`);
    } else {
      throw new Error(`no SVG writer for shape kind ${shape.kind}`);
    }
  }
  lines.push('</svg>');
  return `${lines.join('\n')}\n`;
}

function escapeText(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
