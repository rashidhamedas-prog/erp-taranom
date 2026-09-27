# Domain Host (Node) — فاز ۱ stub

## اجرا

```powershell
# از ریشهٔ مخزن، با Node 20:
node win-native/DomainHost/host-main.js
```

پیش‌فرض Windows: `\\.\pipe\erp-taranom-domain`  
متغیرها: `ERP_BRAND_ID`, `ERP_HOST_PIPE`

## پروتکل

خط‌به‌خط JSON (NDJSON). فرمان‌های فعلی:

| command | نتیجه |
|---|---|
| `ping` | `{ pong, ts }` |
| `version` | نسخه Host |
| `schema.hash` | SHA اسکیما از `docs/native/` |
| `contract.hash` | SHA قرارداد عملیات |
| `brand.get` | Brand Pack |

## تست دود

```powershell
node win-native/DomainHost/scripts/test-pipe-ping.js
```

## بعدی

- `invoke` دامنه از طریق همان handlers سرور (بدون سرو کردن `public/` به کاربر)
- SyncWorker پس‌زمینه
- ACL pipe برای کاربر جاری + توکن نشست
- UI WPF فقط از این کانال می‌نویسد
