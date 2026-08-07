// Colour, kept in one place so the SVG writer, the rasteriser and the browser canvas can
// never drift apart.
//
// Each palette carries at least six ink colours because the Jeandel-Rao set uses five
// distinct vertical edge labels, and a palette that runs out silently reuses a colour,
// which would make two different edge labels look identical and make the whole rendering
// unreadable as a proof that the edges match. `colourFor` throws instead.

export const PALETTE_DATA = {
  indigo: {
    label: 'Indigo night',
    background: '#141a2e',
    ink: '#f2ece1',
    colours: ['#e9614a', '#f0a35e', '#ecd9a0', '#63b2a4', '#3f6bab', '#9a6fa8'],
  },
  cyanotype: {
    label: 'Cyanotype',
    background: '#0a1f3c',
    ink: '#dcecff',
    colours: ['#dcecff', '#93b8dd', '#5a8ac0', '#2e5f9e', '#173f75', '#0d2a52'],
  },
  terracotta: {
    label: 'Terracotta',
    background: '#f6efe6',
    ink: '#372520',
    colours: ['#b8442b', '#dd7f4e', '#eab661', '#7d9b6a', '#3f6b6b', '#6b4a52'],
  },
  slate: {
    label: 'Slate and bone',
    background: '#e9e6df',
    ink: '#22262b',
    colours: ['#22262b', '#4d565f', '#7c8791', '#a9b2b9', '#cfd4d8', '#f4f2ee'],
  },
  orchard: {
    label: 'Orchard',
    background: '#fbf7ee',
    ink: '#2b3324',
    colours: ['#3f6b35', '#7aa055', '#c3cc72', '#e5b04b', '#d1663f', '#8c4a53'],
  },
  neon: {
    label: 'Neon on black',
    background: '#08090c',
    ink: '#f2f4f8',
    colours: ['#ff4d6d', '#ffb703', '#f7f5bc', '#38e8b0', '#3aa0ff', '#b478ff'],
  },
};

export function paletteNames() {
  return Object.keys(PALETTE_DATA);
}

export function getPalette(name) {
  const found = PALETTE_DATA[name];
  if (!found) {
    throw new Error(`unknown palette ${JSON.stringify(name)}; `
      + `known palettes are ${paletteNames().join(', ')}`);
  }
  return found;
}

/**
 * The colour for edge label `index`.
 *
 * Refuses to wrap. Reusing a colour when the alphabet outgrows the palette would make two
 * distinct edge labels render identically, and the four-triangle rendering is readable as
 * evidence of matching only while distinct labels look distinct.
 */
export function colourFor(palette, index) {
  if (index < 0 || index >= palette.colours.length) {
    throw new Error(`edge label ${index} has no colour: palette "${palette.label}" has `
      + `${palette.colours.length} colours, so it cannot render this tile set`);
  }
  return palette.colours[index];
}

export function parseHex(hex) {
  const text = hex.replace('#', '');
  const full = text.length === 3 ? text.split('').map((ch) => ch + ch).join('') : text;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) throw new Error(`not a hex colour: ${hex}`);
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}
