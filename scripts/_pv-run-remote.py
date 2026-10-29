#!/usr/bin/env python3
from __future__ import annotations

import subprocess
from pathlib import Path

KEY = Path.home() / ".ssh" / "id_ed25519_taranom"
HOST = "taranom@94.249.244.208"
LOCAL_JS = Path(__file__).resolve().parent / "_pv-ro-remote.js"
REMOTE_JS = "/home/taranom/crm-taranom/server/_pv-ro-remote.js"
OUT = Path(__file__).resolve().parents[1] / "reports" / "pv-2026-10-29-raw.json"
DB = "/home/taranom/crm-taranom/server/crm.db"


def run(args, **kw):
    return subprocess.run(args, check=True, **kw)


def main():
    OUT.parent.mkdir(parents=True, exist_ok=True)
    run([
        "scp", "-i", str(KEY), "-o", "BatchMode=yes",
        str(LOCAL_JS), f"{HOST}:{REMOTE_JS}",
    ])
    remote_cmd = (
        f"cd /home/taranom/crm-taranom/server && "
        f"PV_DB={DB} node {REMOTE_JS}; "
        f"ec=$?; rm -f {REMOTE_JS}; exit $ec"
    )
    p = subprocess.run(
        ["ssh", "-i", str(KEY), "-o", "BatchMode=yes", HOST, remote_cmd],
        capture_output=True,
    )
    text = (p.stdout or b"").decode("utf-8", "replace")
    err = (p.stderr or b"").decode("utf-8", "replace")
    OUT.write_text(text if p.returncode == 0 else f"ERROR {p.returncode}\n{err}\n{text}", encoding="utf-8")
    print(f"rc={p.returncode} bytes={OUT.stat().st_size}")
    if p.returncode != 0:
        print(err[:2000])
        raise SystemExit(p.returncode)
    print(text[:2500])


if __name__ == "__main__":
    main()
