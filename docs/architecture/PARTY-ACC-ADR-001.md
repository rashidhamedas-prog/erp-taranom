# ADR-PARTY-001 — Persons / Parties professional accounting (Option 1 Minimal)

**Status:** Accepted (۱۴۰۵/۰۷/۱۸)  
**Supersedes open decisions in:** `PERSONS-ACCOUNTING-RESEARCH.md` §۷ / §۹  
**Depends on:** ACC-CRM-UNIFY (`parties` canonical), money ADR-001 (rial)

## Decision

Ship **Option 1 Minimal** — correctness + enforceable per-party credit, without Full knobs (terms / withholding / default bank):

1. **SoT master:** accounting settings live on `parties`; `customers` / `suppliers` / `persons` stay dual-write mirrors.
2. **Credit limit hard block:** when `parties.credit_limit > 0` (rial), a firm sale that increases AR beyond `limit − current_AR` is rejected (`409` / `E_CREDIT_LIMIT`). `0` / unset = unlimited. Proforma does not enforce.
3. **Cheque books XOR:** receivable cheque registration/bounce posts **either** `customer_ledger` **or** `person_ledger`, never both for the same cheque. Customer wins when linked.
4. **Dual-role leaves:** a party with both customer and supplier roles must not share one COA leaf for AR and AP. Header/`customers.coa_code` = customer kind; `suppliers.coa_code` = distinct supplier kind (auto-split when colliding).
5. **Canonical tafsili:** posting resolves `coa_code` leaf; `detail_accounts` remains optional parallel (no deprecate in this wave).
6. **Balance display:** keep `partySignedBalanceMap` rule (subledger first; GL only if absent or `|Δ|≤1`).
7. **Masters R13:** party deactivate + reverse opening unchanged; physical DELETE of unused masters unchanged.

### Amendment v368 (opening + supplier SoT)

8. **Opening once:** live balance = role subledger + `parties.opening_balance` only when that subledger has no opening row. Never drop header opening when later activity exists (root of false «اختلاف دفتر»).
9. **Supplier SoT:** `supplier_ledger` (debit−credit, rial) — not purchase/payment document formula.
10. **Opening post:** `postPartyOpeningBalance` mirrors JE onto every linked `customers` / `persons` / `suppliers` row by `party_id` (not only `legacy_table`).
11. **Mismatch:** per-leaf compare via `partyBooksMismatch` (dual-role AR≠AP).

### Amendment v442 (turnover = books)

12. **گردش SoT:** `buildPartyTurnover` ending `closing` must equal `partySignedBalanceDetailMap` (net by default; leaf when `?role=`). Synthetic opening fold when subledger lacks opening row; union all linked customer/supplier ids; never use purchase/payment docs formula for closing when books leaf exists.

### Amendment v448 (person vs incentive ledgers)

13. **Two books, never half-merge:** Person/party turnover (`buildMergedPersonTurnover`) must **not** merge `rep_ledger` rows into the control-account statement. Displaying incentive debits without affecting running balance or period totals is forbidden (v447 anti-pattern). UI may expose `linked_rep_id` to open the operational rep statement. Every row shown on a statement must participate in debit/credit totals and running balance for that same SoT.

### Amendment v449 (rep cash hits the person leaf)

14. **Counterparty is the person, not the pool:** When a sales rep is linked to a party that has its own COA leaf, incentive accrual, incentive payment, rep settlement, and rep advance debit/credit **that leaf** and write `person_ledger` for the same rial amount. Pooled `2107` / `1107` is only the fallback when no leaf exists. Bank and fee lines stay on the cash account. A historical heal (`reclass_rep_person_v449`) moves live pooled lines onto the leaf without changing amounts. Expense reimbursement keeps the P&L line and also books a net-zero person payable + payment pair so the cash document is on گردش. Void retires the person rows (no hollow reverse line).

### Amendment v455 (customer role ⇒ CRM projection)

15. **Roles drive commercial projections, not party group:** If `party_roles` includes `customer` (or `party_type` is `customer`/`both`), `syncPartyToLegacy` **must** maintain an active `customers` row regardless of `party_groups.entity_type` (including پرسنل / `person`). Group is classification UX only. Invoice create selects from `customers`; suppressing the projection makes sellable parties invisible. Dual-role must not copy an AP leaf onto `customers.coa_code` — allocate/keep a receivable leaf (`ensureCustomerTafsili` / `ensureDualRoleSeparateLeaves`). Boot heal: `customer_role_projection_v455`.

### Amendment v456 (one leaf, one balance)

16. **Sibling books on one leaf follow that leaf's GL:** When person and supplier (or customer) share a party's COA and their signed balances disagree by more than 2 rial, `partySignedBalanceDetailMap` keeps the candidate closest to the live GL of that code. The larger absolute balance must not win — a stale opening-only book was hiding a real payment and forcing a synthetic «تطبیق» row that cancelled it. Do not sum the siblings. A single subledger that is merely incomplete still wins over GL until its missing lines are copied (existing `|Δ|≤2` snap stays). Boot heal `party_leaf_books_align_v456` inserts each live GL line into every linked book of that unique leaf that lacks a matching row (ref, or opening, or same date and amount including ×10 payroll). It does not rewrite payroll toman rows and does not move bank lines. Live posts (`postToLedger` / role-ledger insert) copy a new line onto siblings that share the leaf, except openings (opening-post already writes every book). Void retires the mirrored sibling rows for the same party and ref.

## Also in scope (P0)

- Server guards + regression test `test-party-acc-adr001-v337.js`
- Help + SW bump when shipping frontend
- Call `ensureDualRoleSeparateLeaves` from party tafsili / legacy sync

## Out of scope (later waves)

- Portal payment → person_ledger (P1)
- Persons opening JE or sunset `/api/persons` (P1)
- Party group default COA / nature defaults (P2)
- Full knobs: payment terms, withholding, default settlement bank (P3)
- ERPNext-style Common Party offset JE
- UNIQUE `users.party_id`
- Changing customer_groups.nature into posting control

## Locked answers to research open questions

| # | Question | Answer |
|---|----------|--------|
| 1 | SoT مانده party | Keep current GL-if-agree rule |
| 2 | Sunset `/persons` | Deferred P1 |
| 3 | Supplier list vs ledger | Deferred P2 |
| 4 | detail_accounts | Keep optional; leaf = `coa_code` |
| 5 | customer_groups.nature | UX only |
| 6 | Deactivate cascade | Unchanged |
| 7 | Employee fallback COA | Unchanged (2104/1106 via payroll resolver) |
| 8 | Pro settings panel | Deferred; credit enforce only |
| 9 | VOIDABLE opening vouchers | Deferred |
| 10 | Dual-role | Separate AR/AP leaves (not forbid both roles) |
| 11 | credit_limit | Hard block |
| 12 | users.party_id UNIQUE | Deferred |
