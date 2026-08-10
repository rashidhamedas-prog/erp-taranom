## 2026-08-10T16:10:00+03:30 — PROD-P5-R2 implementation checkpoint (pre-review)

- **Task:** still `active` — NOT completed; **NO Iran deploy**
- **Branch/worktree:** `fix/PROD-P5-R2-review-remediation` /
  `D:/soft/Claud/porje/Run in the project/erp-taranom-prod-p5-r2` @ base `a152086`
- **High-1:** `ERP_TEST_ISOLATION` + unique `COMPANIES_DIR` in `freshDb`; T2-05/07/08 PASS; health 5201/5202/5203 zero; pack×20/×25 regression PASS
- **High-2:** `sensitivity` uses in-memory `priceOverrides` via `getPrice`/`explodeBom`/`rollUpBom`; tests sens-a..d PASS; no `UPDATE products`
- **High-3:** `prepare-embedded-server all` + `compare-embedded-hash` → desktop/android **diff=0** (251 files)
- **Medium-1:** ops/outputs CRUD + auto-share UI + E_* map + Help path; smoke **29/29**
- **Medium-2:** canonical `https://erp.poshaktaranom.com`; probe/smoke scripts + `docs/08-deployment.md`
- **Next:** full P0–P5 gate suite on one commit → Independent Reviewer + Security (no deploy)

## 2026-08-10T15:40:00+03:30 — PROD-P5-R2 claimed (corrective reopen)

- **Task:** `PROD-P5-R2` status=`active`; owner `cursor:implementer`
- **Reviewer / Security:** independent identities `cursor:independent-reviewer` / `cursor:independent-security` (not Implementer)
- **Branch / worktree:** `fix/PROD-P5-R2-review-remediation` /
  `D:/soft/Claud/porje/Run in the project/erp-taranom-prod-p5-r2`
- **Base:** `origin/claude/claude-md-docs-2ssrpy@a152086` (clean worktree; NOT erp-taranom1)
- **PROD-P5:** status=`superseded` (invalid completion); claims empty
- **Constraint:** NO `completed` and NO Iran deploy until High/Medium closed + full P0–P5 gates + Independent Reviewer Approved + Security Approved
- **Scope High:** P2 fixed T2-05/07/08 + health 5201/5203; sensitivity read-only; embedded prepare/hash diff=0
- **Scope Medium:** BOM editor CRUD+template+resequence+Help; deploy evidence/domain/hashes/role smoke
- **Exact next:** parallel diagnose High-1/High-2; then implement on claimed files only

## 2026-08-10T14:40:00+03:30 — Applied to program (merge + Iran SFTP)

- Merge primary: `889b61b` pushed to `origin/claude/claude-md-docs-2ssrpy`
- Feature tip: `5fb2276` (getBom) / remedia `6271a3f` / docs `5ae889c` / handoff `d571af9`
- Iran SFTP: stamp `.sftp-deploy-stamp-prod-p5-rereview`; smoke `root=200 health=200 ready=200`; getBom/tree/compare wraps verified on VPS
- Independent Reviewer: Approved with comments; Security: Approved (no open High/Medium)
- PROD-P5: completed; claims released
# Handoff Log

Newest entries are added at the top. Never erase another agent's record.

## 2026-08-10T14:20:00+03:30 — Independent + Security re-review Approved → apply

- Tip code: `5fb2276` (+ docs stamp `5ae889c`)
- Independent Reviewer: **Approved with comments** (getBom Medium closed; 38/38)
- Security: **Approved** for R11/operator cost-leak scope (no open High/Medium on production-boms.js)
- Next: merge to `claude/claude-md-docs-2ssrpy` + precise Iran apply; then mark PROD-P5 completed / release claims

## 2026-08-10T13:55:00+03:30 — close Independent Reviewer Medium (getBom R11)

- Independent Reviewer on `6271a3f`: **Changes requested** — Medium bypass via `GET /:id` / `/tree` / `/compare`
- Security on `6271a3f`: **Approved with comments** (same residual GET /:id)
- Fix applied (pending commit): wrap `applyCostPolicy` on GET `/:id`, `/:id/tree`, `/compare` + regression getBom-shape
- Raw: advanced **38/38 PASS**
- Task remains **active** until re-review Approved; **no Iran deploy yet**

