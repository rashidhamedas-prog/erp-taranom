# Phase P0-S3 — Web & API security

**Status:** `[x]` — 2026-08-01 Cursor continuation after Codex handoff  
**Roadmap:** فاز P0-S3

## Tasks

- [x] CSP without `unsafe-inline`/`unsafe-eval`; Trusted Types; asset split (`app.js`/`app.css`/`csp-runtime.js`/…)
- [x] Central HTML sanitizer + `data-csp-*` delegation; secure print HTML (`secure-html-response.js`)
- [x] CORS fail-fast; production HTTPS-only origins
- [x] Upload MIME/magic/size/polyglot/XLSX-ZIP/PDF policy (`upload-policy.js`)
- [x] Private uploads + sync file auth (`private-uploads.js`, `sync/files.js`, `multipart-policy.js`)
- [x] SSRF HTTPS-only + DNS pin + redirect revalidation (`safe-outbound-request.js`)
- [x] Secret settings `enc:v2` + API redaction (`secret-settings.js`)
- [x] Staff/B2B sessions with sid hash store; company switch guard; portal no fixed `12345`
- [x] Rate limits persistent; login anti-enumeration; 2FA challenge one-time; recovery HMAC `h1:`
- [x] Sync capture failure → 503 + durable repair queue; Ed25519 replay attestation

## Verification (Cursor 2026-08-01)

| Suite | Result |
|-------|--------|
| auth login rate persistence | 4/4 |
| auth session security | 46/46 |
| auth migration / cleanup / middleware / bootstrap | 9+8+1+3 |
| company switch safety | 2/2 |
| cross-company session isolation | 2/2 |
| B2B | 34/34 |
| portal | 64/64 |
| 2FA recovery digest | 8/8 |
| sync replay / capture repair | 8+2 |
| upload/SSRF | 55/55 |
| sync file security | 19/19 |
| TLS URL | 9/9 |
| full sync | 44/44 |
| secret settings | 37/37 |
| SMS | 22/22 |
| secure HTML / CSP DOM / CSP browser | 10 + static + 15/15 |
| P0-S2 regression | platform 7 + Android 27 + desktop 42 + app-update/integrity |

Fix applied this session: `mirrorStaffSession` DELETE by `UNIQUE(user_id,device_slot)`; `failLoginChallenge`/`consumeLoginChallenge`/`revokeCurrentB2BSession` scoped by `company_id`.

**Deploy:** ❌ Wave 0 blocked (commit/push only)
