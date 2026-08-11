# Handoff

## هدف اصلی
بستن follow-up sharp production پس از Wave 0 Gate.

## وضعیت
**تمام.** مالک waiver دائمی بدون انقضا پذیرفت: runtime production = `sharp@0.33.5`؛ سورس/CI = `0.35.0`.

## موج صفر
Gate کامل؛ W0-OPS-001 و W0-OPS-002 بسته‌اند. آمادهٔ شروع P1.

## نکات برای عامل بعدی (P1)
- شاخهٔ پایه: `claude/claude-md-docs-2ssrpy` پس از merge این کار.
- VPS و `erp-taranom1` ممکن است dirty باشند — بدون pull/reset کور.
- اسکریپت اختیاری آینده: `scripts/deploy-sharp-production.ps1` بعد از ارتقای CPU.
- قانون `auto-commit-deploy.mdc` هنوز با `--update-env`/blind pull در تعارض است؛ قبل از deploy خودكار ایران اصلاح/استثنا ثبت شود.
