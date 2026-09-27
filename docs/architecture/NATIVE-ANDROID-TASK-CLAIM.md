# Task claim — ANDROID-NATIVE-SALES

> تاریخ: ۱۴۰۵/۰۷/۰۵ (2026-09-27)  
> Owner: `cursor:android-native-sales`  
> Branch: `ai/ANDROID-NATIVE-SALES`  
> Worktree: `D:/proje/erp-taranom-android-native`

## وضعیت هم‌زمانی AI-DOS

تسک `DESKTOP-EXE-DELIVER` هنوز در `.ai-dos/tasks/active.yaml` با وضعیت `in_progress` است و این فایل‌های مشترک را claim کرده:

- `.ai-dos/tasks/active.yaml`
- `.ai-dos/tasks/handoff.md`
- `.ai-dos/project/status.md`
- `docs/CHANGE-LOG.md`
- چند فایل `desktop/**` و `server/public/{app.js,sw.js}`

طبق قرارداد AI-DOS، این تسک Android **آن فایل‌ها را ویرایش نمی‌کند** تا claim دسکتاپ آزاد شود. ثبت این claim در همین فایل انجام می‌شود.

## File claims (این تسک)

| مسیر | نقش |
|---|---|
| `docs/architecture/NATIVE-ANDROID-*.md` | معماری، ماتریس، ADR، فازبندی، claim |
| `android-native/**` | اپلیکیشن بومی Kotlin جدید (محصول هدف) |
| `shared/sales-parity/**` | fixtureهای طلایی مشترک محاسبات (در صورت ایجاد) |
| `scripts/build-android-native*.ps1` | بیلد بومی (در صورت ایجاد) |

## عمداً خارج از claim (هماهنگی بعدی)

| مسیر | دلیل |
|---|---|
| `android/**` (nodejs-mobile فعلی) | تا مسیر مهاجرت آماده نشود حذف/بازنویسی wholesale نمی‌شود؛ تغییرات مهاجرتی با claim جدا |
| `server/sync/**`, `server/routes/sync.js` | مالک مشترک؛ فقط پس از ADR و handoff صریح |
| فایل‌های claimشدهٔ `DESKTOP-EXE-DELIVER` | ممنوع تا آزادسازی |

## Acceptance (Wave 0 — معماری)

- سند معماری پیاده‌سازی‌پذیر با ADR، غیر اهداف، ماتریس فروش، sync سازگار، امنیت، updater، air-gap
- هم‌راستایی صریح با `NATIVE-WINDOWS-*` برای پروتکل sync (نه پروتکل جدا)
- رد صریح WebView/nodejs-mobile localhost به‌عنوان محصول نهایی
- گزارش مسدودکننده‌ها: کلید امضا، دستگاه آزمون، رجیستری AI-DOS مشترک

## Non-goals (Wave 0)

- آپلود APK به Iran VPS / انتشار عمومی بدون مجوز مالک
- حذف APK فعلی nodejs-mobile قبل از مسیر مهاجرت
- ویرایش `desktop/**`
- ضبط مکالمه / ردیابی دائمی GPS بدون نیاز صریح
