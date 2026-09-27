# Native Android Sales — Delivery Status

> Branch: `ai/ANDROID-NATIVE-SALES` · Worktree: `D:/proje/erp-taranom-android-native`  
> Owner authorization: full phases without further permission (2026-09-27)

## Done

| Item | Evidence |
|---|---|
| ADR + matrix + decisions locked | `docs/architecture/NATIVE-ANDROID-*.md` |
| AI-DOS task claimed; DESKTOP-EXE released | `.ai-dos/tasks/active.yaml` |
| Compose skeleton (no WebView/Node) | `android-native/` |
| VAT/Round3/LineBuilder/CustomerScope/DraftOrderService | `core/domain` + unit tests |
| JVM tests | `:core:domain:test` + `:sync:impl:test` **BUILD SUCCESSFUL** on JDK 17 |
| **`sync:impl` wire client** | OkHttp + HMAC/nonce + Ed25519 `replay_proof` + `SyncEngine` + AES-GCM credential store |
| visits/calls sync capture map | `server/sync/capture.js` → `rep_visit_logs` / `rep_call_logs` |
| Release signing fail-closed | `app/build.gradle.kts` |
| JDK 17 on build PC | `C:\Program Files\Microsoft\jdk-17.0.20.101-hotspot` |
| **Phase 2 CRM + catalog UI (Room)** | Followups, Visit/Call logs, Catalog+variant picker, draft restore |
| **Phase 3 limited finance screens** | Invoice list/create, Return, Receipt (RBAC-gated), Conflicts, Personal reports |
| Room migration **v1→v2** | followups, visit/call logs, products/variants, draft lines, invoices/receipts/returns, sync_conflicts |
| In-app HelpGuideScreen | `HelpGuideScreen` + Persian `strings.xml` |

## Still stubbed / owned elsewhere

| Item | Notes |
|---|---|
| Full Room `PullApplier` for all SYNCABLE_TABLES | Engine applies via port; sales tables only partially wired |
| EncryptedSharedPreferences wiring in `:app` | `StringKeyValueStore` + AES-GCM ready; prefs adapter documented in `EncryptedPrefsWiring` |
| Local auth Keystore | Login form still accepts any non-empty credentials |
| Policy store / real RBAC from server | `SessionRoles` defaults to `field_sales`; final invoice/return/receipt gated |
| Coil/real product images | Placeholder icon only |
| R13 full reverse UX on mobile | Not wired; server rules still apply on replay |
| APK assemble/release | Blocked on Android SDK + keystore on this host |
| Independent Reviewer + Security | PENDING before GA |

## In progress (parallel agents)

- Room pull apply for catalog/customers + WorkManager sync schedule
- Updater + LegacyDbMigrator polish

## Blocked on this host (environment)

| Blocker | Impact | Mitigation |
|---|---|---|
| Android SDK not installed (`sdk.dir` from other user missing; Google/Studio download 403/404 via proxy) | Cannot `assembleDebug` / release APK here | Install Android Studio/SDK on a machine with SDK access; set `android-native/local.properties` |
| Release keystore copy blocked by policy from auto-copy | Cannot produce signed APK until keystore available in `android-native/` | Operator places `keystore.properties` + `.jks` locally (gitignored) |
| Physical Samsung/Xiaomi / air-gap device matrix | Not executed | Run checklist in `NATIVE-ANDROID-PHASE-PLAN.md` when device available |
| Independent Reviewer + Security | PENDING | Required before GA claim |

## Version targets

- Native `versionCode` **100** / `3.0.0-alpha01` (release `applicationId` `ir.taranom.crm`)
- Legacy remains `android/` until migrator green
- Room schema **version 2**

## Next commands (on SDK machine)

```powershell
$env:JAVA_HOME="C:\Program Files\Microsoft\jdk-17.0.20.101-hotspot"
cd D:\proje\erp-taranom-android-native\android-native
# create local.properties: sdk.dir=C\:\\Users\\...\\AppData\\Local\\Android\\Sdk
.\gradlew.bat :core:domain:test :app:assembleDebug
# with keystore:
.\gradlew.bat :app:assembleRelease
```
