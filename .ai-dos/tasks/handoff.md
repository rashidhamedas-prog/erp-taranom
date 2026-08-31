## 2026-08-31T23:55:00+03:30 — OPS pack v179 (cash-flow / cheque / warehouse / nav / fabric)

- Cash-flow: isolated builder, never 500 on null/empty `account_code`; all cash/bank codes.
- Cheque واگذاری requires collection bank; status واگذارشده; endorse writes supplier_ledger + FK remap cols.
- Invoice header warehouse copies to new/changed lines; fabric rolls as invoice rows (sale consume / purchase identity, no second JE).
- Acc nav operations: only «فاکتورهای فروش».
- Fabric amount = meters × unit; PATCH edit while unused.
- SW v179. Do not commit dirty `_deploy-demo-ui-v156`, `_deploy-mdi-v152`, `_diag-moein-ledger*`.
- Iran overlay next.

## 2026-08-31T19:20:00+03:30 — CRM customer list uses same GL net as statement

- CRM list / dashboard balances still showed Moein 99,999,000 creditor (raw customer_ledger; repair only on accounting).
- Overlay GL tafsili on customer APIs; run repair on GET /customers. Footer/cards net debit vs credit (larger side wins).
- SW v178. Tests 20/20. Iran overlay ✅ `c4adf5e` health 200.

## 2026-08-31T18:50:00+03:30 — Customer statement / red ledger warnings

- **Branch:** `fix/LEDGER-STATEMENT-AR` (workspace `erp-taranom1`)
- **Root:** firm cash invoices skipped `customer_ledger` + customer tafsili; dashboard AR used `1103%` (party openings on control). Moein Mehdizadeh T-0003 cash + settlement-3 looked like 100M creditor; T-0004 unapproved stayed off the book until attach/repair.
- **Fix:** `server/lib/customer-books.js` — always post AR; repair v1; KPI = customer tafsili sum. Help + SW v177.
- **Tests:** statement-repair 14, stitch-p2 79, sms 22, sync 44.
- **Do not commit:** dirty `scripts/_deploy-demo-ui-v156-sftp.py`, `_deploy-mdi-v152-sftp.py`, `_diag-moein-ledger*.py`.
- **Iran:** overlay v177 ✅ health/ready/root 200 @ `1788d1b`. Repair runs on first overview/statement.

## 2026-08-31T15:20:00+03:30 — Git hygiene + leftover PACK merge

- Audited all worktrees. Only real unmerged product: `ai/PROD-STITCH-PACK` (`aa2367b`+`cb10268`).
- Cherry-picked onto Primary `12b0385` as `ai/PROD-STITCH-PACK-MERGE`. SW v176. `sync_seq_backfill_v13`.
- Kept `UI-STITCH-P0-DISCOVERY` closed (0 unique commits). Did not commit truncated `app.js`. No Iran `git pull`.
- Primary FF `fbf157e`. Iran overlay v176 ✅ health/ready/root 200. PACK 48/48.

## 2026-08-31T14:55:00+03:30 — UI-DOCS-STITCH / P0 claim closed

- **Owner:** close leftover docs branch; nothing product-open on `ai/UI-DOCS-STITCH`.
- **Facts:** local branch had 0 unique commits, never pushed, 102 behind Primary. P0 map + Stitch ZIPs lived only as untracked `artifacts/`.
- **Done:** discarded stale local AI-DOS edits on the old tip; workspace now on `chore/UI-DOCS-STITCH-close` @ Primary `fd47e86`. `UI-STITCH-P0-DISCOVERY` → `completed`, `file_claims: []`. `/artifacts/` gitignored (files stay on disk). Local `ai/UI-DOCS-STITCH` deleted.
- **Untouched:** `scripts/_deploy-demo-ui-v156-sftp.py`, `scripts/_deploy-mdi-v152-sftp.py`.
- **No Iran deploy / no product code.**

## 2026-08-31T14:40:00+03:30 — QA product gaps closed + Iran v175

- RFQ sales/purchase, PO, GR+GRNI (2112), GR invoice, three-way match, SOD maker-checker, branch ACL, order reservation.
- qa:full `qa-20260831T105600-14704` PASS 268 · FAIL 0 · NOT_IMPLEMENTED 0.
- Primary FF `9151483` (کد قابلیت `a75ed64` + مهر docs). Iran overlay v175 ✅ health/ready/root 200. `QA-ERP-GAPS-NOT-IMPLEMENTED` completed. بدون merge شاخه‌های غیرمرتبط (UI-STITCH / PACK).

## 2026-08-31T14:15:00+03:30 — Primary + Iran v174 done

- **Primary FF:** `dbd86fc..f3318bb` on `origin/claude/claude-md-docs-2ssrpy`
- **Iran:** overlay public SW v174 + surgical backup-restore; health/ready/root 200. No db.js.
- **Next product children (do not fake PASS):** RFQ → 3-way → GRNI → SOD → branch ACL → reservation on POST /orders.

## 2026-08-31T14:10:00+03:30 — Gaps coverage + backup verify; merge to Primary

- **Task:** `QA-ERP-GAPS-NOT-IMPLEMENTED` + child `QA-ERP-GAPS-BACKUP-VERIFY-EXT`
- **qa:full:** `qa-20260831T103426-14980` PASS 258 FAIL 0 ERROR 0 · 11 product gaps remain
- **Closed coverage:** reservation API, fabric kind=fabric, backup verify (multer dest now keeps .zip)
- **Still NOT_IMPLEMENTED:** RFQ, 3-way, GRNI, SOD, branch ACL, reservation-on-legacy-orders
- **SW v174.** Owner asked merge to Primary. Iran overlay without db.js.
- **erp-taranom1 / UI-STITCH:** untouched

## 2026-08-31T13:50:00+03:30 — QA-ERP-GAPS claimed; backup create/list/health covered

- **Task:** `QA-ERP-GAPS-NOT-IMPLEMENTED` on `ai/QA-ERP-GAPS-NOT-IMPLEMENTED`
- **Worktree:** `D:/soft/Claud/porje/Run in the project/erp-taranom-qa-gaps` from Primary `dbd86fc`
- **Coverage:** Admin batch now hits `/admin/backup-health`, `/admin/backup-now`, `/admin/backups`. Restore stays NOT_IMPLEMENTED (destructive mid-run).
- **Still product gaps:** RFQ, 3-way match, GRNI, SOD/maker-checker, branch ACL. Reservation + tracking_profile remain coverage/model gaps.
- **No Primary merge/Iran deploy this child** until qa:full + review.

## 2026-08-31T13:40:00+03:30 — Primary merge + Iran overlay v173 done

- **Primary push:** `6ce3ac1..be0faec` on `origin/claude/claude-md-docs-2ssrpy`
- **qa:full:** `qa-20260831T095752-10032` PASS 248 FAIL 0 ERROR 0 · 14 gaps
- **Iran:** SFTP product overlay; **do not replace VPS db.js**. Outage recovered via `git checkout -- server/db.js`. health/ready/root 200. SW v173.
- **Integration** claims released (`completed`). Next: `QA-ERP-GAPS-NOT-IMPLEMENTED` on new worktree from Primary. erp-taranom1 untouched.

## 2026-08-31T13:20:00+03:30 — Owner approved Primary merge + Iran deploy

- **Task:** `QA-ERP-FULL-CYCLE-INTEGRATION` — owner override of prior no-merge/no-deploy gate
- **Primary:** `origin/claude/claude-md-docs-2ssrpy` @ `6ce3ac1` (authoritative). Local stale `51be279` in demo-v3-merge worktree left untouched.
- **Integration tip before stamp:** `1fd4917` (22 commits ahead of origin Primary, 0 behind)
- **SW:** `erp-taranom-v173`
- **Constraint kept:** do not checkout `erp-taranom1` / `ai/UI-DOCS-STITCH`
- **Exact next:** merge `--no-ff` into Primary worktree, run gates + `/qa-full`, push Primary, SFTP Iran, stamp CHANGE-LOG ✅, then claim `QA-ERP-GAPS-NOT-IMPLEMENTED`

## 2026-08-26T17:30:00+03:30 — recon UNION fix + qa:full GREEN (no Primary/deploy)

- **Bugbot finding:** `scripts/qa/recon.js` `stock.ledger_vs_warehouse` only walked ledger keys; positive `warehouse_stock` without ledger was PASS.
- **Regression first:** `test-qa-fix-recon-ledger-union.js` failed 4 cases on old code (warehouse-only + company/variant sides).
- **Fix:** UNION keys from both sources; dims company/warehouse/product/variant when columns exist; missing side treated as 0.
- **Harness:** CRM-PRO RBAC HTTP wait 60→180 ticks (boot ~20s under load; 15s was flake). Assertions unchanged.
- **qa:full:** `qa-20260826T135416-20172` exit **0** · PASS **248** · FAIL **0** · ERROR **0** · JE **0** · FK **0** · stock **0**. Prior flake run `qa-20260826T134136-19508` FAIL 1 wrap.crm_pro_rbac ECONNREFUSED.
- **Reviews:** Bugbot no bugs ([Bugbot](ae3528f1-ebec-49e1-a8ca-f874b91b6b71)); Independent APPROVED ([Independent](8af62a60-b0a0-4dc7-8476-499d110d3da8)); Security C0/H0/M0 ([Security](15b49fa8-361b-4920-aeeb-28894e97c2d9)).
- **NO merge / push / Iran deploy.** Rollback: restore `recon.js` + RBAC wait.
- **MERGE_READY on this worktree** (FAIL=0 ERROR=0 JE=0 FK=0 stock=0, no H/M). Owner still must approve Primary merge.

## 2026-08-25T15:00:00+03:30 — Integration qa:full GREEN (no Primary/deploy)

- **Task:** `QA-ERP-FULL-CYCLE-INTEGRATION` still `active` until Bugbot + Independent + Security on this tip.
- **Tip:** merge `16791be` (a9a7110 + 7d60258) plus harness boot/E2E fallback (pending this commit).
- **Run:** `qa-20260825T115815-8164` · `NODE_ENV=test node scripts/qa/run-full-erp-qa.js` (no `--skip-e2e`)
- **Exit 0** · PASS **248** · FAIL **0** · ERROR **0** · NOT_IMPLEMENTED **14** · SKIP 1
- Admin + All-Roles + Playwright E2E (system Chrome channel) ran. recon JE=0 FK=0 stock-GL=0.
- **14 gaps classified** (do not fake PASS). See CHANGE-LOG / report. **NO merge / push / Iran deploy.**
- **Exact next:** Bugbot + Independent (`/agent-review`) + Security on this worktree only.

## 2026-08-25T14:15:00+03:30 — QA-ERP-FULL-CYCLE-INTEGRATION claimed + source merge

- **Task:** `QA-ERP-FULL-CYCLE-INTEGRATION` status=`active`; owner `cursor:orchestrator-qa-erp`; implementer `cursor:implementer-qa-integration`.
- **Worktree:** `D:/soft/Claud/porje/Run in the project/erp-taranom-qa-erp-integration` branch `ai/QA-ERP-FULL-CYCLE-INTEGRATION` from Primary `6ce3ac1`.
- **Sources kept:** harness `a9a7110` (`ai/QA-ERP-FULL-CYCLE-admin-roles`) + product `7d60258` (`ai/QA-ERP-FULL-CYCLE-FIX-HIGHS-product`).
- **Claim transfer:** parent `QA-ERP-FULL-CYCLE` / `FIX-HIGHS` / `RBAC-MATRIX-ALIGN` claims released to Integration. `UI-STITCH-P0-DISCOVERY` in erp-taranom1 not edited.
- **Constraint:** NO Primary merge, NO push, NO Iran deploy this session.
- **Exact next:** isolated `NODE_ENV=test node scripts/qa/run-full-erp-qa.js` (no --skip-e2e); classify 14 NOT_IMPLEMENTED; Bugbot + Independent + Security on Integration tip.

## 2026-08-25T02:45:00+03:30 — Reviews green; cheque harness kept on admin-roles

- **This worktree:** `ai/QA-ERP-FULL-CYCLE-admin-roles` @ `9d853c3` then this commit. `scripts/qa/batches/admin.js` cheque tests unchanged since `50e8269`.
- **erp-taranom1:** stayed `ai/UI-DOCS-STITCH` (not checked out).
- **Product sibling:** `7d60258` — skipStock no `stock_logs`; payroll pay/void/delete + master-data `payroll.create`.
- **qa:full:** `qa-20260824T224056-6580` PASS 246 FAIL 0 ERROR 0 · recon JE 0.
- **Reviews (product worktree):** Bugbot no bugs; Independent APPROVED; Security C0/H0/M0 ([Security Review](6232929e-5149-4fb6-b77b-b45399ff3fab)).
- **Follow-up task:** `QA-ERP-GAPS-NOT-IMPLEMENTED` (14 gaps, not PASS). **NO merge / Iran deploy.**

## 2026-08-25T02:15:00+03:30 — Continue on admin-roles; do not touch erp-taranom1

- **Constraint:** Cursor workspace `erp-taranom1` stayed on `ai/UI-DOCS-STITCH`. No checkout of this worktree. `scripts/qa/batches/admin.js` cheque tests remain at `50e8269` / tip `60e371f`.
- **Harness tip:** `60e371f` on `ai/QA-ERP-FULL-CYCLE-admin-roles` (this worktree). Product High/Medium closed on sibling `erp-taranom-qa-erp-fix-highs` @ `88d30ab` (skipStock `stock_logs`; payroll pay/void/delete `payroll.create`).
- **Authoritative `qa:full`:** `qa-20260824T224056-6580` on product worktree · PASS **246** · FAIL **0** · ERROR **0** · NOT_IMPLEMENTED **14** · recon JE **0**. No `--skip-e2e`.
- **NOT_IMPLEMENTED (not PASS):** RFQ, 3-way match, GRNI/`coa_grni`, maker-checker SOD, branch ACL, order reservations, fabric `tracking_profile=roll`, backup/restore not hit in admin batch.
- **Reviews:** re-run on product worktree only (prior Bugbot High + Security Medium should be closed). **NO merge / Iran deploy.**
## 2026-08-25T02:10:00+03:30 — Bugbot High skipStock kardex + Security Medium payroll pay

