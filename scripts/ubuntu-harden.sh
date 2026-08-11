#!/bin/bash
# ==============================================================================
# Ubuntu 24.04 Security Hardening — ERP ترنم (VPS ایران)
# اجرا: sudo bash ubuntu-harden.sh
#
# اصلاح نسبت به نسخهٔ قبلی:
# - کلید SSH روی سرور ساخته نمی‌شود (باید از ماشین محلی بیاید)
# - /dev/shm به‌جای /run/shm
# - unattended-upgrades بدون تعامل
# - fail2ban با backend=systemd
# - sysctl، AllowUsers، MaxAuthTries، X11Forwarding
# - پورت 80/443 هنوز بسته (بعد از انتقال پروژه باز می‌شود)
# ==============================================================================
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "این اسکریپت باید با root/sudo اجرا شود."
  exit 1
fi

TARGET_USER="${TARGET_USER:-taranom}"
SSH_PORT="${SSH_PORT:-22}"

echo "==> [1/8] به‌روزرسانی بسته‌ها..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get upgrade -y
apt-get install -y \
  ufw fail2ban unattended-upgrades apt-listchanges \
  curl wget ca-certificates gnupg \
  chrony needrestart \
  vim-tiny nano htop

echo "==> [2/8] فایروال UFW..."
ufw --force reset >/dev/null 2>&1 || true
ufw default deny incoming
ufw default allow outgoing
# فقط SSH — HTTP/HTTPS بعد از استقرار Nginx باز می‌شود
if [[ "${SSH_PORT}" == "22" ]]; then
  ufw allow OpenSSH
else
  ufw allow "${SSH_PORT}/tcp" comment 'SSH custom'
fi
ufw --force enable
ufw status verbose

echo "==> [3/8] Fail2Ban (ضد brute-force SSH)..."
mkdir -p /etc/fail2ban
cat >/etc/fail2ban/jail.local <<EOF
[DEFAULT]
bantime  = 1h
findtime = 10m
maxretry = 3
backend  = systemd

[sshd]
enabled  = true
port     = ${SSH_PORT}
filter   = sshd
maxretry = 3
bantime  = 1h
findtime = 10m
EOF
systemctl enable fail2ban
systemctl restart fail2ban
systemctl --no-pager --full status fail2ban | head -n 15 || true

echo "==> [4/8] سخت‌سازی SSH (رمز هنوز فعال — تا تست کلید)..."
cp -a /etc/ssh/sshd_config "/etc/ssh/sshd_config.bak.$(date +%Y%m%d%H%M%S)"
mkdir -p /etc/ssh/sshd_config.d
# کلید عمومی باید از قبل در ~/.ssh/authorized_keys کاربر باشد
if [[ ! -s "/home/${TARGET_USER}/.ssh/authorized_keys" ]]; then
  echo "⚠️  هشدار: /home/${TARGET_USER}/.ssh/authorized_keys خالی/غایب است."
  echo "    قبل از PasswordAuthentication no حتماً کلید را نصب کنید."
fi

cat >/etc/ssh/sshd_config.d/99-hardening.conf <<EOF
# ERP ترنم — SSH hardening (Ubuntu 24.04 drop-in)
PermitRootLogin no
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
AllowUsers ${TARGET_USER}
EOF

# اعتبارسنجی قبل از restart — جلوگیری از قفل شدن سرور
if sshd -t 2>/dev/null; then
  systemctl restart ssh
else
  echo "❌ sshd_config نامعتبر است — restart انجام نشد."
  sshd -t || true
  exit 1
fi

echo "==> [5/8] به‌روزرسانی خودکار امنیتی..."
cat >/etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF
# فقط آپدیت‌های امنیتی — بدون پرسش تعاملی
if [[ -f /etc/apt/apt.conf.d/50unattended-upgrades ]]; then
  sed -i 's|//\s*"\${distro_id}:\${distro_codename}-security"|"${distro_id}:${distro_codename}-security"|' \
    /etc/apt/apt.conf.d/50unattended-upgrades || true
fi
systemctl enable unattended-upgrades >/dev/null 2>&1 || true
systemctl restart unattended-upgrades >/dev/null 2>&1 || true

echo "==> [6/8] sysctl شبکه + حافظه مشترک..."
cat >/etc/sysctl.d/99-crm-harden.conf <<'EOF'
# جلوگیری از IP spoofing / redirect abuse
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
# IPv6 redirects (اگر IPv6 فعال باشد)
net.ipv6.conf.all.accept_redirects = 0
net.ipv6.conf.default.accept_redirects = 0
net.ipv6.conf.all.accept_source_route = 0
EOF
sysctl --system >/dev/null 2>&1 || sysctl -p /etc/sysctl.d/99-crm-harden.conf || true

# shared memory — مسیر استاندارد Ubuntu: /dev/shm
if ! grep -qE '^[^#]*\s/dev/shm\s' /etc/fstab; then
  echo 'tmpfs /dev/shm tmpfs defaults,noexec,nosuid,nodev 0 0' >> /etc/fstab
fi
mount -o remount,noexec,nosuid,nodev /dev/shm 2>/dev/null || true

echo "==> [7/8] زمان‌سنجی + محدودیت sudo..."
systemctl enable --now chrony >/dev/null 2>&1 || true
# کاربر هدف باید sudo داشته باشد (بدون پسورد برای اسکریپت‌های آینده اختیاری است — اینجا دست نمی‌زنیم)
if id "${TARGET_USER}" &>/dev/null; then
  usermod -aG sudo "${TARGET_USER}" 2>/dev/null || true
  chmod 700 "/home/${TARGET_USER}/.ssh" 2>/dev/null || true
  chmod 600 "/home/${TARGET_USER}/.ssh/authorized_keys" 2>/dev/null || true
  chown -R "${TARGET_USER}:${TARGET_USER}" "/home/${TARGET_USER}/.ssh" 2>/dev/null || true
fi

echo "==> [8/8] آماده‌سازی مسیر استقرار (بدون نصب Node هنوز)..."
mkdir -p /home/"${TARGET_USER}"/crm-taranom
chown -R "${TARGET_USER}:${TARGET_USER}" /home/"${TARGET_USER}"/crm-taranom
# لاگ‌های auth قابل‌خواندن برای fail2ban از قبل هست

echo ""
echo "=============================================================================="
echo "✅ Hardening پایه تمام شد."
echo ""
echo "وضعیت فعلی SSH:"
echo "  - PermitRootLogin: no"
echo "  - PasswordAuthentication: هنوز YES (تا وقتی کلید را تست کنید)"
echo "  - AllowUsers: ${TARGET_USER}"
echo "  - UFW: فقط SSH باز است (80/443 بسته)"
echo ""
echo "قدم بعدی (از ماشین محلی، در ترمینال جدا):"
echo "  ssh -i ~/.ssh/id_ed25519_taranom ${TARGET_USER}@SERVER_IP"
echo ""
echo "اگر ورود با کلید موفق بود، این را اجرا کنید:"
echo "  sudo sed -i 's/^PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config.d/99-hardening.conf"
echo "  sudo sshd -t && sudo systemctl restart ssh"
echo ""
echo "⚠️  رمز سرور در چت افشا شده — بعد از فعال‌شدن کلید، رمز را عوض کنید:"
echo "  passwd"
echo "=============================================================================="
