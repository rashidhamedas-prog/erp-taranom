const router = require('express').Router();
const { getDB, audit, createJournalEntry, resolveCashAccount, allocateNumber } = require('../db');
const { auth, adminOrAccounting } = require('../middleware/auth');
const { todayJalali } = require('../jalali');

// Create a supplier ledger entry (debit = we owe less / paid, credit = we owe more / purchased)
function createSupplierLedgerEntry(db, { supplier_id, date, entry_type, ref_type, ref_id, description, debit, credit, user_id }) {
  try {
    db.prepare('INSERT INTO supplier_ledger (supplier_id,date,entry_type,ref_type,ref_id,description,debit,credit,user_id) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(supplier_id, date || '', entry_type, ref_type || '', ref_id || null, description || '', debit || 0, credit || 0, user_id || null);
  } catch (e) {
    if (db.inTransaction) throw e;
    console.error('supplier ledger entry error:', e.message);
  }
}

function buildRows(db, inputRows) {
  const out = [];
  let subtotal = 0;
  for (const r of (inputRows || [])) {
    const pid = parseInt(r.product_id);
    if (!pid) throw new Error('هر ردیف باید یک محصول معتبر داشته باشد');
    const prod = db.prepare('SELECT * FROM products WHERE id=?').get(pid);
    if (!prod) throw new Error('محصول یافت نشد (شناسه ' + pid + ')');
    const qty = Math.max(1, parseInt(r.qty) || 1);
    const price = (r.price !== undefined && r.price !== null && r.price !== '') ? (parseFloat(r.price) || 0) : (prod.cost || 0);
    const sum = qty * price;
    subtotal += sum;
    out.push({ product_id: pid, name: prod.name, qty, price, sum });
  }
  return { rows: out, subtotal };
}

// ---------------- Purchase invoices ----------------

router.get('/', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const rows = db.prepare(`
    SELECT p.*, s.name as supplier_name, u.name as recorder
    FROM purchase_invoices p LEFT JOIN suppliers s ON p.supplier_id=s.id LEFT JOIN users u ON p.user_id=u.id
    ORDER BY p.created_at DESC
  `).all();
  res.json(rows.map(r => ({ ...r, rows: JSON.parse(r.rows || '[]') })));
});

router.get('/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT p.*, s.name as supplier_name FROM purchase_invoices p LEFT JOIN suppliers s ON p.supplier_id=s.id WHERE p.id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  res.json({ ...row, rows: JSON.parse(row.rows || '[]') });
});