- **Worktree:** `erp-taranom-qa-erp-fix-highs` @ `ai/QA-ERP-FULL-CYCLE-FIX-HIGHS-product` (erp-taranom1 stayed on `ai/UI-DOCS-STITCH`)
- **Bugbot High:** `postInventoryMovement({skipStock:true})` still inserted `stock_logs` → skip when `skipStock`. Claim appended: `server/lib/inventory/ledger.js`.
- **Security Medium:** `POST /payroll/:id/pay`, `void-payment`, `DELETE /:id` now `requirePermission('payroll','create')`; UI pay/void/cancel gated.
- **Tests:** opening-stock 10/10 · payroll RBAC 17/17 · SMS 22/22 · `qa:full` `qa-20260824T224056-6580` PASS 246 FAIL 0 ERROR 0 · recon JE 0. **NO merge / Iran deploy.**
- **Exact next:** Bugbot / Independent / Security on `erp-taranom-qa-erp-fix-highs` only (do not checkout `erp-taranom1`)

## 2026-08-25T01:20:00+03:30 — QA-ERP-RBAC-MATRIX-ALIGN claimed + matrix tightened

- **Task:** `QA-ERP-RBAC-MATRIX-ALIGN` (child of QA-ERP-FULL-CYCLE); implementer `cursor:implementer-qa-fix-highs`
- **Why:** Full E2E `qa-20260824T214150-19348` FAIL 18 were matrix vs route: GET `/settings` adminOnly, GET `/accounting/sales-returns` adminOrAccounting. Not a secret-dump product bug.
- **Product:** `settings.view=false` for non-admin; `accounting.view=false` except admin/accounting/sales_manager.
- **Harness (parent commits cherry-picked):** cheque party_id tests; accounting.view probe=`/reps`; entity-picker E2E; sales-returns gate kept.
- **Test:** `test-qa-fix-rbac-matrix.js` 23/23. **NO merge / Iran deploy.**
- **Exact next:** `NODE_ENV=test node scripts/qa/run-full-erp-qa.js` then reviews if FAIL=0 ERROR=0

## 2026-08-25T00:45:00+03:30 — Independent re-review + central-only opening backfill

- **Independent re-review:** [Independent Review](6bc4aad4-719e-47f2-bd33-69805849ebf5) vs `aeb5d06`
  - Prior High (payroll sibling POSTs) **closed** (not re-reported)
  - New Medium: `backfillOpeningInventoryLedger` on device duplicates ledger after pull → skip on `SYNC_ROLE=device`
- **Constraint:** NO merge, NO Iran deploy

## 2026-08-24T19:56:00+03:30 — Independent High = sibling payroll POSTs (already closed)

- **Independent:** [Independent Review](44682d22-40e7-417d-a8f8-78d715baa679) High on `POST /payroll/monthly-batch` + `/farankenou/commit` still `adminOrAccounting`
- **Disposition:** same gap as Security Medium; already gated in `2b005c7` with `requirePermission('payroll','create')` (also `year-end/:id/post`, `accruals/monthly`). Test 13/13.
- **review_status:** still PENDING until re-review of tip `a79774e` (reviewer saw pre-`2b005c7` diff)
- **Constraint:** NO merge, NO Iran deploy

## 2026-08-24T19:54:00+03:30 — FIX-HIGHS product Highs closed; harness leftover

