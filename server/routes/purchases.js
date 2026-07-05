const router = require('express').Router();
const { getDB, audit, createJournalEntry } = require('../db');
const { auth, adminOrAccounting } = require('../middleware/auth');
const { todayJalali } = require('../jalali');

// Create a supplier ledger entry (debit = we owe less / paid, credit = we owe more / purchased)
function createSupplierLedgerEntry(db, { supplier_id, date, entry_type, ref_type, ref_id, description, debit, credit, user_id }) {
  try {
    db.prepare('INSERT INTO supplier_ledger (supplier_id,date,entry_type,ref_type,ref_id,description,debit,credit,user_id) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(supplier_id, date || '', entry_type, ref_type || '', ref_id || null, description || '', debit || 0, credit || 0, user_id || null);
  } catch (e) { console.error('supplier ledger entry error:', e.message); }
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
  const { supplier_id, date, note, rows, disc, pay_type } = req.body;
  if (!supplier_id) return res.status(400).json({ error: 'تأمین‌کننده الزامی است' });
  const db = getDB();
  let built;
  try { built = buildRows(db, rows); }
  catch (e) { return res.status(400).json({ error: e.message }); }

  const subtotal = built.subtotal;
  const discPct = parseFloat(disc) || 0;
  const discAmt = Math.round(subtotal * discPct / 100);
  const final = subtotal - discAmt;
  const count = db.prepare('SELECT COUNT(*) c FROM purchase_invoices').get().c;
  const num = 'PO-' + String(count + 1).padStart(4, '0');
  const pType = pay_type || 'credit';

  const result = db.prepare(
    'INSERT INTO purchase_invoices (user_id,supplier_id,num,date,note,rows,subtotal,disc,disc_amt,final,pay_type,stock_added) VALUES (?,?,?,?,?,?,?,?,?,?,?,1)'
  ).run(req.user.id, supplier_id, num, date || '', note || '', JSON.stringify(built.rows), subtotal, discPct, discAmt, final, pType);
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

  // Journal: Dr Inventory / Cr Payable (credit) or Cr Cash/Bank (cash/cheque)
  const crCode = pType === 'credit' ? '2101' : (pType === 'cheque' ? '1102' : '1101');
  const crName = pType === 'credit' ? 'حساب‌های پرداختنی' : (pType === 'cheque' ? 'موجودی بانک' : 'موجودی صندوق');
  createJournalEntry(db, {
    date: date || '', description: `فاکتور خرید ${num}`, ref_type: 'purchase', ref_id: invId, created_by: req.user.id,
    lines: [
      { code: '1104', name: 'موجودی کالا', debit: final, credit: 0 },
      { code: crCode, name: crName, debit: 0, credit: final }
    ]
  });

  audit(req.user.id, 'create', 'purchase', invId, `ثبت فاکتور خرید ${num} به مبلغ ${final}`);
  res.json(db.prepare('SELECT p.*, s.name as supplier_name FROM purchase_invoices p LEFT JOIN suppliers s ON p.supplier_id=s.id WHERE p.id=?').get(invId));
});

router.delete('/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM purchase_invoices WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });

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
  const crCode = row.pay_type === 'credit' ? '2101' : (row.pay_type === 'cheque' ? '1102' : '1101');
  const crName = row.pay_type === 'credit' ? 'حساب‌های پرداختنی' : (row.pay_type === 'cheque' ? 'موجودی بانک' : 'موجودی صندوق');
  createJournalEntry(db, {
    date: row.date || '', description: `ابطال فاکتور خرید ${row.num}`, ref_type: 'purchase_reversal', ref_id: row.id, created_by: req.user.id,
    lines: [
      { code: crCode, name: crName, debit: row.final, credit: 0 },
      { code: '1104', name: 'موجودی کالا', debit: 0, credit: row.final }
    ]
  });

  db.prepare('DELETE FROM purchase_invoices WHERE id=?').run(req.params.id);
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

router.post('/returns', auth, adminOrAccounting, (req, res) => {
  const { supplier_id, purchase_invoice_id, date, note, rows } = req.body;
  if (!supplier_id) return res.status(400).json({ error: 'تأمین‌کننده الزامی است' });
  const db = getDB();
  let built;
  try { built = buildRows(db, rows); }
  catch (e) { return res.status(400).json({ error: e.message }); }
  if (!built.rows.length) return res.status(400).json({ error: 'حداقل یک ردیف لازم است' });

  const amount = built.subtotal;
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

  audit(req.user.id, 'create', 'purchase_return', retId, `برگشت از خرید به مبلغ ${amount}`);
  res.json({ id: retId, ok: true });
});

router.delete('/returns/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM purchase_returns WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
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
  const { supplier_id, purchase_invoice_id, amount, pay_type, date, note } = req.body;
  if (!supplier_id || !amount) return res.status(400).json({ error: 'تأمین‌کننده و مبلغ الزامی است' });
  const db = getDB();
  const result = db.prepare(
    'INSERT INTO supplier_payments (supplier_id,purchase_invoice_id,amount,pay_type,date,note,created_by) VALUES (?,?,?,?,?,?,?)'
  ).run(supplier_id, purchase_invoice_id || null, parseFloat(amount), pay_type || 'cash', date || todayJalali(), note || '', req.user.id);
  const payId = result.lastInsertRowid;

  createSupplierLedgerEntry(db, {
    supplier_id, date: date || todayJalali(), entry_type: 'payment', ref_type: 'supplier_payment', ref_id: payId,
    description: `پرداخت به تأمین‌کننده — ${Number(amount).toLocaleString('fa-IR')} تومان`, debit: parseFloat(amount), credit: 0, user_id: req.user.id
  });
  const cashCode = (pay_type || 'cash') === 'cheque' ? '1102' : '1101';
  const cashName = (pay_type || 'cash') === 'cheque' ? 'موجودی بانک' : 'موجودی صندوق';
  createJournalEntry(db, {
    date: date || todayJalali(), description: 'پرداخت به تأمین‌کننده', ref_type: 'supplier_payment', ref_id: payId, created_by: req.user.id,
    lines: [
      { code: '2101', name: 'حساب‌های پرداختنی', debit: parseFloat(amount), credit: 0 },
      { code: cashCode, name: cashName, debit: 0, credit: parseFloat(amount) }
    ]
  });

  audit(req.user.id, 'create', 'supplier_payment', payId, `پرداخت ${amount} تومان به تأمین‌کننده`);
  res.json({ id: payId, ok: true });
});

router.delete('/payments/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM supplier_payments WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  createSupplierLedgerEntry(db, {
    supplier_id: row.supplier_id, date: row.date || '', entry_type: 'reversal', ref_type: 'supplier_payment', ref_id: row.id,
    description: `ابطال پرداخت #${row.id}`, debit: 0, credit: row.amount, user_id: req.user.id
  });
  const cashCode = row.pay_type === 'cheque' ? '1102' : '1101';
  const cashName = row.pay_type === 'cheque' ? 'موجودی بانک' : 'موجودی صندوق';
  createJournalEntry(db, {
    date: row.date || '', description: `ابطال پرداخت به تأمین‌کننده #${row.id}`, ref_type: 'supplier_payment_reversal', ref_id: row.id, created_by: req.user.id,
    lines: [
      { code: cashCode, name: cashName, debit: row.amount, credit: 0 },
      { code: '2101', name: 'حساب‌های پرداختنی', debit: 0, credit: row.amount }
    ]
  });
  db.prepare('DELETE FROM supplier_payments WHERE id=?').run(req.params.id);
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
