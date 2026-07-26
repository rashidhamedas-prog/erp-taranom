#!/usr/bin/env python3
"""Finish Iran deploy: npm + pm2 + verify sync markers."""
from __future__ import annotations

import sys
from pathlib import Path

import paramiko

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HOST = "94.249.244.208"
USER = "taranom"
KEY = Path.home() / ".ssh" / "id_ed25519_taranom"
APP = "/home/taranom/crm-taranom"


def run(c, cmd, timeout=600):
    print("==>", cmd)
    _i, o, e = c.exec_command(cmd, timeout=timeout, get_pty=True)
    out = o.read().decode("utf-8", "replace")
    err = e.read().decode("utf-8", "replace")
    code = o.channel.recv_exit_status()
    text = out if len(out) < 2500 else out[-2500:]
    print(text)
    if err.strip():
        print("ERR", err[-500:])
    print("EXIT", code)
    return code


def main() -> None:
    pkey = paramiko.Ed25519Key.from_private_key_file(str(KEY))
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST, username=USER, pkey=pkey, timeout=30, allow_agent=False, look_for_keys=False)

    run(c, f"cd {APP} && git rev-parse --short HEAD && git status -sb")
    run(c, f"cd {APP}/server && npm install --omit=dev", timeout=600)
    run(c, "pm2 restart erp-taranom --update-env")
    run(c, "sleep 3 && pm2 list")
    run(c, "curl -sS -o /dev/null -w 'health:%{http_code}\\n' http://127.0.0.1:3000/api/system/health")
    run(
        c,
        f"cd {APP} && "
        "grep -n sync_seq_backfill_v2 server/db.js | head -2; "
        "grep -n OVERFLOW_FLOOR server/sync/tables.js | head -2; "
        "grep -n erp.poshaktaranom.com server/public/index.html | head -2; "
        "head -3 server/routes/import.js",
    )
    # Re-apply production party-delete commit if still missing
    run(c, f"cd {APP} && git cherry-pick 74b4b46", timeout=180)
    run(c, f"cd {APP} && git log -4 --oneline")
    run(c, "pm2 restart erp-taranom --update-env")
    run(c, "curl -sS -o /dev/null -w 'health2:%{http_code}\\n' http://127.0.0.1:3000/api/system/health")
    c.close()
    print("DONE")


if __name__ == "__main__":
    main()
