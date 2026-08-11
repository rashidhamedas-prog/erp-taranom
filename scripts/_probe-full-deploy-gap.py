#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Walk key trees and list local vs Iran SHA-256 mismatches (read-only)."""
from __future__ import annotations

import hashlib
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parents[1]
HOST = "94.249.244.208"
USER = "taranom"
APP = "/home/taranom/crm-taranom"
KEY = Path.home() / ".ssh" / "id_ed25519_taranom"

TREES = [
    "server/public",
    "server/lib/production",
    "server/lib/moadian",
    "server/routes",
    "server/sync",
    "server/middleware",
]


def iter_files():
    for tree in TREES:
        base = ROOT / tree
        if not base.exists():
            continue
        for p in base.rglob("*"):
            if not p.is_file():
                continue
            rel = p.relative_to(ROOT).as_posix()
            # skip bulky/vendor/binary noise
            if "/vendor/" in rel or rel.endswith((".map", ".png", ".jpg", ".webp", ".woff2", ".woff", ".ttf")):
                continue
            if rel.endswith((".enc", ".db", ".sqlite", ".log")):
                continue
            yield rel


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    import paramiko

    files = sorted(iter_files())
    local = {rel: sha256(ROOT / rel) for rel in files}

    pkey = paramiko.Ed25519Key.from_private_key_file(str(KEY))
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST, username=USER, pkey=pkey, timeout=45, allow_agent=False, look_for_keys=False)

    # Also compare critical root server files
    extra = [
        "server/db.js",
        "server/server.js",
        "server/package.json",
    ]
    for e in extra:
        if (ROOT / e).is_file() and e not in local:
            local[e] = sha256(ROOT / e)
            files.append(e)

    # Batch sha256sum in chunks
    remote: dict[str, str | None] = {f: None for f in files}
    chunk_size = 40
    for i in range(0, len(files), chunk_size):
        chunk = files[i : i + chunk_size]
        remote_list = " ".join(f"{APP}/{f}" for f in chunk)
        _i, o, e = c.exec_command(f"sha256sum {remote_list} 2>&1", timeout=120)
        out = o.read().decode("utf-8", "replace")
        for line in out.splitlines():
            line = line.strip()
            if not line or " " not in line:
                continue
            parts = line.split(None, 1)
            if len(parts) != 2 or len(parts[0]) != 64:
                continue
            digest, path = parts[0], parts[1].lstrip("*")
            for rel in chunk:
                if path.endswith("/" + rel) or path.rstrip("/").endswith(rel):
                    remote[rel] = digest
                    break

    # also check missing files remotely with test -f
    missing_remote = [rel for rel, d in remote.items() if d is None]
    if missing_remote:
        # confirm with test
        checks = "; ".join(f'test -f {APP}/{rel} && echo HAS:{rel} || echo MISS:{rel}' for rel in missing_remote[:80])
        _i, o, e = c.exec_command(checks, timeout=120)
        confirm = o.read().decode("utf-8", "replace")
        for line in confirm.splitlines():
            if line.startswith("HAS:"):
                # rare: sha failed but exists — leave as mismatch
                pass
            elif line.startswith("MISS:"):
                remote[line[5:]] = None

    c.close()

    mismatches = []
    missing = []
    match_n = 0
    for rel in files:
        loc = local[rel]
        rem = remote.get(rel)
        if rem is None:
            missing.append(rel)
            mismatches.append(rel)
        elif rem != loc:
            mismatches.append(rel)
        else:
            match_n += 1

    print(f"compared={len(files)} match={match_n} mismatch={len(mismatches)} missing_remote={len(missing)}")
    print("\nMISMATCHES:")
    for rel in mismatches:
        rem = remote.get(rel)
        tag = "MISSING" if rem is None else "DIFF"
        print(f"  [{tag}] {rel}")
    return 0 if not mismatches else 1


if __name__ == "__main__":
    raise SystemExit(main())
