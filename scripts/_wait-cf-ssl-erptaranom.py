#!/usr/bin/env python3
"""Poll Cloudflare Universal SSL until active for erptaranom.com; then edge health."""
from __future__ import annotations

import json
import pathlib
import sys
import time
import urllib.request

# Uses Cloudflare API token from env if present; otherwise prints dig-only checks.
# Prefer MCP for API; this script only verifies public edge via dig+curl on VPS.

import paramiko

HOST = "94.249.244.208"
USER = "taranom"


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
        _i, stdout, stderr = client.exec_command(cmd, timeout=60)
        return stdout.read().decode("utf-8", "replace") + stderr.read().decode("utf-8", "replace")

    for i in range(40):
        ip = run("dig +short erptaranom.com A @1.1.1.1 | head -1").strip()
        # Prefer IPv4 CF anycast
        out = run(
            f"curl -sS -m 20 --resolve erptaranom.com:443:{ip} "
            f"-o /dev/null -w '%{{http_code}} cf-ray=%{{header_cf-ray}}\\n' "
            f"https://erptaranom.com/api/system/health || echo FAIL"
        )
        p(f"[{i}] edge={ip} {out.strip()}")
        if "200" in out and "cf-ray=" in out.lower() and "cf-ray=\n" not in out and "cf-ray=;" not in out:
            # also require non-empty cf-ray — curl may print empty
            pass
        if out.strip().startswith("200") and "cf-ray=" in out and len(out.strip()) > 20:
            # get trace
            p(run(f"curl -sS -m 20 --resolve erptaranom.com:443:{ip} https://erptaranom.com/cdn-cgi/trace | head -15"))
            client.close()
            return 0
        # simpler success: 200 + cf-ray header present
        hdr = run(
            f"curl -sSI -m 20 --resolve erptaranom.com:443:{ip} https://erptaranom.com/api/system/health | head -30"
        )
        if "cf-ray:" in hdr.lower() and "200" in hdr:
            p(hdr)
            client.close()
            return 0
        time.sleep(30)
    client.close()
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
