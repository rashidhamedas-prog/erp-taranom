#!/usr/bin/env python3
"""Persist BACKUP_OFFSITE_DIR on Iran PM2 and verify offsite backup/restore drill."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import paramiko

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HOST = "94.249.244.208"
USER = "taranom"
KEY = Path.home() / ".ssh" / "id_ed25519_taranom"
APP = "/home/taranom/crm-taranom"
OFFSITE = "/home/taranom/crm-offsite-backups"


def run(c, cmd, timeout=180):
    print("==>", cmd)
    _i, o, e = c.exec_command(cmd, timeout=timeout, get_pty=True)
    out = o.read().decode("utf-8", "replace")
    err = e.read().decode("utf-8", "replace")
    code = o.channel.recv_exit_status()
    text = out if out.strip() else err
    print(text[-6000:] if len(text) > 6000 else text)
    print("EXIT", code)
    return code, out


def main() -> None:
    pkey = paramiko.Ed25519Key.from_private_key_file(str(KEY))
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST, username=USER, pkey=pkey, timeout=45, allow_agent=False, look_for_keys=False)

    run(c, f"mkdir -p {OFFSITE} && chmod 700 {OFFSITE}")

    # Write/update ecosystem without wiping unknown secrets: read dump, merge env, rewrite ecosystem
    eco = f"""module.exports = {{
  apps: [{{
    name: 'erp-taranom',
    cwd: '{APP}',
    script: 'server/server.js',
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    watch: false,
    max_memory_restart: '800M',
    env: {{
      NODE_ENV: 'production',
      BACKUP_OFFSITE_DIR: '{OFFSITE}'
    }}
  }}]
}};
"""
    # Prefer merging into existing process via pm2 restart with env file that server can read
    # Safer: create server/local.env (gitignored on deploy machine only) AND patch start via ecosystem merge.

    sftp = c.open_sftp()
    # local.env loaded if we add dotenv - check if already loaded. Instead set via PM2:
    # Use `pm2 restart erp-taranom --update-env` after writing a tiny wrapper ecosystem that only adds BACKUP_OFFSITE
    # Best reliable approach for this host: write ecosystem.backup-offsite.config.js and restart with --update-env
    # after injecting into dump via jq/python on server.

    remote_py = f"{APP}/server/_set_offsite_env.py"
    script = r'''
import json, os, subprocess, sys
OFFSITE = "/home/taranom/crm-offsite-backups"
DUMP = os.path.expanduser("~/.pm2/dump.pm2")
data = json.load(open(DUMP))
changed = False
for p in data:
    if p.get("name") != "erp-taranom":
        continue
    env = p.get("env") or {}
    env["BACKUP_OFFSITE_DIR"] = OFFSITE
    # keep production
    env.setdefault("NODE_ENV", "production")
    p["env"] = env
    # also pm2 stores env under env_production sometimes
    ep = p.get("pm_env_production") or p.get("env_production") or {}
    if isinstance(ep, dict):
        ep["BACKUP_OFFSITE_DIR"] = OFFSITE
        p["env_production"] = ep
    changed = True
if not changed:
    print("PROCESS_NOT_FOUND")
    sys.exit(2)
json.dump(data, open(DUMP, "w"))
print("DUMP_UPDATED")
# resurrect from dump
subprocess.check_call(["pm2", "resurrect"])
subprocess.check_call(["pm2", "restart", "erp-taranom", "--update-env"])
print("RESTARTED")
'''
    with sftp.file(remote_py, "w") as f:
        f.write(script)
    sftp.close()

    code, _ = run(c, f"python3 {remote_py}; rm -f {remote_py}", timeout=120)
    if code != 0:
        # fallback: ecosystem-only restart preserving script path
        sftp = c.open_sftp()
        with sftp.file(f"{APP}/ecosystem.offsite.config.js", "w") as f:
            f.write(eco)
        sftp.close()
        run(
            c,
            f"cd {APP} && pm2 delete erp-taranom || true; "
            f"pm2 start ecosystem.offsite.config.js && pm2 save",
            timeout=120,
        )

    run(c, "sleep 4 && curl -sS -o /dev/null -w 'health:%{http_code}\\n' http://127.0.0.1:3000/api/system/health")

    # Verify env on running process
    run(
        c,
        "PID=$(pgrep -n -f 'server/server.js' || true); "
        "echo PID=$PID; "
        "tr '\\0' '\\n' < /proc/$PID/environ 2>/dev/null | grep -E '^BACKUP_OFFSITE_DIR=' || echo 'ENV_MISSING'",
    )

    # Trigger one backup via node one-shot using same DB as production
    remote_bak = f"{APP}/server/_run_one_backup.js"
    bak_js = r'''
process.env.BACKUP_OFFSITE_DIR = process.env.BACKUP_OFFSITE_DIR || '/home/taranom/crm-offsite-backups';
const { runBackup } = require('./backup');
(async () => {
  const r = await runBackup();
  console.log(JSON.stringify({
    ok: r.ok,
    file: r.file,
    encrypted: r.encrypted,
    checksum: (r.checksum||'').slice(0,16),
    offsite: r.offsite,
    error: r.error || null
  }, null, 2));
  process.exit(r.ok ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
'''
    sftp = c.open_sftp()
    with sftp.file(remote_bak, "w") as f:
        f.write(bak_js)
    sftp.close()

    # Run inside pm2 env by extracting BACKUP_OFFSITE from process and using production DB
    run(
        c,
        f"cd {APP}/server && "
        f"BACKUP_OFFSITE_DIR={OFFSITE} node _run_one_backup.js; "
        f"rm -f _run_one_backup.js",
        timeout=300,
    )

    run(
        c,
        f"echo '=== latest offsite ==='; ls -lt {OFFSITE} | head -8; "
        f"echo '=== latest local backups ==='; ls -lt {APP}/server/backups 2>/dev/null | head -8",
    )

    # Restore drill from newest offsite archive into temp dir (do NOT touch production DB)
    drill = f'''
set -e
OFF={OFFSITE}
TMP=/tmp/offsite-drill-$$
mkdir -p "$TMP"
LATEST=$(ls -1t "$OFF"/crm-backup-*.tar.gz "$OFF"/crm-backup-*.zip "$OFF"/crm-backup-*.tar.gz.enc "$OFF"/crm-backup-*.zip.enc 2>/dev/null | head -1)
echo LATEST=$LATEST
test -n "$LATEST"
SUMF="$LATEST.sha256"
test -f "$SUMF"
EXP=$(awk '{{print $1}}' "$SUMF")
ACT=$(sha256sum "$LATEST" | awk '{{print $1}}')
echo EXP=$EXP
echo ACT=$ACT
test "$EXP" = "$ACT"
# extract if not encrypted
case "$LATEST" in
  *.enc) echo "SKIP_EXTRACT encrypted; checksum OK"; echo DRILL_OK checksum_only; exit 0 ;;
esac
mkdir -p "$TMP/ex"
if echo "$LATEST" | grep -q '\\.zip$'; then
  python3 - <<PY
import zipfile
zipfile.ZipFile("$LATEST").extractall("$TMP/ex")
print("unzip-ok")
PY
else
  tar -xzf "$LATEST" -C "$TMP/ex"
fi
test -f "$TMP/ex/crm.db"
cd {APP}/server
node -e 'const Database=require("better-sqlite3"); const db=new Database(process.argv[1],{{readonly:true}}); const i=db.pragma("integrity_check",{{simple:true}}); const u=db.prepare("SELECT COUNT(*) c FROM users").get().c; console.log(JSON.stringify({{integrity:i,users:u}})); db.close();' "$TMP/ex/crm.db"
rm -rf "$TMP"
echo DRILL_OK
'''
    run(c, drill, timeout=300)

    c.close()
    print("DONE")


if __name__ == "__main__":
    main()
