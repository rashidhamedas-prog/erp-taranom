#!/usr/bin/env python3
"""Deploy product image upload fix + price sort to Iran (reset + SFTP)."""
from __future__ import annotations

import sys
import time
from pathlib import Path

import paramiko

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HOST, USER = "94.249.244.208", "taranom"
KEY = Path.home() / ".ssh" / "id_ed25519_taranom"
APP = "/home/taranom/crm-taranom"
ROOT = Path(__file__).resolve().parents[1]
FILES = [
    "server/routes/products.js",
    "server/routes/b2b.js",
    "server/public/sw.js",
    "docs/CHANGE-LOG.md",
]


def run(c, cmd, timeout=300):
    print("==>", cmd)
    _i, o, e = c.exec_command(cmd, timeout=timeout, get_pty=True)
    out = o.read().decode("utf-8", "replace")
    print(out[-3000:] if len(out) > 3000 else out)
    code = o.channel.recv_exit_status()
    print("EXIT", code)
    return code, out


def main() -> None:
    pkey = paramiko.Ed25519Key.from_private_key_file(str(KEY))
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST, username=USER, pkey=pkey, timeout=30, allow_agent=False, look_for_keys=False)

    run(
        c,
        f"cd {APP} && "
        "git stash push -u -m deploy-stash-img 2>&1 | tail -5; "
        "rm -f server/scripts/test-coa-release.js; "
        "git fetch origin claude/claude-md-docs-2ssrpy 2>&1 | tail -8; "
        "git reset --hard origin/claude/claude-md-docs-2ssrpy 2>&1 | tail -8; "
        "git rev-parse --short HEAD; git log -1 --oneline",
        timeout=180,
    )

    sftp = c.open_sftp()
    for rel in FILES:
        local, remote = ROOT / rel, f"{APP}/{rel}"
        print(" put", rel, local.stat().st_size)
        sftp.put(str(local), remote)
    sftp.close()

    code, out = run(
        c,
        f"cd {APP} && head -2 server/public/sw.js; "
        "grep -n 'CAST(p.price\\|Gallery add\\|effort: 2\\|Deduplicate' server/routes/products.js | head -10; "
        "grep -n 'CAST(price' server/routes/b2b.js | head -3; "
        "git rev-parse --short HEAD",
    )
    if "effort: 2" not in out or "v101" not in out:
        print("VERIFY FAILED")
        sys.exit(1)

    run(c, "pm2 restart erp-taranom --update-env")
    time.sleep(4)
    run(c, "curl -sS -o /dev/null -w 'health:%{http_code}\\n' http://127.0.0.1:3000/api/system/health")
    run(c, "curl -sS http://127.0.0.1:3000/sw.js | head -2")
    c.close()
    print("DONE")


if __name__ == "__main__":
    main()
