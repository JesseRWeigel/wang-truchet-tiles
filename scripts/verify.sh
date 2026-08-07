#!/usr/bin/env bash
# Verification for wang-truchet-tiles. The exit code is the result.
#
# Design rules this script holds to.
#
# Nothing prints success for a step it did not run. A missing browser, a missing python, a
# missing file: each is a FAILURE with an actionable message, never a skip, because a skipped
# check and a passing check read identically in a log a week later.
#
# Every claim that matters is checked twice by different code. The unit suite asserts the
# invariants over generated tilings using the generator's own checkers; step 6 re-derives the
# same invariants from the rendered SVG in Python, which imports nothing from this project,
# and step 7 proves that independence by walking the import graph with `ast` rather than by
# grepping for the word import.
#
# Every checker is shown to be capable of failing. The counterexample families must be
# reported as broken, and a deliberately recoloured quadrant must be caught, because a
# checker that always passes proves nothing at all.
#
# The run must not modify the tree. Every tracked file is digested at the start and compared
# at the end, so a script that quietly rewrites a fixture and then passes because of it is a
# named failure rather than a mystery.

set -uo pipefail
cd "$(dirname "$0")/.."

pass=0
fail=0
ok()  { printf '  ok    %s\n' "$1"; pass=$((pass + 1)); }
bad() { printf '  FAIL  %s\n' "$1"; fail=$((fail + 1)); }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# The number of tests is a claim like any other, so it is asserted rather than described.
# Update it deliberately when you add a test, and never by pasting whatever the run printed.
EXPECTED_TESTS=45

digest_tree() {
  git ls-files -z \
    | xargs -0 sha256sum 2>/dev/null \
    | LC_ALL=C sort \
    | sha256sum \
    | cut -d' ' -f1
}

echo "0. preconditions"
missing=0
for tool in node python3 git; do
  if command -v "$tool" >/dev/null 2>&1; then continue; fi
  printf '  FAIL  %s is not installed, and nothing here can run without it\n' "$tool"
  missing=1
done
if [ "$missing" -ne 0 ]; then
  echo "VERIFY FAILED: install the tools above and run this again"
  exit 1
fi
node_major=$(node -p 'process.versions.node.split(".")[0]')
if [ "$node_major" -lt 18 ]; then
  bad "node $(node -v) is too old; the test runner and the fetch used by the browser check need 18 or later"
else
  ok "node $(node -v), python $(python3 -c 'import platform; print(platform.python_version())')"
fi
before="$(digest_tree)"
tracked=$(git ls-files | wc -l)
ok "$tracked tracked files digested as $before"

