---
description: Delete only the resolved QA artifact directory and temp DB after explicit --yes. Fail-closed against production paths.
---

# qa-clean

```
node scripts/qa/run-clean.js --yes
```

Deletes `artifacts/qa/<last QA_RUN_ID>` and the tmp DB recorded in `db-path.json` only if paths are under os.tmpdir `erp-qa-*` or `artifacts/qa`. Refuses production-like paths. Requires `--yes`.
