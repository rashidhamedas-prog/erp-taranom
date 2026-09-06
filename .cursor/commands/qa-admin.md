---
description: Run isolated Admin QA batch on a temp DB and print the artifact summary. No production, no deploy.
---

# qa-admin

From repo root (QA worktree):

```
set NODE_ENV=test
node scripts/qa/run-admin-qa.js
```

Windows: `scripts\qa\run-admin-qa.cmd`

npm: `npm.cmd --prefix server run qa:admin`

Fail-closed: temp DB only, `ERP_TEST_ISOLATION=1`, loopback, SMS/Moadian disabled.

Artifacts: `artifacts/qa/<QA_RUN_ID>/summary.md`

Do not deploy. Do not point DB_PATH at production.
