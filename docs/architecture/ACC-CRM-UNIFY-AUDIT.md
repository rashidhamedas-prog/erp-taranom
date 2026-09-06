# ACC-CRM-UNIFY Audit Matrix

Base: `448a8c1` @ `ai/ACC-CRM-UNIFY-accounting-crm`
Date: 2026-08-11
Status: Wave 0 baseline (pre-implementation)

## Canonical services (target)

| Concept | Canonical service | Canonical API | Canonical UI |
|---------|-------------------|---------------|--------------|
| Sales doc | `server/lib/sales-document.js` | `/api/invoices` | `acc-sales-invoices` / builder |
| Inventory move | `postInventoryMovement` | `/api/warehouses/*`, docs via service | `acc-warehouse-ops`, kardex |
| Parties | `parties` + `user-party.js` | `/api/parties` | `acc-parties` |
| Cheques | `cheque_records` lifecycle | `/api/cheque-records` | `acc-cheque-register` |
| Settlements | settlements | `/api/accounting/settlements` | `acc-settlements` |
| CRM analytics | `crm-analytics.js` | `/api/crm/*` | `crm-dashboard` |
| Followups | followups routes | `/api/followups` | `followups` |

## Domain matrix

### Persons / parties
- Tables: `parties`, `party_groups`, `customers`, `suppliers`, `persons` (legacy parallel)
- API: `/api/parties`, `/api/party-groups`, `/api/customers`
- UI: `acc-parties` (canonical); `acc-suppliers`/`acc-persons` redirect
- JE/detail: `coa_code` via `allocTafsili`; optional `detail_accounts`
- Gaps: no UNIQUE `users.party_id`; dual-write customers; persons unlinked; phone-only dup check

### Products
- Tables: `products`, `product_categories`, `units`, `warehouse_stock`
- API: `/api/products`
- UI: `acc-products` CRUD canonical; main nav `products` view-only duplicate
- Gaps: two menu entries with same label

### Warehouse / kardex
- Tables: `warehouses`, `warehouse_stock`, `inventory_ledger`, `inventory_cost_layers`, `stock_logs`
- API: `/api/warehouses`, `/api/inventory`, `/api/stocktaking`
- UI: `acc-item-kardex` (listed twice in nav under کالا and انبار)
- Engine: `postInventoryMovement` used by WH ops; **not** by invoices/purchases
- Gaps: sales/purchase bypass ledger → kardex incomplete

### Bank / cash
- Tables: `banks`, `cash_boxes`, `account_transfers`, `journal_*`
- API: `/api/banks`, `/api/cash-boxes`, `/api/transfers`
- Balance: live `SUM(debit-credit)` from journal (good)
- Gaps: invariants need locked tests

### Cheques
- Parallel models: settlement `cheque_status`, `cheque_records` lifecycle, `trust_checks`
- Canonical target: `cheque_records` with JE on status transitions
- Gaps: settlement status patch posts no JE; free-text status on register

### Sales invoices
- Tables: `invoices`, `sales_returns`, `settlements`, `moadian_queue`
- Types today: `proforma` \| `final` only (no `normal`)
- Final create: `deductStock` + `postToLedger` + optional `postCogsVoucher` + Moadian
- Convert: `POST /:id/convert` → final
- Void: `voidInvoiceFully` (R13 reverse, no physical delete)
- Gaps: no normal; legacy stock; no WH product gate; JE not UNIQUE

### Purchases
- Tables: `purchase_invoices`, `purchase_returns`
- Create: qty on products/warehouse_stock + JE inventory/payable — **no inventory_ledger**
- Returns: often products.stock only
- Gaps: wire to perpetual engine

### Journal / reports
- `postToLedger` / `createJournalEntry`; index on ref without UNIQUE
- Accounting reports treat `type='final'` only — must include `normal` for sales metrics where appropriate

### Users ↔ party
- `ensureUserParty` on admin create/update; boot `ensureAllUserParties`
- Gaps: no ownership lock; no UNIQUE; party_group from form needs hardening

### CRM / followups
- Menu label «پیگیری‌ها»; no CRM subgroup/dashboard
- Timeline: followups-by-customer only; no ERP-wide party timeline
- RBAC: `sales_manager` seesAll on dashboard but not on followups lists

### MDI
- Left hover rail; `--mdi-taskbar-h: 0`
- Target: bottom fixed bar with real height

## Duplicate redirect map (planned)

| Old / duplicate | Canonical | Notes |
|-----------------|-----------|-------|
| Main `products` | `acc-products` mode=view | Keep catalog for sales if needed |
| Kardex under کالا + انبار | `acc-item-kardex` once | Remove duplicate nav entry |
| `acc-receipts` / `acc-payments` | `acc-settlements` | Already alias |
| `acc-suppliers` / `acc-persons` | `acc-parties` | Already redirect |
| CRM `invoices` vs `acc-sales-invoices` | Prefer accounting shell; CRM keeps builder entry | Shared API |
| `acc-cheques-recv` vs register | Register for lifecycle; settlements for AR cheques | Document; align JE |

## Root causes (invoice normal)

1. Print template «عادی ساده» is UI-only (`casual-simple`), not `invoices.type`.
2. Form `#inv-type` only offers proforma/final.
3. List filter ignores other type values.
4. Backend accepts arbitrary type string but never models `normal` as firm sale.

## Baseline test results (Wave 0)

Recorded at claim time in handoff after commands finish.
