#!/usr/bin/env python3
"""Install Origin CA on erptaranom nginx vhosts and report readiness for orange cloud."""
from __future__ import annotations

import pathlib
import re
import sys

import paramiko

HOST = "94.249.244.208"
USER = "taranom"
ROOT = pathlib.Path(__file__).resolve().parent
CERT_LOCAL = ROOT / "_tmp-erptaranom.origin.crt"
REMOTE_NGINX = "/etc/nginx/sites-available/crm-taranom"
CERT = "/etc/ssl/taranom/erptaranom.com.origin.crt"
KEY = "/etc/ssl/taranom/erptaranom.com.origin.key"


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
    pem = CERT_LOCAL.read_text(encoding="utf-8")
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

    code, out = run(
        f"sudo mkdir -p /etc/ssl/taranom && sudo cp /tmp/erptaranom.origin.crt {CERT} && "
        f"sudo chmod 644 {CERT} && test -f {KEY} && echo KEY_OK"
    )
    p(out)
    if "KEY_OK" not in out:
        p("missing origin key")
        return 1

    code, text = run(f"sudo cat {REMOTE_NGINX}")
    if code != 0:
        p(text)
        return 1

    # Replace LE paths only when nearby server_name mentions erptaranom.com
    blocks = re.split(r"(?=server\s*\{)", text)
    new_blocks = []
    changed = 0
    for b in blocks:
        if "server_name" in b and "erptaranom.com" in b and "ssl_certificate" in b:
            b2 = b.replace(
                "/etc/letsencrypt/live/erptaranom.com/fullchain.pem", CERT
            ).replace("/etc/letsencrypt/live/erptaranom.com/privkey.pem", KEY)
            if b2 != b:
                changed += 1
            new_blocks.append(b2)
        else:
            new_blocks.append(b)
    new_text = "".join(new_blocks)
    p(f"changed_blocks={changed}")
    if changed == 0:
        p("no erptaranom ssl blocks updated")
        return 1

    sftp = client.open_sftp()
    with sftp.file("/tmp/crm-taranom.origin.conf", "w") as f:
        f.write(new_text)
    sftp.close()

    for cmd in (
        f"sudo cp -a {REMOTE_NGINX} {REMOTE_NGINX}.bak-origin-ca",
        f"sudo cp /tmp/crm-taranom.origin.conf {REMOTE_NGINX}",
        "sudo nginx -t",
        "sudo systemctl reload nginx",
        "curl -sS -o /dev/null -w 'local:%{http_code}\\n' -H 'Host: erptaranom.com' "
        "https://127.0.0.1/api/system/health --insecure",
        f"openssl x509 -in {CERT} -noout -subject -dates | head -5",
    ):
        code, out = run(cmd)
        p(f"$ {cmd}\nexit={code}\n{out}")
        if code != 0 and "nginx -t" in cmd:
            run(f"sudo cp -a {REMOTE_NGINX}.bak-origin-ca {REMOTE_NGINX}")
            run("sudo nginx -t && sudo systemctl reload nginx")
            return 1
    client.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
