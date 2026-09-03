# 08 — Deployment (PROD-P5-R2 / Iran)

Short ops notes for safe production apply. Full history lives in `CHANGE-LOG.md`.

## Canonical public domain

- **HTTPS base:** `https://erp.poshaktaranom.com`
- Deploy / smoke defaults (e.g. `scripts/deploy-sharp-production.ps1` `-PublicBaseUrl`) must use this host — not legacy `erp.taranom.app`.
- **Origin TLS (Cloudflare Full strict):** nginx uses Cloudflare Origin CA (15y, `*.poshaktaranom.com` + apex) at `/etc/ssl/taranom/erp.poshaktaranom.com.{crt,key}`. Do not revert to self-signed (CF 526) and do not enable Authenticated Origin Pulls without the AOP client CA. Iran VPS cannot reliably reach Let's Encrypt API.

## Hard rules on Iran VPS (`taranom@94.249.244.208`)

| Forbidden | Why |
|-----------|-----|
| Blind `git pull` / `git reset --hard` on a dirty tree | Overwrites local overlays / untracked recover stamps |
| `pm2 restart … --update-env` | Can wipe curated PM2 env (JWT, backup paths, etc.) |

Prefer **targeted SFTP overlays** of known files + `pm2 restart erp-taranom` **without** `--update-env`, then HTTP smoke.

## Login / origin downtime (v185)

Intermittent «خطای ارتباط با سرور» on the login page is usually **origin restart**, not a bad password:

1. `pm2 restart` or `max_memory_restart` kills the only Node process → Cloudflare **521/502** → browser `fetch` throws.
2. The login form used to fail on the **first** failed fetch with a generic message.

Mitigations in product:

- PM2 `max_memory_restart: 1024M` + `wait_ready` (process sends `ready` after schema init).
- HTTP listen **before** `initDB()` so the kernel accept-queue survives schema boot; `/api/system/ready` is 503 `STARTING` until `bootGate.markReady()`.
- Login and GET APIs retry transient 502/503/521–524 with backoff; login errors are classified (starting vs timeout vs 401).
- SIGINT/SIGTERM drain: new APIs get 503 `RESTARTING` for a few seconds instead of connection reset.

Nginx origin should keep `proxy_connect_timeout` modest (e.g. 5s) so a dead process fails fast and the **client retry** can hit the new process. Do not enable Authenticated Origin Pulls.

## Evidence recipes (read-only / non-mutating)

### 1) Hash probe (local vs VPS)

Compares SHA-256 of BOM-critical files. SSH is optional and **read-only** (`sha256sum` only).

```powershell
cd "D:\soft\Claud\porje\Run in the project\erp-taranom-prod-p5-r2"
python scripts/_probe-prod-p5-r2-hashes.py
```

Files covered:

- `server/public/app.js`
- `server/lib/production/bom-advanced.js`
- `server/routes/production-boms.js`

If `~/.ssh/id_ed25519_taranom` is missing or SSH fails, the script still prints local hashes and exits `0`.

### 2) Role / health smoke (HTTP only)

```powershell
cd "D:\soft\Claud\porje\Run in the project\erp-taranom-prod-p5-r2"
python scripts/_smoke-prod-p5-r2-roles.py

# optional authenticated checks:
$env:SMOKE_USER="admin"
$env:SMOKE_PASS="••••"
$env:SMOKE_BOM_ID="123"   # optional; otherwise first listable BOM
$env:SMOKE_OP_USER="op1"  # production_operator — cost-strip check
$env:SMOKE_OP_PASS="••••"
python scripts/_smoke-prod-p5-r2-roles.py
```

Checks:

- `GET /`, `/api/system/health`, `/api/system/ready` → expect HTTP 200
- UI markers in `app.js` / index: `اقلام`, `مسیر عملیات`, `خروجی‌ها`, `بهای تمام‌شده`
- With credentials: login + BOM GET endpoints; operator path asserts cost fields stripped (or `std-cost` 403)

Override base: `$env:SMOKE_BASE_URL="https://erp.poshaktaranom.com"`.

## After an approved overlay

1. Run hash probe — local vs remote `match=YES` for changed files.
2. Run role smoke — public 200s + UI markers; authenticated checks if creds available.
3. Record stamp / tip in `docs/CHANGE-LOG.md` (parent/orchestrator).
