# Project Status

- Last verified: 2026-09-27
- **Active task:** `DESKTOP-EXE-DELIVER` — Windows EXE 2.0.12 built to `D:/proje/ERP EXE` (build OK + smoke; not public-release-ready)
- **Iran last:** unchanged by this task (no binary/metadata production publish)
- **Primary tip:** follow `main` after merge of `ai/DESKTOP-EXE-DELIVER`
- Prior: CRM user scope / dashboard / print density — see CHANGE-LOG

## Working quality commands

- Isolated QA (temp DB, no production): `set NODE_ENV=test` then `node scripts/qa/run-full-erp-qa.js` (exit 0/1/2/3)
- `git diff --check`
- `node --check server/server.js`
- `node --check server/public/app.js`
- `node server/scripts/check-ui-encoding.js`
- `node server/scripts/check-audit-waivers.js`
- `node server/scripts/test-sms.js`
- `node server/scripts/test-sync.js` (requires better-sqlite3 matching current Node ABI)
- `node desktop/scripts/test-security-policy.js`
- `node desktop/scripts/test-main-hardening-static.js`
- `node desktop/scripts/test-local-secret-store.js`
- `node scripts/test-platform-security.js`
- `node scripts/prepare-embedded-server.js desktop && node scripts/compare-embedded-hash.js` (desktop target drift=0)
- Desktop build: `powershell -File scripts/build-desktop-signed.ps1` then copy to `D:\proje\ERP EXE`
