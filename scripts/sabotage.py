#!/usr/bin/env python3
"""Break the generator on purpose and see whether the checks notice.

A verify script that passes on a broken implementation is the default failure, so the only
way to know this one is worth anything is to break the implementation and watch it fail.

THE THREE GATES. A sabotage counts only if it

  1. APPLIES.  The patch matched and the file on disk changed. An attack that silently did
     nothing is a no-op with a confident write-up attached.
  2. CHANGES THE MEASURED OUTPUT.  The tool now produces something different. If the output
     is unchanged, the sabotage touched code that the measurement never reaches, and a
     passing check afterwards says nothing about the check.
  3. IS CAUGHT.  Some part of the verification fails.

GUARDS INVERT GATE 2. Code that is dormant when the input is correct cannot change the
output when you disable it. Removing the assertion that band radii are symmetric leaves every
correct rendering exactly as it was. For those the requirement is the opposite and stricter:
the output must be UNCHANGED and the unit suite must FAIL. A sabotage declared a guard that
does change the output was never a guard, and is reported as misclassified rather than
quietly counted.

THE NULL CONTROL RUNS FIRST. Before any sabotage, an unmodified copy of the tree is put in a
second directory and required to fingerprint identically to the baseline. If it does not, the
measurement is a function of where the code lives rather than of the code, gate 2 passes for
free for every sabotage, and the whole run is void. That is not hypothetical: it invalidated
eleven sabotages in this fleet on 2026-08-06 because the fingerprint included an absolute
output path. Every command below therefore runs with the copy as its working directory and
writes to relative paths.

    python3 scripts/sabotage.py             run them all
    python3 scripts/sabotage.py --list      name them without running anything
    python3 scripts/sabotage.py --only 3 7  run two of them
"""

import argparse
import hashlib
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# The commands whose combined output is the fingerprint. Relative paths only, and the working
# directory is never printed, so two copies of the same tree in different places measure the
# same. The set is chosen to exercise every module: the placers, both continuity families,
# the solver, the SVG writer, the rasteriser and the PNG encoder.
MEASURE = [
    ["node", "src/cli.mjs", "report"],
    ["node", "src/cli.mjs", "check", "--family", "wang", "--set", "stochastic-3",
     "--width", "9", "--height", "7", "--seed", "s"],
    ["node", "src/cli.mjs", "check", "--family", "arcs", "--width", "9", "--height", "7",
     "--seed", "s"],
    ["node", "src/cli.mjs", "check", "--family", "arcs-free", "--width", "9", "--height", "7",
     "--seed", "s"],
    ["node", "src/cli.mjs", "check", "--family", "diagonals", "--width", "9", "--height", "7",
     "--seed", "s"],
    ["node", "src/cli.mjs", "check", "--family", "diagonals-free", "--width", "9",
     "--height", "7", "--seed", "s"],
    ["node", "src/cli.mjs", "check", "--family", "wang", "--set", "jeandel-rao",
     "--width", "10", "--height", "8", "--seed", "s"],
]

# Artifacts the fingerprint also covers, as (relative output path, arguments).
ARTIFACTS = [
    ("out/tri.svg", ["--family", "wang", "--set", "stochastic-3", "--style", "triangles",
                     "--width", "7", "--height", "5", "--seed", "s"]),
    ("out/arc.svg", ["--family", "wang", "--set", "full-2", "--style", "arcs",
                     "--width", "6", "--height", "6", "--bands", "3", "--seed", "s"]),
    ("out/smith.svg", ["--family", "arcs", "--width", "8", "--height", "6", "--bands", "5",
                       "--seed", "s"]),
    ("out/diag.svg", ["--family", "diagonals", "--width", "8", "--height", "6", "--seed", "s"]),
]
# Both PNGs matter, and the second one is here because of a sabotage that proved nothing.
# Recolouring the rasteriser's triangle fill rule changed no fingerprint at all while the
# corpus rasterised only arcs, which have no polygons in them. The lesson from AGENTS.md
# applies exactly: when a sabotage is a no-op, ask first whether the input ever exercises the
# code. It did not. The fix was a corpus that rasterises triangles, not a deleted sabotage.
PNG_ARTIFACTS = [
    ("out/wrap.png", ["--family", "arcs", "--width", "4", "--height", "4",
                      "--torus", "--bands", "3", "--pixel-width", "100"]),
    ("out/tri.png", ["--family", "wang", "--set", "full-2", "--style", "triangles",
                     "--width", "4", "--height", "4", "--torus", "--pixel-width", "100"]),
]


