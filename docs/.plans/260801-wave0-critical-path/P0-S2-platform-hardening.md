# Phase P0-S2 — Android & Electron hardening

**Status:** `[ ]`  
**Roadmap:** فاز P0-S2

## Android

- [ ] `allowBackup=false` or strict extraction rules
- [ ] `usesCleartextTraffic` off except loopback config
- [ ] WebView debugging off in release
- [ ] APK update checksum + signature verify
- [ ] Keystore for local secrets

## Electron

- [ ] `sandbox:true` if compatible
- [ ] Navigation/window-open loopback only
- [ ] `shell.openExternal` https + allowlist
- [ ] CSP for renderer
- [ ] Updater signature check

## Verification

- [ ] Malicious deep links / file: / javascript: rejected
- [ ] OS backup excludes DB and device token

**Deploy:** ❌ Wave 0 blocked
