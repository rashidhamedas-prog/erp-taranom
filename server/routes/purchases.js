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
const { sendSecureHtml } = require('../lib/secure-html-response');
const { assertJournalLinesBalanced } = require('../lib/customer-books');
const { resolveCashPaid, assertCashBoxRequired } = require('../lib/cash-on-document');
const {
  resolvePurchasePayments, applyPurchasePaySplits, persistPurchasePayPlan, headerPayTypeFromSplits,
  recomputePurchaseInvoiceSettledBalances,
} = require('../lib/purchase-payments');
const { reverseJournalEntry } = require('../lib/void-journal');

function getSetting(db, key) {
  const r = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return r ? r.value : '';
}
const { todayJalali } = require('../jalali');
const { calcDocTotals } = require('../lib/vat');
const { postToLedger } = require('../lib/ledger');
const { rialToLedger } = require('../lib/money');
const {
  parseFeeRial, parseFeeCostCenterInput, resolveFeeCostCenterId,
  outboundPaymentLines, outboundPaymentReversalLines,
} = require('../lib/payment-bank-fee');
const {
  postPurchaseStockMovements, reverseStockBySource,
  perpetualDocsEnabled, assertJournalIdempotent,
  allocateFreight, applyFreightToDocTotals, freightChargedToCounterparty,
} = require('../lib/sales-document');
const { postInventoryMovement, inventoryAccountForWarehouse, inventoryAmountLinesByWarehouse } = require('../lib/inventory/ledger');

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

const { parseQty } = require('../lib/round3');

function purchaseLineKey(r) {
  if (!r) return '';
  if (r.batch_id) return 'b' + Number(r.batch_id);
  if (r.variant_id) return 'v' + Number(r.variant_id);
  const color = String(r.color || r.color_name || '').trim();
  if (color && r.product_id) return 'p' + Number(r.product_id) + ':c' + color;
  return r.product_id ? ('p' + Number(r.product_id)) : '';
}

function findPurchaseOrigLine(invoiceLineMap, r) {
  if (!invoiceLineMap || !r) return null;
  if (r.line_key && invoiceLineMap[r.line_key]) return invoiceLineMap[r.line_key];
  const key = purchaseLineKey(r);
  if (key && invoiceLineMap[key]) return invoiceLineMap[key];
  if (r.product_id && invoiceLineMap['p' + Number(r.product_id)]) return invoiceLineMap['p' + Number(r.product_id)];
  return null;
}

function buildRows(db, inputRows) {
  const out = [];
  let subtotal = 0;
  for (const r of (inputRows || [])) {
    const pid = parseInt(r.product_id);
    if (!pid) throw new Error('هر ردیف باید یک محصول معتبر داشته باشد');
    const prod = db.prepare('SELECT * FROM products WHERE id=?').get(pid);
    if (!prod) throw new Error('محصول یافت نشد (شناسه ' + pid + ')');
    const qty = Math.max(0.001, parseQty(r.qty, 1));
    const price = (r.price !== undefined && r.price !== null && r.price !== '') ? (parseFloat(r.price) || 0) : (prod.cost || 0);
    const disc = Math.min(100, Math.max(0, parseFloat(r.disc) || 0));
    const discAmountIn = Math.max(0, Math.round(parseFloat(r.disc_amount) || 0));
    const description = String(r.description || '').trim();
    const gross = qty * price;
    const discPctAmt = Math.round(gross * disc / 100);
    const discAmt = discAmountIn > 0 ? discAmountIn : discPctAmt;
    const discAmount = discAmt;
    const sum = Math.max(0, Math.round(gross - discAmt));
    subtotal += sum;
    out.push({
      product_id: pid, name: prod.name, qty, price, disc, disc_amount: discAmount,
      disc_amt: discAmt, sum, description, allocated_freight: 0,
      warehouse_id: r.warehouse_id ? parseInt(r.warehouse_id, 10) : null,
      batch_id: r.batch_id ? parseInt(r.batch_id, 10) : null,
      is_fabric_roll: r.is_fabric_roll ? 1 : 0,
      variant_id: r.variant_id ? parseInt(r.variant_id, 10) : null,
      color: String(r.color || r.color_name || '').trim(),
      color_name: String(r.color_name || r.color || '').trim(),
      size_name: String(r.size_name || '').trim(),
      pattern: String(r.pattern || '').trim(),
      width_cm: Math.round(Number(r.width_cm) || 0),
      roll_no: String(r.roll_no || '').trim(),
      unit_cost_rial: Math.round(Number(r.unit_cost_rial) || 0),
    });
  }
  return { rows: out, subtotal };
}

function buildInventoryValuationRows(rows, documentDiscountRial, includeFreight) {
  const discount = Math.round(Number(documentDiscountRial) || 0);
  const total = rows.reduce((sum, row) => sum + Math.round(Number(row.sum) || 0), 0);
  let allocatedDiscount = 0;
  return rows.map((row, index) => {
    const lineValue = Math.round(Number(row.sum) || 0);
    const discountShare = index === rows.length - 1
      ? discount - allocatedDiscount
      : (total > 0 ? Math.round(discount * lineValue / total) : 0);
    allocatedDiscount += discountShare;
    const amountRial = lineValue - discountShare
      + (includeFreight ? Math.round(Number(row.allocated_freight) || 0) : 0);
    const qty = Number(row.qty) || 0;
    return {
      ...row,
      // Landed unit in rial so inventory_ledger matches purchase JE (netBeforeVat).
      price_rial: qty > 0 ? Math.round(amountRial / qty) : Math.round(Number(row.price) || 0),
      amount_rial: amountRial,
    };
  });
}

// ---------------- Purchase invoices ----------------

router.get('/', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const rows = db.prepare(`
    SELECT p.*, s.name as supplier_name, u.name as recorder
    FROM purchase_invoices p LEFT JOIN suppliers s ON p.supplier_id=s.id LEFT JOIN users u ON p.user_id=u.id
    WHERE COALESCE(p.status,'posted')<>'reversed'
    ORDER BY p.date DESC, p.id DESC
  `).all();
  res.json(rows.map(r => ({ ...r, rows: JSON.parse(r.rows || '[]') })));
});

router.get('/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT p.*, s.name as supplier_name FROM purchase_invoices p LEFT JOIN suppliers s ON p.supplier_id=s.id WHERE p.id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  res.json({ ...row, rows: JSON.parse(row.rows || '[]') });
});