## 2026-08-10T13:35:00+03:30 — PROD-P5 remediation evidence (pre re-review)

- **Task:** still `active` — NOT completed; **NO Iran deploy**
- **Branch/worktree:** `ai/PROD-P5-advanced-bom` / `D:/soft/Claud/porje/Run in the project/erp-taranom-prod-p5`
- **Remedia commit:** `6271a3f` (pushed to `origin/ai/PROD-P5-advanced-bom`)
- **Base tip before remedia commit:** `45961c4`
- **Diffstat (staged for remedia):**
  ```
  .ai-dos/project/status.md                      |  30 +++----
  .ai-dos/tasks/active.yaml                      | 112 +++++++++++++------------
  .ai-dos/tasks/handoff.md                       |  18 ++++
  docs/CHANGE-LOG.md                             |  19 +++--
  server/routes/production-boms.js               |  14 ++--
  server/scripts/test-production-bom-advanced.js |  47 +++++++++--
  6 files changed, 150 insertions(+), 90 deletions(-)
  ```
- **10 items status:**
  1. CHANGE-LOG full tip — DONE (this remedia entry)
  2–5. GET std-cost/ops/outputs/explode/routing `applyCostPolicy` — VERIFIED (tip `ac078a7`)
  6–7. resequence `assertDraftBom` + test `E_BOM_LOCKED` — VERIFIED
  8. `applyCostPolicy` + `production_operator` + POST/PUT row shapes — DONE (37/37)
  9. diag `mismatches=[]` — PASS
  10. full gates PASS; independent re-review PENDING
- **Extra Medium closed:** POST/PUT ops/outputs + resequence responses wrapped with `applyCostPolicy`
- **Raw gates:**
  - advanced: `P4 Advanced BOM: ✅ 37 پاس`
  - overhead: `P4 Overhead + Labor: ✅ 38 پاس`
  - variable: `P3 Variable: ✅ 27 پاس`
  - sms: `🎉 22 passed, 0 failed`
  - sync: `🎉 44 passed, 0 failed` (retry without `SYNC_ROLE=device`)
  - diag: `{"mismatches":[],"registryMissing":[],"hasOldDebug":false,"count":147}`
  - audit waivers: `Dependency gate OK`
- **Next:** commit+push remedia → Independent Reviewer + Security re-review → only if Approved: merge/apply to program (still no premature completed)

## 2026-08-10T12:55:00+03:30 — PROD-P5 REACTIVATED for Independent Review remediation

- **Task:** `PROD-P5` status=`active` again; file_claims restored; owner `cursor:orchestrator`
- **Constraint:** NO `completed` and NO Iran deploy until High/Medium closed + full tests + independent re-review
- **10 corrective items listed in active.yaml `corrective_items`**

## 2026-08-10T11:45:00+03:30 — PROD-P5 security remediation (post-review)

- **Security:** [Security Review](be434b0a-32ae-4e19-8f58-dbb653ddc5d1) → **Approved with comments**; remediated medium findings in `ac078a7`
- **Fixes:** `applyCostPolicy` on GET operations/routing/outputs/explode/std-cost; `assertDraftBom` in `resequenceOperations`; regression tests (suite **34/34**)
- **Next:** push `ac078a7` → primary merge → Iran SFTP overlay of 3 server files + CHANGE-LOG

## 2026-08-10T11:20:00+03:30 — PROD-P5 complete: merge + Iran SFTP

