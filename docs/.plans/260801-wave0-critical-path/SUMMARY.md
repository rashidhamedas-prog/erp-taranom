# Wave 0 Critical Path — ERP ترنم

**Plan ID:** `260801-wave0-critical-path`  
**Roadmap:** `docs/erp-taranom-master-roadmap.md` (§ موج صفر)  
**Skill:** `.cursor/skills/erp-roadmap-wave0/SKILL.md`  
**Executor agent:** `@erp-wave0-executor`  
**Status:** 🟡 In progress — code/test pass completed through P0-Q; operational Wave 0 gates remain blocked

---

## Progress

| When | Phase | Note |
|------|-------|------|
| 2026-08-01 | Setup | Master roadmap copied; Wave 0 skill, agents, and this plan created. Deploy blocked per Wave 0 gate. |
| 2026-08-01 | P0-A (probe) | Isolated BOM was already green (T1-08 not hanging on Node 22). |
| 2026-08-01 | P0-A ✅ | Path-based `detectCircular`; T1-28/T1-29; `run-production-tests.js` timeouts; **`test:production` ×3 GREEN** (10.6 / 8.9 / 8.0 min). `test-sms` 22/22; `test-sync` 33/33. |
| 2026-08-01 | P0-S1 partial | Remote HTTP fallback removed; `assertCentralUrlAllowed`; `test-sync-tls-url.js` 7/7. Token rotation / revoke / nonce still open. |
| 2026-08-01 | P0-B started | Unified embedded prepare/hash pipeline implementation started after `git pull --ff-only` confirmed branch up to date. Production deploy and full APK/EXE builds remain blocked. |
| 2026-08-01 | P0-B ✅ | Shared runtime-only prepare pipeline produced 199 files per target; SHA-256 drift 0; release metadata 7/7; app-info release-id smoke test green. No APK/EXE build and no deploy. |
| 2026-08-01 | P0-S1 ✅ | TLS-only plus expiring/rotatable/revocable device credentials, signed nonce replay guard, and token-redacted TLS errors. TLS 9/9; sync 41/41. |
| 2026-08-01 | P0-S2 partial | Android backup/cleartext/WebView and Electron sandbox/navigation policies hardened; policy 7/7. Signing keys and signed artifact verification remain operational blockers. |
| 2026-08-01 | P0-S3 partial | Production CORS fail-fast, CSP without unsafe-eval, rate limits, auth-epoch logout-all, restore upload filter and Dependabot added. Legacy inline HTML sanitizer migration remains open. |
| 2026-08-01 | P0-C partial | 15-minute WAL-safe encrypted backup, SHA-256, S3 CLI upload path, integrity verification and DR runbook; isolated local drill 6/6. Real off-site restore drill pending. |
| 2026-08-01 | P0-Q1/Q2 partial | Test matrix/waivers and parallel Wave-0 CI gate added. Browser Playwright, signed platform builds and staging/production gates remain blocked. |
| 2026-08-01 | Local gate | Frontend parse 2 scripts; embedded 199/199 drift 0; platform 7/7; TLS 9/9; SMS 22/22; B2B 30/30; DR 6/6; companies/fiscal 18/18; sync 41/41; production 18 suites all green in 484.5s. |
| 2026-08-01 | Dependency gate ❌ | Online `npm audit --omit=dev --audit-level=high` found 7 advisories (4 high). Breaking upgrades are available for adm-zip/nodemailer/sharp; SheetJS `xlsx` has no published fix. No forced upgrade applied. |
| 2026-08-01 | Gate close ✅ (code) | Upgraded adm-zip/nodemailer/sharp; xlsx waiver+excel-safe; BACKUP_OFFSITE_DIR drill; financial/hostile API 20/0; Playwright login; CI updated. Ops signing + prod OFFSITE wiring remain. |
| 2026-08-01 | P0-S2 resumed | Full non-signing closure started: protected local secrets (Android Keystore / Windows DPAPI), encrypted device credential storage, checksum-gated updater paths, permission/navigation hardening, and behavioral negative tests. APK/EXE signing, full builds, and Iran deploy remain explicitly excluded. |
| 2026-08-01 | Signing ops ✅ (self-signed) | APK 2.0.32 + EXE 2.0.9 signed on build PC; artifacts in New folder + `releases/`; handoff `docs/WAVE0-SIGNING-HANDOFF-GPT.md`. Commercial OV/EV + REQUIRE_SIGNED_UPDATES e2e still open. Offsite Iran PM2 env + restore drill also closed. |

---

## Surprises & Discoveries