router.get('/:id/print', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const raw = String(req.params.id || '').trim();
  const asId = parseInt(raw, 10);
  const purchasePrintSql = `SELECT p.*, s.name as supplier_name, s.phone as supplier_phone, s.address as supplier_address,
      s.economic_code as supplier_economic_code, s.national_id as supplier_national_id, s.postal_code as supplier_postal_code
    FROM purchase_invoices p LEFT JOIN suppliers s ON p.supplier_id=s.id`;
  const row = Number.isFinite(asId)
    ? db.prepare(purchasePrintSql + ' WHERE p.id=?').get(asId)
    : db.prepare(purchasePrintSql + ' WHERE p.num=?').get(raw);
  if (!row) return res.status(404).send('فاکتور خرید پیدا نشد');
  let rows = [];
  try { rows = JSON.parse(row.rows || '[]'); } catch (_) { rows = []; }
  const settings = {
    company_name: getSetting(db, 'company_name'),
    company_address: getSetting(db, 'company_address'),
    company_phone: getSetting(db, 'company_phone'),
    company_economic_code: getSetting(db, 'company_economic_code'),
    company_national_id: getSetting(db, 'company_national_id'),
    company_postal_code: getSetting(db, 'company_postal_code'),
    invoice_template_formal: getSetting(db, 'invoice_template_formal') || 'formal-official',
    invoice_template_casual: 'casual-simple',
    invoice_paper_size: getSetting(db, 'invoice_paper_size') || 'A4',
    invoice_thermal_width: getSetting(db, 'invoice_thermal_width') || '80',
    invoice_customize: getSetting(db, 'invoice_customize') || '',
  };
  const paperQ = String(req.query.paper || 'A4').toUpperCase();
  const paper = paperQ === 'A5' ? 'A5' : 'A4';
  const inv = {
    ...row,
    doc_kind: 'purchase',
    type: 'purchase',
    cust_biz: row.supplier_name || '',
    cust_owner: '',
    cust_city: '',
    cust_phone: row.supplier_phone || '',
    cust_address: row.supplier_address || '',
    cust_economic_code: row.supplier_economic_code || '',
    cust_national_id: row.supplier_national_id || '',
    cust_postal_code: row.supplier_postal_code || '',
  };
  try {
    const { renderInvoicePrintHtml } = require('../lib/invoice-print');
    let settlements = [];
    try {
      settlements = db.prepare(`
        SELECT sp.*, b.name AS bank_name, cb.name AS cash_box_name,
               sp.amount AS amount_rial
        FROM supplier_payments sp
        LEFT JOIN banks b ON b.id=sp.bank_id
        LEFT JOIN cash_boxes cb ON cb.id=sp.cash_box_id
        WHERE sp.purchase_invoice_id=? AND COALESCE(sp.status,'posted')<>'reversed'
        ORDER BY sp.id
      `).all(row.id);
    } catch (_) { settlements = []; }
    const html = renderInvoicePrintHtml({
      inv, rows, settings, paper, db,
      settlements,
      templateOverride: 'casual-simple',
    });
    return sendSecureHtml(res, html, { allowPrintScript: true });
  } catch (e) {
    console.error('purchase print:', e && e.message);
    return res.status(500).send('خطا در ساخت چاپ فاکتور خرید');
  }
});

/** برگه رسید ورود انبار برای فاکتور خرید — عملیاتی (بدون مبلغ) */
router.get('/:id/warehouse-slip', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const raw = String(req.params.id || '').trim();
  const asId = parseInt(raw, 10);
  const row = Number.isFinite(asId)
    ? db.prepare('SELECT p.*, s.name as supplier_name, u.name as recorder FROM purchase_invoices p LEFT JOIN suppliers s ON p.supplier_id=s.id LEFT JOIN users u ON u.id=p.user_id WHERE p.id=?').get(asId)
    : db.prepare('SELECT p.*, s.name as supplier_name, u.name as recorder FROM purchase_invoices p LEFT JOIN suppliers s ON p.supplier_id=s.id LEFT JOIN users u ON u.id=p.user_id WHERE p.num=?').get(raw);
  if (!row) return res.status(404).send('فاکتور خرید پیدا نشد');
  let rows = [];
  try { rows = JSON.parse(row.rows || '[]'); } catch (_) { rows = []; }
  const paperQ = String(req.query.paper || 'A4').toUpperCase();
  const paper = paperQ === 'A5' ? 'A5' : 'A4';
  try {
    const { buildPurchaseInvoiceSlip, companySettings } = require('../lib/warehouse-slip-print');
    const html = buildPurchaseInvoiceSlip(db, row, rows, companySettings(db, getSetting), paper);
    return sendSecureHtml(res, html, { allowPrintScript: true });
  } catch (e) {
    console.error('purchase warehouse-slip:', e && e.message);
    return res.status(500).send('خطا در ساخت رسید انبار خرید');
  }
});

