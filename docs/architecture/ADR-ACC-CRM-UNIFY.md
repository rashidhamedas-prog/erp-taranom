# ADR: ACC-CRM-UNIFY — Canonical accounting + CRM

## Status
Accepted for implementation on branch `ai/ACC-CRM-UNIFY-accounting-crm`.

## Context
Sales/purchases use legacy stock updates while warehouse ops use `postInventoryMovement`. Invoice types lack `normal`. CRM followups are isolated from ERP events. Menus duplicate products/kardex. MDI taskbar is a left hover rail.

## Decisions

1. **Document types:** `proforma` (no stock/JE), `normal` (firm sale, stock+JE+COGS, no Moadian), `final` (firm sale + Moadian when enabled). Legacy rows are never silently rewritten to `normal`.

2. **Perpetual inventory:** All firm sales, purchases, returns, and voids go through `postInventoryMovement` inside the same `db.transaction` as JE posting. Feature flag `feature_perpetual_docs` defaults on for new code paths; can disable for emergency rollback of behavior (not schema).

3. **Idempotency:** Before posting, guard on existing non-reversed `journal_entries` with same `(ref_type, ref_id)`. Prefer application guard + partial unique index when SQLite allows.

4. **Conversions:** `proforma → normal|final` via dedicated convert endpoints. Posted `normal|final` are not edited in place; cancel (full reverse) then re-issue.

5. **Warehouse gate:** Firm sales with stocked lines need an effective warehouse per line.
   - **Preferred:** header `warehouse_id` set by UI/API.
   - **Legacy fallback (devices / older clients):** `header || line.warehouse_id || products.warehouse_id`.
   - Hard `E_WH_MISMATCH` only when header AND line WH both set and differ.
   - Missing `warehouse_stock` uses seed semantics (`products.stock` only on home WH) for backward compatibility with sync replay; services exempt.
   - API may soft-fill header from seller `sales_warehouse_id` (reps forced). This is intentional compatibility, documented here — not a silent bypass of stock checks (`E_WH_INSUFFICIENT` still applies).

6. **Canonical UI:** Accounting shell pages are source of truth; duplicate menu entries redirect. Single kardex route `acc-item-kardex`.

7. **User↔party:** Exactly one active `users.party_id` binding; refuse linking a party already bound to another user; deactivate user soft-deactivates party access, never deletes financial history.

8. **Cheques:** Canonical lifecycle is `cheque_records` with JE on allowed transitions. Settlement cheque rows remain for compatibility.

9. **CRM:** Menu «پیگیری CRM» with children Followups + Dashboard. Dashboard metrics from real SQL APIs only. Party timeline aggregates ERP events with RBAC.

10. **MDI:** Bottom fixed taskbar; `--mdi-taskbar-h` equals real bar height; always visible when windows exist.

11. **Deploy:** No production deploy until owner explicit approval after Independent Reviewer + Security Approved.

12. **Report type filters (Phase 5):** Classify every invoice consumer:
    - **Firm sale** (`type IN ('normal','final')` via `firmSaleTypeSql`): revenue, P&L invoice side, VAT invoice fallback (aligned with JE), AR/debt/open invoices, dashboard/admin/rep/AI sales KPIs, CRM firm metrics, reserves, integrity JE checks, last-sale heuristics.
    - **Commission-eligible** (`commissionEligibleSql`): firm + `approved=1`. Normal invoices are **auto-approved** on create/convert (`autoApproveNormalInvoice`); final still requires explicit commission approve.
    - **Final-only:** Moadian enqueue/submit, pending official-approval queues/counts/notifications, seasonal tax report 169, approve-gate endpoints.
    - Proforma never enters revenue/AR/Moadian.

13. **Cheque lifecycle (Phase 6):** Canonical path for incoming cheques is
    `registered → in_collection → cleared|bounced`. Free-text `PATCH …/status` must not
    mutate financial meaning (Persian or English synonyms, or when lifecycle is past
    `registered`). `POST …/resend` reverses the bounce JE and restores the prior
    lifecycle state (`in_collection` or `cleared`) with idempotent guards.
    Outgoing cheques keep register notes only until a dedicated payable lifecycle exists.

14. **CRM new_customers KPI:** When dashboard `from`/`to` (Jalali) are set, count
    customers whose `created_at` (unix) falls in that inclusive day range (same scope
    filters). Without dates: all customers in scope (legacy).

15. **Invoice product picker cache:** Warehouse-filtered product lists must not overwrite
    `CACHE.allProducts`; use a dedicated picker cache so catalog/BOM/other pages keep the full set.

## Consequences
- Large touch surface on `invoices.js`, `purchases.js`, void helpers, `app.js`, nav, CRM routes.
- Additive schema only; Help + CHANGE-LOG + SW bump required.
- Sync hygiene if new mutating `/api/crm` paths need capture (CRM read-mostly preferred).
- Report SQL must import `firmSaleTypeSql` / `commissionEligibleSql` — do not hard-code `type='final'` for commercial metrics.

## Rollback
- Abandon branch before merge.
- After merge: revert commits; keep additive columns.
- Behavioral rollback: set `feature_perpetual_docs=0` only if emergency (documents still retain type `normal`).
