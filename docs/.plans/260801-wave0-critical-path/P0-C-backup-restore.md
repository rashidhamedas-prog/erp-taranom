# Phase P0-C — Backup, restore & DR

**Status:** `[ ]`  
**Roadmap:** فاز P0-C

## Tasks

- [ ] Document RPO ≤15m, RTO ≤4h
- [ ] WAL-safe SQLite backup
- [ ] Encrypt backups with key off VPS
- [ ] Second copy to S3-compatible storage
- [ ] Retention policy + integrity_check + checksum per backup
- [ ] Weekly isolated restore drill + alert
- [ ] DR runbook (full server, single company, attachment restore)

## Verification

- [ ] Restore blank VPS within RTO
- [ ] Trial balance + invoice counts match pre/post restore

**Deploy:** ❌ Wave 0 blocked
