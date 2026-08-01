# Phase P0-S2 — Android & Electron hardening

**Status:** `[-]` — code hardening complete; signing/key-store operational gates open
**Roadmap:** فاز P0-S2

## Android

- [x] `allowBackup=false` or strict extraction rules
- [x] `usesCleartextTraffic` off except loopback config
- [x] WebView debugging off in release
- [ ] APK update checksum + signature verify
- [ ] Keystore for local secrets

## Electron

- [x] `sandbox:true` if compatible
- [x] Navigation/window-open loopback only
- [x] `shell.openExternal` https + allowlist
- [x] CSP for renderer (served by embedded backend; no `unsafe-eval`)
- [ ] Updater signature check

## Verification

- [x] Malicious deep links / file: / javascript: rejected
- [x] OS backup excludes DB and device token

**Deploy:** ❌ Wave 0 blocked
