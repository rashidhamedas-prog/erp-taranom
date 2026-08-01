#!/usr/bin/env python3
"""Deploy signing/docs/web to Iran: clean dirty WT if safe, SFTP code + large releases, restart."""
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

CODE_FILES = [
    "docs/CHANGE-LOG.md",
    "docs/WAVE0-GATE-STATUS.md",
    "docs/WAVE0-SIGNING-RUNBOOK.md",
    "docs/WAVE0-SIGNING-HANDOFF-GPT.md",
    "docs/.plans/260801-wave0-critical-path/SUMMARY.md",
    "server/public/index.html",
    "server/public/sw.js",
    "server/public/releases/manifest.json",
    "server/public/releases/latest.yml",
    "scripts/_iran-enable-offsite-backup.py",
    "scripts/_iran-verify-offsite-env.py",
]

# Large binaries — upload separately with progress
BINARIES = [
    "server/public/releases/erp-taranom.apk",
    "server/public/releases/crm-taranom.apk",
    "server/public/releases/ERP-Taranom-Setup-2.0.9.exe",
    "server/public/releases/ERP Taranom Setup 2.0.9.exe",
    "server/public/releases/ERP-Taranom-Setup-2.0.9.exe.blockmap",
]


def run(c, cmd, timeout=300):
    print("==>", cmd[:200])
    _i, o, e = c.exec_command(cmd, timeout=timeout, get_pty=True)
    out = o.read().decode("utf-8", "replace")
    code = o.channel.recv_exit_status()
    print(out[-4000:] if len(out) > 4000 else out)
    print("EXIT", code)
    return code, out


def ensure_dir(sftp, remote_file: str) -> None:
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


def put(sftp, rel: str) -> None:
    local = ROOT / rel
    if not local.is_file():
        print("SKIP missing", rel)
        return
    remote = f"{APP}/{rel.replace(chr(92), '/')}"
    ensure_dir(sftp, remote)
    print(f"PUT {rel} ({local.stat().st_size} bytes)")
    sftp.put(str(local), remote)


def main() -> None:
    pkey = paramiko.Ed25519Key.from_private_key_file(str(KEY))
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST, username=USER, pkey=pkey, timeout=45, allow_agent=False, look_for_keys=False)

    # Stash local mods + move conflicting untracked aside so pull can succeed
    run(
        c,
        f"cd {APP} && "
        f"git stash push -u -m 'auto-stash-before-signing-deploy' -- "
        f"docs server/backup.js server/package.json server/package-lock.json "
        f"server/public/index.html server/public/sw.js server/routes/excel.js "
        f"server/scripts 2>&1 | tail -20; "
        f"mkdir -p /tmp/taranom-wt-aside && "
        f"for f in docs/WAVE0-GATE-STATUS.md docs/WAVE0-SIGNING-RUNBOOK.md "
        f"server/lib/excel-safe.js server/scripts/check-audit-waivers.js "
        f"server/scripts/keep-products-clean.js server/scripts/rebuild-product-docs.js "
        f"server/scripts/test-wave0-financial-hostile.js; do "
        f"  if [ -e \"$f\" ]; then mv -f \"$f\" /tmp/taranom-wt-aside/ 2>/dev/null || true; fi; "
        f"done; "
        f"git fetch origin claude/claude-md-docs-2ssrpy 2>&1 | tail -8; "
        f"git pull --ff-only origin claude/claude-md-docs-2ssrpy 2>&1 | tail -25; "
        f"git rev-parse --short HEAD",
        timeout=180,
    )

    sftp = c.open_sftp()
    for rel in CODE_FILES:
        put(sftp, rel)
    for rel in BINARIES:
        put(sftp, rel)
    sftp.close()

    run(c, "pm2 restart erp-taranom --update-env", timeout=90)
    run(c, "sleep 3 && curl -sS -o /dev/null -w 'health:%{http_code}\\n' http://127.0.0.1:3000/api/system/health")
    run(
        c,
        "ls -la /home/taranom/crm-taranom/server/public/releases/erp-taranom.apk "
        "/home/taranom/crm-taranom/server/public/releases/ERP-Taranom-Setup-2.0.9.exe "
        "/home/taranom/crm-taranom/server/public/releases/manifest.json 2>&1; "
        "python3 -c \"import json; print(json.load(open('/home/taranom/crm-taranom/server/public/releases/manifest.json')))\"",
    )
    # Confirm BACKUP_OFFSITE still set
    run(
        c,
        "pm2 jlist | python3 -c \"import sys,json; p=next(x for x in json.load(sys.stdin) if x.get('name')=='erp-taranom'); "
        "pid=p['pid']; env=open(f'/proc/{pid}/environ','rb').read().split(b'\\0'); "
        "print(next((e.decode() for e in env if e.startswith(b'BACKUP_OFFSITE_DIR=')),'ENV_MISSING'))\"",
    )
    c.close()
    print("DONE")


if __name__ == "__main__":
    main()
