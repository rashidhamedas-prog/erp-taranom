#!/bin/bash
# پیست کامل در VNC به‌عنوان root — یک‌بار، تمام کارهای امنیتی
set -euo pipefail

IGNORE_IP="140.82.39.93"
PUB='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICpPpB/nTxfFbq4q8q3K1tX9O8T2J06gEBH4MUiGIQQS taranom-crm-admin@Taranom'

echo "==> 1) Stop fail2ban + unban"
systemctl stop fail2ban 2>/dev/null || true
iptables -F fail2ban-ssh 2>/dev/null || true
iptables -F f2b-sshd 2>/dev/null || true
# flush common ban chains if present
for c in $(iptables -L -n 2>/dev/null | awk '/^Chain f2b/ {print $2}'); do iptables -F "$c" 2>/dev/null || true; done

echo "==> 2) Packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ufw fail2ban unattended-upgrades chrony curl ca-certificates

echo "==> 3) User taranom + SSH key"
if ! id taranom >/dev/null 2>&1; then
  adduser --disabled-password --gecos 'ERP Taranom' taranom
fi
usermod -aG sudo taranom
echo 'taranom ALL=(ALL) NOPASSWD:ALL' >/etc/sudoers.d/taranom
chmod 440 /etc/sudoers.d/taranom
mkdir -p /home/taranom/.ssh /home/taranom/crm-taranom
chmod 700 /home/taranom/.ssh
touch /home/taranom/.ssh/authorized_keys
chmod 600 /home/taranom/.ssh/authorized_keys
grep -qxF "$PUB" /home/taranom/.ssh/authorized_keys || echo "$PUB" >>/home/taranom/.ssh/authorized_keys
chown -R taranom:taranom /home/taranom/.ssh /home/taranom/crm-taranom

echo "==> 4) UFW (SSH only for now)"
ufw --force reset >/dev/null 2>&1 || true
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw --force enable

echo "==> 5) Fail2Ban with ignoreip"
mkdir -p /etc/fail2ban
cat >/etc/fail2ban/jail.local <<EOF
[DEFAULT]
bantime  = 1h
findtime = 10m
maxretry = 5
backend  = systemd
ignoreip = 127.0.0.1/8 ::1 ${IGNORE_IP}

[sshd]
enabled  = true
port     = ssh
filter   = sshd
maxretry = 5
bantime  = 1h
findtime = 10m
EOF

echo "==> 6) SSH hardening (key-only for taranom)"
mkdir -p /etc/ssh/sshd_config.d
cat >/etc/ssh/sshd_config.d/99-hardening.conf <<'EOF'
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
AllowUsers taranom
EOF
sshd -t
systemctl restart ssh

echo "==> 7) sysctl + auto updates"
cat >/etc/sysctl.d/99-crm-harden.conf <<'EOF'
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
cat >/etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF
systemctl enable --now chrony fail2ban >/dev/null 2>&1 || true
systemctl restart fail2ban

echo "==== REPORT ===="
hostname
id taranom
ufw status verbose | head -20
systemctl is-active ssh fail2ban
grep -E 'PasswordAuthentication|PermitRootLogin|AllowUsers' /etc/ssh/sshd_config.d/99-hardening.conf
grep ignoreip /etc/fail2ban/jail.local
wc -l /home/taranom/.ssh/authorized_keys
echo HARDEN_COMPLETE
