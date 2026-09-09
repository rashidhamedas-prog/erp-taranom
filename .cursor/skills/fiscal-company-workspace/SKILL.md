---
name: fiscal-company-workspace
description: >-
  Multi-company SQLite workspaces and fiscal year clean-slate for ERP Taranom.
  Use when creating companies, opening a blank fiscal year, factory-reset,
  rollover, or wiping invoices/journals. Prevents silent leftover documents.
---

# Fiscal year and company workspace

## Invariants

- Each company is a **separate SQLite file** (`server/lib/company-workspace.js`). Do not add `company_id` on every row.
- **Rollover** keeps documents. Close P&L of the year being closed (`coa.type` income/expense, never 3xxx equity) and post retained earnings into the new year.
- **Open clean / factory reset / new company** must delete operational documents. A success response with leftover invoices is a bug.
- Wipe engine: `server/lib/clean-slate.js` — discover tables from `sqlite_master`, FK off, no swallowed DELETE errors, verify `TXN_PROBE` counts are zero.
- Keep `sync_tombstones` so devices still receive deletes. Reset `number_sequences` and stock projections.
- `initDBOn(handle)` must **not** swap the process-wide `db` handle (concurrent requests would write into the new company file).
- New company: `initDBOn(fresh, { skipOpeningBackfill: true })` then `purgeTransactionalData(fresh, { mode: 'new-company' })`. Copy users only — never copy invoices.
- Confirm phrases: `OPEN-CLEAN-YEAR`, `RESET-FISCAL`. Password via bcrypt. `adminOnly` + `centralOnly`.
- Do not mix rollover UX with clean-year UX. Primary button for a blank year is «افتتاح سال خام».

## Tests

```
node server/scripts/test-clean-slate-v212.js
node server/scripts/test-sms.js
```

If the wipe catalog is extended, extend `TXN_PROBE` and the test seed (invoice + settlement + journal_lines).
