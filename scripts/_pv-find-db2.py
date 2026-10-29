#!/usr/bin/env python3
import subprocess
from pathlib import Path

KEY = str(Path.home() / ".ssh" / "id_ed25519_taranom")
REMOTE = r"""
ls -lah /home/taranom/crm-taranom/server/crm.db* 2>/dev/null
echo '---'
# detect from running process open files
PID=$(pm2 pid erp-taranom 2>/dev/null)
echo PID=$PID
if [ -n "$PID" ] && [ "$PID" != "0" ]; then
  ls -l /proc/$PID/cwd
  # open sqlite files
  ls -l /proc/$PID/fd 2>/dev/null | head -5
  for f in /proc/$PID/fd/*; do
    readlink "$f" 2>/dev/null
  done | grep -E '\.db' | sort -u
fi
echo '--- ecosystem ---'
grep -Rni 'DB_PATH\|crm.db' /home/taranom/crm-taranom/server/ecosystem* /home/taranom/crm-taranom/ecosystem* /home/taranom/.pm2/dump.pm2 2>/dev/null | head -30
# size compare
cd /home/taranom/crm-taranom/server && node -e "
const Database=require('better-sqlite3');
for (const p of ['crm.db','data/crm.db','data/erp.db']) {
  try {
    const db=new Database(p,{readonly:true,fileMustExist:true});
    const t=db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' ORDER BY 1\").all().map(r=>r.name);
    const n=t.includes('settings')?db.prepare('SELECT COUNT(*) c FROM settings').get().c:null;
    const w=t.includes('warehouses')?db.prepare('SELECT COUNT(*) c FROM warehouses').get().c:null;
    console.log(p, 'tables', t.length, 'settings', n, 'warehouses', w);
    db.close();
  } catch(e) { console.log(p, 'ERR', e.message); }
}
"
"""

p = subprocess.run(
    ["ssh", "-i", KEY, "-o", "BatchMode=yes", "taranom@94.249.244.208", REMOTE],
    capture_output=True,
)
print((p.stdout or b"").decode("utf-8", "replace"))
print((p.stderr or b"").decode("utf-8", "replace"))
raise SystemExit(p.returncode)
