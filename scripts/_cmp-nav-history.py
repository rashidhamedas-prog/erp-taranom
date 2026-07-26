# -*- coding: utf-8 -*-
import hashlib
import re
import subprocess
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
repo = Path(r"d:\soft\Claud\porje\CursorCrm\crm-taranom")


def sh(*a):
    return subprocess.check_output(a, cwd=repo, text=True, encoding="utf-8", errors="replace")


print("HEAD", sh("git", "log", "-1", "--oneline").strip())
try:
    subprocess.check_call(["git", "merge-base", "--is-ancestor", "4ea1870", "HEAD"], cwd=repo)
    print("4ea1870 is ancestor of HEAD: YES")
except subprocess.CalledProcessError:
    print("4ea1870 is ancestor of HEAD: NO")
print("4ea1870", sh("git", "log", "-1", "--oneline", "4ea1870").strip())

for label, rev in [
    ("BEFORE", "e30b92b^:server/public/acc-nav.js"),
    ("MODEL_A", "e30b92b:server/public/acc-nav.js"),
    ("HEAD", "HEAD:server/public/acc-nav.js"),
]:
    t = sh("git", "show", rev)
    titles = re.findall(r"title:\s*'([^']+)'", t)
    print(f"=== {label} titles ({len(titles)}) ===")
    for x in titles:
        print(" ", x)

local = (repo / "server/public/acc-nav.js").read_bytes()
print("local_sha", hashlib.sha256(local).hexdigest()[:12])
print("git_hash_object", sh("git", "hash-object", "server/public/acc-nav.js").strip())
print("git_rev_parse", sh("git", "rev-parse", "HEAD:server/public/acc-nav.js").strip())

idx = sh("git", "show", "HEAD:server/public/index.html")
for pat in [".nav-acc-sub-title", "nav-acc-head", "nav-acc-sub"]:
    print("css", pat, "found" if pat in idx else "MISSING")

# Compare item counts
for label, rev in [("BEFORE", "e30b92b^:server/public/acc-nav.js"), ("HEAD", "HEAD:server/public/acc-nav.js")]:
    t = sh("git", "show", rev)
    ids = re.findall(r"id:\s*'([^']+)'", t)
    print(label, "item_ids", len(ids), "unique", len(set(ids)))
