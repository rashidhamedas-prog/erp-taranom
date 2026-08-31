# Project Status

- Last verified: 2026-08-31
- **Primary:** `origin/claude/claude-md-docs-2ssrpy` @ `f3318bb` (QA gaps + SW v174)
- **Iran:** overlay v174 ✅ health/ready/root 200; VPS `db.js` kept; surgical `server.js` backup-restore
- **qa:full:** `qa-20260831T103426-14980` PASS 258 FAIL 0 ERROR 0 · NOT_IMPLEMENTED 11
- **Active task:** `QA-ERP-GAPS-NOT-IMPLEMENTED` — coverage closed; product RFQ/3-way/GRNI/SOD/branch/order-reservation remain
- **Closed:** `QA-ERP-FULL-CYCLE-INTEGRATION` — owner-approved merge + overlay
- **erp-taranom1 / UI-STITCH:** untouched
- **Integration tip:** `ai/QA-ERP-FULL-CYCLE-INTEGRATION` /
  `D:/soft/Claud/porje/Run in the project/erp-taranom-qa-erp-integration` @ Primary `6ce3ac1`
- **Sources:** harness `a9a7110` + product `7d60258`
- **qa:full (this tree, no skip-e2e):** `qa-20260826T135416-20172` · exit **0** · PASS **248** · FAIL **0** · ERROR **0** · NOT_IMPLEMENTED **14**
  Admin batch ✓ · All-Roles batch ✓ · Playwright E2E ✓ (channel=chrome)
  recon JE unbalanced **0** · FK **0** · ledger ∪ warehouse **0**
- **Recon fix:** `stock.ledger_vs_warehouse` unions both sources (company/warehouse/product/variant). Regression 12/12.
- **No Iran deploy / Primary merge / push this session.**
- **Integration branch/worktree:** `ai/QA-ERP-FULL-CYCLE-INTEGRATION` /
  `D:/soft/Claud/porje/Run in the project/erp-taranom-qa-erp-integration` @ Primary `6ce3ac1`
- **Sources (kept):** harness `a9a7110` (`ai/QA-ERP-FULL-CYCLE-admin-roles`); product `7d60258` (`ai/QA-ERP-FULL-CYCLE-FIX-HIGHS-product`)
- **Harness:** cheque admin.js tests kept (`50e8269`). Claims transferred from parent.
- **Child product:** `QA-ERP-FULL-CYCLE-FIX-HIGHS` + `QA-ERP-RBAC-MATRIX-ALIGN` completed @ `7d60258`
- **Prior product E2E:** `qa-20260824T214150-19348` exit 1 · PASS 218 · FAIL 18 (matrix vs route; later closed)
- **Authoritative sibling qa:full:** `qa-20260824T224056-6580` · PASS 246 · FAIL 0 · ERROR 0 · NOT_IMPLEMENTED 14 · recon JE 0
- **Prior reviews (product tree):** Bugbot none; Independent APPROVED; Security C0/H0/M0
- **Follow-up:** `QA-ERP-GAPS-NOT-IMPLEMENTED` (classify in Integration; do not fake PASS)
- **erp-taranom1:** stayed on `ai/UI-DOCS-STITCH` (not checked out; UI-STITCH-P0-DISCOVERY untouched)
- **No Iran deploy / Primary merge / push this session.**
- First full run `qa-20260824T151001-15880`: exit **3** · PASS 211 · FAIL 24 · NOT_IMPLEMENTED 14
  Evidence: `docs/qa/FIRST-RUN.md`. **No Iran deploy / merge.**
- Prior: `PROD-STITCH-P5B` completed
- Independent Bugbot: no bugs. Security: APPROVED C0/H0/M0.
- **PROD-STITCH-P5B:** `completed` — dual APPROVED + owner merge/deploy
  Primary `b52a1de`; stamp `.sftp-deploy-stamp-stitch-v172` = `2026-08-20T13:54:13Z hash=b52a1de`
  health/ready/root **200**; SW `erp-taranom-v172`; `db.js` not replaced; `schema.js` overlaid
- **PROD-STITCH-P5:** `completed` — dual APPROVED + owner merge/deploy
  Primary `db708a8`; stamp `.sftp-deploy-stamp-stitch-v171` = `2026-08-20T13:09:58Z hash=db708a8`
  health/ready/root **200**; SW `erp-taranom-v171`; `db.js` not replaced; `schema.js` overlaid
- **STITCH-P8-POS03-ADR007:** `completed` — dual APPROVED + owner merge/deploy
  Primary `9b16876`; stamp `.sftp-deploy-stamp-stitch-v170` = `2026-08-20T12:40:04Z hash=4d9bc83`
  health/ready/root **200**; SW `erp-taranom-v170`; `db.js` not replaced
- **ADR-007:** Accepted (طاقه فقط WH-RAW؛ FG بدون Lot/Serial/Bin)
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

- Isolated QA (temp DB, no production): `set NODE_ENV=test` then `node scripts/qa/run-full-erp-qa.js` (exit 0/1/2/3)
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
