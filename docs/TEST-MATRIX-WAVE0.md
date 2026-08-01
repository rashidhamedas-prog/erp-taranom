# Wave 0 test matrix

| Risk / critical path | Automated coverage | Gate state |
|---|---|---|
| Production BOM, costing, close, RBAC, reports | `npm run test:production` | Automated |
| Offline pairing, push/pull, conflicts | `server/scripts/test-sync.js` | Automated |
| TLS-only central URL | `test-sync-tls-url.js` | Automated |
| Device token expiry/rotation/revoke/replay | `test-sync.js` | Automated |
| Embedded source drift / release ID | `prepare-embedded-server.js`, `compare-embedded-hash.js` | Automated |
| Android/Electron navigation policy | `scripts/test-platform-security.js` | Automated policy; signed install needs ops keys |
| B2B auth / isolation | `test-b2b.js` | Automated |
| Backup encrypt + **off-site FS mirror** + restore | `test-backup-dr.js` (BACKUP_OFFSITE_DIR) | Automated; wire `BACKUP_OFFSITE_DIR` or S3 on prod |
| SMS | `test-sms.js` | Automated |
| Multi-company / fiscal | `test-companies-fiscal.js` | Automated |
| Financial cycle + hostile cross-company IDOR | `test-wave0-financial-hostile.js` | Automated |
| Browser login E2E | `e2e/login.spec.js` (Playwright) | Automated in CI |
| Dependency high/critical | `npm run audit:gate` (xlsx waived ≤2026-10-01) | Automated with waiver |
| Signed EXE/APK install | `docs/WAVE0-SIGNING-RUNBOOK.md` | Ops credentials required |
| Full CSP without unsafe-inline | deferred — see WAVE0-GATE-STATUS.md | Open (break-glass risk) |