router.post('/', auth, adminOrAccounting, (req, res) => {
  const { supplier_id, date, note, rows, disc, pay_type, bank_id, check_category_id, cash_box_id } = req.body;
  if (!supplier_id) return res.status(400).json({ error: 'تأمین‌کننده الزامی است' });
  const db = getDB();
  let built;
  try { built = buildRows(db, rows); }
  catch (e) { return res.status(400).json({ error: e.message }); }

  const subtotal = built.subtotal;
  const discPct = parseFloat(disc) || 0;
  const discAmt = Math.round(subtotal * discPct / 100);
  const final = subtotal - discAmt;
  const prefixRow = db.prepare("SELECT value FROM settings WHERE key='purchase_num_prefix'").get();
  const pType = pay_type || 'credit';

  // All mutations commit atomically: number allocation, purchase row,
  // stock increase, supplier ledger and journal postings.
  const { invId, num } = db.transaction(() => {
    const num = allocateNumber(db, 'purchase', prefixRow?.value || 'PO');
    const result = db.prepare(
      'INSERT INTO purchase_invoices (user_id,supplier_id,num,date,note,rows,subtotal,disc,disc_amt,final,pay_type,stock_added,bank_id,check_category_id,cash_box_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,?,?)'
    ).run(req.user.id, supplier_id, num, date || '', note || '', JSON.stringify(built.rows), subtotal, discPct, discAmt, final, pType, bank_id || null, check_category_id || null, cash_box_id || null);
    const invId = result.lastInsertRowid;

    // Stock increases immediately on purchase
    for (const r of built.rows) {
      db.prepare('UPDATE products SET stock=stock+? WHERE id=?').run(r.qty, r.product_id);
      db.prepare('INSERT INTO stock_logs (product_id,user_id,change,note) VALUES (?,?,?,?)').run(r.product_id, req.user.id, r.qty, `افزودن موجودی از فاکتور خرید ${num}`);
    }

    // Supplier ledger: credit = we now owe the supplier (only tracked for on-account purchases)
    if (pType === 'credit') {
      createSupplierLedgerEntry(db, {
        supplier_id, date: date || '', entry_type: 'purchase', ref_type: 'purchase', ref_id: invId,
        description: `فاکتور خرید ${num}`, debit: 0, credit: final, user_id: req.user.id
      });
    }

    // Journal: Dr Inventory / Cr Payable (credit) or Cr Cash/specific bank (cash/cheque)
    const cr = pType === 'credit' ? { code: '2101', name: 'حساب‌های پرداختنی' } : resolveCashAccount(db, pType, bank_id, cash_box_id);
    createJournalEntry(db, {
      date: date || '', description: `فاکتور خرید ${num}`, ref_type: 'purchase', ref_id: invId, created_by: req.user.id,
      lines: [
        { code: '1104', name: 'موجودی کالا', debit: final, credit: 0 },
        { code: cr.code, name: cr.name, debit: 0, credit: final }
      ]
    });
    return { invId, num };
  })();

  audit(req.user.id, 'create', 'purchase', invId, `ثبت فاکتور خرید ${num} به مبلغ ${final}`);
  res.json(db.prepare('SELECT p.*, s.name as supplier_name FROM purchase_invoices p LEFT JOIN suppliers s ON p.supplier_id=s.id WHERE p.id=?').get(invId));
});

router.delete('/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM purchase_invoices WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });

  db.transaction(() => {
    if (row.stock_added) {
      const invRows = JSON.parse(row.rows || '[]');
      for (const r of invRows) {
        db.prepare('UPDATE products SET stock=stock-? WHERE id=?').run(r.qty, r.product_id);
        db.prepare('INSERT INTO stock_logs (product_id,user_id,change,note) VALUES (?,?,?,?)').run(r.product_id, req.user.id, -r.qty, `بازگشت موجودی از حذف فاکتور خرید ${row.num}`);
      }
    }
    if (row.pay_type === 'credit') {
      createSupplierLedgerEntry(db, {
        supplier_id: row.supplier_id, date: row.date || '', entry_type: 'reversal', ref_type: 'purchase', ref_id: row.id,
        description: `ابطال فاکتور خرید ${row.num}`, debit: row.final, credit: 0, user_id: req.user.id
      });
    }
    const cr = row.pay_type === 'credit' ? { code: '2101', name: 'حساب‌های پرداختنی' } : resolveCashAccount(db, row.pay_type, row.bank_id, row.cash_box_id);
    createJournalEntry(db, {
      date: row.date || '', description: `ابطال فاکتور خرید ${row.num}`, ref_type: 'purchase_reversal', ref_id: row.id, created_by: req.user.id,
      lines: [
        { code: cr.code, name: cr.name, debit: row.final, credit: 0 },
        { code: '1104', name: 'موجودی کالا', debit: 0, credit: row.final }
      ]
    });

    db.prepare('DELETE FROM purchase_invoices WHERE id=?').run(req.params.id);
  })();
  audit(req.user.id, 'delete', 'purchase', req.params.id, `حذف فاکتور خرید ${row.num}`);
  res.json({ ok: true });
});

// ---------------- Purchase returns ----------------

