const router = require('express').Router();
const { getDB, audit, createLedgerEntry, createJournalEntry, allocateNumber, isDevice } = require('../db');
const { acct, coaMode } = require('../lib/coa-map');

// دریافتنیِ این مشتری: تفصیلی خودش (coa_code) وگرنه حساب کنترلی نگاشت‌شده
function receivableAcct(db, custId) {
  const c = db.prepare('SELECT coa_code FROM customers WHERE id=?').get(custId);
  if (c && c.coa_code) {
    const a = db.prepare('SELECT code,name FROM chart_of_accounts WHERE code=?').get(c.coa_code);
    if (a) return a;
  }
  return acct(db, 'coa_receivable');
}

// سند بهای تمام‌شده مثل محک (تصمیم ۸ مهاجرت): Dr بهای تمام‌شده / Cr موجودی هر کالا.
// فقط در حالت کدینگ محک و با کلید feature_cogs_voucher. reverse=true برای ابطال.
function postCogsVoucher(db, invId, num, date, rows, userId, reverse) {
  if (coaMode(db) !== 'mahak') return;
  const on = db.prepare("SELECT value FROM settings WHERE key='feature_cogs_voucher'").get();
  if (!on || on.value !== '1') return;
  if (reverse) {
    // فقط اگر سند اصلی وجود دارد معکوس بزن
    const orig = db.prepare("SELECT id FROM journal_entries WHERE ref_type='invoice_cogs' AND ref_id=? AND COALESCE(deleted_at,0)=0").get(invId);
    if (!orig) return;
  }
  const lines = [];
  let total = 0;
  for (const r of rows || []) {
    const p = db.prepare('SELECT cost,coa_code,name FROM products WHERE id=?').get(r.product_id);
    if (!p || !p.cost || !p.coa_code) continue;
    const amt = Math.round(p.cost * (parseInt(r.qty) || 0));
    if (amt <= 0) continue;
    total += amt;
    lines.push({ code: p.coa_code, name: p.name, debit: reverse ? amt : 0, credit: reverse ? 0 : amt });
  }
  if (!total) return;
  const cogs = acct(db, 'coa_cogs');
  lines.unshift({ code: cogs.code, name: cogs.name, debit: reverse ? 0 : total, credit: reverse ? total : 0 });
  createJournalEntry(db, {
    date: date || '', description: `بهای تمام‌شده فاکتور ${num}${reverse ? ' (ابطال)' : ''}`,
    ref_type: reverse ? 'invoice_cogs_reversal' : 'invoice_cogs', ref_id: invId, created_by: userId, lines
  });
}
const { auth, adminOnly, requirePermission } = require('../middleware/auth');
const { todayJalali, addDaysToJalali } = require('../jalali');
const notif = require('../lib/notifications');

function getScope(req) {
  // Accounting staff see all invoices (read scope) — needed for the Sales
  // Invoices list inside the Accounting module, same as customers.js's getScope.
  const seesAll = req.user.role === 'admin' || req.user.role === 'accounting';
  if (req.user.role === 'admin' && req.query.user_id) return parseInt(req.query.user_id);
  if (seesAll) return null;
  return req.user.id;
}

function getSetting(db, key) {
  const r = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return r ? r.value : '';
}

function faNum(n) {
  return Number(n || 0).toLocaleString('fa-IR');
}

// Sales channel is derived from WHO issues the invoice — never from the
// request body for sales roles (spec 1.0.9 §1).
const ROLE_CHANNEL = { field_sales: 'field', inside_sales: 'phone', salesperson: 'field' };
function resolveSalesChannel(req) {
  const forced = ROLE_CHANNEL[req.user.role];
  if (forced) return forced;
  // Admin/accounting may set explicitly when creating on behalf of the company
  if (['admin', 'accounting', 'sales_manager'].includes(req.user.role)) {
    return req.body.sales_channel || '';
  }
  return '';
}

