const router = require('express').Router();
const { getDB, audit, createLedgerEntry, createJournalEntry } = require('../db');
const { auth } = require('../middleware/auth');
const { todayJalali, addDaysToJalali } = require('../jalali');

function getScope(req) {
  if (req.user.role === 'admin' && req.query.user_id) return parseInt(req.query.user_id);
  if (req.user.role === 'admin') return null;
  return req.user.id;
}

function getSetting(db, tenantId, key) {
  const r = db.prepare('SELECT value FROM settings WHERE tenant_id=? AND key=?').get(tenantId, key);
  return r ? r.value : '';
}

function faNum(n) {
  return Number(n || 0).toLocaleString('fa-IR');
}

// Validate & normalize invoice rows.
// Price is always editable by both admin and salesperson.
// product_id must be valid and belong to the same tenant.
function buildRows(db, tenantId, inputRows) {
  const out = [];
  let subtotal = 0;
  for (const r of (inputRows || [])) {
    const pid = parseInt(r.product_id);
    if (!pid) throw new Error('هر ردیف باید یک محصول معتبر داشته باشد');
    const prod = db.prepare('SELECT * FROM products WHERE id=? AND tenant_id=?').get(pid, tenantId);
    if (!prod) throw new Error('محصول یافت نشد (شناسه ' + pid + ')');
    const qty = Math.max(1, parseInt(r.qty) || 1);
    // Allow price override by anyone (price always editable)
    let price = prod.price;
    if (r.price !== undefined && r.price !== null && r.price !== '') {
      price = parseFloat(r.price) || 0;
    }
    const sum = qty * price;
    subtotal += sum;
    // mac_cost snapshot at issue time — basis for the COGS journal entry
    out.push({ product_id: pid, name: prod.name, qty, price, sum, mac_cost: prod.mac_cost || prod.cost || 0 });
  }
  return { rows: out, subtotal };
}

// Deduct stock for each row via WMS warehouse issues (MAC-costed).
// Returns error message if aggregate stock is insufficient.
function deductStock(db, tenantId, rows, userId, invoiceDate) {
  const wms = require('../services/wms');
  for (const r of rows) {
    const prod = db.prepare('SELECT * FROM products WHERE id=? AND tenant_id=?').get(r.product_id, tenantId);
    if (!prod) return `محصول شناسه ${r.product_id} یافت نشد`;
    if (prod.stock < r.qty) {
      return `موجودی ${prod.name} کافی نیست (موجود: ${prod.stock})`;
    }
  }
  // All checks passed — issue from warehouses (default first)
  try {
    for (const r of rows) {
      wms.issueForSale(db, {
        tenantId, productId: r.product_id, qty: r.qty,
        note: 'کسر موجودی از فاکتور رسمی', date: invoiceDate || '', userId,
      });
    }
  } catch (e) {
    return e.message;
  }
  return null;
}

// Total cost of goods sold for an invoice's rows at their MAC snapshot
function rowsCOGS(rows) {
  return rows.reduce((a, r) => a + (Number(r.mac_cost) || 0) * (Number(r.qty) || 0), 0);
}

// All accounting entries for issuing a final invoice: receivable/revenue + COGS at MAC
function recordFinalInvoiceAccounting(db, { tenantId, invId, num, date, cust_id, final, subtotal, discAmt, rows, userId, isConversion }) {
  createLedgerEntry(db, {
    tenant_id: tenantId, customer_id: cust_id, date: date || '', entry_type: 'invoice',
    ref_type: 'invoice', ref_id: invId,
    description: isConversion ? `تبدیل پیش‌فاکتور ${num} به فاکتور رسمی` : `فاکتور رسمی ${num}`,
    debit: final, credit: 0, user_id: userId
  });
  const jLines = [
    { code: '1103', name: 'حساب‌های دریافتنی از مشتریان', debit: final, credit: 0 }
  ];
  if (discAmt > 0) jLines.push({ code: '4103', name: 'تخفیفات فروش', debit: discAmt, credit: 0, description: 'تخفیف فاکتور' });
  jLines.push({ code: '4101', name: 'درآمد فروش کالا', debit: 0, credit: subtotal });
  createJournalEntry(db, {
    tenant_id: tenantId, date: date || '',
    description: isConversion ? `فاکتور رسمی ${num} (تبدیل از پیش‌فاکتور)` : `فاکتور رسمی ${num}`,
    ref_type: 'invoice', ref_id: invId, created_by: userId, lines: jLines
  });
  // COGS at moving-average cost: debit 5000, credit inventory 1104
  const cogs = rowsCOGS(rows);
  if (cogs > 0) {
    createJournalEntry(db, {
      tenant_id: tenantId, date: date || '', description: `بهای تمام‌شده فاکتور ${num}`,
      ref_type: 'invoice_cogs', ref_id: invId, created_by: userId,
      lines: [
        { code: '5000', name: 'بهای تمام‌شده کالای فروش رفته', debit: cogs, credit: 0 },
        { code: '1104', name: 'موجودی کالا', debit: 0, credit: cogs }
      ]
    });
  }
}

