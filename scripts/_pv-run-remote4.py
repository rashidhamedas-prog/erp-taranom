#!/usr/bin/env python3
import subprocess
from pathlib import Path
KEY = str(Path.home() / ".ssh" / "id_ed25519_taranom")
HOST = "taranom@94.249.244.208"
LOCAL = Path(__file__).resolve().parent / "_pv-ro-remote4.js"
REMOTE = "/home/taranom/crm-taranom/server/_pv-ro-remote4.js"
OUT = Path(__file__).resolve().parents[1] / "reports" / "pv-2026-10-29-bal2.json"
DB = "/home/taranom/crm-taranom/server/crm.db"
subprocess.run(["scp","-i",KEY,"-o","BatchMode=yes",str(LOCAL),f"{HOST}:{REMOTE}"], check=True)
cmd = f"cd /home/taranom/crm-taranom/server && PV_DB={DB} node {REMOTE}; ec=$?; rm -f {REMOTE}; exit $ec"
p = subprocess.run(["ssh","-i",KEY,"-o","BatchMode=yes",HOST,cmd], capture_output=True)
text = (p.stdout or b"").decode("utf-8","replace")
OUT.write_text(text, encoding="utf-8")
print(text)
raise SystemExit(p.returncode)
