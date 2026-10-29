#!/usr/bin/env python3
import subprocess
from pathlib import Path

KEY = str(Path.home() / ".ssh" / "id_ed25519_taranom")
REMOTE = r"""
echo '=== candidates ==='
find /home/taranom -maxdepth 5 -name 'crm.db' 2>/dev/null
echo '=== data dirs ==='
ls -la /home/taranom/crm-taranom/server/data 2>/dev/null | head
ls -la /home/taranom/crm-taranom/data 2>/dev/null | head
echo '=== env (masked) ==='
if [ -f /home/taranom/crm-taranom/server/.env ]; then
  grep -E '^(DB_PATH|UPLOADS_DIR|SYNC_ROLE|PORT)=' /home/taranom/crm-taranom/server/.env | sed -E 's/(SECRET|TOKEN|PASS|KEY).*/\1=***/I'
fi
echo '=== pm2 ==='
pm2 show erp-taranom 2>/dev/null | head -40
"""

p = subprocess.run(
    ["ssh", "-i", KEY, "-o", "BatchMode=yes", "taranom@94.249.244.208", REMOTE],
    capture_output=True,
)
print((p.stdout or b"").decode("utf-8", "replace"))
print((p.stderr or b"").decode("utf-8", "replace"))
raise SystemExit(p.returncode)