router.get('/', auth, (req, res) => {
  const db = getDB();
  const scope = getScope(req);
  let rows;
  if (scope === null) {
    rows = db.prepare('SELECT i.*,c.biz as cust_biz,u.name as salesperson FROM invoices i LEFT JOIN customers c ON i.cust_id=c.id LEFT JOIN users u ON i.user_id=u.id WHERE i.tenant_id=? ORDER BY i.created_at DESC').all(req.tenantId);
  } else {
    rows = db.prepare('SELECT i.*,c.biz as cust_biz FROM invoices i LEFT JOIN customers c ON i.cust_id=c.id WHERE i.tenant_id=? AND i.user_id=? ORDER BY i.created_at DESC').all(req.tenantId, scope);
  }
  rows = rows.map(r => ({ ...r, rows: JSON.parse(r.rows || '[]') }));
  res.json(rows);
});

// Export invoices to Excel (must be before /:id to avoid route capture)
router.get('/export/excel', auth, (req, res) => {
  const XLSX = require('xlsx');
  const db = getDB();
  const scope = getScope(req);
  let rows;
  if (scope === null) {
    rows = db.prepare('SELECT i.*,c.biz as cust_biz,u.name as salesperson FROM invoices i LEFT JOIN customers c ON i.cust_id=c.id LEFT JOIN users u ON i.user_id=u.id WHERE i.tenant_id=? ORDER BY i.created_at DESC').all(req.tenantId);
  } else {
    rows = db.prepare('SELECT i.*,c.biz as cust_biz FROM invoices i LEFT JOIN customers c ON i.cust_id=c.id WHERE i.tenant_id=? AND i.user_id=? ORDER BY i.created_at DESC').all(req.tenantId, scope);
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
  const row = db.prepare('SELECT i.*,c.biz as cust_biz,c.owner as cust_owner,c.city as cust_city,c.phone as cust_phone FROM invoices i LEFT JOIN customers c ON i.cust_id=c.id WHERE i.id=? AND i.tenant_id=?').get(req.params.id, req.tenantId);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  if (req.user.role !== 'admin' && row.user_id !== req.user.id) return res.status(403).json({ error: 'دسترسی ندارید' });
  res.json({ ...row, rows: JSON.parse(row.rows || '[]') });
});

router.post('/', auth, (req, res) => {
  const { cust_id, type, date, note, rows, disc, pay_type, cheque_duration, cheque_due_date, cheque_info, client_uuid } = req.body;
  if (!cust_id) return res.status(400).json({ error: 'مشتری الزامی است' });
  const db = getDB();

  // Customer must belong to this tenant
  const cust = db.prepare('SELECT id, auto_followup FROM customers WHERE id=? AND tenant_id=?').get(cust_id, req.tenantId);
  if (!cust) return res.status(404).json({ error: 'مشتری یافت نشد' });

  // Offline-sync idempotency: an invoice with this client_uuid already exists → return it
  if (client_uuid) {
    const existing = db.prepare('SELECT i.*,c.biz as cust_biz FROM invoices i LEFT JOIN customers c ON i.cust_id=c.id WHERE i.tenant_id=? AND i.client_uuid=?').get(req.tenantId, client_uuid);
    if (existing) return res.json({ ...existing, rows: JSON.parse(existing.rows || '[]'), deduped: true });
  }

  let built;
  try { built = buildRows(db, req.tenantId, rows); }
  catch (e) { return res.status(400).json({ error: e.message }); }

  const subtotal = built.subtotal;
  const discPct = parseFloat(disc) || 0;
  const discAmt = Math.round(subtotal * discPct / 100);
  const final = subtotal - discAmt;

  // sequential invoice number — per tenant
  const count = db.prepare('SELECT COUNT(*) as c FROM invoices WHERE tenant_id=?').get(req.tenantId).c;
  const num = 'T-' + String(count + 1).padStart(4, '0');

  // capture seller info from the user record
  const seller = db.prepare('SELECT name,phone FROM users WHERE id=?').get(req.user.id);

  const invType = type || 'proforma';
  let stockDeducted = 0;

  // Stock validation & deduction for final invoices
  if (invType === 'final') {
    const stockErr = deductStock(db, req.tenantId, built.rows, req.user.id, date);
    if (stockErr) return res.status(400).json({ error: stockErr });
    stockDeducted = 1;
  }

  const result = db.prepare(
    'INSERT INTO invoices (tenant_id,user_id,cust_id,num,type,date,note,rows,subtotal,disc,disc_amt,final,seller_name,seller_phone,pay_type,cheque_duration,cheque_due_date,cheque_info,stock_deducted,client_uuid) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(req.tenantId, req.user.id, cust_id, num, invType, date || '', note || '',
        JSON.stringify(built.rows), subtotal, discPct, discAmt, final,
        seller ? seller.name : '', seller ? (seller.phone || '') : '',
        pay_type || 'cash', cheque_duration || '', cheque_due_date || '', cheque_info || '',
        stockDeducted, client_uuid || null);

  // Auto-update customer status to 'active' when a final invoice is issued
  if (invType === 'final') {
    db.prepare("UPDATE customers SET status='active' WHERE id=? AND tenant_id=?").run(cust_id, req.tenantId);
  }

  const row = db.prepare('SELECT i.*,c.biz as cust_biz FROM invoices i LEFT JOIN customers c ON i.cust_id=c.id WHERE i.id=?').get(result.lastInsertRowid);

  // Customer ledger + journal + COGS entries for final invoices
  if (invType === 'final') {
    recordFinalInvoiceAccounting(db, {
      tenantId: req.tenantId, invId: result.lastInsertRowid, num, date, cust_id,
      final, subtotal, discAmt, rows: built.rows, userId: req.user.id, isConversion: false
    });
  }

  // Auto-create a 7-day quality follow-up — only if the customer has auto-followup enabled
  try {
    if (cust.auto_followup == null || cust.auto_followup) {
      const invoiceDate = date || todayJalali();
      const followupDate = addDaysToJalali(invoiceDate, 7);
      const productList = built.rows.map(r => r.name).join('، ') || '-';
      db.prepare(
        'INSERT INTO followups (tenant_id,user_id,cust_id,date,type,subject,note,next_date,status,priority) VALUES (?,?,?,?,?,?,?,?,?,?)'
      ).run(
        req.tenantId, req.user.id, cust_id, invoiceDate,
        '🧾 پیگیری فاکتور',
        'بررسی رضایت از کیفیت کالا',
        `پیگیری پس از فاکتور ${num}\nمحصولات: ${productList}`,
        followupDate, 'open', 'mid'
      );
    }
  } catch (e) {
    console.error('auto-followup error:', e.message);
  }

  res.json({ ...row, rows: JSON.parse(row.rows || '[]') });
});

router.put('/:id', auth, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM invoices WHERE id=? AND tenant_id=?').get(req.params.id, req.tenantId);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  if (req.user.role !== 'admin' && row.user_id !== req.user.id) return res.status(403).json({ error: 'دسترسی ندارید' });
  const { cust_id, type, date, note, rows, disc, pay_type, cheque_duration, cheque_due_date, cheque_info } = req.body;
  const cust = db.prepare('SELECT id FROM customers WHERE id=? AND tenant_id=?').get(cust_id, req.tenantId);
  if (!cust) return res.status(404).json({ error: 'مشتری یافت نشد' });
  let built;
  try { built = buildRows(db, req.tenantId, rows); }
  catch (e) { return res.status(400).json({ error: e.message }); }
  const subtotal = built.subtotal;
  const discPct = parseFloat(disc) || 0;
  const discAmt = Math.round(subtotal * discPct / 100);
  const final = subtotal - discAmt;

  const newType = type || 'proforma';
  let stockDeducted = row.stock_deducted || 0;

  // Only deduct stock when transitioning TO final for the first time
  if (newType === 'final' && !stockDeducted) {
    const stockErr = deductStock(db, req.tenantId, built.rows, req.user.id, date);
    if (stockErr) return res.status(400).json({ error: stockErr });
    stockDeducted = 1;
    // First transition to final via edit also gets full accounting entries
    recordFinalInvoiceAccounting(db, {
      tenantId: req.tenantId, invId: row.id, num: row.num, date: date || row.date, cust_id,
      final, subtotal, discAmt, rows: built.rows, userId: req.user.id, isConversion: false
    });
    db.prepare("UPDATE customers SET status='active' WHERE id=? AND tenant_id=?").run(cust_id, req.tenantId);
  }

  db.prepare('UPDATE invoices SET cust_id=?,type=?,date=?,note=?,rows=?,subtotal=?,disc=?,disc_amt=?,final=?,pay_type=?,cheque_duration=?,cheque_due_date=?,cheque_info=?,stock_deducted=? WHERE id=? AND tenant_id=?')
    .run(cust_id, newType, date || '', note || '', JSON.stringify(built.rows), subtotal, discPct, discAmt, final,
         pay_type || 'cash', cheque_duration || '', cheque_due_date || '', cheque_info || '',
         stockDeducted, req.params.id, req.tenantId);
  res.json({ ok: true });
});

