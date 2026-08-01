# Wave 0 Critical Path — ERP ترنم

**Plan ID:** `260801-wave0-critical-path`  
**Roadmap:** `docs/erp-taranom-master-roadmap.md` (§ موج صفر)  
**Skill:** `.cursor/skills/erp-roadmap-wave0/SKILL.md`  
**Executor agent:** `@erp-wave0-executor`  
**Status:** 🟡 In progress — **P0-A closed**; next = P0-B

---

## Progress

| When | Phase | Note |
|------|-------|------|
| 2026-08-01 | Setup | Master roadmap copied; Wave 0 skill, agents, and this plan created. Deploy blocked per Wave 0 gate. |
| 2026-08-01 | P0-A (probe) | Isolated BOM was already green (T1-08 not hanging on Node 22). |
| 2026-08-01 | P0-A ✅ | Path-based `detectCircular`; T1-28/T1-29; `run-production-tests.js` timeouts; **`test:production` ×3 GREEN** (10.6 / 8.9 / 8.0 min). `test-sms` 22/22; `test-sync` 33/33. |
| 2026-08-01 | P0-S1 partial | Remote HTTP fallback removed; `assertCentralUrlAllowed`; `test-sync-tls-url.js` 7/7. Token rotation / revoke / nonce still open. |

---

## Surprises & Discoveries

- Roadmap hang T1-07→T1-08 **not reproducible**; isolated BOM 29/29 after new cycle/diamond tests.
- Suite hang risk was process-level (missing per-script timeout), not infinite explode on T1-08.
- Concurrent `test-sync` + production suite can ECONNREFUSED on :4100 — run serially.
- Mid-path cycles (Root→B→C→B) previously could hit `E_BOM_TOO_DEEP` instead of `E_BOM_CIRCULAR` before path visited-set fix.

---

## Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-08-01 | Block production deploy until Wave 0 gate | Roadmap موج صفر + skill override of auto-deploy |
| 2026-08-01 | Close P0-A after ×3 green + cycle hardening | Meets phase acceptance; continue Wave 0 order |
| 2026-08-01 | Partial P0-S1 ship with URL/TLS only | High-value security win without waiting full S1 checklist |
| 2026-08-01 | Handoff unfinished phases to `docs/WAVE0-GPT-PRO-HANDOFF.md` | User requested ChatGPT Pro continuity pack |

---

## Outcomes

*(Fill when Wave 0 gate passes.)*

- [ ] Wave 0 exit gate met
- [ ] Production deploy unblocked
- [ ] Retrospective notes
- [x] P0-A phase gate met (2026-08-01)

---

## Phase index

Execute in order. Mark `[x]` when gate passed.

| # | Phase | Plan file | Status |
|---|-------|-----------|--------|
| 1 | P0-A BOM / CI | [P0-A-bom-ci.md](./P0-A-bom-ci.md) | `[x]` |
| 2 | P0-B Source drift | [P0-B-source-drift.md](./P0-B-source-drift.md) | `[ ]` |
| 3 | P0-S1 TLS sync | [P0-S1-tls-sync.md](./P0-S1-tls-sync.md) | `[-]` partial |
| 4 | P0-S2 Android/Electron | [P0-S2-platform-hardening.md](./P0-S2-platform-hardening.md) | `[ ]` |
| 5 | P0-S3 Web/API security | [P0-S3-web-api-security.md](./P0-S3-web-api-security.md) | `[ ]` |
| 6 | P0-C Backup/restore | [P0-C-backup-restore.md](./P0-C-backup-restore.md) | `[ ]` |
| 7 | P0-Q1 Test pyramid | [P0-Q1-test-pyramid.md](./P0-Q1-test-pyramid.md) | `[ ]` |
| 8 | P0-Q2 CI/CD | [P0-Q2-ci-cd.md](./P0-Q2-ci-cd.md) | `[ ]` |

---

## Wave 0 exit gate (from roadmap)

- [ ] Full test suite green *(production ×3 done; broader suites still open)*
- [ ] Remote sync TLS-only (no HTTP fallback off localhost) *(URL layer done; token/nonce open)*
- [ ] Off-server backup operational
- [ ] Successful restore drill documented

---

## Global verification (after each backend phase)

```powershell
cd server
node scripts/test-sms.js
node scripts/test-sync.js
node scripts/test-sync-tls-url.js
node scripts/_diag-sync-gaps-b16e78.js
```

**Deploy:** ❌ blocked until Wave 0 gate — commit/push only.

**GPT Pro handoff:** `docs/WAVE0-GPT-PRO-HANDOFF.md`
