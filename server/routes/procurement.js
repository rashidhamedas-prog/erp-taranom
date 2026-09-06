'use strict';
/**
 * Purchase order + goods receipt + GRNI + three-way match.
 * Mounted at /api/purchases before the generic invoices router.
 */
const router = require('express').Router();
const { getDB, audit, allocateNumber, isDevice } = require('../db');
const { auth, adminOrAccounting } = require('../middleware/auth');
const { todayJalali } = require('../jalali');
const { acct } = require('../lib/coa-map');
const { postToLedger } = require('../lib/ledger');
const { rialToLedger } = require('../lib/money');
const { postPurchaseStockMovements, reverseStockBySource, assertJournalIdempotent } = require('../lib/sales-document');
const { assertMakerChecker, assertBranchScope } = require('../lib/rbac');

function httpErr(status, message, code) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  return e;
}
function sendErr(res, e) {
  res.status(e.status || 400).json({ error: e.message || String(e), code: e.code });
}

function parseRows(db, input) {
  const rows = [];
  for (const r of input || []) {
    const productId = parseInt(r.product_id, 10);
    const qty = Number(r.qty) || 0;
    if (!productId || qty <= 0) continue;
    const prod = db.prepare('SELECT id,name,cost FROM products WHERE id=?').get(productId);
    if (!prod) throw httpErr(400, 'محصول یافت نشد', 'E_PROD');
    const price = r.price != null ? Number(r.price) || 0 : (Number(prod.cost) || 0);
    rows.push({
      product_id: productId, name: prod.name, qty, price,
      amount: Math.round(qty * price),
    });
  }
  if (!rows.length) throw httpErr(400, 'حداقل یک ردیف کالا لازم است', 'E_PO_ROWS');
  return rows;
}

function payableAcct(db, supplierId) {
  const s = supplierId ? db.prepare('SELECT coa_code FROM suppliers WHERE id=?').get(supplierId) : null;
  if (s && s.coa_code) {
    const a = db.prepare('SELECT code,name FROM chart_of_accounts WHERE code=?').get(s.coa_code);
    if (a) return a;
  }
  return acct(db, 'coa_payable');
}

router.get('/orders', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const rows = db.prepare(`
    SELECT p.*, s.name as supplier_name
    FROM purchase_orders p LEFT JOIN suppliers s ON p.supplier_id=s.id
    WHERE COALESCE(p.status,'')<>'cancelled'
    ORDER BY p.id DESC LIMIT 200
  `).all();
  res.json(rows.map((r) => ({ ...r, rows: JSON.parse(r.rows || '[]') })));
});

router.post('/orders', auth, adminOrAccounting, (req, res) => {
  try {
    const db = getDB();
    if (!req.body.supplier_id) throw httpErr(400, 'تأمین‌کننده الزامی است', 'E_PO_SUP');
    const rows = parseRows(db, req.body.rows);
    const branchId = req.body.branch_id != null ? parseInt(req.body.branch_id, 10) : (req.user.branch_id || 1);
    assertBranchScope(req.user, branchId);
    const created = db.transaction(() => {
      const num = isDevice()
        ? ('موقت-' + Date.now().toString(36).toUpperCase())
        : allocateNumber(db, 'purchase_order', 'POR');
      const r = db.prepare(`
        INSERT INTO purchase_orders (num,supplier_id,rfq_id,date,status,branch_id,warehouse_id,rows,note,created_by)
        VALUES (?,?,?,?,?,?,?,?,?,?)
      `).run(
        num, req.body.supplier_id, req.body.rfq_id || null,
        req.body.date || todayJalali(), 'open', branchId,
        req.body.warehouse_id || null, JSON.stringify(rows),
        String(req.body.note || ''), req.user.id
      );
      return db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(r.lastInsertRowid);
    })();
    audit(req.user.id, 'create', 'purchase_order', created.id, created.num);
    res.json({ ...created, rows: JSON.parse(created.rows || '[]') });
  } catch (e) { sendErr(res, e); }
});

