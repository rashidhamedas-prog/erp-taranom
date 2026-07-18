const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { getDB, audit, createJournalEntry } = require('../db');
const { auth, adminOnly, centralOnly } = require('../middleware/auth');
const { todayJalali } = require('../jalali');

function currentFiscalYear(db) {
  return db.prepare("SELECT * FROM fiscal_years WHERE status='open' ORDER BY id DESC LIMIT 1").get()
    || db.prepare('SELECT * FROM fiscal_years ORDER BY id DESC LIMIT 1').get();
}

router.get('/', auth, adminOnly, (req, res) => {
  const db = getDB();
  const years = db.prepare('SELECT * FROM fiscal_years ORDER BY start_date DESC').all();
  res.json({ current: currentFiscalYear(db), years });
});

// Pathway 1: Close current year, carry forward balances, open new year
router.post('/rollover', auth, adminOnly, centralOnly, (req, res) => {
  const { new_year_label, start_date, end_date } = req.body;
  if (!new_year_label || !start_date) return res.status(400).json({ error: 'برچسب و تاریخ شروع سال جدید الزامی است' });
  const db = getDB();
  const open = currentFiscalYear(db);
  if (open && open.status === 'open') {
    db.prepare("UPDATE fiscal_years SET status='closed', closed_at=strftime('%s','now'), closed_by=? WHERE id=?")
      .run(req.user.id, open.id);
  }

  const retained = db.prepare(`
    SELECT COALESCE(SUM(jl.credit - jl.debit), 0) as net
    FROM journal_lines jl JOIN journal_entries je ON jl.entry_id=je.id
    WHERE jl.account_code LIKE '3%' AND COALESCE(je.deleted_at,0)=0
  `).get().net || 0;

  const receivables = db.prepare(`
    SELECT COALESCE(SUM(balance),0) as total FROM (
      SELECT c.id,
        COALESCE((SELECT SUM(debit-credit) FROM customer_ledger WHERE customer_id=c.id),0) as balance
      FROM customers c
    )
  `).get().total || 0;

  const inventory = db.prepare('SELECT COALESCE(SUM(stock * cost),0) as v FROM products').get().v || 0;

  const result = db.transaction(() => {
    const fy = db.prepare(`
      INSERT INTO fiscal_years (label, start_date, end_date, status, opening_retained, opening_receivables, opening_inventory, created_by)
      VALUES (?, ?, ?, 'open', ?, ?, ?, ?)
    `).run(new_year_label, start_date, end_date || '', retained, receivables, inventory, req.user.id);

    if (Math.abs(retained) > 0.01) {
      createJournalEntry(db, {
        date: start_date,
        description: `افتتاحیه سال مالی ${new_year_label} — سود انباشته`,
        ref_type: 'fiscal_opening', ref_id: fy.lastInsertRowid, created_by: req.user.id,
        lines: [
          { code: '3101', name: 'سود (زیان) انباشته', debit: retained < 0 ? Math.abs(retained) : 0, credit: retained > 0 ? retained : 0 },
          { code: '3201', name: 'افتتاحیه سال مالی', debit: retained > 0 ? retained : 0, credit: retained < 0 ? Math.abs(retained) : 0 },
        ],
      });
    }
    db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('active_fiscal_year_id',?)").run(String(fy.lastInsertRowid));
    return fy.lastInsertRowid;
  })();

  audit(req.user.id, 'fiscal_rollover', 'fiscal_year', result, `انتقال سال مالی → ${new_year_label}`);
  res.json({ ok: true, fiscal_year_id: result });
});