- **Task:** `PROD-P5` / `cursor:orchestrator` → **completed**; `file_claims` released
- **Merge:** `4306168` on `claude/claude-md-docs-2ssrpy` (from `ai/PROD-P5-advanced-bom` tip `9878f11`)
- **Agents:** sync PATH ([Sync](350cf600-4c0a-49da-bc45-d3117f44fe92)); API routes ([API](7d05729c-6331-424b-99b1-2dae2df10cc6)); UI ([UI](2804c4ab-2d16-41b7-9fad-d2e3ac89c75e)); tests orchestrated locally after seed UNIQUE fix; reviews ([Reviewer](1178c628-2f0f-4eaf-8307-46194d7e42ad), [Security](560d0fca-e2bd-438b-956f-89a645453f95))
- **Tests:** advanced **32/32**; overhead 38/38; variable 27/27; sms 22/22; sync **44/44** (retry); `_diag-sync-gaps` mismatches=[]
- **Deploy:** SFTP overlay to `taranom@94.249.244.208` (no blind pull); stamp `.sftp-deploy-stamp-prod-p5`; HTTP `/=200` `/health=200` `/ready=200`; pm2 online; no `--update-env`
- **Delivered:** bom-advanced helpers, ops/outputs PATH map + FK appends, routes+R11, BOM 4 tabs + Help, CHANGE-LOG
- **Next:** P6 advanced fixed execution only when owner selects; leave `ai/W1-*` alone

## 2026-08-09T17:05:00+03:30 — PROD-P5 preflight claimed (no app code yet)

- **Task / owner:** `PROD-P5` / `cursor:orchestrator` (roles: architect/implementer/reviewer/security recorded in `active.yaml`)
- **Branch / worktree:** `ai/PROD-P5-advanced-bom` @ `D:/soft/Claud/porje/Run in the project/erp-taranom-prod-p5`
- **Base:** created from `origin/claude/claude-md-docs-2ssrpy` @ `55b287d` (clean; tracks primary)
- **Claim conflicts:** none — prior PROD-P3/P4/W2-ORCH completed with empty `file_claims`
- **Primary `erp-taranom1`:** untracked noise + historically behind origin — **do not implement there**
- **Avoid:** all `ai/W1-*` worktrees/branches; Wave 2 exit ops (pilots/SLA)

### Scope
- **In:** Module 4 gap-close — routing/`bom_operations`, co/by `bom_outputs`, roll-up golden math, missing helpers (`costTree`, `yieldAnalysis`, `sensitivity`, `breakeven`, `compareScenarios`, `autoShare`) + routes, full BOM editor UI tabs deferred from P4, §18 tests, Help + CHANGE-LOG
- **Out:** P6/P6b execution posting, P7–P10 packs, ledger JE from Module 4, full APK/EXE builds, rewrite of P4 overhead/labor engines

### Acceptance (numeric)
- §6.6 stages + §6.8 breakdown reproduced
- `full-cost?qty=300` matches §15
- cost-tree ≤5s on 5-level tree
- zero JE from Module 4
- T4-05 `95.5647`, T4-06 `314`, T4-13 `698324500±1`, T4-15 `2315880`, T4-21 circular, T4-29 V4-21
- Expand `test-production-bom-advanced.js` toward §18 (28); keep P3/P4 suites green

### Risks
1. Golden roll-up drift vs §6 (poisons P6+) — high
2. V4-21 double-count yield if header≠100 with routing — high
3. Shared `db.js` / `app.js` / `server.js` collisions with W1 merges — medium
4. Sync hygiene if new mutating paths — medium
5. UI-only “done” without golden tests — process risk

### Implementation plan (ordered)
1. **Baseline in worktree:** run existing `test-production-bom-advanced.js` + P3/P4 suites; inventory FAIL/missing T4 ids
2. **Service gap-close:** implement missing exports in `bom-advanced.js`; harden `validateAdvancedBom` V4-01..V4-21
3. **API:** add/complete routes for cost-tree / sensitivity / breakeven / compare / autoShare / CRUD gaps; sync `PATH_TABLE_MAP` only if new prefixes
4. **UI:** BOM tabs [اقلام|مسیر عملیات|خروجی‌ها|بهای تمام‌شده], template button, cost card; Help update
5. **Tests + gates:** full advanced suite; `test-sms` + `test-sync`; `git diff --check`; `node --check server/server.js`; `check-audit-waivers`; frontend parse
6. **Independent reviewer + security** (high risk) before merge/deploy
7. Merge to primary + Iran deploy per project rules (no blind VPS reset; no `--update-env` unless secrets confirmed)

