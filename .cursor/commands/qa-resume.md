---
description: Resume a full QA run from the last artifact pointer. Does not target production.
---

# qa-resume

```
node scripts/qa/run-resume.js
```

Starts a new isolated temp DB (idempotent). `--resume` is accepted; passing tests from a prior artifact are informational. Prefer a fresh full run after product fixes.
