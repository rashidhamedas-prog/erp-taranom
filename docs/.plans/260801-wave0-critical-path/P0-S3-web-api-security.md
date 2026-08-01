# Phase P0-S3 — Web & API security

**Status:** `[ ]`  
**Roadmap:** فاز P0-S3

## Tasks

- [ ] CSP with nonce/hash; no unsafe-eval
- [ ] innerHTML inventory + central sanitizer
- [ ] CORS fail-fast without valid ALLOWED_ORIGINS in production
- [ ] Upload MIME/signature/size validation
- [ ] SSRF checks on external URL fetches
- [ ] Rate limits (OTP, login, pairing, upload, reports)
- [ ] Session refresh/revocation; logout all devices
- [ ] Security audit log for role/permission/backup changes

## Verification

- [ ] OWASP subset tests (XSS, IDOR, auth bypass, upload, rate limit)
- [ ] Cross-tenant access denied

**Deploy:** ❌ Wave 0 blocked
