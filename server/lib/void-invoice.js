/**
 * Full invoice void / cancel (R12 + R13).
 * - Cascades settlement reversals
 * - Reverses stock, sales JE, COGS, invoice-basis commission
 * - Converted proforma → restores active proforma (un-convert)
 * - Direct final → soft reverse (status=reversed + deleted_at)
 */
const { audit } = require('../db');
const { acct } = require('./coa-map');
const { postToLedger } = require('./ledger');
const { rialToLedger } = require('./money');
const { reverseCommissionAccrual } = require('./rep-ledger');
const { reverseSettlementInTx } = require('./void-settlement');
const { todayJalali } = require('../jalali');
const notif = require('./notifications');
const { persistPrivateUpload } = require('./private-uploads');
const { reverseStockBySource, postCogsFromMovements, isFirmSale, perpetualDocsEnabled } = require('./sales-document');
const { salesJournalLines, reverseInvoiceCustomerLedger } = require('./customer-books');

function cancelTitleForRole(role) {
  if (role === 'admin') return 'فاکتور لغو شده توسط مدیر';
  if (role === 'accounting') return 'فاکتور لغو شده توسط حسابداری';
  if (role === 'sales_manager') return 'فاکتور لغو شده توسط مدیر فروش';
  return 'فاکتور لغو شده توسط کاربر';
}

function postCogsVoucher(db, invId, num, date, rows, userId, reverse) {
  const on = db.prepare("SELECT value FROM settings WHERE key='feature_cogs_voucher'").get();
  if (!on || on.value !== '1') return;
  if (reverse) {
    const orig = db.prepare("SELECT id FROM journal_entries WHERE ref_type='invoice_cogs' AND ref_id=? AND COALESCE(deleted_at,0)=0").get(invId);
    if (!orig) return;
  }
  const { parseQty } = require('./round3');
  const lines = [];
  let total = 0;
  for (const r of rows || []) {
    const p = db.prepare('SELECT cost,average_cost_rial,coa_code,name FROM products WHERE id=?').get(r.product_id);
    if (!p || !p.coa_code) continue;
    const unitRial = Number(p.average_cost_rial) > 0 ? Number(p.average_cost_rial) : (Number(p.cost) || 0);
    const amtRial = Math.round(unitRial * (parseQty(r.qty) || 0));
    if (amtRial <= 0) continue;
    const amt = rialToLedger(amtRial);
    total += amt;
    lines.push({ code: p.coa_code, name: p.name, debit: reverse ? amt : 0, credit: reverse ? 0 : amt });
  }
  if (!total) return;
  const cogs = acct(db, 'coa_cogs');
  lines.unshift({ code: cogs.code, name: cogs.name, debit: reverse ? 0 : total, credit: reverse ? total : 0 });
  postToLedger(db, {
    sourceType: reverse ? 'invoice_cogs_reversal' : 'invoice_cogs', sourceId: invId,
    date: date || todayJalali(), description: `بهای تمام‌شده فاکتور ${num}${reverse ? ' (ابطال)' : ''}`,
    createdBy: userId, lines,
  });
}

/**
 * @returns {{ restoredToProforma: boolean, invoice: object, title: string, settlementsReversed: number }}
 * @throws Error with .status = 400/404/422
 */
