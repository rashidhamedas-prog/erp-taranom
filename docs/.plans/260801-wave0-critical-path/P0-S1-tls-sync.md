# Phase P0-S1 — TLS & sync security

**Status:** `[x]`
**Roadmap:** فاز P0-S1

## Tasks

- [x] Remove HTTP fallback except 127.0.0.1 / localhost
- [x] `normalizeCentralUrl` rejects remote HTTP
- [x] Migrate stored HTTP URLs → HTTPS or block
- [x] Device token rotation, revoke, expiry
- [x] Mask tokens in logs/UI/errors
- [x] Replay protection (nonce/idempotency, time window)

## Verification

- [x] Tests: remote HTTP rejected, HTTPS accepted
- [x] Invalid cert blocks sync and yields a redacted TLS error
- [x] Revoked device blocked on next push/pull

**Deploy:** ❌ Wave 0 blocked
