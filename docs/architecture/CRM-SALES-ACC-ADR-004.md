# ADR-004 — CRM / Sales accounting professional settings (Option 1)

**Status:** Accepted (۱۴۰۵/۰۷/۱۸)  
**Supersedes open decisions in:** `CRM-SALES-ACCOUNTING-RESEARCH.md` §۹  
**Builds on:** `ADR-ACC-CRM-UNIFY.md`, Treasury ADR-001, Warehouse ADR-003 (no rewrite)

## Decision

Ship **Option 1** — correctness of CRM sales books/KPIs + writable sales COA map + explicit receivables fold fields, without Moadian live submit or approve-before-revenue:

1. **Revenue recognition (unchanged UNIFY):** Both `normal` and `final` post JE + stock + `customer_ledger` on create/convert. `proforma` never posts until convert. Commission/`approved` and Moadian enqueue stay orthogonal to posting.

2. **تهاتر / receivables fold:** No cross-customer clearing JE. Portfolio cards use `foldSignedRows`:
   - gross debtors = `display`
   - gross creditors = `creditor`
   - net = `signed`
   Dashboard summary and any company overview APIs MUST expose these three explicitly (not a single overloaded `net_receivables` meaning different things in different screens).

3. **Settings whitelist (P0):** Add to `ALLOWED_KEYS` and admin COA UI:
   - `coa_sales_return`, `coa_sales_expense`, `coa_other_income`
   - `coa_cheques_receivable`, `coa_cheques_in_collection`
   - `coa_card_in_transit`, `coa_card_fee`
   Values continue to resolve via `acct()` / LEGACY defaults when unset.

4. **books ↔ GL (P0):** Keep `customer_ledger` as SoT for CRM cards and statements. Ship:
   - mismatch detection already on statements/overview
   - admin repair helper that posts controlled reclass from control AR (`coa_receivable`) to customer tafsili when safe, or documents why history cannot auto-move
   - never silent last-write-wins on JE

5. **Portal convert copy (P0):** UI must offer convert to firm sale (`normal` or `final` per role/policy), not hard-coded “فقط final”.

6. **Returns / consignment / opening R13 / stock PATCH JE (P1):**  
   - Sales return reverses VAT/discount structure of source invoice when present; inventory side uses typed WH COA (`inventoryAccountForWarehouse`).  
   - Consignment payable/loss accounts configurable (settings or per-party).  
   - Customer opening edits use reverse voucher semantics (R13), not bare soft-delete of JE.  
   - `PATCH /products/:id/stock` either posts adjustment JE or is rejected when perpetual docs enabled (central-only path).

7. **Out of scope this ADR:** Live Moadian, seasonal VAT, §169, installment unearned interest, doubtful-debt reserve, changing `final` to post only after approve.

## Also in scope

- Automated regression: firm vs proforma posting, fold fields on `/api/dashboard/summary`, settings keys writable, smoke void
- In-app Help: تهاتر خانواده‌ها، firm-only KPI، mismatch banner meaning
- SW bump when shipping frontend
- CHANGE-LOG + Iran deploy per project rules

## Waves

| Wave | Content |
|------|---------|
| P0 | §2–5 + tests + Help snippet + SW |
| P1 | §6 returns/consignment/opening/stock |
| P2 | Deferred compliance (separate ADR if needed) |
| P3 | COGS path clarity + polish |

## Rollback

- Revert commits; additive settings keys harmless if unused.
- Behavioral flags unchanged (`feature_perpetual_docs` emergency only).
