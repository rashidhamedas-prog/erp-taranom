# Domain Host (Node) — فاز ۱ invoke

## اجرا

```powershell
node win-native/DomainHost/host-main.js
```

پیش‌فرض Windows: `\\.\pipe\erp-taranom-domain`  
Runtime داخلی فقط روی `127.0.0.1` (بدون UI محصول).

## فرمان‌ها

| command | نقش |
|---|---|
| `ping` / `version` / `schema.hash` / `contract.hash` / `brand.get` | متادیتا |
| `runtime.start` / `status` / `stop` | موتور Express داخلی |
| `auth.login` / `logout` / `me` | نشست Host |
| `api.call` | `{ sessionId, method, path, body, idempotencyKey? }` |

## تست

```powershell
node win-native/DomainHost/scripts/test-pipe-ping.js
node win-native/DomainHost/scripts/test-invoke-slice.js
```

WPF: `win-native/Taranom.App/` (نیاز به .NET 8 SDK).
