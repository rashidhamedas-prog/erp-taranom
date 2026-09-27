# Project Status

- Last verified: 2026-09-27
- **Active task:** `ANDROID-NATIVE-SALES` — native Compose sales app (`ai/ANDROID-NATIVE-SALES`, worktree `D:/proje/erp-taranom-android-native`)
- Owner authorized full phases without further permission (2026-09-27)
- Prior: `DESKTOP-EXE-DELIVER` completed (EXE 2.0.12); claims released
- Iran last: unchanged by Android task until APK/manifest publish

## Working quality commands

- Isolated QA (temp DB, no production): `set NODE_ENV=test` then `node scripts/qa/run-full-erp-qa.js` (exit 0/1/2/3)
- `git diff --check`
- `node --check server/server.js`
- `node --check server/public/app.js`
- `node server/scripts/check-ui-encoding.js`
- `node server/scripts/check-audit-waivers.js`
- `node server/scripts/test-sms.js`
- `node server/scripts/test-sync.js` (requires better-sqlite3 matching current Node ABI)
- Native Android: `cd android-native` then `.\gradlew.bat :core:domain:test :app:assembleDebug` (JDK 17 + Android SDK)
- Desktop build: `powershell -File scripts/build-desktop-signed.ps1` then copy to `D:\proje\ERP EXE`
