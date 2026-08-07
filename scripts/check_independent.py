#!/usr/bin/env python3
"""Re-derive the invariants from the rendered SVG, sharing no code with the generator.

The generator checks its own tilings, and a generator that agrees with itself has proven
nothing. This reads the finished file instead: the polygons and paths that a viewer would
see, in a different language, with its own geometry. It imports only the standard library,
which `scripts/verify.sh` proves by walking this file's import graph with `ast` rather than
by grepping for the word import, because a grep is satisfied by a comment and blind to
`importlib.import_module`.

What is recomputed, from coordinates and fill colours alone:

  Edge matching.  Each cell of a four-triangle Wang rendering is four polygons, one per
  compass direction, and the direction is worked out from which cell edge the polygon's two
  outer vertices lie on. Two cells side by side must have painted their shared edge the same
  colour. Nothing here knows what an edge label is; it compares the colours on the page.

  Curve continuity.  Every arc is reconstructed from its endpoints, its radius and its sweep
  flag back to a centre and an angular span, which gives the cell it lives in. Every arc
  endpoint must therefore land on a cell edge, and every interior edge must carry the same
  endpoints from both sides. An endpoint offered by one cell and not met by the other is a
  curve that stops in mid air, which is the defect this whole exercise is about.

  Diagonal continuity.  Line segments end at lattice corners, and an interior corner with an
  odd number of ends has a line dangling at it.

The grid shape is read from the file's own <desc>, which is a label rather than an invariant,
and it is then checked against the geometry: the cells the shapes actually occupy have to be
exactly the cells that shape implies, so a wrong or stale description fails here rather than
quietly rescaling the analysis.

    python3 scripts/check_independent.py out/*.svg
    python3 scripts/check_independent.py --expect-broken out/quarter.svg
"""

import argparse
import math
import re
import sys
import xml.etree.ElementTree as ElementTree
from collections import defaultdict

SVG_NS = "{http://www.w3.org/2000/svg}"
TOLERANCE = 1e-3

NUMBER = re.compile(r"-?\d+(?:\.\d+)?")


def numbers(text):
    return [float(match.group()) for match in NUMBER.finditer(text)]


class Failure(Exception):
    pass


def parse_description(root):
    """Family, grid shape and seamlessness, as the file states them."""
    described = {}
    for element in root.iter(f"{SVG_NS}desc"):
        for line in (element.text or "").splitlines():
            if ":" not in line:
                continue
            key, _, value = line.partition(":")
            described[key.strip()] = value.strip()
    if "grid" not in described:
        raise Failure("the file has no grid in its description, so it cannot be checked")
    match = re.fullmatch(r"(\d+)x(\d+)", described["grid"])
    if not match:
        raise Failure(f"grid {described['grid']!r} is not WIDTHxHEIGHT")
    described["width"] = int(match.group(1))
    described["height"] = int(match.group(2))
    described["torus"] = described.get("seamless") == "true"
    return described


def view_box(root):
    values = numbers(root.get("viewBox", ""))
    if len(values) != 4:
        raise Failure(f"viewBox {root.get('viewBox')!r} is not four numbers")
    return values[2], values[3]


def close(a, b, tolerance=TOLERANCE):
    return abs(a - b) <= tolerance


def collect_shapes(root):
    polygons, arcs, segments = [], [], []
    for element in root.iter():
        tag = element.tag
        if tag == f"{SVG_NS}polygon":
            values = numbers(element.get("points", ""))
            points = list(zip(values[0::2], values[1::2]))
            if len(points) != 3:
                raise Failure(f"a polygon has {len(points)} points, expected a triangle")
            polygons.append((points, element.get("fill")))
        elif tag == f"{SVG_NS}path":
            d = element.get("d", "")
            if " A " in d:
                arcs.append((d, element.get("stroke")))
            elif " L " in d:
                segments.append((d, element.get("stroke")))
            else:
                raise Failure(f"a path is neither an arc nor a line: {d[:60]!r}")
    return polygons, arcs, segments


def arc_geometry(d):
    """Centre, radius and the angular span of a quarter arc, from the path data alone.

    An SVG elliptical arc gives the two endpoints, the radii and a sweep flag. Two circles of
    the given radius pass through both endpoints, so there are two candidate centres, and the
    sweep flag chooses between them: for sweep 1 the turn from the first endpoint to the
    second about the centre is positive. Reconstructing this rather than reading a centre out
    of the generator is the point of the exercise.
    """
    values = numbers(d)
    if len(values) != 9:
        raise Failure(f"an arc path has {len(values)} numbers, expected 9: {d[:70]!r}")
    x1, y1, rx, ry, _rotation, _large, sweep, x2, y2 = values
    if not close(rx, ry):
        raise Failure(f"an arc is elliptical, {rx} against {ry}, which this tool cannot read")
    midpoint = ((x1 + x2) / 2, (y1 + y2) / 2)
    span = math.hypot(x2 - x1, y2 - y1)
    if span > 2 * rx + TOLERANCE:
        raise Failure(f"an arc of radius {rx} spans {span}, which no circle can do")
    height = math.sqrt(max(0.0, rx * rx - (span / 2) ** 2))
    # The two candidate centres sit either side of the chord.
    ux, uy = (x2 - x1) / span, (y2 - y1) / span
    candidates = [
        (midpoint[0] - uy * height, midpoint[1] + ux * height),
        (midpoint[0] + uy * height, midpoint[1] - ux * height),
    ]
    chosen = None
    for cx, cy in candidates:
        cross = (x1 - cx) * (y2 - cy) - (y1 - cy) * (x2 - cx)
        if (cross > 0) == (sweep == 1):
            chosen = (cx, cy)
            break
    if chosen is None:
        raise Failure(f"neither candidate centre matches sweep {sweep} for {d[:70]!r}")
    cx, cy = chosen
    start = math.degrees(math.atan2(y1 - cy, x1 - cx))
    end = math.degrees(math.atan2(y2 - cy, x2 - cx))
    while end < start:
        end += 360
    return (cx, cy), rx, start, end