function voidInvoiceFully(db, invId, user, opts = {}) {
  const id = typeof invId === 'object' ? invId.id : invId;
  const row = db.prepare('SELECT * FROM invoices WHERE id=? AND COALESCE(deleted_at,0)=0').get(id);
  if (!row) {
    const err = new Error('یافت نشد');
    err.status = 404;
    throw err;
  }
  // Tax-stamped invoices must not reverse locally without Moadian cancel/correct flow.
  try {
    const { assertInvoiceEditableForMoadian } = require('./moadian/invoice-hooks');
    assertInvoiceEditableForMoadian(row);
  } catch (e) {
    if (e && e.code === 'MOADIAN_LOCKED') throw e;
    throw e;
  }
  if (row.status === 'reversed') {
    const err = new Error('این فاکتور قبلاً ابطال شده است');
    err.status = 400;
    throw err;
  }

  const activeReturns = db.prepare(
    "SELECT COUNT(*) AS c FROM sales_returns WHERE invoice_id=? AND COALESCE(status,'posted')<>'reversed'"
  ).get(row.id).c;
  if (activeReturns > 0) {
    const err = new Error(`این فاکتور ${activeReturns} مرجوعی فروش فعال دارد — ابتدا مرجوعی را ابطال کنید`);
    err.status = 400;
    throw err;
  }

  const title = cancelTitleForRole(user.role);
  const wasConverted = !!(row.converted && row.type === 'final');
  let settlementsReversed = 0;
  let restoredToProforma = false;

  db.transaction(() => {
    const settlements = db.prepare(
      "SELECT * FROM settlements WHERE invoice_id=? AND COALESCE(status,'posted')<>'reversed'"
    ).all(row.id);
    for (const s of settlements) {
      reverseSettlementInTx(db, s, user.id);
      settlementsReversed++;
    }

    if (row.stock_deducted) {
      const invRows = JSON.parse(row.rows || '[]');
      if (perpetualDocsEnabled(db)) {
        const reversed = reverseStockBySource(db, 'invoice', row.id, {
          createdBy: user.id, date: todayJalali(), note: `بازگشت موجودی از لغو فاکتور ${row.num}`,
        });
        if (invRows.length) {
          for (const r of invRows) {
            if (!r.variant_id || r.row_type === 'income') continue;
            try {
              require('./product-variants').adjustVariantStock(db, r.variant_id, Number(r.qty) || 0, 'delta');
            } catch (_) { /* variant row may have been removed */ }
          }
        }
        if (!reversed.length) {
          // Legacy firm docs without inventory_ledger rows
          for (const r of invRows) {
            if (r.row_type === 'income' || !r.product_id) continue;
            db.prepare('UPDATE products SET stock=stock+? WHERE id=?').run(r.qty, r.product_id);
            db.prepare('INSERT INTO stock_logs (product_id,user_id,change,note) VALUES (?,?,?,?)').run(
              r.product_id, user.id, r.qty, `بازگشت موجودی از لغو فاکتور ${row.num}`
            );
            const whId = r.warehouse_id || row.warehouse_id;
            if (whId) {
              db.prepare('INSERT INTO warehouse_stock (product_id,warehouse_id,qty) VALUES (?,?,?) ON CONFLICT(product_id,warehouse_id) DO UPDATE SET qty=qty+excluded.qty')
                .run(r.product_id, whId, r.qty);
            }
          }
        }
      } else {
        for (const r of invRows) {
          if (r.row_type === 'income' || !r.product_id) continue;
          if (r.variant_id) {
            try {
              require('./product-variants').adjustVariantStock(db, r.variant_id, Number(r.qty) || 0, 'delta');
            } catch (_) { /* optional */ }
          }
          db.prepare('UPDATE products SET stock=stock+? WHERE id=?').run(r.qty, r.product_id);
          db.prepare('INSERT INTO stock_logs (product_id,user_id,change,note) VALUES (?,?,?,?)').run(
            r.product_id, user.id, r.qty, `بازگشت موجودی از لغو فاکتور ${row.num}`
          );
          if (row.warehouse_id) {
            db.prepare('INSERT INTO warehouse_stock (product_id,warehouse_id,qty) VALUES (?,?,?) ON CONFLICT(product_id,warehouse_id) DO UPDATE SET qty=qty+excluded.qty')
              .run(r.product_id, row.warehouse_id, r.qty);
          }
        }
      }
    }

    if (isFirmSale(row.type)) {
      reverseInvoiceCustomerLedger(db, row, user.id, todayJalali());
      const invTotals = {
        subtotal: row.subtotal, discAmt: row.disc_amt || 0, final: row.final,
        vatAmount: row.vat_amount || 0,
        netBeforeVat: (row.subtotal || 0) - (row.disc_amt || 0) + Math.round(row.freight_amount || 0),
      };
      postToLedger(db, {
        sourceType: 'invoice_reversal', sourceId: row.id, date: todayJalali(),
        description: `ابطال فاکتور ${row.num}`, createdBy: user.id,
        lines: salesJournalLines(db, row.cust_id, invTotals, true, {
          payType: row.pay_type || 'credit', bankId: row.bank_id, cashBoxId: row.cash_box_id,
          rows: JSON.parse(row.rows || '[]'),
        }),
      });
      const cogsOrig = db.prepare(
        "SELECT id FROM journal_entries WHERE ref_type='invoice_cogs' AND ref_id=? AND COALESCE(deleted_at,0)=0"
      ).get(row.id);
      if (cogsOrig) {
        const cogsLines = db.prepare(`
          SELECT COALESCE(
            NULLIF(SUM(COALESCE(debit_rial,0)),0),
            ROUND(SUM(COALESCE(debit,0))*10),
            0
          ) AS d
          FROM journal_lines WHERE entry_id=?
        `).get(cogsOrig.id);
        postCogsFromMovements(db, {
          invId: row.id, num: row.num, date: todayJalali(), userId: user.id,
          cogsRial: Number(cogsLines?.d) || 0, reverse: true,
        });
      } else {
        postCogsVoucher(db, row.id, row.num, todayJalali(), JSON.parse(row.rows || '[]'), user.id, true);
      }
      reverseCommissionAccrual(db, 'invoice', row.id, user.id, todayJalali());
    }

    if (wasConverted) {
      db.prepare(`UPDATE invoices SET
        type='proforma', converted=0, stock_deducted=0,
        approved=0, approved_at=NULL, approved_by=NULL,
        status='posted', deleted_at=NULL, deleted_by=NULL,
        reversed_at=NULL, reversed_by=NULL
        WHERE id=?`).run(row.id);
      restoredToProforma = true;
    } else {
      db.prepare("UPDATE invoices SET status='reversed',deleted_at=strftime('%s','now'),deleted_by=?,reversed_at=strftime('%s','now'),reversed_by=? WHERE id=?")
        .run(user.id, user.id, row.id);
    }
  })();

  audit(user.id, restoredToProforma ? 'unconvert' : 'soft_delete', 'invoice', row.id,
    restoredToProforma
      ? `لغو فاکتور رسمی ${row.num} — برگشت به پیش‌فاکتور`
      : `حذف نرم فاکتور ${row.num}`);

  return {
    restoredToProforma,
    invoice: row,
    title,
    settlementsReversed,
    reason: opts.reason || '',
  };
}

