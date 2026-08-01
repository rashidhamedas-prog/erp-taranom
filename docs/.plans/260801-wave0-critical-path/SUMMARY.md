# Wave 0 Critical Path — ERP ترنم

**Plan ID:** `260801-wave0-critical-path`  
**Roadmap:** `docs/erp-taranom-master-roadmap.md` (§ موج صفر)  
**Skill:** `.cursor/skills/erp-roadmap-wave0/SKILL.md`  
**Executor agent:** `@erp-wave0-executor`  
**Status:** 🟡 In progress — infrastructure pack created; P0-A execution pending

---

## Progress

| When | Phase | Note |
|------|-------|------|
| 2026-08-01 | Setup | Master roadmap copied; Wave 0 skill, agents, and this plan created. Deploy blocked per Wave 0 gate. |
| 2026-08-01 | P0-A (probe) | Isolated `test-production-bom.js`: **27/27 pass**, exit 0 in ~125s. Full `npm run test:production` not yet verified ×3. Hang may be suite-level or environment-specific. |

---

## Surprises & Discoveries

- **2026-08-01:** On Node 22 in worktree, `test-production-bom.js` completes all T1-01…T1-27 including T1-08 (previously reported hang point). Suggests hang is intermittent, fixed in HEAD, or occurs in a **later** script in the `test:production` chain.
- Roadmap cites hang between T1-07 and T1-08; code at T1-08 calls `createBom` → `activateBom` → `explodeBom` on a plain BOM — no obvious infinite loop in static review for single-level explode.
- `detectCircular` uses depth + path array but revisits same product via different BOM ids — diamond graphs may need explicit visited-set on `(productId, bomId)` pairs (roadmap requirement).

---

## Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-08-01 | Block production deploy until Wave 0 gate | Roadmap موج صفر + skill override of auto-deploy |
| 2026-08-01 | P0-A remains **open** despite isolated BOM green | Acceptance requires full `test:production` ×3 and ≤5s post-summary exit; not proven yet |
| 2026-08-01 | Copy roadmap to `docs/erp-taranom-master-roadmap.md` | In-repo authoritative reference for Cursor |

---

## Outcomes

*(Fill when Wave 0 gate passes.)*

- [ ] Wave 0 exit gate met
- [ ] Production deploy unblocked
- [ ] Retrospective notes

---

## Phase index

Execute in order. Mark `[x]` when gate passed.

| # | Phase | Plan file | Status |
|---|-------|-----------|--------|
| 1 | P0-A BOM / CI | [P0-A-bom-ci.md](./P0-A-bom-ci.md) | `[ ]` |
| 2 | P0-B Source drift | [P0-B-source-drift.md](./P0-B-source-drift.md) | `[ ]` |
| 3 | P0-S1 TLS sync | [P0-S1-tls-sync.md](./P0-S1-tls-sync.md) | `[ ]` |
| 4 | P0-S2 Android/Electron | [P0-S2-platform-hardening.md](./P0-S2-platform-hardening.md) | `[ ]` |
| 5 | P0-S3 Web/API security | [P0-S3-web-api-security.md](./P0-S3-web-api-security.md) | `[ ]` |
| 6 | P0-C Backup/restore | [P0-C-backup-restore.md](./P0-C-backup-restore.md) | `[ ]` |
| 7 | P0-Q1 Test pyramid | [P0-Q1-test-pyramid.md](./P0-Q1-test-pyramid.md) | `[ ]` |
| 8 | P0-Q2 CI/CD | [P0-Q2-ci-cd.md](./P0-Q2-ci-cd.md) | `[ ]` |

---

## Wave 0 exit gate (from roadmap)

- [ ] Full test suite green
- [ ] Remote sync TLS-only (no HTTP fallback off localhost)
- [ ] Off-server backup operational
- [ ] Successful restore drill documented

---

## Global verification (after each backend phase)

```powershell
cd server
node scripts/test-sms.js
node scripts/test-sync.js
node scripts/_diag-sync-gaps-b16e78.js
```

Frontend parse check:

```powershell
node -e "const fs=require('fs');const h=fs.readFileSync('server/public/index.html','utf8');const m=h.match(/<script>([\s\S]*)<\/script>/i);new Function(m[1]);console.log('ok');"
```

**Deploy:** ❌ blocked until Wave 0 gate — commit/push only.
