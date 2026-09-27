# Domain Host (Node) — اسکلت

Host محلی بدون UI وب. فقط:

1. بارگذاری Brand Pack (`branding/<id>/brand.json`)
2. باز کردن SQLite در `%ProgramData%\<brand.paths.programData>\`
3. اجرای منطق دامنه / Express **بدون** سرو کردن `server/public` به‌عنوان محصول
4. گوش‌دادن روی **Named Pipe** (نه ارائهٔ سایت به کاربر)
5. SyncWorker در پس‌زمینه (همان `server/sync/client.js`)

## قیدها

- UI WPF هرگز مستقیم DB نمی‌نویسد.
- کانال pipe با ACL کاربر جاری + توکن نشست.
- تا استخراج Application Service، پل موقت IPC→handlers مجاز است؛ HTTP loopback فقط داخلی Host، نه پنجرهٔ محصول.

## بعدی

پیاده‌سازی `host-main.js` + پروتکل `Invoke(command, payload, idempotencyKey)` پس از سبز شدن schema_hash و OPERATION-CONTRACT در CI.
