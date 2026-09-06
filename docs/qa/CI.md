# QA harness — local and CI

Isolated Admin + All-Roles runner. **No production DB, no VPS, no real SMS/Moadian, no deploy.**

## Local (Windows worktree)

```bat
cd /d "D:\soft\Claud\porje\Run in the project\erp-taranom-qa-erp-full-cycle"
set NODE_ENV=test
npm.cmd --prefix server install --omit=dev
scripts\qa\run-admin-qa.cmd
scripts\qa\run-all-roles-qa.cmd
scripts\qa\run-full-erp-qa.cmd --skip-e2e
scripts\qa\run-report.cmd
```

E2E (optional, existing Playwright in `e2e/`, no new package):

```bat
npm.cmd --prefix e2e install
cd e2e && npx.cmd playwright install chromium
set NODE_ENV=test
node scripts\qa\run-full-erp-qa.js
```

Resume is a fresh isolated run (`--resume` flag is recorded; DB is always new).

Cleanup after reviewing artifacts:

```bat
node scripts\qa\run-clean.js --yes
```

## CI job (separate from production deploy)

- `NODE_ENV=test`
- Unique `QA_RUN_ID`
- Never set `DB_PATH` to `server/crm.db` or a VPS path (fail-closed exit 2)
- Upload `artifacts/qa/<QA_RUN_ID>/` (junit.xml, summary.md, issues.json)
- Treat exit **3** as security gate; **1** as functional/invariant; **2** as harness misconfig
- Do **not** declare the suite PASS while Critical/High product issues remain
- Product fixes: child task + independent Reviewer/Security for High/Critical

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | PASS |
| 1 | Functional / invariant |
| 2 | Harness / config / fail-closed |
| 3 | RBAC / security |
