---
name: fiscal-company-workspace
description: >-
  Multi-company SQLite workspaces and fiscal year clean-slate for ERP Taranom.
  Use when creating companies, opening a blank fiscal year, factory-reset,
  rollover, or wiping invoices/journals. Prevents silent leftover documents
  and false "wrong password" on step-up confirm.
---

# Fiscal year and company workspace

## Invariants

- Each company is a **separate SQLite file** (`server/lib/company-workspace.js`). Do not add `company_id` on every row.
- **Rollover** keeps documents. Close P&L of the year being closed (`coa.type` income/expense, never 3xxx equity) and post retained earnings into the new year.
- **Open clean** (`mode: 'open-clean'`) deletes documents **and** catalog (products, customers, parties, BOM) **and all detail/tafsili codes** (`detail_accounts`, `detail_categories`, COA level-4 / 12-digit / dashed / `tafsili_type`). Keeps users, base COA (group/kol/moein), settings, empty warehouses/banks (with `coa_code` cleared). A success response with leftover invoices/products/customers/tafsili is a bug.
- **Factory reset** keeps catalog (products/customers) and only wipes transactions (detail codes stay with masters).
- **New company** copies users only; never copy invoices. Purge with `new-company` (masters kept because the new file has no catalog copy).
- Wipe engine: `server/lib/clean-slate.js` — discover tables from `sqlite_master`, FK off, no swallowed DELETE errors, verify probe counts are zero. Detail strip: `purgeDetailCoding(db)` (also callable alone for live repair via `server/scripts/_purge-live-tafsili-v214.js`).
- Keep `sync_tombstones` so devices still receive deletes. Reset `number_sequences`.
- `initDBOn(handle)` must **not** swap the process-wide `db` handle.
- Confirm phrases: `OPEN-CLEAN-YEAR`, `RESET-FISCAL`. Password via `server/lib/password-verify.js` (same bcrypt path as login, hash trim, `$2` check, dummy compare). `adminOnly` + `centralOnly`.
- Step-up UI: isolate from hidden login autofill (`disarmLoginAutofill`), capture password on input, keep modal open on error, «درج عبارت» so Chrome does not put `OPEN-CLEAN-YEAR` into the password field.
- Do not mix rollover UX with clean-year UX. Primary button for a blank year is «افتتاح سال خام».

## Tests

```
node server/scripts/test-password-verify-v213.js
node server/scripts/test-clean-slate-v212.js
node server/scripts/test-sms.js
```

If the wipe catalog is extended, extend `TXN_PROBE` / `CATALOG_PROBE` and the test seed.