- Roadmap hang T1-07→T1-08 **not reproducible**; isolated BOM 29/29 after new cycle/diamond tests.
- Suite hang risk was process-level (missing per-script timeout), not infinite explode on T1-08.
- Concurrent `test-sync` + production suite can ECONNREFUSED on :4100 — run serially.
- A chained P0-B verification initially masked `test-sync` ECONNREFUSED with a later zero exit code; the suite was rerun independently and passed 33/33. CI commands must preserve each test exit status.
- Auth-epoch invalidation required the sync harness to re-login after password change and internal replay JWTs to carry the current epoch; after both fixes sync passed 41/41.
- PowerShell blocked `npm.ps1`; the exact production suite passed through `npm.cmd` and this is an environment-only runner issue.
- Mid-path cycles (Root→B→C→B) previously could hit `E_BOM_TOO_DEEP` instead of `E_BOM_CIRCULAR` before path visited-set fix.

---

## Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-08-01 | Block production deploy until Wave 0 gate | Roadmap موج صفر + skill override of auto-deploy |
| 2026-08-01 | Close P0-A after ×3 green + cycle hardening | Meets phase acceptance; continue Wave 0 order |
| 2026-08-01 | Partial P0-S1 ship with URL/TLS only | High-value security win without waiting full S1 checklist |
| 2026-08-01 | Handoff unfinished phases to `docs/WAVE0-GPT-PRO-HANDOFF.md` | User requested ChatGPT Pro continuity pack |

---

## Outcomes

- [x] Wave 0 **code/CI gate** met (2026-08-01) — see `docs/WAVE0-GATE-STATUS.md`
- [ ] Wave 0 **ops gate** (signed artifacts + prod OFFSITE/S3 restore log) — operator
- [ ] Production deploy unblocked *for Wave1* only after ops checklist above
- [x] Retrospective notes → `docs/WAVE0-GATE-STATUS.md`
- [x] P0-A phase gate met (2026-08-01)
- [x] P0-B phase gate met (2026-08-01)
- [x] P0-S1 phase gate met (2026-08-01)
- [~] Operational gate: signed APK/EXE — runbook + `REQUIRE_SIGNED_UPDATES`; keys pending
- [x] Automated off-site restore drill (`BACKUP_OFFSITE_DIR`); prod path wiring pending
- [x] Quality gate: Playwright login + API financial/hostile cross-company suite
- [ ] Web hardening gate: remove legacy inline HTML/`unsafe-inline` (deferred — Chrome break risk)
- [x] Dependency gate: high vulns fixed except time-boxed `xlsx` waiver + `excel-safe`

---

## Phase index

Execute in order. Mark `[x]` when gate passed.

| # | Phase | Plan file | Status |
|---|-------|-----------|--------|
| 1 | P0-A BOM / CI | [P0-A-bom-ci.md](./P0-A-bom-ci.md) | `[x]` |
| 2 | P0-B Source drift | [P0-B-source-drift.md](./P0-B-source-drift.md) | `[x]` |
| 3 | P0-S1 TLS sync | [P0-S1-tls-sync.md](./P0-S1-tls-sync.md) | `[x]` |
| 4 | P0-S2 Android/Electron | [P0-S2-platform-hardening.md](./P0-S2-platform-hardening.md) | `[-]` |
| 5 | P0-S3 Web/API security | [P0-S3-web-api-security.md](./P0-S3-web-api-security.md) | `[-]` |
| 6 | P0-C Backup/restore | [P0-C-backup-restore.md](./P0-C-backup-restore.md) | `[-]` |
| 7 | P0-Q1 Test pyramid | [P0-Q1-test-pyramid.md](./P0-Q1-test-pyramid.md) | `[-]` |
| 8 | P0-Q2 CI/CD | [P0-Q2-ci-cd.md](./P0-Q2-ci-cd.md) | `[-]` |

---

## Wave 0 exit gate (from roadmap)

- [ ] Full test suite green *(production ×3 done; broader suites still open)*
- [ ] Remote sync TLS-only (no HTTP fallback off localhost) *(URL layer done; token/nonce open)*
- [ ] Off-server backup operational
- [ ] Successful restore drill documented

---

## Global verification (after each backend phase)

```powershell
cd server
node scripts/test-sms.js
node scripts/test-sync.js
node scripts/test-sync-tls-url.js
node scripts/_diag-sync-gaps-b16e78.js
```

**Deploy:** ❌ blocked until Wave 0 gate — commit/push only.

**GPT Pro handoff:** `docs/WAVE0-GPT-PRO-HANDOFF.md`
