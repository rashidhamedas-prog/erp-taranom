const router = require('express').Router();
const { getDB, audit, resolveCashAccount } = require('../db');
const { auth, adminOrAccounting } = require('../middleware/auth');
const { todayJalali } = require('../jalali');
const { postToLedger } = require('../lib/ledger');
const { acct } = require('../lib/coa-map');
const { parseFeeRial, outboundPaymentLines, outboundPaymentReversalLines } = require('../lib/payment-bank-fee');
const {
  assertActiveBank, assertActiveCashBox, assertBankOverdraftOk,
} = require('../lib/treasury-guards');

const COST_SECTIONS = new Set(['admin', 'selling', 'production_overhead']);

function sectionError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function activeAccount(db, code) {
  if (!code) return null;
  return db.prepare('SELECT code, name FROM chart_of_accounts WHERE code=? AND is_active=1').get(String(code)) || null;
}

function isExpenseCodingAccount(row) {
  if (!row) return false;
  const type = String(row.type || '').toLowerCase();
  const code = String(row.code || '');
  return type === 'expense' || type === 'cogs' || code.startsWith('5') || code.startsWith('6');
}

/** Explicit pick: any active expense level. Missing/inactive/non-expense does not fall back. */
function explicitExpenseAccount(db, accountCode) {
  const code = String(accountCode || '').trim();
  const row = db.prepare(
    'SELECT code, name, type, is_active FROM chart_of_accounts WHERE code=?'
  ).get(code);
  if (!row) {
    const err = sectionError(400, `حساب ${code} در کدینگ نیست`);
    err.code = 'E_COA_MISSING';
    throw err;
  }
  if (row.is_active === 0) {
    const err = sectionError(400, `حساب ${code} غیرفعال است`);
    err.code = 'E_COA_INACTIVE';
    throw err;
  }
  if (!isExpenseCodingAccount(row)) {
    const err = sectionError(400, `حساب ${code} جزو کدینگ هزینه نیست`);
    err.code = 'E_COA_NOT_EXPENSE';
    throw err;
  }
  return { code: row.code, name: row.name };
}

function findExpenseCategory(db, category) {
  if (category == null || category === '') return null;
  return db.prepare(
    'SELECT * FROM expense_categories WHERE active=1 AND (code=? OR id=?)'
  ).get(String(category), parseInt(category, 10) || -1) || null;
}

/** Walk parent categories: child account/section wins, else inherit. */
function resolveCategoryChain(db, category) {
  let cur = findExpenseCategory(db, category);
  let accountCode = null;
  let section = null;
  let name = cur?.name || null;
  let guard = 0;
  while (cur && guard++ < 8) {
    if (!section && COST_SECTIONS.has(cur.cost_section)) section = cur.cost_section;
    const code = cur.coa_code || cur.account_code;
    if (!accountCode && code) accountCode = code;
    if (accountCode && section) break;
    if (!cur.parent_id) break;
    cur = db.prepare('SELECT * FROM expense_categories WHERE id=?').get(cur.parent_id);
  }
  return { accountCode, section, name };
}

function sectionDefaultAccount(db, section, category) {
  if (section === 'production_overhead') return acct(db, 'coa_overhead_control');
  if (section === 'selling' || category === 'sales') return acct(db, 'coa_sales_expense');
  return acct(db, 'coa_admin_expense');
}

/**
 * One cost belongs to one section:
 * admin / selling → period expense (category moein, else 6102 / 6103)
 * production_overhead → control account 5202 and a live cost center
 */
