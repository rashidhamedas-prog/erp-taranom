const router = require('express').Router();
const { acct: coaAcct } = require('../lib/coa-map');
// پرداختنیِ تأمین‌کننده: تفصیلی خودش وگرنه حساب کنترلی نگاشت‌شده
function payableAcct(db, supplierId) {
  const s = supplierId ? db.prepare('SELECT coa_code FROM suppliers WHERE id=?').get(supplierId) : null;
  if (s && s.coa_code) {
    const a = db.prepare('SELECT code,name FROM chart_of_accounts WHERE code=?').get(s.coa_code);
    if (a) return a;
  }
  return coaAcct(db, 'coa_payable');
}
const { getDB, audit, resolveCashAccount, allocateNumber, isDevice } = require('../db');
const { auth, adminOrAccounting } = require('../middleware/auth');
const { todayJalali } = require('../jalali');
const { calcDocTotals } = require('../lib/vat');
const { postToLedger } = require('../lib/ledger');
const { tomanToRial } = require('../lib/money');

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
    WHERE COALESCE(p.status,'posted')<>'reversed'
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
  const { supplier_id, date, note, rows, disc, pay_type, bank_id, check_category_id, cash_box_id, warehouse_id,
    freight_amount, freight_type, vat_exempt, cost_center_id } = req.body;
  if (!supplier_id) return res.status(400).json({ error: 'تأمین‌کننده الزامی است' });
  const db = getDB();
  let built;
  try { built = buildRows(db, rows); }
  catch (e) { return res.status(400).json({ error: e.message }); }

  const discPct = parseFloat(disc) || 0;
  const totals = calcDocTotals(db, built, discPct, { vatExempt: !!vat_exempt });
  const freightRial = tomanToRial(parseFloat(freight_amount) || 0);
  const freightToman = Math.round(freightRial / 10);
  let { subtotal, discAmt, final, vatAmount, vatRate, netBeforeVat } = totals;
  final += freightToman;
  netBeforeVat += freightToman;
  const entryDate = date || todayJalali();
  const whId = warehouse_id ? parseInt(warehouse_id, 10) : null;
  const prefixRow = db.prepare("SELECT value FROM settings WHERE key='purchase_num_prefix'").get();
  const pType = pay_type || 'credit';
  const ccId = cost_center_id ? parseInt(cost_center_id, 10) : null;

  const { invId, num } = db.transaction(() => {
    const num = isDevice()
      ? ('موقت-' + Date.now().toString(36).toUpperCase())
      : allocateNumber(db, 'purchase', prefixRow?.value || 'PO');
    const result = db.prepare(
      `INSERT INTO purchase_invoices (user_id,supplier_id,num,date,note,rows,subtotal,disc,disc_amt,final,vat_amount,vat_rate,pay_type,stock_added,bank_id,check_category_id,cash_box_id,warehouse_id,freight_amount,freight_type,vat_exempt,cost_center_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?,?,?,?,?)`
    ).run(req.user.id, supplier_id, num, entryDate, note || '', JSON.stringify(built.rows), subtotal, discPct, discAmt, final, vatAmount, vatRate, pType, bank_id || null, check_category_id || null, cash_box_id || null, whId, freightRial, freight_type || '', vat_exempt ? 1 : 0, ccId);
    const invId = result.lastInsertRowid;

    // Stock increases immediately on purchase
    for (const r of built.rows) {
      db.prepare('UPDATE products SET stock=stock+? WHERE id=?').run(r.qty, r.product_id);
      db.prepare('INSERT INTO stock_logs (product_id,user_id,change,note) VALUES (?,?,?,?)').run(r.product_id, req.user.id, r.qty, `افزودن موجودی از فاکتور خرید ${num}`);
      if (whId) {
        db.prepare('INSERT INTO warehouse_stock (product_id,warehouse_id,qty) VALUES (?,?,?) ON CONFLICT(product_id,warehouse_id) DO UPDATE SET qty=qty+excluded.qty')
          .run(r.product_id, whId, r.qty);
      }
    }

    // Supplier ledger: credit = we now owe the supplier (only tracked for on-account purchases)
    if (pType === 'credit') {
      createSupplierLedgerEntry(db, {
        supplier_id, date: date || '', entry_type: 'purchase', ref_type: 'purchase', ref_id: invId,
        description: `فاکتور خرید ${num}`, debit: 0, credit: final, user_id: req.user.id
      });
    }

    // Journal: Dr Inventory + Dr VAT receivable / Cr Payable or Cash
    const invAcct = coaAcct(db, 'coa_inventory');
    const vatRec = coaAcct(db, 'coa_vat_receivable');
    const inventoryDebit = netBeforeVat;
    const jLines = [{ code: invAcct.code, name: invAcct.name, debit: inventoryDebit, credit: 0 }];
    if (vatAmount > 0) jLines.push({ code: vatRec.code, name: vatRec.name, debit: vatAmount, credit: 0, description: 'مالیات خرید' });
    const payTypeResolved = pType === 'bank_transfer' ? 'bank' : pType;
    const cr = pType === 'credit' ? payableAcct(db, supplier_id) : resolveCashAccount(db, payTypeResolved, bank_id, cash_box_id);
    jLines.push({ code: cr.code, name: cr.name, debit: 0, credit: final });
    postToLedger(db, {
      sourceType: 'purchase', sourceId: invId, date: entryDate,
      description: `فاکتور خرید ${num}${freightRial ? ' (با کرایه حمل)' : ''}`, createdBy: req.user.id, lines: jLines,
      costCenterId: ccId,
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
  if (row.status === 'reversed') return res.status(400).json({ error: 'این فاکتور خرید قبلاً ابطال شده است' });

  db.transaction(() => {
    if (row.stock_added) {
      const invRows = JSON.parse(row.rows || '[]');
      for (const r of invRows) {
        db.prepare('UPDATE products SET stock=stock-? WHERE id=?').run(r.qty, r.product_id);
        db.prepare('INSERT INTO stock_logs (product_id,user_id,change,note) VALUES (?,?,?,?)').run(r.product_id, req.user.id, -r.qty, `بازگشت موجودی از حذف فاکتور خرید ${row.num}`);
        if (row.warehouse_id) {
          db.prepare('UPDATE warehouse_stock SET qty=qty-? WHERE product_id=? AND warehouse_id=?').run(r.qty, r.product_id, row.warehouse_id);
        }
      }
    }
    if (row.pay_type === 'credit') {
      createSupplierLedgerEntry(db, {
        supplier_id: row.supplier_id, date: todayJalali(), entry_type: 'reversal', ref_type: 'purchase', ref_id: row.id,
        description: `ابطال فاکتور خرید ${row.num}`, debit: row.final, credit: 0, user_id: req.user.id
      });
    }
    const payTypeResolved = row.pay_type === 'bank_transfer' ? 'bank' : row.pay_type;
    const cr = row.pay_type === 'credit' ? payableAcct(db, row.supplier_id) : resolveCashAccount(db, payTypeResolved, row.bank_id, row.cash_box_id);
    const invAcct = coaAcct(db, 'coa_inventory');
    const vatRec = coaAcct(db, 'coa_vat_receivable');
    const netBeforeVat = (row.subtotal || 0) - (row.disc_amt || 0) + Math.round((row.freight_amount || 0) / 10);
    const revLines = [
      { code: cr.code, name: cr.name, debit: row.final, credit: 0 },
      { code: invAcct.code, name: invAcct.name, debit: 0, credit: netBeforeVat },
    ];
    if (row.vat_amount > 0) revLines.push({ code: vatRec.code, name: vatRec.name, debit: 0, credit: row.vat_amount, description: 'ابطال VAT خرید' });
    const reversalId = postToLedger(db, {
      sourceType: 'purchase_reversal', sourceId: row.id,
      date: todayJalali(), description: `ابطال فاکتور خرید ${row.num}`, createdBy: req.user.id,
      lines: revLines,
    });

    db.prepare("UPDATE purchase_invoices SET status='reversed',stock_added=0,reversal_journal_id=?,reversed_at=strftime('%s','now'),reversed_by=? WHERE id=?")
      .run(reversalId, req.user.id, row.id);
  })();
  audit(req.user.id, 'reverse', 'purchase', req.params.id, `ابطال فاکتور خرید ${row.num}`);
  res.json({ ok: true });
});

// ---------------- Purchase returns ----------------

router.get('/returns/list', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const rows = db.prepare(`
    SELECT pr.*, s.name as supplier_name FROM purchase_returns pr
    LEFT JOIN suppliers s ON pr.supplier_id=s.id
    WHERE COALESCE(pr.status,'posted')<>'reversed' ORDER BY pr.created_at DESC
  `).all();
  res.json(rows.map(r => {
    let parsed = [];
    try { parsed = JSON.parse(r.rows || '[]'); } catch (_) { parsed = []; }
    return { ...r, rows: parsed };
  }));
});

// Invoice-linked return picker — mirrors /accounting/sales-returns/available/:id
router.get('/returns/available/:invoiceId', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const inv = db.prepare('SELECT p.*,s.name as supplier_name FROM purchase_invoices p LEFT JOIN suppliers s ON p.supplier_id=s.id WHERE p.id=?').get(req.params.invoiceId);
  if (!inv) return res.status(404).json({ error: 'فاکتور خرید یافت نشد' });
  const invRows = JSON.parse(inv.rows || '[]');
  const alreadyReturned = {};
  db.prepare("SELECT rows FROM purchase_returns WHERE purchase_invoice_id=? AND COALESCE(status,'posted')<>'reversed'").all(req.params.invoiceId).forEach(pr => {
    try {
      JSON.parse(pr.rows || '[]').forEach(r => { alreadyReturned[r.product_id] = (alreadyReturned[r.product_id] || 0) + r.qty; });
    } catch (_) { /* ignore bad JSON */ }
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
    db.prepare("SELECT rows FROM purchase_returns WHERE purchase_invoice_id=? AND COALESCE(status,'posted')<>'reversed'").all(purchase_invoice_id).forEach(pr => {
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
    postToLedger(db, {
      sourceType: 'purchase_return', sourceId: retId,
      date: date || todayJalali(), description: `برگشت از خرید #${retId}`, createdBy: req.user.id,
      lines: [
        (()=>{const a=payableAcct(db, supplier_id);return { code: a.code, name: a.name, debit: amount, credit: 0 };})(),
        { code: coaAcct(db,'coa_inventory').code, name: coaAcct(db,'coa_inventory').name, debit: 0, credit: amount }
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
  if (row.status === 'reversed') return res.status(400).json({ error: 'این برگشت خرید قبلاً ابطال شده است' });
  db.transaction(() => {
    const invRows = JSON.parse(row.rows || '[]');
    for (const r of invRows) {
      db.prepare('UPDATE products SET stock=stock+? WHERE id=?').run(r.qty, r.product_id);
      db.prepare('INSERT INTO stock_logs (product_id,user_id,change,note) VALUES (?,?,?,?)').run(r.product_id, req.user.id, r.qty, `ابطال برگشت از خرید #${row.id}`);
    }
    createSupplierLedgerEntry(db, {
      supplier_id: row.supplier_id, date: todayJalali(), entry_type: 'reversal', ref_type: 'purchase_return', ref_id: row.id,
      description: `ابطال برگشت از خرید #${row.id}`, debit: 0, credit: row.amount, user_id: req.user.id
    });
    const reversalId = postToLedger(db, {
      sourceType: 'purchase_return_reversal', sourceId: row.id,
      date: todayJalali(), description: `ابطال برگشت از خرید #${row.id}`, createdBy: req.user.id,
      lines: [
        { code: coaAcct(db,'coa_inventory').code, name: coaAcct(db,'coa_inventory').name, debit: row.amount, credit: 0 },
        (()=>{const a=payableAcct(db, row.supplier_id);return { code: a.code, name: a.name, debit: 0, credit: row.amount };})()
      ]
    });
    db.prepare("UPDATE purchase_returns SET status='reversed',reversal_journal_id=?,reversed_at=strftime('%s','now'),reversed_by=? WHERE id=?")
      .run(reversalId, req.user.id, row.id);
  })();
  res.json({ ok: true });
});

// ---------------- Supplier payments (mirrors customer settlements) ----------------

router.get('/payments/list', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const rows = db.prepare(`
    SELECT sp.*, s.name as supplier_name FROM supplier_payments sp
    LEFT JOIN suppliers s ON sp.supplier_id=s.id
    WHERE COALESCE(sp.status,'posted')<>'reversed' ORDER BY sp.created_at DESC LIMIT 300
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
    postToLedger(db, {
      sourceType: 'supplier_payment', sourceId: payId,
      date: date || todayJalali(), description: 'پرداخت به تأمین‌کننده', createdBy: req.user.id,
      lines: [
        (()=>{const a=payableAcct(db, supplier_id);return { code: a.code, name: a.name, debit: parseFloat(amount), credit: 0 };})(),
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
  if (row.status === 'reversed') return res.status(400).json({ error: 'این پرداخت قبلاً ابطال شده است' });
  db.transaction(() => {
    createSupplierLedgerEntry(db, {
      supplier_id: row.supplier_id, date: todayJalali(), entry_type: 'reversal', ref_type: 'supplier_payment', ref_id: row.id,
      description: `ابطال پرداخت #${row.id}`, debit: 0, credit: row.amount, user_id: req.user.id
    });
    const cash = resolveCashAccount(db, row.pay_type, row.bank_id, row.cash_box_id);
    const reversalId = postToLedger(db, {
      sourceType: 'supplier_payment_reversal', sourceId: row.id,
      date: todayJalali(), description: `ابطال پرداخت به تأمین‌کننده #${row.id}`, createdBy: req.user.id,
      lines: [
        { code: cash.code, name: cash.name, debit: row.amount, credit: 0 },
        (()=>{const a=payableAcct(db, row.supplier_id);return { code: a.code, name: a.name, debit: 0, credit: row.amount };})()
      ]
    });
    db.prepare("UPDATE supplier_payments SET status='reversed',reversal_journal_id=?,reversed_at=strftime('%s','now'),reversed_by=? WHERE id=?")
      .run(reversalId, req.user.id, row.id);
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
