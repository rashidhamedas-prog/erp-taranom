const router = require('express').Router();
const { getDB, audit } = require('../db');
const { postToLedger } = require('../lib/ledger');
const { acct } = require('../lib/coa-map');
const { rialToLedger, SQL_JL_DEBIT_RIAL, SQL_JL_CREDIT_RIAL } = require('../lib/money');
const { auth, adminOnly, centralOnly } = require('../middleware/auth');
const { todayJalali } = require('../jalali');
const { purgeTransactionalData, isWorkspaceClean } = require('../lib/clean-slate');
const { requireUserPassword, pickConfirmPassword } = require('../lib/password-verify');

function currentFiscalYear(db) {
  const activeId = db.prepare("SELECT value FROM settings WHERE key='active_fiscal_year_id'").get()?.value;
  if (activeId) {
    const byId = db.prepare('SELECT * FROM fiscal_years WHERE id=?').get(Number(activeId));
    if (byId) return byId;
  }
  return db.prepare("SELECT * FROM fiscal_years WHERE status='open' ORDER BY id DESC LIMIT 1").get()
    || db.prepare('SELECT * FROM fiscal_years ORDER BY id DESC LIMIT 1').get();
}

function yearPnLNetRial(db, fyId) {
  const hasType = db.prepare(`
    SELECT 1 AS ok FROM chart_of_accounts
    WHERE LOWER(COALESCE(type,'')) IN ('income','expense','revenue') LIMIT 1
  `).get();
  if (hasType) {
    return db.prepare(`
      SELECT COALESCE(SUM((${SQL_JL_CREDIT_RIAL}) - (${SQL_JL_DEBIT_RIAL})), 0) as net
      FROM journal_lines jl
      JOIN journal_entries je ON jl.entry_id=je.id
      JOIN chart_of_accounts coa ON coa.code=jl.account_code
      WHERE COALESCE(je.deleted_at,0)=0
        AND (? IS NULL OR je.fiscal_year_id=?)
        AND LOWER(COALESCE(coa.type,'')) IN ('income','expense','revenue')
    `).get(fyId || null, fyId || null).net || 0;
  }
  // Fallback for charts without type: 4xxx income, 5xxx/6xxx expense — never 3xxx equity.
  return db.prepare(`
    SELECT COALESCE(SUM((${SQL_JL_CREDIT_RIAL}) - (${SQL_JL_DEBIT_RIAL})), 0) as net
    FROM journal_lines jl
    JOIN journal_entries je ON jl.entry_id=je.id
    WHERE COALESCE(je.deleted_at,0)=0
      AND (? IS NULL OR je.fiscal_year_id=?)
      AND (
        jl.account_code LIKE '4%'
        OR jl.account_code LIKE '5%'
        OR jl.account_code LIKE '6%'
      )
  `).get(fyId || null, fyId || null).net || 0;
}

function requireAdminPassword(db, userId, password) {
  requireUserPassword(db, userId, password);
}

function fyTxnCount(db, fyId) {
  const je = db.prepare(`
    SELECT COUNT(*) c FROM journal_entries
    WHERE fiscal_year_id=? AND COALESCE(deleted_at,0)=0
  `).get(fyId)?.c || 0;
  return { journal_entries: je };
}

router.get('/', auth, adminOnly, (req, res) => {
  const db = getDB();
  const years = db.prepare('SELECT * FROM fiscal_years ORDER BY start_date DESC, id DESC').all();
  const current = currentFiscalYear(db);
  const enriched = years.map(y => {
    const counts = fyTxnCount(db, y.id);
    return {
      ...y,
      is_active: current && current.id === y.id,
      txn_count: counts.journal_entries,
      can_delete: !(current && current.id === y.id) && counts.journal_entries === 0,
    };
  });
  const clean = isWorkspaceClean(db);
  res.json({ current, years: enriched, cleanliness: clean.counts, workspace_clean: clean.clean });
});

