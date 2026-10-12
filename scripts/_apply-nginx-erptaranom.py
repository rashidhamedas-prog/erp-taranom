#!/usr/bin/env python3
"""Upload transitional nginx vhost for erptaranom.com and reload (safe nginx -t)."""
from __future__ import annotations

import pathlib
import sys

import paramiko

HOST = "94.249.244.208"
USER = "taranom"
REMOTE = "/etc/nginx/sites-available/crm-taranom"
CONF = pathlib.Path(__file__).with_name("nginx-crm-taranom-erptaranom.conf")


def main() -> int:
    key_paths = [
        pathlib.Path.home() / ".ssh" / "id_ed25519_taranom",
        pathlib.Path(r"D:\proje\.ssh\id_ed25519_taranom"),
    ]
    key = next((p for p in key_paths if p.exists()), None)
    if not key:
        print("ERROR: SSH key not found", file=sys.stderr)
        return 2
    if not CONF.exists():
        print(f"ERROR: missing {CONF}", file=sys.stderr)
        return 2

    body = CONF.read_text(encoding="utf-8")
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, username=USER, key_filename=str(key), timeout=30)

    def run(cmd: str) -> tuple[int, str, str]:
        stdin, stdout, stderr = client.exec_command(cmd, timeout=60)
        out = stdout.read().decode("utf-8", "replace")
        err = stderr.read().decode("utf-8", "replace")
        code = stdout.channel.recv_exit_status()
        return code, out, err

    # stage in /tmp then sudo install
    sftp = client.open_sftp()
    with sftp.file("/tmp/crm-taranom.erptaranom.conf", "w") as f:
        f.write(body)
    sftp.close()

    steps = [
        f"sudo cp -a {REMOTE} {REMOTE}.bak-before-erptaranom-apply",
        f"sudo cp /tmp/crm-taranom.erptaranom.conf {REMOTE}",
        "sudo mkdir -p /var/www/html",
        "sudo nginx -t",
        "sudo systemctl reload nginx",
        "curl -sS -o /dev/null -w 'host80:%{http_code}\\n' -H 'Host: erptaranom.com' http://127.0.0.1/",
        "curl -sS -o /dev/null -w 'old443:%{http_code}\\n' -k --resolve erp.poshaktaranom.com:443:127.0.0.1 https://erp.poshaktaranom.com/",
        "curl -sS -o /dev/null -w 'node:%{http_code}\\n' http://127.0.0.1:3000/api/system/health",
    ]
    for cmd in steps:
        code, out, err = run(cmd)
        print(f"$ {cmd}\nexit={code}\n{out}{err}")
        if code != 0 and "nginx -t" in cmd:
            print("ROLLING BACK")
            run(f"sudo cp -a {REMOTE}.bak-before-erptaranom-apply {REMOTE}")
            run("sudo nginx -t && sudo systemctl reload nginx")
            client.close()
            return 1
        if code != 0 and cmd.startswith("sudo cp /tmp"):
            client.close()
            return 1

    client.close()
    print("OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
