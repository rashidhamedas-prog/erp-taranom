# ADR-003 — Warehouse inventory GL (typed COA + receipt classes)

Status: **Accepted** (۱۴۰۵/۰۷/۱۸)  
Supersedes open decisions in `WAREHOUSE-ACCOUNTING-RESEARCH.md` §۹ for the P0/P1 wave.  
Preserves: `PROD-ACC-ADR-001` (avg at product header; money = rial).

## Decision

1. **Control account resolution** (`inventoryAccountForWarehouse`):
   - Optional `warehouses.inventory_coa_code` (must exist in COA) wins.
   - Else type map: `raw_material`→1110, `packaging`→1112, `wip`→1111, `scrap`→1113, `consignment`→1114, else→1104 FG.
2. **All value-posting purchase/sale inventory paths use typed COA**: purchase invoice, GRNI, purchase return, landed cost, invoice COGS, period-close, warehouse docs.
3. **Warehouse receipt counterpart classes** (`receipt_class`):
   - `opening` → Cr `coa_opening_balance` (3102)
   - `grni` / `supplier` → Cr `coa_grni` (2112) — supplier receipt without PI
   - `adjustment` (default) → Cr `coa_adjustment` (9999) — ops/count fixes only
4. **Purchase with invoice stays on `/purchases` or procurement GR→invoice** — do not use WH receipt adjustment for the same goods (avoids double inventory debit).
5. **Valuation scope unchanged** — moving average remains product-header (ADR-001); no per-warehouse avg in this ADR.

## Consequences

- UI: warehouse form shows optional inventory COA; receipt modal requires class.
- Tests: `server/scripts/test-warehouse-typed-coa-v335.js`.
- Follow-ups (P2+): in-transit 1115, `/inventory/adjust` JE gate, legacy production migration — not in this ADR.
