#!/usr/bin/env bash
# استقرار ERP ترنم روی سرور مرکزی (production)
# اجرا روی سرور:  bash scripts/deploy-production.sh
#
# پیش‌نیاز: git، node 20+، pm2
# APP_ROOT پیش‌فرض: خانهٔ کاربر فعلی (مثلاً /home/taranom/crm-taranom)
set -euo pipefail

BRANCH="${DEPLOY_BRANCH:-claude/claude-md-docs-2ssrpy}"
APP_ROOT="${APP_ROOT:-$HOME/crm-taranom}"
SERVER_DIR="$APP_ROOT/server"
JWT_FILE="$SERVER_DIR/jwt-secret.txt"

echo "==> ERP ترنم — deploy ($BRANCH)"
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

echo "==> ensure sharp runtime (waiver 0.33.5 on pre-v2 CPU)..."
node scripts/ensure-sharp-runtime.js || echo "⚠️ ensure-sharp-runtime failed — ImageEngine passthrough will keep uploads working"

echo "==> pm2 restart..."
# Never use --update-env unless every secret in ecosystem is accounted for.
pm2 describe erp-taranom >/dev/null 2>&1 && \
  pm2 restart erp-taranom || \
  pm2 start ecosystem.config.js
pm2 save

echo "==> health check..."
sleep 2
if curl -sf "http://127.0.0.1:${PORT:-3000}/api/system/time" >/dev/null; then
  echo "✅ سرور پاسخ داد."
else
  echo "❌ health check ناموفق — لاگ: pm2 logs erp-taranom --lines 30"
  exit 1
fi

echo ""
echo "✅ Deploy کامل شد."
echo "   یادآوری: APK اندروید هرگز روی سرور آپلود نشود — فقط build محلی (scripts/build-android.ps1)."
echo "   یادآوری: از پنل «پشتیبان» رمزنگاری بکاپ را فعال کنید (docs/SECURITY-HARDENING.md)"
echo "   اولین ورود admin: مودال تغییر اجباری رمز نمایش داده می‌شود."
