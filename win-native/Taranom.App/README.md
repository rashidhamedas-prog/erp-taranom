# Taranom.App — اسکلت WPF (.NET 8)

پیش‌نیاز: [.NET 8 SDK](https://dotnet.microsoft.com/download/dotnet/8.0)

```powershell
# ترمینال ۱
node win-native/DomainHost/host-main.js

# ترمینال ۲
cd win-native/Taranom.App
dotnet run
```

پنجره فقط Brand + وضعیت Host را از Named Pipe می‌خواند. نوشتن دامنه در مرحلهٔ بعد از `api.call` روی همان کلاینت انجام می‌شود.
