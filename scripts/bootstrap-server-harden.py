#!/usr/bin/env python3
"""One-shot: install SSH pubkey + run ubuntu-harden.sh on a fresh VPS.
Credentials via env only — never commit passwords.

  $env:TARANOM_SSH_PASS='...'
  $env:TARANOM_SSH_USER='root'   # first boot often only root works
  python scripts/bootstrap-server-harden.py
"""
from __future__ import annotations

import os
import shlex
import sys
import time
from pathlib import Path

import paramiko

HOST = os.environ.get("TARANOM_SSH_HOST", "94.249.244.208")
USER = os.environ.get("TARANOM_SSH_USER", "root")
PASS = os.environ.get("TARANOM_SSH_PASS", "")
APP_USER = os.environ.get("TARANOM_APP_USER", "taranom")
KEY_PATH = Path(os.environ.get(
    "TARANOM_SSH_KEY",
    Path.home() / ".ssh" / "id_ed25519_taranom",
))
PUB_PATH = Path(str(KEY_PATH) + ".pub")
SCRIPT_DIR = Path(__file__).resolve().parent
HARDEN_SCRIPT = SCRIPT_DIR / "ubuntu-harden.sh"


def connect_password(user: str = USER) -> paramiko.SSHClient:
    if not PASS:
        print("Set TARANOM_SSH_PASS env var.", file=sys.stderr)
        sys.exit(1)
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST, username=user, password=PASS, timeout=30, allow_agent=False, look_for_keys=False)
    return c


def connect_key(user: str = APP_USER) -> paramiko.SSHClient:
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    pkey = paramiko.Ed25519Key.from_private_key_file(str(KEY_PATH))
    c.connect(HOST, username=user, pkey=pkey, timeout=30, allow_agent=False, look_for_keys=False)
    return c


def run(c: paramiko.SSHClient, cmd: str, timeout: int = 600) -> tuple[int, str, str]:
    stdin, stdout, stderr = c.exec_command(cmd, timeout=timeout, get_pty=True)
    out = stdout.read().decode("utf-8", errors="replace")
    err = stderr.read().decode("utf-8", errors="replace")
    code = stdout.channel.recv_exit_status()
    return code, out, err


def as_root(c: paramiko.SSHClient, cmd: str, timeout: int = 600) -> tuple[int, str, str]:
    """Run as root. If already root, no sudo; else sudo -S."""
    who = run(c, "id -u")[1].strip().splitlines()[-1].strip()
    if who == "0":
        return run(c, f"bash -lc {shlex.quote(cmd)}", timeout=timeout)
    full = f"sudo -S -p '' bash -lc {shlex.quote(cmd)}"
    stdin, stdout, stderr = c.exec_command(full, timeout=timeout, get_pty=True)
    stdin.write(PASS + "\n")
    stdin.flush()
    out = stdout.read().decode("utf-8", errors="replace")
    err = stderr.read().decode("utf-8", errors="replace")
    code = stdout.channel.recv_exit_status()
    return code, out, err


def ensure_app_user(c: paramiko.SSHClient, pub: str) -> None:
    print(f"==> Ensuring app user '{APP_USER}' + sudo + authorized_keys...")
    script = f"""
set -euo pipefail
if ! id {shlex.quote(APP_USER)} >/dev/null 2>&1; then
  adduser --disabled-password --gecos 'CRM Taranom' {shlex.quote(APP_USER)}
  echo {shlex.quote(APP_USER + ':' + PASS)} | chpasswd
fi
usermod -aG sudo {shlex.quote(APP_USER)}
# passwordless sudo for deploy convenience (optional — can remove later)
echo '{APP_USER} ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/{APP_USER}
chmod 440 /etc/sudoers.d/{APP_USER}
HOME_DIR=$(getent passwd {shlex.quote(APP_USER)} | cut -d: -f6)
mkdir -p "$HOME_DIR/.ssh"
chmod 700 "$HOME_DIR/.ssh"
AUTH="$HOME_DIR/.ssh/authorized_keys"
touch "$AUTH"
chmod 600 "$AUTH"
if ! grep -qxF {shlex.quote(pub)} "$AUTH" 2>/dev/null; then
  echo {shlex.quote(pub)} >> "$AUTH"
fi
chown -R {shlex.quote(APP_USER)}:{shlex.quote(APP_USER)} "$HOME_DIR/.ssh"
# also put key on root for emergency (optional)
mkdir -p /root/.ssh && chmod 700 /root/.ssh
touch /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys
if ! grep -qxF {shlex.quote(pub)} /root/.ssh/authorized_keys 2>/dev/null; then
  echo {shlex.quote(pub)} >> /root/.ssh/authorized_keys
fi
echo USER_READY
"""
    code, out, err = as_root(c, script)
    print(out)
    if err.strip():
        print(err)
    if code != 0 or "USER_READY" not in out:
        raise SystemExit(f"Failed to ensure app user (exit {code})")


