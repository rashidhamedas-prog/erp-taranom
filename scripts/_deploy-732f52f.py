#!/usr/bin/env python3
"""Deploy 732f52f to Iran: pull + pm2 + health."""
from __future__ import annotations

import sys
from pathlib import Path

import paramiko

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
KEY = Path.home() / ".ssh" / "id_ed25519_taranom"
APP = "/home/taranom/crm-taranom"


def main() -> None:
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(
        "94.249.244.208",
        username="taranom",
        pkey=paramiko.Ed25519Key.from_private_key_file(str(KEY)),
        timeout=30,
        allow_agent=False,
        look_for_keys=False,
    )

    def run(cmd, timeout=120):
        print("==>", cmd)
        _i, o, e = c.exec_command(cmd, timeout=timeout, get_pty=True)
        out = o.read().decode("utf-8", "replace")
        print(out)
        code = o.channel.recv_exit_status()
        print("EXIT", code)
        return code, out

    run(
        f"cd {APP} && "
        "git stash push -m deploy-732f52f -- server/package-lock.json 2>/dev/null; "
        "git fetch origin claude/claude-md-docs-2ssrpy && "
        "git pull --ff-only origin claude/claude-md-docs-2ssrpy && "
        "git stash pop || true && "
        "cd server && pm2 restart erp-taranom --update-env && "
        "sleep 2 && curl -sS -o /dev/null -w 'health:%{http_code}\\n' http://127.0.0.1:3000/api/system/health && "
        "git rev-parse --short HEAD && "
        "grep -n ledger_balance routes/accounting.js | head -3"
    )
    c.close()
    print("DONE")


if __name__ == "__main__":
    main()