router.delete('/:id', auth, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM invoices WHERE id=? AND tenant_id=?').get(req.params.id, req.tenantId);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  if (req.user.role !== 'admin' && row.user_id !== req.user.id) return res.status(403).json({ error: 'دسترسی ندارید' });

  // Restore inventory when a final invoice with deducted stock is deleted
  if (row.stock_deducted) {
    const wms = require('../services/wms');
    const invRows = JSON.parse(row.rows || '[]');
    for (const r of invRows) {
      try {
        wms.restoreForSale(db, {
          tenantId: req.tenantId, productId: r.product_id, qty: r.qty, refId: row.id,
          note: `بازگشت موجودی از حذف فاکتور ${row.num}`, date: row.date || '', userId: req.user.id,
        });
      } catch (e) { console.error('stock restore error:', e.message); }
    }
  }

  // Reverse ledger + journal entries for deleted final invoices
  if (row.type === 'final') {
    createLedgerEntry(db, {
      tenant_id: req.tenantId, customer_id: row.cust_id, date: row.date || '', entry_type: 'reversal',
      ref_type: 'invoice', ref_id: row.id,
      description: `ابطال فاکتور ${row.num}`,
      debit: 0, credit: row.final, user_id: req.user.id
    });
    const jLines = [
      { code: '4101', name: 'درآمد فروش کالا', debit: row.subtotal, credit: 0, description: 'ابطال' }
    ];
    if ((row.disc_amt || 0) > 0) jLines.push({ code: '4103', name: 'تخفیفات فروش', debit: 0, credit: row.disc_amt, description: 'ابطال تخفیف' });
    jLines.push({ code: '1103', name: 'حساب‌های دریافتنی از مشتریان', debit: 0, credit: row.final });
    createJournalEntry(db, {
      tenant_id: req.tenantId, date: row.date || '', description: `ابطال فاکتور ${row.num}`,
      ref_type: 'invoice_reversal', ref_id: row.id, created_by: req.user.id, lines: jLines
    });
    // Reverse the COGS entry (restores inventory value)
    const invRows = JSON.parse(row.rows || '[]');
    const cogs = rowsCOGS(invRows);
    if (cogs > 0) {
      createJournalEntry(db, {
        tenant_id: req.tenantId, date: row.date || '', description: `ابطال بهای تمام‌شده فاکتور ${row.num}`,
        ref_type: 'invoice_cogs_reversal', ref_id: row.id, created_by: req.user.id,
        lines: [
          { code: '1104', name: 'موجودی کالا', debit: cogs, credit: 0 },
          { code: '5000', name: 'بهای تمام‌شده کالای فروش رفته', debit: 0, credit: cogs }
        ]
      });
    }
  }

  db.prepare('DELETE FROM invoices WHERE id=? AND tenant_id=?').run(req.params.id, req.tenantId);
  audit(req.tenantId, req.user.id, 'delete', 'invoice', req.params.id, `حذف فاکتور ${row.num}`, req.ip);
  res.json({ ok: true });
});

