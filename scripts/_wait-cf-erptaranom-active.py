#!/usr/bin/env python3
"""Poll until erptaranom.com NS points at Cloudflare and zone is active."""
from __future__ import annotations

import pathlib
import sys
import time

import paramiko

HOST = "94.249.244.208"
USER = "taranom"
CF_NS = ("connie.ns.cloudflare.com", "finley.ns.cloudflare.com")


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

    def run(cmd: str) -> str:
        _i, stdout, stderr = client.exec_command(cmd, timeout=45)
        return stdout.read().decode("utf-8", "replace") + stderr.read().decode("utf-8", "replace")

    for i in range(40):
        ns = run("dig +short erptaranom.com NS @8.8.8.8 | sort")
        a = run("dig +short erptaranom.com A @1.1.1.1 | head -5")
        cf = "cloudflare.com" in ns.lower()
        p(f"[{i}] NS={ns.strip()!r} A={a.strip()!r} cf_ns={cf}")
        if cf:
            # resolve via CF edge and hit health
            out = run(
                "curl -sS -o /dev/null -w '%{http_code} %{remote_ip}\\n' "
                "--connect-timeout 15 https://erptaranom.com/api/system/health"
            )
            p("health " + out.strip())
            if "200" in out:
                client.close()
                return 0
        time.sleep(30)
    client.close()
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
