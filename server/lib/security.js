// Production security checks and password policy.
const DEFAULT_JWT = 'taranom-crm-secret-2024';

function validatePassword(pass) {
  const p = String(pass || '');
  if (p.length < 8) return 'رمز باید حداقل ۸ کاراکتر باشد';
  if (p.length > 128) return 'رمز خیلی طولانی است';
  if (!/[a-zA-Z\u0600-\u06FF]/.test(p) || !/\d/.test(p)) {
    return 'رمز باید شامل حرف و عدد باشد';
  }
  return null;
}

function assertSecurityConfig() {
  const secret = process.env.JWT_SECRET || DEFAULT_JWT;
  const isProd = process.env.NODE_ENV === 'production';

  if (isProd) {
    if (!process.env.JWT_SECRET || secret === DEFAULT_JWT || secret.length < 32) {
      console.error('❌ امنیت: در production متغیر JWT_SECRET (حداقل ۳۲ کاراکتر تصادفی) الزامی است.');
      console.error('   تولید: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
      if (process.env.SECURITY_STRICT !== '0') process.exit(1);
      console.warn('⚠️ SECURITY_STRICT=0 — ادامه با رمز ضعیف (فقط موقت)');
    }
  } else if (!process.env.JWT_SECRET || secret === DEFAULT_JWT) {
    console.warn('⚠️ JWT_SECRET پیش‌فرض — فقط برای توسعه. در production حتماً تغییر دهید.');
  }

  if (isProd && !process.env.ALLOWED_ORIGINS) {
    console.error('❌ امنیت: ALLOWED_ORIGINS در production الزامی است.');
    if (process.env.SECURITY_STRICT !== '0') process.exit(1);
  }
}

module.exports = { validatePassword, assertSecurityConfig, DEFAULT_JWT };
