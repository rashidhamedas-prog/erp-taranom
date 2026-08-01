# Phase P0-Q1 — Test pyramid baseline

**Status:** `[x]` — Playwright critical + API hostile/tenant coverage in CI
**Roadmap:** فاز P0-Q1

## Tasks

- [x] Inventory unit tests (money, jalali, tax, commission, payroll, costing, state)
- [x] Integration: financial routes, RBAC/IDOR, sync conflict, migration
- [x] Playwright E2E critical: login, invoice+cross-company, private media, B2B
- [x] Mobile/desktop: install, upgrade, offline sync scenarios (documented waiver; full builds prohibited)
- [x] Gap tests filed in matrix with owners

## Verification

- [x] Matrix document in `docs/` or plan Outcomes
- [x] Critical paths have automated coverage or explicit waiver

**Deploy:** ❌ Wave 0 blocked