class Sabotage:
    def __init__(self, name, path, old, new, guard=False, note=""):
        self.name = name
        self.path = path
        self.old = old
        self.new = new
        self.guard = guard
        self.note = note

    def apply(self, tree):
        target = tree / self.path
        source = target.read_text()
        if self.old not in source:
            return False, f"the anchor was not found in {self.path}"
        if source.count(self.old) != 1:
            return False, f"the anchor appears {source.count(self.old)} times in {self.path}"
        target.write_text(source.replace(self.old, self.new))
        return True, f"{self.path}, {len(self.old)} characters replaced"


SABOTAGES = [
    Sabotage(
        "scanline ignores the west constraint",
        "src/wang.mjs",
        "        if (west !== null && tiles[i].w !== west) continue;\n"
        "        options.push(i);\n"
        "      }\n"
        "      if (options.length === 0) {\n"
        "        throw new Error(`scanline stranded",
        "        options.push(i);\n"
        "      }\n"
        "      if (options.length === 0) {\n"
        "        throw new Error(`scanline stranded",
        note="the placer stops looking at the tile to its left, so vertical edges disagree",
    ),
    Sabotage(
        "the edge checker stops looking east",
        "src/wang.mjs",
        "      const hasEast = c + 1 < width || (torus && width > 1);\n"
        "      if (hasEast) {\n"
        "        const other = at(r, (c + 1) % width);",
        "      const hasEast = false;\n"
        "      if (hasEast) {\n"
        "        const other = at(r, (c + 1) % width);",
        guard=True,
        note="half the edges go unchecked; correct tilings still report clean",
    ),
    Sabotage(
        "diagonals are drawn unconstrained",
        "src/truchet.mjs",
        "    for (let c = 0; c < width; c++) field[r * width + c] = rows[r] ^ cols[c];",
        "    for (let c = 0; c < width; c++) field[r * width + c] = rng.int(2);",
        note="the a xor b structure is dropped, so half the interior vertices dangle",
    ),
    Sabotage(
        "the arc continuity check assumes every tile is a Smith tile",
        "src/truchet.mjs",
        "    if (family === 'arcs') return [true, true, true, true];\n"
        "    return quarterArcEdges(field[index]);",
        "    return [true, true, true, true];",
        note="the quarter arc counterexample is declared continuous",
    ),
    Sabotage(
        "the seed is ignored",
        "src/rng.mjs",
        "  const [a0, b0, c0, d0] = cyrb128(String(seed));",
        "  const [a0, b0, c0, d0] = cyrb128('fixed');",
        note="every seed produces the same tiling, which kills the shareable link",
    ),
    Sabotage(
        "SVG numbers are not rounded",
        "src/svg.mjs",
        "  const rounded = value.toFixed(DECIMALS).replace(/\\.?0+$/, '');",
        "  const rounded = String(value);",
        note="output stops being byte stable across machines",
    ),
    Sabotage(
        "the one-cell torus constraint is dropped",
        "src/wang.mjs",
        "    if (torus && width === 1 && tiles[i].e !== tiles[i].w) return false;\n"
        "    if (torus && height === 1 && tiles[i].s !== tiles[i].n) return false;",
        "",
        note="1xN and Nx1 torus searches become vacuously satisfiable, which is how the "
             "aperiodicity evidence was once wrong by nine tilings",
    ),
    Sabotage(
        "the scanline placer is used on incomplete sets",
        "src/model.mjs",
        "  } else if (report.complete && !torus) {",
        "  } else if (!torus) {",
        note="the aperiodic set is handed to a placer that provably strands on it",
    ),
    Sabotage(
        "band radii may be asymmetric",
        "src/geometry.mjs",
        "    if (Math.abs((sorted[i] + sorted[j]) - cell) > 1e-9) {",
        "    if (false) {",
        guard=True,
        note="an asymmetric set would put the two sides of an edge in different places, and "
             "nothing would say so",
    ),
    Sabotage(
        "the palette reuses a colour instead of refusing",
        "src/palette.mjs",
        "  if (index < 0 || index >= palette.colours.length) {",
        "  if (index < 0 || index >= palette.colours.length + 99) {",
        guard=True,
        note="two distinct edge labels could render identically, which makes the picture "
             "unreadable as evidence that the edges match",
    ),
    Sabotage(
        "the wrapped render alignment guard is removed",
        "src/raster.mjs",
        "    if (!Number.isInteger(pixelsPerCell) || !dyadic) {",
        "    if (false) {",
        guard=True,
        note="a seam test at a misaligned pixel width measures rounding rather than the seam",
    ),
    Sabotage(
        "the PNG records the wrong physical resolution",
        "src/png.mjs",
        "  const perMetre = Math.round((dpi / 0.0254) / 1);",
        "  const perMetre = Math.round((dpi / 0.0254) / 2);",
        note="a 300 dpi file claims 150, so it prints at twice the intended size",
    ),
    Sabotage(
        "the rasteriser goes back to inclusive triangle edges",
        "src/raster.mjs",
        "  const edges = [[ax, ay, bx, by], [bx, by, cx, cy], [cx, cy, ax, ay]];\n"
        "  for (const [x0, y0, x1, y1] of edges) {\n"
        "    const value = (x1 - x0) * (py - y0) - (y1 - y0) * (px - x0);\n"
        "    if (value > 0) continue;\n"
        "    if (value < 0) return false;",
        "  const edges = [[ax, ay, bx, by], [bx, by, cx, cy], [cx, cy, ax, ay]];\n"
        "  for (const [x0, y0, x1, y1] of edges) {\n"
        "    const value = (x1 - x0) * (py - y0) - (y1 - y0) * (px - x0);\n"
        "    if (value >= 0) continue;\n"
        "    if (value < 0) return false;",
        note="a sample on a shared edge belongs to both triangles again, and the winner "
             "depends on paint order",
    ),
]


