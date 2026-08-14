#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""SFTP overlay: Demo V3 only. No git pull. No --update-env."""
from __future__ import annotations

import sys
from datetime import datetime, timezone
from pathlib import Path

import paramiko

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HOST = "94.249.244.208"
USER = "taranom"
KEY = Path.home() / ".ssh" / "id_ed25519_taranom"
APP = "/home/taranom/crm-taranom"
ROOT = Path(__file__).resolve().parents[1]
STAMP_HASH = "bb868c5"
STAMP_FILE = ".sftp-deploy-stamp-demo-v3"

FILES = [
    "docs/CHANGE-LOG.md",
    "docs/architecture/DEMO-V3-DESIGN.md",
    "server/public/demo.css",
    "server/public/demo.html",
    "server/public/demo.js",
    "server/public/demo-v3-app.js",
    "server/public/demo-v3-seed.js",
    "server/public/demo-v3-store.js",
    "server/public/demo-v3-tour.js",
    "server/scripts/test-demo-static.js",
    "server/scripts/test-demo-v3.js",
]


def run(c, cmd, timeout=300):
    print("==>", cmd)
    _i, o, e = c.exec_command(cmd, timeout=timeout, get_pty=True)
    out = o.read().decode("utf-8", "replace")
    err = e.read().decode("utf-8", "replace")
    code = o.channel.recv_exit_status()
    text = (out + err).strip()
    if len(text) > 6000:
        text = text[-6000:]
    print(text)
    print("EXIT", code)
    return code, text


def ensure_dirs(sftp, remote_file: str) -> None:
    parts = remote_file.split("/")[:-1]
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


def main() -> None:
    missing = [rel for rel in FILES if not (ROOT / rel).is_file()]
    if missing:
        raise SystemExit(f"missing local files: {missing}")

    pkey = paramiko.Ed25519Key.from_private_key_file(str(KEY))
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST, username=USER, pkey=pkey, timeout=45, allow_agent=False, look_for_keys=False)

    run(c, f"cd {APP} && git rev-parse --short HEAD && git status -sb | head -5")

    sftp = c.open_sftp()
    for rel in FILES:
        local = ROOT / rel
        remote = f"{APP}/{rel.replace(chr(92), '/')}"
        ensure_dirs(sftp, remote)
        print("PUT", rel, local.stat().st_size)
        sftp.put(str(local), remote)
    stamp = f"{datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')} hash={STAMP_HASH}\n"
    with sftp.file(f"{APP}/{STAMP_FILE}", "w") as fh:
        fh.write(stamp)
    sftp.close()

    run(c, "pm2 restart erp-taranom", timeout=90)
    run(
        c,
        "curl -sS -o /dev/null -w 'health:%{http_code}\\n' http://127.0.0.1:3000/health; "
        "curl -sS -o /dev/null -w 'demo:%{http_code}\\n' http://127.0.0.1:3000/demo.html; "
        "curl -sS -o /dev/null -w 'seed:%{http_code}\\n' http://127.0.0.1:3000/demo-v3-seed.js",
        timeout=45,
    )
    c.close()
    print("STAMP", STAMP_FILE, stamp.strip())


if __name__ == "__main__":
    main()
