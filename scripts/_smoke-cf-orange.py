#!/usr/bin/env python3
"""Smoke Cloudflare orange path from VPS (resolve to public CF A) and local machine."""
from __future__ import annotations

import pathlib
import subprocess
import sys
import time

import paramiko


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
    # Windows: flush + resolve via 1.1.1.1 using dig if available else nslookup parse via python socket after sleep
    time.sleep(3)
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect("94.249.244.208", username="taranom", key_filename=str(find_key()), timeout=30)

    def run(cmd: str) -> str:
        _i, o, e = client.exec_command(cmd, timeout=90)
        return (o.read() + e.read()).decode("utf-8", "replace")

    ips = run("dig +short erptaranom.com A @1.1.1.1").strip().split()
    p("public_A=" + " ".join(ips))
    # pick non-origin IP
    edge = next((ip for ip in ips if not ip.startswith("94.249.")), ips[0] if ips else "")
    p("edge=" + edge)
    if not edge:
        return 1

    for path in ("/cdn-cgi/trace", "/api/system/health", "/"):
        out = run(
            f"curl -sS -m 45 --resolve erptaranom.com:443:{edge} "
            f"-D /tmp/cfhdrs -o /tmp/cfbody -w 'code=%{{http_code}} time=%{{time_total}}\\n' "
            f"https://erptaranom.com{path}; "
            f"echo '---hdr---'; sed -n '1,20p' /tmp/cfhdrs; "
            f"echo '---body---'; head -c 200 /tmp/cfbody; echo"
        )
        p(f"\nPATH {path}\n{out}")

    client.close()

    # local windows probe
    p("\n=== local ===")
    for i in range(3):
        r = subprocess.run(
            [
                "curl.exe",
                "-sS",
                "-m",
                "40",
                "--resolve",
                f"erptaranom.com:443:{edge}",
                "-w",
                "code=%{http_code} time=%{time_total}\n",
                "-o",
                "NUL",
                "https://erptaranom.com/api/system/health",
            ],
            capture_output=True,
            text=True,
            timeout=50,
        )
        p(f"local[{i}] {(r.stdout + r.stderr).strip()}")
        if "code=200" in r.stdout:
            break
        time.sleep(2)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
