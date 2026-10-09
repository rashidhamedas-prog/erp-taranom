# ADR-002 — Overhead drivers: professional settings (Option 1)

**Status:** Accepted (۱۴۰۵/۰۷/۱۸)  
**Supersedes decision open in:** `PROD-OH-DRIVERS-RESEARCH.md`

## Decision

Ship **Option 1**: keep predetermined OAR formula

```
applied = total_rate_rial × driver_qty × (absorb_pct/100)
```

and separate UX/API layers A (indirect budget) / B (rates) / C (absorb_pct) / D (driver-specific + direct monthly labor). Do **not** change period-close JE math to full IAS 2 fixed-vs-variable split in this wave.

## Also in scope

- Persist `production_orders.manual_driver_qty`
- Pass BOM ops / optional hours into simple-engine `applyOverhead`
- R13: decrement `cost_center_rates.applied_oh_rial` / `actual_driver_qty`
- Advanced stage apply also bumps (and reverse unbumps) rate counters
- Docs: actual OH remains expense→5202 (PRD-06 narrative stays aspirational)

## Out of scope

- IAS 2 pure fixed@normal / variable@actual engine (future ADR)
- Multi-CC allocation UI / `5214` budget variance posting
- Wiring live `postEvent(PRD-06)`
