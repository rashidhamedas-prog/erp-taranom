#!/usr/bin/env python3
"""Verify BACKUP_OFFSITE_DIR is on running erp-taranom; fix if missing."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import paramiko

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HOST = "94.249.244.208"
USER = "taranom"
KEY = Path.home() / ".ssh" / "id_ed25519_taranom"
OFFSITE = "/home/taranom/crm-offsite-backups"
APP = "/home/taranom/crm-taranom"


def run(c, cmd, timeout=90):
    print("==>", cmd)
    _i, o, e = c.exec_command(cmd, timeout=timeout, get_pty=True)
    out = o.read().decode("utf-8", "replace")
    err = e.read().decode("utf-8", "replace")
    code = o.channel.recv_exit_status()
    text = (out or err).strip()
    print(text[-4000:] if len(text) > 4000 else text)
    print("EXIT", code)
    return code, out


def main() -> None:
    pkey = paramiko.Ed25519Key.from_private_key_file(str(KEY))
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST, username=USER, pkey=pkey, timeout=45, allow_agent=False, look_for_keys=False)

    # Inspect dump + pm2 env
    run(
        c,
        "python3 - <<'PY'\n"
        "import json,os\n"
        "d=json.load(open(os.path.expanduser('~/.pm2/dump.pm2')))\n"
        "for p in d:\n"
        "  if p.get('name')=='erp-taranom':\n"
        "    env=p.get('env') or {}\n"
        "    print('dump_BACKUP_OFFSITE_DIR=', env.get('BACKUP_OFFSITE_DIR'))\n"
        "    print('dump_keys_sample=', sorted([k for k in env if k.startswith('BACKUP') or k in ('NODE_ENV','JWT_SECRET','PORT','DB_PATH')])[:20])\n"
        "    print('has_JWT=', 'JWT_SECRET' in env)\n"
        "PY",
    )

    # Correct pid via pm2 jlist
    code, out = run(
        c,
        "pm2 jlist | python3 -c \"import sys,json; ps=json.load(sys.stdin); "
        "p=next(x for x in ps if x.get('name')=='erp-taranom'); "
        "pid=p.get('pid'); print('pid',pid); "
        "env=open(f'/proc/{pid}/environ','rb').read().split(b'\\0'); "
        "vals=[e.decode() for e in env if e.startswith(b'BACKUP_OFFSITE_DIR=')]; "
        "print(vals[0] if vals else 'ENV_MISSING')\"",
    )

    if "ENV_MISSING" in out or "ENV_MISSING" in (out or ""):
        print("FIXING via pm2 restart with env")
        # Use ecosystem merge: set env on existing app without delete
        run(
            c,
            f"cd {APP} && "
            f"BACKUP_OFFSITE_DIR={OFFSITE} pm2 restart erp-taranom --update-env && "
            f"pm2 save",
            timeout=120,
        )
        run(c, "sleep 3 && curl -sS -o /dev/null -w 'health:%{http_code}\\n' http://127.0.0.1:3000/api/system/health")
        run(
            c,
            "pm2 jlist | python3 -c \"import sys,json; ps=json.load(sys.stdin); "
            "p=next(x for x in ps if x.get('name')=='erp-taranom'); "
            "pid=p.get('pid'); print('pid',pid); "
            "env=open(f'/proc/{pid}/environ','rb').read().split(b'\\0'); "
            "vals=[e.decode() for e in env if e.startswith(b'BACKUP_OFFSITE_DIR=')]; "
            "print(vals[0] if vals else 'ENV_MISSING')\"",
        )

    # How does cron backup run?
    run(c, "crontab -l 2>/dev/null | grep -i backup || echo NO_CRON_BACKUP; ls -la /etc/cron* 2>/dev/null | head -5; systemctl list-timers 2>/dev/null | head -5 || true")

    c.close()
    print("DONE")


if __name__ == "__main__":
    main()
