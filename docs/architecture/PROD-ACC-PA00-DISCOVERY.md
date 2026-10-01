# PA-00 Discovery — Production Accounting

Date: 2026-10-01 (Asia/Tehran)  
HEAD: `002ca012` (`main` / `ai/PROD-ACC-PA02-posting-core`)  
Scope: read-only reconfirm of F01–F21 + writer map. No production DB access.

## Writer map (stock / JE / payroll)

| Path | Stock writer | JE writer | Period guard |
|---|---|---|---|
| `costing.issueFromStock` | direct `products` + `warehouse_stock` (+ rewrite fallback) | caller PRD-01 | caller |
| `costing.updateMovingAverage` | direct | caller PRD-07 | caller |
| `engine.js` receipts/issues | via costing helpers | `posting.postEvent` | `assertPeriodOpen` + FY |
| `engine-advanced.js` stages/finalize | via costing helpers | `postEvent` | FY only (gap F17) |
| `cutting.js` lay/pack | `postInventoryMovement` | `postToLedger` | none for month |
| `routes/production.js` legacy | direct/engine | mixed | partial |
| `routes/payroll.js` | — | payroll JEs | payroll period |
| `routes/expenses.js` | — | expense JEs | FY |

## Finding status on HEAD

| ID | Severity | Reconfirmed | Notes |
|---|---|---|---|
| F01 | P0 | Yes | `costing.js` rewrites WH qty from `products.stock` |
| F02 | P0 | Yes | `close.periodEndDate` Gregorian month lengths on Jalali label |
| F03 | P0 | Yes | `postAllocation` early-null on net-zero; mixed signs unbalanced |
| F04 | P0 | Deferred | expense rial vs OH ×10 — needs historical column audit |
| F05 | P0 | Yes | `finalizeAdvancedOrder` missing completed guard at entry |
| F06 | P0 | Yes | pack posts FG independently; when PO linked → double-path risk |
| F07 | P0 | Yes | legacy `routes/production.js` still mounted |
| F08 | P1 | Observed | payroll source vs production precheck mismatch |
| F09 | P0 | Observed | close reopen snapshot risk |
| F10–F18 | P1 | Observed | as execution plan |
| F19 | P1 | Yes | materials keyed by `stage_cost_center_id`, first op wins |
| F20–F21 | P1 | Yes | single `color_id` / `color` + `size_breakdown` |

## Baseline tests

Run from `server/` with better-sqlite3 ABI matching host Node.  
PA-00 records environment; product PASS/FAIL captured in PA-02+ handoff after fixes.

## Locked assumptions (→ ADR-001)

See `PROD-ACC-ADR-001-locked-assumptions.md`.

## Next

PA-02: F02 + F03. PA-03: F01/F16 via inventory movement. PA-04: operation assignments + color×size matrix.
