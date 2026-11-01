'use strict';
/**
 * P9 — پورسانت چندنفره (/api/commissions).
 *   GET  /meta                                     اشخاص، گروه کالا، دورهٔ حقوق باز، مرکز هزینه
 *   GET  /report?from=&to=[&person_id=&detail=1]   گزارش ماهانه/بازه per person
 *   GET  /rules                                    قاعده‌ها (?person_id=&include_inactive=1)
 *   POST /rules                                    قاعدهٔ جدید
 *   PUT  /rules/:id                                ویرایش
 *   POST /rules/:id/deactivate                     ابطال (غیرفعال؛ بدون حذف فیزیکی)
 *   GET  /invoice-parties/:invoiceId               طرف‌های پورسانت فاکتور
 *   PUT  /invoice-parties/:invoiceId               تعیین چند فروشنده/سرپرست با سهم (جمع ۱۰۰٪)
 *   GET  /transfers                                انتقال‌ها
 *   POST /transfers                                انتقال به حقوق (کارمند) / سند پیش‌نویس (غیرکارمند)
 *   POST /transfers/:id/void                       ابطال کامل R13
 *   GET  /beneficiaries                            اشخاص دارای قاعده + نوع ذی‌نفع/فلگ‌ها (P9-fix)
 *   PUT  /beneficiaries/:personId                  نوع ذی‌نفع employee|agent + insurance/payroll_tax_applicable
 *   GET  /review?month=YYYY/MM                     بازبینی ماهانه: فلگ خاموش / نمایندهٔ با نرخ ۰ / تعارض موتور
 *   GET  /account-suggestions                      پیشنهاد حساب از کدینگ موجود (فقط خواندنی)
 *   GET|PUT /settings                              نرخ کسر مالیات نماینده (PUT فقط مدیر، مرکز)
 * تعارض موتور (انگیزه فروش قدیمی فعال) ⇒ ۴۰۹ E_COMMISSION_ENGINE_CONFLICT.
 */
const router = require('express').Router();
const { getDB, audit } = require('../db');
const { auth, adminOrAccounting, adminOnly, centralOnly } = require('../middleware/auth');
const CM = require('../lib/commissions-multi');
const CB = require('../lib/commission-beneficiary');

function sendErr(res, e) {
  const status = e && e.status ? e.status : 500;
  if (status >= 500) console.error('commissions:', e);
  return res.status(status).json({ error: (e && e.message) || String(e), code: (e && e.code) || undefined });
}

router.get('/meta', auth, adminOrAccounting, (req, res) => {
  try { res.json(CM.commissionMeta(getDB())); } catch (e) { sendErr(res, e); }
});

router.get('/report', auth, adminOrAccounting, (req, res) => {
  try {
    res.json(CM.commissionReport(getDB(), {
      from: req.query.from, to: req.query.to, person_id: req.query.person_id, detail: req.query.detail === '1',
    }));
  } catch (e) { sendErr(res, e); }
});

router.get('/rules', auth, adminOrAccounting, (req, res) => {
  try {
    res.json({ rows: CM.listRules(getDB(), { person_id: req.query.person_id, include_inactive: req.query.include_inactive === '1' }) });
  } catch (e) { sendErr(res, e); }
});

router.post('/rules', auth, adminOrAccounting, (req, res) => {
  try {
    const row = CM.createRule(getDB(), req.body || {}, req.user.id);
    audit(req.user.id, 'create', 'commission_rule', row.id, `قاعدهٔ پورسانت ${row.role}/${row.scope} ${row.pct}%`);
    res.json(row);
  } catch (e) { sendErr(res, e); }
});

router.put('/rules/:id', auth, adminOrAccounting, (req, res) => {
  try {
    const row = CM.updateRule(getDB(), req.params.id, req.body || {}, req.user.id);
    audit(req.user.id, 'update', 'commission_rule', row.id, `ویرایش قاعدهٔ پورسانت ${row.pct}%`);
    res.json(row);
  } catch (e) { sendErr(res, e); }
});