- **Task:** `QA-ERP-FULL-CYCLE-FIX-HIGHS` still `active` (no merge/deploy)
- **Tip:** `2b005c7` on `ai/QA-ERP-FULL-CYCLE-FIX-HIGHS-product`
- **Security:** [Security Review](e9b016cc-161a-4c75-a4ea-0ad8a57583cd) C0/H0 + Medium sibling payroll POSTs → closed in `2b005c7` (13/13 RBAC test)
- **Independent Reviewer:** still PENDING ([Independent Review](44682d22-40e7-417d-a8f8-78d715baa679) in flight)
- **QA `qa-20260824T162339-14916`:** `--skip-e2e` (Playwright chromium missing in sandbox cache) · exit **1** · PASS 182 · FAIL 19 · NOT_IMPLEMENTED 14
- **Product Highs now PASS:** `fault.invoice_maybe_wh`, `roles.accounting.payroll.create`, `recon.firm_invoice.has_warehouse`, `recon.stock.ledger_vs_warehouse`
- **Party UI:** `test-qa-fix-party-picker-ui.js` 14/14; no `id="tc-party"` / `id="oc-party"` (E2E skip so `e2e.party_id_required` not rec'd)
- **Harness leftovers (do not weaken; parent owns `scripts/qa/**`):** hardcoded `cheque.free_text_party` FAIL; `cheque.create_in` posts without `party_id` → 400
- **Mediums unchanged:** GET `/settings` adminOnly vs matrix `settings.view`; GET sales-returns tighter than `accounting.view`
- **Constraint:** NO merge, NO Iran deploy. Do not declare full suite PASS.

## 2026-08-24T18:57:00+03:30 — QA-ERP-FULL-CYCLE-FIX-HIGHS claimed (owner start)

- **Task:** `QA-ERP-FULL-CYCLE-FIX-HIGHS` status=`active`
- **Implementer:** `cursor:implementer-qa-fix-highs` (≠ `cursor:implementer-qa-erp`)
- **Reviewer / Security:** `cursor:independent-reviewer-qa-erp` / `cursor:independent-security-qa-erp`
- **Branch / worktree:** `ai/QA-ERP-FULL-CYCLE-FIX-HIGHS-product` /
  `D:/soft/Claud/porje/Run in the project/erp-taranom-qa-erp-fix-highs` @ `aeb5d06`
- **Registry overlap:** child updates its own block in `active.yaml` plus handoff/status/CHANGE-LOG
  (parent still claims those paths; owner authorized this child start).
- **Constraint:** NO merge, NO Iran deploy. Do not edit `scripts/qa/**`.
- **Exact next:** five Highs with failing tests first, one commit each

## 2026-08-24T18:40:00+03:30 — QA-ERP-FULL-CYCLE first full run (no deploy)

- **Task:** `QA-ERP-FULL-CYCLE` implementer done (harness). Reviewer still PENDING.
- **Run:** `qa-20260824T151001-15880` · `NODE_ENV=test node scripts/qa/run-full-erp-qa.js`
- **Exit 3** · PASS 211 · FAIL 24 · NOT_IMPLEMENTED 14 · wrap tests all green · E2E login+nav OK
- **Highs (not PASS):** cheque `party_name`, firm invoice without warehouse, ledger vs `warehouse_stock`, accounting POST `/payroll` despite `payroll.create=false`, UI free-text party
- **Child:** `QA-ERP-FULL-CYCLE-FIX-HIGHS` status=`blocked` (implementer unassigned, ≠ QA implementer)
- **Constraint:** NO merge, NO Iran deploy. Product files not edited.
- **Exact next:** Independent review of harness; owner assigns child for Highs

## 2026-08-24T17:59:00+03:30 — QA-ERP-FULL-CYCLE claimed (pre-implementation)

- **Task:** `QA-ERP-FULL-CYCLE` status=`active`; owner `cursor:orchestrator-qa-erp`
- **Implementer:** `cursor:implementer-qa-erp`
- **Reviewer / Security:** `cursor:independent-reviewer-qa-erp` / `cursor:independent-security-qa-erp` (≠ Implementer; for later High product fixes)
- **Branch / worktree:** `ai/QA-ERP-FULL-CYCLE-admin-roles` /
  `D:/soft/Claud/porje/Run in the project/erp-taranom-qa-erp-full-cycle` @ base `6ce3ac1`
- **Not used:** dirty `erp-taranom1` (`ai/UI-DOCS-STITCH` / `UI-STITCH-P0-DISCOVERY`); deploy scripts untouched
- **Constraint:** NO merge, NO Iran deploy, NO production DB/API/SMS/Moadian
- **Exact next:** fail-closed runner + inventory + Admin/Roles batches on temp DB

## 2026-08-20T17:25:00+03:30 — PROD-02/03 Iran SFTP v172 @ b52a1de

- Stamp `.sftp-deploy-stamp-stitch-v172` = `2026-08-20T13:54:13Z hash=b52a1de`
- health/ready/root **200**; SW `erp-taranom-v172`; `db.js` not replaced; `schema.js` overlaid
- Independent [Bugbot](15f254b6-11a8-4913-98b3-fd17622b0c74) no bugs; Security [review](47086660-b6fc-4e97-8e9c-0776c9659da7) APPROVED C0/H0/M0
- Claims released. Next: PACK / FG receipt still out

## 2026-08-20T17:50:00+03:30 — PROD-02/03 dual APPROVED (Iran overlay next)

- Independent [Bugbot](15f254b6-11a8-4913-98b3-fd17622b0c74) no bugs
- Security [review](47086660-b6fc-4e97-8e9c-0776c9659da7) APPROVED C0/H0/M0
- Tests **39/39**. SW v172. FF + SFTP overlay next. `db.js` not replaced

## 2026-08-20T17:35:00+03:30 — Independent High: production roll picker

- `GET /api/production/cutting-lays/rolls` for `production.view` (no cost fields)
- UI no longer depends on admin-only `/inventory/fabric-rolls`
- Tests **39/39**. **NO Iran deploy / FF** until Independent Highs closed

## 2026-08-20T17:20:00+03:30 — PROD-02/03 Independent Highs fixed

- High: client `waste_abnormal_m` cannot exceed leftover (actual − matrix)
- Medium: fabric line picked by meter unit / size_matrix, not first material
- Tests **35/35**. Security already APPROVED on prior commit; Independent re-review next
- **NO Iran deploy / FF**

## 2026-08-20T17:05:00+03:30 — PROD-02/03 implementer done (pre-review)

- Tests: cutting **32/32** · SMS **22/22** · schema P0 **16/16** · sync gaps mismatches=[] · app.js parse OK
- SW `erp-taranom-v172`. Help warns against PO backflush of same fabric.
- Empty roll reactivates on R13 void.
- **NO Iran deploy / FF** until Independent + Security APPROVED

## 2026-08-20T16:42:00+03:30 — PROD-STITCH-P5B claimed (PROD-02/03)

- Branch `ai/PROD-02-CUTTING` from primary `be76a5c`
- Spreading wizard + size matrix + waste. Consumes WH-RAW fabric rolls.
- No PACK / FG receipt. Direct JE `cutting_lay` / `cutting_lay_waste`.
- **NO Iran deploy / FF** until Independent + Security APPROVED

## 2026-08-20T17:50:00+03:30 — PROD-01 Iran SFTP v171 @ db708a8

- Stamp `.sftp-deploy-stamp-stitch-v171` = `2026-08-20T13:09:58Z hash=db708a8`
- health/ready/root **200**; SW `erp-taranom-v171`; `db.js` not replaced; `schema.js` overlaid
- Independent [Bugbot](63fac38b-3c47-4e4e-94b1-73f311d39b8a) no bugs; Security [review](fab46d47-8155-413d-91ea-958c58583d2b) APPROVED C0/H0/M0
- Claims released. Next: PROD-02/03 wizard not in this task

## 2026-08-20T17:45:00+03:30 — PROD-01 review Highs fixed (pre-merge)

- High-1: `supplierDetailId` via `suppliers.party_id` → `parties.detail_account_id`
- High-2: `supplier_ledger` credit on valued receive; debit on R13 void
- M1: UI always sends `idempotency_key`; server requires it; replay returns same row
- FK append: `ledger_id` / `journal_id` / `reversal_journal_id` on `inventory_batches`
- Tests **23/23**. **NO Iran deploy** until Independent + Security APPROVED

## 2026-08-20T17:10:00+03:30 — PROD-STITCH-P5 claimed (PROD-01)

- ADR-007 Accepted. Fabric receive on WH-RAW. Tests 17/17. SW v171
- **NO Iran deploy** until Independent + Security APPROVED



- Primary FF `claude/claude-md-docs-2ssrpy` = `4d9bc83`
- Stamp `.sftp-deploy-stamp-stitch-v170` = `2026-08-20T12:40:04Z hash=4d9bc83`
- health/ready/root **200**; SW `erp-taranom-v170`; `db.js` not replaced
- ADR-007 Accepted. Claims released. Next: `PROD-STITCH-P5`



- Owner: merge POS-03/Phase 8 to primary and Iran SFTP; Accept ADR-007 (طاقه فقط WH-RAW)
- PROD-01 schema **not** in this overlay — next task `PROD-STITCH-P5`
- SW v170



- **Task:** `STITCH-P8-POS03-ADR007` @ `bf29bfc` SW v169
- Independent Bugbot: no remaining Highs ([re-review](1e1019b4-772c-492a-9d41-1872052f55d8))
- Security: prior APPROVED on CSV/RBAC (`06c637e`); later commits are GL share + unbounded totals
- POS-03 **53/53** · Phase 8 gates green
- **NO Iran deploy / merge** until owner approval
- ADR-007 stays Proposed; PROD-01 not started

## 2026-08-20T16:40:00+03:30 — Independent High: unbounded bank reconcile vs 500-row list

- Totals + `reconcile.banks` from SQL without LIMIT; UI list still 500/800
- POS-03 **53/53**; SW v169

## 2026-08-20T16:10:00+03:30 — Independent Highs: mixed-batch GL + crm_token

- **High-1:** `exportPosReport` uses `crm_token` (not `token`)
- **High-2:** terminal-scoped GL allocates `pos_batch` JE via `pos_settlement_items` (mixed header `terminal_id=NULL`)

## 2026-08-20T15:20:00+03:30 — STITCH-P8 POS-03 + ADR-007 open + Phase 8 gates

- **Task:** `STITCH-P8-POS03-ADR007` claimed; branch `ai/STITCH-P8-POS03-ADR007` @ worktree stitch-impl
- **POS-03:** `GET /api/pos/report` + CSV; UI `acc-pos-report`; in-transit GL vs open remaining; bank POS net vs `pos_batch` JE
- **ADR-007:** opened as Proposed in `docs/architecture/ADR-007-FABRIC-ROLL.md` — fabric roll on WH-RAW only; no FG lot; no Serial/Bin; **no PROD schema this commit**
- **Phase 8:** `run-stitch-phase8-gates.js` + `docs/architecture/STITCH-PHASE-8-HARDENING.md`
- **SW:** v167 then v169 after review fixes
- Dirty `erp-taranom1` deploy scripts untouched


## 2026-08-19 — LED-01 Iran SFTP v166 @ 0daf21f

- Stamp `.sftp-deploy-stamp-stitch-v166` = `2026-08-19T13:26:45Z hash=0daf21f`
- health/ready/root **200**; SW `erp-taranom-v166`; `db.js` not replaced
- Next: Phase 8. ADR-007 stays closed

## 2026-08-19 — LED-01 merge + Iran SFTP v166 (owner authorized)

- Security [Security LED](9ac12419-4bb4-4821-b456-14d607355906) **APPROVED** C0/H0/M0
- Independent stalled; owner: merge and deploy all remaining changes
- Tests re-run **47/47** · SMS **22/22**. Claims released. SW v166. `db.js` not replaced

## 2026-08-19 — LED Security APPROVED on a464b2e

- [Security LED](9ac12419-4bb4-4821-b456-14d607355906) **APPROVED** C0/H0/M0 on real worktree (`ledgers.js` present)
- RBAC DB-role, parameterized SQL, read-only, export same gate as JSON
- Independent still in flight ([Independent LED](d48d2faa-8e9a-48a4-b418-0443a03c162e))
- **NO merge / Iran deploy** until Independent APPROVED

## 2026-08-19 — LED-01 implementer done on a464b2e (pre-review)

- [LED-01 implementer](fcedf052-bc55-4ac8-a27d-e37e0bbd01ff) shipped `ai/LED-STITCH-P9` @ `a464b2e`
- Read-only financial + stock APIs; opening+period=closing; CSV matches JSON; field_sales 403
- test-led-stitch-p9 **47/47** · SMS **22/22**; SW v166; no new sync tables
- Dual review next. **NO merge / Iran deploy** until Independent + Security APPROVED

## 2026-08-19 — LED-STITCH-P9 claimed (LED-01)

- Owner: next wave after POS Iran v165
- Claims: lib/ledgers.js, routes/ledgers.js, test-led-stitch-p9.js
- POS-03 and ADR-007 out. No merge until dual review

## 2026-08-19 — POS-01/02 Iran SFTP v165 @ bdcc84a

- Dual APPROVED: [Independent POS](c5058adb-ce19-4880-8468-b099d33e73e6) + [Security POS product](f97371e8-d74b-4222-a789-75f429799fab)
- Merged `7cab828` into `ai/UI-STITCH-IMPL` @ `bdcc84a`; FF to primary
- Stamp `.sftp-deploy-stamp-stitch-v165` = `2026-08-19T03:05:04Z hash=bdcc84a`
- health/ready/root **200**; SW `erp-taranom-v165`; `db.js` patched (`initPosSchema`)
- Next: LED-01 + Phase 8. ADR-007 stays closed

## 2026-08-19 — POS-01/02 dual APPROVED; merge + Iran SFTP v165

- [Independent POS](c5058adb-ce19-4880-8468-b099d33e73e6) **APPROVED** + [Security POS product](f97371e8-d74b-4222-a789-75f429799fab) **APPROVED** C0/H0/M0 on `7cab828`
- Merged `origin/ai/POS-STITCH-P8` into `ai/UI-STITCH-IMPL`. Claims released. SW v165
- Next: Iran SFTP overlay (do not replace VPS `db.js` — patch `initPosSchema` call). Then LED-01 + Phase 8. ADR-007 stays closed

## 2026-08-19 — POS Independent APPROVED on 7cab828

- [Independent POS](c5058adb-ce19-4880-8468-b099d33e73e6) **APPROVED** High 0 / Medium 0; tests 55/55
- Security product re-run still in flight ([Security POS product](f97371e8-d74b-4222-a789-75f429799fab)); prior pass void
- **NO merge / Iran deploy** until Security APPROVED on POS code

## 2026-08-19 — POS Security pass invalid (wrong tree)

- [Security POS](6f2a51d4-f2a0-419e-b800-ae56f5317fb6) reviewed stitch-impl docs/demo, not `pos.js`
- Verdict on that diff is irrelevant to POS-STITCH-P8. Re-run on `erp-taranom-pos-stitch-p8` @ `7cab828`
- **NO merge / Iran deploy**

## 2026-08-19 — POS-01/02 implementer done on 7cab828 (pre-review)

- [POS-01/02 implementer](51006781-358a-4ef6-99a3-70a7492fa52a) shipped `ai/POS-STITCH-P8` @ `7cab828`
- Terminal bank FK (not localStorage); receipt → in-transit 1118; batch net to bank + fee/shortage; R13 void
- test-pos-stitch-p8 **55/55** · SMS **22/22**; SW v165; sync append + backfill v11
- Dual review next. **NO merge / Iran deploy** until Independent + Security APPROVED

## 2026-08-19 — POS-STITCH-P8 claimed (POS-01/02)

- Owner: next wave after CON Iran v164
- Claims: db.js, coa-map.js, lib/pos.js, routes/pos.js, test-pos-stitch-p8.js, sync/tables.js
- POS-03 and ADR-007 out. No merge until dual review

## 2026-08-19 — CON-01/02 Iran SFTP v164 @ 1a1bf0f

- Dual APPROVED: [Independent re-review](73cd20d1-4ad6-46eb-b506-1691ace7df18) + [Security CON delta](e69a57e1-870a-4dae-9284-d6787930ce83)
- Merged `f79127c` into `ai/UI-STITCH-IMPL` @ `1a1bf0f`; FF to primary
- Stamp `.sftp-deploy-stamp-stitch-v164` = `2026-08-19T02:33:45Z hash=1a1bf0f`
- health/ready/root **200**; SW `erp-taranom-v164`; `db.js` patched in place (consignment columns)
- Next: POS-01/02 + LED-01 + Phase 8. ADR-007 stays closed

## 2026-08-19 — CON-01/02 dual APPROVED; merge + Iran SFTP v164

- [Independent re-review](73cd20d1-4ad6-46eb-b506-1691ace7df18) **APPROVED** on `f79127c` (M1–M3 closed, 61/61)
- [Security CON delta](e69a57e1-870a-4dae-9284-d6787930ce83) **APPROVED** C0/H0/M0 on same tip
- Merged `origin/ai/CON-STITCH-P7` into `ai/UI-STITCH-IMPL`. Claims released. SW v164
- Next: Iran SFTP overlay (do not replace VPS `db.js` — patch consignment columns). Then POS-01/02 + LED-01 + Phase 8. ADR-007 stays closed

## 2026-08-19 — CON Security APPROVED on f79127c (delta)

- [Security CON delta](e69a57e1-870a-4dae-9284-d6787930ce83) **APPROVED** C0/H0/M0 on `f79127c`
- Buyer isolation, COGS+void, append-only FK remap verified; RBAC `adminOrAccounting`

## 2026-08-19 — CON M1–M3 fix on f79127c (re-review)

- [CON-01/02 consignment](16450d8f-c62d-49b4-af27-bd973dcd570d) closed Independent M1–M3
- in+sale needs distinct buyer; out+sale posts COGS without second qty drop; FK remap settle_je_id/issue_ledger_id
- Tests **61/61** · SMS **22/22**

## 2026-08-19 — CON Independent CHANGES_REQUIRED M1–M3

- [Independent CON](9cb86e60-da40-402a-ad31-a3b275b3531f) **CHANGES_REQUIRED** on `ca6f5a2` (47/47 still green)
- M1: `in`+sale must not invoice the consignor / Dr AP; require a distinct buyer `cust_id`/`buyer_person_id`
- M2: `out`+sale must post inventory GL + COGS (qty already issued; no second warehouse qty drop)
- M3: append `consignments.settle_je_id` and `issue_ledger_id` to `FK_COLUMNS`

## 2026-08-19 — CON-01/02 Security APPROVED on ca6f5a2

- [Security CON](dfe2d2bd-b84a-492f-b0cc-1a29b298c894) **APPROVED** C0/H0/M0 — person FK, RBAC, no double stock, JE, sync, R13 void

## 2026-08-19 — CON-01/02 implementer done on ca6f5a2 (pre-review)

- [CON-01/02 consignment](16450d8f-c62d-49b4-af27-bd973dcd570d) shipped `ai/CON-STITCH-P7` @ `ca6f5a2`
- Person FK, warehouse issue/receipt, four settle paths, sale-only invoice, R13 no physical delete
- test-con-stitch-p7 **47/47** · SMS **22/22**; SW v164

## 2026-08-19 — CON-STITCH-P7 claimed (CON-01/02)

- Owner: execute next wave after HR+INV+TRS Iran v163
- Claims: consignments.js, lib/consignments.js, test-con-stitch-p7.js, db.js

## 2026-08-19 — HR+INV+TRS Iran SFTP v163 @ 02872a5

- Stamp `.sftp-deploy-stamp-stitch-v163` = `2026-08-19T01:34:41Z hash=02872a5`
- health/ready/root **200**; SW `erp-taranom-v163`; `db.js` patched in place (`user_invitations`)
- Next: CON + POS-01/02 + Phase 8. ADR-007 stays closed

## 2026-08-19 — HR+INV+TRS merged (SW v163); Iran deploy next

- [Independent HR re-review](4450ae38-7d9d-419f-832b-6495a85ee7fa) **APPROVED** on `6c65660` closed log+role M1s
- Merged into `ai/UI-STITCH-IMPL`: HR `6c65660` + INV `d1ea078` + TRS `ca4e22a`
- Tests: invite 51/51 · obs 12/12 · inv-p4 25/25 · cheque-out 36/36 · SMS 22/22
- Claims released. CON + POS after deploy

## 2026-08-19 — HR-02 dual APPROVED on 6c65660; merge three waves

- [Independent HR re-review](4450ae38-7d9d-419f-832b-6495a85ee7fa) **APPROVED** — log M1 and role M1 closed; 51/51 + 12/12
- Security already APPROVED on same tip (b8f07eb4). Triple wave merge next: HR `6c65660` + INV `d1ea078` + TRS `ca4e22a` (rebase `app.js`)
- Then Iran deploy. CON/POS after `db.js` lands

## 2026-08-19 — HR-02 Security APPROVED on 6c65660

- [Security HR 6c65660](b8f07eb4-5487-46fd-8c70-b3675e724fd6) **APPROVED** C0/H0/M0 — log redact + intended_role (no admin, no accept-body escalate, accounting cannot invite accounting, table not syncable)
- Independent still in flight ([Independent HR re-review](4450ae38-7d9d-419f-832b-6495a85ee7fa))
- **NO merge / Iran deploy** until Independent APPROVED; then rebase `app.js` with INV/TRS

## 2026-08-19 — HR-02 log M1 dual APPROVED on fdb39ae

- [Independent HR M1](8680b9d9-f567-4d5d-88d0-db96089a0d30) **APPROVED** — `sanitizeLogPath` closes token-in-log M1
- [Security HR M1](4a00f683-711c-47bf-b1d9-3a25d97a448c) **APPROVED** C0/H0/M0 on same tip
- Current product tip is **`6c65660`** (intended_role). Merge still waits Independent+Security on that delta
- **NO merge / Iran deploy**

## 2026-08-19 — HR-02 intended_role on 6c65660 (re-review)

- [HR-02 invitation](93b50704-54ab-430b-bb9e-af7fc99a3186) closed Independent role M1: persist `intended_role`, never `admin`, accounting-invite admin-only, accept ignores client role
- Tip `ai/HR-STITCH-P3` @ `6c65660`; invite **51/51** · obs **12/12** · SMS **22/22**; SW v162
- Also keeps `sanitizeLogPath` from `fdb39ae`. Dual re-review of both M1s next
- **NO merge / Iran deploy**

## 2026-08-19 — INV-02/03 dual APPROVED on d1ea078

- [Independent INV-02/03](0b08900f-5d27-4e4a-9355-0f74e10d4598) **APPROVED** H0/M0 (Lows: stale ATP, GET reservation expiry, inactive hex lock)
- [Security INV](ebbc2bb0-af74-40b8-bf73-d369856d1e28) **APPROVED** C0/H0/M0
- **NO merge** until HR Independent APPROVED; then rebase `app.js` with TRS

## 2026-08-19 — HR-02 Independent CHANGES_REQUIRED (hardcoded field_sales)

- [Independent HR-02](fcc70551-7f87-4354-9554-8cfeb3d556c6) on `bc6b975` **CHANGES_REQUIRED** Medium: accept always inserts `role='field_sales'` (sales write for every invited person)
- Distinct from log-redact M1 ([Independent HR-02](b61c3c16-2e0f-4141-81d4-29a60bb9649c)); both merge-blocking
- Fix: allow-listed `role` on create (never `admin`; `accounting` only if creator is admin); persist on invite; accept must not take role from client. Default omitted body stays `field_sales` for sales invites
- Confirmatory Security [Security HR-02](f8aff36f-d58e-42d6-919f-9f4b318d76bc) **APPROVED** on `bc6b975` (same as fff3c354)
- **NO merge / Iran deploy**

## 2026-08-19 — HR-02 M1 log-redact on fdb39ae (Independent re-review)

- [HR-02 invitation](93b50704-54ab-430b-bb9e-af7fc99a3186) closed Independent M1: `sanitizeLogPath` redacts invite tokens in `http_request` path
- Tip `ai/HR-STITCH-P3` @ `fdb39ae`; tests obs **12/12** · invite **38/38** · SMS **22/22**
- Independent re-review of M1 next. Security was APPROVED on `bc6b975` — delta is log-only
- **NO merge / Iran deploy**

## 2026-08-19 — INV-02/03 implementer done on d1ea078 (pre-review)

- [INV-02/03 warehouse search](c083e408-cac8-4676-89b2-089a1d19c98a) shipped `ai/INV-STITCH-P4` @ `d1ea078`
- Hex `#RGB`/`#RRGGBB` + `E_COLOR_DUPLICATE`; warehouse search SKU/barcode/name + ATP
- test-inv-stitch-p4 **25/25** · SMS **22/22**; SW bump on that branch
- Minimal `app.js` search in receipt/issue/transfer — rebase with HR/TRS
- Dual review next. **NO merge / Iran deploy**

## 2026-08-19 — HR-02 Independent CHANGES_REQUIRED M1; Security APPROVED

- [Independent HR-02](b61c3c16-2e0f-4141-81d4-29a60bb9649c) **CHANGES_REQUIRED** — Medium M1: raw invite token in `http_request` `path` (`req.originalUrl`) for `/api/auth/invite/:token` and `/invite?token=`
- [Security HR-02](fff3c354-809f-44f8-a811-a36942ab7906) **APPROVED** C0/H0/M0 on same tip (did not treat log path as Medium)
- Independent Medium is merge-blocking. M1 fix: redact invite tokens in `observability.js` logger (keep public URL API). Re-review Independent after.
- Payslip self-service remains Low/out of scope. **NO merge / Iran deploy**

## 2026-08-19 — TRS-01 Independent APPROVED; dual gate closed on ca4e22a

- [Independent TRS-01](2180f9f2-ed29-4880-8f57-2d743a0e8096) **APPROVED** H0/M0 (Lows: PATCH regex, 403 test, `collection_je_id` reuse, `app.js` rebase)
- Security already APPROVED (7e136658). Dual APPROVED but **NO merge** until HR M1 + INV reviews; then rebase `app.js`

## 2026-08-19 — HR-02 implementer done on bc6b975 (pre-review)

- [HR-02 invitation](93b50704-54ab-430b-bb9e-af7fc99a3186) shipped `ai/HR-STITCH-P3` @ `bc6b975`
- Hashed one-time token, 72h expiry, accept creates user with chosen password; SW v161
- test-hr-invite **37/37** · SMS **22/22**
- Also edited `app.js` / `db.js` / `capture.js` — rebase after TRS/INV

## 2026-08-19 — TRS-01 Security APPROVED on ca4e22a

- [Security Review](7e136658-7a4d-4ddf-b50f-cb0c916dc216) **APPROVED** C0/H0/M0 on `ai/TRS-STITCH-P6` @ `ca4e22a`
- Lows non-blocking: add 403 RBAC test; `account_key` any LEGACY key by design; `collection_je_id` naming
- Independent still PENDING ([Independent TRS-01 review](2180f9f2-ed29-4880-8f57-2d743a0e8096))
- **NO merge / Iran deploy** until Independent APPROVED

## 2026-08-19 — TRS-01 implementer done on ca4e22a (pre-review)

- [TRS-01 cheques](8bb2dc0b-7ab0-4df6-801b-ef495998d710) shipped `ai/TRS-STITCH-P6` @ `ca4e22a`
- Pay / expense / endorse JE + R13 cancel; test-trs-cheque-out **36/36**; SMS **22/22**
- Also edited `app.js` (tab buttons + Help) — rebase after HR/INV
- Dual review next. **NO merge / Iran deploy** until Independent + Security APPROVED
- POS-01/02 still deferred (needs db.js after HR)

## 2026-08-19 — UI-STITCH-IMPL merged + Iran deployed; next waves claimed

- Owner approved merge/deploy. FF `ai/UI-STITCH-IMPL` → `claude/claude-md-docs-2ssrpy` @ `7dd5481`
- Iran: GitHub DNS fail on VPS; SFTP overlay of stitch files; `db.js` patched with `product_categories.coa_code` only. health/ready/root 200. SW v160. stamp `.sftp-deploy-stamp-stitch-v160`
- Task `UI-STITCH-IMPL` completed. PROD/PACK skipped (ADR-007 stays closed)
- Claimed parallel: `HR-STITCH-P3`, `INV-STITCH-P4`, `TRS-STITCH-P6` (disjoint file_claims; app.js later)
- CON + POS schema + Phase 8 after those APIs. Do not touch dirty erp-taranom1 deploy scripts

## 2026-08-19 — Dual APPROVED on 34e1891; waiting owner

- [Independent ACC-04 re-review](324293a7-3f99-43de-b3f5-e0146aa23584) **APPROVED** on product `34e1891`
- [Security Review](e235c782-4567-4256-bc79-110b9f7d9ed5) **APPROVED** C0/H0/M0 on ACC-04 delta (consistent with `759a63d`; Lows non-blocking: bound inv dates, `link-coa` leaf)
- Task remains `active`. **NO merge / push-to-primary / Iran deploy / PM2** until explicit owner approval
- SW: `erp-taranom-v160`

## 2026-08-19 — Independent APPROVED on 34e1891

- [Independent ACC-04 re-review](324293a7-3f99-43de-b3f5-e0146aa23584) **APPROVED** — H1–H3 and M1–M4 closed; 79/79 stitch-p2
- Remaining M5–M7 advisory (dashboard net-vs-gross banner; control GL no child roll-up; invoice-mode still invoice−settlement) — not merge-blocking
- Security on this tip still PENDING ([Security Review](e235c782-4567-4256-bc79-110b9f7d9ed5)); prior APPROVED was `759a63d` only
- Task stays `active`. **NO merge / Iran deploy / PM2** until Security APPROVED + owner approval
- SW: `erp-taranom-v160`

## 2026-08-18 — Implementer closed Independent ACC-04 Highs

- Identity: `cursor:implementer-stitch-impl`
- Closed [Independent Stitch review](0e8c3afd-c8e0-424d-be8e-2855d39692a1) H1–H3 + M1–M4 on worktree `erp-taranom-stitch-impl`
- H1 receivables outstanding from posted GL; ledger as labeled second + `books_mismatch`
- H2 shared cutoff: dashboard `asOf`/`to`, statement `closing` as-of `to`, receivables ledger/GL at same `to`
- H3 statement primary close = GL; export writes GL + mismatch warning
- M1 GL `q` filters rows only; M2 creditor from GL; M3 Add per four-col; M4 leaf pickers
- Next: gates, then Independent + Security re-review. **NO merge / Iran deploy / PM2**
- SW: `erp-taranom-v160`

## 2026-08-18 — Security APPROVED on 759a63d

- [Security Review](d8ad5a9d-ec38-4a14-8ac2-859e393161f4) **APPROVED** — C0/H0/M0 on product tip `759a63d`
- Low advisories only (non-blocking): `link-coa` not leaf-checked; empty `parties.coa_code` body not chart-validated
- Independent Reviewer still PENDING ([Independent Stitch review](0e8c3afd-c8e0-424d-be8e-2855d39692a1))
- Task remains `active`. **NO merge / Iran deploy / PM2** until Independent APPROVED + owner approval

## 2026-08-18 — UI-STITCH-IMPL accounting wave (pre dual-review)

- Identity: `cursor:implementer-stitch-impl`
- Worktree: `D:/soft/Claud/porje/Run in the project/erp-taranom-stitch-impl` branch `ai/UI-STITCH-IMPL`
- Done: OPS-01, TRS-02, ACC-01 identity lock, ACC-02..06, INV-01 group COA, Help, SW v159
- Remaining MASTER: HR-02 invite tokens, INV-02/03, UX-01, Phase 5 production (ADR-007), TRS-01/03, POS, CON, LED-01, Phase 8 hardening
- **NO merge / push-to-primary / Iran deploy / PM2** until owner approval
- Next: gates + Independent Reviewer + Security on this tip

## 2026-08-15T03:15:00+03:30 — DEMO-V3 merged + Iran deployed

- Owner approved merge/push/deploy.
- FF `feat/DEMO-V3-GUIDED-SALES` → `claude/claude-md-docs-2ssrpy` @ `bb868c5` (then this stamp commit).
- VPS git dirty (behind 63); SFTP overlay of demo files only. `pm2 restart` without `--update-env`.
- health/demo/seed 200; public `https://erp.poshaktaranom.com/demo.html` 200.
- Stamp `.sftp-deploy-stamp-demo-v3` = `2026-08-14T23:46:53Z hash=bb868c5`
- Task `completed`. Dirty user deploy scripts in erp-taranom1 untouched.

## 2026-08-15T03:08:00+03:30 — Dual APPROVED; waiting owner

- [Independent Demo V3 re-review](e84b9701-1cbe-4db1-a4c9-0d93b70ae458) **APPROVED** on `dbc2ec4`
- [Security Review](0e9e56e1-e80e-484e-81d1-289a6d709352) **APPROVED** on `dbc2ec4` — C0/H0/M0/L0
- Tip after docs stamp: `f29da49` (docs only; product = `dbc2ec4`)
- Task remains `active`. **NO merge / push / Iran deploy / PM2 / SW bump** until explicit owner approval.

## 2026-08-15T03:06:00+03:30 — Independent APPROVED on dbc2ec4

- [Independent Demo V3 re-review](e84b9701-1cbe-4db1-a4c9-0d93b70ae458) **APPROVED** — M7 closed; prior H/M closed; C0/H0/M0; Lows advisory only.
- Gates: test-demo-v3 **65/65**
- Security on this tip still PENDING ([Security Review](0e9e56e1-e80e-484e-81d1-289a6d709352)); prior security APPROVED was `1e8243c` only.
- Task stays `active`. NO merge/push/deploy until Security APPROVED + owner approval.

## 2026-08-15T03:00:00+03:30 — Security APPROVED on 1e8243c; Independent M7

- [Security Review](9c36aaac-b069-485a-a3f5-7ca91edbd317) **APPROVED** C0/H0/M0/L0 on `1e8243c` (tip has since moved).
- [Independent Demo V3 re-review](a64f05fb-e166-4431-9b6e-a0f2596cdecb) **CHANGES_REQUIRED** — prior H/M closed; new **M7** oversell (qty 4 vs stock 3).
- Implementer closing M7 (pick sellable + clamp issue qty + exact stock assert). Then dual re-review on new tip. NO push/merge/deploy.

## 2026-08-15T02:55:00+03:30 — UX review on stale tip; remaining Highs closed

- [Independent UX review V3](fd094008-0625-42fa-b7df-87ad195043c2) reviewed `3dd0d11` (stale). H1/H2/H4/H5 already in `1e8243c`.
- New on current tip: tour action no longer auto-advances (drill stays); pause/resume bar; acc section collapse; recon ≠ trial; BOM consume; MO cost; activity↔opp customer.
- Next: local commit, then re-review after in-flight agents finish. NO push/merge/deploy.

## 2026-08-15T02:50:00+03:30 — Implementer closed review High/Medium (pre re-review)

- Identity: `cursor:implementer-demo-v3`
- Closed [Independent Demo V3 review](8e7351b6-e721-4798-9f36-ef4cc075e3e4) findings:
  H1 delivery writes `delivered`/`deliveryDate`; H2 `viewBound` once; H3 sales-path asserts in `test-demo-v3.js`
  M1 convert/receipt post JE + AR; M2 COA from journals; M3 acc pages not dash / P&L first
  M4 highlight = `getBoundingClientRect`; M5 `.tour-progress` visible; M6 reset dialog a11y
- Gates: test-demo-v3 **52/52** · test-demo-static OK
- Next: commit locally, Independent + Security re-review on new tip. NO push/merge/deploy.

## 2026-08-15T02:42:00+03:30 — Independent Reviewer DEMO-V3-GUIDED-SALES

- Identity: `cursor:independent-reviewer-demo-v3` (≠ implementer/security). Product code not edited.
- Scope: committed tip `3dd0d11` only (dirty `demo-v3-app.js` WIP ignored).
- Disposition: **CHANGES_REQUIRED** — open High/Medium. See review message.
- test-demo-v3 34/34 green; does not exercise sales-path mutations.
- Production `app.js` / auth untouched. NO commit / push / deploy.

## 2026-08-15T02:35:00+03:30 — Independent Reviewer DEMO-V3-GUIDED-SALES

- Identity: `cursor:independent-reviewer-demo-v3` (≠ implementer). No product files edited.
- Tip reviewed: `3dd0d11` on `feat/DEMO-V3-GUIDED-SALES`
- Disposition: **CHANGES_REQUIRED** — open High/Medium (delivery no-op; double-bind init; tests are string/count not sales-path behavior; AR/JE unlink; acc-shell fallback to dash)
- Production auth/app.js untouched. test-demo-v3 34/34 still green (does not catch the Highs).
- NO commit / push / deploy

## 2026-08-15T02:35:00+03:30 — Security APPROVED on 3dd0d11

- [Security](afd96821-5e12-46c3-a002-bf9a0f6a6665) **APPROVED** — no Critical/High/Medium
- Prior empty-diff attempt [7a18a8d3](7a18a8d3-6f85-49c5-b6df-59fa742d0c8e) skipped (already committed)
- Low advisories only: re-validate seed on load; escape numeric data-id
- Independent Reviewer still PENDING (8e7351b6 no result yet — relaunch)
- Task remains `active`; NO merge/push/deploy

## 2026-08-15T01:45:00+03:30 — Demo V3 implementation on disk (pre dual-review)

- Failed agents (connection): inventory [38705563](38705563-83a9-421a-b60d-e753c5cbb026),
  seed/store [4a1948a9](4a1948a9-a384-4e04-886a-70ed25188982),
  app/tour [e22bd6f7](e22bd6f7-47c7-4584-b521-71bf03794f52)
- CSS succeeded: [Demo V3 CSS](6e4d7cc3-ce91-47cb-9677-72aabe30291d)
- Orchestrator wrote seed/store/tour/app/bootstrap + tests after agent failures
- Gates: test-demo-v3 **34/34** · test-demo-static OK · encoding PASS · audit OK
- Still PENDING: Independent Reviewer + Security
- NO push / merge / deploy / SW bump

## 2026-08-15T01:20:00+03:30 — inventory agent failed; mapping recorded

- [ERP feature inventory](38705563-83a9-421a-b60d-e753c5cbb026) **error** (connection failed)
- Replacement: inventory + role mapping written into
  `docs/architecture/DEMO-V3-DESIGN.md` (section «ERP inventory → Demo V3 mapping»)
- Implementers still in flight (no `demo-v3-*.js` on disk yet):
  seed/store [4a1948a9](4a1948a9-a384-4e04-886a-70ed25188982),
  CSS [6e4d7cc3](6e4d7cc3-ce91-47cb-9677-72aabe30291d),
  app/tour [e22bd6f7](e22bd6f7-47c7-4584-b521-71bf03794f52)
- No push / merge / deploy

## 2026-08-15T00:34:00+03:30 — DEMO-V3-GUIDED-SALES claimed (pre-implementation)

- **Task:** `DEMO-V3-GUIDED-SALES` status=`active`; owner `cursor:orchestrator-demo-v3`
- **Implementer:** `cursor:implementer-demo-v3`
- **Reviewer / Security:** `cursor:independent-reviewer-demo-v3` / `cursor:independent-security-demo-v3` (≠ Implementer)
- **Branch / worktree:** `feat/DEMO-V3-GUIDED-SALES` /
  `D:/soft/Claud/porje/Run in the project/erp-taranom-demo-v3` @ base `8a1d699`
- **Not used:** dirty `erp-taranom1` (user-owned deploy scripts untouched)
- **Architecture decision:** keep public path `/demo.html`; add modular V3 files
  (`demo-v3-seed.js`, `demo-v3-store.js`, `demo-v3-tour.js`, `demo-v3-app.js`).
  Static-only sandbox (no fetch). Demo Mode server stack unchanged.
  CTA URLs configurable via `window.DEMO_V3_CTA` — no invented phone/email
  (repo `demo-brand.js` has empty support_phone/support_email).
  Sample company: «پوشاک نمونه سپیدارگل». Maker credit stays
  «شرکت ترانه اندیشه پردازان ریان».
  localStorage keys explicit allow-list under `erp.taranom.demo.v3.1.*` — no wildcard delete.
- **Constraint:** NO `completed`, NO push, NO merge, NO Iran deploy until
  Independent Reviewer + Security Approved + explicit owner approval
- **Exact next:** implement welcome + role tours + linked seed + sandbox + tests

## 2026-08-14T13:25:00+03:30 — DEMO-V2 MERGED + IRAN DEPLOYED ✅

- **Owner approval:** explicit merge + SFTP + demo file
- **Merge:** `claude/claude-md-docs-2ssrpy` = `6f4d24a` (DEMO-V2 onto CRM-PRO `1287a1a`)
- **Iran deploy:** SFTP overlay (`scripts/_deploy-demo-v2-v155-sftp.py`); no `git pull`; `pm2 restart erp-taranom` **without** `--update-env`
- **Stamp:** `.sftp-deploy-stamp-demo-v2-v155` → `2026-08-14T09:51:15Z hash=6f4d24a`
- **VPS:** health/ready/root/demo 200; `CACHE='erp-taranom-v155'`; `app.js?v=155`; crm-pro still present
- **Public:** `https://erp.poshaktaranom.com/demo.html`
- Dirty `scripts/_deploy-mdi-v152-sftp.py` not staged

## 2026-08-14T13:20:00+03:30 — DEMO-V2 merge into primary (owner-approved deploy)

- Owner explicit: merge to `claude/claude-md-docs-2ssrpy` + Iran SFTP + demo file
- Dual Approved already: Independent a925eb95 + Security 1471cb54
- Dirty `scripts/_deploy-mdi-v152-sftp.py` not staged
- SW bump to v155 for demo-shell + static showcase

## 2026-08-14T13:05:00+03:30 — DEMO-V2-SECURE-SALES COMPLETED (dual Approved; no deploy)

- **Independent:** [Independent re-review demo v2](a925eb95-5742-4bed-8574-6374a2a2695d) **APPROVED**
- **Security:** [Security Review](1471cb54-6e3c-45e5-93af-34dee967ad44) **APPROVED**
- **Tip:** `af9859f` on `ai/DEMO-V2-SECURE-SALES`

## 2026-08-14T09:05:00+03:30 — CRM-PRO MERGED + IRAN DEPLOYED ✅

- **Owner approval:** explicit merge + pull/SFTP + restart + SW bump
- **FF-merge:** `origin/claude/claude-md-docs-2ssrpy` = `eae0a14..d3b6136` (from `ai/CRM-PRO-ANALYTICS-crm-dashboard`)
- **Iran deploy:** SFTP overlay (`scripts/_deploy-crm-pro-v154-sftp.py`); VPS dirty so no `git pull`; `pm2 restart erp-taranom` **without** `--update-env`
- **Stamp:** `.sftp-deploy-stamp-crm-pro-v154` → `SFTP_CRM_PRO_V154=2026-08-14T05:33:42Z hash=d3b6136`
- **VPS verify:** health/ready/root 200; `CACHE='erp-taranom-v154'`; `app.js?v=154`; crm-pro-analytics + crm route + Chart.js present; PM2 online
- **Public:** `https://erp.poshaktaranom.com/sw.js` = v154
- **Task:** `completed`; claims empty; Reviewer a092902a + Security 16b3d555 APPROVED

## 2026-08-14T09:00:00+03:30 — CRM-PRO owner approved merge + Iran deploy

- Owner explicit: merge + pull/SFTP + restart + SW bump
- Task → `completed`; claims released
- SW `erp-taranom-v154` / `app.js?v=154`
- Dual approval already on file (Reviewer a092902a, Security 16b3d555)

## 2026-08-14T05:00:00+03:30 — CRM-PRO dual APPROVED (task still active; no deploy)

- Independent Reviewer [Review](a092902a-0680-44f5-bd5c-4323c524fc44): **APPROVED** (no High/Medium)
- Independent Security [Review](16b3d555-0b6b-44b3-bec4-2b939e933dda): **APPROVED**
- Task remains `active` — **not** `completed`; claims kept until owner says complete
- **NO Iran deploy** without explicit separate owner approval
- Tests: analytics 33/33 · RBAC 17/17 · UI 17/17 · perf 8/8 · SMS 22/22 · sync 44/44
- SW still v153 (no bump; browser smoke on production not done)

## 2026-08-14T04:40:00+03:30 — CRM-PRO review-fix (High/Medium closed; re-review needed)

- Independent Reviewer [Review](a092902a-0680-44f5-bd5c-4323c524fc44): CHANGES_REQUIRED (H1 filters, H2 drill reconcile)
- Independent Security [Review](16b3d555-0b6b-44b3-bec4-2b939e933dda): NOT_APPROVED (SEC-001 GET segmentation, SEC-002 v10, SEC-003 followup IDOR, SEC-004 automations)
- **Fixes applied:** shared addInv/addOpp/addCust filters + dates/geo/segment; drilldown uses DRILL_METRICS allow-list; GET segments/churn/profile read-only; `sync_seq_backfill_v10`; followup POST/PUT customer scope 403; automations `crmEdit`+`centralOnlyStrict`; campaign/source lead counts scoped; export uses `audit()`; by-customer requires view + 403 if missing
- **Tests:** analytics 32/32 · RBAC 17/17 · UI 17/17 · perf 8/8
- Task still `active`; NO completed; NO Iran deploy
- **Exact next:** re-review by same independent identities; browser smoke; commit on feature branch

## 2026-08-14T04:10:00+03:30 — CRM-PRO-ANALYTICS implementation gates green (no deploy)

- **Task:** still `active`; review_status/security_status still PENDING
- **Fix:** `migrateFollowupsToOpportunities` after stamp still backfills customers with followups/invoices and no opportunity (no duplicates). Test seeds then backfills then asserts idempotent rerun.
- **Sync hygiene:** `crm_customer_segments` now `compositeKeys: ['customer_id']`; PATH `/api/crm/segmentation`; `/api/crm/automations` blocklisted from device capture
- **Help:** admin pipeline stages aligned to 8-stage model; sales guide has داشبورد CRM
- **Gates:** analytics 28/28 · RBAC 11/11 · UI 17/17 · perf 8/8 · ACC-CRM dash 21/21 · SMS 22/22 · sync 44/44 · encoding PASS · diag mismatches=[]
- **NOT done:** SW bump · Iran deploy · `completed` · Independent Reviewer/Security APPROVED
- **Exact next:** browser smoke + dual independent review; commit on feature branch only

## 2026-08-14T03:10:00+03:30 — CRM-PRO-ANALYTICS claimed (pre-implementation)

- **Task:** `CRM-PRO-ANALYTICS` status=`active`; owner `cursor:orchestrator-crm-pro`
- **Implementer:** `cursor:implementer-crm-pro`
- **Reviewer / Security:** `cursor:independent-reviewer-crm-pro` / `cursor:independent-security-crm-pro` (≠ Implementer)
- **Branch / worktree:** `ai/CRM-PRO-ANALYTICS-crm-dashboard` /
  `D:/soft/Claud/porje/Run in the project/erp-taranom-crm-pro-analytics` @ base `eae0a14`
- **Not used:** dirty `erp-taranom1` (only unrelated `scripts/_deploy-mdi-v152-sftp.py`)
- **Root cause of limited CRM:** dashboard is KPI cards + tables; pipeline SQL groups `followups.status` (open/done/cancel) instead of `pipeline_stage`; no Chart.js; date filters wired but not rendered; no mock-free professional analytics
- **Decision:** add `crm_opportunities` / `crm_activities` / `crm_stage_history` (+ campaigns, lead sources, segments, automation log). Keep `followups` as daily activity UI; migrate stage onto one opportunity per customer; no financial rewrite
- **Constraint:** NO `completed` and NO Iran deploy until Independent Reviewer + Security Approved + explicit owner deploy approval
- **Exact next:** schema + analytics APIs + dashboard charts + tests

## 2026-08-13T01:06:00+03:30 — ACC-CRM-UNIFY MERGED + IRAN DEPLOYED ✅

- **Owner approval:** explicit 100% OK for merge + primary + deploy
- **FF-merge:** `origin/claude/claude-md-docs-2ssrpy` = `448a8c1..aa1ee64` (from `ai/ACC-CRM-UNIFY-accounting-crm`)
- **Iran deploy:** SFTP overlay (script `scripts/_deploy-acc-crm-unify-sftp.py`); `pm2 restart erp-taranom` **without** `--update-env`
- **Stamp:** `.sftp-deploy-stamp-acc-crm-unify` → `SFTP_ACC_CRM_UNIFY=2026-08-12T21:36:19Z hash=aa1ee64`
- **VPS verify:** health/ready/root 200; `CACHE='erp-taranom-v151'`; `app.js?v=151`; crm + sales-document present
- **Public:** `https://erp.poshaktaranom.com/sw.js` = v151
- **Task remains:** `completed`; claims empty; no further ACC-CRM gate work

## 2026-08-12T24:15:00+03:30 — ACC-CRM-UNIFY COMPLETED (dual Approved; no deploy)

- **Independent Reviewer:** APPROVED (agent 09471755) — prior High/Medium closed on `c0ed4c9`
- **Security:** APPROVED (agent 5f0954d9) — M1 cheque txn idempotency closed
- **Tip:** code `c0ed4c9` · stamp `fe2f1da` · branch `ai/ACC-CRM-UNIFY-accounting-crm`
- **Task:** `completed`; `file_claims: []`; review_status=APPROVED; security_status=APPROVED
- **NOT done:** merge to primary · Iran SFTP/deploy — need explicit owner approval

## 2026-08-12T24:00:00+03:30 — ACC-CRM-UNIFY Phase 8a review-fix (`c0ed4c9`)

- Closed Independent Reviewer Highs: CRM receivables ×10 removed; Jalali dates for overdue/inactive/cheque-due KPIs; invoice amount_rial no longer `final*10`
- Closed Mediums: ensureAllUserParties after unify; void COGS debit_rial||debit×10; cheque send/clear/bounce/resend idempotency+lifecycle inside `db.transaction` with conditional UPDATE
- Tip: `c0ed4c9` — still NOT completed; awaiting re-review; NO deploy

## 2026-08-12T23:40:00+03:30 — ACC-CRM-UNIFY Phase 7 GREEN (full gates)

- **Task:** still `active` — awaiting Independent Reviewer + Security; NO deploy
- **Tip:** `0d043fd` (Phase 6 stamp on `bce9943`)
- **Gates (clean tip):**
  - `git diff --check` OK · `node --check` server/app OK
  - encoding guard PASS (BOM, 584 Persian)
  - audit waivers OK
  - party **22/22** · reports **15/15** · phase6 **13/13** · dashboard **21/21**
  - perpetual **44/44** · sms **22/22** · sync **44/44**
  - diag mismatches=[]
  - `test:production` **ALL GREEN** (~13m)
  - embedded prepare+compare **diff=0** (desktop/android 258)
  - secret scan: only ephemeral test harness passwords (no production secrets)
- **Next:** Phase 8 dual review (identities ≠ implementer); do NOT completed/claims/deploy until Approved

## 2026-08-12T22:55:00+03:30 — ACC-CRM-UNIFY Phase 6 GREEN (medium edges)

- **Task:** still `active` — CHANGES_REQUIRED / NOT_APPROVED; NO deploy
- **Fixes:** ADR #5/#13–15; cheque PATCH financial synonyms blocked + bounce→resend; `CACHE._invProducts` for WH picker; `new_customers` respects Jalali from/to via `created_at`; Help+SW v151
- **Tests:** phase6 **13/13**; dashboard **21/21**; reports **15/15**
- **Next:** Phase 7 full gates on clean tip

## 2026-08-12T22:25:00+03:30 — ACC-CRM-UNIFY Phase 5 GREEN (firm-sale reports)

- **Task:** still `active` — CHANGES_REQUIRED / NOT_APPROVED; NO deploy
- **Fixes:** `firmSaleTypeSql` / `commissionEligibleSql` / `autoApproveNormalInvoice`; revenue/AR/P&L/VAT/KPIs include `normal|final`; Moadian + pending approval + seasonal-169 remain final-only; ADR decision #12
- **Tests:** `test-acc-crm-reports.js` **15/15**
- **Next:** Phase 6 — warehouse gate ADR, cheque enum/bounce→resend, product CACHE, new-customer from/to

## 2026-08-12T20:40:00+03:30 — ACC-CRM-UNIFY Phase 4 GREEN (party migration)

- **Task:** still `active` — CHANGES_REQUIRED / NOT_APPROVED; NO deploy
- **Fixes:** no silent `UPDATE users SET party_id=NULL` on conflict; conflict → `E_PARTY_ALREADY_LINKED` + revert requester link; `runAccCrmUnifyV1` transactional reconcile (keep lowest user id, audit_log + settings snapshot, UNIQUE index) stamps `acc_crm_unify_v1=1` only on success; failure rethrows (boot fails)
- **Tests:** `test-acc-crm-party.js` **18/18** (duplicates, idempotency, retry after unstamp, keep-lowest, implicit bind, no silent NULL)
- **Next:** Phase 5 — firm-sale reports (`normal|final`) + ADR classification vs Moadian final-only

## 2026-08-12T20:25:00+03:30 — ACC-CRM-UNIFY Phase 3 GREEN (CRM RBAC)

- **Task:** still `active` — CHANGES_REQUIRED / NOT_APPROVED; NO deploy
- **Fixes:** `resolveEffectiveUserId` ignores client `user_id` when scoped (incl. 0); CRM routes `requirePermission('followups','view')`; cheque KPIs scoped via customer_id/party_id; timeline cheque binding stable IDs + unique-name legacy only; `cheque_records.party_id/customer_id/lifecycle_status` columns
- **Tests:** dashboard unit+HTTP green (override/0/drilldown/same-name/cheque scope)
- **Next:** Phase 4 migration transaction-safety + E_PARTY_ALREADY_LINKED

## 2026-08-12T19:45:00+03:30 — ACC-CRM-UNIFY Phase 2 GREEN (money/rial)

- **Task:** still `active` — CHANGES_REQUIRED / NOT_APPROVED; NO deploy
- **Fixes:** purchases no `*10`; valuation rows use landed `amount_rial`; sales-document purchase/return rial-only; sales_returns.cost_amount rial end-to-end; JE uses `rialToLedger(costAmount)` correctly
- **Tests:** `test-acc-crm-perpetual.js` **44/44** incl. avg=40000, GL==ledger, discount 450000, COGS=3×40000, return JE==ledger, void reverse
- **Next:** Phase 3 CRM RBAC (scopeUserId ignore override; cheque scope; negative HTTP)

## 2026-08-12T19:25:00+03:30 — ACC-CRM-UNIFY Phase 1 GREEN (encoding restore)

- **Task:** still `active` — CHANGES_REQUIRED / NOT_APPROVED; claims retained; NO deploy
- **index.html:** restored from `448a8c1` UTF-8+BOM (584 Persian chars, 0 `???` runs); only intentional ACC-CRM edit re-applied was asset `?v=` bump → **v150** after UI confirm
- **Guard:** `node server/scripts/check-ui-encoding.js` PASS
- **HTTP smoke:** `/` 200 persian=584 hasLogin/hasUser/title true; login 200
- **Screenshots:**
  - `docs/architecture/ui-baseline/phase1-login.png` (Chrome headless live login — Persian readable)
  - `docs/architecture/ui-baseline/phase1-shell-admin.png` / `phase1-crm-dashboard.png`
  - `phase1-login.html`, `phase1-crm-dashboard.json` (CRM dashboard status 200)
- **SW:** `erp-taranom-v150` (bumped only after UI confirm)
- **Parallel:** Phase 2 money + Phase 3 RBAC agents running; not committed in this phase
- **Next:** await Phase 2/3 green → commit each separately → Phase 4 migration

## 2026-08-12T19:05:00+03:30 — ACC-CRM-UNIFY Phase 0 GREEN (baseline + ports)

- **Task:** still `active` — `CHANGES_REQUIRED` / Security `NOT_APPROVED` unchanged; claims retained
- **Tip before this commit:** `d5a2f51`; Phase 0 commit pending
- **Harness:**
  - `server/scripts/lib/test-server-boot.js` — `pickFreePort`, `assertPortsFree`, Windows `taskkill /T /F`
  - `ACC_CRM_TEST_PORT` (perpetual) + `SYNC_TEST_PORT_BASE` (sync e2e)
  - `run-acc-crm-baseline.js` serial runner
  - sync stop/restart: await kill + `waitPortFree` + `waitForServer` (fixes EADDRINUSE / ECONNREFUSED flake)
- **Baseline evidence (serial, isolated DB/ports):**
  - party PASS (~20s)
  - dashboard PASS (~12s)
  - perpetual **34/34** PASS (~27s) on free/fallback port
  - sms **22/22** PASS
  - `_diag-sync-gaps` mismatches=[]
  - test-sync on ports **4120/4121/4122**: **PASS** (exit 0) after stop/restart harden
- **CHANGE-LOG:** preserved prior dirty stamp `d5a2f51` + added Phase 0 entry
- **NO deploy / merge / completed**
- **Next:** Phase 1 — restore `index.html` UTF-8 from `448a8c1`, re-apply ACC-CRM edits, encoding guard, browser smoke

## 2026-08-12T18:50:00+03:30 — ACC-CRM-UNIFY Phase 0 start (remediation; CHANGES_REQUIRED)

- **Task:** still `active` — review_status=`CHANGES_REQUIRED`, security_status=`NOT_APPROVED`
- **Do NOT:** completed / release claims / merge / Iran deploy / mark Approved
- **Worktree:** `D:/soft/Claud/porje/Run in the project/erp-taranom-acc-crm-unify`
  branch `ai/ACC-CRM-UNIFY-accounting-crm` @ tip was `d5a2f51` (reviewed); base `448a8c1`
- **Dirty file at session start:** only `docs/CHANGE-LOG.md` (stamp Commit `d5a2f51` instead of pending).
  Preserved — no overwrite of user/content intent; included in Phase 0 commit.
- **File claims:** retained + appended `server/scripts/lib/test-server-boot.js`,
  `run-acc-crm-baseline.js`, `check-ui-encoding.js` (encoding guard reserved for Phase 1)
- **Phase 0 scope:** configurable ports (`ACC_CRM_TEST_PORT`, `SYNC_TEST_PORT_BASE`),
  Windows process-tree kill (`taskkill /T /F`), serial baseline runner, record ownership/git
- **Next:** finish Phase 0 baseline evidence → commit → Phase 1 encoding restore
- **Parallel discovery:** Accounting/RBAC/Migration inventory + UI encoding inventory agents

## 2026-08-11T20:15:00+03:30 — ACC-CRM-UNIFY implementation checkpoint (waves 0–6 code-complete, pre-review)

- **Task:** `ACC-CRM-UNIFY` still `active` — NOT completed; **NO Iran deploy**
- **Branch/worktree:** `ai/ACC-CRM-UNIFY-accounting-crm` / `D:/soft/Claud/porje/Run in the project/erp-taranom-acc-crm-unify` @ base `448a8c1`
- **Waves 0–6 code-complete:**
  - `normal` invoice type; firm sale = `normal|final` → stock via `postInventoryMovement` + sales JE + COGS JE; Moadian only `final`; proforma no effects
  - Purchases + purchase returns + sales returns + voids all on perpetual path behind `feature_perpetual_docs` (default on); void reverses from `inventory_ledger`
  - `sales-returns` now perpetual: `postSaleReturnStockMovements` (sale_return qtyIn, real avg cost) + `reverseStockBySource` on cancel + `assertJournalIdempotent`
  - Cheque lifecycle transitions (`send-to-bank`/`clear`/`bounce`) guarded with `assertJournalIdempotent` (`E_JE_DUPLICATE`) + error codes `E_CHEQUE_LIFECYCLE`
  - `users.party_id` unique binding (`E_PARTY_ALREADY_LINKED`); migration `acc_crm_unify_v1`
  - UI: legacy route redirects in `go()` (kardex canonical `acc-item-kardex`, normal/final invoice pages, crm); MDI taskbar fixed bottom with real `--mdi-taskbar-h`; CRM group (پیگیری‌ها + داشبورد) + customer history modal now uses `/api/crm/timeline` (invoice+settlement+return+followup) with followups fallback; SW v149
  - `/api/crm` read-only (GET only) — no sync capture needed
- **Gates so far:** perpetual **34/34**, party **5/5**, dashboard **8/8**, SMS **22/22**, diag `mismatches=[]`, app.js parse OK, lints clean
- **Sync gate:** initially failed twice (boot timeout under a concurrent Next.js build), then exposed TWO real bugs once boot succeeded:
  1. warehouse gate broke legacy device flows (no header warehouse_id / no warehouse_stock row) → fixed with per-line fallback to product home warehouse + legacy seed semantics (`E_WH_MISMATCH` stays strict 409)
  2. `inventory_ledger.tx_no` UNIQUE collision on devices (local counter vs pulled central INV-xxxx) → devices now issue provisional `موقت-INV-…`, central allocates real numbers on replay (mirrors invoice numbering)
  After fixes: **test-sync 44/44 green** including oversell conflict now surfacing as `E_WH_INSUFFICIENT` reason.
- **Harness fixes:** both `test-acc-crm-perpetual.js` and `test-sync.js` strip HTTP(S)_PROXY for loopback + tunable boot timeout (`SYNC_TEST_BOOT_TIMEOUT_MS`)
- **Second audit findings closed:** cheque free-text status PATCH blocked for lifecycle transitions (`E_CHEQUE_USE_LIFECYCLE`); modal no longer zeroes `--mdi-taskbar-h`; timeline adds sales_return+cheque kinds; `NAV_ACCOUNTING` got CRM group; followups scope aligned with `crmScopeUserId` (sales_manager/accounting full)
- **Next:** production gates → commit+push branch → Independent Reviewer + Security (separate identities) → owner approval before any deploy/merge

## 2026-08-10T20:10:00+03:30 — Independent Reviewer re-verification APPROVED (PROD-P5-R2)

- Role: Independent Reviewer (orchestrator + parallel agents); **no product code changes**
- Scope: tip `1728626` vs base `a152086` on `fix/PROD-P5-R2-review-remediation` @ worktree `erp-taranom-prod-p5-r2`
- Agents: technical [Review](fba7f21e-da4b-4d17-b75c-d995678bde7b); gates [Shell](a3f6f2ad-2572-43b8-95b2-10b8deab0d96); Security [Security](f3d138f1-eac4-476d-bb04-56908174cda2)
- AC: all Pass (T2-05/07/08 ✅; health 5201/5202/5203 zero + ok=true ✅; sensitivity priceOverrides no UPDATE products ✅; embedded diff=0 ✅; BOM editor smoke 54/54 ✅; Security Approved ✅)
- Gates: format/static/audit/advanced 46/46/overhead 38/38/variable 27/27/fixed 36/36/editor-smoke/sms 22/sms; sync **44/44** (retry after transient reconnect flake); diag mismatches=[]; `test:production` ALL GREEN; prepare+compare diff=0; tree clean
- Findings: **None** Critical/High/Medium; Low advisories only (locked param naming; NRV column UI; delta=0 quirk; AutoAddPolicy probe; auto-commit-deploy.mdc out-of-claim)
- Disposition: **APPROVED** — prior `completed` + released claims stand; management docs only updated

## 2026-08-10T19:15:00+03:30 — PROD-P5-R2 completed (merge + Iran SFTP)

- Independent Reviewer: **Approved with comments** (97b82c6e)
- Security: **Approved** (7d68a554)
- Primary FF: `origin/claude/claude-md-docs-2ssrpy` → `33ab46e` (code tip `1728626`)
- Iran SFTP: stamp `.sftp-deploy-stamp-prod-p5-r2` hash=1728626; no blind pull; no `--update-env`
- Probe: app.js / bom-advanced.js / production-boms.js local=remote YES
- Smoke: health/ready/root **200**; priceOverrides present; SW v146
- PROD-P5-R2: **completed**; `file_claims: []`

## 2026-08-10T18:40:00+03:30 — Independent + Security Approved on 1728626

- Independent Reviewer: **Approved with comments** (agent 97b82c6e) — no open High/Medium
- Security (re-review on tip worktree): **Approved** (agent 7d68a554) — High-2 closed (priceOverrides; no UPDATE products); residual auto-commit-deploy.mdc out of R2 claims
- Prior Security Not Approved was false positive (inspected wrong/stale tree)
- status.md aligned; next: merge to primary + Iran SFTP overlay (no blind pull / no --update-env); then completed + release claims
## 2026-08-10T16:10:00+03:30 — PROD-P5-R2 implementation checkpoint (pre-review)

- **Task:** still `active` — NOT completed; **NO Iran deploy**
- **Branch/worktree:** `fix/PROD-P5-R2-review-remediation` /
  `D:/soft/Claud/porje/Run in the project/erp-taranom-prod-p5-r2` @ base `a152086`
- **High-1:** `ERP_TEST_ISOLATION` + unique `COMPANIES_DIR` in `freshDb`; T2-05/07/08 PASS; health 5201/5202/5203 zero; pack×20/×25 regression PASS
- **High-2:** `sensitivity` uses in-memory `priceOverrides` via `getPrice`/`explodeBom`/`rollUpBom`; tests sens-a..d PASS; no `UPDATE products`
- **High-3:** `prepare-embedded-server all` + `compare-embedded-hash` → desktop/android **diff=0** (251 files)
- **Medium-1:** ops/outputs CRUD + auto-share UI + E_* map + Help path; smoke **29/29**
- **Medium-2:** canonical `https://erp.poshaktaranom.com`; probe/smoke scripts + `docs/08-deployment.md`
- **Next:** full P0–P5 gate suite on one commit → Independent Reviewer + Security (no deploy)

## 2026-08-10T15:40:00+03:30 — PROD-P5-R2 claimed (corrective reopen)

- **Task:** `PROD-P5-R2` status=`active`; owner `cursor:implementer`
- **Reviewer / Security:** independent identities `cursor:independent-reviewer` / `cursor:independent-security` (not Implementer)
- **Branch / worktree:** `fix/PROD-P5-R2-review-remediation` /
  `D:/soft/Claud/porje/Run in the project/erp-taranom-prod-p5-r2`
- **Base:** `origin/claude/claude-md-docs-2ssrpy@a152086` (clean worktree; NOT erp-taranom1)
- **PROD-P5:** status=`superseded` (invalid completion); claims empty
- **Constraint:** NO `completed` and NO Iran deploy until High/Medium closed + full P0–P5 gates + Independent Reviewer Approved + Security Approved
- **Scope High:** P2 fixed T2-05/07/08 + health 5201/5203; sensitivity read-only; embedded prepare/hash diff=0
- **Scope Medium:** BOM editor CRUD+template+resequence+Help; deploy evidence/domain/hashes/role smoke
- **Exact next:** parallel diagnose High-1/High-2; then implement on claimed files only

## 2026-08-10T14:40:00+03:30 — Applied to program (merge + Iran SFTP)

- Merge primary: `889b61b` pushed to `origin/claude/claude-md-docs-2ssrpy`
- Feature tip: `5fb2276` (getBom) / remedia `6271a3f` / docs `5ae889c` / handoff `d571af9`
- Iran SFTP: stamp `.sftp-deploy-stamp-prod-p5-rereview`; smoke `root=200 health=200 ready=200`; getBom/tree/compare wraps verified on VPS
- Independent Reviewer: Approved with comments; Security: Approved (no open High/Medium)
- PROD-P5: completed; claims released
# Handoff Log

Newest entries are added at the top. Never erase another agent's record.

## 2026-08-10T14:20:00+03:30 — Independent + Security re-review Approved → apply

- Tip code: `5fb2276` (+ docs stamp `5ae889c`)
- Independent Reviewer: **Approved with comments** (getBom Medium closed; 38/38)
- Security: **Approved** for R11/operator cost-leak scope (no open High/Medium on production-boms.js)
- Next: merge to `claude/claude-md-docs-2ssrpy` + precise Iran apply; then mark PROD-P5 completed / release claims

## 2026-08-10T13:55:00+03:30 — close Independent Reviewer Medium (getBom R11)

- Independent Reviewer on `6271a3f`: **Changes requested** — Medium bypass via `GET /:id` / `/tree` / `/compare`
- Security on `6271a3f`: **Approved with comments** (same residual GET /:id)
- Fix applied (pending commit): wrap `applyCostPolicy` on GET `/:id`, `/:id/tree`, `/compare` + regression getBom-shape
- Raw: advanced **38/38 PASS**
- Task remains **active** until re-review Approved; **no Iran deploy yet**

## 2026-08-10T13:35:00+03:30 — PROD-P5 remediation evidence (pre re-review)

- **Task:** still `active` — NOT completed; **NO Iran deploy**
- **Branch/worktree:** `ai/PROD-P5-advanced-bom` / `D:/soft/Claud/porje/Run in the project/erp-taranom-prod-p5`
- **Remedia commit:** `6271a3f` (pushed to `origin/ai/PROD-P5-advanced-bom`)
- **Base tip before remedia commit:** `45961c4`
- **Diffstat (staged for remedia):**
  ```
  .ai-dos/project/status.md                      |  30 +++----
  .ai-dos/tasks/active.yaml                      | 112 +++++++++++++------------
  .ai-dos/tasks/handoff.md                       |  18 ++++
  docs/CHANGE-LOG.md                             |  19 +++--
  server/routes/production-boms.js               |  14 ++--
  server/scripts/test-production-bom-advanced.js |  47 +++++++++--
  6 files changed, 150 insertions(+), 90 deletions(-)
  ```
- **10 items status:**
  1. CHANGE-LOG full tip — DONE (this remedia entry)
  2–5. GET std-cost/ops/outputs/explode/routing `applyCostPolicy` — VERIFIED (tip `ac078a7`)
  6–7. resequence `assertDraftBom` + test `E_BOM_LOCKED` — VERIFIED
  8. `applyCostPolicy` + `production_operator` + POST/PUT row shapes — DONE (37/37)
  9. diag `mismatches=[]` — PASS
  10. full gates PASS; independent re-review PENDING
- **Extra Medium closed:** POST/PUT ops/outputs + resequence responses wrapped with `applyCostPolicy`
- **Raw gates:**
  - advanced: `P4 Advanced BOM: ✅ 37 پاس`
  - overhead: `P4 Overhead + Labor: ✅ 38 پاس`
  - variable: `P3 Variable: ✅ 27 پاس`
  - sms: `🎉 22 passed, 0 failed`
  - sync: `🎉 44 passed, 0 failed` (retry without `SYNC_ROLE=device`)
  - diag: `{"mismatches":[],"registryMissing":[],"hasOldDebug":false,"count":147}`
  - audit waivers: `Dependency gate OK`
- **Next:** commit+push remedia → Independent Reviewer + Security re-review → only if Approved: merge/apply to program (still no premature completed)

## 2026-08-10T12:55:00+03:30 — PROD-P5 REACTIVATED for Independent Review remediation

- **Task:** `PROD-P5` status=`active` again; file_claims restored; owner `cursor:orchestrator`
- **Constraint:** NO `completed` and NO Iran deploy until High/Medium closed + full tests + independent re-review
- **10 corrective items listed in active.yaml `corrective_items`**

## 2026-08-10T11:45:00+03:30 — PROD-P5 security remediation (post-review)

- **Security:** [Security Review](be434b0a-32ae-4e19-8f58-dbb653ddc5d1) → **Approved with comments**; remediated medium findings in `ac078a7`
- **Fixes:** `applyCostPolicy` on GET operations/routing/outputs/explode/std-cost; `assertDraftBom` in `resequenceOperations`; regression tests (suite **34/34**)
- **Next:** push `ac078a7` → primary merge → Iran SFTP overlay of 3 server files + CHANGE-LOG

## 2026-08-10T11:20:00+03:30 — PROD-P5 complete: merge + Iran SFTP

- **Task:** `PROD-P5` / `cursor:orchestrator` → **completed**; `file_claims` released
- **Merge:** `4306168` on `claude/claude-md-docs-2ssrpy` (from `ai/PROD-P5-advanced-bom` tip `9878f11`)
- **Agents:** sync PATH ([Sync](350cf600-4c0a-49da-bc45-d3117f44fe92)); API routes ([API](7d05729c-6331-424b-99b1-2dae2df10cc6)); UI ([UI](2804c4ab-2d16-41b7-9fad-d2e3ac89c75e)); tests orchestrated locally after seed UNIQUE fix; reviews ([Reviewer](1178c628-2f0f-4eaf-8307-46194d7e42ad), [Security](560d0fca-e2bd-438b-956f-89a645453f95))
- **Tests:** advanced **32/32**; overhead 38/38; variable 27/27; sms 22/22; sync **44/44** (retry); `_diag-sync-gaps` mismatches=[]
- **Deploy:** SFTP overlay to `taranom@94.249.244.208` (no blind pull); stamp `.sftp-deploy-stamp-prod-p5`; HTTP `/=200` `/health=200` `/ready=200`; pm2 online; no `--update-env`
- **Delivered:** bom-advanced helpers, ops/outputs PATH map + FK appends, routes+R11, BOM 4 tabs + Help, CHANGE-LOG
- **Next:** P6 advanced fixed execution only when owner selects; leave `ai/W1-*` alone

## 2026-08-09T17:05:00+03:30 — PROD-P5 preflight claimed (no app code yet)

- **Task / owner:** `PROD-P5` / `cursor:orchestrator` (roles: architect/implementer/reviewer/security recorded in `active.yaml`)
- **Branch / worktree:** `ai/PROD-P5-advanced-bom` @ `D:/soft/Claud/porje/Run in the project/erp-taranom-prod-p5`
- **Base:** created from `origin/claude/claude-md-docs-2ssrpy` @ `55b287d` (clean; tracks primary)
- **Claim conflicts:** none — prior PROD-P3/P4/W2-ORCH completed with empty `file_claims`
- **Primary `erp-taranom1`:** untracked noise + historically behind origin — **do not implement there**
- **Avoid:** all `ai/W1-*` worktrees/branches; Wave 2 exit ops (pilots/SLA)

### Scope
- **In:** Module 4 gap-close — routing/`bom_operations`, co/by `bom_outputs`, roll-up golden math, missing helpers (`costTree`, `yieldAnalysis`, `sensitivity`, `breakeven`, `compareScenarios`, `autoShare`) + routes, full BOM editor UI tabs deferred from P4, §18 tests, Help + CHANGE-LOG
- **Out:** P6/P6b execution posting, P7–P10 packs, ledger JE from Module 4, full APK/EXE builds, rewrite of P4 overhead/labor engines

### Acceptance (numeric)
- §6.6 stages + §6.8 breakdown reproduced
- `full-cost?qty=300` matches §15
- cost-tree ≤5s on 5-level tree
- zero JE from Module 4
- T4-05 `95.5647`, T4-06 `314`, T4-13 `698324500±1`, T4-15 `2315880`, T4-21 circular, T4-29 V4-21
- Expand `test-production-bom-advanced.js` toward §18 (28); keep P3/P4 suites green

### Risks
1. Golden roll-up drift vs §6 (poisons P6+) — high
2. V4-21 double-count yield if header≠100 with routing — high
3. Shared `db.js` / `app.js` / `server.js` collisions with W1 merges — medium
4. Sync hygiene if new mutating paths — medium
5. UI-only “done” without golden tests — process risk

### Implementation plan (ordered)
1. **Baseline in worktree:** run existing `test-production-bom-advanced.js` + P3/P4 suites; inventory FAIL/missing T4 ids
2. **Service gap-close:** implement missing exports in `bom-advanced.js`; harden `validateAdvancedBom` V4-01..V4-21
3. **API:** add/complete routes for cost-tree / sensitivity / breakeven / compare / autoShare / CRUD gaps; sync `PATH_TABLE_MAP` only if new prefixes
4. **UI:** BOM tabs [اقلام|مسیر عملیات|خروجی‌ها|بهای تمام‌شده], template button, cost card; Help update
5. **Tests + gates:** full advanced suite; `test-sms` + `test-sync`; `git diff --check`; `node --check server/server.js`; `check-audit-waivers`; frontend parse
6. **Independent reviewer + security** (high risk) before merge/deploy
7. Merge to primary + Iran deploy per project rules (no blind VPS reset; no `--update-env` unless secrets confirmed)

### Validation commands (from worktree)
```powershell
cd "D:/soft/Claud/porje/Run in the project/erp-taranom-prod-p5"
git diff --check
node --check server/server.js
node server/scripts/check-audit-waivers.js
node server/scripts/test-production-bom-advanced.js
node server/scripts/test-production-overhead-labor.js
node server/scripts/test-production-variable.js
node server/scripts/test-sms.js
node server/scripts/test-sync.js
# frontend script parse (index.html or app.js per surface touched)
```

### Rollback
- Branch abandon / revert commit on `ai/PROD-P5-advanced-bom` before merge
- After merge: revert merge commit; do not blind-reset dirty Iran VPS — targeted SFTP/ff only
- Schema: `ensureColumn` is additive; no physical delete of financial docs

### Exact next action
Implementer enters worktree, re-reads AI-DOS load order + claim, runs baseline tests, then starts phase 2 — **still no edits in primary `erp-taranom1`.**

### Architect disposition ([Architect](da8fcbf0-ccc4-42d9-8828-bcef44a316f8))
- Engine ~55–65% present; P5 = gap-close + UI + §18 completeness (not rewrite).
- **Blocker-class sync:** `PATH_TABLE_MAP` maps only `/api/production/boms` → `bom_headers`; mutating `/operations` & `/outputs` capture wrong table — longer prefixes must sit **above** generic boms.
- FK append candidates: `bom_operations.subcontract_supplier_id`, `bom_outputs.stage_cost_center_id`.
- T4-13 harness tolerance ±50 violates AC ±1; some T4 IDs mislabeled vs §18.
- R11: `full-cost` should apply cost-strip policy defense-in-depth.
- Prefer thin helpers + 4 tabs in existing BOM UI in `app.js`; no new framework.

Parallel preflight agents: claim-audit, roadmap-priority, gates-plan, architect — complete.

## 2026-08-09T14:05:00+03:30 — PROD-P4 merge to primary + Iran deploy

- Merging `origin/ai/PROD-P4-overhead-labor` into primary (`claude/claude-md-docs-2ssrpy`).
- Code clean-merged: `overhead.js`, `labor.js`, `production-cost-centers.js`, `test-production-overhead-labor.js` (38/38).
- SSH production: `taranom@94.249.244.208` key `~/.ssh/id_ed25519_taranom` — ff-pull only, no dirty reset.
- Docs conflicts resolved (CHANGE-LOG / AI-DOS status/active/handoff).

## 2026-08-09T05:35:00+03:30 — PROD-P4 integration complete

- Evidence: `test-production-overhead-labor.js` → **38/38 PASS** on `ai/PROD-P4-overhead-labor` (`d0465ac`).
- Deliverables: overhead bootstrap (toman×10), four labor methods, cost-center rates PUT/bootstrap API.

## 2026-08-09T13:50:00+03:30 — PROD-P3 finalize complete

- Merged primary into `ai/PROD-P3-variable-analysis` @ `fefedda`; FF-pushed to `claude/claude-md-docs-2ssrpy`.
- Tests: `test-production-variable.js` 27/27 PASS; SW v144.
- Deploy Iran: targeted SFTP (`scripts/_deploy-prod-p3-sftp.py`) — health 200, ready 200, VARIANCE=YES; pm2 restart without `--update-env`.
- Claims released; task completed.

## 2026-08-09T13:20:00+03:30 — PROD-P3 finalize (merge primary + deploy)

- Merged `origin/claude/claude-md-docs-2ssrpy` into `ai/PROD-P3-variable-analysis`.
- Tests: `test-production-variable.js` 27/27 PASS; SW v144.
- Deploy: targeted SFTP (no blind VPS pull).

## 2026-08-09T05:35:00+03:30 — W2-ORCH: six MVP slices merged

- Task / owner: `W2-ORCH` / `cursor:implementer`
- Branch tip: `d411f0e` on `ai/W2-ORCH-wave2` (worktree `erp-taranom-w2-orch`)
- Merged slices:
  - O1 observability `07bf7e3`
  - M3 onboarding `29d4f67`
  - M1 license `22dce30`
  - F5 bank recon `55415a6`
  - B2B credit `317dd6d` (db.js conflict resolved: both `initLicenseSchema` + `initB2bSchema`)
  - HR export `5486ca8`
- Agent evidence tests (pre-merge, per slice): license 24/24, onboarding 29/29, b2b-credit 19/19 + b2b 34/34, bank-recon 24/24, payroll-export+accounting green, observability 9/9, sms 22/22
- Orch re-validation (NODE_PATH / local node_modules): license 24/24, onboarding 29/29, b2b-credit 19/19 (harness wait+SYNC_ROLE fixed), bank-recon 24/24, payroll-export green, observability 9/9, sms 22/22
- Deploy: ✅ Iran production at `b4b653b` (2026-08-09); health/ready/root 200; tracked dirty stashed as `w2-pre-deploy-tracked`
- Residual gaps: full Wave-2 exit gate (paid pilots, support SLA); HR CSV draft; B2B consume-on-invoice; bank 1:N matching; license max_users/feature UI; onboarding wizard UI
- Do not claim Wave 2 complete. P1 remains other agents' `ai/W1-*`.
- Primary branch `origin/claude/claude-md-docs-2ssrpy` FF'd to `b4b653b`.

## 2026-08-09T04:55:00+03:30 — W2-ORCH claimed; P1 work by this owner abandoned

- Owner clarified: this Cursor session owns **Wave 2 / P2**, not Wave 1.
- Abandoned/cleaned local `ai/W1-001-moadian-ops` worktree (never pushed). Did **not** touch other agents' `ai/W1-*` worktrees.
- Active task: `W2-ORCH` on `ai/W2-ORCH-wave2` at `D:/soft/Claud/porje/Run in the project/erp-taranom-w2-orch`.
- Next: parallel MVP implementers for license, onboarding, B2B, treasury/cheques, HR legal export, observability/support; orch merges.

## 2026-08-09T05:00:00+03:30 — W0-OPS-002 completed under permanent owner waiver

- Owner accepted permanent production waiver `W0-OPS-002-SHARP-RUNTIME-0335` with **no expiry**: VPS runtime may remain `sharp@0.33.5`; source/CI stay `0.35.0`.
- Task status: **completed**; `file_claims` released; `.ai-dos/tasks/active.yaml` cleared.
- Wave 0 exit: closed. **Ready for Wave 1 / P1** when owner selects scope.
- Residual (not blockers): optional CPU upgrade later; S4U; OV/EV; cold backup; restricted publisher; fix `auto-commit-deploy.mdc` conflict before autonomous Iran deploys.
- Do not claim production is on `0.35.0`. Do not blind pull/reset dirty VPS or `erp-taranom1`.

## 2026-08-09T04:55:00+03:30 — Independent reviewer disposition

- [Reviewer](bbb4b9b8-47d4-40b4-a61f-459265612f72): **Approved with comments**. Declaring `blocked` (not complete) is correct; AC for production `0.35.0` unmet.
- Comments addressed in claimed script: backup/restore/rollback now include `detect-libc` + `semver` and clean `*.__old` leftovers.
- Raw blocker transcript (from VPS probe, preserved):
  ```
  Model name: QEMU Virtual CPU version 2.5+
  cx16=yes lahf_lm=yes popcnt=NO sse4_1=NO sse4_2=NO ssse3=NO
  Error: Unsupported CPU: Prebuilt binaries for Linux x64 require v2 microarchitecture
  Post-restore: PKG=0.33.5 RT=0.33.5 REQUIRE_OK root=200 health=200
  ```
- Next step confirmed sound: hypervisor `x86-64-v2`/`host` → reboot → flag check → `-Deploy` → pull/drill → attach raw logs before complete claim.

## 2026-08-09T04:50:00+03:30 — Security review disposition + deploy-script hardening

- Independent [security review](5816c075-fa15-4eee-9dc3-639b922c018e): **blocked disposition Approved / completion Not approved**.
- Residual advisory on production `sharp@0.33.5` accepted until CPU upgrade or explicit time-boxed owner waiver.
- High finding (out of this task's file_claims): `.cursor/rules/auto-commit-deploy.mdc` still mandates blind `git pull` + `pm2 restart --update-env` and can bypass the reviewed sharp path — needs separate ownership change before any autonomous Iran deploy.
- Medium findings remediated in claimed `scripts/deploy-sharp-production.ps1`:
  1. SSH `RejectPolicy` + required pinned `known_hosts`
  2. Remote SHA-256 sidecar verify before extract
  3. Auto-rollback from recover stamp if post-PM2 smoke fails
- Task remains `blocked` on CPU; do not claim `0.35.0` deployed.

## 2026-08-09T04:10:00+03:30 — W0-OPS-002 blocked on VPS CPU microarchitecture

- Task / owner / role: `W0-OPS-002` / `cursor:implementer` / Implementer (status=`blocked`).
- Branch / worktree: `ai/W0-OPS-002-sharp-production-deploy` / `D:/soft/Claud/porje/Run in the project/erp-taranom-w0-ops-002`.
- What was done:
  - Created dedicated worktree from `origin/claude/claude-md-docs-2ssrpy`.
  - Added `scripts/deploy-sharp-production.ps1` (inventory / offline Linux bundle / bounded swap / rollback / CPU preflight).
  - Built offline bundle `sharp-0.35.0-linux-x64.tgz` (SHA-256 `8BF9B7FDE5D2933E4B7B1AAB5D0268BE2A3D3B83F83CBE076BF5962F04634ABD`).
  - Attempted production apply twice without `git pull`/`reset`; both failed before PM2 restart; automatic restore kept live modules.
- Production evidence after attempts: `PKG=0.33.5`, `RT=0.33.5`, `REQUIRE_OK`, HTTP `root=200`/`health=200`, PM2 `online`, restarts still `8` (no restart during failed applies).
- Dirty VPS inventory preserved (no blind clean): HEAD `6390bcc`; modified docs/app/sw/releases; untracked `.sftp-deploy-stamp`, `server/_recover/`, `server/backup-encryption-key.txt`, broken APK.
- Blocker: CPU `QEMU Virtual CPU version 2.5+` missing `popcnt sse4_1 sse4_2 ssse3`. Error: `Unsupported CPU: Prebuilt binaries for Linux x64 require v2 microarchitecture`. Wasm needs SSE4.1 → also unavailable.
- Recover stamps retained on VPS: `sharp-20260808T160047Z`, `sharp-20260809T003020Z`, `sharp-20260809T003451Z`, plus uploaded bundle under `server/_recover/bundles/`.
- Exact next action for owner/infra: change hypervisor CPU type to `x86-64-v2` or `host` (expose SSE4.2), reboot guest, then from this worktree run `powershell -File scripts/deploy-sharp-production.ps1 -Deploy`. After success: backup pull + restore drill + independent reviewer/security approval.
- Do not declare W0-OPS-002 complete; do not start Waves 1–4.

## 2026-08-09 — Ownership transferred to Cursor as W0-OPS-002

- `W0-OPS-001` is completed and its claims are released from the active registry; history remains below and in Git.
- New active owner/implementer: `cursor:implementer`; independent role identities: `cursor:reviewer` and `cursor:security`.
- Required branch/worktree: `ai/W0-OPS-002-sharp-production-deploy` at `D:/soft/Claud/porje/Run in the project/erp-taranom-w0-ops-002`.
- Cursor must create the worktree from `origin/claude/claude-md-docs-2ssrpy`, enter it, reread the AI-DOS load order, verify its claim, and only then edit claimed files.
- Exact first setup commands (no destructive action):
  1. `git fetch origin claude/claude-md-docs-2ssrpy`
  2. `git worktree add "D:/soft/Claud/porje/Run in the project/erp-taranom-w0-ops-002" -b ai/W0-OPS-002-sharp-production-deploy origin/claude/claude-md-docs-2ssrpy`
  3. Change directory to that worktree and run the AI-DOS preflight.
- Do not work in dirty `erp-taranom1`; do not blindly pull/reset the dirty VPS. Follow the production rollback evidence in the next handoff entry.

## 2026-08-08T16:12:00Z — Cursor continuation handoff (do not redo completed work)

### Completed and verified

- Source/CI commit `7460857`: GitHub Wave 0 Gate run `31265434377` is 7/7 green. Final documentation commit: `9ae1ba1` (`[skip ci]`). Both are pushed to `claude/claude-md-docs-2ssrpy` and `ai/W0-OPS-001-wave0-ops-close`.
- P0-C is operational: 15-minute Windows pull and weekly restore drill Scheduled Tasks both returned result `0`; latest real drill fingerprints match and RTO estimate is 3s.
- Backup wrapper source is tracked and production hash matches: `d28baf01768fdf21c51bc1a606c89b68b0b563eec8540f444d7f390e22e2afe6`, owner/mode `root:root 0755`; confinement negative tests and contract 26/26 pass.
- APK 2.0.33 / EXE 2.0.10 are published; stage/hash/atomic promote/rollback/HTTP re-hash passed.
- Reviewer: Approved. Security: Approved with documented waivers.

### Production sharp attempt — rolled back safely

- Source/lock use `sharp@0.35.0`; audit has zero unwaived high/critical and image tests pass.
- A targeted VPS `npm install sharp@0.35.0` hung on registry/DNS. It was stopped; no PM2 restart occurred.
- Production was restored from `server/_recover/sharp-20260808T160047Z` and npm cache: `SHARP_ROLLBACK_OK=0.33.5`, PM2 PID `320901`, HTTP root `200`.
- Therefore production runtime is healthy but still on `sharp@0.33.5`; do not claim the production advisory is deployed.

### Cursor next actions, in order

1. **Deploy sharp 0.35.0 without risking production:** wait for stable registry or prepare a verified Linux x64 offline npm cache/tarball bundle; back up package files; install with bounded timeout; require `require('sharp')` + exact version before restart; restart without `--update-env`; HTTP/image smoke; retain rollback. Never leave `node_modules/sharp` missing.
2. **Do not `git pull` blindly on VPS.** `/home/taranom/crm-taranom` is at `6390bcc` and dirty: modified docs, `server/public/app.js`, releases metadata, `sw.js`; untracked deploy stamp, recover directory, encryption key and broken APK. Reconcile/preserve each operational change first, then use a reviewed deploy plan.
3. **Do not fast-forward the user's original local worktree blindly.** `D:/soft/Claud/porje/crm-taranom/erp-taranom1` has user-owned `server/routes/accounting.js` changes and many untracked AI-DOS/docs files. Continue from clean worktree `D:/soft/Claud/porje/Run in the project/erp-taranom-w0-ops` or merge with explicit preservation.
4. Optional hardening: elevated S4U Scheduled Tasks (current Interactive mode does not run logged out), restricted release-publisher replacing broad admin key, immutable/cold offsite generation, commercial Windows OV/EV certificate.
5. Do not start Waves 1–4 until the owner selects priority.

### Required validation after Cursor production dependency deployment

- `node -e "require('sharp'); console.log(require('sharp/package.json').version)"` → `0.35.0`.
- `pm2 describe erp-taranom` online; restart must preserve backup/data encryption env.
- HTTP root/health and one image upload/thumbnail smoke pass.
- New encrypted backup + Windows pull + isolated drill still pass.
- Update `docs/WAVE0-GATE-STATUS.md`, `docs/CHANGE-LOG.md`, this handoff and task files with exact commit/hash/results; commit and push the same branch.

## 2026-08-08T15:43:00Z — W0-OPS-001 complete

- Completion: acceptance criteria met; Reviewer approved; Security approved with documented waivers; no remaining release blocker.
- Final production evidence: wrapper tracked and deployed `root:root 0755` with matching SHA-256 `d28baf01768fdf21c51bc1a606c89b68b0b563eec8540f444d7f390e22e2afe6`; contract 26/26; actual newest pull/drill `crm-backup-20260808-153000.zip.enc`, SHA-256 `2166FB8E9C0F75719F7B87DFA4A01D4F72DA442C4D0553DB53F92986C5A1B866`, fingerprints match, RTO estimate 3s.
- Waivers: broad release-admin key exception was one-RC-only and expired after successful publish; self-signed Windows certificate; Interactive scheduler when logged out; Windows copy is off-server but not immutable/air-gapped.
- Remaining follow-up (not a W0-OPS-001 blocker): restricted release-publisher architecture, elevated S4U installation, remote CI/staging automation evidence, optional OV/EV and immutable cold copy.
- CI follow-up: first remote run exposed new `sharp <0.35.0` advisory; upgraded to `sharp@0.35.0`. Local dependency gate has zero unwaived high/critical; upload security 55/55 and sync-file 19/19 PASS.
- Final CI: GitHub Wave 0 Gate run `31265434377` on `7460857` completed successfully with 7/7 jobs. Weekly restore Scheduled Task was also registered and manually executed with result `0` (next Sunday 03:00).

## 2026-08-08T15:36:00Z — W0-OPS-001 implementation checkpoint

- Task / owner / role: `W0-OPS-001` / `codex:root` / Orchestrator, Architect, Implementer.
- Branch / worktree: `ai/W0-OPS-001-wave0-ops-close` / `D:/soft/Claud/porje/Run in the project/erp-taranom-w0-ops`.
- Production evidence: encrypted `crm-backup-20260808-153000.zip.enc` copied to Windows; size `12268025`; SHA-256 `2166FB8E9C0F75719F7B87DFA4A01D4F72DA442C4D0553DB53F92986C5A1B866`; isolated restore `ok=true`, fingerprints match, RTO estimate 3s.
- Access confinement: backup identity defaults to `id_ed25519_taranom_backup` and is forced through tracked/root-owned `/usr/local/sbin/erp-taranom-backup-reader` (`root:root 0755`, local/production SHA-256 `d28baf01768fdf21c51bc1a606c89b68b0b563eec8540f444d7f390e22e2afe6`). Backup list/download passed; secret key, DB, `.env`, private uploads, SFTP, upload, delete and shell were denied.
- Scheduler evidence: `ERP-Taranom-Offsite-Pull`, Limited/Interactive fallback, 15 minutes, actual `LastTaskResult=0`. Logged-out RPO requires a later elevated S4U install.
- Release evidence: APK 2.0.33, EXE 2.0.10, blockmap, `latest.yml`, and `manifest.json` fully staged, SHA-256/SHA-512 verified, atomically promoted with rollback support, and HTTP re-hashed.
- Tests observed: artifact real PASS; offsite contract 25/25; policy 4/4; DR 14/14; uploader 3/3; embedded desktop/android 224 each with diff=0; `git diff --check` PASS.
- Review/security disposition: path-confinement, unsafe default identity and accidental key replacement findings fixed. Residual waiver: existing release admin key is broad and was used manually for this one RC with pinned host/hashes; permanent restricted publisher remains hardening work.
- Exact next action: final diff audit, remove generated cache, independent re-review delta, commit and push; then collect remote CI evidence.

## 2026-08-08T14:42:49Z — W0-OPS-001 claimed

- Task / owner / role: `W0-OPS-001` / `codex:root` / Orchestrator, Architect, Implementer
- Branch / worktree / commit: `ai/W0-OPS-001-wave0-ops-close` / `D:/soft/Claud/porje/Run in the project/erp-taranom-w0-ops` / base `a45b97c`
- Objective and acceptance criteria: close real off-server backup by pulling encrypted backups to the user's Windows PC; safely publish RC binaries; validate and document Wave 0 evidence.
- Verified context and decisions: no active claims existed; user approved the task branch/worktree and two independent review agents; Windows PC is the offsite destination; commercial Windows certificate is not required for this task.
- Files changed (and why): task registry and this checkpoint only, to establish ownership before implementation.
- Tests/gates run with exact results: none yet; preflight was read-only.
- Review/security findings and dispositions: pending independent review.
- Known failures, risks, and assumptions: production/SSH operations are high-risk; no destructive restore is authorized; existing source worktree contains unrelated user files and is not used for implementation.
- File claims released or retained: all claims in `active.yaml` retained.
- Exact next action: inspect existing deployment/backup interfaces inside the isolated worktree, then implement the smallest secure Windows pull workflow.


