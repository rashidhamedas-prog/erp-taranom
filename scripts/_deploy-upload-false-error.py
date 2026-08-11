#!/usr/bin/env python3
from __future__ import annotations
import sys, time
from pathlib import Path
import paramiko

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
HOST, USER = "94.249.244.208", "taranom"
KEY = Path.home() / ".ssh" / "id_ed25519_taranom"
APP = "/home/taranom/crm-taranom"
ROOT = Path(__file__).resolve().parents[1]
FILES = [
    "server/public/index.html",
    "server/routes/products.js",
    "server/public/sw.js",
    "docs/CHANGE-LOG.md",
]

def run(c, cmd, timeout=300):
    print("==>", cmd)
    _i, o, e = c.exec_command(cmd, timeout=timeout, get_pty=True)
    out = o.read().decode("utf-8", "replace")
    print(out[-2500:] if len(out) > 2500 else out)
    print("EXIT", o.channel.recv_exit_status())
    return out

def main():
    pkey = paramiko.Ed25519Key.from_private_key_file(str(KEY))
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST, username=USER, pkey=pkey, timeout=30, allow_agent=False, look_for_keys=False)
    run(c, f"cd {APP} && git fetch origin claude/claude-md-docs-2ssrpy 2>&1 | tail -5 && "
           f"git reset --hard origin/claude/claude-md-docs-2ssrpy 2>&1 | tail -5 && "
           f"git rev-parse --short HEAD && git log -1 --oneline", timeout=180)
    sftp = c.open_sftp()
    for rel in FILES:
        local, remote = ROOT / rel, f"{APP}/{rel}"
        print(" put", rel, local.stat().st_size)
        sftp.put(str(local), remote)
    sftp.close()
    out = run(c, f"cd {APP} && head -2 server/public/sw.js; "
              "grep -n 'compressProductImageFile\\|beforeImgCount\\|jsonSafeProduct\\|effort: 1' "
              "server/public/index.html server/routes/products.js | head -15")
    if "compressProductImageFile" not in out or "v103" not in out:
        print("VERIFY FAILED"); sys.exit(1)
    run(c, "pm2 restart erp-taranom --update-env")
    time.sleep(4)
    run(c, "curl -sS -o /dev/null -w 'health:%{http_code}\\n' http://127.0.0.1:3000/api/system/health")
    run(c, "curl -sS http://127.0.0.1:3000/sw.js | head -2")
    c.close(); print("DONE")

if __name__ == "__main__":
    main()
