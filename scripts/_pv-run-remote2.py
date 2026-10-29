#!/usr/bin/env python3
import subprocess
from pathlib import Path

KEY = str(Path.home() / ".ssh" / "id_ed25519_taranom")
HOST = "taranom@94.249.244.208"
LOCAL_JS = Path(__file__).resolve().parent / "_pv-ro-remote2.js"
REMOTE_JS = "/home/taranom/crm-taranom/server/_pv-ro-remote2.js"
OUT = Path(__file__).resolve().parents[1] / "reports" / "pv-2026-10-29-raw2.json"
DB = "/home/taranom/crm-taranom/server/crm.db"

subprocess.run([
    "scp", "-i", KEY, "-o", "BatchMode=yes",
    str(LOCAL_JS), f"{HOST}:{REMOTE_JS}",
], check=True)
remote_cmd = (
    f"cd /home/taranom/crm-taranom/server && "
    f"PV_DB={DB} node {REMOTE_JS}; ec=$?; rm -f {REMOTE_JS}; exit $ec"
)
p = subprocess.run(
    ["ssh", "-i", KEY, "-o", "BatchMode=yes", HOST, remote_cmd],
    capture_output=True,
)
text = (p.stdout or b"").decode("utf-8", "replace")
err = (p.stderr or b"").decode("utf-8", "replace")
OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(text if p.returncode == 0 else f"ERROR {p.returncode}\n{err}\n{text}", encoding="utf-8")
print(f"rc={p.returncode} bytes={OUT.stat().st_size}")
print(text[:3000] if p.returncode == 0 else err[:2000])
raise SystemExit(p.returncode)
