#!/usr/bin/env python3
"""Deploy origin/main (SW v202) to Iran VPS: git pull, SFTP fallback, pm2 restart."""
from __future__ import annotations

import socket
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import paramiko

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HOST, USER, APP = "94.249.244.208", "taranom", "/home/taranom/crm-taranom"
ROOT = Path(__file__).resolve().parents[1]
SOCKS_HOST, SOCKS_PORT = "127.0.0.1", 10808
STAMP_FILE = ".sftp-deploy-stamp-main-v202"

FILES = [
    "docs/CHANGE-LOG.md",
    "server/db.js",
    "server/lib/invoice-payments.js",
    "server/lib/invoice-print.js",
    "server/lib/payroll/engine.js",
    "server/lib/payroll/schema.js",
    "server/lib/product-variants/service.js",
    "server/lib/production/bom-advanced.js",
    "server/lib/secure-html-response.js",
    "server/public/app.js",
    "server/public/index.html",
    "server/public/sw.js",
    "server/routes/invoices.js",
    "server/routes/payroll.js",
    "server/routes/product-variants.js",
    "server/routes/production-boms.js",
    "server/scripts/test-erp3-v201.js",
    "server/scripts/test-invoice-print-blob-v199.js",
    "server/scripts/test-production-bom-advanced.js",
    "server/scripts/test-secure-html-response.js",
    "server/sync/capture.js",
]


def resolve_key() -> Path:
    for p in (
        Path.home() / ".ssh" / "id_ed25519_taranom",
        Path(r"D:\proje\.ssh\id_ed25519_taranom"),
        ROOT.parent / ".ssh" / "id_ed25519_taranom",
    ):
        if p.is_file():
            return p
    raise SystemExit("SSH key missing")


def socks_socket() -> socket.socket:
    try:
        import socks
    except ImportError as exc:
        raise SystemExit("PySocks missing: pip install pysocks") from exc
    sock = socks.socksocket()
    sock.set_proxy(socks.SOCKS5, SOCKS_HOST, SOCKS_PORT)
    sock.settimeout(90)
    sock.connect((HOST, 22))
    return sock


def connect(use_socks: bool) -> paramiko.SSHClient:
    key = resolve_key()
    pkey = paramiko.Ed25519Key.from_private_key_file(str(key))
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    kwargs = dict(
        username=USER,
        pkey=pkey,
        timeout=90,
        banner_timeout=120,
        auth_timeout=120,
        allow_agent=False,
        look_for_keys=False,
    )
    if use_socks:
        print("Connecting via SOCKS", SOCKS_HOST, SOCKS_PORT, "key:", key)
        sock = socks_socket()
        client.connect(HOST, sock=sock, **kwargs)
    else:
        print("Connecting direct", HOST, "key:", key)
        client.connect(HOST, **kwargs)
    return client


def run(c, cmd, timeout=300, check=True):
    print("==>", cmd[:320])
    _i, o, e = c.exec_command(cmd, timeout=timeout, get_pty=True)
    out = o.read().decode("utf-8", "replace")
    err = e.read().decode("utf-8", "replace")
    code = o.channel.recv_exit_status()
    print(out.strip())
    if err.strip():
        print("ERR:", err.strip())
    if check and code != 0:
        raise RuntimeError(f"Remote command failed: {code}")
    return code, out


def upload(client):
    sftp = client.open_sftp()
    for rel in FILES:
        lp = ROOT / rel
        rp = f"{APP}/{rel}"
        if not lp.is_file():
            raise SystemExit(f"missing local file: {rel}")
        print(f"SFTP: {rel} ({lp.stat().st_size} bytes) -> {rp}")
        sftp.put(str(lp), rp)
    now_utc = datetime.now(timezone.utc).isoformat()
    with sftp.file(f"{APP}/{STAMP_FILE}", "w") as f:
        f.write(f"deployed_at={now_utc}\nby=_deploy-main-v202-sftp.py\ncommit=ccf6699\n")
    sftp.close()


def deploy(client):
    code, _ = run(
        client,
        f"cd {APP} && git rev-parse --abbrev-ref HEAD && git status -sb && git log -1 --oneline",
        check=False,
    )
    pulled = False
    if code == 0:
        code, _ = run(
            client,
            f"cd {APP} && git fetch origin && git checkout main && git pull --ff-only origin main && git log -1 --oneline",
            check=False,
        )
        pulled = code == 0
        if not pulled:
            print("git pull --ff-only failed; overlay SFTP then hard-reset to origin/main")
    else:
        print("git status failed; SFTP overlay only")

    if pulled:
        print("git pull on main succeeded")
    else:
        reset_code, _ = run(
            client,
            f"cd {APP} && git fetch origin && git checkout -f main && git reset --hard origin/main && git log -1 --oneline",
            check=False,
        )
        if reset_code != 0:
            print("reset to origin/main failed; SFTP overlay of v202 files")
            upload(client)

    run(client, f"cd {APP} && pm2 restart erp-taranom --update-env")
    run(client, "sleep 4 && grep -n erp-taranom-v server/public/sw.js | head -1", timeout=60)
    run(client, "curl -sI http://127.0.0.1:3000/ | head -n 8", timeout=60)
    run(client, "curl -s http://127.0.0.1:3000/ready || curl -s http://127.0.0.1:3000/api/health", timeout=60)
    run(client, f"cd {APP} && git log -1 --oneline && grep -n CACHE server/public/sw.js | head -1")


def main():
    last_err = None
    for use_socks in (True, False):
        client = None
        try:
            client = connect(use_socks)
            deploy(client)
            client.close()
            print("DEPLOY COMPLETE OK")
            return
        except Exception as exc:
            last_err = exc
            print("ATTEMPT FAIL", "socks" if use_socks else "direct", type(exc).__name__, exc)
            try:
                if client:
                    client.close()
            except Exception:
                pass
            time.sleep(2)
    raise SystemExit(f"deploy failed: {last_err}")


if __name__ == "__main__":
    main()
