#!/usr/bin/env python3
from pathlib import Path
import paramiko
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(
    "94.249.244.208",
    username="taranom",
    pkey=paramiko.Ed25519Key.from_private_key_file(str(Path.home() / ".ssh" / "id_ed25519_taranom")),
    timeout=30,
    allow_agent=False,
    look_for_keys=False,
)


def run(cmd, timeout=120):
    print("==>", cmd[:180])
    _i, o, e = c.exec_command(cmd, timeout=timeout, get_pty=True)
    print(o.read().decode("utf-8", "replace"))
    print("EXIT", o.channel.recv_exit_status())


run(
    "cd /home/taranom/crm-taranom && "
    "git stash push -m deploy-fe38338 -- server/package-lock.json server/routes/products.js 2>/dev/null; "
    "git pull --ff-only origin claude/claude-md-docs-2ssrpy && "
    "git stash pop || true && "
    "pm2 restart erp-taranom --update-env && "
    "sleep 2 && curl -sS -o /dev/null -w 'health:%{http_code}\\n' http://127.0.0.1:3000/api/system/health && "
    "git rev-parse --short HEAD && "
    "grep -E \"title: '\" server/public/acc-nav.js | head -12 && "
    "grep -n erp-taranom-v115 server/public/sw.js && "
    "grep -c _dbgUi server/public/index.html || true && "
    "grep -c debug-ingest server/server.js || true"
)
c.close()
print("DONE")