function resolveExpensePosting(db, { category, account_code, is_overhead, cost_center_id, amount }) {
  const chain = resolveCategoryChain(db, category);
  let section = chain.section || (category === 'sales' ? 'selling' : 'admin');
  if (is_overhead || section === 'production_overhead') section = 'production_overhead';

  const { assertExpenseDocumentCostCenter } = require('../lib/cost-center-policy');
  let ccId;
  try {
    ccId = assertExpenseDocumentCostCenter(db, {
      cost_center_id,
      is_overhead: !!(is_overhead || section === 'production_overhead'),
      section,
      amount,
    });
  } catch (e) {
    throw sectionError(e.status || 400, e.message);
  }

  if (section === 'production_overhead') {
    return {
      account: acct(db, 'coa_overhead_control'),
      section,
      isOverhead: 1,
      costCenterId: ccId,
    };
  }

  const explicit = String(account_code == null ? '' : account_code).trim();
  if (explicit) {
    return {
      account: explicitExpenseAccount(db, explicit),
      section,
      isOverhead: 0,
      costCenterId: ccId,
    };
  }
  const picked = activeAccount(db, chain.accountCode);
  return {
    account: picked || sectionDefaultAccount(db, section, category),
    section,
    isOverhead: 0,
    costCenterId: ccId,
  };
}

function resolveExpenseAccount(db, category, account_code) {
  const chain = resolveCategoryChain(db, category);
  const picked = activeAccount(db, account_code) || activeAccount(db, chain.accountCode);
  if (picked) return picked;
  const section = chain.section || (category === 'sales' ? 'selling' : 'admin');
  return sectionDefaultAccount(db, section, category);
}

router.get('/categories', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  res.json(db.prepare('SELECT * FROM expense_categories WHERE active=1 ORDER BY id').all());
});

router.post('/categories', auth, adminOrAccounting, (req, res) => {
  const { name, code, account_code, coa_code, parent_id } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'نام دسته‌بندی الزامی است' });
  const db = getDB();
  const parentId = parent_id ? parseInt(parent_id, 10) : null;
  let level = 1;
  if (parentId) {
    const parent = db.prepare('SELECT id, level FROM expense_categories WHERE id=?').get(parentId);
    if (!parent) return res.status(400).json({ error: 'دسته والد یافت نشد' });
    level = (parent.level || 1) + 1;
  }
  const coa = coa_code || account_code || null;
  const section = COST_SECTIONS.has(req.body.cost_section) ? req.body.cost_section : null;
  const r = db.prepare(
    'INSERT INTO expense_categories (code,name,account_code,coa_code,parent_id,level,cost_section) VALUES (?,?,?,?,?,?,?)'
  ).run(code || null, String(name).trim(), account_code || coa, coa, parentId, level, section);
  audit(req.user.id, 'create', 'expense_category', r.lastInsertRowid, name);
  res.json(db.prepare('SELECT * FROM expense_categories WHERE id=?').get(r.lastInsertRowid));
});

router.put('/categories/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM expense_categories WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  const { name, code, account_code, active, coa_code, parent_id, cost_section } = req.body;
  let parentId = row.parent_id;
  let level = row.level || 1;
  if (parent_id !== undefined) {
    parentId = parent_id ? parseInt(parent_id, 10) : null;
    if (parentId) {
      if (parentId === parseInt(req.params.id, 10)) return res.status(400).json({ error: 'دسته نمی‌تواند والد خودش باشد' });
      const parent = db.prepare('SELECT id, level FROM expense_categories WHERE id=?').get(parentId);
      if (!parent) return res.status(400).json({ error: 'دسته والد یافت نشد' });
      level = (parent.level || 1) + 1;
    } else {
      level = 1;
    }
  }
  const coa = coa_code !== undefined ? (coa_code || null) : (row.coa_code || null);
  const acc = account_code !== undefined ? (account_code || null) : (row.account_code || coa);
  const section = cost_section !== undefined
    ? (COST_SECTIONS.has(cost_section) ? cost_section : null)
    : (row.cost_section || null);
  db.prepare(
    'UPDATE expense_categories SET name=?, code=?, account_code=?, coa_code=?, parent_id=?, level=?, active=?, cost_section=? WHERE id=?'
  ).run(
    name || row.name, code ?? row.code, acc, coa, parentId, level,
    active != null ? (active ? 1 : 0) : row.active, section, req.params.id
  );
  res.json({ ok: true });
});

