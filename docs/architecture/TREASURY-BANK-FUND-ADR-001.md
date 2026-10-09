# ADR-001 — Bank & Fund professional settings (Option 1)

**Status:** Accepted (۱۴۰۵/۰۷/۱۸)  
**Supersedes open decisions in:** `TREASURY-BANK-FUND-RESEARCH.md` §۹

## Decision

Ship **Option 1** — correctness + per-entity professional controls without rewriting the treasury engine or multi-currency GL:

1. **Inbound cheque settlements always Dr `1109`** (`coa_cheques_receivable`), same as invoice payment splits — never generic bank / `resolveCashAccount('cheque')`.
2. **Per-entity settings (additive columns):**
   - `banks.overdraft_limit_rial` — `NULL` = unlimited (compat); `0` = no negative; `>0` = floor at `−limit`.
   - `cash_boxes.float_ceiling_rial` — `NULL` = unlimited; when set, transfer **into** that box (esp. petty) cannot push live GL above the ceiling.
3. **Hard server guards:** inactive bank/cash cannot be used on mutating cash ops; IBAN/شبا when provided must be `IR`+24 digits.
4. **Petty cash:** keep `is_petty_cash` + existing expense/transfer APIs; **no** new imprest `sourceType` in this wave.
5. **FX banks:** remain non-goal (recon already rejects foreign); flags stay metadata only.
6. **Masters R13:** prefer `active=0`; physical DELETE only when unused (unchanged). Fee/interest COA stay global `6115`/`4115` until a later ADR.

## Also in scope

- Wire guards into transfers, bank/cash save, settlements, expenses (petty path)
- UI fields on bank / cash (تنخواه) modals + in-app Help
- Automated regression test for cheque→1109 + overdraft + float ceiling
- SW bump when shipping frontend

## Out of scope

- Bank API statement feed / advanced recon profiles table
- Per-bank fee schedule % and per-bank fee COA override
- Full multi-currency revaluation
- Issued-cheque outbound unify to `2109` (separate ADR)
- Removing GET `/balances` opening side-effect (follow-up)
