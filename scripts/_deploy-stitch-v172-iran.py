#!/usr/bin/env python3
"""SFTP overlay stitch v172 (PROD-02/03 cutting lays). VPS cannot fetch GitHub. Do not replace db.js."""
from __future__ import annotations

import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import paramiko

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HOST, USER, APP = "94.249.244.208", "taranom", "/home/taranom/crm-taranom"
KEY = Path.home() / ".ssh" / "id_ed25519_taranom"
ROOT = Path(__file__).resolve().parents[1]
STAMP_FILE = ".sftp-deploy-stamp-stitch-v172"

FILES = [
    "docs/CHANGE-LOG.md",
    "docs/architecture/ADR-007-FABRIC-ROLL.md",
    ".ai-dos/project/status.md",
    ".ai-dos/tasks/active.yaml",
    ".ai-dos/tasks/handoff.md",
    "server/lib/production/schema.js",
    "server/lib/production/cutting.js",
    "server/lib/inventory/batch-serial.js",
    "server/routes/production-cutting.js",
    "server/scripts/test-prod-02-cutting.js",
    "server/server.js",
    "server/sync/capture.js",
    "server/sync/tables.js",
    "server/public/acc-nav.js",
    "server/public/app.js",
    "server/public/index.html",
    "server/public/sw.js",
]


def stamp_hash() -> str:
    return subprocess.check_output(["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, text=True).strip()


def run(c, cmd, timeout=300):
    print("==>", cmd[:280])
    _i, o, e = c.exec_command(cmd, timeout=timeout, get_pty=True)
    out = o.read().decode("utf-8", "replace")
    err = e.read().decode("utf-8", "replace")
    code = o.channel.recv_exit_status()
    text = (out + err).strip()
    print(text[-6000:] if len(text) > 6000 else text)
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
    if not KEY.is_file():
        raise SystemExit("SSH key missing")
    h = stamp_hash()

    pkey = paramiko.Ed25519Key.from_private_key_file(str(KEY))
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST, username=USER, pkey=pkey, timeout=45, allow_agent=False, look_for_keys=False)

    run(c, f"cd {APP} && git rev-parse --short HEAD && git status -sb | head -8")

    sftp = c.open_sftp()
    for rel in FILES:
        local = ROOT / rel
        remote = f"{APP}/{rel.replace(chr(92), '/')}"
        ensure_dirs(sftp, remote)
        print("PUT", rel, local.stat().st_size)
        sftp.put(str(local), remote)
    sftp.close()

    run(c, "pm2 restart erp-taranom 2>&1 | tail -15")
    _code, health = run(
        c,
        "sleep 6; "
        "curl -sS -o /dev/null -w 'health:%{http_code}\\n' http://127.0.0.1:3000/api/system/health; "
        "curl -sS -o /dev/null -w 'ready:%{http_code}\\n' http://127.0.0.1:3000/api/system/ready; "
        "curl -sS -o /dev/null -w 'root:%{http_code}\\n' http://127.0.0.1:3000/; "
        f"grep -n erp-taranom-v {APP}/server/public/sw.js | head -1",
        timeout=90,
    )
    if "health:200" not in health or "root:200" not in health:
        c.close()
        raise SystemExit("health check failed")
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    run(
        c,
        f"cd {APP} && echo {STAMP_FILE}={stamp} hash={h} > {STAMP_FILE} && cat {STAMP_FILE}",
        timeout=30,
    )
    c.close()
    print("DEPLOY_DONE", h)
    print("STAMP", stamp)


if __name__ == "__main__":
    main()