// Convert proforma to official invoice (type='final')
router.post('/:id/convert', auth, (req, res) => {
  const db = getDB();
  const inv = db.prepare('SELECT * FROM invoices WHERE id=? AND tenant_id=?').get(req.params.id, req.tenantId);
  if (!inv) return res.status(404).json({ error: 'یافت نشد' });
  if (req.user.role !== 'admin' && inv.user_id !== req.user.id) return res.status(403).json({ error: 'دسترسی ندارید' });
  if (inv.converted) return res.status(400).json({ error: 'قبلاً تبدیل شده' });
  if (inv.type === 'final') return res.status(400).json({ error: 'این فاکتور رسمی است' });

  const rows = JSON.parse(inv.rows || '[]');

  // Stock deduction if not already done
  let stockDeducted = inv.stock_deducted || 0;
  if (!stockDeducted) {
    const stockErr = deductStock(db, req.tenantId, rows, req.user.id, inv.date);
    if (stockErr) return res.status(400).json({ error: stockErr });
    stockDeducted = 1;
  }

  db.prepare('UPDATE invoices SET type=?,converted=1,stock_deducted=? WHERE id=? AND tenant_id=?').run('final', stockDeducted, inv.id, req.tenantId);
  // Auto-update customer status to 'active' when proforma is converted to final
  db.prepare("UPDATE customers SET status='active' WHERE id=? AND tenant_id=?").run(inv.cust_id, req.tenantId);
  audit(req.tenantId, req.user.id, 'convert', 'invoice', inv.id, `تبدیل پیش‌فاکتور ${inv.num} به فاکتور رسمی`, req.ip);

  // Customer ledger + journal + COGS entries on conversion
  recordFinalInvoiceAccounting(db, {
    tenantId: req.tenantId, invId: inv.id, num: inv.num, date: inv.date, cust_id: inv.cust_id,
    final: inv.final, subtotal: inv.subtotal, discAmt: inv.disc_amt || 0, rows, userId: req.user.id, isConversion: true
  });

  res.json({ ok: true });
});

