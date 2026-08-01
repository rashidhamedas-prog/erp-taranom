# Phase P0-Q2 — CI/CD pipeline

**Status:** `[-]` — CI gate added; staging/production actions intentionally blocked
**Roadmap:** فاز P0-Q2

## Tasks

- [x] Lint + frontend script parse in CI
- [x] Parallel test suites with per-job timeout
- [x] Dependency/security scan
- [x] Migration test job
- [x] Source drift check (from P0-B)
- [ ] Staging deploy + smoke
- [ ] Production approval gate + rollback artifacts
- [ ] Versioned artifacts + checksum

## Verification

- [ ] CI green on PR to working branch
- [ ] Failed suite produces logs artifact
- [ ] Drift job fails on embedded mismatch

**Deploy:** ❌ Wave 0 blocked until full gate; then enable staging → production with approval
