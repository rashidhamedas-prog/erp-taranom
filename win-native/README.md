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

## فاز فعلی (۰)

- قرارداد عملیات: `docs/native/OPERATION-CONTRACT.*`
- schema hash: `docs/native/schema.v1.*`
- Brand Pack: `branding/taranom/brand.json`
- Host stub: `win-native/DomainHost/README.md`

## فرمان‌های فاز ۰

```powershell
node scripts/native/generate-operation-contract.js
node scripts/native/schema-hash.js
```

بیلد installer بومی هنوز شروع نشده — تا دستور صریح مالک و تکمیل فاز ۱.
