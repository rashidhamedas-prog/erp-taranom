# Handoff Log

Newest entries are added at the top. Never erase another agent's record.

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