router.post('/', auth, adminOrAccounting, (req, res) => {
  const { supplier_id, date, note, rows, disc, pay_type, bank_id, check_category_id, cash_box_id, warehouse_id,
    freight_amount, freight_type, vat_exempt, cost_center_id,
    cheque_duration, cheque_due_date, cheque_info } = req.body;
  if (!supplier_id) return res.status(400).json({ error: 'تأمین‌کننده الزامی است' });
  const db = getDB();
  let built;
  try { built = buildRows(db, rows); }
  catch (e) { return res.status(400).json({ error: e.message }); }

  const discPct = parseFloat(disc) || 0;
  const totals = calcDocTotals(db, built, discPct, { vatExempt: !!vat_exempt });
  const freightRial = Math.round(parseFloat(freight_amount) || 0);
  const allocMethod = ['amount', 'qty', 'equal'].includes(req.body.freight_alloc_method)
    ? req.body.freight_alloc_method : 'amount';
  allocateFreight(built.rows, freightRial, allocMethod);
  const freightAdj = applyFreightToDocTotals(totals, freightRial, freight_type);
  let { subtotal, discAmt, vatAmount, vatRate } = totals;
  let { final, netBeforeVat } = freightAdj;
  const entryDate = date || todayJalali();
  const whId = warehouse_id ? parseInt(warehouse_id, 10) : null;
  if (whId) {
    for (const r of built.rows) {
      if (!r.warehouse_id) r.warehouse_id = whId;
    }
  }
  const prefixRow = db.prepare("SELECT value FROM settings WHERE key='purchase_num_prefix'").get();
  const pType = pay_type || 'credit';
  const ccId = cost_center_id ? parseInt(cost_center_id, 10) : null;
  let payPlan;
  try {
    payPlan = resolvePurchasePayments(req.body || {}, final);
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
  const storedPayType = payPlan.splits.length
    ? headerPayTypeFromSplits(payPlan.splits, pType, final)
    : pType;
  const payAmountRial = payPlan.splits.length
    ? payPlan.splits.reduce((a, s) => a + s.amount, 0)
    : 0;
  const chqDur = storedPayType === 'cheque' ? String(cheque_duration || '') : '';
  const chqDue = storedPayType === 'cheque' ? String(cheque_due_date || '') : '';
  const chqInfo = storedPayType === 'cheque' ? String(cheque_info || '') : '';
  try {
    resolveCashPaid(req.body || {}, final);
    if (storedPayType === 'cash' && !payPlan.splits.length) {
      assertCashBoxRequired('cash', cash_box_id);
    }
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message, code: e.code || 'E_CASH_BOX_REQUIRED' });
  }

  let created;
  try {
  created = db.transaction(() => {
    const num = isDevice()
      ? ('موقت-' + Date.now().toString(36).toUpperCase())
      : allocateNumber(db, 'purchase', prefixRow?.value || 'PO');
    const result = db.prepare(
      `INSERT INTO purchase_invoices (user_id,supplier_id,num,date,note,rows,subtotal,disc,disc_amt,final,vat_amount,vat_rate,pay_type,cheque_duration,cheque_due_date,cheque_info,stock_added,bank_id,check_category_id,cash_box_id,warehouse_id,freight_amount,freight_type,freight_alloc_method,vat_exempt,cost_center_id,pay_amount_rial)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?,?,?,?,?,?,?)`
    ).run(req.user.id, supplier_id, num, entryDate, note || '', JSON.stringify(built.rows), subtotal, discPct, discAmt, final, vatAmount, vatRate, storedPayType, chqDur, chqDue, chqInfo, bank_id || null, check_category_id || null, cash_box_id || null, whId, freightRial, freight_type || '', allocMethod, vat_exempt ? 1 : 0, ccId, payAmountRial);
    const invId = result.lastInsertRowid;

    const priced = buildInventoryValuationRows(built.rows, discAmt, freightChargedToCounterparty(freight_type));
    if (perpetualDocsEnabled(db)) {
      postPurchaseStockMovements(db, {
        rows: priced, warehouseId: whId, sourceType: 'purchase', sourceId: invId,
        userId: req.user.id, date: entryDate, note: `خرید ${num}`,
        supplierId: supplier_id,
      });
    } else {
      const { postStockMovement } = require('../lib/inventory/movement');
      let lineIdx = 0;
      for (const r of built.rows) {
        const rowWh = r.warehouse_id || whId;
        postStockMovement(db, {
          productId: r.product_id,
          variantId: r.variant_id || null,
          warehouseId: rowWh || null,
          qtyDelta: Number(r.qty) || 0,
          docType: 'purchase',
          docId: invId,
          docLine: lineIdx,
          userId: req.user.id,
          note: `افزودن موجودی از فاکتور خرید ${num}`,
          allowNegative: true,
        });
        lineIdx += 1;
        try {
          const fabric = require('../lib/inventory/fabric-rolls');
          if (fabric.isFabricPurchaseLine(db, r, rowWh)) {
            fabric.attachFabricIdentityOnPurchase(db, {
              row: r, movement: null, supplierId: supplier_id,
              user: req.user, date: entryDate, warehouseId: rowWh, sourceId: invId,
            });
          }
        } catch (e) {
          if (e && e.code && String(e.code).startsWith('E_FABRIC')) throw e;
        }
      }
    }

    createSupplierLedgerEntry(db, {
      supplier_id, date: date || '', entry_type: 'purchase', ref_type: 'purchase', ref_id: invId,
      description: `فاکتور خرید ${num}`, debit: 0, credit: final, user_id: req.user.id
    });

    assertJournalIdempotent(db, 'purchase', invId);
    const vatRec = coaAcct(db, 'coa_vat_receivable');
    const payable = payableAcct(db, supplier_id);
    // Typed inventory COA per destination warehouse (not bare coa_inventory).
    let invGroups = inventoryAmountLinesByWarehouse(db, priced.map((r) => ({
      warehouseId: r.warehouse_id || whId,
      amountRial: r.amount_rial,
    })));
    if (!invGroups.length) {
      const fallback = inventoryAccountForWarehouse(db, whId);
      invGroups = [{ code: fallback.code, name: fallback.name, amountRial: netBeforeVat }];
    } else {
      // Absorb rounding so inventory debits == netBeforeVat
      const sumInv = invGroups.reduce((s, g) => s + g.amountRial, 0);
      const drift = Math.round(netBeforeVat) - sumInv;
      if (drift !== 0) invGroups[invGroups.length - 1].amountRial += drift;
    }
    const jLines = invGroups.map((g) => ({
      code: g.code, name: g.name, debit: rialToLedger(g.amountRial), credit: 0,
    }));
    if (vatAmount > 0) jLines.push({ code: vatRec.code, name: vatRec.name, debit: rialToLedger(vatAmount), credit: 0, description: 'مالیات خرید' });
    jLines.push({ code: payable.code, name: payable.name, debit: 0, credit: rialToLedger(final) });
    assertJournalLinesBalanced(jLines, 'فاکتور خرید');
    postToLedger(db, {
      sourceType: 'purchase', sourceId: invId, date: entryDate,
      description: `فاکتور خرید ${num}${freightRial ? ' (با کرایه حمل)' : ''}`, createdBy: req.user.id, lines: jLines,
      costCenterId: ccId,
    });
    persistPurchasePayPlan(db, invId, payPlan, req.body || {});
    if (payPlan.splits.length) {
      applyPurchasePaySplits(db, {
        purchaseId: invId, supplierId: supplier_id, date: entryDate,
        splits: payPlan.splits, userId: req.user.id, num,
        chequeHeader: { cheque_info, cheque_due_date },
      });
    }
    return { invId, num };
  })();
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
  const { invId, num } = created;

  audit(req.user.id, 'create', 'purchase', invId, `ثبت فاکتور خرید ${num} به مبلغ ${final}`);
  res.json(db.prepare('SELECT p.*, s.name as supplier_name FROM purchase_invoices p LEFT JOIN suppliers s ON p.supplier_id=s.id WHERE p.id=?').get(invId));
});