def run(command, cwd, timeout=600):
    try:
        result = subprocess.run(command, cwd=cwd, capture_output=True, text=True,
                                timeout=timeout)
        return result.returncode, result.stdout + result.stderr
    except subprocess.TimeoutExpired:
        return 124, "timed out"
    except OSError as error:
        return 127, str(error)


def fingerprint(tree):
    """A digest of everything the tool produces, with nothing in it that names the tree."""
    digest = hashlib.sha256()
    parts = []
    (tree / "out").mkdir(exist_ok=True)
    for command in MEASURE:
        code, output = run(command, tree)
        parts.append(f"{command[-1]} exit {code}")
        digest.update(f"{command} exit {code}\n".encode())
        digest.update(output.encode())
    for name, arguments in ARTIFACTS:
        code, output = run(["node", "src/cli.mjs", "svg", "--out", name] + arguments, tree)
        digest.update(f"{name} exit {code}\n".encode())
        # The command prints the byte count and the invariant result; the file itself is the
        # real evidence, so both go in.
        digest.update(output.encode())
        path = tree / name
        digest.update(path.read_bytes() if path.exists() else b"missing")
    for name, arguments in PNG_ARTIFACTS:
        code, output = run(["node", "src/cli.mjs", "png", "--out", name] + arguments, tree)
        digest.update(f"{name} exit {code}\n".encode())
        digest.update(output.encode())
        path = tree / name
        digest.update(path.read_bytes() if path.exists() else b"missing")
    return digest.hexdigest()[:16]


def catchers(tree):
    """The checks a sabotage has to get past, cheapest first."""
    found = []
    code, output = run(["node", "--test", "--test-reporter=tap"] + sorted(
        str(path.relative_to(tree)) for path in (tree / "tests").glob("*.mjs")), tree)
    if code != 0:
        failed = [line for line in output.splitlines() if line.startswith("not ok ")]
        first = failed[0][7:].strip() if failed else "the runner itself failed"
        found.append(f"unit suite ({len(failed)} failing, first: {first[:70]})")

    svgs = sorted(str(path.relative_to(tree)) for path in (tree / "out").glob("*.svg"))
    if svgs:
        code, output = run(["python3", "scripts/check_independent.py"] + svgs, tree)
        if code != 0:
            found.append("independent checker on the rendered SVG")

    code, output = run(["node", "scripts/build_docs.mjs", "--check"], tree)
    if code != 0:
        found.append("the published page no longer matches its sources")
    return found