router.delete('/categories/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM expense_categories WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  db.prepare('UPDATE expense_categories SET active=0 WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

router.get('/', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const rows = db.prepare(`
    SELECT e.*, u.name as recorder, cc.name as cost_center_name,
      pi.num as purchase_invoice_num,
      COALESCE(
        (SELECT c.name FROM expense_categories c WHERE c.code=e.category AND c.active=1 LIMIT 1),
        (SELECT c.name FROM expense_categories c WHERE c.id=CAST(e.category AS INTEGER) LIMIT 1),
        e.category
      ) AS category_name
    FROM expense_payments e
    LEFT JOIN users u ON e.created_by=u.id
    LEFT JOIN cost_centers cc ON e.cost_center_id=cc.id
    LEFT JOIN purchase_invoices pi ON e.purchase_invoice_id=pi.id
    WHERE COALESCE(e.status,'posted')<>'reversed'
    ORDER BY e.created_at DESC LIMIT 300
  `).all();
  res.json(rows);
});

router.post('/', auth, adminOrAccounting, (req, res) => {
  const {
    category, title, amount, pay_type, date, note, bank_id, cash_box_id,
    check_category_id, cost_center_id, account_code, purchase_invoice_id, is_overhead,
    fee_rial, bank_fee_rial
  } = req.body;
  const amt = parseFloat(amount) || 0;
  if (!amt) return res.status(400).json({ error: 'مبلغ الزامی است' });
  const fee = parseFeeRial(fee_rial ?? bank_fee_rial, pay_type || 'cash');
  const db = getDB();
  const payTypeNorm = pay_type || 'cash';
  try {
    if (payTypeNorm === 'cash' && cash_box_id) assertActiveCashBox(db, cash_box_id);
    if (payTypeNorm === 'bank' || payTypeNorm === 'bank_transfer') {
      assertActiveBank(db, bank_id);
      assertBankOverdraftOk(db, bank_id, amt + fee);
    }
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
  let posting;
  try {
    posting = resolveExpensePosting(db, { category, account_code, is_overhead, cost_center_id, amount: amt });
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
  const acc = posting.account;
  const expId = db.transaction(() => {
    const result = db.prepare(
      `INSERT INTO expense_payments (category,title,amount,fee_rial,pay_type,bank_id,cash_box_id,check_category_id,cost_center_id,date,note,created_by,account_code,purchase_invoice_id,is_overhead)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(category || 'admin', title || '', amt, fee, payTypeNorm, bank_id || null, cash_box_id || null,
          check_category_id || null, posting.costCenterId, date || todayJalali(), note || '',
          req.user.id, acc.code, purchase_invoice_id || null, posting.isOverhead);
    const expId = result.lastInsertRowid;

    const cash = resolveCashAccount(db, payTypeNorm, bank_id, cash_box_id);
    const { lines } = outboundPaymentLines(db, {
      amount: amt, feeRial: fee, payType: payTypeNorm,
      dest: acc, cash, destDescription: title || '',
    });
    // ADR-003 / PRD-06: production overhead JE tagged for period-close precheck
    const expSourceType = posting.isOverhead || posting.section === 'production_overhead'
      ? 'production_overhead_actual'
      : 'expense_payment';
    const entryId = postToLedger(db, {
      sourceType: expSourceType, sourceId: expId,
      date: date || todayJalali(), description: `پرداخت هزینه: ${title || acc.name}`,
      createdBy: req.user.id, costCenterId: posting.costCenterId,
      lines,
    });
    db.prepare('UPDATE expense_payments SET journal_entry_id=? WHERE id=?').run(entryId, expId);
    return expId;
  })();

  audit(req.user.id, 'create', 'expense_payment', expId, `پرداخت هزینه ${amt} ریال (${title || acc.name})`);
  try {
    const { dispatchSmsEvent } = require('../lib/sms-dispatch');
    setImmediate(() => dispatchSmsEvent(db, 'payment.created', {
      phone: '',
      name: title || acc.name,
      amount: amt,
      date: date || '',
      note: note || '',
      created_by: req.user.id,
      user: req.user.name,
    }));
  } catch (_) {}
  if (purchase_invoice_id) {
    const { recomputePurchaseInvoiceSettledBalances } = require('../lib/purchase-payments');
    recomputePurchaseInvoiceSettledBalances(db, purchase_invoice_id);
  }
  res.json({ id: expId, ok: true });
});

router.get('/overhead-pool', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const from = req.query.from || '';
  const to = req.query.to || '';
  const where = ["is_overhead=1", "COALESCE(status,'posted')<>'reversed'"], params = [];
  if (from) { where.push('date>=?'); params.push(from); }
  if (to) { where.push('date<=?'); params.push(to); }
  const tagged = db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM expense_payments WHERE ${where.join(' AND ')}`).get(...params).s;

  const settings = {};
  db.prepare('SELECT key,value FROM settings WHERE key IN (?,?,?)').all(
    'overhead_method', 'overhead_fixed_rate', 'overhead_period_production_qty'
  ).forEach(r => { settings[r.key] = r.value; });

  const method = settings.overhead_method || 'tag';
  const fixedRate = parseFloat(settings.overhead_fixed_rate) || 0;
  const periodQty = parseInt(settings.overhead_period_production_qty) || 0;
  const fixedPool = fixedRate * periodQty;

  res.json({
    method,
    tagged_overhead: tagged,
    fixed_rate: fixedRate,
    period_production_qty: periodQty,
    fixed_pool: fixedPool,
    total_pool: method === 'fixed' ? fixedPool : (method === 'both' ? tagged + fixedPool : tagged)
  });
});

router.delete('/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM expense_payments WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  if (row.status === 'reversed') return res.status(400).json({ error: 'این هزینه قبلاً ابطال شده است' });
  const acc = resolveExpenseAccount(db, row.category, row.account_code);
  db.transaction(() => {
    const cash = resolveCashAccount(db, row.pay_type, row.bank_id, row.cash_box_id);
    const { lines } = outboundPaymentReversalLines(db, {
      amount: row.amount, feeRial: row.fee_rial || 0, dest: acc, cash,
    });
    const revSrc = Number(row.is_overhead) === 1
      ? 'production_overhead_actual_reversal'
      : 'expense_payment_reversal';
    const reversalId = postToLedger(db, {
      sourceType: revSrc, sourceId: row.id,
      date: todayJalali(), description: `ابطال پرداخت هزینه #${row.id}`, createdBy: req.user.id,
      costCenterId: row.cost_center_id || null,
      lines,
    });
    try {
      db.prepare(`
        UPDATE journal_entries SET status='reversed'
        WHERE ref_type='expense_payment' AND ref_id=? AND COALESCE(deleted_at,0)=0 AND id<>?
      `).run(row.id, reversalId);
    } catch (_) {}
    db.prepare("UPDATE expense_payments SET status='reversed',reversal_journal_id=?,reversed_at=strftime('%s','now'),reversed_by=? WHERE id=?")
      .run(reversalId, req.user.id, row.id);
  })();
  if (row.purchase_invoice_id) {
    const { recomputePurchaseInvoiceSettledBalances } = require('../lib/purchase-payments');
    recomputePurchaseInvoiceSettledBalances(db, row.purchase_invoice_id);
  }
  audit(req.user.id, 'reverse', 'expense_payment', req.params.id, `ابطال پرداخت هزینه #${req.params.id}`);
  res.json({ ok: true });
});

router.put('/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  try {
    const { amendExpensePayment } = require('../lib/amend-cash-ops');
    const out = db.transaction(() => amendExpensePayment(db, +req.params.id, req.body || {}, req.user.id))();
    audit(req.user.id, 'update', 'expense_payment', out.id, out.summary);
    res.json({ ok: true, id: out.id, amount: out.amount });
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error('amend expense', e);
    res.status(status).json({ error: e.message || 'اصلاح پرداخت هزینه ناموفق بود', code: e.code });
  }
});

module.exports = router;
module.exports.resolveExpensePosting = resolveExpensePosting;
module.exports.COST_SECTIONS = COST_SECTIONS;
