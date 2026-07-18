# یک‌بار اجرا کنید — آپلود نسخه دسکتاپ به GitHub Releases
# پیش‌نیاز: نصب GitHub CLI از https://cli.github.com

$ErrorActionPreference = "Stop"
$Root = Split-Path $PSScriptRoot -Parent
$Version = (Get-Content "$Root\desktop\package.json" | ConvertFrom-Json).version
$Tag = "v$Version"
$Exe = "$Root\desktop\dist\CRM Taranom Setup $Version.exe"
$Yml = "$Root\server\public\releases\latest.yml"

Write-Host "نسخه: $Version" -ForegroundColor Cyan

if (-not (Test-Path $Exe)) {
  Write-Host "فایل نصب یافت نشد. اول بسازید:" -ForegroundColor Yellow
  Write-Host "  cd desktop" 
  Write-Host "  npm run dist:win"
  exit 1
}

$mb = [math]::Round((Get-Item $Exe).Length / 1MB, 1)
Write-Host "فایل نصب: $mb MB" -ForegroundColor Green

Write-Host "`nمرحله ۱: ورود به GitHub (فقط یک‌بار لازم است)" -ForegroundColor Cyan
gh auth status 2>$null
if ($LASTEXITCODE -ne 0) {
  gh auth login
}

Write-Host "`nمرحله ۲: ساخت Release روی GitHub" -ForegroundColor Cyan
gh release create $Tag `
  $Exe `
  $Yml `
  --repo rashidhamedas-prog/crm-taranom `
  --title "CRM Taranom Desktop $Version" `
  --notes "رفع crash راه‌اندازی (rep_territories) + بهبودهای 1.0.6"

if ($LASTEXITCODE -eq 0) {
  Write-Host "`n✅ تمام! لینک دانلود:" -ForegroundColor Green
  Write-Host "https://github.com/rashidhamedas-prog/crm-taranom/releases/tag/$Tag"
} else {
  Write-Host "`n❌ خطا — اگر release از قبل وجود دارد:" -ForegroundColor Red
  Write-Host "gh release upload $Tag `"$Exe`" `"$Yml`" --repo rashidhamedas-prog/crm-taranom --clobber"
}
