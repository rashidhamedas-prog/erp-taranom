#!/usr/bin/env python3
"""Upload RC release artifacts to Iran via SFTP (one file per reconnect)."""
from __future__ import annotations

import sys
import time
from pathlib import Path

import paramiko

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HOST = "94.249.244.208"
USER = "taranom"
KEY = Path.home() / ".ssh" / "id_ed25519_taranom"
APP = "/home/taranom/crm-taranom"
ROOT = Path(__file__).resolve().parents[1]

FILES = [
    "server/public/releases/manifest.json",
    "server/public/releases/latest.yml",
    "server/public/sw.js",
    "server/public/app.js",
    "docs/CHANGE-LOG.md",
    "docs/WAVE0-GATE-STATUS.md",
    "server/public/releases/erp-taranom.apk",
    "server/public/releases/crm-taranom.apk",
    "server/public/releases/ERP-Taranom-Setup-2.0.10.exe",
    "server/public/releases/ERP Taranom Setup 2.0.10.exe",
    "server/public/releases/ERP Taranom Setup 2.0.10.exe.blockmap",
]


def connect():
    pkey = paramiko.Ed25519Key.from_private_key_file(str(KEY))
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST, username=USER, pkey=pkey, timeout=60, allow_agent=False, look_for_keys=False,
              banner_timeout=60, auth_timeout=60)
    return c


def put_one(rel: str, retries: int = 4) -> None:
    local = ROOT / rel
    remote = f"{APP}/{rel}"
    for attempt in range(1, retries + 1):
        c = None
        try:
            c = connect()
            sftp = c.open_sftp()
            # mkdir parents
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
            print(f"PUT[{attempt}] {rel} ({local.stat().st_size} bytes)")
            sftp.put(str(local), remote)
            sftp.close()
            c.close()
            print("OK", rel)
            return
        except Exception as e:
            print("FAIL", rel, type(e).__name__, e)
            try:
                if c:
                    c.close()
            except Exception:
                pass
            time.sleep(3 * attempt)
    raise RuntimeError(f"failed to upload {rel}")


def run(c, cmd, timeout=120):
    print("==>", cmd)
    _i, o, e = c.exec_command(cmd, timeout=timeout, get_pty=True)
    out = o.read().decode("utf-8", "replace")
    code = o.channel.recv_exit_status()
    print(out[-2000:] if len(out) > 2000 else out)
    print("EXIT", code)
    return code


def main() -> None:
    for rel in FILES:
        put_one(rel)
    c = connect()
    run(c, "pm2 restart erp-taranom --update-env; sleep 4; "
           "curl -s -o /dev/null -w 'health=%{http_code}\\n' http://127.0.0.1:3000/api/system/health; "
           "curl -s -o /dev/null -w 'manifest=%{http_code}\\n' http://127.0.0.1:3000/releases/manifest.json; "
           "python3 -c \"import json; d=json.load(open('/home/taranom/crm-taranom/server/public/releases/manifest.json')); "
           "print('android', d['android']['version'], 'desktop', d['desktop']['version'])\"")
    c.close()
    print("DONE")


if __name__ == "__main__":
    main()
