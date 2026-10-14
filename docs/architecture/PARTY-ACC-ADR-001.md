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
