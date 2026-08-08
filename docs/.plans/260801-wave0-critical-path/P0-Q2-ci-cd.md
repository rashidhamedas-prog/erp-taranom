# Phase P0-Q2 — CI/CD pipeline

**Status:** `[~]` — Wave0 CI expanded; staging/production deploy jobs remain disabled
**Roadmap:** فاز P0-Q2

## Tasks

- [x] Lint + frontend script parse in CI
- [x] Parallel test suites with per-job timeout
- [x] Dependency/security scan
- [x] Migration test job
- [x] Source drift check (from P0-B)
- [ ] Staging deploy + smoke
- [x] Manual production approval + verify-before-promote/rollback uploader for RC feed
- [x] Versioned artifacts + SHA-256/SHA-512 + HTTP re-verification

## Verification

- [ ] CI green on PR to working branch
- [ ] Failed suite produces logs artifact
- [ ] Drift job fails on embedded mismatch

**Operational evidence:** APK 2.0.33 / EXE 2.0.10 and metadata were staged, verified, atomically promoted and HTTP-hash checked on 2026-08-08. CI/staging automation remains a Q2 follow-up.
