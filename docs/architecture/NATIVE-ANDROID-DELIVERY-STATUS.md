# Native Android Sales — Delivery Status

> Branch: `ai/ANDROID-NATIVE-SALES` · Worktree: `D:/proje/erp-taranom-android-native`  
> Owner authorization: full phases without further permission (2026-09-27)

## Done (phases 0–5 code)

| Item | Evidence |
|---|---|
| ADR + matrix + decisions locked | `docs/architecture/NATIVE-ANDROID-*.md` |
| AI-DOS task claimed; DESKTOP-EXE released | `.ai-dos/tasks/active.yaml` |
| Compose sales shell (no WebView/Node) | `android-native/app` — customers/catalog/cart/more + CRM/finance/conflicts/reports/help |
| Room v2 + migrations (no destructive fallback) | `core/database` |
| VAT/Round3/LineBuilder/DraftOrder/CRM/Financial capture | `core/domain` + unit tests |
| Sync wire: HMAC + Ed25519 + OkHttp + SyncEngine | `sync/api` + `sync:impl` |
| Legacy migrator fail-closed + AES-GCM backup | `:migrate` |
| Signed APK update policy (manifest sha256 required) | `:update` |
| WorkManager stubs | `app/.../work/` |
| visits/calls sync capture map | `server/sync/capture.js` |
| Release signing fail-closed | `app/build.gradle.kts` |
| JDK 17 JVM tests | `:core:domain:test` `:sync:impl:test` `:migrate:test` `:update:test` **BUILD SUCCESSFUL** |

## Blocked on this host (environment)

| Blocker | Impact | Mitigation |
|---|---|---|
| Android SDK platforms/build-tools missing (cmdline-tools empty; Google download 404 via proxy) | Cannot `assembleDebug` / release APK here | Install full Android SDK on a machine with repository access; `local.properties` → `sdk.dir` |
| Release keystore not in worktree (gitignored) | Cannot signed release APK | Operator places `keystore.properties` + `.jks` |
| Physical air-gap device matrix | Not executed | Run when device available |
| Independent Reviewer + Security | PENDING before GA claim | Required before marking product GA |

## Version targets

- Native `versionCode` **100** / `3.0.0-alpha01` (`applicationId` `ir.taranom.crm`)
- Legacy `android/` remains until migrator green on device

## Next commands (on SDK machine)

```powershell
$env:JAVA_HOME="C:\Program Files\Microsoft\jdk-17.0.20.101-hotspot"
cd D:\proje\erp-taranom-android-native\android-native
# local.properties: sdk.dir=...
.\gradlew.bat :core:domain:test :sync:impl:test :migrate:test :update:test :app:assembleDebug
# with keystore:
.\gradlew.bat :app:assembleRelease
```
