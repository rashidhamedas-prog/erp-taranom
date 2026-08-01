# Phase P0-S1 — TLS & sync security

**Status:** `[ ]`  
**Roadmap:** فاز P0-S1

## Tasks

- [ ] Remove HTTP fallback except 127.0.0.1 / localhost
- [ ] `normalizeCentralUrl` rejects remote HTTP
- [ ] Migrate stored HTTP URLs → HTTPS or block
- [ ] Device token rotation, revoke, expiry
- [ ] Mask tokens in logs/UI/errors
- [ ] Replay protection (nonce/idempotency, time window)

## Verification

- [ ] Tests: remote HTTP rejected, HTTPS accepted
- [ ] Invalid cert blocks sync
- [ ] Revoked device blocked on next push/pull

**Deploy:** ❌ Wave 0 blocked
