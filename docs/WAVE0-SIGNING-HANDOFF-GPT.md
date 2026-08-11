# دست‌به‌دست ChatGPT — امضای APK / EXE (Cursor، 2026-08-01)

> شاخه: `claude/claude-md-docs-2ssrpy`  
> مخزن: `rashidhamedas-prog/erp-taranom`  
> این فایل را کامل بخوان؛ **رمز/کلید را در git نگذار و در چت عمومی تکرار نکن.**

---

## خلاصه یک‌خطی

Cursor روی ماشین Windows کاربر **APK اندروید 2.0.32** و **Installer دسکتاپ 2.0.9** را با کلیدهای **محلی (غیر تجاری / خودامضا برای EXE)** امضا کرد، خروجی را در پوشهٔ تحویل گذاشت، `gitignore` را برای PFX/JKS محکم کرد، و مسیر انتشار وب (`releases/` + `manifest.json`) را هم‌تراز کرد. **گواهی تجاری OV/EV ویندوز هنوز تهیه نشده** — روی PCهای دیگر ممکن است SmartScreen ناشناس بماند.

---

## اندروید (APK)

| مورد | مقدار |
|------|--------|
| نسخه | `2.0.32` / versionCode `34` |
| Keystore | `android/erp-taranom.jks` (**gitignored**؛ در تاریخچهٔ قدیمی keystore لو رفته بود → **keystore جدید**) |
| Config | `android/keystore.properties` (**gitignored**) |
| Subject | `CN=Poshak Taranom` |
| تأیید | `apksigner verify` OK |
| خروجی تحویل | `D:\soft\Claud\porje\crm-taranom\New folder\erp-taranom-signed.apk` |
| مسیر وب | `server/public/releases/erp-taranom.apk` (+ `crm-taranom.apk`) |
| SHA-256 | `CF60CF86B49508721C7E70986996514734902CE0AE423B3C73800B38257F0C90` |
| Manifest | `android.version=2.0.32` → url `/releases/erp-taranom.apk` |

**نکتهٔ نصب:** چون کلید امضا نسبت به بیلدهای قبلی عوض شده، ارتقا روی دستگاه‌های قدیمی ممکن است نیاز به **uninstall یک‌بار** و نصب مجدد داشته باشد (sideload).

---

## ویندوز (EXE / electron-builder)

| مورد | مقدار |
|------|--------|
| نسخه | `2.0.9` |
| گواهی | **خودامضا** Code Signing PFX: `desktop/certs/taranom-codesign.pfx` (**gitignored**؛ `.gitignore` شامل `desktop/certs/` و `*.pfx`) |
| Subject / Issuer | `CN=Poshak Taranom, O=Taranom, L=Mashhad, C=IR` |
| اعتبار محلی | تا ~2031؛ روی **همان PC بیلد** Trust شد → `Get-AuthenticodeSignature` = **Valid** |
| بیلد | `CSC_LINK` + `CSC_KEY_PASSWORD` هنگام `npm run dist:win` |
| خروجی تحویل | `New folder\ERP-Taranom-Setup-2.0.9-signed.exe` (+ `latest.yml` + `.blockmap`) |
| مسیر وب | `server/public/releases/ERP-Taranom-Setup-2.0.9.exe` و نام با فاصله مطابق `latest.yml` |
| SHA-256 | `940922969311FA7D187C7638E2A912A204F0989149B1F3BC2C2719B80A866C22` |
| Commit مرتبط ignore | `e5e6949` |

**محدودیت:** خودامضا ≠ گواهی تجاری. روی PC دیگر: Unknown publisher / SmartScreen تا خرید OV/EV. `REQUIRE_SIGNED_UPDATES=1` هنوز به‌صورت پیش‌فرض روی همهٔ کلاینت‌های تولید روشن نشده مگر ops بخواهد.

---

## کارهایی که Cursor عمداً نکرد / باز است برای تو

1. خرید و نصب **گواهی تجاری Windows** (OV/EV) و re-sign EXE با همان pipeline (`CSC_LINK`).
2. روشن‌کردن اجباری `REQUIRE_SIGNED_UPDATES=1` روی کلاینت‌های production بعد از انتشار signed feed پایدار.
3. تست end-to-end: یک آپدیت in-app موفق روی PC تست + رد fallback unsigned.
4. **موج ۱–۴ را شروع نکن** مگر کاربر بگوید؛ Gate باقی‌مانده: xlsx→exceljs (waiver تا 2026-10-01)، حذف کامل `unsafe-inline`.
5. رمز keystore/PFX فقط نزد ops؛ در CHANGE-LOG/چت/commit تکرار نشود.

---

## وضعیت Gate مرتبط (فعلی)

- امضای APK/EXE عملیاتی روی PC بیلد: ✅  
- گواهی تجاری ویندوز: ❌  
- Offsite ایران (`BACKUP_OFFSITE_DIR`): ✅ ops + drill  
- مرجع: `docs/WAVE0-GATE-STATUS.md`, `docs/WAVE0-SIGNING-RUNBOOK.md`

---

## دستورهای تأیید سریع (محلی)

```powershell
# APK
& "$env:LOCALAPPDATA\Android\Sdk\build-tools\*\apksigner.bat" verify --verbose "D:\soft\Claud\porje\crm-taranom\New folder\erp-taranom-signed.apk"

# EXE
Get-AuthenticodeSignature "D:\soft\Claud\porje\crm-taranom\New folder\ERP-Taranom-Setup-2.0.9-signed.exe"
```

---

*پایان handoff امضا — ادامهٔ کار Gate غیر امضا را از CHANGE-LOG بالای فایل و WAVE0-GATE-STATUS بگیر.*
