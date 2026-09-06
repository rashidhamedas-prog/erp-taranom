#!/usr/bin/env python3
"""Paramiko overlay: ERP2 prod reports hub v188/v189. No db.js."""
from __future__ import annotations

import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import paramiko

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HOST, USER, APP = "94.249.244.208", "taranom", "/home/taranom/crm-taranom"
ROOT = Path(__file__).resolve().parents[1]
STAMP_FILE = ".sftp-deploy-stamp-erp2-v189"

FILES = [
    "docs/CHANGE-LOG.md",
    "server/lib/production/bom.js",
    "server/routes/production-boms.js",
    "server/public/acc-nav.js",
    "server/public/app.js",
    "server/public/prod-ui.css",
    "server/public/sw.js",
]


def resolve_key() -> Path:
    for p in (
        Path.home() / ".ssh" / "id_ed25519_taranom",
        Path(r"D:\proje\.ssh\id_ed25519_taranom"),
        ROOT.parent / ".ssh" / "id_ed25519_taranom",
    ):
        if p.is_file():
            return p
    raise SystemExit("SSH key missing")


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
    key = resolve_key()
    h = stamp_hash()
    pkey = paramiko.Ed25519Key.from_private_key_file(str(key))
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST, username=USER, pkey=pkey, timeout=45, allow_agent=False, look_for_keys=False)
    run(c, f"cd {APP} && git rev-parse --short HEAD && git status -sb | head -8")
    print("skip git pull (VPS dirty); overlay v189 ERP2 prod UX files")
    sftp = c.open_sftp()
    for rel in FILES:
        local = ROOT / rel
        remote = f"{APP}/{rel.replace(chr(92), '/')}"
        ensure_dirs(sftp, remote)
        print("PUT", rel, local.stat().st_size)
        sftp.put(str(local), remote)
    sftp.close()
    run(
        c,
        "cd /home/taranom/crm-taranom/server && "
        "pm2 restart erp-taranom --max-memory-restart 1024M --kill-timeout 10000 2>&1 | tail -20",
    )
    _code, _health = run(
        c,
        "ok=0; readyok=0; "
        "for i in 1 2 3 4 5 6 7 8 9 10 11 12; do "
        "  sleep 4; "
        "  h=$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/system/health || true); "
        "  r=$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/system/ready || true); "
        "  echo try_$i:health=$h:ready=$r; "
        "  if [ \"$h\" = \"200\" ]; then ok=1; fi; "
        "  if [ \"$r\" = \"200\" ]; then readyok=1; break; fi; "
        "done; "
        "curl -sS -o /dev/null -w 'root:%{http_code}\\n' http://127.0.0.1:3000/; "
        f"grep -n erp-taranom-v {APP}/server/public/sw.js | head -1; "
        "echo HEALTH_OK=$ok READY_OK=$readyok; "
        "test \"$ok\" = \"1\" && test \"$readyok\" = \"1\"",
        timeout=90,
    )
    if _code != 0:
        run(c, "pm2 logs erp-taranom --lines 80 --nostream || true", timeout=30)
        raise SystemExit("health/ready check failed")
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    run(c, f"cd {APP} && echo {STAMP_FILE}={stamp} hash={h} > {STAMP_FILE} && cat {STAMP_FILE}", timeout=30)
    print("DEPLOY_DONE", h)
    c.close()


if __name__ == "__main__":
    main()
