#!/usr/bin/env python3
"""Upload and run bootstrap-iran-vps.sh on the hardened IR VPS."""
from __future__ import annotations

import sys
import time
from pathlib import Path

import paramiko

HOST = "94.249.244.208"
USER = "taranom"
KEY = Path.home() / ".ssh" / "id_ed25519_taranom"
SCRIPT = Path(__file__).resolve().parent / "bootstrap-iran-vps.sh"


def main() -> None:
    pkey = paramiko.Ed25519Key.from_private_key_file(str(KEY))
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    print(f"==> connect {USER}@{HOST}")
    c.connect(HOST, username=USER, pkey=pkey, timeout=30, allow_agent=False, look_for_keys=False)

    sftp = c.open_sftp()
    remote = "/tmp/bootstrap-iran-vps.sh"
    with sftp.open(remote, "w") as f:
        f.write(SCRIPT.read_text(encoding="utf-8"))
    sftp.chmod(remote, 0o755)
    sftp.close()

    # ensure fail2ban ignore current peer if possible
    cmd = f"sudo bash {remote}"
    print("==> running bootstrap (node install + clone + nginx)...")
    stdin, stdout, stderr = c.exec_command(cmd, timeout=2400, get_pty=True)
    # stream
    while True:
        line = stdout.readline()
        if not line:
            break
        sys.stdout.buffer.write(line.encode("utf-8", errors="replace") if isinstance(line, str) else line)
        sys.stdout.buffer.flush()
    code = stdout.channel.recv_exit_status()
    err = stderr.read()
    if err:
        sys.stdout.buffer.write(err if isinstance(err, bytes) else err.encode())
    print("EXIT", code)
    c.close()
    if code != 0:
        raise SystemExit(code)


if __name__ == "__main__":
    main()