echo
echo "1. unit suite"
if node --test --test-reporter=tap tests/*.mjs > "$work/tests.txt" 2>&1; then
  ran=$(grep -c '^ok ' "$work/tests.txt" || true)
  passed=$(sed -n 's/^# pass \([0-9]*\)$/\1/p' "$work/tests.txt" | tail -1)
  failed=$(sed -n 's/^# fail \([0-9]*\)$/\1/p' "$work/tests.txt" | tail -1)
  if [ "${passed:-0}" -ne "$EXPECTED_TESTS" ] || [ "${failed:-1}" -ne 0 ]; then
    bad "the suite reports ${passed:-?} passed and ${failed:-?} failed, expected $EXPECTED_TESTS and 0. If you added a test, update EXPECTED_TESTS in this script."
  else
    ok "unit suite: $passed tests passed"
  fi
else
  grep -E '^not ok |^  *error:|AssertionError' "$work/tests.txt" | head -20
  bad "unit suite"
fi

echo
echo "2. the published page is what the sources build"
# The page is generated from src/ and web/, so a change to the generator that was never
# rebuilt would leave docs/index.html showing last week's behaviour while every test passes.
if node scripts/build_docs.mjs --check > "$work/docs.txt" 2>&1; then
  ok "$(cat "$work/docs.txt")"
else
  cat "$work/docs.txt"
  bad "docs/index.html does not match its sources"
fi

echo
echo "3. the command line runs end to end"
if node src/cli.mjs report > "$work/report.txt" 2>&1; then
  sets=$(grep -cE '^  (stochastic|full|jeandel)' "$work/report.txt" || true)
  if [ "$sets" -lt 6 ]; then
    bad "the report covered $sets tile sets, expected at least 6"
  else
    ok "report: $(grep -c . "$work/report.txt") lines covering every tile set"
  fi
else
  tail -20 "$work/report.txt"
  bad "the report command failed"
fi

# The two measurements the README quotes, asserted here against the report rather than
# retyped into prose where they would go stale silently.
if grep -q 'jeandel-rao    failure rate  100.0%' "$work/report.txt" \
   && grep -q 'stochastic-2   failure rate    0.0%' "$work/report.txt"; then
  ok "naive scanline strands the aperiodic set 100% of the time and the complete sets 0%"
else
  grep 'failure rate' "$work/report.txt" || true
  bad "the scanline failure rates are not what the README claims"
fi

if grep -q 'exhaustive torus search 1x1 through 5x5: 0 periodic tiling(s) found' "$work/report.txt"; then
  ok "no periodic tiling of the Jeandel-Rao set on any torus up to 5x5, searched exhaustively"
else
  bad "the exhaustive torus search did not come back empty, which would contradict aperiodicity"
fi

echo
echo "4. every family is placed and checked, and the counterexamples fail as they must"
family_problems=0
for family in wang arcs diagonals; do
  if ! node src/cli.mjs check --family "$family" --width 11 --height 9 --seed verify \
      > "$work/check-$family.txt" 2>&1; then
    cat "$work/check-$family.txt"
    family_problems=$((family_problems + 1))
  fi
done
for family in arcs-free diagonals-free; do
  # These must report violations. The CLI exits 0 when a counterexample is broken, which is
  # the correct outcome, and exits 1 if it comes back clean.
  if ! node src/cli.mjs check --family "$family" --width 11 --height 9 --seed verify \
      > "$work/check-$family.txt" 2>&1; then
    cat "$work/check-$family.txt"
    family_problems=$((family_problems + 1))
  fi
  if ! grep -q 'PASS: broken' "$work/check-$family.txt"; then
    cat "$work/check-$family.txt"
    family_problems=$((family_problems + 1))
  fi
done
if [ "$family_problems" -eq 0 ]; then
  broken_counts=$(grep -h 'violation' "$work/check-arcs-free.txt" "$work/check-diagonals-free.txt" \
    | sed -n 's/.*: \([0-9]*\) violation.*/\1/p' | tr '\n' ' ')
  ok "5 families placed; the two counterexamples reported $broken_counts violations"
else
  bad "$family_problems problem(s) across the five families"
fi

# The set that needs the solver, and the wrap it cannot have.
if node src/cli.mjs check --family wang --set jeandel-rao --width 14 --height 14 \
    --seed verify > "$work/jr.txt" 2>&1 && grep -q 'placement  solver' "$work/jr.txt"; then
  ok "the aperiodic set is placed by the solver: $(grep 'placement' "$work/jr.txt" | tr -s ' ')"
else
  cat "$work/jr.txt"
  bad "the aperiodic set was not placed by the solver"
fi
if node src/cli.mjs check --family wang --set jeandel-rao --torus --width 6 --height 6 \
    > "$work/jrtorus.txt" 2>&1; then
  bad "asking for a seamless wrap of an aperiodic set succeeded, which cannot be right"
else
  if grep -q 'aperiodic' "$work/jrtorus.txt"; then
    ok "a seamless wrap of the aperiodic set is refused with a reason, not attempted"
  else
    cat "$work/jrtorus.txt"
    bad "the refusal did not explain itself"
  fi
fi

