# win-native — اسکلت محصول بومی ویندوز

مسیر نهایی UI طبق [`docs/architecture/NATIVE-WINDOWS-DECISIONS-LOCKED.md`](../docs/architecture/NATIVE-WINDOWS-DECISIONS-LOCKED.md):

- **WPF (.NET 8)** برای رابط
- **Domain Host** (Node headless، Named Pipe) مالک SQLite
- Electron فقط پل تجاری موقت در `desktop/`

## ساختار هدف

```
win-native/
  DomainHost/          ← Node: بدون public UI؛ pipe + همان server logic
  Taranom.App/         ← WPF (فاز بعد)
  Taranom.Application/
  Taranom.Domain/      ← پورت تدریجی C# با golden parity
  branding/            ← symlink/copy از /branding/<brandId>
```

## فاز فعلی (۰→۱)

- قرارداد + schema hash + drift gate + golden-vertical
- Brand Pack: `branding/taranom/brand.json`
- Host stub با Named Pipe: `win-native/DomainHost/host-main.js`

```powershell
node scripts/native/check-drift.js
node scripts/native/run-golden-fixtures.js
node win-native/DomainHost/scripts/test-pipe-ping.js
node win-native/DomainHost/host-main.js
```

بیلد installer بومی هنوز شروع نشده — تا تکمیل invoke دامنه و اسکلت WPF.