### Validation commands (from worktree)
```powershell
cd "D:/soft/Claud/porje/Run in the project/erp-taranom-prod-p5"
git diff --check
node --check server/server.js
node server/scripts/check-audit-waivers.js
node server/scripts/test-production-bom-advanced.js
node server/scripts/test-production-overhead-labor.js
node server/scripts/test-production-variable.js
node server/scripts/test-sms.js
node server/scripts/test-sync.js
# frontend script parse (index.html or app.js per surface touched)
```

### Rollback
- Branch abandon / revert commit on `ai/PROD-P5-advanced-bom` before merge
- After merge: revert merge commit; do not blind-reset dirty Iran VPS — targeted SFTP/ff only
- Schema: `ensureColumn` is additive; no physical delete of financial docs

### Exact next action
Implementer enters worktree, re-reads AI-DOS load order + claim, runs baseline tests, then starts phase 2 — **still no edits in primary `erp-taranom1`.**

### Architect disposition ([Architect](da8fcbf0-ccc4-42d9-8828-bcef44a316f8))
- Engine ~55–65% present; P5 = gap-close + UI + §18 completeness (not rewrite).
- **Blocker-class sync:** `PATH_TABLE_MAP` maps only `/api/production/boms` → `bom_headers`; mutating `/operations` & `/outputs` capture wrong table — longer prefixes must sit **above** generic boms.
- FK append candidates: `bom_operations.subcontract_supplier_id`, `bom_outputs.stage_cost_center_id`.
- T4-13 harness tolerance ±50 violates AC ±1; some T4 IDs mislabeled vs §18.
- R11: `full-cost` should apply cost-strip policy defense-in-depth.
- Prefer thin helpers + 4 tabs in existing BOM UI in `app.js`; no new framework.

Parallel preflight agents: claim-audit, roadmap-priority, gates-plan, architect — complete.

## 2026-08-09T14:05:00+03:30 — PROD-P4 merge to primary + Iran deploy

- Merging `origin/ai/PROD-P4-overhead-labor` into primary (`claude/claude-md-docs-2ssrpy`).
- Code clean-merged: `overhead.js`, `labor.js`, `production-cost-centers.js`, `test-production-overhead-labor.js` (38/38).
- SSH production: `taranom@94.249.244.208` key `~/.ssh/id_ed25519_taranom` — ff-pull only, no dirty reset.
- Docs conflicts resolved (CHANGE-LOG / AI-DOS status/active/handoff).

## 2026-08-09T05:35:00+03:30 — PROD-P4 integration complete

- Evidence: `test-production-overhead-labor.js` → **38/38 PASS** on `ai/PROD-P4-overhead-labor` (`d0465ac`).
- Deliverables: overhead bootstrap (toman×10), four labor methods, cost-center rates PUT/bootstrap API.

## 2026-08-09T13:50:00+03:30 — PROD-P3 finalize complete

- Merged primary into `ai/PROD-P3-variable-analysis` @ `fefedda`; FF-pushed to `claude/claude-md-docs-2ssrpy`.
- Tests: `test-production-variable.js` 27/27 PASS; SW v144.
- Deploy Iran: targeted SFTP (`scripts/_deploy-prod-p3-sftp.py`) — health 200, ready 200, VARIANCE=YES; pm2 restart without `--update-env`.
- Claims released; task completed.

## 2026-08-09T13:20:00+03:30 — PROD-P3 finalize (merge primary + deploy)

- Merged `origin/claude/claude-md-docs-2ssrpy` into `ai/PROD-P3-variable-analysis`.
- Tests: `test-production-variable.js` 27/27 PASS; SW v144.
- Deploy: targeted SFTP (no blind VPS pull).

## 2026-08-09T05:35:00+03:30 — W2-ORCH: six MVP slices merged

- Task / owner: `W2-ORCH` / `cursor:implementer`
- Branch tip: `d411f0e` on `ai/W2-ORCH-wave2` (worktree `erp-taranom-w2-orch`)
- Merged slices:
  - O1 observability `07bf7e3`
  - M3 onboarding `29d4f67`
  - M1 license `22dce30`
  - F5 bank recon `55415a6`
  - B2B credit `317dd6d` (db.js conflict resolved: both `initLicenseSchema` + `initB2bSchema`)
  - HR export `5486ca8`
