#!/usr/bin/env python3
"""Abort failed cherry-pick on Iran and restore healthy origin HEAD + PM2."""
from __future__ import annotations

import sys
from pathlib import Path
import time

import paramiko

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HOST = "94.249.244.208"
USER = "taranom"
KEY = Path.home() / ".ssh" / "id_ed25519_taranom"
APP = "/home/taranom/crm-taranom"


def run(c, cmd, timeout=300):
    print("==>", cmd)
    _i, o, e = c.exec_command(cmd, timeout=timeout, get_pty=True)
    out = o.read().decode("utf-8", "replace")
    code = o.channel.recv_exit_status()
    print(out[-1500:] if len(out) > 1500 else out)
    print("EXIT", code)
    return code


def main() -> None:
    pkey = paramiko.Ed25519Key.from_private_key_file(str(KEY))
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST, username=USER, pkey=pkey, timeout=30, allow_agent=False, look_for_keys=False)

    run(c, f"cd {APP} && git cherry-pick --abort || true")
    run(c, f"cd {APP} && git merge --abort || true")
    run(c, f"cd {APP} && git reset --hard origin/claude/claude-md-docs-2ssrpy")
    run(c, f"cd {APP} && git status -sb && git rev-parse --short HEAD")
    # ensure no conflict markers in critical files
    run(
        c,
        f"cd {APP} && "
        "grep -R \"<<<<<<<\" server/public/index.html server/db.js server/routes/customers.js 2>/dev/null | head || echo 'no conflict markers'",
    )
    run(c, "pm2 restart erp-taranom --update-env")
    time.sleep(5)
    run(c, "pm2 list")
    for i in range(6):
        code = run(
            c,
            "curl -sS -o /dev/null -w 'health:%{http_code}\\n' http://127.0.0.1:3000/api/system/health",
        )
        if code == 0:
            break
        time.sleep(3)
    run(c, "curl -sS http://127.0.0.1:3000/api/system/health | head -c 400; echo")
    c.close()
    print("RECOVERED")


if __name__ == "__main__":
    main()
