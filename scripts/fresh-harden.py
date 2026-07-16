#!/usr/bin/env python3
"""Fresh VPS harden for CRM تارانوم — credentials via env only."""
from __future__ import annotations

import os
import shlex
import sys
import time
from pathlib import Path

import paramiko

HOST = os.environ.get("TARANOM_SSH_HOST", "94.249.244.208")
PASS = os.environ["TARANOM_SSH_PASS"]
APP_USER = "taranom"
IGNORE_IP = os.environ.get("TARANOM_IGNORE_IP", "140.82.39.93")
KEY_PATH = Path.home() / ".ssh" / "id_ed25519_taranom"
PUB = (Path(str(KEY_PATH) + ".pub")).read_text(encoding="utf-8").strip()


def connect(user: str, password: str | None = None, key: bool = False) -> paramiko.SSHClient:
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    kw = dict(hostname=HOST, username=user, timeout=30, allow_agent=False, look_for_keys=False, banner_timeout=40, auth_timeout=40)
    if key:
        kw["pkey"] = paramiko.Ed25519Key.from_private_key_file(str(KEY_PATH))
    else:
        kw["password"] = password
    c.connect(**kw)
    return c


def run(c: paramiko.SSHClient, cmd: str, timeout: int = 900) -> tuple[int, str]:
    stdin, stdout, stderr = c.exec_command(cmd, timeout=timeout, get_pty=True)
    out = stdout.read().decode("utf-8", errors="replace")
    err = stderr.read().decode("utf-8", errors="replace")
    code = stdout.channel.recv_exit_status()
    return code, out + (("\n" + err) if err.strip() else "")


def main() -> None:
    print(f"==> connect root@{HOST}")
    c = connect("root", PASS)
    try:
        script = f"""
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

echo '[1] packages'
apt-get update -y
apt-get install -y ufw fail2ban unattended-upgrades chrony curl ca-certificates

echo '[2] user {APP_USER}'
if ! id {APP_USER} >/dev/null 2>&1; then
  adduser --disabled-password --gecos 'CRM Taranom' {APP_USER}
fi
echo {shlex.quote(APP_USER + ':' + PASS)} | chpasswd
usermod -aG sudo {APP_USER}
echo '{APP_USER} ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/{APP_USER}
chmod 440 /etc/sudoers.d/{APP_USER}

echo '[3] ssh key'
mkdir -p /home/{APP_USER}/.ssh /home/{APP_USER}/crm-taranom /root/.ssh
chmod 700 /home/{APP_USER}/.ssh /root/.ssh
printf '%s\\n' {shlex.quote(PUB)} > /home/{APP_USER}/.ssh/authorized_keys
printf '%s\\n' {shlex.quote(PUB)} > /root/.ssh/authorized_keys
chmod 600 /home/{APP_USER}/.ssh/authorized_keys /root/.ssh/authorized_keys
chown -R {APP_USER}:{APP_USER} /home/{APP_USER}/.ssh /home/{APP_USER}/crm-taranom

echo '[4] ufw ssh only'
ufw --force reset >/dev/null 2>&1 || true
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw --force enable

echo '[5] fail2ban with ignoreip FIRST'
mkdir -p /etc/fail2ban
cat > /etc/fail2ban/jail.local <<EOF
[DEFAULT]
bantime  = 1h
findtime = 10m
maxretry = 5
backend  = systemd
ignoreip = 127.0.0.1/8 ::1 {IGNORE_IP}

[sshd]
enabled  = true
port     = ssh
filter   = sshd
maxretry = 5
bantime  = 1h
findtime = 10m
EOF
systemctl enable fail2ban
systemctl restart fail2ban

echo '[6] sysctl'
cat > /etc/sysctl.d/99-crm-harden.conf <<'EOF'
net.ipv4.conf.all.rp_filter = 1
net.ipv4.conf.default.rp_filter = 1
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.default.accept_redirects = 0
net.ipv4.conf.all.send_redirects = 0
net.ipv4.conf.default.send_redirects = 0
net.ipv4.conf.all.accept_source_route = 0
net.ipv4.conf.default.accept_source_route = 0
net.ipv4.icmp_echo_ignore_broadcasts = 1
net.ipv4.tcp_syncookies = 1
net.ipv6.conf.all.accept_redirects = 0
net.ipv6.conf.default.accept_redirects = 0
net.ipv6.conf.all.accept_source_route = 0
EOF
sysctl --system >/dev/null 2>&1 || true

echo '[7] unattended upgrades'
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF
systemctl enable --now chrony >/dev/null 2>&1 || true

echo '[8] ssh drop-in (password still ON until key verified)'
mkdir -p /etc/ssh/sshd_config.d
cat > /etc/ssh/sshd_config.d/99-hardening.conf <<'EOF'
PermitRootLogin prohibit-password
PubkeyAuthentication yes
PasswordAuthentication yes
KbdInteractiveAuthentication no
PermitEmptyPasswords no
X11Forwarding no
AllowTcpForwarding no
AllowAgentForwarding no
MaxAuthTries 3
LoginGraceTime 30
ClientAliveInterval 300
ClientAliveCountMax 2
AllowUsers {APP_USER} root
EOF
sshd -t
systemctl restart ssh
systemctl enable --now ssh

echo STAGE1_OK
hostname
ufw status | head -15
systemctl is-active ssh fail2ban
id {APP_USER}
wc -l /home/{APP_USER}/.ssh/authorized_keys
grep ignoreip /etc/fail2ban/jail.local
"""
        print("==> stage1 harden (may take a few minutes)...")
        code, out = run(c, "bash -lc " + shlex.quote(script), timeout=1200)
        sys.stdout.buffer.write(out.encode("utf-8", errors="replace"))
        sys.stdout.buffer.write(b"\n")
        if code != 0 or "STAGE1_OK" not in out:
            raise SystemExit(f"stage1 failed exit={code}")
    finally:
        c.close()

    print("==> verify key login as taranom")
    time.sleep(2)
    c2 = connect(APP_USER, key=True)
    try:
        code, out = run(c2, "echo KEY_OK; whoami; sudo -n true && echo SUDO_OK")
        print(out)
        if "KEY_OK" not in out:
            raise SystemExit("key login failed")

        print("==> disable password auth + root ssh")
        lock = f"""
set -euo pipefail
cat > /etc/ssh/sshd_config.d/99-hardening.conf <<'EOF'
PermitRootLogin no
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitEmptyPasswords no
X11Forwarding no
AllowTcpForwarding no
AllowAgentForwarding no
MaxAuthTries 3
LoginGraceTime 30
ClientAliveInterval 300
ClientAliveCountMax 2
AllowUsers {APP_USER}
EOF
sshd -t
systemctl restart ssh
grep -E 'PasswordAuthentication|PermitRootLogin|AllowUsers' /etc/ssh/sshd_config.d/99-hardening.conf
echo HARDEN_DONE
"""
        code, out = run(c2, "sudo -n bash -lc " + shlex.quote(lock))
        print(out)
        if code != 0 or "HARDEN_DONE" not in out:
            raise SystemExit(f"lock failed exit={code}")
    finally:
        c2.close()

    time.sleep(2)
    c3 = connect(APP_USER, key=True)
    try:
        code, out = run(c3, "echo FINAL_OK; whoami; hostname; sudo ufw status verbose | head -20; systemctl is-active ssh fail2ban")
        print(out)
    finally:
        c3.close()

    # password login should now fail
    try:
        connect("root", PASS)
        print("WARN: root password still works")
    except Exception:
        print("OK: root password login blocked")

    print("ALL_DONE")


if __name__ == "__main__":
    main()