router.get('/returns/list', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const rows = db.prepare(`
    SELECT pr.*, s.name as supplier_name FROM purchase_returns pr
    LEFT JOIN suppliers s ON pr.supplier_id=s.id ORDER BY pr.created_at DESC
  `).all();
  res.json(rows.map(r => ({ ...r, rows: JSON.parse(r.rows || '[]') })));
});

// Invoice-linked return picker — mirrors /accounting/sales-returns/available/:id
router.get('/returns/available/:invoiceId', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const inv = db.prepare('SELECT p.*,s.name as supplier_name FROM purchase_invoices p LEFT JOIN suppliers s ON p.supplier_id=s.id WHERE p.id=?').get(req.params.invoiceId);
  if (!inv) return res.status(404).json({ error: 'فاکتور خرید یافت نشد' });
  const invRows = JSON.parse(inv.rows || '[]');
  const alreadyReturned = {};
  db.prepare('SELECT rows FROM purchase_returns WHERE purchase_invoice_id=?').all(req.params.invoiceId).forEach(pr => {
    JSON.parse(pr.rows || '[]').forEach(r => { alreadyReturned[r.product_id] = (alreadyReturned[r.product_id] || 0) + r.qty; });
  });
  const rows = invRows.map(r => ({
    ...r, already_returned: alreadyReturned[r.product_id] || 0,
    max_returnable: r.qty - (alreadyReturned[r.product_id] || 0)
  })).filter(r => r.max_returnable > 0);
  res.json({ invoice: inv, rows });
});

router.post('/returns', auth, adminOrAccounting, (req, res) => {
  const { supplier_id, purchase_invoice_id, date, note, rows } = req.body;
  if (!supplier_id) return res.status(400).json({ error: 'تأمین‌کننده الزامی است' });
  const db = getDB();

  // Invoice-linked return: original price is always taken from the invoice
  // itself, and returned quantity per product is capped at what's still
  // returnable (original qty minus whatever has already been returned).
  let invoiceLineMap = null, alreadyReturnedMap = {};
  if (purchase_invoice_id) {
    const inv = db.prepare('SELECT * FROM purchase_invoices WHERE id=? AND supplier_id=?').get(purchase_invoice_id, supplier_id);
    if (!inv) return res.status(400).json({ error: 'فاکتور خرید یافت نشد یا متعلق به این تأمین‌کننده نیست' });
    invoiceLineMap = {};
    JSON.parse(inv.rows || '[]').forEach(r => { invoiceLineMap[r.product_id] = r; });
    db.prepare('SELECT rows FROM purchase_returns WHERE purchase_invoice_id=?').all(purchase_invoice_id).forEach(pr => {
      JSON.parse(pr.rows || '[]').forEach(r => { alreadyReturnedMap[r.product_id] = (alreadyReturnedMap[r.product_id] || 0) + r.qty; });
    });
  }

  let built;
  if (invoiceLineMap) {
    built = { rows: [], subtotal: 0 };
    for (const r of (rows || [])) {
      const pid = parseInt(r.product_id);
      const prod = db.prepare('SELECT * FROM products WHERE id=?').get(pid);
      if (!prod) return res.status(400).json({ error: `محصول یافت نشد (شناسه ${pid})` });
      const origLine = invoiceLineMap[pid];
      if (!origLine) return res.status(400).json({ error: `کالای ${prod.name} در این فاکتور خرید وجود ندارد` });
      const already = alreadyReturnedMap[pid] || 0;
      const maxReturnable = origLine.qty - already;
      const qty = Math.max(1, parseInt(r.qty) || 1);
      if (qty > maxReturnable) return res.status(400).json({ error: `حداکثر مقدار قابل برگشت برای ${prod.name}: ${maxReturnable}` });
      const price = origLine.price;
      const sum = qty * price;
      built.rows.push({ product_id: pid, name: prod.name, qty, price, sum });
      built.subtotal += sum;
    }
    if (!built.rows.length) return res.status(400).json({ error: 'حداقل یک ردیف لازم است' });
  } else {
    try { built = buildRows(db, rows); }
    catch (e) { return res.status(400).json({ error: e.message }); }
    if (!built.rows.length) return res.status(400).json({ error: 'حداقل یک ردیف لازم است' });
  }

  const amount = built.subtotal;
  const retId = db.transaction(() => {
    const result = db.prepare(
      'INSERT INTO purchase_returns (user_id,supplier_id,purchase_invoice_id,date,note,rows,amount) VALUES (?,?,?,?,?,?,?)'
    ).run(req.user.id, supplier_id, purchase_invoice_id || null, date || todayJalali(), note || '', JSON.stringify(built.rows), amount);
    const retId = result.lastInsertRowid;

    // Returned goods leave inventory
    for (const r of built.rows) {
      db.prepare('UPDATE products SET stock=stock-? WHERE id=?').run(r.qty, r.product_id);
      db.prepare('INSERT INTO stock_logs (product_id,user_id,change,note) VALUES (?,?,?,?)').run(r.product_id, req.user.id, -r.qty, `برگشت از خرید #${retId}`);
    }

    createSupplierLedgerEntry(db, {
      supplier_id, date: date || todayJalali(), entry_type: 'purchase_return', ref_type: 'purchase_return', ref_id: retId,
      description: `برگشت از خرید #${retId}`, debit: amount, credit: 0, user_id: req.user.id
    });
    createJournalEntry(db, {
      date: date || todayJalali(), description: `برگشت از خرید #${retId}`, ref_type: 'purchase_return', ref_id: retId, created_by: req.user.id,
      lines: [
        { code: '2101', name: 'حساب‌های پرداختنی', debit: amount, credit: 0 },
        { code: '1104', name: 'موجودی کالا', debit: 0, credit: amount }
      ]
    });
    return retId;
  })();

  audit(req.user.id, 'create', 'purchase_return', retId, `برگشت از خرید به مبلغ ${amount}`);
  res.json({ id: retId, ok: true });
});

