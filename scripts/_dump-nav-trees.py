# -*- coding: utf-8 -*-
"""Dump BEFORE vs HEAD acc-nav section trees for comparison."""
import re
import subprocess
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
repo = Path(r"d:\soft\Claud\porje\CursorCrm\crm-taranom")


def show(rev):
    return subprocess.check_output(
        ["git", "show", rev], cwd=repo, text=True, encoding="utf-8", errors="replace"
    )


def parse_sections(src: str):
    # crude extract of ACC_NAV_SECTIONS array body
    m = re.search(r"const ACC_NAV_SECTIONS\s*=\s*\[", src)
    if not m:
        return []
    i = m.end() - 1
    depth = 0
    start = None
    for j, ch in enumerate(src[i:], i):
        if ch == "[":
            if depth == 0:
                start = j
            depth += 1
        elif ch == "]":
            depth -= 1
            if depth == 0 and start is not None:
                body = src[start : j + 1]
                break
    else:
        return []

    # split top-level objects by tracking braces
    secs = []
    depth = 0
    obj_start = None
    for j, ch in enumerate(body):
        if ch == "{":
            if depth == 0:
                obj_start = j
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0 and obj_start is not None:
                secs.append(body[obj_start : j + 1])
                obj_start = None
    out = []
    for s in secs:
        tm = re.search(r"title:\s*'([^']+)'", s)
        title = tm.group(1) if tm else "?"
        items = re.findall(r"\{\s*id:\s*'([^']+)'\s*,\s*icon:\s*'[^']*'\s*,\s*label:\s*'([^']*)'", s)
        out.append((title, items))
    return out


for label, rev in [
    ("BEFORE (pre Model A)", "e30b92b^:server/public/acc-nav.js"),
    ("NOW (HEAD)", "HEAD:server/public/acc-nav.js"),
]:
    print("=" * 60)
    print(label)
    print("=" * 60)
    for title, items in parse_sections(show(rev)):
        print(f"\n## {title} ({len(items)} items)")
        for iid, lab in items:
            print(f"  - {lab} [{iid}]")

# missing items
before_ids = {i for _, items in parse_sections(show("e30b92b^:server/public/acc-nav.js")) for i, _ in items}
now_ids = {i for _, items in parse_sections(show("HEAD:server/public/acc-nav.js")) for i, _ in items}
print("\n=== ONLY IN BEFORE (lost?) ===")
for x in sorted(before_ids - now_ids):
    print(" ", x)
print("\n=== ONLY IN NOW (added) ===")
for x in sorted(now_ids - before_ids):
    print(" ", x)
