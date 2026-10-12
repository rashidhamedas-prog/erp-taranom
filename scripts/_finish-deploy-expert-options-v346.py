#!/usr/bin/env python3
"""Deploy invoice expert-options picker fix (SW v346) to Iran (overlay if dirty)."""
from pathlib import Path
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
import paramiko

KEY = Path.home() / ".ssh" / "id_ed25519_taranom"
ROOT = Path(r"D:\proje\erp-taranom1")
REMOTE = "/home/taranom/crm-taranom"
FILES = [
    "docs/CHANGE-LOG.md",
    "server/lib/sales-experts.js",
    "server/routes/auth.js",
    "server/public/app.js",
    "server/public/sw.js",
    "server/public/index.html",
    "server/scripts/test-invoice-expert-options-v346.js",
]


def run(client, cmd, timeout=900):
    _, stdout, stderr = client.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode("utf-8", "replace")
    err = stderr.read().decode("utf-8", "replace")
    code = stdout.channel.recv_exit_status()
    return code, out, err


def main():
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect("94.249.244.208", username="taranom", key_filename=str(KEY), timeout=30)
    code, out, err = run(client, f"cd {REMOTE} && git rev-parse --short HEAD && git status -sb")
    print("REMOTE", out.strip())
    sftp = client.open_sftp()
    for rel in FILES:
        remote = f"{REMOTE}/{rel}"
        parent = "/".join(remote.split("/")[:-1])
        run(client, f"mkdir -p {parent}")
        sftp.put(str(ROOT / rel), remote)
        print("put", rel)
    sftp.close()
    code, out, err = run(
        client,
        "set -e; cd /home/taranom/crm-taranom; "
        "node --check server/lib/sales-experts.js; "
        "node --check server/routes/auth.js; "
        "node server/scripts/test-invoice-expert-options-v346.js; "
        "node server/scripts/test-sms.js; "
        "node server/scripts/test-sync.js; "
        "pm2 restart erp-taranom; "
        "sleep 6; "
        "curl -s -o /dev/null -w 'ready:%{http_code}\\n' http://127.0.0.1:3000/api/system/ready; "
        "curl -s http://127.0.0.1:3000/api/system/health | head -c 500; echo; "
        "grep -n 'erp-taranom-v346' server/public/sw.js | head -1; "
        "grep -n 'app.js?v=346' server/public/index.html | head -1",
        timeout=900,
    )
    print("VERIFY", code)
    print(out[-14000:] if len(out) > 14000 else out)
    if err.strip():
        print("ERR", err[-4000:])
    client.close()
    return code


if __name__ == "__main__":
    raise SystemExit(main() or 0)
