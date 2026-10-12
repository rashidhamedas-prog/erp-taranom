#!/usr/bin/env python3
"""Install/refresh BIND master zone for erptaranom.com (multi-primary with Cloudflare)."""
from __future__ import annotations

import pathlib
import sys

import paramiko

HOST = "94.249.244.208"
USER = "taranom"
ZONE = pathlib.Path(__file__).with_name("dns-erptaranom.zone")
NAMED_SNIPPET = """zone "erptaranom.com" {
    type master;
    file "/etc/bind/zones/erptaranom.com.db";
    allow-transfer { none; };
    allow-query { any; };
    notify no;
};
"""


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
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, username=USER, key_filename=str(find_key()), timeout=30)
    sftp = client.open_sftp()
    with sftp.file("/tmp/erptaranom.com.db", "w") as f:
        f.write(ZONE.read_text(encoding="utf-8"))
    with sftp.file("/tmp/named.conf.erptaranom", "w") as f:
        f.write(NAMED_SNIPPET)
    sftp.close()

    def run(cmd: str) -> tuple[int, str]:
        _i, stdout, stderr = client.exec_command(cmd, timeout=90)
        out = stdout.read().decode("utf-8", "replace") + stderr.read().decode("utf-8", "replace")
        code = stdout.channel.recv_exit_status()
        p(f"$ {cmd}\nexit={code}\n{out}")
        return code, out

    for cmd in (
        "sudo mkdir -p /etc/bind/zones",
        "sudo cp /tmp/erptaranom.com.db /etc/bind/zones/erptaranom.com.db",
        "sudo cp /tmp/named.conf.erptaranom /etc/bind/named.conf.erptaranom",
        "grep -q named.conf.erptaranom /etc/bind/named.conf.local || "
        "echo 'include \"/etc/bind/named.conf.erptaranom\";' | sudo tee -a /etc/bind/named.conf.local",
        "sudo named-checkzone erptaranom.com /etc/bind/zones/erptaranom.com.db",
        "sudo named-checkconf",
        "sudo ufw allow 53/tcp || true",
        "sudo ufw allow 53/udp || true",
        "sudo systemctl restart named 2>/dev/null || sudo systemctl restart bind9",
        "dig @127.0.0.1 erptaranom.com NS +short",
        "dig @127.0.0.1 erptaranom.com A +short",
        "dig @127.0.0.1 www.erptaranom.com A +short",
    ):
        code, _ = run(cmd)
        if code != 0 and "named-check" in cmd:
            client.close()
            return 1
    client.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