router.delete('/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM purchase_invoices WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  if (row.status === 'reversed') return res.status(400).json({ error: 'این فاکتور خرید قبلاً ابطال شده است' });
  const activeReturns = db.prepare(
    "SELECT COUNT(*) AS c FROM purchase_returns WHERE purchase_invoice_id=? AND COALESCE(status,'posted')<>'reversed'"
  ).get(row.id).c;
  if (activeReturns > 0) {
    return res.status(400).json({ error: `این فاکتور ${activeReturns} برگشت از خرید فعال دارد — ابتدا برگشت را ابطال کنید` });
  }
  const activePays = db.prepare(
    "SELECT COUNT(*) AS c FROM supplier_payments WHERE purchase_invoice_id=? AND COALESCE(status,'posted')<>'reversed'"
  ).get(row.id).c;
  if (activePays > 0) {
    return res.status(400).json({ error: `این فاکتور ${activePays} پرداخت تأمین‌کننده فعال دارد — ابتدا پرداخت را ابطال کنید` });
  }

  db.transaction(() => {
    if (row.stock_added) {
      if (perpetualDocsEnabled(db)) {
        const reversed = reverseStockBySource(db, 'purchase', row.id, {
          createdBy: req.user.id, date: todayJalali(), note: `بازگشت موجودی از حذف فاکتور خرید ${row.num}`,
        });
        try {
          require('../lib/inventory/movement').reverseStockDocument(db, {
            docType: 'purchase_sku',
            docId: row.id,
            userId: req.user.id,
            note: `بازگشت رنگ×سایز از حذف فاکتور خرید ${row.num}`,
            applyHeaderStock: false,
          });
        } catch (_) { /* no sku layer on older docs */ }
        if (!reversed.length) {
          const invRows = JSON.parse(row.rows || '[]');
          for (const r of invRows) {
            const rowWh = r.warehouse_id || row.warehouse_id;
            db.prepare('UPDATE products SET stock=stock-? WHERE id=?').run(r.qty, r.product_id);
            db.prepare('INSERT INTO stock_logs (product_id,user_id,change,note) VALUES (?,?,?,?)').run(r.product_id, req.user.id, -r.qty, `بازگشت موجودی از حذف فاکتور خرید ${row.num}`);
            if (rowWh) {
              db.prepare('UPDATE warehouse_stock SET qty=qty-? WHERE product_id=? AND warehouse_id=?').run(r.qty, r.product_id, rowWh);
            }
          }
        }
      } else {
        const { reverseStockDocument, postStockMovement } = require('../lib/inventory/movement');
        const reversed = reverseStockDocument(db, {
          docType: 'purchase', docId: row.id, userId: req.user.id,
          note: `بازگشت موجودی از حذف فاکتور خرید ${row.num}`,
        });
        if (!reversed.length) {
          const invRows = JSON.parse(row.rows || '[]');
          let lineIdx = 0;
          for (const r of invRows) {
            const rowWh = r.warehouse_id || row.warehouse_id;
            postStockMovement(db, {
              productId: r.product_id,
              variantId: r.variant_id || null,
              warehouseId: rowWh || null,
              qtyDelta: -(Number(r.qty) || 0),
              docType: 'purchase_void',
              docId: row.id,
              docLine: lineIdx,
              userId: req.user.id,
              note: `بازگشت موجودی از حذف فاکتور خرید ${row.num}`,
              allowNegative: true,
            });
            lineIdx += 1;
          }
        }
      }
    }
    const purchaseLed = db.prepare(
      "SELECT credit FROM supplier_ledger WHERE supplier_id=? AND ref_type='purchase' AND ref_id=? AND entry_type='purchase' LIMIT 1"
    ).get(row.supplier_id, row.id);
    const payLed = db.prepare(
      "SELECT debit FROM supplier_ledger WHERE supplier_id=? AND ref_type='purchase' AND ref_id=? AND entry_type='payment' LIMIT 1"
    ).get(row.supplier_id, row.id);
    // v373: retire supplier books — no hollow «ابطال/اصلاح» on statements.
    const { retireSupplierLedgerByRef } = require('../lib/party-ledger-retire');
    retireSupplierLedgerByRef(db, {
      refTypes: ['purchase', 'purchase_invoice'],
      refId: row.id,
      supplierId: row.supplier_id,
    });
    const origJe = db.prepare(`
      SELECT id FROM journal_entries
      WHERE ref_type='purchase' AND ref_id=? AND COALESCE(deleted_at,0)=0
      ORDER BY id ASC LIMIT 1
    `).get(row.id);
    let reversalId = origJe
      ? reverseJournalEntry(db, origJe.id, {
          userId: req.user.id, date: todayJalali(),
          reason: `ابطال فاکتور خرید ${row.num}`,
          sourceType: 'purchase_reversal',
        })
      : null;
    if (!reversalId) {
      const hasNewShape = !!purchaseLed;
      const payTypeResolved = row.pay_type === 'bank_transfer' ? 'bank' : row.pay_type;
      const payable = payableAcct(db, row.supplier_id);
      const invAcct = inventoryAccountForWarehouse(db, row.warehouse_id);
      const vatRec = coaAcct(db, 'coa_vat_receivable');
      const netBeforeVat = (row.subtotal || 0) - (row.disc_amt || 0)
        + (freightChargedToCounterparty(row.freight_type) ? Math.round(row.freight_amount || 0) : 0);
      const paidAmt = Math.round(Number(payLed && payLed.debit) || Number(row.pay_amount_rial) || 0);
      const revLines = [];
      if (hasNewShape) {
        revLines.push({ code: payable.code, name: payable.name, debit: rialToLedger(row.final), credit: 0 });
        revLines.push({ code: invAcct.code, name: invAcct.name, debit: 0, credit: rialToLedger(netBeforeVat) });
        if (row.vat_amount > 0) revLines.push({ code: vatRec.code, name: vatRec.name, debit: 0, credit: rialToLedger(row.vat_amount), description: 'ابطال VAT خرید' });
        if (paidAmt > 0) {
          const cash = resolveCashAccount(db, payTypeResolved, row.bank_id, row.cash_box_id);
          revLines.push({ code: payable.code, name: payable.name, debit: 0, credit: rialToLedger(paidAmt), description: 'ابطال پرداخت هنگام خرید' });
          revLines.push({ code: cash.code, name: cash.name, debit: rialToLedger(paidAmt), credit: 0, description: 'ابطال پرداخت هنگام خرید' });
        }
      } else {
        const cr = row.pay_type === 'credit' ? payable : resolveCashAccount(db, payTypeResolved, row.bank_id, row.cash_box_id);
        revLines.push({ code: cr.code, name: cr.name, debit: rialToLedger(row.final), credit: 0 });
        revLines.push({ code: invAcct.code, name: invAcct.name, debit: 0, credit: rialToLedger(netBeforeVat) });
        if (row.vat_amount > 0) revLines.push({ code: vatRec.code, name: vatRec.name, debit: 0, credit: rialToLedger(row.vat_amount), description: 'ابطال VAT خرید' });
      }
      reversalId = postToLedger(db, {
        sourceType: 'purchase_reversal', sourceId: row.id,
        date: todayJalali(), description: `ابطال فاکتور خرید ${row.num}`, createdBy: req.user.id,
        lines: revLines,
      });
    }

    db.prepare("UPDATE purchase_invoices SET status='reversed',stock_added=0,reversal_journal_id=?,reversed_at=strftime('%s','now'),reversed_by=? WHERE id=?")
      .run(reversalId, req.user.id, row.id);
    try {
      const { unlinkWarehouseGrniOnPurchaseVoid } = require('../lib/warehouse-grni-invoice');
      unlinkWarehouseGrniOnPurchaseVoid(db, row.id, {
        userId: req.user.id,
        reason: `ابطال فاکتور خرید ${row.num}`,
      });
    } catch (unlinkErr) {
      console.warn('unlinkWarehouseGrniOnPurchaseVoid:', unlinkErr && unlinkErr.message);
    }
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
    WHERE COALESCE(pr.status,'posted')<>'reversed' ORDER BY pr.date DESC, pr.id DESC
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
  const {
    lineOrigDiscAmt, priorHeaderDiscConsumed, priorVatConsumed, rial,
  } = require('../lib/returns-discount');
  const { invoiceNetBase, invoiceSourceVat } = require('../lib/returns-posting');
  const alreadyReturned = {};
  db.prepare("SELECT id, rows FROM purchase_returns WHERE purchase_invoice_id=? AND COALESCE(status,'posted')<>'reversed'").all(req.params.invoiceId).forEach(pr => {
    try {
      JSON.parse(pr.rows || '[]').forEach(r => {
        const key = purchaseLineKey(r);
        alreadyReturned[key] = (alreadyReturned[key] || 0) + r.qty;
      });
    } catch (_) { /* ignore bad JSON */ }
  });
  const rows = invRows.map(r => {
    const key = purchaseLineKey(r);
    const already = alreadyReturned[key] || 0;
    const lineDisc = lineOrigDiscAmt(r);
    const netUnit = (Number(r.qty) || 0) > 0
      ? Math.max(0, rial((Number(r.price) || 0) - (lineDisc / (Number(r.qty) || 1))))
      : rial(r.price);
    return {
      ...r,
      line_key: key,
      already_returned: already,
      max_returnable: r.qty - already,
      line_disc_amt: lineDisc,
      net_unit: netUnit,
      disc: r.disc || 0,
      disc_amt: r.disc_amt != null ? r.disc_amt : (r.disc_amount != null ? r.disc_amount : lineDisc),
    };
  }).filter(r => r.max_returnable > 0);
  const hdrUsed = priorHeaderDiscConsumed(db, {
    table: 'purchase_returns', invoiceCol: 'purchase_invoice_id', invoiceId: inv.id,
    invoiceDiscAmt: inv.disc_amt, invoiceSubtotal: inv.subtotal, excludeReturnId: null,
  });
  const vatUsed = priorVatConsumed(db, {
    table: 'purchase_returns', invoiceCol: 'purchase_invoice_id', invoiceId: inv.id,
  });
  const sourceVat = invoiceSourceVat(inv);
  res.json({
    invoice: inv,
    rows,
    discount: {
      hdr_disc_amt: rial(inv.disc_amt),
      hdr_disc_remaining: Math.max(0, rial(inv.disc_amt) - hdrUsed),
      vat_remaining: Math.max(0, sourceVat - vatUsed),
      subtotal: rial(inv.subtotal),
      net_base: invoiceNetBase(inv),
    },
  });
});

router.post('/returns', auth, adminOrAccounting, (req, res) => {
  const {
    supplier_id, purchase_invoice_id, date, note, rows, reason_code,
    extra_disc_amt, extra_disc_pct, disc_extra_amt, disc_extra_pct,
  } = req.body;
  if (!supplier_id) return res.status(400).json({ error: 'تأمین‌کننده الزامی است' });
  const db = getDB();
  const reasonCode = String(reason_code || '').trim().slice(0, 40);
  const {
    prorateLineDiscount, priorHeaderDiscConsumed, priorVatConsumed,
    computeReturnTotals, rial,
  } = require('../lib/returns-discount');

  let invoiceLineMap = null, alreadyReturnedMap = {};
  let invRow = null;
  if (purchase_invoice_id) {
    invRow = db.prepare('SELECT * FROM purchase_invoices WHERE id=? AND supplier_id=?').get(purchase_invoice_id, supplier_id);
    if (!invRow) return res.status(400).json({ error: 'فاکتور خرید یافت نشد یا متعلق به این تأمین‌کننده نیست' });
    invoiceLineMap = {};
    JSON.parse(invRow.rows || '[]').forEach(r => { invoiceLineMap[purchaseLineKey(r)] = r; });
    db.prepare("SELECT rows FROM purchase_returns WHERE purchase_invoice_id=? AND COALESCE(status,'posted')<>'reversed'").all(purchase_invoice_id).forEach(pr => {
      JSON.parse(pr.rows || '[]').forEach(r => {
        const key = purchaseLineKey(r);
        alreadyReturnedMap[key] = (alreadyReturnedMap[key] || 0) + r.qty;
      });
    });
  }

  let built;
  try {
    if (invoiceLineMap) {
      built = { rows: [], subtotal: 0 };
      for (const r of (rows || [])) {
        const pid = parseInt(r.product_id);
        const prod = db.prepare('SELECT * FROM products WHERE id=?').get(pid);
        if (!prod) return res.status(400).json({ error: `محصول یافت نشد (شناسه ${pid})` });
        const origLine = findPurchaseOrigLine(invoiceLineMap, r);
        if (!origLine) return res.status(400).json({ error: `کالای ${prod.name} در این فاکتور خرید وجود ندارد` });
        const already = alreadyReturnedMap[purchaseLineKey(origLine)] || alreadyReturnedMap[purchaseLineKey(r)] || 0;
        const maxReturnable = origLine.qty - already;
        const qty = Math.max(0.001, parseQty(r.qty, 1));
        if (qty > maxReturnable) return res.status(400).json({ error: `حداکثر مقدار قابل برگشت برای ${prod.name}: ${maxReturnable}` });
        const price = origLine.price;
        const prDisc = prorateLineDiscount(origLine, qty, already);
        const sum = rial(qty * price - prDisc.discAmt);
        const unitLanded = (Number(origLine.qty) || 0) > 0 && Number(origLine.amount_rial) > 0
          ? rial(Number(origLine.amount_rial) / Number(origLine.qty))
          : rial(sum / qty);
        built.rows.push({
          product_id: pid,
          name: prod.name,
          qty, price, sum,
          disc: prDisc.discPct,
          disc_amt: prDisc.discAmt,
          line_key: purchaseLineKey(origLine),
          batch_id: origLine.batch_id || null,
          is_fabric_roll: origLine.is_fabric_roll || 0,
          color: origLine.color_name || origLine.color || '',
          color_name: origLine.color_name || origLine.color || '',
          size_name: origLine.size_name || '',
          pattern: origLine.pattern || '',
          width_cm: origLine.width_cm || 0,
          roll_no: origLine.roll_no || '',
          unit_cost_rial: unitLanded || origLine.unit_cost_rial || 0,
          warehouse_id: origLine.warehouse_id || null,
          variant_id: origLine.variant_id || null,
        });
        built.subtotal += sum;
      }
      if (!built.rows.length) return res.status(400).json({ error: 'حداقل یک ردیف لازم است' });
    } else {
      built = buildRows(db, rows);
      if (!built.rows.length) return res.status(400).json({ error: 'حداقل یک ردیف لازم است' });
    }
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message, code: e.code });
  }

  const goodsAmountA = rial(built.subtotal);
  let remainingGoodsOnInvoice = null;
  if (invoiceLineMap) {
    remainingGoodsOnInvoice = 0;
    Object.values(invoiceLineMap).forEach((ol) => {
      const already = alreadyReturnedMap[purchaseLineKey(ol)] || 0;
      const remQty = Math.max(0, (Number(ol.qty) || 0) - already);
      if (remQty <= 0) return;
      const { discAmt } = prorateLineDiscount(ol, remQty, already);
      remainingGoodsOnInvoice += rial(remQty * (Number(ol.price) || 0) - discAmt);
    });
  }

  const {
    settingFlag, invoiceNetBase, invoiceSourceVat, buildPurchaseReturnJournalLines,
  } = require('../lib/returns-posting');
  let totals;
  try {
    if (purchase_invoice_id && invRow) {
      const priorHdr = priorHeaderDiscConsumed(db, {
        table: 'purchase_returns', invoiceCol: 'purchase_invoice_id', invoiceId: purchase_invoice_id,
        invoiceDiscAmt: invRow.disc_amt, invoiceSubtotal: invRow.subtotal,
      });
      const priorVat = priorVatConsumed(db, {
        table: 'purchase_returns', invoiceCol: 'purchase_invoice_id', invoiceId: purchase_invoice_id,
      });
      totals = computeReturnTotals({
        goodsAmountA,
        invoiceDiscAmt: invRow.disc_amt,
        invoiceSubtotal: invRow.subtotal,
        priorHdrUsed: priorHdr,
        remainingGoodsOnInvoice,
        extraDiscAmt: extra_disc_amt != null ? extra_disc_amt : disc_extra_amt,
        extraDiscPct: extra_disc_pct != null ? extra_disc_pct : disc_extra_pct,
        sourceVat: invoiceSourceVat(invRow),
        sourceNetBase: invoiceNetBase(invRow),
        vatSettingOn: settingFlag(db, 'returns_reverse_vat', true),
        priorVatUsed: priorVat,
      });
    } else {
      totals = computeReturnTotals({
        goodsAmountA,
        invoiceDiscAmt: 0, invoiceSubtotal: 0, priorHdrUsed: 0,
        remainingGoodsOnInvoice: null,
        extraDiscAmt: extra_disc_amt != null ? extra_disc_amt : disc_extra_amt,
        extraDiscPct: extra_disc_pct != null ? extra_disc_pct : disc_extra_pct,
        sourceVat: 0, sourceNetBase: 0, vatSettingOn: false, priorVatUsed: 0,
      });
    }
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message, code: e.code });
  }

  const amount = totals.amount;
  const retId = db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO purchase_returns (
        user_id,supplier_id,purchase_invoice_id,date,note,rows,amount,reason_code,
        goods_amount,hdr_disc_amt,extra_disc_amt,extra_disc_pct,vat_amount
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      req.user.id, supplier_id, purchase_invoice_id || null, date || todayJalali(), note || '',
      JSON.stringify(built.rows), amount, reasonCode,
      totals.goodsAmount, totals.hdrDiscAmt, totals.extraDiscAmt, totals.extraDiscPct || 0, totals.vatAmount
    );
    const retId = result.lastInsertRowid;
    const parent = purchase_invoice_id
      ? db.prepare('SELECT warehouse_id FROM purchase_invoices WHERE id=?').get(purchase_invoice_id)
      : null;

    const invCreditTotal = Math.max(0, totals.goodsAmount - totals.hdrDiscAmt);
    if (perpetualDocsEnabled(db)) {
      for (const r of built.rows) {
        const whId = r.warehouse_id || parent?.warehouse_id || null;
        const lineShare = goodsAmountA > 0
          ? rial(invCreditTotal * (rial(r.sum) / goodsAmountA))
          : rial((Number(r.qty) || 0) * (Number(r.unit_cost_rial) || Number(r.price) || 0));
        const unitCost = (Number(r.qty) || 0) > 0 ? rial(lineShare / Number(r.qty)) : 0;
        postInventoryMovement(db, {
          eventType: 'purchase_return',
          productId: r.product_id,
          warehouseId: whId,
          qtyOut: Number(r.qty) || 0,
          unitCostRial: unitCost || Math.round(Number(r.unit_cost_rial) || Number(r.price) || 0),
          sourceType: 'purchase_return',
          sourceId: retId,
          date: date || todayJalali(),
          note: `برگشت از خرید #${retId}`,
          createdBy: req.user.id,
          updateAvg: true,
          batchId: r.batch_id || null,
        });
        if (!r.batch_id) {
          require('../lib/inventory/movement').postVariantLayer(db, {
            productId: r.product_id,
            variantId: r.variant_id || null,
            warehouseId: whId,
            qtyDelta: -(Number(r.qty) || 0),
            docType: 'purchase_return_sku',
            docId: retId,
            docLine: built.rows.indexOf(r),
            userId: req.user.id,
            note: `برگشت از خرید #${retId} / رنگ×سایز`,
            allowNegative: true,
          });
        }
      }
    } else {
      for (const r of built.rows) {
        db.prepare('UPDATE products SET stock=stock-? WHERE id=?').run(r.qty, r.product_id);
        db.prepare('INSERT INTO stock_logs (product_id,user_id,change,note) VALUES (?,?,?,?)').run(r.product_id, req.user.id, -r.qty, `برگشت از خرید #${retId}`);
      }
    }

    const vatAmount = totals.vatAmount;
    const gross = amount + vatAmount;
    createSupplierLedgerEntry(db, {
      supplier_id, date: date || todayJalali(), entry_type: 'purchase_return', ref_type: 'purchase_return', ref_id: retId,
      description: `برگشت از خرید #${retId}`, debit: gross, credit: 0, user_id: req.user.id
    });
    assertJournalIdempotent(db, 'purchase_return', retId);
    const costItems = built.rows.map((r) => {
      const whId = r.warehouse_id || parent?.warehouse_id || null;
      const lineShare = goodsAmountA > 0
        ? rial(invCreditTotal * (rial(r.sum) / goodsAmountA))
        : rial((Number(r.qty) || 0) * (Number(r.price) || 0));
      return { warehouseId: whId, amountRial: lineShare };
    }).filter((x) => x.amountRial > 0);
    postToLedger(db, {
      sourceType: 'purchase_return', sourceId: retId,
      date: date || todayJalali(), description: `برگشت از خرید #${retId}`, createdBy: req.user.id,
      lines: buildPurchaseReturnJournalLines(db, {
        supplierId: supplier_id,
        amountNet: amount,
        goodsAmount: totals.goodsAmount,
        hdrDiscAmt: totals.hdrDiscAmt,
        extraDiscAmt: totals.extraDiscAmt,
        inventoryAmount: invCreditTotal,
        vatAmount,
        costItems,
      }),
    });
    return retId;
  })();

  if (purchase_invoice_id) recomputePurchaseInvoiceSettledBalances(db, purchase_invoice_id);
  else {
    try {
      const { autoAllocateIfEnabled, SIDE_PURCHASE } = require('../lib/return-credit-allocate');
      autoAllocateIfEnabled(db, { side: SIDE_PURCHASE, returnId: retId, userId: req.user.id });
    } catch (e) {
      console.warn('purchase-return auto-allocate:', e && e.message);
    }
  }
  audit(req.user.id, 'create', 'purchase_return', retId, `برگشت از خرید به مبلغ ${amount}`);
  res.json({ id: retId, ok: true, amount });
});