router.delete('/returns/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM purchase_returns WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  db.transaction(() => {
    const invRows = JSON.parse(row.rows || '[]');
    for (const r of invRows) {
      db.prepare('UPDATE products SET stock=stock+? WHERE id=?').run(r.qty, r.product_id);
      db.prepare('INSERT INTO stock_logs (product_id,user_id,change,note) VALUES (?,?,?,?)').run(r.product_id, req.user.id, r.qty, `ابطال برگشت از خرید #${row.id}`);
    }
    createSupplierLedgerEntry(db, {
      supplier_id: row.supplier_id, date: row.date || '', entry_type: 'reversal', ref_type: 'purchase_return', ref_id: row.id,
      description: `ابطال برگشت از خرید #${row.id}`, debit: 0, credit: row.amount, user_id: req.user.id
    });
    createJournalEntry(db, {
      date: row.date || '', description: `ابطال برگشت از خرید #${row.id}`, ref_type: 'purchase_return_reversal', ref_id: row.id, created_by: req.user.id,
      lines: [
        { code: '1104', name: 'موجودی کالا', debit: row.amount, credit: 0 },
        { code: '2101', name: 'حساب‌های پرداختنی', debit: 0, credit: row.amount }
      ]
    });
    db.prepare('DELETE FROM purchase_returns WHERE id=?').run(req.params.id);
  })();
  res.json({ ok: true });
});

// ---------------- Supplier payments (mirrors customer settlements) ----------------

router.get('/payments/list', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const rows = db.prepare(`
    SELECT sp.*, s.name as supplier_name FROM supplier_payments sp
    LEFT JOIN suppliers s ON sp.supplier_id=s.id ORDER BY sp.created_at DESC LIMIT 300
  `).all();
  res.json(rows);
});