router.post('/orders/:id/approve', auth, adminOrAccounting, (req, res) => {
  try {
    const db = getDB();
    const row = db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'یافت نشد' });
    assertMakerChecker(req.user, row.created_by);
    db.prepare("UPDATE purchase_orders SET status='approved', approved_by=? WHERE id=?").run(req.user.id, row.id);
    res.json(db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(row.id));
  } catch (e) { sendErr(res, e); }
});

router.delete('/orders/:id', auth, adminOrAccounting, (req, res) => {
  try {
    const db = getDB();
    const row = db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'یافت نشد' });
    const gr = db.prepare("SELECT COUNT(*) c FROM goods_receipts WHERE purchase_order_id=? AND COALESCE(status,'posted')<>'reversed'").get(row.id).c;
    if (gr) return res.status(400).json({ error: 'این سفارش رسید فعال دارد' });
    db.prepare("UPDATE purchase_orders SET status='cancelled' WHERE id=?").run(row.id);
    audit(req.user.id, 'reverse', 'purchase_order', row.id, row.num);
    res.json({ ok: true });
  } catch (e) { sendErr(res, e); }
});

router.get('/goods-receipts', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const rows = db.prepare(`
    SELECT g.* FROM goods_receipts g
    WHERE COALESCE(g.status,'posted')<>'reversed'
    ORDER BY g.id DESC LIMIT 200
  `).all();
  res.json(rows.map((r) => ({ ...r, rows: JSON.parse(r.rows || '[]') })));
});

router.post('/goods-receipts', auth, adminOrAccounting, (req, res) => {
  try {
    const db = getDB();
    const po = db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(req.body.purchase_order_id);
    if (!po || po.status === 'cancelled') throw httpErr(400, 'سفارش خرید یافت نشد', 'E_GR_PO');
    const poRows = JSON.parse(po.rows || '[]');
    const rows = (req.body.rows && req.body.rows.length) ? parseRows(db, req.body.rows) : poRows;
    const whId = req.body.warehouse_id || po.warehouse_id;
    if (!whId) throw httpErr(400, 'انبار رسید الزامی است', 'E_GR_WH');
    const date = req.body.date || todayJalali();
    const created = db.transaction(() => {
      const num = isDevice()
        ? ('موقت-' + Date.now().toString(36).toUpperCase())
        : allocateNumber(db, 'goods_receipt', 'GR');
      const r = db.prepare(`
        INSERT INTO goods_receipts (num,purchase_order_id,supplier_id,date,status,branch_id,warehouse_id,rows,note,created_by)
        VALUES (?,?,?,?,?,?,?,?,?,?)
      `).run(
        num, po.id, po.supplier_id, date, 'posted',
        po.branch_id, whId, JSON.stringify(rows),
        String(req.body.note || ''), req.user.id
      );
      const grId = r.lastInsertRowid;
      postPurchaseStockMovements(db, {
        rows, warehouseId: whId, sourceType: 'goods_receipt', sourceId: grId,
        userId: req.user.id, date, note: `رسید کالا ${num}`,
      });
      const amount = rows.reduce((s, x) => s + Math.round(Number(x.amount) || (x.qty * x.price) || 0), 0);
      const inv = acct(db, 'coa_inventory');
      const grni = acct(db, 'coa_grni');
      assertJournalIdempotent(db, 'goods_receipt', grId);
      const jeId = postToLedger(db, {
        sourceType: 'goods_receipt', sourceId: grId, date,
        description: `رسید کالا ${num} (GRNI)`, createdBy: req.user.id,
        lines: [
          { code: inv.code, name: inv.name, debit: rialToLedger(amount), credit: 0 },
          { code: grni.code, name: grni.name, debit: 0, credit: rialToLedger(amount) },
        ],
      });
      db.prepare('UPDATE goods_receipts SET journal_id=? WHERE id=?').run(jeId, grId);
      return db.prepare('SELECT * FROM goods_receipts WHERE id=?').get(grId);
    })();
    audit(req.user.id, 'create', 'goods_receipt', created.id, created.num);
    res.json({ ...created, rows: JSON.parse(created.rows || '[]') });
  } catch (e) { sendErr(res, e); }
});