router.get('/returns/:id/allocations', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM purchase_returns WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  const {
    listAllocationsForReturn, unallocatedGrossRial, returnGrossRial, SIDE_PURCHASE,
  } = require('../lib/return-credit-allocate');
  res.json({
    return_id: row.id,
    purchase_invoice_id: row.purchase_invoice_id,
    gross_rial: returnGrossRial(row),
    unallocated_rial: row.purchase_invoice_id ? 0 : unallocatedGrossRial(db, SIDE_PURCHASE, row),
    allocations: listAllocationsForReturn(db, SIDE_PURCHASE, row.id),
  });
});

router.post('/returns/:id/allocate', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  try {
    const { allocateReturnCredit, SIDE_PURCHASE } = require('../lib/return-credit-allocate');
    const body = req.body || {};
    const allocations = Array.isArray(body.allocations)
      ? body.allocations
      : ((body.invoice_id || body.purchase_invoice_id)
        ? [{ invoice_id: body.invoice_id || body.purchase_invoice_id, amount_rial: body.amount_rial || body.amount }]
        : []);
    const out = allocateReturnCredit(db, {
      side: SIDE_PURCHASE,
      returnId: parseInt(req.params.id, 10),
      allocations,
      userId: req.user.id,
      note: body.note || '',
    });
    audit(req.user.id, 'allocate', 'purchase_return', req.params.id, `تخصیص بدهکار برگشت به ${out.recomputed.length} فاکتور خرید`);
    res.json({ ok: true, ...out });
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
});

