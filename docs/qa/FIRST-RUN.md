# First full run — QA-ERP-FULL-CYCLE

- **QA_RUN_ID:** `qa-20260824T151001-15880`
- **When:** 2026-08-24 (worktree `ai/QA-ERP-FULL-CYCLE-admin-roles`)
- **Command:** `NODE_ENV=test node scripts/qa/run-full-erp-qa.js`
- **Exit:** **3** (RBAC/security High still open — suite is **not** PASS)
- **Counts:** PASS 211 · FAIL 24 · ERROR 0 · NOT_IMPLEMENTED 14 · BLOCKED 0 · SKIP 1
- **Wrap:** inventory-smoke 24/24 · acc-crm-party 22/22 · crm-pro-rbac 17/17
- **E2E:** login OK · 22 nav pages crawled · picker type OK
- **Recon:** JE balanced, FK zero; firm invoice without warehouse **FAIL**; ledger vs warehouse_stock **FAIL**
- **Deploy:** none (forbidden)

## High product findings (child task `QA-ERP-FULL-CYCLE-FIX-HIGHS`)

| Id | Evidence | Likely file |
|----|----------|-------------|
| `cheque.free_text_party` | POST `/api/cheque-records` stores `party_name` | `server/routes/cheque-records.js` |
| `fault.invoice_maybe_wh` / `recon.firm_invoice.has_warehouse` | firm `final` posts with `warehouse_id` null | `server/routes/invoices.js` |
| `recon.stock.ledger_vs_warehouse` | opening qty on `warehouse_stock`/`products.stock` not in `inventory_ledger` | inventory posting / product create |
| `roles.accounting.payroll.create` | matrix `payroll.create=false` (VIEW_ONLY default) but POST `/payroll` is `adminOrAccounting` → 200 | `server/routes/payroll.js` |
| `e2e.party_id_required` | UI free-text `#tc-party`, `#oc-party` | `server/public/app.js` |

## Medium (route tighter than `DEFAULT_ROLE_PERMISSIONS`)

GET `/settings` is `adminOnly`; GET `/accounting/sales-returns` is `adminOrAccounting`. Roles with `settings.view` / `accounting.view` in the matrix get 403. Safer than the matrix; still a documented mismatch (not fake PASS).

## Gaps (`NOT_IMPLEMENTED`, not PASS)

RFQ, 3-way match, `tracking_profile=roll`, GRNI, maker-checker SOD, branch ACL, order reservations, backup/restore not hit in this batch.

Do not declare the full suite PASS while Highs remain. Do not weaken assertions.
