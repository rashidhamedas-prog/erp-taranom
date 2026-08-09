# Task فعال

## شناسه
W0-OPS-002

## عنوان
Deploy امن `sharp@0.35.0` روی production و ثبت شواهد

## هدف
اعمال pin سورس (`0.35.0`) روی runtime VPS با timeout/rollback/smoke، بدون pull/reset کور روی درخت‌های کثیف.

## محدوده مجاز
- worktree: `D:/soft/Claud/porje/Run in the project/erp-taranom-w0-ops-002`
- branch: `ai/W0-OPS-002-sharp-production-deploy`
- فایل‌های `file_claims` در `.ai-dos/tasks/active.yaml`
- عملیات VPS فقط برای dependency deploy کنترل‌شده + smoke/backup شواهد

## خارج از محدوده
- blind `git pull`/`reset`/`clean` روی VPS یا `erp-taranom1`
- rebuild APK/EXE، restore مخرب، Waves 1–4
- افشا/چرخش secrets

## وضعیت
**blocked** — CPU مهمان فاقد x86-64-v2 است؛ native/wasm `sharp@0.35.0` قابل اجرا نیست. production سالم روی `0.33.5`.

## شواهد blocker
- Model: `QEMU Virtual CPU version 2.5+`
- Missing flags: `popcnt sse4_1 sse4_2 ssse3`
- Error: `Unsupported CPU: Prebuilt binaries for Linux x64 require v2 microarchitecture`
- Post-attempt: `PKG=0.33.5` `RT=0.33.5` HTTP 200

## مرحله بعدی
1. مالک/infra نوع CPU hypervisor را ارتقا دهد.
2. `scripts/deploy-sharp-production.ps1 -Deploy`
3. backup pull + restore drill + reviewer/security