// Pathway 1: Close current year, carry forward balances, open new year
router.post('/rollover', auth, adminOnly, centralOnly, (req, res) => {
  const { new_year_label, start_date, end_date } = req.body;
  if (!new_year_label || !start_date) return res.status(400).json({ error: 'برچسب و تاریخ شروع سال جدید الزامی است' });
  const db = getDB();
  const open = currentFiscalYear(db);

  const retained = yearPnLNetRial(db, open?.id || null);

  const receivables = db.prepare(`
    SELECT COALESCE(SUM(balance),0) as total FROM (
      SELECT c.id,
        COALESCE((SELECT SUM(debit-credit) FROM customer_ledger WHERE customer_id=c.id),0) as balance
      FROM customers c
    )
  `).get().total || 0;

  const inventory = db.prepare('SELECT COALESCE(SUM(stock * cost),0) as v FROM products').get().v || 0;

  const result = db.transaction(() => {
    if (open && open.status === 'open') {
      db.prepare("UPDATE fiscal_years SET status='closed', closed_at=strftime('%s','now'), closed_by=? WHERE id=?")
        .run(req.user.id, open.id);
    }
    const fy = db.prepare(`
      INSERT INTO fiscal_years (label, start_date, end_date, status, opening_retained, opening_receivables, opening_inventory, created_by)
      VALUES (?, ?, ?, 'open', ?, ?, ?, ?)
    `).run(new_year_label, start_date, end_date || '', retained, receivables, inventory, req.user.id);

    if (Math.abs(retained) > 0.01) {
      const retainedAccount = acct(db, 'coa_retained_earnings');
      const openingAccount = acct(db, 'coa_fiscal_opening');
      const absRial = Math.abs(retained);
      const amt = rialToLedger(absRial);
      postToLedger(db, {
        sourceType: 'fiscal_opening', sourceId: fy.lastInsertRowid, date: start_date,
        description: `افتتاحیه سال مالی ${new_year_label} — سود انباشته`,
        createdBy: req.user.id, voucherType: 'opening',
        lines: [
          { code: retainedAccount.code, name: retainedAccount.name, debit: retained < 0 ? amt : 0, credit: retained > 0 ? amt : 0 },
          { code: openingAccount.code, name: openingAccount.name, debit: retained > 0 ? amt : 0, credit: retained < 0 ? amt : 0 },
        ],
      });
    }
    db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('active_fiscal_year_id',?)").run(String(fy.lastInsertRowid));
    return fy.lastInsertRowid;
  })();

  audit(req.user.id, 'fiscal_rollover', 'fiscal_year', result, `انتقال سال مالی → ${new_year_label}`);
  res.json({ ok: true, fiscal_year_id: result, kept_documents: true });
});

function assertNotLegacyLocked(db, actionFa) {
  const coaMode = db.prepare("SELECT value FROM settings WHERE key='coa_mode'").get()?.value;
  if (coaMode === 'mahak' || coaMode === 'extended') {
    const err = new Error(`در حالت کدینگ تفصیلی، ${actionFa} مجاز نیست — اسناد واردشده از سیستم قبلی حفظ می‌شوند.`);
    err.status = 400;
    throw err;
  }
  const legacyDocs = db.prepare("SELECT COUNT(*) c FROM journal_entries WHERE src_system IN ('mahak','legacy') AND COALESCE(deleted_at,0)=0").get()?.c || 0;
  if (legacyDocs > 0) {
    const err = new Error(`${actionFa} با ${legacyDocs} سند واردشده از سیستم قبلی ممکن نیست.`);
    err.status = 400;
    throw err;
  }
}

function openFreshYear(db, { label, startDate, endDate, userId, mode }) {
  let fyId;
  const result = purgeTransactionalData(db, {
    mode,
    after: () => {
      db.prepare("UPDATE fiscal_years SET status='closed', closed_at=strftime('%s','now'), closed_by=? WHERE status IN ('open','locked')")
        .run(userId);
      const fy = db.prepare(`
        INSERT INTO fiscal_years (label, start_date, end_date, status, created_by)
        VALUES (?, ?, ?, 'open', ?)
      `).run(label, startDate, endDate || '', userId);
      fyId = fy.lastInsertRowid;
      db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('active_fiscal_year_id',?)")
        .run(String(fyId));
    },
  });
  return { fyId, wipe: result };
}

// Pathway 2: Factory reset — purge transactions, keep master data
router.post('/factory-reset', auth, adminOnly, centralOnly, (req, res) => {
  try {
    const { confirm_text } = req.body || {};
    if (confirm_text !== 'RESET-FISCAL') {
      return res.status(400).json({ error: 'متن تأیید نادرست است — RESET-FISCAL را تایپ کنید' });
    }
    const db = getDB();
    requireAdminPassword(db, req.user.id, pickConfirmPassword(req.body));
    const label = 'سال مالی جدید ' + todayJalali().slice(0, 4);
    const opened = openFreshYear(db, {
      label,
      startDate: todayJalali(),
      endDate: '',
      userId: req.user.id,
      mode: 'transactions',
    });
    audit(req.user.id, 'fiscal_factory_reset', 'fiscal_year', opened.fyId, 'بازنشانی کامل داده‌های مالی');
    res.json({
      ok: true,
      fiscal_year_id: opened.fyId,
      reload: true,
      cleanliness: opened.wipe.counts,
    });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message, code: e.code, leftover: e.leftover });
  }
});

/**
 * Open a brand-new fiscal year from zero: documents + customers + products.
 * Keeps users, COA, settings, empty warehouses/banks. Confirm: OPEN-CLEAN-YEAR + password.
 */