// Pathway 2: Factory reset — purge transactions, keep master data
router.post('/factory-reset', auth, adminOnly, centralOnly, (req, res) => {
  const { confirm_password, confirm_text } = req.body;
  if (confirm_text !== 'RESET-FISCAL') return res.status(400).json({ error: 'متن تأیید نادرست است — RESET-FISCAL را تایپ کنید' });
  const db = getDB();
  const coaMode = db.prepare("SELECT value FROM settings WHERE key='coa_mode'").get();
  if (coaMode && (coaMode.value === 'mahak' || coaMode.value === 'extended')) {
    return res.status(400).json({ error: 'در حالت کدینگ تفصیلی، بازنشانی کامل مجاز نیست — اسناد واردشده از سیستم قبلی حفظ می‌شوند.' });
  }
  const legacyDocs = db.prepare("SELECT COUNT(*) c FROM journal_entries WHERE src_system IN ('mahak','legacy') AND COALESCE(deleted_at,0)=0").get().c;
  if (legacyDocs > 0) {
    return res.status(400).json({ error: `بازنشانی کامل با ${legacyDocs} سند واردشده از سیستم قبلی ممکن نیست.` });
  }
  const user = db.prepare('SELECT password FROM users WHERE id=?').get(req.user.id);
  if (!user || !bcrypt.compareSync(confirm_password || '', user.password)) {
    return res.status(403).json({ error: 'رمز عبور نادرست است' });
  }

  db.transaction(() => {
    const tables = [
      'journal_lines', 'journal_entries', 'customer_ledger', 'person_ledger',
      'settlements', 'invoices', 'purchase_invoices', 'supplier_payments',
      'sales_returns', 'purchase_returns', 'expense_payments', 'incentive_payments',
      'rep_payment_submissions', 'rep_expenses', 'rep_advances', 'payroll_records',
      'production_runs', 'stocktaking_items', 'stocktaking_sessions',
      'warehouse_moves', 'stock_logs', 'voucher_drafts', 'ai_insights',
      'app_notifications',
    ];
    for (const t of tables) {
      try { db.prepare(`DELETE FROM ${t}`).run(); } catch { /* table may not exist */ }
    }
    db.prepare('UPDATE customers SET balance=0, churn_score=0').run();
    db.prepare('UPDATE products SET stock=0').run();
    db.prepare('UPDATE warehouse_stock SET qty=0').run();
    db.prepare("UPDATE fiscal_years SET status='closed' WHERE status='open'").run();
    const label = 'سال مالی جدید ' + todayJalali().slice(0, 4);
    const fy = db.prepare(`
      INSERT INTO fiscal_years (label, start_date, status, created_by) VALUES (?, ?, 'open', ?)
    `).run(label, todayJalali(), req.user.id);
    db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('active_fiscal_year_id',?)").run(String(fy.lastInsertRowid));
  })();

  audit(req.user.id, 'fiscal_factory_reset', 'fiscal_year', null, 'بازنشانی کامل داده‌های مالی');
  res.json({ ok: true });
});

router.post('/:id/lock', auth, adminOnly, centralOnly, (req, res) => {
  const db = getDB();
  const fy = db.prepare('SELECT * FROM fiscal_years WHERE id=?').get(req.params.id);
  if (!fy) return res.status(404).json({ error: 'سال مالی یافت نشد' });
  db.prepare("UPDATE fiscal_years SET status='locked', closed_at=strftime('%s','now'), closed_by=? WHERE id=?")
    .run(req.user.id, fy.id);
  audit(req.user.id, 'fiscal_lock', 'fiscal_year', fy.id, `قفل سال مالی ${fy.label}`);
  res.json({ success: true, data: { id: fy.id, status: 'locked' } });
});

router.post('/:id/unlock', auth, adminOnly, centralOnly, (req, res) => {
  const db = getDB();
  const fy = db.prepare('SELECT * FROM fiscal_years WHERE id=?').get(req.params.id);
  if (!fy) return res.status(404).json({ error: 'سال مالی یافت نشد' });
  db.prepare("UPDATE fiscal_years SET status='open', closed_at=NULL, closed_by=NULL WHERE id=?").run(fy.id);
  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('active_fiscal_year_id',?)").run(String(fy.id));
  audit(req.user.id, 'fiscal_unlock', 'fiscal_year', fy.id, `بازگشایی سال مالی ${fy.label}`);
  res.json({ success: true, data: { id: fy.id, status: 'open' } });
});

module.exports = router;
