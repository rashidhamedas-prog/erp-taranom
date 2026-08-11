#!/usr/bin/env python3
"""Deploy Wave-1 merge tip to Iran via SFTP (no git pull / npm / reset).

Uploads W1 delta vs Iran tip, pm2 restart WITHOUT --update-env.
Stamps .sftp-deploy-stamp-w1-merge. Git HEAD on VPS may stay at ced58ef.
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import paramiko

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HOST = "94.249.244.208"
USER = "taranom"
KEY = Path.home() / ".ssh" / "id_ed25519_taranom"
APP = "/home/taranom/crm-taranom"
ROOT = Path(__file__).resolve().parents[1]

# W1 delta (ced58ef..f67a9fc) — code + gate docs
FILES = [
    "server/db.js",
    "server/lib/moadian/adapter.js",
    "server/lib/moadian/sign.js",
    "server/lib/product-variants/service.js",
    "server/lib/secret-settings.js",
    "server/lib/void-invoice.js",
    "server/public/app.js",
    "server/public/sw.js",
    "server/routes/invoices.js",
    "server/routes/moadian.js",
    "server/routes/product-variants.js",
    "server/scripts/test-moadian-foundation.js",
    "server/scripts/test-product-variants.js",
    "docs/CHANGE-LOG.md",
    "docs/WAVE1-GATE-STATUS.md",
    "docs/.plans/260809-wave1-parallel/SUMMARY.md",
    ".ai-dos/project/status.md",
    ".ai-dos/tasks/active.yaml",
    ".ai-dos/tasks/handoff.md",
]


def tip_hash() -> str:
    r = subprocess.run(
        ["git", "rev-parse", "--short", "HEAD"],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        check=True,
    )
    return r.stdout.strip()


def run(c, cmd, timeout=300):
    print("==>", cmd[:240])
    _i, o, e = c.exec_command(cmd, timeout=timeout, get_pty=True)
    out = o.read().decode("utf-8", "replace")
    err = e.read().decode("utf-8", "replace")
    code = o.channel.recv_exit_status()
    text = (out + err).strip()
    print(text[-5000:] if len(text) > 5000 else text)
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
    tip = tip_hash()
    missing = [rel for rel in FILES if not (ROOT / rel).is_file()]
    if missing:
        raise SystemExit(f"missing local files: {missing}")
    if not KEY.is_file():
        raise SystemExit(f"SSH key missing: {KEY}")

    pkey = paramiko.Ed25519Key.from_private_key_file(str(KEY))
    c = paramiko.SSHClient()
    # AutoAddPolicy: Iran host key often missing from known_hosts on fresh shells
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST, username=USER, pkey=pkey, timeout=45, allow_agent=False, look_for_keys=False)

    run(c, f"cd {APP} && git rev-parse --short HEAD && git status -sb | head -25")

    sftp = c.open_sftp()
    for rel in FILES:
        local = ROOT / rel
        remote = f"{APP}/{rel.replace(chr(92), '/')}"
        ensure_dirs(sftp, remote)
        print("PUT", rel, local.stat().st_size)
        sftp.put(str(local), remote)
    sftp.close()

    # Preserve encryption env: no --update-env; no npm install
    run(c, "pm2 restart erp-taranom", timeout=90)
    code, text = run(
        c,
        "sleep 4; "
        "curl -sS -o /dev/null -w 'health:%{http_code}\\n' http://127.0.0.1:3000/api/system/health; "
        "curl -sS -o /dev/null -w 'ready:%{http_code}\\n' http://127.0.0.1:3000/api/system/ready || true; "
        "curl -sS -o /dev/null -w 'root:%{http_code}\\n' http://127.0.0.1:3000/; "
        f"grep -n 'erp-taranom-v' {APP}/server/public/sw.js | head -1; "
        f"test -f {APP}/server/lib/moadian/sign.js && echo MOADIAN_SIGN=YES; "
        f"test -f {APP}/server/lib/product-variants/service.js && echo VARIANTS=YES; "
        f"test -f {APP}/server/routes/moadian.js && echo MOADIAN_ROUTE=YES; "
        f"cd {APP} && git rev-parse --short HEAD",
        timeout=90,
    )
    if "health:200" not in text:
        raise SystemExit("post-deploy verification failed: health not 200")

    run(
        c,
        f"cd {APP} && echo SFTP_W1_MERGE=$(date -u +%Y-%m-%dT%H:%M:%SZ) hash={tip} > .sftp-deploy-stamp-w1-merge && "
        f"cat .sftp-deploy-stamp-w1-merge && ls -la .sftp-deploy-stamp-w1-merge",
        timeout=30,
    )
    c.close()
    print("DEPLOY_DONE", tip)


if __name__ == "__main__":
    main()