echo
echo "5. a wrapped PNG is seamless to the byte, and carries its resolution"
if node src/cli.mjs png --out "$work/seam.png" --family arcs --width 6 --height 6 --torus \
    --bands 3 --pixel-width 300 > "$work/png.txt" 2>&1; then
  if grep -q 'seamless      shifting the tiling one cell' "$work/png.txt" \
     && ! grep -q 'worst channel delta' "$work/png.txt"; then
    ok "$(grep 'seamless' "$work/png.txt" | sed 's/^ *//')"
  else
    cat "$work/png.txt"
    bad "the seam test did not come back exact"
  fi
else
  cat "$work/png.txt"
  bad "the PNG command failed"
fi
if node -e '
  const { readPngHeader } = await import("./src/png.mjs");
  const { readFileSync } = await import("node:fs");
  const bytes = readFileSync(process.argv[1]);
  const header = readPngHeader(bytes);
  const view = Buffer.from(bytes);
  let offset = 8, dpi = null;
  while (offset < view.length) {
    const length = view.readUInt32BE(offset);
    if (view.toString("ascii", offset + 4, offset + 8) === "pHYs") {
      dpi = Math.round(view.readUInt32BE(offset + 8) * 0.0254);
    }
    offset += 12 + length;
  }
  if (header.width !== 300 || header.bitDepth !== 8 || header.colourType !== 2 || dpi !== 300) {
    console.error(`header ${JSON.stringify(header)} dpi ${dpi}`);
    process.exit(1);
  }
  console.log(`${header.width}x${header.height}, 8 bit truecolour, ${dpi} dpi on disk`);
' "$work/seam.png" > "$work/pnghdr.txt" 2>&1; then
  ok "the PNG on disk is $(cat "$work/pnghdr.txt")"
else
  cat "$work/pnghdr.txt"
  bad "the PNG header does not match what was asked for"
fi

echo
echo "6. the invariants re-derived from the rendered SVG by an independent checker"
mkdir -p "$work/svg"
gen_problems=0
gen() { node src/cli.mjs svg --out "$work/svg/$1.svg" "${@:2}" > /dev/null 2>&1 \
  || gen_problems=$((gen_problems + 1)); }
gen tri      --family wang --set stochastic-3 --style triangles --width 7 --height 5 --seed iv
gen tri-jr   --family wang --set jeandel-rao --style triangles --width 9 --height 7 --seed iv
gen tri-wrap --family wang --set full-3 --width 6 --height 6 --torus --seed iv
gen arcs     --family arcs --width 9 --height 6 --bands 5 --seed iv
gen arcs-w   --family arcs --width 6 --height 4 --torus --bands 3 --seed iv
gen wangarc  --family wang --set full-2 --style arcs --width 6 --height 6 --bands 3 --seed iv
gen diag     --family diagonals --width 8 --height 6 --seed iv
gen diag-w   --family diagonals --width 6 --height 4 --torus --seed iv
mkdir -p "$work/broken"
node src/cli.mjs svg --out "$work/broken/quarter.svg" --family arcs-free --width 8 --height 6 \
  --seed iv > /dev/null 2>&1 || gen_problems=$((gen_problems + 1))
node src/cli.mjs svg --out "$work/broken/freediag.svg" --family diagonals-free --width 8 \
  --height 6 --seed iv > /dev/null 2>&1 || gen_problems=$((gen_problems + 1))
if [ "$gen_problems" -ne 0 ]; then
  bad "$gen_problems SVG(s) failed to generate, so the independent check has nothing to read"
