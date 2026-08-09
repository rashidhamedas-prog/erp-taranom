#!/usr/bin/env python3
"""Deploy tip code to Iran via SFTP without npm install / blind git reset.

Keeps sharp runtime pin at 0.33.5 (owner permanent waiver). Restarts PM2
without --update-env.
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
KNOWN = Path.home() / ".ssh" / "known_hosts"
APP = "/home/taranom/crm-taranom"
ROOT = Path(__file__).resolve().parents[1]

FILES = [
    "server/lib/production/variance.js",
    "server/lib/production/engine.js",
    "server/lib/production/labor.js",
    "server/lib/production/overhead.js",
    "server/routes/production-orders.js",
    "server/routes/production-reports.js",
    "server/routes/production-cost-centers.js",
    "server/public/app.js",
    "server/public/sw.js",
    "server/scripts/test-production-variable.js",
    "server/scripts/test-production-overhead-labor.js",
    "docs/CHANGE-LOG.md",
    "docs/WAVE0-GATE-STATUS.md",
    "scripts/deploy-sharp-production.ps1",
    "scripts/_deploy-prod-p3-sftp.py",
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
    print("==>", cmd[:220])
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
    if not KEY.is_file() or not KNOWN.is_file():
        raise SystemExit("SSH key or known_hosts missing")

    pkey = paramiko.Ed25519Key.from_private_key_file(str(KEY))
    c = paramiko.SSHClient()
    c.load_host_keys(str(KNOWN))
    c.set_missing_host_key_policy(paramiko.RejectPolicy())
    c.connect(HOST, username=USER, pkey=pkey, timeout=45, allow_agent=False, look_for_keys=False)

    run(c, f"cd {APP} && git rev-parse --short HEAD && git status -sb | head -25")
    run(
        c,
        f"cd {APP}/server && node -e \"console.log('PRE', require('./package.json').dependencies.sharp, require('./node_modules/sharp/package.json').version); require('sharp'); console.log('PRE_OK')\"",
    )

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
        f"""cd {APP}/server && node -e "const fs=require('fs'); const p=JSON.parse(fs.readFileSync('package.json','utf8')); p.dependencies.sharp='0.33.5'; fs.writeFileSync('package.json', JSON.stringify(p,null,2)+'\\n');" && node -e "console.log('PIN', require('./package.json').dependencies.sharp); require('sharp'); console.log('REQUIRE_OK', require('./node_modules/sharp/package.json').version)" """,
    )

    run(c, "pm2 restart erp-taranom", timeout=90)
    code, text = run(
        c,
        "sleep 4; "
        "curl -sS -o /dev/null -w 'root:%{http_code}\\n' http://127.0.0.1:3000/; "
        "curl -sS -o /dev/null -w 'health:%{http_code}\\n' http://127.0.0.1:3000/api/system/health; "
        "curl -sS -o /dev/null -w 'ready:%{http_code}\\n' http://127.0.0.1:3000/api/system/ready || true; "
        f"cd {APP}/server && node -e \"console.log('POST', require('./package.json').dependencies.sharp, require('./node_modules/sharp/package.json').version); require('sharp'); console.log('POST_OK')\"; "
        f"test -f {APP}/server/lib/production/variance.js && echo VARIANCE=YES; "
        f"test -f {APP}/server/lib/production/labor.js && echo LABOR=YES; "
        f"test -f {APP}/server/lib/production/overhead.js && echo OVERHEAD=YES; "
        f"grep -n \"erp-taranom-v\" {APP}/server/public/sw.js | head -1",
        timeout=90,
    )
    if "POST_OK" not in text or "root:200" not in text:
        raise SystemExit("post-deploy verification failed")
    run(
        c,
        f"cd {APP} && echo SFTP_SYNC_TIP=$(date -u +%Y-%m-%dT%H:%M:%SZ) hash={tip} sharp=0.33.5 > .sftp-deploy-stamp-sync-tip && cat .sftp-deploy-stamp-sync-tip",
        timeout=30,
    )
    c.close()
    print("DEPLOY_DONE", tip)


if __name__ == "__main__":
    main()
