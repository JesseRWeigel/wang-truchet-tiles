# wang-truchet-tiles

Wang and Truchet tile system with a validating placer, a backtracking solver, SVG and PNG
export, and a self-contained web tool that checks its own output.

**[The tilings, and what they were checked for →](https://jesserweigel.github.io/wang-truchet-tiles/)**

Catalog task: `ART-020`. One of a public catalog of build ideas:
https://github.com/JesseRWeigel/722-things-to-build

## What this is

A generator for two families of tiling that look decorative and are not, plus the checks that
say whether a given output is actually correct.

**Wang tiles** are unit squares with coloured edges, placed without rotation and without
reflection, so that two tiles may sit side by side only when the colours on the edge they
share are equal. Six tile sets ship here, from an eight tile stochastic set up to the
Jeandel-Rao set of eleven aperiodic tiles.

**Truchet tiles** are the curve families. Cyril Stanley Smith's variant draws two quarter arcs
on opposite corners, and the original tile is split by a diagonal. Both can be drawn in a way
that leaves curves ending in mid air, and both broken versions are shipped on purpose, as the
counterexamples the continuity checker has to reject.

Everything is deterministic from a named seed, in Node and in the browser, and the browser
check asserts that the page and the command line produce the same SVG byte for byte.

The web tool is one file with no network requests, no fonts, no build step and no analytics:
[`docs/index.html`](docs/index.html), built by inlining `src/` and `web/`.

## Running it

```bash
node src/cli.mjs report                         # completeness, failure rates, torus search
node src/cli.mjs check --family arcs --width 20 --height 12
node src/cli.mjs svg --out tiling.svg --family wang --set jeandel-rao --width 24 --height 18
node src/cli.mjs png --out tiling.png --family arcs --torus --bands 5 --pixel-width 1600
node scripts/build_docs.mjs                     # rebuild docs/index.html from source
bash scripts/verify.sh                          # the whole thing; the exit code is the result
```

`node src/cli.mjs --help` lists every option. There are no dependencies: Node 18 or later,
Python 3 for the independent checker and the privacy scan, and a Chrome or Chromium for the
browser check.

## The parts that are easy to get wrong

**Rotation changes the problem.** A Wang tile is placed as it is. Allowing rotation replaces
the set with its rotation closure, which is a different set with different answers, and the
undecidability result that makes these interesting is about the version that does not turn.
Nothing here rotates a tile.

**A naive scanline placer can strand itself.** Going left to right and top to bottom, each
cell is constrained by the tile above and the tile to its left, so the set needs a tile for
every (north, west) pair or the placer eventually reaches a pair it cannot satisfy. That
property is called completeness here, it is checked pair by pair rather than assumed, and the
placement method is chosen from the result:

| method | when | guarantee |
|---|---|---|
| edges | a full colours^4 set | cannot fail; the edge colours are chosen directly and the tiles read off |
| scanline | a complete set, open boundary | cannot strand; every constraint pair has a tile |
| solver | anything else | arc consistency plus backtracking, reporting sat, unsat or capped |

Measured rather than described: over 200 trials on a 16 by 16 grid, a naive scanline pass
succeeds on every complete set 100% of the time and on the Jeandel-Rao set 0% of the time,
stranding after a mean of 18.8 of 256 cells. `node src/cli.mjs report` prints the table.

**Aperiodic is not the same as random.** A stochastic two colour tiling is random. The
Jeandel-Rao set of 11 tiles is aperiodic: it tiles the plane and admits no periodic tiling at
all. **That was proven by Emmanuel Jeandel and Michael Rao (arXiv:1506.06492), not here.**
What this project verifies is strictly weaker and is labelled as such: the set tiles 8x8,
16x16 and 24x24 squares, and an exhaustive search finds no tiling of any torus from 1x1
through 5x5. Both are necessary conditions, both would fail on a mistranscribed digit, and one
of them did fail during development, which is how a wrong digit was found. Asking for a
seamless wrap of this set is refused with an explanation rather than answered with a broken
tiling, because a periodic tiling of it does not exist.

**Truchet curves join only under a condition.** Smith arcs join because every tile presents an
endpoint at all four edge midpoints, so any orientation meets any neighbour and random
placement is safe. One quarter arc per tile touches two edges out of four and most curves end
in mid air. For diagonals the endpoints sit at corners where four cells meet, so continuity
requires every interior vertex to have an even number of line ends, which reduces to the xor
of every 2x2 block being zero. The fields satisfying that are exactly `x[r][c] = a[r] xor
b[c]` and nothing else, which the test suite confirms by brute force enumeration on small
grids: 2^(H+W-1) valid fields, counted two ways.

**Seamless means seamless to the byte.** On a torus, shifting the tiling by one cell gives
another valid tiling of the same torus, so its rendering must equal the original rendering
shifted by one cell of pixels. That is the test, with no tolerance. Comparing the first pixel
column against the last was tried and rejected: it reads near zero for arcs and about eight
percent for diagonals purely because of the angle at which curves cross an edge.

## What is checked, and how it is known that the checks work

- **46 unit tests** over generated tilings, not fixtures. Every positive assertion has a
  negative control beside it: single-cell corruptions swept over a whole grid, the two broken
  Truchet families required to fail, the wrap check required to reject an open-boundary
  tiling, and the torus solver required to find a torus tiling when one exists.
- **`scripts/check_independent.py`** re-derives edge matching and curve continuity from the
  rendered SVG. It reads the painted polygon colours and reconstructs each arc's centre from
  its endpoints, radius and sweep flag, so it checks the file a viewer sees rather than the
  generator's own structures. It imports only the standard library, which verify proves by
  walking its import graph with `ast` rather than by grepping for the word import. Its own
  negative control recolours one quadrant of one interior cell in a finished file and requires
  the checker to notice.
- **`scripts/sabotage.py`** breaks the generator thirteen ways under the three-gate rule, with
  a null control first: an unmodified copy of the tree in a second directory must fingerprint
  identically, or the run is void. Four of the thirteen are guard removals, where the
  requirement is inverted: the output must be unchanged and the unit suite must fail.
- **`scripts/browser_check.mjs`** drives real headless Chrome over the DevTools protocol, with
  no driver dependency, and measures inside the page rather than from a screenshot: the script
  ran, the canvas has real pixels, all five families report the verdict they should, the page
  and Node produce the same SVG byte for byte, a seed reproduces across two page loads, an
  explicit theme overrides the system preference in both directions, and nothing escapes the
  page at 390 pixels.
- **`scripts/privacy_scan.py`** with a positive control that plants one example of each of its
  eight patterns and requires every pattern to fire before any real file is read.
- The verify run **digests every tracked file before and after** and fails if the run modified
  the tree.

### Sabotage results

Thirteen of thirteen proven: applied, observable in the correct direction, and caught.

```
 1. [attack] scanline ignores the west constraint            caught by unit suite, independent checker
 2. [guard]  the edge checker stops looking east             output unchanged, unit suite fails
 3. [attack] diagonals are drawn unconstrained               caught by unit suite, independent checker
 4. [attack] arc continuity assumes every tile is a Smith tile   caught by unit suite
 5. [attack] the seed is ignored                             caught by unit suite
 6. [attack] SVG numbers are not rounded                     caught by unit suite, independent checker
 7. [attack] the one-cell torus constraint is dropped        caught by unit suite
 8. [attack] the scanline placer is used on incomplete sets  caught by unit suite
 9. [guard]  band radii may be asymmetric                    output unchanged, unit suite fails
10. [guard]  the palette reuses a colour instead of refusing output unchanged, unit suite fails
11. [guard]  the wrapped render alignment guard is removed   output unchanged, unit suite fails
12. [attack] the PNG records the wrong physical resolution   caught by unit suite
13. [attack] the rasteriser goes back to inclusive triangle edges  caught by unit suite
```

Number 13 is the interesting one. On its first run it was a no-op: the fingerprint did not
move at all, because the measured corpus rasterised only arcs and the fill rule it attacks
only affects polygons. The lesson in `AGENTS.md` applies exactly, that a no-op can mean the
corpus is too clean rather than that the check is weak, so the corpus gained a triangle raster
and the suite gained the invariant the rule exists for, that the four quadrants of a cell
partition it with no point claimed twice.

## Two bugs found by these checks

**A seamless tiling that rendered unseamlessly.** The byte for byte shift test failed on a
wrapped Wang tiling with 146 differing pixels at deltas of up to 16 of 255, invisible to the
eye. Two causes, and the first one found was not the real one. Samples landing exactly on a
shared triangle edge were claimed by both triangles and the tie went to whichever was painted
last, which changes when the scene is shifted; that is now resolved by the standard top-left
fill rule. The actual cause was arithmetic: at 96 pixels over 4 cells the unit width of a
pixel is 100/24, and although 24 of those come to exactly 100, the sample coordinate is
computed as (pixel + offset) x unitWidth and that product rounds differently at different
pixels. A wrapped render now requires the unit width to be a dyadic rational and says so with
a list of usable sizes. Adding a tolerance to the test would have hidden the only check that
can catch a real seam.

**A checker blind to a torus one cell wide.** On a 1xN torus a cell's east edge is glued to
its own west edge, which is a constraint on one cell rather than between two, so the neighbour
loop never saw it and every 1xN and Nx1 torus reported clean whatever it contained. The solver
had the matching fix already; the two continuity checkers did not.

## Status

Verified by running `bash scripts/verify.sh`, exit code 0. Pasted output:

```
0. preconditions
  ok    node v24.13.0, python 3.12.3
  ok    28 tracked files digested before the run

1. unit suite
  ok    unit suite: 46 tests passed

2. the published page is what the sources build
  ok    docs/index.html matches its sources, 90804 bytes

3. the command line runs end to end
  ok    report: 30 lines covering every tile set
  ok    naive scanline strands the aperiodic set 100% of the time and the complete sets 0%
  ok    no periodic tiling of the Jeandel-Rao set on any torus up to 5x5, searched exhaustively

4. every family is placed and checked, and the counterexamples fail as they must
  ok    5 families placed; the two counterexamples reported 88 40  violations
  ok    the aperiodic set is placed by the solver:  placement solver in 43 step(s)
  ok    a seamless wrap of the aperiodic set is refused with a reason, not attempted

5. a wrapped PNG is seamless to the byte, and carries its resolution
  ok    seamless      shifting the tiling one cell and shifting the image one cell agree on 270000/270000 bytes
  ok    the PNG on disk is 300x300, 8 bit truecolour, 300 dpi on disk

6. the invariants re-derived from the rendered SVG by an independent checker
    ok    arcs-w.svg: curve continuity, by tracing arc endpoints
           144 shapes, 48 interior edges, 288 endpoints traced, 0 violation(s), expected clean
    ok    arcs.svg: curve continuity, by tracing arc endpoints
           540 shapes, 93 interior edges, 1080 endpoints traced, 0 violation(s), expected clean
    ok    diag-w.svg: diagonal continuity, by counting line ends
           24 shapes, 24 interior vertices, 0 violation(s), expected clean
    ok    diag.svg: diagonal continuity, by counting line ends
           48 shapes, 35 interior vertices, 0 violation(s), expected clean
    ok    tri-jr.svg: edge matching, from the painted colours
           252 shapes, 110 interior edges, 0 violation(s), expected clean
    ok    tri-wrap.svg: edge matching, from the painted colours
           144 shapes, 72 interior edges, 0 violation(s), expected clean
    ok    tri.svg: edge matching, from the painted colours
           140 shapes, 58 interior edges, 0 violation(s), expected clean
    ok    wangarc.svg: curve continuity, by tracing arc endpoints
           216 shapes, 60 interior edges, 432 endpoints traced, 0 violation(s), expected clean
  ok    8 renderings re-checked from their own geometry, all clean
  ok    the counterexample renderings are caught by the independent checker too: 2 reported
  ok    recoloured the east quadrant of cell 1,1 from #f0a35e to #000000, and the independent checker caught it

7. the independent checker really is independent, proved with ast
  ok    check_independent.py shares no code with the package it checks
    imports only argparse, collections, math, re, sys, xml, all standard library, no dynamic import and no subprocess

8. the page in a real browser
    ok    the page script ran and built 1024 shapes
    ok    5 families, 6 tile sets, 6 palettes offered
    ok    the tile inspector drew all 8 tiles of the default set
    ok    the canvas is 783x783 with 401+ distinct colours
    ok    all five families report the verdict they should, including arcs-free with 246 violations and diagonals-free with 105 violations
    ok    the browser and node produce the same 12921 byte SVG, 9293d3b723c8dc30
    ok    the seed in the URL reproduces the same pixels across two page loads, 5694737:92308603
    ok    a different seed draws a different tiling
    ok    16 cells at 12 mm and 300 dpi exports 2268 pixels
    ok    an explicit theme overrides the system preference in both directions, and the toggle cycles auto to light to dark
    ok    at 1280px nothing escapes the page, canvas is 750 css px backed by 783
    ok    at 390px nothing escapes the page, canvas is 337 css px backed by 354
    ok    no uncaught exception and no console error in any of the runs above
  13 passed, 0 failed
  ok    the browser check passed: 13 passed, 0 failed

9. privacy
  ok    positive control: all 8 patterns fired on planted examples (8 hits)
  ok    28 tracked files scanned, no credential-shaped string, no personal path, no NUL byte
  ok    privacy scan clean, with its positive control fired

10. the README says what is true
  ok    README has a Status section and no scaffold marker outside its code fences
  ok    the Status block quotes the current test count, 46

11. the verify run did not modify the tree
  ok    every tracked file is byte for byte what it was

21 passed, 0 failed
VERIFY OK
```

## What is not done

- **The aperiodicity evidence is evidence, not a proof.** The torus search is exhaustive only
  up to 5x5. A set that first admits a periodic tiling at 6x6 would pass every check here.
  The proof belongs to Jeandel and Rao.
- **No PDF or DXF export.** The SVG carries millimetre dimensions and a matching viewBox, which
  is what a printer or a cutter needs, but there is no direct plotter format.
- **The solver is not tuned.** Arc consistency plus minimum remaining values is enough for the
  sizes the tool offers, and a 48x48 Jeandel-Rao grid is slow enough to be noticeable in the
  browser. It has a step budget and reports `capped` rather than guessing when it runs out.
- **Only two Truchet families.** No hexagonal Truchet, no multi-scale subdivision, and no
  Wang tiles over more than four colours in the shipped sets.
- **The page has no undo.** The URL carries the whole state, so the browser's back button is
  the undo, which works but is not obvious.

## Licence

MIT. See [LICENSE](LICENSE).
