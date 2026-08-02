# Phase P0-C — Backup, restore & DR

**Status:** `[-]` — local drill green; real off-server drill pending
**Roadmap:** فاز P0-C

## Tasks

- [x] Document RPO ≤15m, RTO ≤4h
- [x] WAL-safe SQLite backup
- [x] Encrypt backups with key off VPS
- [x] Second copy to S3-compatible storage (configuration-driven; production credentials pending)
- [x] Retention policy + integrity_check + checksum per backup
- [x] Weekly isolated restore drill script + status (`weekly-backup-drill.js`) — real off-server ops still pending
- [x] DR runbook (full server, single company, attachment restore)

## Verification

- [ ] Restore blank VPS within RTO
- [ ] Trial balance + invoice counts match pre/post restore

**Deploy:** ❌ Wave 0 blocked
