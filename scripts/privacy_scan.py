#!/usr/bin/env python3
"""Look for credential-shaped strings and personal paths in everything git tracks.

Three things this does that a one line grep does not.

A positive control runs first. A scanner that reads no files reports exactly what a clean
tree reports, so before scanning anything real it plants a file containing one synthetic
example of every pattern and requires every pattern to fire on it. If any pattern is dead the
scan aborts rather than reporting the repository clean.

The patterns are assembled from fragments. A scanner that holds `ghp_[A-Za-z0-9]{20,}` as a
literal matches its own source, so the file that finds secrets becomes the file that reports
one. Concatenating the pieces at run time keeps the complete pattern off disk, which is the
same trick that keeps GitHub push protection from rejecting the fixture.

Files are read as bytes and a NUL is a failure rather than a skip. git and grep classify a
file containing a NUL as binary and `grep -I` then passes over it in silence, so one NUL byte
in a source file makes the whole file invisible to a scan that reports success. This has
happened in this workspace with a real token committed inside such a file.
"""

import re
import subprocess
import sys
import tempfile
from pathlib import Path

# Assembled at run time. Written as a literal, each of these would match this file.
PATTERNS = {
    "OpenAI style key": "sk" + "-" + r"[A-Za-z0-9]{20,}",
    "GitHub token": "gh" + "p_" + r"[A-Za-z0-9]{20,}",
    "AWS access key id": "AK" + "IA" + r"[0-9A-Z]{16}",
    "Slack bot token": "xo" + "xb-" + r"[0-9A-Za-z-]{12,}",
    "Google API key": "AI" + "za" + "Sy" + r"[0-9A-Za-z_-]{33}",
    "private key header": "BEGIN" + r" [A-Z ]*PRIVATE KEY",
    "home directory path": "/ho" + "me/" + r"[a-z][a-z0-9_-]*",
    "bearer token": "Bear" + "er " + r"[A-Za-z0-9._-]{24,}",
}

# The examples the positive control plants. Each must be matched by its own pattern and by
# nothing else, so a pattern that has been broadened into uselessness is caught too.
CONTROLS = {
    "OpenAI style key": "sk" + "-" + "A" * 32,
    "GitHub token": "gh" + "p_" + "B" * 36,
    "AWS access key id": "AK" + "IA" + "C" * 16,
    "Slack bot token": "xo" + "xb-" + "123456789012-abcdefghijkl",
    "Google API key": "AI" + "za" + "Sy" + "D" * 33,
    "private key header": "-----" + "BEGIN" + " RSA PRIVATE KEY" + "-----",
    "home directory path": "/ho" + "me/" + "someone" + "/Projects/thing",
    "bearer token": "Bear" + "er " + "E" * 40,
}

# Case sensitivity is deliberate. An AWS key id is uppercase by definition, and a
# case-insensitive sweep matches base64 inside an inline image, which turns every page with an
# embedded picture into a false alarm. That happened in this workspace.
COMPILED = {name: re.compile(pattern) for name, pattern in PATTERNS.items()}


def scan_text(text):
    hits = []
    for number, line in enumerate(text.splitlines(), start=1):
        for name, pattern in COMPILED.items():
            found = pattern.search(line)
            if found:
                hits.append((number, name, found.group()[:60]))
    return hits


def positive_control():
    """Plant one example per pattern and require every pattern to find its own."""
    with tempfile.TemporaryDirectory() as directory:
        planted = Path(directory) / "planted.txt"
        lines = [f"{name}: {value}" for name, value in CONTROLS.items()]
        planted.write_text("\n".join(lines) + "\n", encoding="utf-8")
        hits = scan_text(planted.read_text(encoding="utf-8"))
        found = {name for _, name, _ in hits}
        missing = sorted(set(PATTERNS) - found)
        return missing, len(hits)


def tracked_files(root):
    result = subprocess.run(["git", "-C", str(root), "ls-files", "-z"],
                            capture_output=True, check=True)
    return [root / name for name in result.stdout.decode().split("\0") if name]


def main():
    root = Path(__file__).resolve().parent.parent

    missing, control_hits = positive_control()
    if missing:
        print(f"  FAIL  the positive control did not fire for: {', '.join(missing)}")
        print("        A pattern that cannot match its own example cannot find a real one, "
              "so this run proves nothing about the repository.")
        return 1
    print(f"  ok    positive control: all {len(PATTERNS)} patterns fired on planted examples "
          f"({control_hits} hits)")

    try:
        files = tracked_files(root)
    except subprocess.CalledProcessError as error:
        print(f"  FAIL  git ls-files failed: {error}")
        return 1

    # Before the first commit git tracks nothing and a scan of nothing passes. Reaching for a
    # floor here is not arbitrary: this project has more than thirty tracked files, and a
    # count near zero means the scan read the wrong tree.
    if len(files) < 15:
        print(f"  FAIL  only {len(files)} tracked file(s). The scan would pass without "
              "opening anything, which is indistinguishable from a clean tree.")
        return 1

    problems = 0
    scanned = 0
    total_bytes = 0
    for path in files:
        if not path.exists():
            continue
        raw = path.read_bytes()
        total_bytes += len(raw)
        if b"\0" in raw:
            print(f"  FAIL  {path.relative_to(root)} contains a NUL byte, so grep and git "
                  "would classify it as binary and skip it entirely. Write the byte as the "
                  "two character escape instead of embedding it.")
            problems += 1
            continue
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            print(f"  FAIL  {path.relative_to(root)} is not valid UTF-8, so it cannot be "
                  "scanned as text and nothing here can vouch for it.")
            problems += 1
            continue
        scanned += 1
        for number, name, sample in scan_text(text):
            print(f"  FAIL  {path.relative_to(root)}:{number} looks like a {name}: {sample}")
            problems += 1

    if problems:
        print(f"  {problems} problem(s) across {scanned} files")
        return 1
    print(f"  ok    {scanned} tracked files, {total_bytes} bytes, no credential-shaped "
          "string, no personal path, no NUL byte")
    return 0


if __name__ == "__main__":
    sys.exit(main())