function saveCancelImage(file) {
  if (!file) return null;
  return persistPrivateUpload(file, 'messages', 'cancel');
}

/**
 * In-app notification + message with optional invoice snapshot image.
 */
function notifyInvoiceCancelled(db, { inv, user, title, imageFileName }) {
  const cust = inv.cust_id ? db.prepare('SELECT biz FROM customers WHERE id=?').get(inv.cust_id) : null;
  const biz = cust?.biz || 'مشتری';
  const body = `${inv.num || '#' + inv.id} — ${biz} — ${Number(inv.final || 0).toLocaleString('fa-IR')} ریال`;

  notif.notifyRoles(db, {
    kind: 'invoice_cancelled',
    entity_type: 'invoice',
    entity_id: inv.id,
    title,
    body,
  });

  const msgBody = `${title}\n${body}`;
  const recipients = new Set();
  if (inv.user_id) recipients.add(inv.user_id);
  const managers = db.prepare(
    "SELECT id FROM users WHERE active=1 AND role IN ('admin','accounting','sales_manager')"
  ).all();
  for (const m of managers) recipients.add(m.id);
  recipients.delete(user.id);

  const ins = db.prepare('INSERT INTO messages (from_id,to_id,body,image) VALUES (?,?,?,?)');
  if (recipients.size === 0) {
    ins.run(user.id, user.id, msgBody, imageFileName || null);
  } else {
    for (const toId of recipients) {
      ins.run(user.id, toId, msgBody, imageFileName || null);
    }
  }
}

module.exports = {
  voidInvoiceFully,
  notifyInvoiceCancelled,
  cancelTitleForRole,
  saveCancelImage,
  salesJournalLines,
  postCogsVoucher,
};
