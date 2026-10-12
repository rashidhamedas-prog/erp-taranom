#!/usr/bin/env python3
"""Probe Cloudflare edge for erptaranom.com from this machine."""
from __future__ import annotations

import socket
import subprocess
import sys


def dig_a(name: str) -> str:
    # Prefer known CF anycast from prior resolve; fall back to getaddrinfo.
    for candidate in ("104.21.67.113", "172.67.221.159", "188.114.96.3"):
        try:
            socket.create_connection((candidate, 443), timeout=3).close()
            return candidate
        except OSError:
            continue
    infos = socket.getaddrinfo(name, 443, type=socket.SOCK_STREAM)
    for fam, _t, _p, _c, sockaddr in infos:
        if fam == socket.AF_INET:
            return sockaddr[0]
    return infos[0][4][0] if infos else "?"


def curl(url: str, resolve_ip: str | None = None, path_only: str = "") -> str:
    cmd = ["curl.exe", "-sS", "-m", "35"]
    if resolve_ip:
        host = "erptaranom.com"
        cmd += ["--resolve", f"{host}:443:{resolve_ip}"]
    cmd += ["-D", "-", "-o", "NUL", url]
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=40)
        return (p.stdout + p.stderr)[:1500]
    except Exception as e:
        return str(e)


def main() -> int:
    ip = dig_a("erptaranom.com")
    print("edge_ip", ip)
    print("=== health via edge ===")
    print(curl("https://erptaranom.com/api/system/health", ip))
    print("=== root via edge ===")
    print(curl("https://erptaranom.com/", ip))
    print("=== trace via edge ===")
    p = subprocess.run(
        [
            "curl.exe",
            "-sS",
            "-m",
            "35",
            "--resolve",
            f"erptaranom.com:443:{ip}",
            "https://erptaranom.com/cdn-cgi/trace",
        ],
        capture_output=True,
        text=True,
        timeout=40,
    )
    print(p.stdout[:500], p.stderr[:200])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
