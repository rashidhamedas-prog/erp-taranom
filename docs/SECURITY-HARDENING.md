# سخت‌سازی امنیتی — CRM ترنم

این سند مرجع اجرای بند «ب» از `docs/PROJECT-HANDOFF.md` (بخش ۶) است: چه چیزهایی در کد اعمال شده و چه کارهایی باید **روی سرور** انجام شود.

---

## ۱) اعمال‌شده در کد ✅

### تغییر اجباری رمز پیش‌فرض/موقت (اولین ورود)
- ستون `users.must_change_password` اضافه شد (migration خودکار در `server/db.js`).
- ادمین پیش‌فرض با پرچم ۱ ساخته می‌شود؛ در دیتابیس‌های قدیمی، **ورود با رمز `admin123`** به‌طور خودکار پرچم را فعال می‌کند.
- تا وقتی رمز عوض نشود، میان‌افزار `auth` همه مسیرها به‌جز `/api/auth/change-password` و `/api/auth/me` را با کد `must_change_password` (HTTP 403) رد می‌کند و فرانت‌اند مودال «تغییر اجباری رمز عبور» را بدون راه فرار نشان می‌دهد.
- ساخت کاربر جدید و بازنشانی رمز توسط مدیر هم پرچم را فعال می‌کند (رمز تعیین‌شده توسط مدیر موقتی است).
- **فقط روی سرور مرکزی** اعمال می‌شود: دستگاه‌های آفلاین (SYNC_ROLE=device) جدول `users` را از مرکز pull می‌کنند و تغییر محلی رمز بی‌اثر می‌شد؛ رمز جدید با اولین همگام‌سازی به دستگاه می‌رسد.
- انتخاب دوباره `admin123` به‌عنوان رمز جدید ممنوع است.

### رمزنگاری پشتیبان (AES-256-GCM)
- اگر رمز پشتیبان تنظیم شده باشد (کلید تنظیمات `backup_password` از صفحه «پشتیبان»، یا متغیر محیطی `BACKUP_PASSWORD`)، خروجی `tar.gz`/`zip` رمزنگاری و با پسوند `.enc` ذخیره می‌شود.
- فرمت فایل: `TRNMBKP1` + salt(16) + iv(12) + ciphertext + authTag(16)؛ کلید با scrypt از رمز مشتق می‌شود.
- بازگشایی: `node server/scripts/decrypt-backup.js <فایل.enc> [خروجی]` (رمز از `BACKUP_PASSWORD` یا پرسش تعاملی).
- تنظیم رمز فقط روی سرور مرکزی انجام می‌شود و از طریق sync جدول `settings` به دستگاه‌ها می‌رسد، پس بکاپ محلی دسکتاپ هم رمزنگاری می‌شود.
- ⚠️ رمز پشتیبان را جای امن (خارج از سرور) نگه دارید — بدون آن بازیابی ممکن نیست.

### حذف اسرار از مخزن
- `JWT_SECRET` هاردکد از `server/ecosystem.config.js` حذف شد — حالا از `server/jwt-secret.txt` (در `.gitignore`) یا env خوانده می‌شود.
- رمز keystore اندروید از `android/app/build.gradle` و `android/BUILD.md` حذف شد — از `android/keystore.properties` (در `.gitignore`) یا متغیرهای `CRM_KEYSTORE_*` خوانده می‌شود.
- فایل `android/crm-taranom.jks` از مخزن حذف شد و الگوهای `*.jks` / `keystore.properties` / `jwt-secret.txt` / `.env` به `.gitignore` اضافه شدند.

---

## ۲) کارهای الزامی روی سرور (چک‌لیست عملیات)

### الف) JWT_SECRET
```bash
cd /home/taranom-admin/crm-taranom/server
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" > jwt-secret.txt
chmod 600 jwt-secret.txt
pm2 restart crm-taranom --update-env
```
> از قبل `assertSecurityConfig()` در production بدون `JWT_SECRET` معتبر (≥۳۲ کاراکتر) سرور را بالا نمی‌آورد.
> ⚠️ با تغییر JWT_SECRET همه توکن‌های فعلی باطل می‌شوند — همه کاربران باید دوباره وارد شوند (یک‌بار، طبیعی است).

### ب) چرخش keystore اندروید
رمز و فایل keystore قبلی در **تاریخچه گیت** افشا شده است. پاک‌کردن تاریخچه نیاز به force-push و هماهنگی دارد؛ راه درست‌تر و کافی، **چرخش** است:
```bash
cd android
keytool -genkeypair -v -keystore crm-taranom.jks -alias crm-taranom -keyalg RSA -keysize 2048 -validity 10000
cat > keystore.properties <<'EOF'
storeFile=crm-taranom.jks
storePassword=<رمز جدید>
keyAlias=crm-taranom
keyPassword=<رمز جدید>
EOF
```
چون امضا عوض می‌شود، کاربران اندروید باید یک‌بار نسخه قبلی را حذف و APK جدید را نصب کنند (auto-update با امضای متفاوت نصب نمی‌شود).

### ج) رمز پشتیبان
از منوی «پشتیبان» در نسخه وب، یک رمز قوی (≥۸ کاراکتر) تعیین کنید و آن را خارج از سرور (مثلاً مدیر سیستم) نگه دارید.

### د) HTTPS (هنگام مهاجرت به سرور ایرانی)
برنامه پشت Nginx روی HTTP ساده است. برای فعال‌سازی TLS:

