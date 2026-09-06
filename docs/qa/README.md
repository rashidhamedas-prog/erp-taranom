# QA Harness — ERP ترنم

ایزوله، fail-closed، بدون Production و بدون Deploy.

## پیش‌نیاز

- Node.js روی Windows
- `npm.cmd --prefix server install --omit=dev` (یک‌بار در worktree)
- اختیاری E2E: `npm.cmd --prefix e2e install` سپس Playwright browser

## اجرا

از ریشهٔ worktree:

```bat
set NODE_ENV=test
scripts\qa\run-admin-qa.cmd
scripts\qa\run-all-roles-qa.cmd
scripts\qa\run-full-erp-qa.cmd
scripts\qa\run-report.cmd
```

PowerShell معادل `*.ps1`. npm از پوشهٔ `server`:

```bat
npm.cmd --prefix server run qa:admin
npm.cmd --prefix server run qa:roles
npm.cmd --prefix server run qa:full
npm.cmd --prefix server run qa:report
```

## Exit codes

| Code | معنی |
|------|------|
| 0 | PASS |
| 1 | Functional / invariant |
| 2 | Harness / config / fail-closed |
| 3 | Security / RBAC |

## ایمنی

- فقط DB موقت زیر `os.tmpdir()/erp-qa-*` با `ERP_TEST_ISOLATION=1`
- اگر `DB_PATH` / URL شبیه Production باشد فرایند با کد ۲ خارج می‌شود
- SMS و Moadian خاموش؛ `SYNC_ROLE=central`؛ loopback
- Failure → DB حفظ می‌شود (`artifacts/qa/<id>/db-path.json`)
- Success + `--cleanup-on-success` → پاک‌سازی tmp
- پاک‌سازی دستی: `node scripts/qa/run-clean.js --yes`

## Artifact

`artifacts/qa/<QA_RUN_ID>/`: `summary.md`, `issues.json`, `junit.xml`, `reconciliation.json`, `inventory.json`, `screenshots/`, `logs/`

نقش‌ها از `Object.keys(DEFAULT_ROLE_PERMISSIONS)` کشف می‌شوند (اجازهٔ واقعی با `fillRoleDefaults` مثل runtime).

قابلیت غایب: `NOT_IMPLEMENTED` / `BLOCKED` — نه PASS دروغین.

اولین full run: `docs/qa/FIRST-RUN.md` — exit 3 به‌خاطر High محصول؛ harness crash نیست.

## CI

Job جدا، روی temp DB، بدون secret پروداکشن. Playwright اختیاری (`--skip-e2e` اگر browser نباشد).

## Fix

باگ محصول در Task/Claim جدا. High/Critical نیازمند Reviewer و Security مستقل. این harness فایل‌های `server/routes` و `server/public` را تغییر نمی‌دهد.
