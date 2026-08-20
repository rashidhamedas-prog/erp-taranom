# Stitch Phase 8 — سخت‌سازی یکپارچه (بدون Deploy)

**وضعیت:** در حال اجرا روی `ai/STITCH-P8-POS03-ADR007`  
**مرجع فرمان:** `MASTER-CURSOR-COMMAND.md` فاز ۸  
**خارج از این نوبت:** PROD/PACK تا Accept شدن `docs/architecture/ADR-007-FABRIC-ROLL.md`

## چه چیزی در این نوبت سخت می‌شود

موج‌های Stitch که قبلاً روی ایران رفته‌اند: ACC-01..06، OPS-01، HR-02، INV-02/03، TRS-01/02، CON-01/02، POS-01/02، LED-01، به‌علاوه **POS-03** همین شاخه.

## Gates (اجرا با `node server/scripts/run-stitch-phase8-gates.js`)

| Gate | فرمان | هدف |
|---|---|---|
| POS-01/02 | `test-pos-stitch-p8.js` | ترمینال، در راه، تسویه، R13 |
| POS-03 | `test-pos-03-report.js` | گزارش + آشتی GL |
| LED-01 | `test-led-stitch-p9.js` | دفتر مشترک |
| SMS | `test-sms.js` | رگرسیون پیامک |
| Encoding | `check-ui-encoding.js` | UTF-8 فارسی |
| Static | `node --check` server + app.js | نحو |
| Parse | `new Function` روی `app.js` | فرانت |
| Format | `git diff --check` | فاصله انتهایی |

`test:production` و prepare+compare embedded در این نوبت **اختیاری** هستند مگر مالک برای merge بخواهد؛ طبق Wave 0 تا Gate کامل، Deploy ایران جداگانه است.

## Visual / a11y / RTL (چک‌لیست دستی — خودکار نیست)

- [ ] Light و Dark روی `acc-pos-report` و `acc-pos-devices`
- [ ] Desktop ~1440 و Mobile ~360
- [ ] Print فاکتور همچنان روشن و بدون chrome
- [ ] Focus قابل‌دیدن؛ کنترل‌ها حداقل ۴۴px لمس
- [ ] متن فارسی/RTL بریده نشود

## Reconciliation که تست خودکار می‌پوشاند

- POS-03: وجوه در راه = مانده باز دریافت؛ خالص دسته = سند بانک `ref_type=pos_batch`
- Cutoff یک روز قبل از تسویه: بانک افزایش نیافته؛ در راه مانده است (سناریو ۹ Master Prompt)

## Migration rehearsal

POS-03 جدول جدید ندارد. ADR-007 هنوز schema ندارد. rehearsal طاقه بعد از Accept.

## Deploy

ممنوع تا Independent + Security APPROVED و تأیید جداگانه مالک.