1. **دامنه** را به IP سرور متصل کنید (رکورد A).
2. **گواهی**: برای دسترسی از داخل ایران (اینترنت ملی) گواهی از CA قابل قبول مرورگرها کافی است؛ Let's Encrypt (رایگان) معمولاً کار می‌کند:
   ```bash
   sudo apt install certbot python3-certbot-nginx
   sudo certbot --nginx -d crm.example.ir
   ```
   اگر certbot به‌دلیل تحریم/فیلترینگ شکست خورد، از CA ایرانی (مثلاً گواهی میزبان‌های داخلی) گواهی بگیرید و دستی نصب کنید.
3. **پیکربندی Nginx** (نمونه کامل):
   ```nginx
   server {
     listen 80;
     server_name crm.example.ir;
     return 301 https://$host$request_uri;
   }
   server {
     listen 443 ssl http2;
     server_name crm.example.ir;

     ssl_certificate     /etc/letsencrypt/live/crm.example.ir/fullchain.pem;
     ssl_certificate_key /etc/letsencrypt/live/crm.example.ir/privkey.pem;
     ssl_protocols TLSv1.2 TLSv1.3;

     add_header Strict-Transport-Security "max-age=31536000" always;
     client_max_body_size 20m;

     location / {
       proxy_pass http://127.0.0.1:3000;
       proxy_http_version 1.1;
       proxy_set_header Host $host;
       proxy_set_header X-Real-IP $remote_addr;
       proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
       proxy_set_header X-Forwarded-Proto $scheme;
     }
   }
   ```
   `app.set('trust proxy', 1)` از قبل در `server/server.js` هست، پس rate-limit و IPها پشت Nginx درست کار می‌کنند.
4. بعد از فعال‌سازی، آدرس سرور مرکزی در دستگاه‌های آفلاین (پنل همگام‌سازی) را به `https://...` تغییر دهید و `PUBLIC_URL` را در env سرور ست کنید تا لینک‌های auto-update درست ساخته شوند.

---

## ۳) سخت‌سازی سیستم‌عامل (VPS اوبونتو ایران)

اسکریپت‌ها در `scripts/`:

| فایل | نقش |
|------|-----|
| `ubuntu-harden.sh` | UFW + Fail2Ban + SSH drop-in + sysctl + unattended-upgrades |
| `bootstrap-server-harden.py` | نصب کلید عمومی از ماشین محلی + اجرای harden |
| `disable-ssh-password.sh` | بعد از تست کلید، قطع ورود با رمز |
| `ssh-config-taranom-ir.example` | نمونه `~/.ssh/config` |

### باگ‌های اسکریپت قدیمی که اصلاح شد
1. **ساخت کلید روی سرور** اشتباه است — کلید باید روی لپ‌تاپ ساخته شود و فقط pubkey روی سرور برود.
2. مسیر حافظه مشترک درست **`/dev/shm`** است نه `/run/shm`.
3. `dpkg-reconfigure` تعاملی بود → تنظیم noninteractive.
4. Fail2Ban روی Ubuntu 24.04 با **`backend = systemd`**.
5. قبل از `restart ssh` باید **`sshd -t`** اجرا شود تا سرور قفل نشود.
6. `PermitRootLogin no` + `AllowUsers` + `MaxAuthTries` اضافه شد.
7. پورت 80/443 عمداً بسته می‌ماند تا Nginx بعد از انتقال پروژه باز شود.

### اجرای دستی (بعد از ورود موفق به سرور)
```bash
# روی ویندوز (یک‌بار):
ssh-keygen -t ed25519 -f %USERPROFILE%\.ssh\id_ed25519_taranom -N ""

# کپی کلید (وقتی رمز/پنل کنسول کار می‌کند):
type %USERPROFILE%\.ssh\id_ed25519_taranom.pub | ssh taranom@SERVER_IP "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"

# روی سرور:
sudo bash ubuntu-harden.sh
# تست کلید در ترمینال جدید، سپس:
sudo bash disable-ssh-password.sh
passwd   # رمز چت‌شده را عوض کنید
```

یا یک‌جا از ویندوز (رمز فقط در env — هرگز در گیت):
```powershell
$env:TARANOM_SSH_PASS='...'
$env:TARANOM_SSH_HOST='94.249.244.208'
python scripts/bootstrap-server-harden.py
```

### قبل از انتقال پروژه (هنوز انجام نشود تا harden تمام شود)
1. باز کردن 80/443: `sudo ufw allow 80/tcp && sudo ufw allow 443/tcp`
2. نصب Node 20 + PM2 + Nginx + certbot
3. `git clone` / `deploy-production.sh`
4. دامنه `.ir` → A record به IP سرور → SSL

---

## ۴) وضعیت باقی‌مانده

- [x] VPS ایران (`94.249.244.208`) سرور production فعلی است؛ سرور آلمان از رده خارج شد
- [ ] تکمیل harden / HTTPS دامنه روی سرور ایران
- [ ] اجرای چک‌لیست بخش ۲ روی سرور production (JWT / بکاپ / HTTPS)
- [x] تغییر اجباری رمز پیش‌فرض — کد کامل
- [x] رمزنگاری بکاپ — کد کامل (فعال‌سازی: تعیین رمز از UI)
- [x] حذف اسرار از فایل‌های مخزن (تاریخچه دست‌نخورده — پوشش با چرخش)
- [x] اسکریپت harden اصلاح‌شده در مخزن
