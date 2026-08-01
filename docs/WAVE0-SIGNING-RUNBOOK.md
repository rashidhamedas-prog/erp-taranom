# Wave 0 — signed updater / APK runbook

## Decision (2026-08-01)

Code signing **keys stay with the operator** (never in Git). The app enforces signed installs when `REQUIRE_SIGNED_UPDATES=1` on desktop. Android already refuses auto-install of downloaded APKs from WebView.

## Windows (Electron)

1. Obtain a code-signing certificate (EV preferred) and import on the build machine.
2. Set `CSC_LINK` / `CSC_KEY_PASSWORD` (or Windows certificate store) for `electron-builder`.
3. Build: `cd desktop && npm run dist:win` — artifact must be signed; `latest.yml` + `.blockmap` published beside the EXE.
4. On devices set `REQUIRE_SIGNED_UPDATES=1` so unsigned fallback URL install is rejected.
5. Verify: `Get-AuthenticodeSignature .\ERP-Taranom-Setup-*.exe` → `Valid`.

## Android

1. Create `android/keystore.properties` (gitignored) from `android/BUILD.md` template.
2. `scripts/build-android.ps1` — release APK must be signed (`app-release.apk`, not `-unsigned`).
3. Publish SHA-256 of the APK next to `server/public/releases/manifest.json` notes (manual until feed field exists).
4. Devices: sideload signed APK; if signing key changes, uninstall once.

## Gate evidence

- [ ] Signed EXE Authenticode Valid
- [ ] Signed APK (`apksigner verify`)
- [ ] Desktop with `REQUIRE_SIGNED_UPDATES=1` rejects unsigned fallback
- [ ] One successful in-app update on a test PC
