# DEMO-V2-SECURE-SALES — Design Note

Status: implementation design (2026-08-14)  
Task: `DEMO-V2-SECURE-SALES`  
Base: `eae0a14`  
Branch: `ai/DEMO-V2-SECURE-SALES`

## Products

Two **separate** demo surfaces. They must not be wired together.

### A. Static Showcase

- Files: `server/public/demo.html`, `demo.js`, `demo.css`
- No backend, no DB, no `fetch` / XHR / WebSocket / EventSource
- Fake in-memory data only
- Visible watermark + «داده‌ها کاملاً ساختگی هستند»
- No credentials, no admin links, no PII persistence

### B. Interactive Sales Demo

- Real Express + SQLite against an isolated demo root
- Enabled **only** by process environment (never query/header/cookie/UI)
- Fail-closed startup if config is incomplete or paths escape the demo root
- Demo Guard blocks sensitive APIs with `403` / `demo_operation_blocked`
- External providers are no-op (zero network) even if real credentials leak into env
- Atomic reset with marker, lock, temp seed, validate, swap, rollback

## Config (typed, env-only)

| Variable | Required when demo | Meaning |
|----------|--------------------|---------|
| `ERP_DEMO_MODE` | yes (`true`/`1`) | Explicit opt-in |
| `ERP_DEMO_ROOT` | yes, absolute | Allowlisted demo filesystem root |
| `ERP_DEMO_INSTANCE_ID` | yes, opaque | Audit / status id (not a secret) |
| `ERP_DEMO_EXPIRES_AT` | yes, ISO-8601 | Fail-closed expiry |
| `JWT_SECRET` | yes, ≥32 chars | No hardcoded seed secret |
| `DB_PATH` | yes, inside root | No production default |
| `UPLOADS_DIR` | yes, inside root | No `server/public/uploads` |
| `COMPANIES_DIR` | yes, inside root | Isolated registry |
| `ERP_DEMO_SALES_URL` | optional | Allowlisted https sales CTA |
| `ERP_DEMO_RESET_TOKEN` | optional, ≥32 | Operator reset API only |
| `ERP_DEMO_NOW` | test-only | Clock override for expiry tests |

Marker file: `<ERP_DEMO_ROOT>/.erp-demo-root` (contents must match instance id).

## Isolation

All of these resolve **inside** the realpath of `ERP_DEMO_ROOT`:

- `DB_PATH` + sqlite sidecars (`-wal`, `-shm`)
- `COMPANIES_DIR`, `UPLOADS_DIR`, `PRIVATE_UPLOADS_DIR`
- `BACKUP_DIR`, `AUTH_SESSION_DB_PATH`
- temp exports, logs, reset staging

Startup rejects: empty paths, production defaults (`server/crm.db`, `server/public/uploads`),
repo root, home, unresolved paths, symlink/junction escape, UNC/network shares unless
`ERP_DEMO_ALLOW_NETWORK=1`, path traversal.

## Accounts

Real RBAC roles only (no `salesperson` alias):

| Username key | Role | Purpose |
|--------------|------|---------|
| `demo_manager` | `sales_manager` | Presenter (not unrestricted admin) |
| `demo_accountant` | `accounting` | Accounting walkthrough |
| `demo_sales` | `field_sales` | CRM / sales |
| `demo_production` | `production_manager` | BOM / production |

Bootstrap `admin` from `initDB` is rotated to a random password written only to a
0600 secrets file under the demo root. Sessions revoked after seed. Public HTML
never contains credentials.

## Reset

1. Acquire lock file (reject concurrent)
2. Write maintenance marker → `/ready` 503, writes 403
3. Seed new DB in `<root>/tmp/reset-<id>/demo.db`
4. Validate invariants
5. Stop demo process (allowlisted name / pidfile only — never `erp-taranom`)
6. Atomic rename: live → `.bak-<ts>`, new → live
7. Start + health/ready smoke
8. Revoke leftover sessions
9. Delete `.bak-*` only after success
10. On failure: restore `.bak-*`, clear maintenance

No glob deletes. Sidecars named exactly.

## License

Known production gaps (no-license writes allowed; public key on activate;
incomplete max_users / feature_flags) are **not hidden**. Demo expiry is
independent of commercial license and fail-closed. License activate/deactivate
and public-key change are Demo-Guard blocked.

## UI

- Interactive: `demo-shell.js` reads `GET /api/demo/status` (non-secret)
- Permanent badge, expiry, sales CTA, watermark
- Accounting-only floating MDI unchanged; dashboards stay single-page
- SW bump only if shell assets change

## Rollback

- Before merge: abandon `ai/DEMO-V2-SECURE-SALES`
- After merge (not in this task): revert the merge commit
- Runtime: restore `demo.db.bak-*` via reset rollback; never touch Production
