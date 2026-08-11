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

5. **Warehouse gate:** Stocked lines require header `warehouse_id`; products must have valid `warehouse_stock` in that WH (positive unless negative sales allowed). Services (`item_kind=service`) exempt. API enforces independently of UI.

6. **Canonical UI:** Accounting shell pages are source of truth; duplicate menu entries redirect. Single kardex route `acc-item-kardex`.

7. **User↔party:** Exactly one active `users.party_id` binding; refuse linking a party already bound to another user; deactivate user soft-deactivates party access, never deletes financial history.

8. **Cheques:** Canonical lifecycle is `cheque_records` with JE on allowed transitions. Settlement cheque rows remain for compatibility.

9. **CRM:** Menu «پیگیری CRM» with children Followups + Dashboard. Dashboard metrics from real SQL APIs only. Party timeline aggregates ERP events with RBAC.

10. **MDI:** Bottom fixed taskbar; `--mdi-taskbar-h` equals real bar height; always visible when windows exist.

11. **Deploy:** No production deploy until owner explicit approval after Independent Reviewer + Security Approved.

## Consequences
- Large touch surface on `invoices.js`, `purchases.js`, void helpers, `app.js`, nav, CRM routes.
- Additive schema only; Help + CHANGE-LOG + SW bump required.
- Sync hygiene if new mutating `/api/crm` paths need capture (CRM read-mostly preferred).

## Rollback
- Abandon branch before merge.
- After merge: revert commits; keep additive columns.
- Behavioral rollback: set `feature_perpetual_docs=0` only if emergency (documents still retain type `normal`).
