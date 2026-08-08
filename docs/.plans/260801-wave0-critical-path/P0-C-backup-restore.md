# Phase P0-C — Backup, restore & DR

**Status:** `[x]` — real Windows off-server copy and isolated restore drill green (2026-08-08)
**Roadmap:** فاز P0-C

## Tasks

- [x] Document RPO ≤15m, RTO ≤4h
- [x] WAL-safe SQLite backup
- [x] Encrypt backups with key off VPS
- [x] Second copy outside VPS to the Windows offsite agent (S3 remains an optional alternative)
- [x] Retention policy + integrity_check + checksum per backup
- [x] Weekly isolated restore drill script + status (`weekly-backup-drill.js`) — real Windows off-server drill completed
- [x] DR runbook (full server, single company, attachment restore)

## Verification

- [x] Restore an off-server downloaded package in a blank isolated workspace within RTO (3s estimate)
- [x] Financial/company fingerprints match pre/post restore

**Evidence:** `crm-backup-20260808-153000.zip.enc`, SHA-256 `2166FB8E9C0F75719F7B87DFA4A01D4F72DA442C4D0553DB53F92986C5A1B866`; Scheduled Task result `0`.
