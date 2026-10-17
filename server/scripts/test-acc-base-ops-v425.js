'use strict';
/**
 * Invariants for accounting base + manual voucher guards.
 * Run: node server/scripts/test-acc-base-ops-v425.js
 */
const fs = require('fs');
const path = require('path');
const { activateDecision, deleteDecision } = require('../lib/fiscal-year-policy');
const {
  parseVoucherAmount, normalizeDocType, sanitizeTemplateLine, nextNumericCode, coaStructureLocked,
} = require('../lib/voucher-guards');
const { matchAccAccess } = require('../lib/accounting-access');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK', label); }
  else { fail += 1; console.log(' FAIL', label, extra != null ? extra : ''); }
}

const locked = activateDecision({ id: 2, status: 'locked' }, {});
ok(locked.status === 409 && locked.code === 'E_FY_LOCKED' && locked.mutate === false, 'locked year activate does not open');
const opened = activateDecision({ id: 2, status: 'locked' }, { unlock: true });
ok(opened.ok && opened.nextStatus === 'open' && opened.closeOtherOpens, 'explicit unlock opens and closes other years');
const closed = activateDecision({ id: 3, status: 'closed' }, {});
ok(closed.ok && closed.closeOtherOpens, 'closed year activate is the single open year');

const doomed = deleteDecision({ fy: { id: 4 }, isCurrent: false, journalCount: 3, yearCount: 2 });
ok(doomed.status === 409 && doomed.code === 'E_FY_HAS_JOURNALS', 'year with journals is not deleted');
ok(deleteDecision({ fy: { id: 1 }, isCurrent: true, journalCount: 0, yearCount: 2 }).status === 400, 'active year stays');
ok(deleteDecision({ fy: { id: 9 }, isCurrent: false, journalCount: 0, yearCount: 2 }).ok, 'empty inactive year may be deleted');

ok(parseVoucherAmount(-1).code === 'E_AMOUNT', 'negative amount rejected');
ok(parseVoucherAmount('NaN').code === 'E_AMOUNT', 'NaN rejected');
ok(parseVoucherAmount(1.5).code === 'E_AMOUNT', 'fractional rial rejected');
ok(parseVoucherAmount('').value === 0 && parseVoucherAmount(1200).value === 1200, 'empty is zero and integer rial passes');
ok(normalizeDocType('hacked').code === 'E_DOC_TYPE', 'client doc_type allowlist');
ok(normalizeDocType('افتتاحیه').value === 'افتتاحیه', 'opening label allowed');

const line = sanitizeTemplateLine({
  code: '6101', debit: 10, credit: 0, description: 'اجاره', tafsili2_code: 'P1',
  detail_account_id: 4, cost_center_id: 2, project_id: 8, tax_type: 'vat', evil: 'drop',
});
ok(line.tafsili2_code === 'P1' && line.detail_account_id === 4 && line.tax_type === 'vat' && !line.evil, 'template keeps line fields and drops extras');
ok(nextNumericCode(['CC-001', 'CC-007', 'CC-WORKSHOP'], 'CC-') === 'CC-008', 'cost center code is max+1 not count+1');
ok(coaStructureLocked({ type: 'expense', parent_code: '6000' }, { type: 'asset' }, 2).code === 'E_COA_TYPE_LOCKED', 'moved account type locked');
ok(coaStructureLocked({ type: 'expense', parent_code: '6000' }, { parent_code: '6100' }, 2).code === 'E_COA_PARENT_LOCKED', 'moved account parent locked');
ok(!coaStructureLocked({ type: 'expense', parent_code: '6000' }, { name: 'جدید', is_active: 0 }, 2), 'name and deactivate stay allowed');

const voucherHits = matchAccAccess('/api/accounting/vouchers');
ok(voucherHits.some((h) => h.resource === 'acc_journal_entry' && !h.readOnly), 'journal entry can post vouchers');
ok(voucherHits.some((h) => h.resource === 'acc_settlements' && h.readOnly), 'settlements voucher access is read-only');
ok(!voucherHits.some((h) => h.resource === 'acc_settlements' && !h.readOnly), 'settlements cannot post a manual voucher');

const root = path.join(__dirname, '..');
const fiscal = fs.readFileSync(path.join(root, 'routes/fiscal-year.js'), 'utf8');
const acc = fs.readFileSync(path.join(root, 'routes/accounting.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
ok(!fiscal.includes('fiscal_year_id=NULL'), 'delete does not null journal fiscal year');
ok(fiscal.includes("status: saved.status"), 'activate response uses saved status');
ok(acc.includes('include_inactive') && app.includes('chartOfAccountsAll'), 'inactive accounts stay reachable in the chart editor');
ok(app.includes('fetchAllJournalDocs(\'ref_type=manual_voucher'), 'manual voucher list pages through the journal');
ok(app.includes('client_request_id:_voucherIdem'), 'voucher save sends an idempotency key');
const journalFn = acc.slice(acc.indexOf("router.get('/journal'"), acc.indexOf("router.get('/statement/"));
ok(journalFn.includes('if (!includeAudit)') && journalFn.indexOf("<>'reversed'") > journalFn.indexOf('if (!includeAudit)'), 'reversed rows return only in audit mode');

console.log(fail ? `\n${fail} failed, ${pass} passed` : `\n${pass} passed`);
process.exit(fail ? 1 : 0);
