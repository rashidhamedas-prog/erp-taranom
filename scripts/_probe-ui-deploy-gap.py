#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Compare local vs Iran UI/API files (read-only) to find deploy gaps."""
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

FILES = [
    "server/public/index.html",
    "server/public/app.js",
    "server/public/app.css",
    "server/public/sw.js",
    "server/public/prod-ui.js",
    "server/public/prod-ui.css",
    "server/public/acc-nav.js",
    "server/public/i18n.js",
    "server/public/portal-ui.js",
    "server/public/boot.js",
    "server/public/csp-runtime.js",
    "server/public/marketer-ui.js",
    "server/public/mdi.js",
    "server/public/tbl-enhance.js",
    "server/routes/moadian.js",
    "server/routes/product-variants.js",
    "server/routes/production-orders.js",
    "server/routes/production-boms.js",
    "server/lib/production/variance.js",
    "server/lib/production/overhead.js",
    "server/lib/production/labor.js",
    "server/lib/production/bom-advanced.js",
]


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    h.update(path.read_bytes())
    return h.hexdigest()


def main() -> int:
    import paramiko

    local = {f: sha256(ROOT / f) if (ROOT / f).is_file() else None for f in FILES}
    pkey = paramiko.Ed25519Key.from_private_key_file(str(KEY))
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST, username=USER, pkey=pkey, timeout=45, allow_agent=False, look_for_keys=False)

    remote_list = " ".join(f"{APP}/{f}" for f in FILES)
    cmd = (
        f"sha256sum {remote_list} 2>&1; echo '===MARKERS==='; "
        f"grep -n 'erp-taranom-v' {APP}/server/public/sw.js | head -1; "
        f"grep -c 'full-cost' {APP}/server/public/app.js; "
        f"grep -c 'acc-production-boms' {APP}/server/public/acc-nav.js; "
        f"grep -c 'app.js?v=' {APP}/server/public/index.html; "
        f"grep -o 'app.js?v=[0-9]*' {APP}/server/public/index.html | head -1; "
        f"grep -o 'prod-ui.js?v=[0-9]*' {APP}/server/public/index.html | head -1; "
        f"ls -1 {APP}/.sftp-deploy-stamp* 2>/dev/null; "
        f"cd {APP} && git rev-parse --short HEAD; "
        f"curl -sS -o /dev/null -w 'http_sw:%{{http_code}}\\n' http://127.0.0.1:3000/sw.js; "
        f"curl -sS http://127.0.0.1:3000/sw.js | head -c 80; echo; "
        f"curl -sS http://127.0.0.1:3000/index.html | grep -oE 'src=\"/[^\"]+\"' | head -30"
    )
    _i, o, e = c.exec_command(cmd, timeout=90)
    out = o.read().decode("utf-8", "replace")
    err = e.read().decode("utf-8", "replace")
    c.close()

    remote: dict[str, str | None] = {f: None for f in FILES}
    for line in out.splitlines():
        line = line.strip()
        if not line or " " not in line:
            continue
        parts = line.split(None, 1)
        if len(parts) != 2 or len(parts[0]) != 64:
            continue
        digest, path = parts[0], parts[1].lstrip("*")
        for rel in FILES:
            if path.endswith("/" + rel) or path.rstrip("/").endswith(rel):
                remote[rel] = digest
                break

    print("UI deploy gap probe")
    print(f"{'file':<48} {'match':<6} local[:12] remote[:12]")
    print("-" * 90)
    mismatches = []
    for rel in FILES:
        loc = local.get(rel)
        rem = remote.get(rel)
        if loc is None:
            match = "MISS"
        elif rem is None:
            match = "RMISS"
            mismatches.append(rel)
        elif loc == rem:
            match = "YES"
        else:
            match = "NO"
            mismatches.append(rel)
        print(f"{rel:<48} {match:<6} {(loc or '')[:12]:<12} {(rem or '')[:12]}")

    print("\n=== remote extras ===")
    # print everything after MARKERS
    if "===MARKERS===" in out:
        print(out.split("===MARKERS===", 1)[1].strip())
    if err.strip():
        print("stderr:", err.strip()[:500])
    print(f"\nmismatches ({len(mismatches)}):")
    for m in mismatches:
        print(" -", m)
    return 0 if not mismatches else 1


if __name__ == "__main__":
    raise SystemExit(main())