def cell_of(x, y, cell, width, height):
    column = min(width - 1, max(0, int(math.floor(x / cell + 1e-9))))
    row = min(height - 1, max(0, int(math.floor(y / cell + 1e-9))))
    return row, column


def edge_of_point(x, y, row, column, cell):
    """Which side of its cell a point sits on, or None if it is not on the boundary."""
    left, top = column * cell, row * cell
    on = []
    if close(x, left):
        on.append("w")
    if close(x, left + cell):
        on.append("e")
    if close(y, top):
        on.append("n")
    if close(y, top + cell):
        on.append("s")
    if len(on) != 1:
        return None
    return on[0]


def check_triangles(polygons, cell, width, height, torus):
    """Edge matching, recomputed from the painted colours."""
    painted = defaultdict(dict)
    for points, fill in polygons:
        centroid = (sum(p[0] for p in points) / 3, sum(p[1] for p in points) / 3)
        row, column = cell_of(centroid[0], centroid[1], cell, width, height)
        left, top = column * cell, row * cell
        # A quadrant is two adjacent corners of the cell and the cell centre. The corners are
        # what say which edge it paints, and each of them lies on two edges at once, so the
        # side is the one the pair have in common rather than anything a single point knows.
        apex = [p for p in points
                if close(p[0], left + cell / 2) and close(p[1], top + cell / 2)]
        outer = [p for p in points
                 if not (close(p[0], left + cell / 2) and close(p[1], top + cell / 2))]
        if len(apex) != 1 or len(outer) != 2:
            raise Failure(f"a polygon in cell {row},{column} is not a corner to corner to "
                          f"centre quadrant: {points}")
        for x, y in outer:
            if not ((close(x, left) or close(x, left + cell))
                    and (close(y, top) or close(y, top + cell))):
                raise Failure(f"a quadrant vertex at {x},{y} is not a corner of cell "
                              f"{row},{column}")
        side = shared_side(outer, row, column, cell)
        if side in painted[(row, column)]:
            raise Failure(f"cell {row},{column} has two {side} quadrants")
        painted[(row, column)][side] = fill

    expected = width * height
    if len(painted) != expected:
        raise Failure(f"the polygons cover {len(painted)} cells, but the description says "
                      f"{width}x{height} = {expected}")
    for key, quadrants in painted.items():
        if set(quadrants) != {"n", "e", "s", "w"}:
            raise Failure(f"cell {key} has quadrants {sorted(quadrants)}, expected all four")

    violations = []
    checked = 0
    for row in range(height):
        for column in range(width):
            here = painted[(row, column)]
            if column + 1 < width or (torus and width > 1):
                other = painted[(row, (column + 1) % width)]
                checked += 1
                if here["e"] != other["w"]:
                    violations.append(f"row {row} column {column}: east {here['e']} meets "
                                      f"west {other['w']}")
            if row + 1 < height or (torus and height > 1):
                other = painted[((row + 1) % height, column)]
                checked += 1
                if here["s"] != other["n"]:
                    violations.append(f"row {row} column {column}: south {here['s']} meets "
                                      f"north {other['n']}")
    return checked, violations


def shared_side(outer, row, column, cell):
    left, top = column * cell, row * cell
    (x1, y1), (x2, y2) = outer
    if close(x1, x2) and close(x1, left):
        return "w"
    if close(x1, x2) and close(x1, left + cell):
        return "e"
    if close(y1, y2) and close(y1, top):
        return "n"
    if close(y1, y2) and close(y1, top + cell):
        return "s"
    raise Failure(f"the two outer vertices of a quadrant in cell {row},{column} do not lie "
                  "along one edge")


