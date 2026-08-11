# Wave 0 — Phase detail (progressive disclosure)

Read when executing a specific phase. Source: `docs/erp-taranom-master-roadmap.md`.

## P0-A — BOM / CI hang

**Files:** `server/scripts/test-production-bom.js`, `server/lib/production/bom.js`, `server/scripts/lib/test-harness.js`, `server/package.json` (`test:production*`).

**Investigation checklist:**

1. Stage logging before/after each T1-xx block.
2. Run isolated: `node scripts/test-production-bom.js` vs full `npm run test:production`.
3. If hang after summary: inspect open handles (`process._getActiveHandles`), WAL/SHM cleanup, timers, servers.
4. Review `explodeBom`, `resolveSubstitutes`, `detectCircular` for infinite recursion (roadmap: path-based visited set, not depth-only).
5. Per-script timeout wrapper in CI; fail with artifact log.

**Acceptance:** roadmap § P0-A معیار پذیرش.

---

## P0-B — Source drift

**Files:** `desktop/`, `android/`, prepare scripts, `releases/manifest.json`, `/api/system/app-info`.

**Tasks:** unified prepare script; exclude db/uploads/logs/node_modules from copy; SHA-256 compare; CI fail on drift.

---

## P0-S1 — TLS sync

**Files:** `server/sync/client.js`, URL normalization, device pairing.

**Tasks:** reject non-local HTTP; migrate stored URLs; token rotation/revoke; mask tokens in logs.

---

## P0-S2 — Android / Electron

**Android:** `AndroidManifest.xml`, network security config, keystore for secrets.

**Electron:** sandbox, navigation handler, CSP, updater signature check.

---

## P0-S3 — Web/API security

**Files:** `server/server.js` (Helmet/CORS), upload routes, auth middleware.

**Tasks:** CSP with nonce; sanitizer for innerHTML; CORS fail-fast; upload MIME/signature checks; rate limits; 2FA recovery hashing.

---

## P0-C — Backup / restore

**Files:** `server/backup.js`, cron, off-server storage config.

**Tasks:** RPO/RTO doc; WAL-safe snapshot; encryption; S3-compatible second copy; weekly isolated restore + alert; runbook.

---

## P0-Q1 — Test pyramid

Inventory and gap-fill for unit (money, jalali, tax, payroll, costing), integration (financial routes, RBAC, sync, migration), Playwright E2E paths listed in roadmap, mobile/desktop install/sync scenarios.

---

## P0-Q2 — CI/CD

Lint, parallel suites + timeout, dependency audit, migration test, source drift job, staged deploy smoke, production approval + rollback artifacts.