router.post('/open-clean', auth, adminOnly, centralOnly, (req, res) => {
  try {
    const {
      label, start_date, end_date,
      confirm_text,
    } = req.body || {};
    if (confirm_text !== 'OPEN-CLEAN-YEAR') {
      return res.status(400).json({ error: 'متن تأیید نادرست است — OPEN-CLEAN-YEAR را تایپ کنید' });
    }
    if (!label || !start_date) {
      return res.status(400).json({ error: 'برچسب و تاریخ شروع الزامی است' });
    }
    const db = getDB();
    requireAdminPassword(db, req.user.id, pickConfirmPassword(req.body));
    const opened = openFreshYear(db, {
      label,
      startDate: start_date,
      endDate: end_date || '',
      userId: req.user.id,
      mode: 'open-clean',
    });
    audit(req.user.id, 'fiscal_open_clean', 'fiscal_year', opened.fyId, `افتتاح سال خام ${label}`);
    res.json({
      ok: true,
      fiscal_year_id: opened.fyId,
      reload: true,
      cleanliness: opened.wipe.counts,
      wiped_catalog: true,
    });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message, code: e.code, leftover: e.leftover });
  }
});

router.post('/:id/activate', auth, adminOnly, centralOnly, (req, res) => {
  const db = getDB();
  const fy = db.prepare('SELECT * FROM fiscal_years WHERE id=?').get(req.params.id);
  if (!fy) return res.status(404).json({ error: 'سال مالی یافت نشد' });
  db.transaction(() => {
    // Keep historical rows as closed/locked; only unlock if it was locked and user wants writable.
    // Activating a closed year for *viewing/posting* sets it open and demotes other opens to closed.
    db.prepare("UPDATE fiscal_years SET status='closed' WHERE status='open' AND id<>?").run(fy.id);
    const nextStatus = fy.status === 'locked' && !req.body?.unlock ? 'locked' : 'open';
    if (nextStatus === 'open') {
      db.prepare("UPDATE fiscal_years SET status='open', closed_at=NULL, closed_by=NULL WHERE id=?").run(fy.id);
    }
    db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('active_fiscal_year_id',?)").run(String(fy.id));
  })();
  audit(req.user.id, 'fiscal_activate', 'fiscal_year', fy.id, `فعال‌سازی سال ${fy.label}`);
  res.json({ success: true, data: { id: fy.id, status: 'open', reload: true } });
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

router.delete('/:id', auth, adminOnly, centralOnly, (req, res) => {
  const db = getDB();
  const fy = db.prepare('SELECT * FROM fiscal_years WHERE id=?').get(req.params.id);
  if (!fy) return res.status(404).json({ error: 'سال مالی یافت نشد' });

  const current = currentFiscalYear(db);
  if (current && current.id === fy.id) {
    return res.status(400).json({ error: 'سال فعال قابل حذف نیست — ابتدا سال دیگری را فعال کنید' });
  }

  const counts = fyTxnCount(db, fy.id);
  const { confirm_password, confirm_text, force } = req.body || {};
  if (counts.journal_entries > 0) {
    if (confirm_text !== 'DELETE-FISCAL-YEAR' || !force) {
      return res.status(400).json({
        error: `این سال ${counts.journal_entries} سند دارد. برای حذف اجباری confirm_text=DELETE-FISCAL-YEAR و force=true بفرستید`,
        txn_count: counts.journal_entries,
      });
    }
    try {
      requireAdminPassword(db, req.user.id, pickConfirmPassword(req.body) || confirm_password);
    } catch (e) {
      return res.status(e.status || 403).json({ error: e.message, code: e.code });
    }
  }

  const total = db.prepare('SELECT COUNT(*) c FROM fiscal_years').get().c;
  if (total <= 1) {
    return res.status(400).json({ error: 'حداقل یک سال مالی باید باقی بماند' });
  }

  db.transaction(() => {
    // Soft-safety: null out fiscal_year_id on journals rather than cascade-delete docs
    try {
      db.prepare('UPDATE journal_entries SET fiscal_year_id=NULL WHERE fiscal_year_id=?').run(fy.id);
    } catch { /* ignore */ }
    db.prepare('DELETE FROM fiscal_years WHERE id=?').run(fy.id);
  })();

  audit(req.user.id, 'fiscal_delete', 'fiscal_year', fy.id, `حذف سال مالی ${fy.label}`);
  res.json({ ok: true, id: fy.id });
});

router.post('/legal-reserve', auth, adminOnly, centralOnly, (req, res) => {
  try {
    const { postLegalReserve } = require('./reserves');
    const db = getDB();
    const open = currentFiscalYear(db);
    const result = postLegalReserve(db, req.user.id, {
      ...req.body,
      fiscal_year_id: req.body.fiscal_year_id || open?.id || null,
    });
    audit(req.user.id, 'legal_reserve', 'fiscal_year', result.id, `${result.reserve_rial} ریال`);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