router.delete('/returns/:id/allocations/:allocId', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  try {
    const { reverseAllocation, SIDE_PURCHASE } = require('../lib/return-credit-allocate');
    const out = reverseAllocation(db, {
      side: SIDE_PURCHASE,
      allocId: parseInt(req.params.allocId, 10),
      userId: req.user.id,
    });
    audit(req.user.id, 'void_allocate', 'purchase_return', req.params.id, `ابطال تخصیص #${req.params.allocId}`);
    res.json(out);
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
});

router.delete('/returns/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM purchase_returns WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  if (row.status === 'reversed') return res.status(400).json({ error: 'این برگشت خرید قبلاً ابطال شده است' });
  db.transaction(() => {
    const { buildPurchaseReturnJournalLines, costItemsFromLedger } = require('../lib/returns-posting');
    let costItems = costItemsFromLedger(db, 'purchase_return', row.id);
    if (!costItems.length) {
      const invRows = JSON.parse(row.rows || '[]');
      const parentInv = row.purchase_invoice_id
        ? db.prepare('SELECT warehouse_id FROM purchase_invoices WHERE id=?').get(row.purchase_invoice_id)
        : null;
      costItems = invRows.map((r) => ({
        warehouseId: r.warehouse_id || parentInv?.warehouse_id || null,
        amountRial: Math.round((Number(r.qty) || 0) * (Number(r.price) || 0)),
      })).filter((x) => x.amountRial > 0);
      if (!costItems.length && Number(row.amount) > 0) {
        costItems = [{ warehouseId: parentInv?.warehouse_id || null, amountRial: Math.round(Number(row.amount) || 0) }];
      }
    }
    if (perpetualDocsEnabled(db)) {
      const reversed = reverseStockBySource(db, 'purchase_return', row.id, {
        createdBy: req.user.id, date: todayJalali(), note: `ابطال برگشت از خرید #${row.id}`,
      });
      try {
        require('../lib/inventory/movement').reverseStockDocument(db, {
          docType: 'purchase_return_sku',
          docId: row.id,
          userId: req.user.id,
          note: `ابطال رنگ×سایز برگشت از خرید #${row.id}`,
          applyHeaderStock: false,
        });
      } catch (_) { /* older returns have no sku layer */ }
      if (!reversed.length) {
        const invRows = JSON.parse(row.rows || '[]');
        for (const r of invRows) {
          db.prepare('UPDATE products SET stock=stock+? WHERE id=?').run(r.qty, r.product_id);
          db.prepare('INSERT INTO stock_logs (product_id,user_id,change,note) VALUES (?,?,?,?)').run(r.product_id, req.user.id, r.qty, `ابطال برگشت از خرید #${row.id}`);
        }
      }
    } else {
      const invRows = JSON.parse(row.rows || '[]');
      for (const r of invRows) {
        db.prepare('UPDATE products SET stock=stock+? WHERE id=?').run(r.qty, r.product_id);
        db.prepare('INSERT INTO stock_logs (product_id,user_id,change,note) VALUES (?,?,?,?)').run(r.product_id, req.user.id, r.qty, `ابطال برگشت از خرید #${row.id}`);
      }
    }
    const { returnMoneyParts } = require('../lib/returns-discount');
    const parts = returnMoneyParts(row);
    const {
      amountNet, vatAmount, gross, goodsAmount, hdrDiscAmt, extraDiscAmt,
    } = parts;
    const { retireSupplierLedgerByRef } = require('../lib/party-ledger-retire');
    retireSupplierLedgerByRef(db, {
      refTypes: ['purchase_return', 'purchase_return_reversal'],
      refId: row.id,
      supplierId: row.supplier_id,
    });
    const reversalId = postToLedger(db, {
      sourceType: 'purchase_return_reversal', sourceId: row.id,
      date: todayJalali(), description: `ابطال برگشت از خرید #${row.id}`, createdBy: req.user.id,
      lines: buildPurchaseReturnJournalLines(db, {
        supplierId: row.supplier_id,
        amountNet,
        goodsAmount,
        hdrDiscAmt,
        extraDiscAmt,
        inventoryAmount: Math.max(0, goodsAmount - hdrDiscAmt),
        vatAmount,
        costItems,
        reverse: true,
      }),
    });
    db.prepare("UPDATE purchase_returns SET status='reversed',reversal_journal_id=?,reversed_at=strftime('%s','now'),reversed_by=? WHERE id=?")
      .run(reversalId, req.user.id, row.id);
    try {
      const { reverseAllocationsForReturn, SIDE_PURCHASE } = require('../lib/return-credit-allocate');
      reverseAllocationsForReturn(db, SIDE_PURCHASE, row.id, req.user.id);
    } catch (_) { /* older DBs */ }
  })();
  if (row.purchase_invoice_id) recomputePurchaseInvoiceSettledBalances(db, row.purchase_invoice_id);
  else {
    try {
      const all = db.prepare(`
        SELECT DISTINCT invoice_id FROM return_credit_allocations
        WHERE side='purchase' AND return_id=?
      `).all(row.id);
      for (const a of all) recomputePurchaseInvoiceSettledBalances(db, a.invoice_id);
    } catch (_) { /* ignore */ }
  }
  res.json({ ok: true });
});