router.post('/payments', auth, adminOrAccounting, (req, res) => {
  const { supplier_id, purchase_invoice_id, amount, pay_type, date, note, bank_id, check_category_id, cash_box_id } = req.body;
  if (!supplier_id || !amount) return res.status(400).json({ error: 'تأمین‌کننده و مبلغ الزامی است' });
  const db = getDB();
  const payId = db.transaction(() => {
    const result = db.prepare(
      'INSERT INTO supplier_payments (supplier_id,purchase_invoice_id,amount,pay_type,date,note,created_by,bank_id,check_category_id,cash_box_id) VALUES (?,?,?,?,?,?,?,?,?,?)'
    ).run(supplier_id, purchase_invoice_id || null, parseFloat(amount), pay_type || 'cash', date || todayJalali(), note || '', req.user.id, bank_id || null, check_category_id || null, cash_box_id || null);
    const payId = result.lastInsertRowid;

    createSupplierLedgerEntry(db, {
      supplier_id, date: date || todayJalali(), entry_type: 'payment', ref_type: 'supplier_payment', ref_id: payId,
      description: `پرداخت به تأمین‌کننده — ${Number(amount).toLocaleString('fa-IR')} تومان`, debit: parseFloat(amount), credit: 0, user_id: req.user.id
    });
    const cash = resolveCashAccount(db, pay_type || 'cash', bank_id, cash_box_id);
    createJournalEntry(db, {
      date: date || todayJalali(), description: 'پرداخت به تأمین‌کننده', ref_type: 'supplier_payment', ref_id: payId, created_by: req.user.id,
      lines: [
        { code: '2101', name: 'حساب‌های پرداختنی', debit: parseFloat(amount), credit: 0 },
        { code: cash.code, name: cash.name, debit: 0, credit: parseFloat(amount) }
      ]
    });
    return payId;
  })();

  audit(req.user.id, 'create', 'supplier_payment', payId, `پرداخت ${amount} تومان به تأمین‌کننده`);
  res.json({ id: payId, ok: true });
});

router.delete('/payments/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM supplier_payments WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  db.transaction(() => {
    createSupplierLedgerEntry(db, {
      supplier_id: row.supplier_id, date: row.date || '', entry_type: 'reversal', ref_type: 'supplier_payment', ref_id: row.id,
      description: `ابطال پرداخت #${row.id}`, debit: 0, credit: row.amount, user_id: req.user.id
    });
    const cash = resolveCashAccount(db, row.pay_type, row.bank_id, row.cash_box_id);
    createJournalEntry(db, {
      date: row.date || '', description: `ابطال پرداخت به تأمین‌کننده #${row.id}`, ref_type: 'supplier_payment_reversal', ref_id: row.id, created_by: req.user.id,
      lines: [
        { code: cash.code, name: cash.name, debit: row.amount, credit: 0 },
        { code: '2101', name: 'حساب‌های پرداختنی', debit: 0, credit: row.amount }
      ]
    });
    db.prepare('DELETE FROM supplier_payments WHERE id=?').run(req.params.id);
  })();
  res.json({ ok: true });
});

// Supplier ledger (statement) — mirrors /accounting/ledger/:customerId
router.get('/ledger/:supplierId', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const supplier = db.prepare('SELECT id,name,phone FROM suppliers WHERE id=?').get(req.params.supplierId);
  if (!supplier) return res.status(404).json({ error: 'تأمین‌کننده یافت نشد' });
  const entries = db.prepare(`
    SELECT sl.*, u.name as user_name FROM supplier_ledger sl LEFT JOIN users u ON sl.user_id=u.id
    WHERE sl.supplier_id=? ORDER BY sl.created_at ASC, sl.id ASC
  `).all(req.params.supplierId);
  let balance = 0;
  entries.forEach(e => { balance += (e.credit || 0) - (e.debit || 0); e.running_balance = balance; });
  res.json({ supplier, entries, balance });
});

module.exports = router;