router.delete('/goods-receipts/:id', auth, adminOrAccounting, (req, res) => {
  try {
    const db = getDB();
    const row = db.prepare('SELECT * FROM goods_receipts WHERE id=?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'یافت نشد' });
    if (row.status === 'reversed') return res.status(400).json({ error: 'قبلاً ابطال شده' });
    const billed = db.prepare("SELECT COUNT(*) c FROM purchase_invoices WHERE goods_receipt_id=? AND COALESCE(status,'posted')<>'reversed'").get(row.id).c;
    if (billed) return res.status(400).json({ error: 'این رسید فاکتور فعال دارد' });
    db.transaction(() => {
      reverseStockBySource(db, 'goods_receipt', row.id, {
        createdBy: req.user.id, date: todayJalali(), note: `ابطال رسید ${row.num}`,
      });
      const inv = acct(db, 'coa_inventory');
      const grni = acct(db, 'coa_grni');
      const rows = JSON.parse(row.rows || '[]');
      const amount = rows.reduce((s, x) => s + Math.round(Number(x.amount) || (x.qty * x.price) || 0), 0);
      const revId = postToLedger(db, {
        sourceType: 'goods_receipt_reversal', sourceId: row.id,
        date: todayJalali(), description: `ابطال رسید ${row.num}`, createdBy: req.user.id,
        lines: [
          { code: grni.code, name: grni.name, debit: rialToLedger(amount), credit: 0 },
          { code: inv.code, name: inv.name, debit: 0, credit: rialToLedger(amount) },
        ],
      });
      db.prepare("UPDATE goods_receipts SET status='reversed', reversal_journal_id=?, reversed_at=strftime('%s','now'), reversed_by=? WHERE id=?")
        .run(revId, req.user.id, row.id);
    })();
    audit(req.user.id, 'reverse', 'goods_receipt', row.id, row.num);
    res.json({ ok: true });
  } catch (e) { sendErr(res, e); }
});

router.post('/gr-invoices', auth, adminOrAccounting, (req, res) => {
  try {
    const db = getDB();
    const gr = db.prepare('SELECT * FROM goods_receipts WHERE id=?').get(req.body.goods_receipt_id);
    if (!gr || gr.status === 'reversed') throw httpErr(400, 'رسید کالا یافت نشد', 'E_GR_INV');
    const existing = db.prepare("SELECT id FROM purchase_invoices WHERE goods_receipt_id=? AND COALESCE(status,'posted')<>'reversed'").get(gr.id);
    if (existing) throw httpErr(409, 'این رسید قبلاً فاکتور شده', 'E_GR_DUP');
    const rows = JSON.parse(gr.rows || '[]');
    const amount = rows.reduce((s, x) => s + Math.round(Number(x.amount) || (x.qty * x.price) || 0), 0);
    const date = req.body.date || todayJalali();
    const created = db.transaction(() => {
      const num = isDevice()
        ? ('موقت-' + Date.now().toString(36).toUpperCase())
        : allocateNumber(db, 'purchase', 'PO');
      const r = db.prepare(`
        INSERT INTO purchase_invoices (user_id,supplier_id,num,date,note,rows,subtotal,disc,disc_amt,final,vat_amount,vat_rate,pay_type,stock_added,warehouse_id,goods_receipt_id,purchase_order_id)
        VALUES (?,?,?,?,?,?,?,0,0,?,0,0,'credit',0,?,?,?)
      `).run(
        req.user.id, gr.supplier_id, num, date, String(req.body.note || ''),
        JSON.stringify(rows), amount, amount, gr.warehouse_id, gr.id, gr.purchase_order_id
      );
      const invId = r.lastInsertRowid;
      const grni = acct(db, 'coa_grni');
      const ap = payableAcct(db, gr.supplier_id);
      assertJournalIdempotent(db, 'purchase', invId);
      postToLedger(db, {
        sourceType: 'purchase', sourceId: invId, date,
        description: `فاکتور خرید از رسید ${gr.num} (تسویه GRNI)`, createdBy: req.user.id,
        lines: [
          { code: grni.code, name: grni.name, debit: rialToLedger(amount), credit: 0 },
          { code: ap.code, name: ap.name, debit: 0, credit: rialToLedger(amount) },
        ],
      });
      return db.prepare('SELECT * FROM purchase_invoices WHERE id=?').get(invId);
    })();
    audit(req.user.id, 'create', 'purchase', created.id, created.num);
    res.json(created);
  } catch (e) { sendErr(res, e); }
});

function qtyMap(rows) {
  const m = new Map();
  for (const r of rows || []) {
    const id = Number(r.product_id);
    if (!id) continue;
    m.set(id, (m.get(id) || 0) + (Number(r.qty) || 0));
  }
  return m;
}

router.post('/three-way-match', auth, adminOrAccounting, (req, res) => {
  try {
    const db = getDB();
    const po = db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(req.body.purchase_order_id);
    const gr = db.prepare('SELECT * FROM goods_receipts WHERE id=?').get(req.body.goods_receipt_id);
    if (!po || !gr) throw httpErr(400, 'سفارش یا رسید یافت نشد', 'E_TWM');
    if (Number(gr.purchase_order_id) !== Number(po.id)) throw httpErr(400, 'رسید به این سفارش وصل نیست', 'E_TWM_LINK');
    let invoice = null;
    if (req.body.purchase_invoice_id) {
      invoice = db.prepare('SELECT * FROM purchase_invoices WHERE id=?').get(req.body.purchase_invoice_id);
    } else {
      invoice = db.prepare("SELECT * FROM purchase_invoices WHERE goods_receipt_id=? AND COALESCE(status,'posted')<>'reversed'").get(gr.id);
    }
    const poMap = qtyMap(JSON.parse(po.rows || '[]'));
    const grMap = qtyMap(JSON.parse(gr.rows || '[]'));
    const invMap = qtyMap(invoice ? JSON.parse(invoice.rows || '[]') : []);
    const ids = new Set([...poMap.keys(), ...grMap.keys(), ...invMap.keys()]);
    const diffs = [];
    let matched = true;
    for (const id of ids) {
      const poQty = poMap.get(id) || 0;
      const grQty = grMap.get(id) || 0;
      const invQty = invMap.get(id) || 0;
      const ok = Math.abs(poQty - grQty) < 1e-6 && (!invoice || Math.abs(grQty - invQty) < 1e-6);
      if (!ok) matched = false;
      diffs.push({ product_id: id, po_qty: poQty, gr_qty: grQty, invoice_qty: invQty, ok });
    }
    if (!invoice) matched = false;
    const saved = db.transaction(() => {
      const r = db.prepare(`
        INSERT INTO three_way_matches (purchase_order_id,goods_receipt_id,purchase_invoice_id,matched,diffs,created_by)
        VALUES (?,?,?,?,?,?)
      `).run(po.id, gr.id, invoice ? invoice.id : null, matched ? 1 : 0, JSON.stringify(diffs), req.user.id);
      return db.prepare('SELECT * FROM three_way_matches WHERE id=?').get(r.lastInsertRowid);
    })();
    res.json({
      ...saved,
      diffs,
      matched,
      three_way: true,
      message: matched ? 'تطبیق سه‌طرفه موفق' : 'اختلاف مقدار در تطبیق سه‌طرفه',
    });
  } catch (e) { sendErr(res, e); }
});

module.exports = router;
