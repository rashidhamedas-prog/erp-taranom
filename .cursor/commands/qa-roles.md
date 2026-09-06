---
description: Run All-Roles RBAC matrix against discovered DEFAULT_ROLE_PERMISSIONS. Isolated temp DB.
---

# qa-roles

```
set NODE_ENV=test
node scripts/qa/run-all-roles-qa.js
```

Roles are discovered at runtime from `Object.keys(DEFAULT_ROLE_PERMISSIONS)`, not a hardcoded list.

Matrix: role × endpoint × action × expected × actual.

Exit 3 if unexpected allow/deny on security probes.
