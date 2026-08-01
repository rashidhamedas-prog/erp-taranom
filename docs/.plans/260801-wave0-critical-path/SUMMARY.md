# Wave 0 — Critical Path Execution Plan

> Living plan for Cursor. Master backlog: [`docs/erp-taranom-master-roadmap.md`](../../erp-taranom-master-roadmap.md) §17.  
> Skill: `.cursor/skills/erp-roadmap-wave0` · Agents: `erp-wave0-executor`, `erp-p0-bom-ci`  
> **Deploy:** forbidden until Wave 0 gate (commit+push OK).

---

## Progress

| # | Phase | Status | Notes |
|---|-------|--------|-------|
| 1 | P0-A BOM/CI hang | ☐ pending | Planned; hang not fixed in pack session |
| 2 | P0-B source drift | ☐ pending | After P0-A |
| 3 | P0-S1 TLS/sync | ☐ pending | |
| 4 | P0-S2 Android/Electron | ☐ pending | |
| 5 | P0-S3 web/API | ☐ pending | |
| 6 | P0-C backup/restore | ☐ pending | After security critical |
| 7 | P0-Q1 test pyramid | ☐ pending | |
| 8 | P0-Q2 CI/CD | ☐ pending | |
| — | **Wave 0 gate** | ☐ closed | Suite green + TLS-only remote + off-box backup/restore |

### Pack bootstrap (this session)

- [x] Copy roadmap → `docs/erp-taranom-master-roadmap.md`
- [x] Skill + agents + this plan
- [x] CHANGE-LOG infrastructure entry (no deploy)

---

## Surprises & Discoveries

- T1-08 body (not T1-07 itself) is the first heavy call after historical resolve: `createBom` → `activateBom` → `explodeBom` on a plain BOM for `p102`.
- `detectCircular` (`bom.js` ~217) recurses with `depth > 10` only; **no path visited-set** — roadmap requires path-based cycle detection.
- `explodeBom` multilevel child resolve uses empty `catch { }` — can hide errors; unlikely sole cause of T1-08 hang (plain BOM, `is_multilevel` typically off).
- `test:production` is a long `&&` chain in `server/package.json` with **no per-file timeout**; any hang blocks the entire suite.
- Harness `summary()` → `process.exit(code)`; open handles from later scripts (HTTP servers in api-smoke/ui-smoke/etc.) are a separate exit-hang class after BOM is fixed.
- T1-20 uses `bcrypt.hashSync(..., 10)` — slow but after T1-08; not the reported stop point.

---

## Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-08-01 | Pack-only first; hang fix planned not implemented | Best-of-n deliverable is executable Cursor pack; full hang fix optional |
| 2026-08-01 | Override auto-commit-deploy for Wave 0 | Roadmap §3.1 + §17 gate; skill encodes commit+push OK, no pm2/Iran |
| 2026-08-01 | Branch `codex/wave0-execution-pack` | Roadmap §3.1 phase branches with `codex/` prefix |
| 2026-08-01 | Order S1→S2→S3 then C then Q | Matches roadmap §17 Wave 0 list |

---

## Outcomes

- **Pack:** skill, agents, roadmap copy, living plan ready for executors.
- **P0-A code fix:** not done in this session — see concrete steps below.
- **Production deploy:** none (intentional).

---

## Phase details

### P0-A — BOM hang + CI reliability (FIRST)

**Goal:** All production suites finish in bounded time; BOM tests actually run through the last case.

**File targets**

| File | Role |
|------|------|
| `server/lib/production/bom.js` | `createBom`, `activateBom`, `validateBom`, `detectCircular`, `resolveSubstitutes`, `explodeBom` |
| `server/scripts/test-production-bom.js` | T1-01…T1-27; hang after T1-07 |
| `server/scripts/lib/test-harness.js` | `freshDb` / `cleanup` / `summary` exit |
| `server/package.json` | `test:production` / per-script timeouts |
| CI workflow (when present) | fail on timeout; keep log artifact |

#### Concrete hang diagnosis (T1-07 → T1-08)

1. **Instrument** (temporary or `DEBUG_BOM_TEST=1`):
   ```js
   // immediately after T1-07 success block
   console.log('[BOM-TEST] enter T1-08');
   console.log('[BOM-TEST] createBom start');
   // ... createBom ...
   console.log('[BOM-TEST] createBom done', plain?.id);
   console.log('[BOM-TEST] activateBom start');
   // ... activateBom ...
   console.log('[BOM-TEST] activateBom done');
   console.log('[BOM-TEST] explodeBom start');
   // ... explodeBom ...
   console.log('[BOM-TEST] explodeBom done');
   ```