def main() -> None:
    if not PUB_PATH.exists():
        print(f"Missing public key: {PUB_PATH}", file=sys.stderr)
        sys.exit(1)
    if not HARDEN_SCRIPT.exists():
        print(f"Missing harden script: {HARDEN_SCRIPT}", file=sys.stderr)
        sys.exit(1)

    pub = PUB_PATH.read_text(encoding="utf-8").strip()
    harden = HARDEN_SCRIPT.read_text(encoding="utf-8")

    print(f"==> Connecting {USER}@{HOST} (password)...")
    c = connect_password()
    try:
        ensure_app_user(c, pub)

        remote_script = "/tmp/ubuntu-harden.sh"
        print(f"==> Uploading {HARDEN_SCRIPT.name} -> {remote_script}")
        sftp = c.open_sftp()
        with sftp.open(remote_script, "w") as f:
            f.write(harden)
        sftp.chmod(remote_script, 0o755)
        sftp.close()

        print("==> Running hardening (apt upgrade may take several minutes)...")
        code, out, err = as_root(c, f"TARGET_USER={APP_USER} bash {remote_script}", timeout=1800)
        sys.stdout.buffer.write((out or "").encode("utf-8", errors="replace"))
        sys.stdout.buffer.write(b"\n")
        if err.strip():
            sys.stdout.buffer.write(b"--- stderr ---\n")
            sys.stdout.buffer.write(err.encode("utf-8", errors="replace"))
            sys.stdout.buffer.write(b"\n")
        if code != 0:
            print(f"Harden failed with exit {code}", file=sys.stderr)
            sys.exit(code)
    finally:
        c.close()

    print(f"==> Testing key-based login as {APP_USER}...")
    time.sleep(2)
    c2 = connect_key(APP_USER)
    try:
        code, out, err = run(
            c2,
            "echo KEY_OK; whoami; hostname; "
            "sudo ufw status | head -n 25; "
            "systemctl is-active fail2ban ssh; "
            "grep -E 'PasswordAuthentication|PermitRootLogin|AllowUsers' /etc/ssh/sshd_config.d/99-hardening.conf || true",
        )
        print(out)
        if "KEY_OK" not in out:
            print("❌ Key login test failed", file=sys.stderr)
            sys.exit(1)

        print("==> Disabling PasswordAuthentication...")
        code, out, err = as_root(
            c2,
            "sed -i 's/^PasswordAuthentication yes/PasswordAuthentication no/' "
            "/etc/ssh/sshd_config.d/99-hardening.conf && "
            "grep -q '^PasswordAuthentication no' /etc/ssh/sshd_config.d/99-hardening.conf || "
            "echo 'PasswordAuthentication no' >> /etc/ssh/sshd_config.d/99-hardening.conf && "
            "sshd -t && systemctl restart ssh && "
            "grep PasswordAuthentication /etc/ssh/sshd_config.d/99-hardening.conf",
        )
        print(out or err)
        if code != 0:
            print(f"⚠️  Could not disable password auth (exit {code}). Fix manually.", file=sys.stderr)
        else:
            print("✅ PasswordAuthentication disabled.")
    finally:
        c2.close()

    print("")
    print("Done. Connect with:")
    print(f'  ssh -i "{KEY_PATH}" {APP_USER}@{HOST}')
    print("Change the shared password:")
    print("  passwd")


if __name__ == "__main__":
    main()
