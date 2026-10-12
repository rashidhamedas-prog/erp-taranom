#!/usr/bin/env python3
"""Issue Cloudflare Origin CA (RSA), install on nginx alongside LE, re-enable orange cloud."""
from __future__ import annotations

import json
import pathlib
import sys
import time

import paramiko

# NOTE: Origin CA creation uses Cloudflare API via env CLOUDFLARE_API_TOKEN if set.
# This script focuses on VPS install; cert PEM is passed as argv file or stdin.

HOST = "94.249.244.208"
USER = "taranom"
ORIGIN_DIR = "/etc/ssl/taranom"
CERT = f"{ORIGIN_DIR}/erptaranom.com.origin.crt"
KEY = f"{ORIGIN_DIR}/erptaranom.com.origin.key"
NGINX = "/etc/nginx/sites-available/crm-taranom"


def p(s: str) -> None:
    sys.stdout.write(s.encode("ascii", "replace").decode("ascii") + "\n")
    sys.stdout.flush()


def find_key() -> pathlib.Path:
    for cand in (
        pathlib.Path.home() / ".ssh" / "id_ed25519_taranom",
        pathlib.Path(r"D:\proje\.ssh\id_ed25519_taranom"),
    ):
        if cand.exists():
            return cand
    raise SystemExit("SSH key not found")


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: _issue-origin-ca-erptaranom.py <cert.pem>", file=sys.stderr)
        return 2
    pem = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")
    if "BEGIN CERTIFICATE" not in pem:
        print("invalid cert pem", file=sys.stderr)
        return 2

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, username=USER, key_filename=str(find_key()), timeout=30)

    def run(cmd: str, timeout: int = 90) -> tuple[int, str]:
        _i, stdout, stderr = client.exec_command(cmd, timeout=timeout)
        out = stdout.read().decode("utf-8", "replace") + stderr.read().decode("utf-8", "replace")
        return stdout.channel.recv_exit_status(), out

    sftp = client.open_sftp()
    with sftp.file("/tmp/erptaranom.origin.crt", "w") as f:
        f.write(pem)
    sftp.close()

    cmds = [
        f"sudo mkdir -p {ORIGIN_DIR}",
        f"sudo cp /tmp/erptaranom.origin.crt {CERT}",
        f"sudo chmod 644 {CERT}",
        f"test -f {KEY} && echo KEY_OK || echo KEY_MISSING",
        # Point erptaranom.com SSL server block to Origin CA (keep LE files as backup)
        f"sudo cp -a {NGINX} {NGINX}.bak-origin-ca",
        # Replace LE paths only inside erptaranom server_name blocks — careful sed
        r"""python3 - <<'PY'
from pathlib import Path
p = Path('/etc/nginx/sites-available/crm-taranom')
text = p.read_text()
old_c = '/etc/letsencrypt/live/erptaranom.com/fullchain.pem'
old_k = '/etc/letsencrypt/live/erptaranom.com/privkey.pem'
new_c = '/etc/ssl/taranom/erptaranom.com.origin.crt'
new_k = '/etc/ssl/taranom/erptaranom.com.origin.key'
if old_c not in text:
    print('LE paths not found; leave as-is')
else:
    text2 = text.replace(old_c, new_c).replace(old_k, new_k)
    Path('/tmp/crm-taranom.origin.conf').write_text(text2)
    print('rewrote conf draft')
PY""",
        f"sudo cp /tmp/crm-taranom.origin.conf {NGINX}",
        "sudo nginx -t",
        "sudo systemctl reload nginx",
        "curl -sS -o /dev/null -w 'local:%{http_code}\\n' -H 'Host: erptaranom.com' https://127.0.0.1/api/system/health --insecure",
    ]
    for cmd in cmds:
        code, out = run(cmd)
        p(f"$ {cmd[:80]}\nexit={code}\n{out}")
        if code != 0 and "nginx -t" in cmd:
            run(f"sudo cp -a {NGINX}.bak-origin-ca {NGINX}")
            run("sudo nginx -t && sudo systemctl reload nginx")
            client.close()
            return 1
    client.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
