#!/usr/bin/env python3
"""Chunked SFTP upload for large RC binaries (Iran SSH drops big transfers)."""
from __future__ import annotations

import hashlib
import sys
import time
from pathlib import Path

import paramiko

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HOST = "94.249.244.208"
USER = "taranom"
KEY = Path.home() / ".ssh" / "id_ed25519_taranom"
APP = "/home/taranom/crm-taranom"
ROOT = Path(__file__).resolve().parents[1]
CHUNK = 4 * 1024 * 1024  # 4 MiB

UPLOADS = [
    ("server/public/releases/erp-taranom.apk", "server/public/releases/erp-taranom.apk"),
    ("server/public/releases/ERP-Taranom-Setup-2.0.10.exe", "server/public/releases/ERP-Taranom-Setup-2.0.10.exe"),
    ("server/public/releases/ERP Taranom Setup 2.0.10.exe.blockmap", "server/public/releases/ERP Taranom Setup 2.0.10.exe.blockmap"),
]


def connect():
    pkey = paramiko.Ed25519Key.from_private_key_file(str(KEY))
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(
        HOST,
        username=USER,
        pkey=pkey,
        timeout=60,
        allow_agent=False,
        look_for_keys=False,
        banner_timeout=60,
        auth_timeout=60,
    )
    transport = c.get_transport()
    if transport:
        transport.set_keepalive(15)
    return c


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        while True:
            b = f.read(1024 * 1024)
            if not b:
                break
            h.update(b)
    return h.hexdigest().upper()


def ensure_dir(sftp, remote_file: str) -> None:
    parts = remote_file.split("/")[:-1]
    cur = ""
    for p in parts:
        if not p:
            continue
        cur += "/" + p
        try:
            sftp.stat(cur)
        except OSError:
            try:
                sftp.mkdir(cur)
            except OSError:
                pass


def put_chunked(local_rel: str, remote_rel: str) -> None:
    local = ROOT / local_rel
    remote = f"{APP}/{remote_rel}"
    remote_part = remote + ".part"
    size = local.stat().st_size
    digest = sha256_file(local)
    print(f"UPLOAD {local_rel} size={size} sha256={digest}")

    offset = 0
    # resume if .part exists with smaller size
    c = connect()
    sftp = c.open_sftp()
    ensure_dir(sftp, remote)
    try:
        st = sftp.stat(remote_part)
        offset = int(st.st_size)
        print(f"resume from {offset}")
    except OSError:
        offset = 0
    sftp.close()
    c.close()

    with local.open("rb") as lf:
        lf.seek(offset)
        while offset < size:
            chunk = lf.read(CHUNK)
            if not chunk:
                break
            for attempt in range(1, 6):
                try:
                    c = connect()
                    sftp = c.open_sftp()
                    mode = "ab" if offset else "wb"
                    with sftp.file(remote_part, mode) as rf:
                        rf.set_pipelined(False)
                        rf.write(chunk)
                    sftp.close()
                    c.close()
                    offset += len(chunk)
                    print(f"  +{len(chunk)} -> {offset}/{size} ({100*offset/size:.1f}%)")
                    break
                except Exception as e:
                    print(f"  chunk fail attempt {attempt}: {type(e).__name__}: {e}")
                    try:
                        c.close()
                    except Exception:
                        pass
                    time.sleep(2 * attempt)
            else:
                raise RuntimeError(f"chunk upload failed at offset {offset}")

    # finalize + verify
    c = connect()
    sftp = c.open_sftp()
    try:
        sftp.remove(remote)
    except OSError:
        pass
    sftp.rename(remote_part, remote)
    remote_size = sftp.stat(remote).st_size
    sftp.close()
    _i, o, e = c.exec_command(
        f"sha256sum '{remote}' | awk '{{print toupper($1)}}'",
        timeout=180,
    )
    remote_hash = o.read().decode().strip()
    code = o.channel.recv_exit_status()
    c.close()
    print("remote_size", remote_size, "remote_sha", remote_hash, "exit", code)
    if remote_size != size or remote_hash != digest:
        raise RuntimeError(f"integrity mismatch for {local_rel}")
    print("OK", local_rel)


def main() -> None:
    for local_rel, remote_rel in UPLOADS:
        put_chunked(local_rel, remote_rel)
    c = connect()
    _i, o, e = c.exec_command(
        "ln -sf erp-taranom.apk /home/taranom/crm-taranom/server/public/releases/crm-taranom.apk; "
        "cp -f '/home/taranom/crm-taranom/server/public/releases/ERP-Taranom-Setup-2.0.10.exe' "
        "'/home/taranom/crm-taranom/server/public/releases/ERP Taranom Setup 2.0.10.exe'; "
        "curl -s -o /dev/null -w 'apk=%{http_code}\\n' http://127.0.0.1:3000/releases/erp-taranom.apk; "
        "curl -s -o /dev/null -w 'exe=%{http_code}\\n' http://127.0.0.1:3000/releases/ERP-Taranom-Setup-2.0.10.exe; "
        "python3 -c \"import json; d=json.load(open('/home/taranom/crm-taranom/server/public/releases/manifest.json')); "
        "print(d['android']['version'], d['desktop']['version'], d['android']['sha256'][:12], d['desktop']['sha256'][:12])\"",
        timeout=120,
    )
    print(o.read().decode("utf-8", "replace"))
    c.close()
    print("DONE")


if __name__ == "__main__":
    main()
