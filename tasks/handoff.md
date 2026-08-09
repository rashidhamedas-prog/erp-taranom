# Handoff

## هدف اصلی
Deploy امن `sharp@0.35.0` روی VPS ایران بدون خراب کردن production یا درخت‌های کثیف.

## کارهای انجام‌شده
- worktree/branch تسک از `origin/claude/claude-md-docs-2ssrpy` ساخته شد.
- `scripts/deploy-sharp-production.ps1` با inventory، باندل آفلاین، backup، swap، rollback و CPU preflight اضافه شد.
- باندل Linux x64 ساخته و دو بار apply آزمایشی روی VPS انجام شد؛ هر دو قبل از restart شکست و restore شدند.
- inventory dirty VPS ثبت شد؛ هیچ pull/reset/clean کوری انجام نشد.

## وضعیت فعلی
**blocked** روی microarchitecture. production: `sharp@0.33.5` سالم، HTTP 200، PM2 online.

## تست‌ها / شواهد واقعی
- Inventory: HEAD `6390bcc`, dirty docs/app/releases/sw + untracked recover/key/broken APK.
- Apply fail: missing `detect-libc` (رفع شد در باندل) سپس `Unsupported CPU ... v2 microarchitecture`.
- CPU flags missing: `popcnt sse4_1 sse4_2 ssse3`.
- Final health: PKG/RT `0.33.5`, REQUIRE_OK, root/health 200.

## ریسک باقی‌مانده
- Advisory `sharp <0.35.0` روی runtime production تا ارتقای CPU یا waiver رسمی باقی است.
- VPS و `erp-taranom1` همچنان dirty هستند؛ reconcile جدا لازم است.

## مرحله دقیق بعدی
ارتقای CPU مهمان به x86-64-v2/host → `-Deploy` → pull/drill بکاپ → approval مستقل reviewer/security.