def populate(destination):
    destination.mkdir(parents=True, exist_ok=True)
    listing = subprocess.run(["git", "-C", str(ROOT), "ls-files", "-z"],
                             capture_output=True, check=True)
    names = [name for name in listing.stdout.decode().split("\0") if name]
    for name in names:
        source = ROOT / name
        if not source.exists():
            continue
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
    return len(names)


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--list", action="store_true")
    parser.add_argument("--only", nargs="*", type=int)
    arguments = parser.parse_args()

    if arguments.list:
        for index, sabotage in enumerate(SABOTAGES, start=1):
            kind = "guard " if sabotage.guard else "attack"
            print(f"  {index:2}. [{kind}] {sabotage.name}")
            print(f"        {sabotage.note}")
        return 0

    with tempfile.TemporaryDirectory() as scratch:
        scratch = Path(scratch)
        baseline = scratch / "baseline"
        copied = populate(baseline)
        print(f"copied {copied} tracked files into a scratch tree")

        base = fingerprint(baseline)
        print(f"baseline fingerprint {base}")

        # THE NULL CONTROL. An unmodified copy in a different directory must fingerprint the
        # same. If it does not, gate 2 is free for every sabotage below and the run is void.
        null = scratch / "null-control"
        populate(null)
        null_print = fingerprint(null)
        if null_print != base:
            print(f"NULL CONTROL FAILED: an unmodified copy fingerprints {null_print}, not "
                  f"{base}.")
            print("The measurement depends on where the code lives rather than on the code, "
                  "so gate 2 would pass for free and every result below would be worthless.")
            print("ABORTING without scoring anything.")
            return 2
        print(f"null control  {null_print}  an unmodified copy in a second directory agrees, "
              "so the fingerprint measures the code")
        print()

        chosen = list(enumerate(SABOTAGES, start=1))
        if arguments.only:
            chosen = [pair for pair in chosen if pair[0] in set(arguments.only)]

        proven = 0
        problems = []
        for index, sabotage in chosen:
            kind = "guard" if sabotage.guard else "attack"
            print(f"{index:2}. [{kind}] {sabotage.name}")
            tree = scratch / f"sabotage-{index}"
            populate(tree)

            applied, detail = sabotage.apply(tree)
            if not applied:
                print(f"    gate 1 APPLIES     no: {detail}")
                problems.append(f"{index}: the patch did not apply")
                print()
                continue
            print(f"    gate 1 APPLIES     yes, {detail}")

            after = fingerprint(tree)
            changed = after != base
            if sabotage.guard:
                if changed:
                    print(f"    gate 2 DORMANT     NO: the output changed to {after}, so this "
                          "was never a guard. Rerun it as a plain attack.")
                    problems.append(f"{index}: declared a guard but it changes the output")
                    print()
                    continue
                print("    gate 2 DORMANT     yes, the output is unchanged, which is what a "
                      "guard removal must do")
            else:
                if not changed:
                    print("    gate 2 CHANGES     NO: the output is identical, so this patch "
                          "is a no-op against the measured commands. Either the corpus never "
                          "exercises that path, or the attack does nothing.")
                    problems.append(f"{index}: the output did not change")
                    print()
                    continue
                print(f"    gate 2 CHANGES     yes, {base} became {after}")

            caught = catchers(tree)
            if caught:
                print(f"    gate 3 CAUGHT      yes, by {'; '.join(caught)}")
                proven += 1
            else:
                print("    gate 3 CAUGHT      NO. Nothing noticed, which is a real hole in "
                      "the verification.")
                problems.append(f"{index}: not caught")
            print()

        print(f"{proven} of {len(chosen)} sabotages proven: applied, "
              "observable in the right direction, and caught")
        for problem in problems:
            print(f"  unproven  {problem}")
        return 0 if proven == len(chosen) else 1


if __name__ == "__main__":
    sys.exit(main())
