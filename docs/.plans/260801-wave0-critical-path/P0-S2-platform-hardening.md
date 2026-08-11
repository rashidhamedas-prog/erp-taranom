# Phase P0-S2 — Android & Electron hardening

**Status:** `[x]` — source gate complete; final post-hardening binaries must be rebuilt/re-signed before release
**Roadmap:** فاز P0-S2

## Android

- [x] `allowBackup=false` or strict extraction rules
- [x] `usesCleartextTraffic` off except loopback config
- [x] WebView debugging off in release
- [x] APK update URL + size + SHA-256 + package/version + signer-continuity verify; mismatch deleted
- [x] AndroidKeyStore AES-GCM for local JWT secret, with verified plaintext migration/removal
- [x] Device token encrypted at rest with AES-256-GCM and authenticated envelope
- [x] Root/debuggable warning; unstructured APK downloads blocked

## Electron

- [x] `sandbox:true` if compatible
- [x] Navigation/window-open loopback only
- [x] `shell.openExternal` https + allowlist
- [x] CSP for renderer (served by embedded backend; no `unsafe-eval`)
- [x] Windows DPAPI (`safeStorage`) for local JWT secret, fail-closed in packaged builds
- [x] Updater HTTPS allowlist + exact metadata + streamed size/SHA-256 verification
- [x] Authenticode/publisher enforcement defaults on for packaged Windows builds
- [x] IPC sender, permissions, redirects, child windows and webview attachment restricted

## Verification

- [x] Malicious deep links / file: / javascript: rejected
- [x] OS backup excludes DB and device token
- [x] Android static security 27/27 + Java SDK 36 direct compile
- [x] Desktop policy/secret/main tests 42/42 + syntax 4/4
- [x] Local encrypted token migration/tamper/fail-closed tests
- [x] Release manifest SHA-256/size matches current signed APK/EXE; APK v2 and Authenticode signatures verified
- [x] Official embedded prepare: 204/204 each target, SHA-256 drift 0, release 7/7

## Release boundary

The already-signed APK 2.0.32 and EXE 2.0.9 prove the signing pipeline and current
release metadata, but they predate this hardening source change. No full platform
build was authorized in this task. A final release candidate must therefore run the
same build/sign/verify pipeline again before any deployment. No key or password is
stored in Git.

**Deploy:** ❌ Wave 0 blocked
