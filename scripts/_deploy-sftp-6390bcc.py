#!/usr/bin/env python3
"""SFTP fallback — deploy post-6390bcc recovery files (Iran GitHub DNS fails)."""
from __future__ import annotations

import sys
from pathlib import Path

import paramiko

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HOST = "94.249.244.208"
USER = "taranom"
KEY = Path.home() / ".ssh" / "id_ed25519_taranom"
APP = "/home/taranom/crm-taranom"
ROOT = Path(__file__).resolve().parents[1]

FILES = [
    "server/ecosystem.config.js",
    "server/lib/upload-policy.js",
    "server/package.json",
    "server/package-lock.json",
    "server/public/app.js",
    "server/public/sw.js",
    "docs/CHANGE-LOG.md",
    "docs/WAVE0-GATE-STATUS.md",
]


def run(c, cmd, timeout=300):
    print("==>", cmd)
    _i, o, e = c.exec_command(cmd, timeout=timeout, get_pty=True)
    out = o.read().decode("utf-8", "replace")
    err = e.read().decode("utf-8", "replace")
    code = o.channel.recv_exit_status()
    print(out[-4000:] if len(out) > 4000 else out)
    if err.strip():
        print("ERR", err[-400:])
    print("EXIT", code)
    return code


def main() -> None:
    pkey = paramiko.Ed25519Key.from_private_key_file(str(KEY))
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST, username=USER, pkey=pkey, timeout=45, allow_agent=False, look_for_keys=False)
    sftp = c.open_sftp()
    for rel in FILES:
        local = ROOT / rel
        remote = f"{APP}/{rel.replace(chr(92), '/')}"
        parts = remote.split("/")[:-1]
        cur = ""
        for p in parts:
            if not p:
                continue
            cur += "/" + p
            try:
                sftp.stat(cur)
            except OSError:
                try:
                    sftp.mkdir(cur)
                except OSError:
                    pass
        print("PUT", rel, local.stat().st_size)
        sftp.put(str(local), remote)
    sftp.close()
    # Do NOT npm install (DNS often fails); sharp already recovered offline.
    run(c, "pm2 restart erp-taranom --update-env", timeout=90)
    run(
        c,
        "sleep 4; curl -s -o /dev/null -w 'health=%{http_code}\\n' http://127.0.0.1:3000/api/system/health; "
        "grep -n \"erp-taranom-v14\" /home/taranom/crm-taranom/server/public/sw.js | head -1; "
        "test -f /home/taranom/crm-taranom/server/data-encryption-key.txt && echo DEK=YES || echo DEK=NO",
        timeout=60,
    )
    # Mark deploy tip without rewriting git history (github DNS broken)
    run(
        c,
        "cd /home/taranom/crm-taranom && echo SFTP_DEPLOYED=$(date -u +%Y-%m-%dT%H:%M:%SZ) > /home/taranom/crm-taranom/.sftp-deploy-stamp && "
        "echo LOCAL_TIP=5cb88ce >> /home/taranom/crm-taranom/.sftp-deploy-stamp && cat .sftp-deploy-stamp",
        timeout=30,
    )
    c.close()
    print("DONE")


if __name__ == "__main__":
    main()