// Validate & normalize invoice rows.
// Price is always editable by both admin and salesperson (Phase 2 change).
// Line-item discount is only honored when canDiscount is true — enforced
// server-side so a non-privileged client can never smuggle a row discount
// through by editing the request body directly.
// product_id must be valid.
function buildRows(db, inputRows, canDiscount) {
  const out = [];
  let subtotal = 0;
  for (const r of (inputRows || [])) {
    const pid = parseInt(r.product_id);
    if (!pid) throw new Error('هر ردیف باید یک محصول معتبر داشته باشد');
    const prod = db.prepare('SELECT * FROM products WHERE id=?').get(pid);
    if (!prod) throw new Error('محصول یافت نشد (شناسه ' + pid + ')');
    const qty = Math.max(1, parseInt(r.qty) || 1);
    // Allow price override by anyone (Phase 2: price always editable)
    let price = prod.price;
    if (r.price !== undefined && r.price !== null && r.price !== '') {
      price = parseFloat(r.price) || 0;
    }
    const disc = canDiscount ? Math.min(100, Math.max(0, parseFloat(r.disc) || 0)) : 0;
    const gross = qty * price;
    const discAmt = Math.round(gross * disc / 100);
    const sum = gross - discAmt;
    subtotal += sum;
    out.push({ product_id: pid, name: prod.name, qty, price, disc, disc_amt: discAmt, sum });
  }
  return { rows: out, subtotal };
}

// Deduct stock for each row; returns error message if stock insufficient
function deductStock(db, rows) {
  for (const r of rows) {
    const prod = db.prepare('SELECT * FROM products WHERE id=?').get(r.product_id);
    if (!prod) return `محصول شناسه ${r.product_id} یافت نشد`;
    if (prod.stock < r.qty) {
      return `موجودی ${prod.name} کافی نیست (موجود: ${prod.stock})`;
    }
  }
  // All checks passed — deduct
  for (const r of rows) {
    db.prepare('UPDATE products SET stock=stock-? WHERE id=?').run(r.qty, r.product_id);
    db.prepare('INSERT INTO stock_logs (product_id,user_id,change,note) VALUES (?,?,?,?)').run(
      r.product_id, 0, -r.qty, 'کسر موجودی از فاکتور رسمی'
    );
  }
  return null;
}

router.get('/', auth, (req, res) => {
  const db = getDB();
  const scope = getScope(req);
  // List view omits the heavy `rows` JSON blob — fetch line items via GET /:id when editing.
  const cols = `i.id,i.num,i.cust_id,i.user_id,i.type,i.date,i.subtotal,i.disc,i.disc_amt,i.final,i.pay_type,
    i.cheque_duration,i.cheque_due_date,i.cheque_info,i.approved,i.converted,i.note,i.created_at`;
  let rows;
  if (scope === null) {
    rows = db.prepare(`SELECT ${cols},c.biz as cust_biz,c.owner as cust_owner,u.name as salesperson FROM invoices i LEFT JOIN customers c ON i.cust_id=c.id LEFT JOIN users u ON i.user_id=u.id WHERE COALESCE(i.deleted_at,0)=0 ORDER BY i.created_at DESC`).all();
  } else {
    rows = db.prepare(`SELECT ${cols},c.biz as cust_biz,c.owner as cust_owner FROM invoices i LEFT JOIN customers c ON i.cust_id=c.id WHERE i.user_id=? AND COALESCE(i.deleted_at,0)=0 ORDER BY i.created_at DESC`).all(scope);
  }
  res.json(rows);
});

