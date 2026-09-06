---
description: Take the highest-severity open QA failure, write a regression test, and fix it in a child task/claim. Independent Reviewer+Security for High/Critical product fixes.
---

# qa-fix

1. Read `artifacts/qa/_latest.json` and `issues.json`.
2. Pick the first Critical, else High, else Medium.
3. Create a **child task** with its own file_claims on product files (this QA task must not edit `server/routes` / `server/public` / `server/db.js`).
4. Add a failing regression test first.
5. Apply the smallest fix.
6. Re-run `node scripts/qa/run-full-erp-qa.js` (and the targeted unit test).
7. High/Critical: Independent Reviewer + Security ≠ Implementer before close.
8. Do not weaken assertions to force PASS. Do not deploy.
