// The third renderer: the same shape list, drawn into a 2D canvas context.
//
// It exists so the page shows what the SVG and the PNG would show. Three renderers reading
// one description is the arrangement that keeps them honest; three renderers each deriving
// their own geometry would be three chances to disagree, and the disagreement would be
// invisible until someone printed a file and found it different from the screen.
//
// Nothing here decides anything. Every coordinate arrives already computed in user units,
// and this multiplies by a scale. If a curve is broken on the page it is broken in the SVG.

export function drawScene(context, scene, { scale = 1, background = true } = {}) {
  const s = (value) => value * scale;
  if (background) {
    context.fillStyle = scene.background;
    context.fillRect(0, 0, s(scene.width), s(scene.height));
  }
  context.lineCap = 'round';
  for (const shape of scene.shapes) {
    if (shape.kind === 'polygon') {
      context.fillStyle = shape.fill;
      context.beginPath();
      shape.points.forEach(([x, y], index) => {
        if (index === 0) context.moveTo(s(x), s(y));
        else context.lineTo(s(x), s(y));
      });
      context.closePath();
      context.fill();
      // Stroking the polygon with its own fill colour closes the hairline of background that
      // otherwise shows between two triangles of the same colour. Without it a correct
      // tiling looks cracked along every edge on a high density screen.
      context.strokeStyle = shape.fill;
      context.lineWidth = 1;
      context.stroke();
    } else if (shape.kind === 'arc') {
      context.strokeStyle = shape.stroke;
      context.lineWidth = s(shape.width);
      context.beginPath();
      context.arc(s(shape.cx), s(shape.cy), s(shape.r),
        (shape.from * Math.PI) / 180, (shape.to * Math.PI) / 180);
      context.stroke();
    } else if (shape.kind === 'segment') {
      context.strokeStyle = shape.stroke;
      context.lineWidth = s(shape.width);
      context.beginPath();
      context.moveTo(s(shape.x1), s(shape.y1));
      context.lineTo(s(shape.x2), s(shape.y2));
      context.stroke();
    } else {
      throw new Error(`no canvas renderer for shape kind ${shape.kind}`);
    }
  }
}

/**
 * Draw one tile of a Wang set on its own, for the tile set inspector.
 *
 * A person looking at a tiling cannot see the tile set that produced it, and the set is the
 * interesting object. This draws the four coloured triangles at a small size so the page can
 * show all eleven Jeandel-Rao tiles beside the tiling they generate.
 */
export function drawTile(context, tile, size, colours) {
  const half = size / 2;
  const quadrants = [
    [[0, 0], [size, 0], [half, half], tile.n],
    [[size, 0], [size, size], [half, half], tile.e],
    [[size, size], [0, size], [half, half], tile.s],
    [[0, size], [0, 0], [half, half], tile.w],
  ];
  for (const [a, b, c, label] of quadrants) {
    context.fillStyle = colours(label);
    context.beginPath();
    context.moveTo(a[0], a[1]);
    context.lineTo(b[0], b[1]);
    context.lineTo(c[0], c[1]);
    context.closePath();
    context.fill();
    context.strokeStyle = context.fillStyle;
    context.lineWidth = 1;
    context.stroke();
  }
}
