#!/usr/bin/env python3
"""Make erp.poshaktaranom.com HTTPS vhost 301 to erptaranom.com."""
from __future__ import annotations

import pathlib
import re
import sys

import paramiko

HOST = "94.249.244.208"
USER = "taranom"
REMOTE = "/etc/nginx/sites-available/crm-taranom"


def main() -> int:
    key = next(
        (
            p
            for p in (
                pathlib.Path.home() / ".ssh" / "id_ed25519_taranom",
                pathlib.Path(r"D:\proje\.ssh\id_ed25519_taranom"),
            )
            if p.exists()
        ),
        None,
    )
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, username=USER, key_filename=str(key), timeout=30)

    def run(cmd: str) -> tuple[int, str]:
        _i, stdout, stderr = client.exec_command(cmd, timeout=60)
        out = stdout.read().decode() + stderr.read().decode()
        return stdout.channel.recv_exit_status(), out

    code, text = run(f"sudo cat {REMOTE}")
    if code != 0:
        print(text)
        return 1

    pat = re.compile(
        r"(server \{[^\n]*\n(?:.*\n)*?\s*server_name erp\.poshaktaranom\.com;\n(?:.*\n)*?)(\s*location / \{[\s\S]*?\n\s*\})",
        re.M,
    )

    def repl(m: re.Match[str]) -> str:
        head = m.group(1)
        if "return 301 https://erptaranom.com" in m.group(0):
            return m.group(0)
        return head + "  location / {\n    return 301 https://erptaranom.com$request_uri;\n  }"

    new, n = pat.subn(repl, text, count=1)
    if n == 0:
        print("no old block matched; leaving as-is")
        client.close()
        return 0

    sftp = client.open_sftp()
    with sftp.file("/tmp/crm-taranom.redirect-old.conf", "w") as f:
        f.write(new)
    sftp.close()
    for cmd in (
        f"sudo cp -a {REMOTE} {REMOTE}.bak-redirect-old",
        f"sudo cp /tmp/crm-taranom.redirect-old.conf {REMOTE}",
        "sudo nginx -t",
        "sudo systemctl reload nginx",
        "curl -sS -o /dev/null -w 'apex:%{http_code}\\n' https://erptaranom.com/api/system/health",
    ):
        code, out = run(cmd)
        print(f"$ {cmd}\nexit={code}\n{out}")
        if code != 0 and "nginx -t" in cmd:
            run(f"sudo cp -a {REMOTE}.bak-redirect-old {REMOTE}")
            run("sudo nginx -t && sudo systemctl reload nginx")
            client.close()
            return 1
    client.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