- Agent evidence tests (pre-merge, per slice): license 24/24, onboarding 29/29, b2b-credit 19/19 + b2b 34/34, bank-recon 24/24, payroll-export+accounting green, observability 9/9, sms 22/22
- Orch re-validation (NODE_PATH / local node_modules): license 24/24, onboarding 29/29, b2b-credit 19/19 (harness wait+SYNC_ROLE fixed), bank-recon 24/24, payroll-export green, observability 9/9, sms 22/22
- Deploy: ✅ Iran production at `b4b653b` (2026-08-09); health/ready/root 200; tracked dirty stashed as `w2-pre-deploy-tracked`
- Residual gaps: full Wave-2 exit gate (paid pilots, support SLA); HR CSV draft; B2B consume-on-invoice; bank 1:N matching; license max_users/feature UI; onboarding wizard UI
- Do not claim Wave 2 complete. P1 remains other agents' `ai/W1-*`.
- Primary branch `origin/claude/claude-md-docs-2ssrpy` FF'd to `b4b653b`.

## 2026-08-09T04:55:00+03:30 — W2-ORCH claimed; P1 work by this owner abandoned

- Owner clarified: this Cursor session owns **Wave 2 / P2**, not Wave 1.
- Abandoned/cleaned local `ai/W1-001-moadian-ops` worktree (never pushed). Did **not** touch other agents' `ai/W1-*` worktrees.
- Active task: `W2-ORCH` on `ai/W2-ORCH-wave2` at `D:/soft/Claud/porje/Run in the project/erp-taranom-w2-orch`.
- Next: parallel MVP implementers for license, onboarding, B2B, treasury/cheques, HR legal export, observability/support; orch merges.

## 2026-08-09T05:00:00+03:30 — W0-OPS-002 completed under permanent owner waiver

- Owner accepted permanent production waiver `W0-OPS-002-SHARP-RUNTIME-0335` with **no expiry**: VPS runtime may remain `sharp@0.33.5`; source/CI stay `0.35.0`.
- Task status: **completed**; `file_claims` released; `.ai-dos/tasks/active.yaml` cleared.
- Wave 0 exit: closed. **Ready for Wave 1 / P1** when owner selects scope.
- Residual (not blockers): optional CPU upgrade later; S4U; OV/EV; cold backup; restricted publisher; fix `auto-commit-deploy.mdc` conflict before autonomous Iran deploys.
- Do not claim production is on `0.35.0`. Do not blind pull/reset dirty VPS or `erp-taranom1`.

## 2026-08-09T04:55:00+03:30 — Independent reviewer disposition

- [Reviewer](bbb4b9b8-47d4-40b4-a61f-459265612f72): **Approved with comments**. Declaring `blocked` (not complete) is correct; AC for production `0.35.0` unmet.
- Comments addressed in claimed script: backup/restore/rollback now include `detect-libc` + `semver` and clean `*.__old` leftovers.
- Raw blocker transcript (from VPS probe, preserved):
  ```
  Model name: QEMU Virtual CPU version 2.5+
  cx16=yes lahf_lm=yes popcnt=NO sse4_1=NO sse4_2=NO ssse3=NO
  Error: Unsupported CPU: Prebuilt binaries for Linux x64 require v2 microarchitecture
  Post-restore: PKG=0.33.5 RT=0.33.5 REQUIRE_OK root=200 health=200
  ```
- Next step confirmed sound: hypervisor `x86-64-v2`/`host` → reboot → flag check → `-Deploy` → pull/drill → attach raw logs before complete claim.

## 2026-08-09T04:50:00+03:30 — Security review disposition + deploy-script hardening

