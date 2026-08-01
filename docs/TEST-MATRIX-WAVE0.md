# Wave 0 test matrix

| Risk / critical path | Automated coverage | Gate state |
|---|---|---|
| Production BOM, costing, close, RBAC, reports | `npm run test:production` (isolated scripts with per-script timeout) | Automated |
| Offline pairing, push/pull, conflicts, accounting convergence | `server/scripts/test-sync.js` | Automated |
| TLS-only central URL, certificate error hygiene | `test-sync-tls-url.js` | Automated; real public-certificate probe remains an operational check |
| Device token expiry/rotation/revoke/replay | `test-sync.js`, scenarios device request guard + credential lifecycle | Automated |
| Embedded desktop/Android source drift and release ID | `prepare-embedded-server.js`, `compare-embedded-hash.js`, `test-embedded-release.js` | Automated |
| Android/Electron deep-link/navigation policy | `scripts/test-platform-security.js` | Automated policy test; signed APK/EXE install test waived until signing credentials and explicit build approval |
| B2B authentication, isolation, order and statement | `server/scripts/test-b2b.js` | Automated |
| Backup encryption, checksum, SQLite integrity and isolated extraction | `server/scripts/test-backup-dr.js` | Automated locally; off-server S3 restore drill remains operational gate |
| SMS behavior | `server/scripts/test-sms.js` | Automated |
| Multi-company / fiscal migrations | `server/scripts/test-companies-fiscal.js` | Automated |
| Frontend syntax | inline-script parse CI step | Automated |
| Browser financial E2E (purchase → warehouse → sale → accounting) | No Playwright harness in repository | Open P0-Q1 gap; owner: frontend/QA |
| Android and Windows signed install/upgrade | Requires signing keys and full artifacts | Explicit waiver for this run: user prohibited full APK/EXE builds |
| Cross-tenant IDOR | Company DB isolation plus existing RBAC suites; no dedicated hostile matrix | Open P0-Q1 gap; owner: security/backend |
| Dependency vulnerability scan | `npm audit --omit=dev --audit-level=high` in CI | Failing: 7 advisories / 4 high; `xlsx` has no published fix |

Wave 0 production deploy stays blocked until every operational gate is evidenced: off-site backup/restore within RTO, signed updater verification, browser E2E and cross-tenant hostile tests.