else
  if python3 scripts/check_independent.py "$work"/svg/*.svg > "$work/indep.txt" 2>&1; then
    sed 's/^/  /' "$work/indep.txt"
    ok "8 renderings re-checked from their own geometry, all clean"
  else
    cat "$work/indep.txt"
    bad "the independent checker rejected a rendering the generator called clean"
  fi

  if python3 scripts/check_independent.py --expect-broken "$work"/broken/*.svg \
      > "$work/indep-broken.txt" 2>&1; then
    ok "the counterexample renderings are caught by the independent checker too: $(grep -c 'violation' "$work/indep-broken.txt") reported"
  else
    cat "$work/indep-broken.txt"
    bad "the independent checker passed a rendering that is broken on purpose"
  fi

  # A negative control on the checker itself. One quadrant of one interior cell is recoloured
  # in the finished file, which is a defect no generator test could ever see, and the checker
  # has to notice. Without this the eight clean results above could come from a checker that
  # reads the file and returns an empty list.
  if python3 - "$work/svg/tri.svg" "$work/corrupt.svg" <<'PYTHON' > "$work/corrupt.txt" 2>&1
import re, sys
source, target = sys.argv[1], sys.argv[2]
text = open(source).read()
box = [float(v) for v in re.search(r'viewBox="([^"]+)"', text).group(1).split()]
grid = re.search(r'grid: (\d+)x(\d+)', text)
width, height = int(grid.group(1)), int(grid.group(2))
cell = box[2] / width
chosen = None
for match in re.finditer(r'<polygon points="([^"]+)" fill="(#[0-9a-fA-F]+)"', text):
    points = [tuple(float(n) for n in pair.split(',')) for pair in match.group(1).split()]
    cx = sum(p[0] for p in points) / 3
    cy = sum(p[1] for p in points) / 3
    column, row = int(cx // cell), int(cy // cell)
    outer = [p for p in points if abs(p[0] - (column + 0.5) * cell) > 1e-6
             or abs(p[1] - (row + 0.5) * cell) > 1e-6]
    east = all(abs(p[0] - (column + 1) * cell) < 1e-6 for p in outer)
    if east and 0 < column < width - 1 and 0 < row < height - 1:
        chosen = (match, row, column)
        break
if chosen is None:
    sys.exit('found no interior east quadrant to corrupt')
match, row, column = chosen
was = match.group(2)
now = '#000000' if was.lower() != '#000000' else '#ffffff'
open(target, 'w').write(text[:match.start(2)] + now + text[match.end(2):])
print(f'recoloured the east quadrant of cell {row},{column} from {was} to {now}')
PYTHON
  then
    if python3 scripts/check_independent.py --expect-broken "$work/corrupt.svg" \
        >> "$work/corrupt.txt" 2>&1; then
      ok "$(head -1 "$work/corrupt.txt"), and the independent checker caught it"
    else
      cat "$work/corrupt.txt"
      bad "one recoloured quadrant went unnoticed, so the independent checker is inert"
    fi
  else
    cat "$work/corrupt.txt"
    bad "could not build the corrupted fixture, so the checker was never shown to fail"
  fi
fi

echo
echo "7. the independent checker really is independent, proved with ast"
if python3 - <<'PYTHON' > "$work/ast.txt" 2>&1
import ast, pathlib, sys

target = pathlib.Path("scripts/check_independent.py")
tree = ast.parse(target.read_text(), filename=str(target))
imported, problems = set(), []
for node in ast.walk(tree):
    if isinstance(node, ast.Import):
        for alias in node.names:
            imported.add(alias.name.split(".")[0])
    elif isinstance(node, ast.ImportFrom):
        if node.level:
            problems.append(f"relative import of {node.module!r}, which could reach the package")
        imported.add((node.module or "").split(".")[0])
    elif isinstance(node, ast.Call):
        name = getattr(node.func, "attr", None) or getattr(node.func, "id", None)
        if name in {"import_module", "__import__", "exec", "eval"}:
            problems.append(f"a dynamic {name} call, which a grep for the word import misses")
        if name in {"run", "Popen", "check_output", "system"}:
            problems.append(f"a {name} call, which could shell out to the generator")

outside = sorted(imported - set(sys.stdlib_module_names))
if outside:
    problems.append(f"imports outside the standard library: {outside}")
for module in sorted(imported):
    if pathlib.Path(f"src/{module}.py").exists() or pathlib.Path(module).exists():
        problems.append(f"{module} resolves to a path inside this repository")

if problems:
    for problem in problems:
        print(f"    {problem}")
    sys.exit(1)
print(f"    imports only {', '.join(sorted(imported))}, all standard library, "
      "no dynamic import and no subprocess")
PYTHON
then
  ok "check_independent.py shares no code with the package it checks"
  cat "$work/ast.txt"
else
  cat "$work/ast.txt"
  bad "the independent checker is not independent"
fi

echo
echo "8. the page in a real browser"
if node scripts/browser_check.mjs > "$work/browser.txt" 2>&1; then
  sed 's/^/  /' "$work/browser.txt" | grep -v '^  *$'
  ok "the browser check passed: $(tail -1 "$work/browser.txt")"
else
  status=$?
  cat "$work/browser.txt"
  if [ "$status" -eq 2 ]; then
    bad "the browser check COULD NOT RUN, which is a failure and not a skip"
  else
    bad "the browser check failed"
  fi
fi

echo
echo "9. privacy"
if python3 scripts/privacy_scan.py > "$work/privacy.txt" 2>&1; then
  sed 's/^/  /' "$work/privacy.txt" | sed 's/^  //'
  ok "privacy scan clean, with its positive control fired"
else
  cat "$work/privacy.txt"
  bad "the privacy scan found something, or its positive control did not fire"
fi

echo
echo "10. the README says what is true"
if [ ! -f README.md ]; then
  bad "there is no README.md"
else
  # Scaffold markers are searched for OUTSIDE fenced code blocks only. The Status section
  # holds the pasted transcript of this script, and this script prints the word TODO in this
  # very check, so a naive search matches its own output and fails a finished project.
  if python3 - <<'PYTHON' > "$work/readme.txt" 2>&1
import re, sys

text = open("README.md", encoding="utf-8").read()
lines = text.splitlines()
outside, fenced, inside = [], False, 0
for line in lines:
    if line.lstrip().startswith("```"):
        fenced = not fenced
        continue
    if fenced:
        inside += 1
        continue
    outside.append(line)
if fenced:
    sys.exit("a fenced code block is never closed")
prose = "\n".join(outside)

problems = []
markers = ["TO" + "DO", "FIX" + "ME", "replace with a real description", "NOT YET VERIFIED",
           "Everything.", "XX" + "X"]
for marker in markers:
    if marker in prose:
        problems.append(f"the prose still contains the scaffold marker {marker!r}")
if "## Status" not in text:
    problems.append("there is no Status section")
if inside < 20:
    problems.append(f"only {inside} lines inside code fences, so no real output is pasted")
if problems:
    for problem in problems:
        print(f"    {problem}")
    sys.exit(1)
print(f"    {len(lines)} lines, {inside} of them pasted output, no scaffold marker in the prose")
PYTHON
  then
    ok "README has a Status section and no scaffold marker outside its code fences"
    cat "$work/readme.txt"
  else
    cat "$work/readme.txt"
    bad "the README is not finished"
  fi

  # The pasted transcript has to be this run's transcript. Checking the test count closes the
  # gap where a project reports 33 green checks beside a Status block from three changes ago.
  if grep -qF "unit suite: $EXPECTED_TESTS tests passed" README.md; then
    ok "the Status block quotes the current test count, $EXPECTED_TESTS"
  else
    bad "README.md does not contain 'unit suite: $EXPECTED_TESTS tests passed', so its pasted output is stale"
  fi
fi

echo
echo "11. the verify run did not modify the tree"
after="$(digest_tree)"
if [ "$before" = "$after" ]; then
  ok "every tracked file is byte for byte what it was, $after"
else
  git status --short
  bad "the tree changed during verification: $before became $after"
fi

echo
printf '%d passed, %d failed\n' "$pass" "$fail"
if [ "$fail" -ne 0 ]; then echo "VERIFY FAILED"; exit 1; fi
echo "VERIFY OK"
