# GA بومی دسکتاپ — وضعیت و باقی‌مانده

تاریخ: ۱۴۰۵/۰۷/۰۵ · SW وب: erp-taranom-v253

## آماده

| جزء | وضعیت |
|---|---|
| Electron پل ۲.۰.۱۳ | ✅ قابل تحویل تجاری (`D:\proje\ERP EXE`) |
| Domain Host 0.3 Named Pipe | ✅ |
| WPF shell (ورود، مشتری، کالا، فاکتور+پیش‌فاکتور سریع، انبار، گزارش، مهاجرت، بکاپ، sync) | ✅ سورس + بیلد Release |
| Migration Wizard Electron→native | ✅ |
| fixtures + waves 2–10 + airgap checklist | ✅ `run-all-gates.js` |
| بستهٔ stage native | ✅ `D:\proje\ERP EXE\native\TaranomNative\` (WPF + Host + portable .NET shared runtime) |
| `build/start/install-native-desktop.ps1` | ✅ |

## باقی تا GA کامل (جایگزینی Electron)

1. **MSI/NSIS امضا‌شده OV** برای native (الان stage پوشه‌ای + Start Menu script)
2. **کانال update بومی** (Velopack یا معادل) جدا از electron-updater
3. **عمیق‌سازی WPF** (فرم فاکتور کامل، چک، BOM، …)
4. **air-gap ۱۲گامی** روی installer امضا روی VM تمیز (گام ۱)
5. **موج ۱۱:** Electron فقط‌خواندنی / بازنشستگی پس از Migration موفق در میدان

## فرمان‌ها

```powershell
node scripts/native/run-all-gates.js
node scripts/native/run-airgap-checklist.js
powershell -File scripts/native/build-native-desktop.ps1
powershell -File "D:\proje\ERP EXE\native\TaranomNative\start-native-desktop.ps1"
```