- Independent [security review](5816c075-fa15-4eee-9dc3-639b922c018e): **blocked disposition Approved / completion Not approved**.
- Residual advisory on production `sharp@0.33.5` accepted until CPU upgrade or explicit time-boxed owner waiver.
- High finding (out of this task's file_claims): `.cursor/rules/auto-commit-deploy.mdc` still mandates blind `git pull` + `pm2 restart --update-env` and can bypass the reviewed sharp path — needs separate ownership change before any autonomous Iran deploy.
- Medium findings remediated in claimed `scripts/deploy-sharp-production.ps1`:
  1. SSH `RejectPolicy` + required pinned `known_hosts`
  2. Remote SHA-256 sidecar verify before extract
  3. Auto-rollback from recover stamp if post-PM2 smoke fails
- Task remains `blocked` on CPU; do not claim `0.35.0` deployed.

## 2026-08-09T04:10:00+03:30 — W0-OPS-002 blocked on VPS CPU microarchitecture

- Task / owner / role: `W0-OPS-002` / `cursor:implementer` / Implementer (status=`blocked`).
- Branch / worktree: `ai/W0-OPS-002-sharp-production-deploy` / `D:/soft/Claud/porje/Run in the project/erp-taranom-w0-ops-002`.
- What was done:
  - Created dedicated worktree from `origin/claude/claude-md-docs-2ssrpy`.
  - Added `scripts/deploy-sharp-production.ps1` (inventory / offline Linux bundle / bounded swap / rollback / CPU preflight).
  - Built offline bundle `sharp-0.35.0-linux-x64.tgz` (SHA-256 `8BF9B7FDE5D2933E4B7B1AAB5D0268BE2A3D3B83F83CBE076BF5962F04634ABD`).
  - Attempted production apply twice without `git pull`/`reset`; both failed before PM2 restart; automatic restore kept live modules.
- Production evidence after attempts: `PKG=0.33.5`, `RT=0.33.5`, `REQUIRE_OK`, HTTP `root=200`/`health=200`, PM2 `online`, restarts still `8` (no restart during failed applies).
- Dirty VPS inventory preserved (no blind clean): HEAD `6390bcc`; modified docs/app/sw/releases; untracked `.sftp-deploy-stamp`, `server/_recover/`, `server/backup-encryption-key.txt`, broken APK.
- Blocker: CPU `QEMU Virtual CPU version 2.5+` missing `popcnt sse4_1 sse4_2 ssse3`. Error: `Unsupported CPU: Prebuilt binaries for Linux x64 require v2 microarchitecture`. Wasm needs SSE4.1 → also unavailable.
- Recover stamps retained on VPS: `sharp-20260808T160047Z`, `sharp-20260809T003020Z`, `sharp-20260809T003451Z`, plus uploaded bundle under `server/_recover/bundles/`.
- Exact next action for owner/infra: change hypervisor CPU type to `x86-64-v2` or `host` (expose SSE4.2), reboot guest, then from this worktree run `powershell -File scripts/deploy-sharp-production.ps1 -Deploy`. After success: backup pull + restore drill + independent reviewer/security approval.
- Do not declare W0-OPS-002 complete; do not start Waves 1–4.

## 2026-08-09 — Ownership transferred to Cursor as W0-OPS-002

- `W0-OPS-001` is completed and its claims are released from the active registry; history remains below and in Git.
- New active owner/implementer: `cursor:implementer`; independent role identities: `cursor:reviewer` and `cursor:security`.
- Required branch/worktree: `ai/W0-OPS-002-sharp-production-deploy` at `D:/soft/Claud/porje/Run in the project/erp-taranom-w0-ops-002`.
- Cursor must create the worktree from `origin/claude/claude-md-docs-2ssrpy`, enter it, reread the AI-DOS load order, verify its claim, and only then edit claimed files.
- Exact first setup commands (no destructive action):
  1. `git fetch origin claude/claude-md-docs-2ssrpy`
  2. `git worktree add "D:/soft/Claud/porje/Run in the project/erp-taranom-w0-ops-002" -b ai/W0-OPS-002-sharp-production-deploy origin/claude/claude-md-docs-2ssrpy`
  3. Change directory to that worktree and run the AI-DOS preflight.
- Do not work in dirty `erp-taranom1`; do not blindly pull/reset the dirty VPS. Follow the production rollback evidence in the next handoff entry.

## 2026-08-08T16:12:00Z — Cursor continuation handoff (do not redo completed work)

### Completed and verified

- Source/CI commit `7460857`: GitHub Wave 0 Gate run `31265434377` is 7/7 green. Final documentation commit: `9ae1ba1` (`[skip ci]`). Both are pushed to `claude/claude-md-docs-2ssrpy` and `ai/W0-OPS-001-wave0-ops-close`.
- P0-C is operational: 15-minute Windows pull and weekly restore drill Scheduled Tasks both returned result `0`; latest real drill fingerprints match and RTO estimate is 3s.
- Backup wrapper source is tracked and production hash matches: `d28baf01768fdf21c51bc1a606c89b68b0b563eec8540f444d7f390e22e2afe6`, owner/mode `root:root 0755`; confinement negative tests and contract 26/26 pass.
- APK 2.0.33 / EXE 2.0.10 are published; stage/hash/atomic promote/rollback/HTTP re-hash passed.
- Reviewer: Approved. Security: Approved with documented waivers.

### Production sharp attempt — rolled back safely

- Source/lock use `sharp@0.35.0`; audit has zero unwaived high/critical and image tests pass.
- A targeted VPS `npm install sharp@0.35.0` hung on registry/DNS. It was stopped; no PM2 restart occurred.
- Production was restored from `server/_recover/sharp-20260808T160047Z` and npm cache: `SHARP_ROLLBACK_OK=0.33.5`, PM2 PID `320901`, HTTP root `200`.
- Therefore production runtime is healthy but still on `sharp@0.33.5`; do not claim the production advisory is deployed.

### Cursor next actions, in order

1. **Deploy sharp 0.35.0 without risking production:** wait for stable registry or prepare a verified Linux x64 offline npm cache/tarball bundle; back up package files; install with bounded timeout; require `require('sharp')` + exact version before restart; restart without `--update-env`; HTTP/image smoke; retain rollback. Never leave `node_modules/sharp` missing.
2. **Do not `git pull` blindly on VPS.** `/home/taranom/crm-taranom` is at `6390bcc` and dirty: modified docs, `server/public/app.js`, releases metadata, `sw.js`; untracked deploy stamp, recover directory, encryption key and broken APK. Reconcile/preserve each operational change first, then use a reviewed deploy plan.
3. **Do not fast-forward the user's original local worktree blindly.** `D:/soft/Claud/porje/crm-taranom/erp-taranom1` has user-owned `server/routes/accounting.js` changes and many untracked AI-DOS/docs files. Continue from clean worktree `D:/soft/Claud/porje/Run in the project/erp-taranom-w0-ops` or merge with explicit preservation.
4. Optional hardening: elevated S4U Scheduled Tasks (current Interactive mode does not run logged out), restricted release-publisher replacing broad admin key, immutable/cold offsite generation, commercial Windows OV/EV certificate.
5. Do not start Waves 1–4 until the owner selects priority.

### Required validation after Cursor production dependency deployment

- `node -e "require('sharp'); console.log(require('sharp/package.json').version)"` → `0.35.0`.
- `pm2 describe erp-taranom` online; restart must preserve backup/data encryption env.
- HTTP root/health and one image upload/thumbnail smoke pass.
- New encrypted backup + Windows pull + isolated drill still pass.
- Update `docs/WAVE0-GATE-STATUS.md`, `docs/CHANGE-LOG.md`, this handoff and task files with exact commit/hash/results; commit and push the same branch.

## 2026-08-08T15:43:00Z — W0-OPS-001 complete

- Completion: acceptance criteria met; Reviewer approved; Security approved with documented waivers; no remaining release blocker.
- Final production evidence: wrapper tracked and deployed `root:root 0755` with matching SHA-256 `d28baf01768fdf21c51bc1a606c89b68b0b563eec8540f444d7f390e22e2afe6`; contract 26/26; actual newest pull/drill `crm-backup-20260808-153000.zip.enc`, SHA-256 `2166FB8E9C0F75719F7B87DFA4A01D4F72DA442C4D0553DB53F92986C5A1B866`, fingerprints match, RTO estimate 3s.
- Waivers: broad release-admin key exception was one-RC-only and expired after successful publish; self-signed Windows certificate; Interactive scheduler when logged out; Windows copy is off-server but not immutable/air-gapped.
- Remaining follow-up (not a W0-OPS-001 blocker): restricted release-publisher architecture, elevated S4U installation, remote CI/staging automation evidence, optional OV/EV and immutable cold copy.
- CI follow-up: first remote run exposed new `sharp <0.35.0` advisory; upgraded to `sharp@0.35.0`. Local dependency gate has zero unwaived high/critical; upload security 55/55 and sync-file 19/19 PASS.
- Final CI: GitHub Wave 0 Gate run `31265434377` on `7460857` completed successfully with 7/7 jobs. Weekly restore Scheduled Task was also registered and manually executed with result `0` (next Sunday 03:00).

## 2026-08-08T15:36:00Z — W0-OPS-001 implementation checkpoint

- Task / owner / role: `W0-OPS-001` / `codex:root` / Orchestrator, Architect, Implementer.
- Branch / worktree: `ai/W0-OPS-001-wave0-ops-close` / `D:/soft/Claud/porje/Run in the project/erp-taranom-w0-ops`.
- Production evidence: encrypted `crm-backup-20260808-153000.zip.enc` copied to Windows; size `12268025`; SHA-256 `2166FB8E9C0F75719F7B87DFA4A01D4F72DA442C4D0553DB53F92986C5A1B866`; isolated restore `ok=true`, fingerprints match, RTO estimate 3s.
- Access confinement: backup identity defaults to `id_ed25519_taranom_backup` and is forced through tracked/root-owned `/usr/local/sbin/erp-taranom-backup-reader` (`root:root 0755`, local/production SHA-256 `d28baf01768fdf21c51bc1a606c89b68b0b563eec8540f444d7f390e22e2afe6`). Backup list/download passed; secret key, DB, `.env`, private uploads, SFTP, upload, delete and shell were denied.
- Scheduler evidence: `ERP-Taranom-Offsite-Pull`, Limited/Interactive fallback, 15 minutes, actual `LastTaskResult=0`. Logged-out RPO requires a later elevated S4U install.
- Release evidence: APK 2.0.33, EXE 2.0.10, blockmap, `latest.yml`, and `manifest.json` fully staged, SHA-256/SHA-512 verified, atomically promoted with rollback support, and HTTP re-hashed.
- Tests observed: artifact real PASS; offsite contract 25/25; policy 4/4; DR 14/14; uploader 3/3; embedded desktop/android 224 each with diff=0; `git diff --check` PASS.
- Review/security disposition: path-confinement, unsafe default identity and accidental key replacement findings fixed. Residual waiver: existing release admin key is broad and was used manually for this one RC with pinned host/hashes; permanent restricted publisher remains hardening work.
- Exact next action: final diff audit, remove generated cache, independent re-review delta, commit and push; then collect remote CI evidence.

## 2026-08-08T14:42:49Z — W0-OPS-001 claimed

- Task / owner / role: `W0-OPS-001` / `codex:root` / Orchestrator, Architect, Implementer
- Branch / worktree / commit: `ai/W0-OPS-001-wave0-ops-close` / `D:/soft/Claud/porje/Run in the project/erp-taranom-w0-ops` / base `a45b97c`
- Objective and acceptance criteria: close real off-server backup by pulling encrypted backups to the user's Windows PC; safely publish RC binaries; validate and document Wave 0 evidence.
- Verified context and decisions: no active claims existed; user approved the task branch/worktree and two independent review agents; Windows PC is the offsite destination; commercial Windows certificate is not required for this task.
- Files changed (and why): task registry and this checkpoint only, to establish ownership before implementation.
- Tests/gates run with exact results: none yet; preflight was read-only.
- Review/security findings and dispositions: pending independent review.
- Known failures, risks, and assumptions: production/SSH operations are high-risk; no destructive restore is authorized; existing source worktree contains unrelated user files and is not used for implementation.
- File claims released or retained: all claims in `active.yaml` retained.
- Exact next action: inspect existing deployment/backup interfaces inside the isolated worktree, then implement the smallest secure Windows pull workflow.

