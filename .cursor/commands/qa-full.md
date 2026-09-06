---
description: Run Admin + All-Roles + E2E + reconciliation on an isolated temp DB. No production deploy.
---

# qa-full

```
set NODE_ENV=test
node scripts/qa/run-full-erp-qa.js
```

Optional: `--skip-e2e` `--cleanup-on-success`

Exit: 0 PASS, 1 functional/invariant, 2 harness/config, 3 RBAC/security.

Do not declare PASS while Critical/High issues remain.