// ---------------- Supplier payments (mirrors customer settlements) ----------------

router.get('/payments/list', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const rows = db.prepare(`
    SELECT sp.*, s.name as supplier_name FROM supplier_payments sp
    LEFT JOIN suppliers s ON sp.supplier_id=s.id
    WHERE COALESCE(sp.status,'posted')<>'reversed' ORDER BY sp.date DESC, sp.id DESC LIMIT 300
  `).all();
  res.json(rows);
});

router.post('/payments', auth, adminOrAccounting, (req, res) => {
  const {
    supplier_id, purchase_invoice_id, note, check_category_id, account_code,
    fee_cost_center_id, bank_fee_cost_center_id,
  } = req.body;
  if (!supplier_id) return res.status(400).json({ error: 'تأمین‌کننده الزامی است' });
  const db = getDB();
  try {
    const {
      assertOutboundPayment, cashAccountForSource, withPaymentIdempotency,
    } = require('../lib/cash-payment-contract');
    const { assertPurchaseRoom } = require('../lib/amend-cash-ops');
    const spec = assertOutboundPayment(db, req.body);
    const feeCcId = resolveFeeCostCenterId(db, {
      feeRial: spec.fee, payType: spec.payType,
      feeCostCenterId: parseFeeCostCenterInput({ fee_cost_center_id, bank_fee_cost_center_id }),
    });
    const cash = cashAccountForSource(db, spec);
    const overrideCode = String(account_code || '').trim();
    if (overrideCode && overrideCode !== cash.code) {
      return res.status(400).json({
        error: 'حساب معین با صندوق یا بانک انتخاب‌شده یکی نیست و نادیده گرفته نمی‌شود',
        code: 'E_PAY_SOURCE',
      });
    }
    const out = withPaymentIdempotency(db, {
      key: req.body.idempotency_key, userId: req.user.id, path: '/api/purchases/payments', body: req.body,
    }, () => {
      assertOutboundPayment(db, req.body);
      const ids = [];
      const payable = payableAcct(db, supplier_id);
      spec.amounts.forEach((amount, i) => {
        const fee = i === 0 ? spec.fee : 0;
        if (purchase_invoice_id) {
          assertPurchaseRoom(db, purchase_invoice_id, 0, supplier_id, amount, 'supplier');
        }
        const result = db.prepare(
          'INSERT INTO supplier_payments (supplier_id,purchase_invoice_id,amount,fee_rial,pay_type,date,note,created_by,bank_id,check_category_id,cash_box_id,account_code,fee_cost_center_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
        ).run(supplier_id, purchase_invoice_id || null, amount, fee, spec.payType, spec.date, note || '', req.user.id, spec.bankId, check_category_id || null, spec.cashBoxId, cash.code, i === 0 ? feeCcId : null);
        const payId = result.lastInsertRowid;
        createSupplierLedgerEntry(db, {
          supplier_id, date: spec.date, entry_type: 'payment', ref_type: 'supplier_payment', ref_id: payId,
          description: `پرداخت به تأمین‌کننده — ${amount.toLocaleString('fa-IR')} ریال`, debit: amount, credit: 0, user_id: req.user.id,
        });
        const { lines } = outboundPaymentLines(db, {
          amount, feeRial: fee, payType: spec.payType,
          dest: payable, cash, feeCostCenterId: i === 0 ? feeCcId : null,
        });
        postToLedger(db, {
          sourceType: 'supplier_payment', sourceId: payId,
          date: spec.date, description: 'پرداخت به تأمین‌کننده', createdBy: req.user.id,
          lines,
        });
        ids.push(payId);
      });
      return { id: ids[0], ids, ok: true, fee_rial: spec.fee };
    });
    if (purchase_invoice_id) recomputePurchaseInvoiceSettledBalances(db, purchase_invoice_id);
    if (!out.replayed) {
      audit(req.user.id, 'create', 'supplier_payment', out.id, `پرداخت ${spec.amounts.join('+')} ریال به تأمین‌کننده`);
      try {
        const { dispatchSmsEvent } = require('../lib/sms-dispatch');
        const sup = db.prepare('SELECT name,phone,party_group_id FROM suppliers WHERE id=?').get(supplier_id)
          || db.prepare('SELECT full_name as name, phone, party_group_id FROM parties WHERE id=?').get(supplier_id);
        setImmediate(() => dispatchSmsEvent(db, 'payment.created', {
          phone: sup?.phone,
          name: sup?.name,
          amount: spec.amounts.reduce((a, b) => a + b, 0),
          date: spec.date,
          note: note || '',
          party_group_id: sup?.party_group_id,
          created_by: req.user.id,
          user: req.user.name,
        }));
      } catch (_) {}
    }
    res.json(out);
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error('supplier-payment', e);
    res.status(status).json({ error: e.message || 'ثبت پرداخت تأمین‌کننده ناموفق بود', code: e.code });
  }
});

