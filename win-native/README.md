# win-native — اسکلت محصول بومی ویندوز

مسیر نهایی UI طبق [`docs/architecture/NATIVE-WINDOWS-DECISIONS-LOCKED.md`](../docs/architecture/NATIVE-WINDOWS-DECISIONS-LOCKED.md):

- **WPF (.NET 8)** برای رابط
- **Domain Host** (Node headless، Named Pipe) مالک SQLite
- Electron فقط پل تجاری موقت در `desktop/`

## ساختار

```
win-native/
  DomainHost/          ← Node Host v0.2: pipe + runtime داخلی 127.0.0.1
  Taranom.App/         ← اسکلت WPF (.NET 8) + DomainPipeClient
  branding/            ← از /branding/<brandId>
```

## فاز فعلی (۰→۱)

- Host **v0.2:** `auth.*` + `api.call` + idempotency
- fixtures: golden-vertical + print-smoke
- WPF shell (نیاز به .NET 8 SDK برای `dotnet run`)

```powershell
node scripts/native/check-drift.js
node scripts/native/run-golden-fixtures.js
node scripts/native/run-print-fixtures.js
node win-native/DomainHost/scripts/test-invoke-slice.js
node win-native/DomainHost/host-main.js
```

SyncWorker و air-gap هنوز باز است.