router.post('/rules/:id/deactivate', auth, adminOrAccounting, (req, res) => {
  try {
    const row = CM.deactivateRule(getDB(), req.params.id, req.user.id);
    audit(req.user.id, 'reverse', 'commission_rule', row.id, 'غیرفعال‌سازی قاعدهٔ پورسانت');
    res.json(row);
  } catch (e) { sendErr(res, e); }
});

router.get('/invoice-parties/:invoiceId', auth, adminOrAccounting, (req, res) => {
  try { res.json(CM.getInvoiceParties(getDB(), req.params.invoiceId)); } catch (e) { sendErr(res, e); }
});

router.put('/invoice-parties/:invoiceId', auth, adminOrAccounting, (req, res) => {
  try {
    const out = CM.setInvoiceParties(getDB(), req.params.invoiceId, (req.body || {}).parties, req.user.id);
    audit(req.user.id, 'update', 'invoice_commission_parties', Number(req.params.invoiceId), `طرف‌های پورسانت: ${out.parties.length} نفر`);
    res.json(out);
  } catch (e) { sendErr(res, e); }
});

router.get('/transfers', auth, adminOrAccounting, (req, res) => {
  try { res.json({ rows: CM.listTransfers(getDB(), { status: req.query.status, person_id: req.query.person_id }) }); } catch (e) { sendErr(res, e); }
});

router.post('/transfers', auth, adminOrAccounting, (req, res) => {
  try {
    const row = CM.createTransfer(getDB(), req.body || {}, req.user.id);
    audit(req.user.id, 'create', 'commission_transfer', row.id, `${row.doc_no} → ${row.target} ${row.amount_rial}`);
    res.json(row);
  } catch (e) { sendErr(res, e); }
});

router.post('/transfers/:id/void', auth, adminOrAccounting, (req, res) => {
  try {
    const row = CM.voidTransfer(getDB(), req.params.id, req.user.id, (req.body || {}).reason);
    audit(req.user.id, 'reverse', 'commission_transfer', row.id, `ابطال ${row.doc_no}`);
    res.json(row);
  } catch (e) { sendErr(res, e); }
});

// ── P9-fix: ذی‌نفع، بازبینی ماهانه، پیشنهاد حساب، نرخ کسر مالیات نماینده ──

router.get('/beneficiaries', auth, adminOrAccounting, (req, res) => {
  try { res.json({ rows: CB.listBeneficiaries(getDB()), agent_tax_rate_pct: CB.agentTaxRatePct(getDB()) }); } catch (e) { sendErr(res, e); }
});

router.put('/beneficiaries/:personId', auth, adminOrAccounting, (req, res) => {
  try {
    const row = CB.updateBeneficiary(getDB(), req.params.personId, req.body || {});
    audit(req.user.id, 'update', 'person', row.person_id,
      `ذی‌نفع پورسانت: ${row.beneficiary_type} بیمه=${row.insurance_applicable} مالیات=${row.payroll_tax_applicable}`);
    res.json(row);
  } catch (e) { sendErr(res, e); }
});

router.get('/review', auth, adminOrAccounting, (req, res) => {
  try { res.json(CB.reviewReport(getDB(), req.query.month)); } catch (e) { sendErr(res, e); }
});

router.get('/account-suggestions', auth, adminOrAccounting, (req, res) => {
  try { res.json(CB.accountSuggestions(getDB())); } catch (e) { sendErr(res, e); }
});

router.get('/settings', auth, adminOrAccounting, (req, res) => {
  try { res.json({ agent_tax_rate_pct: CB.agentTaxRatePct(getDB()) }); } catch (e) { sendErr(res, e); }
});

router.put('/settings', auth, adminOnly, centralOnly, (req, res) => {
  try {
    const db = getDB();
    const before = CB.agentTaxRatePct(db);
    const after = CB.setAgentTaxRatePct(db, (req.body || {}).agent_tax_rate_pct);
    audit(req.user.id, 'update', 'settings', null, `${CB.AGENT_TAX_KEY}: ${before}% → ${after}%`);
    res.json({ agent_tax_rate_pct: after });
  } catch (e) { sendErr(res, e); }
});

module.exports = router;
