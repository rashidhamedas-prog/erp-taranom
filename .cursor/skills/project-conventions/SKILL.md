---
name: project-conventions
description: >-
  CRM Taranom production-module conventions (R1–R12): INTEGER rial money,
  postToLedger toman conversion, acct() COA keys, ADR-011/012, append-only sync,
  no ORM/TS/React. Use when editing crm-taranom production, accounting ledger,
  BOM, WIP, or server/lib/production/** and server/routes/production-*.
---

# Project Conventions — CRM Taranom Production

Apply these rules on every production/accounting change in `crm-taranom`.

## Stack (do not change)

- Node.js + Express — **no TypeScript**
- better-sqlite3 — **no ORM**
- Frontend: vanilla SPA in `server/public/index.html` — **no React/Vue**
- Ledger: `server/lib/ledger.js` → `postToLedger()`
- COA: `server/lib/coa-map.js` → `acct(db, 'coa_*')`
- Sync: `server/sync/tables.js` — **APPEND-ONLY**

## Twelve golden rules (R1–R12)

### R1 — Money
- DB amounts: `INTEGER` rial, suffix `_rial`. Never `REAL`/`Double`/`Float` for money.
- `postToLedger` takes **toman** → always pass `rial / 10`.
- `expense_payments.amount` and similar legacy fields may be toman REAL → `× 10` to rial.

### R2 — Receipt golden rule
- `production_receipts.amount_rial = WIP_net` exactly (not `unit_cost × qty`).
- After full receipt, order WIP residual must be **exactly 0**.
- `unit_cost_rial` is display/report only.

### R3 — ADR-011 material variances
- WIP debited at **actual** moving-average cost.
- Rate/qty variances only in `var_*_rial` + `production_variances` with `status='memo'`.
- Accounts `5210`/`5211` exist but **must stay at zero balance** (no journal lines).

### R4 — ADR-012 stage transfers
- Single WIP account (`coa_wip` / 1111). No JE for inter-stage transfers.
- Exception: subcontract out/in (PRD-13/14).

### R5 — Normal waste
- Record in `production_waste` with `je_id = NULL`.
- Excess over cap → auto-reclass to abnormal → PRD-09.

### R6 — V4-21 anti double-count yield
- If `bom.has_routing = 1` → header `yield_percent` must be 100 (`E_YIELD_DOUBLE_COUNT` otherwise).
- Stage yields + `bom_lines.scrap_percent` still apply.

### R7 — Overhead driver basis
- Fixed modules (2/7): `material_rial` = **standard** materials.
- Variable modules (3/8): `material_rial` = **actual** issues.

### R8 — Atomicity
- Full operation in one `db.transaction(() => { ... })()`.

### R9 — Account codes
- Never hard-code account codes. Always `acct(db, 'coa_wip')` etc.

### R10 — Sync
- New tables only **appended** to `SYNCABLE_TABLES`. Never reorder existing entries.
- **Full checklist (mandatory when adding tables/APIs/uploads):** see `.cursor/rules/sync-hygiene.mdc`
  - `PATH_TABLE_MAP` / `tableForPath` for every mutating device API (longer prefixes first)
  - `FK_COLUMNS` for provisional-id remaps; `compositeKeys` for non-`id` PKs
  - New `sync_seq_backfill_vN` after appending tables
  - `files.js` `FILE_QUERIES` + `ALLOWED_SUBDIRS` for uploaded media
  - No leftover debug `fetch(…/ingest…)` in sync client
  - Verify: `node server/scripts/_diag-sync-gaps-b16e78.js` then `test-sync.js` if engine changed
- Intentional central-only tables stay **out** of the registry (keys, SMS log, B2B, 2FA, audit, production_events/idempotency).

### R11 — Cost field stripping
- `field_sales` / `production_operator` must not see `*_rial` cost fields in JSON (strip, don't CSS-hide).

### R12 — Reverse, don't delete
- No physical deletes of posted docs. Reverse JE + `status='reversed'`.

## Module posting policy

| Module | Posts ledger? |
|--------|:-------------:|
| BOM / Advanced BOM (1, 4) | ❌ |
| Fixed / Variable / Adv engines (2, 3, 7, 8) | ✅ via `posting.js` |
| MRP / Estimates / Reports | ❌ |

## Tests

```bash
cd crm-taranom/server
npm run test:production
```

Phase scripts: `test:production:schema|bom|fixed|variable` (+ advanced when added).

## File map

```
server/lib/production/schema.js      # P0 DDL
server/lib/production/bom.js         # P1
server/lib/production/bom-advanced.js # P4
server/lib/production/posting.js     # PRD helpers
server/lib/production/costing.js     # stock / avg
server/lib/production/overhead.js
server/lib/production/labor.js
server/lib/production/waste.js
server/lib/production/engine.js      # P2/P3 orders
server/routes/production-boms.js
server/routes/production-orders.js
```
