#!/usr/bin/env python3
"""Upload ERP3.rar fixes (SW v201) to Iran VPS via SOCKS + SFTP."""
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
STAMP_FILE = ".sftp-deploy-stamp-erp3-v201"

FILES = [
    "server/lib/invoice-payments.js",
    "server/lib/payroll/engine.js",
    "server/lib/payroll/schema.js",
    "server/lib/product-variants/service.js",
    "server/lib/production/bom-advanced.js",
    "server/lib/sales-document.js",
    "server/routes/invoices.js",
    "server/routes/payroll.js",
    "server/routes/product-variants.js",
    "server/routes/production-boms.js",
    "server/db.js",
    "server/public/app.js",
    "server/public/sw.js",
    "server/public/index.html",
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


def run(c, cmd, timeout=300):
    print("==>", cmd[:280])
    _i, o, e = c.exec_command(cmd, timeout=timeout, get_pty=True)
    out = o.read().decode("utf-8", "replace")
    err = e.read().decode("utf-8", "replace")
    code = o.channel.recv_exit_status()
    print(out.strip())
    if err.strip():
        print("ERR:", err.strip())
    if code != 0:
        raise RuntimeError(f"Remote command failed: {code}")
    return out


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
        f.write(f"deployed_at={now_utc}\nby=_deploy-erp3-v201-sftp.py\n")
    sftp.close()


def main():
    last_err = None
    for use_socks in (True, False):
        client = None
        try:
            client = connect(use_socks)
            upload(client)
            run(client, f"cd {APP} && pm2 restart erp-taranom --update-env")
            run(client, "sleep 3 && grep -n erp-taranom-v server/public/sw.js | head -1", timeout=60)
            run(client, "curl -sI http://127.0.0.1:3000/ | head -n 8", timeout=60)
            run(client, "curl -s http://127.0.0.1:3000/ready || curl -s http://127.0.0.1:3000/api/health", timeout=60)
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
