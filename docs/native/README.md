# artifacts فاز ۰ — دسکتاپ بومی

| فایل | نقش |
|---|---|
| [`OPERATION-CONTRACT.md`](./OPERATION-CONTRACT.md) / [`.json`](./OPERATION-CONTRACT.json) / [`.sha256`](./OPERATION-CONTRACT.sha256) | قرارداد مسیر→جدول + blocklist + فضای id |
| [`schema.v1.sql`](./schema.v1.sql) / [`schema.v1.sha256`](./schema.v1.sha256) / [`schema.v1.meta.json`](./schema.v1.meta.json) | snapshot اسکیما از `initDBOn` |
| [`AIRGAP-CHECKLIST.md`](./AIRGAP-CHECKLIST.md) | پذیرش ۱۲گامی بدون شبکه |

## تولید دوباره

```powershell
node scripts/native/generate-operation-contract.js
node scripts/native/schema-hash.js   # Node 20؛ در صورت نیاز از .tools/node20
```

CI باید پس از تغییر `capture.js` / `tables.js` / `db.js` این خروجی‌ها را دوباره بسازد و روی diff خالی assert کند.

Brand Pack: `branding/taranom/brand.json`  
اسکلت Host: `win-native/`
