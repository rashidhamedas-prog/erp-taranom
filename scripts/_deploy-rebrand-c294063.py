#!/usr/bin/env python3
"""Deploy c294063 ERP rebrand docs to Iran (disk path stays crm-taranom)."""
from __future__ import annotations
import sys
from pathlib import Path
import paramiko

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
HOST = "94.249.244.208"
USER = "taranom"
KEY = Path.home() / ".ssh" / "id_ed25519_taranom"
APP = "/home/taranom/crm-taranom"  # intentional — see scripts/DEPLOY-IRAN.md
EXPECT = "c294063"


def run(c, cmd, timeout=300):
    print("==>", cmd)
    _i, o, e = c.exec_command(cmd, timeout=timeout, get_pty=True)
    out = o.read().decode("utf-8", "replace")
    code = o.channel.recv_exit_status()
    print(out[-2500:] if len(out) > 2500 else out)
    print("EXIT", code)
    return code, out


def main():
    pkey = paramiko.Ed25519Key.from_private_key_file(str(KEY))
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST, username=USER, pkey=pkey, timeout=30, allow_agent=False, look_for_keys=False)
    run(c, f"cd {APP} && git stash push -m deploy-c294063 -- server/public/releases/latest.yml server/public/releases/manifest.json || true")
    run(c, f"cd {APP} && git checkout -- server/public/releases/latest.yml server/public/releases/manifest.json || true")
    run(c, f"cd {APP} && git fetch origin claude/claude-md-docs-2ssrpy && git pull --ff-only origin claude/claude-md-docs-2ssrpy")
    _, out = run(c, f"cd {APP} && git rev-parse --short HEAD")
    head = out.strip().splitlines()[-1].strip() if out.strip() else ""
    print("HEAD", head)
    # Ensure APK alias if new file uploaded later; update manifest already in pull
    run(c, "pm2 restart erp-taranom --update-env")
    run(c, "sleep 2; curl -sS -o /dev/null -w 'health:%{http_code}\\n' http://127.0.0.1:3000/api/system/health")
    run(c, f"cd {APP} && test -f server/public/releases/manifest.json && grep -n erp-taranom.apk server/public/releases/manifest.json | head -1")
    c.close()
    print("DONE")


if __name__ == "__main__":
    main()
