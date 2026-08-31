---
description: Print the latest QA run summary in at most 20 lines.
---

# qa-report

```
node scripts/qa/run-report.js
```

Reads `artifacts/qa/_latest.json` → `summary.md` + issue counts. No DB mutation.
