#!/bin/bash
# ==============================================================================
# بعد از تست موفق ورود با کلید SSH — غیرفعال‌سازی ورود با رمز
# اجرا: sudo bash disable-ssh-password.sh
# ==============================================================================
set -euo pipefail
CONF=/etc/ssh/sshd_config.d/99-hardening.conf
if [[ ! -f "$CONF" ]]; then
  echo "فایل $CONF یافت نشد — اول ubuntu-harden.sh را اجرا کنید."
  exit 1
fi
sed -i 's/^PasswordAuthentication yes/PasswordAuthentication no/' "$CONF"
grep -q '^PasswordAuthentication no' "$CONF" || echo 'PasswordAuthentication no' >> "$CONF"
sshd -t
systemctl restart ssh
echo "✅ PasswordAuthentication غیرفعال شد."
grep PasswordAuthentication "$CONF"