// Export invoices to Excel (must be before /:id to avoid route capture)
router.get('/export/excel', auth, adminOnly, (req, res) => {
  const XLSX = require('xlsx');
  const db = getDB();
  const scope = getScope(req);
  let rows;
  if (scope === null) {
    rows = db.prepare('SELECT i.*,c.biz as cust_biz,u.name as salesperson FROM invoices i LEFT JOIN customers c ON i.cust_id=c.id LEFT JOIN users u ON i.user_id=u.id ORDER BY i.created_at DESC').all();
  } else {
    rows = db.prepare('SELECT i.*,c.biz as cust_biz FROM invoices i LEFT JOIN customers c ON i.cust_id=c.id WHERE i.user_id=? ORDER BY i.created_at DESC').all(scope);
  }
  const data = rows.map(r => ({
    'شماره': r.num || '',
    'مشتری': r.cust_biz || '',
    'نوع': r.type === 'final' ? 'فاکتور رسمی' : 'پیش‌فاکتور',
    'تاریخ': r.date || '',
    'مبلغ کل (ت)': r.subtotal || 0,
    'تخفیف (٪)': r.disc || 0,
    'مبلغ نهایی (ت)': r.final || 0,
    'نوع پرداخت': r.pay_type === 'cheque' ? 'چک' : 'نقد',
    'تأیید شده': r.approved ? 'بله' : 'خیر',
    'کارشناس': r.salesperson || '',
    'یادداشت': r.note || ''
  }));
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(data);
  ws['!cols'] = [12,20,12,12,18,10,18,12,10,15,20].map(w => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, ws, 'فاکتورها');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename=invoices.xlsx');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

router.get('/:id', auth, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT i.*,c.biz as cust_biz,c.owner as cust_owner,c.city as cust_city,c.phone as cust_phone FROM invoices i LEFT JOIN customers c ON i.cust_id=c.id WHERE i.id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  if (req.user.role !== 'admin' && row.user_id !== req.user.id) return res.status(403).json({ error: 'دسترسی ندارید' });
  res.json({ ...row, rows: JSON.parse(row.rows || '[]') });
});

router.post('/', auth, (req, res) => {
  const { cust_id, type, date, note, rows, disc, pay_type, cheque_duration, cheque_due_date, cheque_info } = req.body;
  if (!cust_id) return res.status(400).json({ error: 'مشتری الزامی است' });
  const db = getDB();
  let built;
  const canDiscount = req.user.role === 'admin' || req.user.role === 'accounting';
  try { built = buildRows(db, rows, canDiscount); }
  catch (e) { return res.status(400).json({ error: e.message }); }

  const subtotal = built.subtotal;
  const discPct = parseFloat(disc) || 0;
  const discAmt = Math.round(subtotal * discPct / 100);
  const final = subtotal - discAmt;

  const prefixRow = db.prepare("SELECT value FROM settings WHERE key='invoice_num_prefix'").get();

  // capture seller info from the user record
  const seller = db.prepare('SELECT name,phone FROM users WHERE id=?').get(req.user.id);

  const invType = type || 'proforma';

  // All mutations commit atomically: number allocation, stock deduction,
  // invoice row, customer status, ledger and journal postings.
  let created;
  try {
    created = db.transaction(() => {
      // Sequential global invoice number (prefix configurable in the admin
      // panel), allocated atomically so numbers are never reused after
      // deletions. Offline device builds never allocate official numbers —
      // they issue a clearly-marked provisional one; the real number is
      // assigned by central when the operation syncs.
      const num = isDevice()
        ? ('موقت-' + Date.now().toString(36).toUpperCase())
        : allocateNumber(db, 'invoice', prefixRow?.value || 'T');

      let stockDeducted = 0;
      if (invType === 'final') {
        const stockErr = deductStock(db, built.rows);
        if (stockErr) throw new Error(stockErr);
        stockDeducted = 1;
      }

      const result = db.prepare(
        'INSERT INTO invoices (user_id,cust_id,num,type,date,note,rows,subtotal,disc,disc_amt,final,seller_name,seller_phone,pay_type,cheque_duration,cheque_due_date,cheque_info,stock_deducted,sales_channel,lead_source,campaign) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
      ).run(req.user.id, cust_id, num, invType, date || '', note || '',
            JSON.stringify(built.rows), subtotal, discPct, discAmt, final,
            seller ? seller.name : '', seller ? (seller.phone || '') : '',
            pay_type || 'cash', cheque_duration || '', cheque_due_date || '', cheque_info || '',
            stockDeducted, resolveSalesChannel(req), req.body.lead_source || '', req.body.campaign || '');
      const invId = result.lastInsertRowid;

      if (invType === 'final') {
        // Auto-update customer status to 'active' when a final invoice is issued
        db.prepare("UPDATE customers SET status='active' WHERE id=?").run(cust_id);
        createLedgerEntry(db, {
          customer_id: cust_id, date: date || '', entry_type: 'invoice',
          ref_type: 'invoice', ref_id: invId,
          description: `فاکتور رسمی ${num}`,
          debit: final, credit: 0, user_id: req.user.id
        });
        const recv = receivableAcct(db, cust_id);
        const sales = acct(db, 'coa_sales'), salesDisc = acct(db, 'coa_sales_discount');
        const jLines = [
          { code: recv.code, name: recv.name, debit: final, credit: 0 }
        ];
        if (discAmt > 0) jLines.push({ code: salesDisc.code, name: salesDisc.name, debit: discAmt, credit: 0, description: 'تخفیف فاکتور' });
        jLines.push({ code: sales.code, name: sales.name, debit: 0, credit: subtotal });
        createJournalEntry(db, {
          date: date || '', description: `فاکتور رسمی ${num}`,
          ref_type: 'invoice', ref_id: invId, created_by: req.user.id, lines: jLines
        });
        postCogsVoucher(db, invId, num, date, built.rows, req.user.id, false);
      }

      // Auto-create a 7-day quality follow-up — only if the customer has
      // auto-followup enabled. Central-only: on a device this would duplicate
      // the follow-up central generates when the invoice op is replayed.
      try {
        const cust = isDevice() ? null : db.prepare('SELECT auto_followup FROM customers WHERE id=?').get(cust_id);
        if (!isDevice() && (!cust || cust.auto_followup == null || cust.auto_followup)) {
          const invoiceDate = date || todayJalali();
          const followupDate = addDaysToJalali(invoiceDate, 7);
          const productList = built.rows.map(r => r.name).join('، ') || '-';
          db.prepare(
            'INSERT INTO followups (user_id,cust_id,date,type,subject,note,next_date,status,priority) VALUES (?,?,?,?,?,?,?,?,?)'
          ).run(
            req.user.id, cust_id, invoiceDate,
            '🧾 پیگیری فاکتور',
            'بررسی رضایت از کیفیت کالا',
            `پیگیری پس از فاکتور ${num}\nمحصولات: ${productList}`,
            followupDate, 'open', 'mid'
          );
        }
      } catch (e) {
        console.error('auto-followup error:', e.message);
      }

      return { id: invId };
    })();
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const row = db.prepare('SELECT i.*,c.biz as cust_biz FROM invoices i LEFT JOIN customers c ON i.cust_id=c.id WHERE i.id=?').get(created.id);
  if (!isDevice()) {
    try {
      const cust = db.prepare('SELECT biz FROM customers WHERE id=?').get(cust_id);
      notif.notifyNewInvoice(db, row, cust);
    } catch (e) { console.error('notify invoice:', e.message); }
  }
  res.json({ ...row, rows: JSON.parse(row.rows || '[]') });
});

router.put('/:id', auth, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM invoices WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  if (req.user.role !== 'admin' && row.user_id !== req.user.id) return res.status(403).json({ error: 'دسترسی ندارید' });
  const { cust_id, type, date, note, rows, disc, pay_type, cheque_duration, cheque_due_date, cheque_info, sales_channel, lead_source, campaign } = req.body;
  let built;
  const canDiscount = req.user.role === 'admin' || req.user.role === 'accounting';
  try { built = buildRows(db, rows, canDiscount); }
  catch (e) { return res.status(400).json({ error: e.message }); }
  const subtotal = built.subtotal;
  const discPct = parseFloat(disc) || 0;
  const discAmt = Math.round(subtotal * discPct / 100);
  const final = subtotal - discAmt;

  const newType = type || 'proforma';

  try {
    db.transaction(() => {
      let stockDeducted = row.stock_deducted || 0;
      // Only deduct stock when transitioning TO final for the first time
      if (newType === 'final' && !stockDeducted) {
        const stockErr = deductStock(db, built.rows);
        if (stockErr) throw new Error(stockErr);
        stockDeducted = 1;
      }
      db.prepare('UPDATE invoices SET cust_id=?,type=?,date=?,note=?,rows=?,subtotal=?,disc=?,disc_amt=?,final=?,pay_type=?,cheque_duration=?,cheque_due_date=?,cheque_info=?,stock_deducted=?,sales_channel=?,lead_source=?,campaign=? WHERE id=?')
        .run(cust_id, newType, date || '', note || '', JSON.stringify(built.rows), subtotal, discPct, discAmt, final,
             pay_type || 'cash', cheque_duration || '', cheque_due_date || '', cheque_info || '',
             stockDeducted, resolveSalesChannel(req), lead_source || '', campaign || '', req.params.id);
    })();
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  res.json({ ok: true });
});

router.delete('/:id', auth, requirePermission('invoices', 'delete'), (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM invoices WHERE id=? AND COALESCE(deleted_at,0)=0').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  if (req.user.role !== 'admin' && req.user.role !== 'accounting' && row.user_id !== req.user.id) {
    return res.status(403).json({ error: 'دسترسی ندارید' });
  }

  db.transaction(() => {
    if (row.stock_deducted) {
      const invRows = JSON.parse(row.rows || '[]');
      for (const r of invRows) {
        db.prepare('UPDATE products SET stock=stock+? WHERE id=?').run(r.qty, r.product_id);
        db.prepare('INSERT INTO stock_logs (product_id,user_id,change,note) VALUES (?,?,?,?)').run(
          r.product_id, req.user.id, r.qty, `بازگشت موجودی از حذف فاکتور ${row.num}`
        );
      }
    }

    if (row.type === 'final') {
      createLedgerEntry(db, {
        customer_id: row.cust_id, date: row.date || '', entry_type: 'reversal',
        ref_type: 'invoice', ref_id: row.id,
        description: `ابطال فاکتور ${row.num}`,
        debit: 0, credit: row.final, user_id: req.user.id
      });
      const recv = receivableAcct(db, row.cust_id);
      const sales = acct(db, 'coa_sales'), salesDisc = acct(db, 'coa_sales_discount');
      const jLines = [
        { code: sales.code, name: sales.name, debit: row.subtotal, credit: 0, description: 'ابطال' }
      ];
      if ((row.disc_amt || 0) > 0) jLines.push({ code: salesDisc.code, name: salesDisc.name, debit: 0, credit: row.disc_amt, description: 'ابطال تخفیف' });
      jLines.push({ code: recv.code, name: recv.name, debit: 0, credit: row.final });
      createJournalEntry(db, {
        date: row.date || '', description: `ابطال فاکتور ${row.num}`,
        ref_type: 'invoice_reversal', ref_id: row.id, created_by: req.user.id, lines: jLines
      });
      postCogsVoucher(db, row.id, row.num, row.date, JSON.parse(row.rows || '[]'), req.user.id, true);
    }

    db.prepare('UPDATE invoices SET deleted_at=strftime(\'%s\',\'now\'), deleted_by=? WHERE id=?').run(req.user.id, req.params.id);
  })();
  audit(req.user.id, 'soft_delete', 'invoice', req.params.id, `حذف نرم فاکتور ${row.num}`);
  res.json({ ok: true });
});

// Convert proforma to official invoice (type='final')
router.post('/:id/convert', auth, (req, res) => {
  const db = getDB();
  const inv = db.prepare('SELECT * FROM invoices WHERE id=?').get(req.params.id);
  if (!inv) return res.status(404).json({ error: 'یافت نشد' });
  if (req.user.role !== 'admin' && inv.user_id !== req.user.id) return res.status(403).json({ error: 'دسترسی ندارید' });
  if (inv.converted) return res.status(400).json({ error: 'قبلاً تبدیل شده' });
  if (inv.type === 'final') return res.status(400).json({ error: 'این فاکتور رسمی است' });

  const rows = JSON.parse(inv.rows || '[]');

  try {
    db.transaction(() => {
      // Stock deduction if not already done
      let stockDeducted = inv.stock_deducted || 0;
      if (!stockDeducted) {
        const stockErr = deductStock(db, rows);
        if (stockErr) throw new Error(stockErr);
        stockDeducted = 1;
      }

      db.prepare('UPDATE invoices SET type=?,converted=1,stock_deducted=? WHERE id=?').run('final', stockDeducted, inv.id);
      // Auto-update customer status to 'active' when proforma is converted to final
      db.prepare("UPDATE customers SET status='active' WHERE id=?").run(inv.cust_id);

      // Customer ledger + journal entries on conversion
      createLedgerEntry(db, {
        customer_id: inv.cust_id, date: inv.date || '', entry_type: 'invoice',
        ref_type: 'invoice', ref_id: inv.id,
        description: `تبدیل پیش‌فاکتور ${inv.num} به فاکتور رسمی`,
        debit: inv.final, credit: 0, user_id: req.user.id
      });
      const recv = receivableAcct(db, inv.cust_id);
      const sales = acct(db, 'coa_sales'), salesDisc = acct(db, 'coa_sales_discount');
      const cvLines = [
        { code: recv.code, name: recv.name, debit: inv.final, credit: 0 }
      ];
      if ((inv.disc_amt || 0) > 0) cvLines.push({ code: salesDisc.code, name: salesDisc.name, debit: inv.disc_amt, credit: 0 });
      cvLines.push({ code: sales.code, name: sales.name, debit: 0, credit: inv.subtotal });
      createJournalEntry(db, {
        date: inv.date || '', description: `فاکتور رسمی ${inv.num} (تبدیل از پیش‌فاکتور)`,
        ref_type: 'invoice', ref_id: inv.id, created_by: req.user.id, lines: cvLines
      });
      postCogsVoucher(db, inv.id, inv.num, inv.date, rows, req.user.id, false);
    })();
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  audit(req.user.id, 'convert', 'invoice', inv.id, `تبدیل پیش‌فاکتور ${inv.num} به فاکتور رسمی`);

  res.json({ ok: true });
});

// Standalone printable HTML page
router.get('/:id/print', auth, (req, res) => {
  const db = getDB();
  const inv = db.prepare('SELECT i.*,c.biz as cust_biz,c.owner as cust_owner,c.city as cust_city,c.phone as cust_phone FROM invoices i LEFT JOIN customers c ON i.cust_id=c.id WHERE i.id=?').get(req.params.id);
  if (!inv) return res.status(404).send('فاکتور یافت نشد');
  if (req.user.role !== 'admin' && inv.user_id !== req.user.id) return res.status(403).send('دسترسی ندارید');
  const rows = JSON.parse(inv.rows || '[]');
  const companyName = getSetting(db, 'company_name') || 'پوشاک ترنم';
  const companyAddr = getSetting(db, 'company_address') || '';
  const companyPhone = getSetting(db, 'company_phone') || '';
  const typeLabel = inv.type === 'final' ? 'فاکتور رسمی' : 'پیش‌فاکتور';
  const paperSize = (req.query.paper || 'A4').toUpperCase() === 'A5' ? 'A5' : 'A4';
  // Invoices created offline carry a provisional number until they sync with
  // central — the printout must be visibly non-official.
  const isProvisional = String(inv.num || '').startsWith('موقت');

  const payTypeLabel = inv.pay_type === 'cheque' ? 'چک' : 'نقد';
  let payInfo = `<div><b>نوع پرداخت:</b> ${payTypeLabel}</div>`;
  if (inv.pay_type === 'cheque') {
    if (inv.cheque_duration) payInfo += `<div><b>مدت چک:</b> ${inv.cheque_duration} روز</div>`;
    if (inv.cheque_due_date) payInfo += `<div><b>سررسید:</b> ${inv.cheque_due_date}</div>`;
    if (inv.cheque_info) payInfo += `<div><b>اطلاعات چک:</b> ${inv.cheque_info}</div>`;
  }

  const rowsHtml = rows.map((r, i) => `
    <tr>
      <td>${faNum(i + 1)}</td>
      <td style="text-align:right">${r.name || ''}</td>
      <td>${faNum(r.qty)}</td>
      <td>${faNum(r.price)}</td>
      <td>${faNum(r.sum)}</td>
    </tr>`).join('');

  const sheetMaxWidth = paperSize === 'A5' ? '560px' : '800px';
  const baseFontSize = paperSize === 'A5' ? '11px' : '13px';
  const html = `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${typeLabel} ${inv.num}</title>
<link href="/vendor/vazirmatn/vazirmatn.css" rel="stylesheet">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Vazirmatn',sans-serif;background:#f3f4f6;color:#1f2937;padding:20px;font-size:${baseFontSize}}
  .sheet{max-width:${sheetMaxWidth};margin:0 auto;background:#fff;padding:${paperSize==='A5'?'20px':'34px'};border-radius:8px;box-shadow:0 2px 12px rgba(0,0,0,.08)}
  .head{display:flex;justify-content:space-between;align-items:center;border-bottom:3px solid #1A5C38;padding-bottom:16px;margin-bottom:18px}
  .logo{display:flex;align-items:center;gap:12px}
  .logo img{height:64px}
  .logo .emoji{font-size:46px}
  .logo h1{font-size:22px;color:#1A5C38}
  .logo p{font-size:12px;color:#6b7280;margin-top:4px}
  .meta{text-align:left;font-size:13px;line-height:1.9}
  .meta .num{font-size:18px;font-weight:800;color:#1A5C38}
  .tag{display:inline-block;background:#E8F5EE;color:#1A5C38;padding:4px 12px;border-radius:20px;font-weight:700;font-size:13px}
  .info{display:flex;justify-content:space-between;gap:16px;margin:18px 0;font-size:13px}
  .info .box{flex:1;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:12px 14px;line-height:2}
  .info .box b{color:#1A5C38}
  table{width:100%;border-collapse:collapse;margin-top:8px;font-size:13px}
  th,td{border:1px solid #e5e7eb;padding:9px 8px;text-align:center}
  thead th{background:#1A5C38;color:#fff;font-weight:700}
  tbody tr:nth-child(even){background:#f4f7f5}
  .totals{margin-top:16px;margin-right:auto;width:300px;font-size:14px}
  .totals .line{display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px dashed #e5e7eb}
  .totals .final{font-size:18px;font-weight:800;color:#059669;border:none;padding-top:10px}
  .note{margin-top:18px;font-size:12px;color:#6b7280;background:#f9fafb;border-radius:8px;padding:10px 14px}
  .footer{margin-top:26px;text-align:center;font-size:12px;color:#9ca3af;border-top:1px solid #e5e7eb;padding-top:14px;line-height:2}
  .pbtn{display:block;margin:20px auto 0;background:#1A5C38;color:#fff;border:none;padding:11px 30px;border-radius:8px;font-family:inherit;font-size:14px;cursor:pointer}
  @media print{body{background:#fff;padding:0}.sheet{box-shadow:none;border-radius:0;max-width:100%}.pbtn{display:none}@page{size:${paperSize};margin:10mm}}
</style>
</head>
<body>
  <div class="sheet" style="position:relative">
    ${isProvisional ? `<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;z-index:5">
      <div style="transform:rotate(-25deg);font-size:44px;font-weight:800;color:rgba(220,38,38,.16);border:4px solid rgba(220,38,38,.16);border-radius:14px;padding:10px 30px;white-space:nowrap">پیش‌نویس — در انتظار شماره رسمی</div>
    </div>` : ''}
    <div class="head">
      <div class="logo">
        <img src="/logo-sm.png" onerror="this.src='/logo.png';this.onerror=()=>{this.style.display='none';this.nextElementSibling.style.display='inline'}">
        <span class="emoji" style="display:none">🌸</span>
        <div>
          <h1>${companyName}</h1>
          <p>تولیدی پوشاک زنانه</p>
        </div>
      </div>
      <div class="meta">
        <div class="num">${inv.num || ''}</div>
        <div class="tag">${typeLabel}</div>
        <div>تاریخ: ${inv.date || '-'}</div>
        ${companyPhone ? `<div>تلفن شرکت: ${companyPhone}</div>` : ''}
      </div>
    </div>

    <div class="info">
      <div class="box">
        <div><b>نام فروشگاه:</b> ${inv.cust_biz || '-'}</div>
        <div><b>نام کامل:</b> ${inv.cust_owner || '-'}</div>
        <div><b>شهر:</b> ${inv.cust_city || '-'}</div>
        <div><b>تلفن:</b> ${inv.cust_phone || '-'}</div>
      </div>
      <div class="box">
        <div><b>فروشنده:</b> ${inv.seller_name || '-'}</div>
        <div><b>تلفن فروشنده:</b> ${inv.seller_phone || '-'}</div>
        <div><b>آدرس شرکت:</b> ${companyAddr || '-'}</div>
        ${payInfo}
      </div>
    </div>

    <table>
      <thead>
        <tr><th>ردیف</th><th>شرح کالا</th><th>تعداد</th><th>قیمت واحد (تومان)</th><th>جمع (تومان)</th></tr>
      </thead>
      <tbody>${rowsHtml || '<tr><td colspan="5">بدون ردیف</td></tr>'}</tbody>
    </table>

    <div class="totals">
      <div class="line"><span>جمع کل:</span><span>${faNum(inv.subtotal)} تومان</span></div>
      <div class="line"><span>تخفیف (${faNum(inv.disc)}٪):</span><span>${faNum(inv.disc_amt)} تومان</span></div>
      <div class="line final"><span>مبلغ نهایی:</span><span>${faNum(inv.final)} تومان</span></div>
    </div>

    ${inv.note ? `<div class="note"><b>توضیحات:</b> ${inv.note}</div>` : ''}

    <div class="footer">
      <div>این ${typeLabel} در تاریخ ${inv.date || ''} صادر شده است.</div>
      <div>${companyName} ${companyAddr ? '- ' + companyAddr : ''} ${companyPhone ? '- ' + companyPhone : ''}</div>
    </div>

    <button class="pbtn" onclick="window.print()">چاپ فاکتور 🖨️</button>
  </div>
</body>
</html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

module.exports = router;
