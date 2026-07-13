#!/usr/bin/env bash
# استقرار CRM ترنم روی سرور مرکزی (production)
# اجرا روی سرور:  bash scripts/deploy-production.sh
#
# پیش‌نیاز: git، node 20+، pm2، دسترسی به /home/taranom-admin/crm-taranom
set -euo pipefail

BRANCH="${DEPLOY_BRANCH:-claude/claude-md-docs-2ssrpy}"
APP_ROOT="${APP_ROOT:-/home/taranom-admin/crm-taranom}"
SERVER_DIR="$APP_ROOT/server"
JWT_FILE="$SERVER_DIR/jwt-secret.txt"

echo "==> CRM ترنم — deploy ($BRANCH)"
cd "$APP_ROOT"

echo "==> git fetch + pull..."
git fetch origin "$BRANCH"
git checkout "$BRANCH"
git pull origin "$BRANCH"

cd "$SERVER_DIR"

if [ ! -f "$JWT_FILE" ]; then
  echo "==> ساخت jwt-secret.txt (اولین بار)..."
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" > "$JWT_FILE"
  chmod 600 "$JWT_FILE"
  echo "    ⚠️  با این restart همهٔ توکن‌های قبلی باطل می‌شوند."
else
  echo "==> jwt-secret.txt موجود است — حفظ شد."
fi

echo "==> npm install..."
npm install --omit=dev

echo "==> pm2 restart..."
pm2 describe crm-taranom >/dev/null 2>&1 && \
  pm2 restart crm-taranom --update-env || \
  pm2 start ecosystem.config.js
pm2 save

echo "==> health check..."
sleep 2
if curl -sf "http://127.0.0.1:${PORT:-3000}/api/system/time" >/dev/null; then
  echo "✅ سرور پاسخ داد."
else
  echo "❌ health check ناموفق — لاگ: pm2 logs crm-taranom --lines 30"
  exit 1
fi

echo ""
echo "✅ Deploy کامل شد."
echo "   یادآوری: APK اندروید هرگز روی سرور آپلود نشود — فقط build محلی (scripts/build-android.ps1)."
echo "   یادآوری: از پنل «پشتیبان» رمزنگاری بکاپ را فعال کنید (docs/SECURITY-HARDENING.md)"
echo "   اولین ورود admin: مودال تغییر اجباری رمز نمایش داده می‌شود."
