#!/bin/bash
# اجرا از کنسول/VNC پنل هاست (اگر SSH بلاک شد)
# آنبن کردن IP و اطمینان از تکمیل harden

set -euo pipefail

BANNED_IP="${1:-140.82.39.93}"

echo "==> Unban Fail2Ban / UFW for $BANNED_IP"
fail2ban-client set sshd unbanip "$BANNED_IP" 2>/dev/null || true
fail2ban-client unban --all 2>/dev/null || true
ufw status numbered || true
# اگر IP در deny list بود:
ufw delete deny from "$BANNED_IP" 2>/dev/null || true

echo "==> Ensure SSH allowed"
ufw allow OpenSSH
ufw --force enable
ufw status verbose

echo "==> Ensure harden config exists"
if [[ ! -f /etc/ssh/sshd_config.d/99-hardening.conf ]]; then
  echo "Harden config missing — re-run /tmp/ubuntu-harden.sh if present"
  ls -la /tmp/ubuntu-harden.sh || true
else
  cat /etc/ssh/sshd_config.d/99-hardening.conf
fi

echo "==> Keep password auth ON until key login verified from your PC"
sed -i 's/^PasswordAuthentication no/PasswordAuthentication yes/' /etc/ssh/sshd_config.d/99-hardening.conf 2>/dev/null || true
sshd -t && systemctl restart ssh
systemctl is-active ssh fail2ban

echo "==> App user + key check"
getent passwd taranom || true
ls -la /home/taranom/.ssh/ 2>/dev/null || true
wc -l /home/taranom/.ssh/authorized_keys 2>/dev/null || true

echo "Done. From your PC:"
echo "  ssh -i ~/.ssh/id_ed25519_taranom taranom@SERVER_IP"
