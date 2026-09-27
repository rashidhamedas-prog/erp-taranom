# طرح فازبندی — Android بومی فروشندگان

> والد: [`NATIVE-ANDROID-SALES-ARCHITECTURE.md`](./NATIVE-ANDROID-SALES-ARCHITECTURE.md)  
> ماتریس: [`NATIVE-ANDROID-SALES-MATRIX.md`](./NATIVE-ANDROID-SALES-MATRIX.md)  
> Claim: [`NATIVE-ANDROID-TASK-CLAIM.md`](./NATIVE-ANDROID-TASK-CLAIM.md)

## فاز ۰ — انجماد معماری (فعلی)

1. ADR-AND-001 نوشته و در انتظار تأیید مالک (§۱۴ معماری).
2. ماتریس فروش اولیه از RBAC + inventory.
3. Worktree `ai/ANDROID-NATIVE-SALES` + claim بدون دست‌زدن به فایل‌های DESKTOP.
4. ثبت شکاف‌های sync مشترک (ارجاع به NATIVE-WINDOWS-SYNC-GAPS).
5. فهرست مسدودکننده: keystore ops، دستگاه آزمون، آزادسازی AI-DOS registry.

**خروج:** تأیید مالک روی ADR → شروع اسکلت.

## فاز ۱ — اسکلت + برش عمودی

```
مشتری ← سبد/سفارش ← محاسبات محلی ← outbox اتمیک ← قطع/وصل ← پذیرش مرکز ← مشاهده وب/دسکتاپ
```

تحویل‌ها:
- ماژول Gradle `android-native/` (app + core + feature:customers/cart + sync stub)
- DB migration v1 + SecureStore
- Golden parity برای VAT/جمع/qty
- Sync client حداقل push سفارش + pull مشتری
- بدون WebView در مسیر اصلی
- Air-gap روی slice

## فاز ۲ — CRM میدانی + کاتالوگ

پیگیری، برنامه روزانه، ویزیت/تماس (بدون ضبط مکالمه)، کاتالوگ+تصویر، variant، پیش‌نویس پایدار.

## فاز ۳ — اسناد مالی فروش محدود

فاکتور/برگشت/وصول طبق RBAC؛ شماره موقت؛ UX تعارض؛ R13 مسیرهای مجاز موبایل.

## فاز ۴ — گزارش، backup، updater

گزارش شخصی، export/restore امن بدون تکثیر device identity، updater امضاشده، ماتریس دستگاه.

## فاز ۵ — مهاجرت از nodejs-mobile

Migrator داده+outbox، ارتقا in-place، بازنشستگی WebView به‌عنوان محصول، نگهداشت کوتاه legacy flavor در صورت نیاز پشتیبانی.

## جریان‌های موازی پیشنهادی (ایجنت‌ها)

| جریان | تمرکز | مدل پیشنهادی |
|---|---|---|
| Architect | ADR/ماتریس/فازبندی | thinking-high |
| Domain/Parity | fixture + Kotlin calc | GPT/Claude دقیق |
| Sync client | wire protocol Kotlin | Opus thinking |
| UI Compose | RTL فروش | UI-focused |
| Security | Keystore/backup/updater | security جدا |
| Legacy migrate | خواندن DB قدیمی | implementer |

هیچ جریانی `desktop/**` یا فایل‌های claimشدهٔ DESKTOP را لمس نمی‌کند. تغییر `server/sync/**` فقط با claim جدا.
