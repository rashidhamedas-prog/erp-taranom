# artifacts فاز ۰ — دسکتاپ بومی

| فایل | نقش |
|---|---|
| [`OPERATION-CONTRACT.md`](./OPERATION-CONTRACT.md) / [`.json`](./OPERATION-CONTRACT.json) / [`.sha256`](./OPERATION-CONTRACT.sha256) | قرارداد مسیر→جدول + blocklist + فضای id |
| [`schema.v1.sql`](./schema.v1.sql) / [`schema.v1.sha256`](./schema.v1.sha256) / [`schema.v1.meta.json`](./schema.v1.meta.json) | snapshot اسکیما از `initDBOn` |
| [`fixtures/golden-vertical.*`](./fixtures/) | برش عمودی مشتری→فاکتور→R13 |
| [`WAVE-MATRIX.md`](./WAVE-MATRIX.md) | موج‌های ۰→۱۱ از inventory |
| [`AIRGAP-CHECKLIST.md`](./AIRGAP-CHECKLIST.md) | پذیرش ۱۲گامی بدون شبکه |

## تولید دوباره

```powershell
node scripts/native/generate-operation-contract.js
node scripts/native/schema-hash.js
node scripts/native/check-drift.js          # CI gate
node scripts/native/run-golden-fixtures.js  # Node 20
node win-native/DomainHost/scripts/test-pipe-ping.js
```