router.delete('/payments/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM supplier_payments WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  if (row.status === 'reversed') return res.status(400).json({ error: 'این پرداخت قبلاً ابطال شده است' });
  db.transaction(() => {
    const { retireSupplierLedgerByRef } = require('../lib/party-ledger-retire');
    retireSupplierLedgerByRef(db, {
      refTypes: ['supplier_payment'],
      refId: row.id,
      supplierId: row.supplier_id,
    });
    let cash = resolveCashAccount(db, row.pay_type, row.bank_id, row.cash_box_id);
    const overrideCode = String(row.account_code || '').trim();
    if (overrideCode) {
      const acctRow = db.prepare('SELECT code,name FROM chart_of_accounts WHERE code=?').get(overrideCode);
      if (acctRow) cash = { code: acctRow.code, name: acctRow.name };
    }
    const payable = payableAcct(db, row.supplier_id);
    const { lines } = outboundPaymentReversalLines(db, {
      amount: row.amount, feeRial: row.fee_rial || 0, dest: payable, cash,
      feeCostCenterId: row.fee_cost_center_id || null,
    });
    const reversalId = postToLedger(db, {
      sourceType: 'supplier_payment_reversal', sourceId: row.id,
      date: todayJalali(), description: `ابطال پرداخت به تأمین‌کننده #${row.id}`, createdBy: req.user.id,
      lines,
    });
    try {
      db.prepare(`
        UPDATE journal_entries SET status='reversed'
        WHERE ref_type='supplier_payment' AND ref_id=? AND COALESCE(deleted_at,0)=0 AND id<>?
      `).run(row.id, reversalId);
    } catch (_) {}
    db.prepare("UPDATE supplier_payments SET status='reversed',reversal_journal_id=?,reversed_at=strftime('%s','now'),reversed_by=? WHERE id=?")
      .run(reversalId, req.user.id, row.id);
  })();
  if (row.purchase_invoice_id) recomputePurchaseInvoiceSettledBalances(db, row.purchase_invoice_id);
  res.json({ ok: true });
});

router.put('/payments/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  try {
    const { amendSupplierPayment } = require('../lib/amend-cash-ops');
    const out = db.transaction(() => amendSupplierPayment(db, +req.params.id, req.body || {}, req.user.id))();
    audit(req.user.id, 'update', 'supplier_payment', out.id, out.summary);
    res.json({ ok: true, id: out.id, amount: out.amount });
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error('amend supplier payment', e);
    res.status(status).json({ error: e.message || 'اصلاح پرداخت تأمین‌کننده ناموفق بود', code: e.code });
  }
});

// Supplier ledger (statement) — mirrors /accounting/ledger/:customerId
router.get('/ledger/:supplierId', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const supplier = db.prepare('SELECT id,name,phone FROM suppliers WHERE id=?').get(req.params.supplierId);
  if (!supplier) return res.status(404).json({ error: 'تأمین‌کننده یافت نشد' });
  const entries = db.prepare(`
    SELECT sl.*, u.name as user_name FROM supplier_ledger sl LEFT JOIN users u ON sl.user_id=u.id
    WHERE sl.supplier_id=? ORDER BY sl.date ASC, sl.created_at ASC, sl.id ASC
  `).all(req.params.supplierId);
  require('../lib/report-order').sortReportRows(entries, { date: 'date', dir: 'asc' });
  let balance = 0;
  entries.forEach(e => { balance += (e.credit || 0) - (e.debit || 0); e.running_balance = balance; });
  res.json({ supplier, entries, balance });
});

router.purchaseLineKey = purchaseLineKey;
module.exports = router;