2. Run: `cd server && node scripts/test-production-bom.js` with a **120s external timeout** (PowerShell `Wait-Process` / `timeout`). Note last log line.
3. If stuck in `activateBom` → log inside `validateBom` / `detectCircular` (entry, each product id, depth).
4. If stuck in `createBom` → check `allocateNumber`, inserts, unique constraints, long migrations via `initDB` already done at start (unlikely mid-test).
5. If stuck in `explodeBom` → log `resolveSubstitutes` and per-line; confirm `is_multilevel` for plain BOM.
6. Dump active handles on watchdog fire; ensure `cleanup()` still runs in `finally`.
7. **Fix cycle detection:** maintain `pathSet` / array includes on `component_product_id`; throw `E_BOM_CIRCULAR` when revisiting; keep depth as secondary guard.
8. Add tests: self-ref (exists T1-10), two-node (T1-11), multi-level cycle, **diamond** (A→B, A→C, B→D, C→D) must not false-positive; cycle through diamond edge must throw.
9. Wrap production scripts with per-file timeout (e.g. `node scripts/_run-with-timeout.js 180 scripts/test-production-bom.js`) and wire into `test:production`.
10. Verify three consecutive: `npm run test:production`; process dead ≤5s after final summary; no unknown open handles.

**Verification**

```powershell
cd server
node scripts/test-production-bom.js
npm.cmd run test:production
# repeat test:production twice more
```

**Acceptance**

- [ ] T1-01 through last BOM test execute (log proves T1-08+)
- [ ] Process exits ≤5s after summary
- [ ] Suite green on Node 20 and current dev Node
- [ ] No unknown open handles
- [ ] `test-sms` + `test-sync` still pass after changes

---

### P0-B — Source drift web / desktop / Android

**Targets:** shared prepare script(s), exclude DB/uploads/logs/`node_modules`, SHA-256 compare after prepare, single release id in manifest / `/api/system/app-info`.

**Verify:** runtime hash drift = 0; no full APK/EXE ship unless user asks.

**Acceptance:** zero drift; shared release id; devices would get same migrations/routes as central (platform limits excepted).

---

### P0-S1 — TLS + sync hardening

**Targets:** sync client `normalizeCentralUrl`, remove remote HTTP fallback, token rotate/revoke/expiry, mask tokens, replay nonce/idempotency.

**Verify:** tests reject HTTP remote; accept HTTPS; revoke blocks push/pull.

---

### P0-S2 — Android + Electron hardening

**Targets:** `allowBackup`, cleartext/network security config, WebView flags; Electron sandbox, navigation allowlist, `openExternal`, CSP, updater signature.

**Verify:** malicious deep links / `file:` / `javascript:` rejected; OS backup excludes DB/tokens.

---

### P0-S3 — Web + API hardening

**Targets:** real CSP, `innerHTML` inventory + sanitizer, CORS fail-fast, upload MIME/signature limits, SSRF checks, rate limits, session/2FA recovery, security audit events, no secret fallbacks in prod middleware.

**Verify:** OWASP-oriented suite; no cross-tenant IDOR.

---

### P0-C — Backup / restore / DR

**Targets:** WAL-safe snapshot, encrypt before leave host, off-VPS object storage, retention, integrity_check, weekly isolated restore, runbooks, disk/backup failure alerts.

**Verify:** empty machine restore within RTO; trial balance / invoice counts / file checksums match; key not only on same VPS.

---

### P0-Q1 — Test pyramid

**Targets:** unit (money, jalali, tax, payroll, costing); integration (financial routes, RBAC, sync, migration); Playwright money paths; device offline/sync smoke design.

**Verify:** critical paths covered; suites exit cleanly.

---

### P0-Q2 — CI/CD

**Targets:** lint/syntax, parallel suites + timeouts, dep scan, migration test, source drift check, staging + smoke, prod approval gate (still no Iran until Wave 0 gate + explicit open).

**Verify:** CI red on hang, drift, or missing tests.

---

## Wave 0 gate checklist

- [ ] Full relevant suite green (incl. `test:production` ×3)
- [ ] Remote sync TLS-only (P0-S1)
- [ ] Off-box encrypted backup + successful restore (P0-C)
- [ ] Q1/Q2 baseline gates in CI
- [ ] Only then consider restoring auto-deploy policy