def check_arcs(arcs, cell, width, height, torus):
    """Curve continuity, by tracing every arc endpoint onto the edge it lands on."""
    offered = defaultdict(list)
    endpoints = 0
    for d, _stroke in arcs:
        (cx, cy), radius, start, end = arc_geometry(d)
        middle = math.radians((start + end) / 2)
        inside = (cx + radius * math.cos(middle), cy + radius * math.sin(middle))
        row, column = cell_of(inside[0], inside[1], cell, width, height)
        values = numbers(d)
        for x, y in [(values[0], values[1]), (values[7], values[8])]:
            side = edge_of_point(x, y, row, column, cell)
            if side is None:
                raise Failure(f"an arc endpoint at {x},{y} does not lie on an edge of the "
                              f"cell {row},{column} it belongs to")
            # The position along the edge is what has to agree across it, so it is recorded
            # to the same precision the file carries.
            along = round(y if side in ("e", "w") else x, 3)
            offered[(row, column, side)].append(along)
            endpoints += 1
    for key in offered:
        offered[key].sort()

    violations = []
    checked = 0
    for row in range(height):
        for column in range(width):
            if column + 1 < width or (torus and width > 1):
                mine = offered.get((row, column, "e"), [])
                theirs = offered.get((row, (column + 1) % width, "w"), [])
                checked += 1
                if mine != theirs:
                    violations.append(f"row {row} column {column} east edge: {len(mine)} "
                                      f"endpoint(s) against {len(theirs)} on the other side")
            if row + 1 < height or (torus and height > 1):
                mine = offered.get((row, column, "s"), [])
                theirs = offered.get(((row + 1) % height, column, "n"), [])
                checked += 1
                if mine != theirs:
                    violations.append(f"row {row} column {column} south edge: {len(mine)} "
                                      f"endpoint(s) against {len(theirs)} on the other side")
    return checked, violations, endpoints


def check_segments(segments, cell, width, height, torus):
    """Diagonal continuity: an interior lattice point with an odd number of line ends."""
    degree = defaultdict(int)
    for d, _stroke in segments:
        values = numbers(d)
        if len(values) != 4:
            raise Failure(f"a line path has {len(values)} numbers, expected 4")
        for x, y in [(values[0], values[1]), (values[2], values[3])]:
            column = round(x / cell)
            row = round(y / cell)
            if not close(column * cell, x) or not close(row * cell, y):
                raise Failure(f"a diagonal ends at {x},{y}, which is not a cell corner")
            if torus:
                row %= height
                column %= width
            degree[(row, column)] += 1

    violations = []
    checked = 0
    rows = range(0, height) if torus else range(1, height)
    columns = range(0, width) if torus else range(1, width)
    for row in rows:
        for column in columns:
            checked += 1
            if degree[(row, column)] % 2 != 0:
                violations.append(f"vertex {row},{column} has {degree[(row, column)]} line "
                                  "ends, which is odd, so one of them dangles")
    return checked, violations


def check_file(path):
    root = ElementTree.parse(path).getroot()
    described = parse_description(root)
    width, height = described["width"], described["height"]
    box_width, box_height = view_box(root)
    cell = box_width / width
    if not close(box_height / height, cell, 1e-6):
        raise Failure(f"the viewBox is {box_width}x{box_height}, which is not {width}x{height} "
                      f"square cells")
    torus = described["torus"]

    polygons, arcs, segments = collect_shapes(root)
    kinds = [bool(polygons), bool(arcs), bool(segments)]
    if sum(kinds) != 1:
        raise Failure(f"the file mixes {sum(kinds)} kinds of shape, which no family produces")

    if polygons:
        checked, violations = check_triangles(polygons, cell, width, height, torus)
        return {
            "kind": "edge matching, from the painted colours",
            "units": f"{checked} interior edges",
            "shapes": len(polygons),
            "violations": violations,
        }
    if arcs:
        checked, violations, endpoints = check_arcs(arcs, cell, width, height, torus)
        return {
            "kind": "curve continuity, by tracing arc endpoints",
            "units": f"{checked} interior edges, {endpoints} endpoints traced",
            "shapes": len(arcs),
            "violations": violations,
        }
    checked, violations = check_segments(segments, cell, width, height, torus)
    return {
        "kind": "diagonal continuity, by counting line ends",
        "units": f"{checked} interior vertices",
        "shapes": len(segments),
        "violations": violations,
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("files", nargs="+")
    parser.add_argument("--expect-broken", action="store_true",
                        help="require every file to FAIL, which is how this checker is shown "
                             "to be capable of failing at all")
    arguments = parser.parse_args(argv)

    problems = 0
    for path in arguments.files:
        try:
            result = check_file(path)
        except (Failure, ElementTree.ParseError) as error:
            print(f"  {path}: CANNOT READ: {error}")
            problems += 1
            continue
        count = len(result["violations"])
        verdict = "broken" if count else "clean"
        wanted = "broken" if arguments.expect_broken else "clean"
        mark = "ok   " if verdict == wanted else "FAIL "
        if verdict != wanted:
            problems += 1
        name = path.rsplit("/", 1)[-1]
        print(f"  {mark} {name}: {result['kind']}")
        print(f"         {result['shapes']} shapes, {result['units']}, "
              f"{count} violation(s), expected {wanted}")
        for violation in result["violations"][:3]:
            print(f"         {violation}")
        if count > 3:
            print(f"         and {count - 3} more")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
