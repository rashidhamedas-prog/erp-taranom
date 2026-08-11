#!/usr/bin/env python3
"""Docs-only pull on Iran (no restart needed if only docs)."""
from pathlib import Path
import paramiko, sys
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
HOST, USER, APP = "94.249.244.208", "taranom", "/home/taranom/crm-taranom"
KEY = Path.home() / ".ssh" / "id_ed25519_taranom"
pkey = paramiko.Ed25519Key.from_private_key_file(str(KEY))
c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(HOST, username=USER, pkey=pkey, timeout=45, allow_agent=False, look_for_keys=False)

def run(cmd, t=120):
    print("==>", cmd)
    _i, o, e = c.exec_command(cmd, timeout=t, get_pty=True)
    out = o.read().decode("utf-8", "replace")
    print(out[-3000:] if len(out) > 3000 else out)
    print("EXIT", o.channel.recv_exit_status())

run(f"cd {APP} && git fetch origin claude/claude-md-docs-2ssrpy 2>&1 | tail -5; git pull --ff-only origin claude/claude-md-docs-2ssrpy 2>&1 | tail -20; git rev-parse --short HEAD")
run("curl -sS -o /dev/null -w 'health:%{http_code}\\n' http://127.0.0.1:3000/api/system/health")
c.close()
print("DONE")
