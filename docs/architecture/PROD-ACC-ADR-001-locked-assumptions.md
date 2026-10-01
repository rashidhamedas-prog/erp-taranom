# ADR-001 — Locked assumptions for PROD-ACC wave

Status: Accepted (2026-10-01)  
Context: Cursor plan «معماری و برنامه اصلاح حسابداری تولید»

## Decision

1. **Money:** integer rial in DB; `postToLedger` toman boundary only (`money.js`). No global rial↔toman rewrite.
2. **Valuation:** keep perpetual weighted average at **product header**; color×size are analytical dimensions, not separate GL accounts or automatic per-variant averages.
3. **Consumption ownership:** one owner per material/stage; lay and backflush must not double-consume.
4. **Cutting pack:** when linked to a production order, pack is a **WIP/cut-bundle** qty event (no WIP→FG JE). Standalone pack (no PO) may still post FG (legacy cut-to-stock).
5. **Payroll:** payroll owns employee liabilities; production sends labor allocation only.
6. **Offline:** financial finality on central; devices use draft/outbox; LWW forbidden for posted JE/stock averages.

## Consequences

- PA-02/03/04 implement against these defaults.
- Changing average scope to variant requires a new ADR + migration.
- Legal rates (payroll/tax/VAT 1405) stay `identified` until official text is verified — not activated in settings.