// Server-generated PDF — cached on disk, regenerated with ?fresh=1
router.get('/:id/pdf', auth, async (req, res) => {
  const db = getDB();
  const inv = db.prepare('SELECT i.*,c.biz as cust_biz,c.owner as cust_owner,c.city as cust_city,c.phone as cust_phone FROM invoices i LEFT JOIN customers c ON i.cust_id=c.id WHERE i.id=? AND i.tenant_id=?').get(req.params.id, req.tenantId);
  if (!inv) return res.status(404).json({ error: 'فاکتور یافت نشد' });
  if (req.user.role !== 'admin' && inv.user_id !== req.user.id) return res.status(403).json({ error: 'دسترسی ندارید' });
  const pdfService = require('../services/pdf');
  const path = require('path');
  const fs = require('fs');
  const paper = (req.query.paper || 'A4').toUpperCase() === 'A5' ? 'A5' : 'A4';
  const filename = `inv-${req.tenantId}-${inv.id}-${paper}.pdf`;
  const filePath = path.join(pdfService.PDF_DIR, filename);
  try {
    if (req.query.fresh === '1' || !fs.existsSync(filePath)) {
      const html = renderInvoiceHTML(db, req.tenantId, inv, paper);
      await pdfService.renderToFile(html, filename, { format: paper });
      db.prepare('UPDATE invoices SET pdf_url=? WHERE id=?').run('/uploads/pdfs/' + filename, inv.id);
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename=invoice-${(inv.num || inv.id).toString().replace(/[^\w-]/g, '')}.pdf`);
    res.send(fs.readFileSync(filePath));
  } catch (e) {
    console.error('invoice pdf error:', e.message);
    res.status(500).json({ error: 'خطا در تولید PDF: ' + e.message });
  }
});

// Standalone printable HTML page
router.get('/:id/print', auth, (req, res) => {
  const db = getDB();
  const inv = db.prepare('SELECT i.*,c.biz as cust_biz,c.owner as cust_owner,c.city as cust_city,c.phone as cust_phone FROM invoices i LEFT JOIN customers c ON i.cust_id=c.id WHERE i.id=? AND i.tenant_id=?').get(req.params.id, req.tenantId);
  if (!inv) return res.status(404).send('فاکتور یافت نشد');
  if (req.user.role !== 'admin' && inv.user_id !== req.user.id) return res.status(403).send('دسترسی ندارید');
  const html = renderInvoiceHTML(db, req.tenantId, inv, (req.query.paper || 'A4'));
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

// Shared invoice HTML renderer — used by /print (browser) and the PDF worker (Puppeteer)
function renderInvoiceHTML(db, tenantId, inv, paper) {
  const rows = JSON.parse(inv.rows || '[]');
  const companyName = getSetting(db, tenantId, 'company_name') || 'پوشاک ترنم';
  const companyAddr = getSetting(db, tenantId, 'company_address') || '';
  const companyPhone = getSetting(db, tenantId, 'company_phone') || '';
  const typeLabel = inv.type === 'final' ? 'فاکتور رسمی' : 'پیش‌فاکتور';
  const paperSize = String(paper).toUpperCase() === 'A5' ? 'A5' : 'A4';

  const payTypeLabel = inv.pay_type === 'cheque' ? 'چک' : 'نقد';
  let payInfo = `<div><b>نوع پرداخت:</b> ${payTypeLabel}</div>`;
  if (inv.pay_type === 'cheque') {
    if (inv.cheque_duration) payInfo += `<div><b>مدت چک:</b> ${inv.cheque_duration} روز</div>`;
    if (inv.cheque_due_date) payInfo += `<div><b>سررسید:</b> ${inv.cheque_due_date}</div>`;
    if (inv.cheque_info) payInfo += `<div><b>اطلاعات چک:</b> ${inv.cheque_info}</div>`;
  }

  // Moadian tax ID + QR (filled by the e-invoice module once the submission is confirmed)
  let einvoiceBlock = '';
  try {
    const sub = db.prepare("SELECT tax_id FROM einvoice_submissions WHERE invoice_id=? AND status='confirmed' ORDER BY id DESC LIMIT 1").get(inv.id);
    if (sub && sub.tax_id) {
      einvoiceBlock = `<div class="einv"><b>شناسه مالیاتی مودیان:</b> ${sub.tax_id}</div>`;
    }
  } catch { /* einvoice table may not exist yet */ }

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
  return `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${typeLabel} ${inv.num}</title>
<link href="https://fonts.googleapis.com/css2?family=Vazirmatn:wght@400;500;700;800&display=swap" rel="stylesheet">
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
  .einv{margin-top:12px;font-size:12px;background:#FDF6E3;border:1px solid #C9A227;border-radius:8px;padding:8px 14px}
  .footer{margin-top:26px;text-align:center;font-size:12px;color:#9ca3af;border-top:1px solid #e5e7eb;padding-top:14px;line-height:2}
  .pbtn{display:block;margin:20px auto 0;background:#1A5C38;color:#fff;border:none;padding:11px 30px;border-radius:8px;font-family:inherit;font-size:14px;cursor:pointer}
  @media print{body{background:#fff;padding:0}.sheet{box-shadow:none;border-radius:0;max-width:100%}.pbtn{display:none}@page{size:${paperSize};margin:10mm}}
</style>
</head>
<body>
  <div class="sheet">
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
    ${einvoiceBlock}

    <div class="footer">
      <div>این ${typeLabel} در تاریخ ${inv.date || ''} صادر شده است.</div>
      <div>${companyName} ${companyAddr ? '- ' + companyAddr : ''} ${companyPhone ? '- ' + companyPhone : ''}</div>
    </div>

    <button class="pbtn" onclick="window.print()">چاپ فاکتور 🖨️</button>
  </div>
</body>
</html>`;
}

module.exports = router;
module.exports.renderInvoiceHTML = renderInvoiceHTML;
