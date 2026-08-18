# Project Status

- Last verified: 2026-08-18
- **UI-STITCH-IMPL:** `active` on `ai/UI-STITCH-IMPL`
  Worktree `D:/soft/Claud/porje/Run in the project/erp-taranom-stitch-impl`
  Wave: OPS-01, TRS-02, ACC-01..06, INV-01. SW v159. **No Iran deploy** until owner approval.
  Dual Independent+Security review still PENDING (high-risk accounting).
- **DEMO-V3-GUIDED-SALES:** `completed` — dual APPROVED + owner merge/deploy
  Primary `bb868c5`; SFTP stamp `.sftp-deploy-stamp-demo-v3` = `2026-08-14T23:46:53Z hash=bb868c5`
  health/demo/seed 200; public `https://erp.poshaktaranom.com/demo.html`
- **Implementation:** welcome + 4 role tours + free sandbox; H1–H3/M1–M6 + tour-stay/pause-resume/BOM
- **Gates so far:** test-demo-v3 62/62 · static OK
- **Branch / worktree:** `feat/DEMO-V3-GUIDED-SALES` /
  `D:/soft/Claud/porje/Run in the project/erp-taranom-demo-v3` @ base `8a1d699`
- **Constraint:** Demo V3 deploy done; do not overwrite dirty VPS files outside demo overlay
- **Dirty user files in erp-taranom1 (untouched):**
  `scripts/_deploy-demo-ui-v156-sftp.py`, `scripts/_deploy-mdi-v152-sftp.py`
- **DEMO-V2-SECURE-SALES:** merged + Iran deployed ✅
  Primary `6f4d24a`; stamp `.sftp-deploy-stamp-demo-v2-v155` = `2026-08-14T09:51:15Z hash=6f4d24a`
  health/ready/root/demo 200; public SW `erp-taranom-v155`; `https://erp.poshaktaranom.com/demo.html`
- **CRM-PRO-ANALYTICS:** merged + Iran deployed ✅
  Primary tip before this merge `d3b6136` / stamp `1287a1a`
  SFTP stamp `.sftp-deploy-stamp-crm-pro-v154` = `2026-08-14T05:33:42Z hash=d3b6136`
  Task `completed`; Reviewer a092902a + Security 16b3d555 APPROVED
- Prior: ACC-CRM-UNIFY merged + Iran deployed (SW v151 lineage; later MDI v153).

## Working quality commands

- `git diff --check`
- `node --check server/server.js`
- `node --check server/public/app.js`
- `node server/scripts/check-ui-encoding.js`
- `node server/scripts/check-audit-waivers.js`
- `node server/scripts/test-crm-pro-analytics.js`
- `node server/scripts/test-crm-pro-rbac.js`
- `node server/scripts/test-crm-pro-ui-smoke.js`
- `node server/scripts/test-crm-pro-performance.js`
- `node server/scripts/test-acc-crm-dashboard.js`
- `node server/scripts/test-acc-crm-reports.js`
- `node server/scripts/test-acc-crm-phase6.js`
- `node server/scripts/test-acc-crm-perpetual.js`
- `node server/scripts/test-acc-crm-party.js`
- `node server/scripts/test-sms.js`
- `node server/scripts/test-sync.js`
- `node server/scripts/_diag-sync-gaps-b16e78.js`
- `npm.cmd --prefix server run test:production`
- `node scripts/prepare-embedded-server.js all`
- `node scripts/compare-embedded-hash.js`
