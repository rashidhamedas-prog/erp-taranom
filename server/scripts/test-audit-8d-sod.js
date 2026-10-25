'use strict';
/**
 * Audit wave 8D — Segregation of Duties / maker-checker.
 *
 * Run:
 *   DB_PATH=server/.tmp-test-artifacts/wave-test-8d.db npm --prefix server run test:audit-8d
 *
 * Guard: refuses empty DB_PATH or basename matching crm*.db.
 */
const path = require('path');
const fs = require('fs');
const {
  assertMakerChecker, requireDifferentApprover,
} = require('../lib/rbac');
const { swAtLeast } = require('./lib/sw-at-least');

(function guardDbPath() {
  const raw = process.env.DB_PATH || '';
  if (!raw) {
    console.error('FATAL: DB_PATH is required under .tmp-test-artifacts. Example:');
    console.error('  DB_PATH=server/.tmp-test-artifacts/wave-test-8d.db npm --prefix server run test:audit-8d');
    process.exit(1);
  }
  const base = path.basename(raw);
  if (/^crm.*\.db$/i.test(base)) {
    console.error('FATAL: DB_PATH looks like a production crm*.db:', base);
    process.exit(1);
  }
})();

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass += 1; console.log('  ✅', name); }
  else { fail += 1; console.log('  ❌', name, extra == null ? '' : extra); }
}

function expectSod(fn, label) {
  let blocked = false;
  let code = null;
  let status = null;
  try {
    fn();
  } catch (e) {
    blocked = e.code === 'E_SOD_MAKER_CHECKER';
    code = e.code;
    status = e.status;
  }
  ok(label, blocked && status === 403, { code, status });
}

function expectOk(fn, label) {
  let threw = false;
  try { fn(); } catch (_) { threw = true; }
  ok(label, !threw);
}

console.log('\n══ Audit 8D — SoD / maker-checker ══\n');
console.log('DB_PATH=', process.env.DB_PATH);

const admin = { id: 1, role: 'admin' };
const acct = { id: 2, role: 'accounting' };
const sales = { id: 3, role: 'field_sales' };

expectSod(() => assertMakerChecker(admin, 1), 'admin cannot self-approve (assertMakerChecker)');
expectSod(() => assertMakerChecker(acct, 2), 'accounting cannot self-approve');
expectSod(() => requireDifferentApprover(3, sales), 'requireDifferentApprover alias blocks self');
expectOk(() => assertMakerChecker(admin, 2), 'admin may approve others’ docs');
expectOk(() => assertMakerChecker(acct, 1), 'accounting may approve admin’s docs');
expectOk(() => assertMakerChecker(admin, null), 'null created_by skipped (legacy)');
expectOk(() => assertMakerChecker(admin, ''), 'empty created_by skipped');

let noUser = false;
try { assertMakerChecker(null, 1); } catch (e) {
  noUser = e.code === 'E_SOD_MAKER_CHECKER' && e.status === 403;
}
ok('missing user → SOD error', noUser);

const root = path.join(__dirname, '..');
const rbacSrc = fs.readFileSync(path.join(root, 'lib/rbac.js'), 'utf8');
ok('rbac exports requireDifferentApprover', /requireDifferentApprover/.test(rbacSrc));
ok('rbac no admin bypass in assertMakerChecker',
  !/if\s*\(\s*user\.role\s*===\s*['"]admin['"]\s*\)\s*return\s*;/.test(
    rbacSrc.slice(rbacSrc.indexOf('function assertMakerChecker'), rbacSrc.indexOf('function requireDifferentApprover') + 80)
  ));

const accSrc = fs.readFileSync(path.join(root, 'routes/accounting.js'), 'utf8');
ok('invoice approve wires assertMakerChecker',
  /invoices\/:id\/approve[\s\S]{0,800}assertMakerChecker\(req\.user,\s*inv\.user_id\)/.test(accSrc));
ok('voucher draft post wires assertMakerChecker',
  /vouchers\/drafts\/:id\/post[\s\S]{0,600}assertMakerChecker\(req\.user,\s*draft\.created_by\)/.test(accSrc));

const repSrc = fs.readFileSync(path.join(root, 'routes/rep-management.js'), 'utf8');
ok('rep payment approve SoD',
  /payments\/:id\/approve[\s\S]{0,900}assertMakerChecker/.test(repSrc));
ok('rep expense approve SoD',
  /expenses\/:expenseId\/approve[\s\S]{0,600}assertMakerChecker/.test(repSrc));

const bomSrc = fs.readFileSync(path.join(root, 'routes/production-boms.js'), 'utf8');
ok('BOM activate SoD',
  /:id\/activate[\s\S]{0,800}assertMakerChecker/.test(bomSrc));

const vapSrc = fs.readFileSync(path.join(root, 'lib/inventory/value-approval.js'), 'utf8');
ok('value-approval approve SoD',
  /function approve[\s\S]{0,400}assertMakerChecker\(user,\s*head\.created_by\)/.test(vapSrc));

const rfqSrc = fs.readFileSync(path.join(root, 'routes/rfq.js'), 'utf8');
ok('RFQ approve keeps assertMakerChecker', /assertMakerChecker\(req\.user,\s*row\.created_by\)/.test(rfqSrc));

const procSrc = fs.readFileSync(path.join(root, 'routes/procurement.js'), 'utf8');
ok('PO approve keeps assertMakerChecker', /assertMakerChecker\(req\.user,\s*row\.created_by\)/.test(procSrc));

const grniSrc = fs.readFileSync(path.join(root, 'lib/warehouse-grni-invoice.js'), 'utf8');
ok('GRNI invoice keeps assertMakerChecker', /assertMakerChecker\(user,\s*d\.created_by\)/.test(grniSrc));

const swSrc = fs.readFileSync(path.join(root, 'public/sw.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
ok('SW at least v550', swAtLeast(swSrc, 550));
ok('Help mentions 8D / SoD', /۸D|8D|تفکیک وظایف|maker-checker|E_SOD_MAKER_CHECKER/.test(appSrc));
ok('frontend maps E_SOD_MAKER_CHECKER', /E_SOD_MAKER_CHECKER\s*:/.test(appSrc));

const pkg = require('../package.json');
ok('package.json has test:audit-8d', pkg.scripts && pkg.scripts['test:audit-8d']);

console.log(`\n── result: ${pass} pass / ${fail} fail ──\n`);
process.exit(fail ? 1 : 0);
