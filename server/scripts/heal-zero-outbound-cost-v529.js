'use strict';
/**
 * v529 — ترمیم سطرهای خروج با مبلغ صفر در کاردکس + جلوگیری از تکرار در کد (ledger gate).
 *
 * ریشه: فروش/خروج وقتی میانگین/نرخ زنده صفر بوده ثبت شده؛ UI همان amount_rial را نشان می‌دهد.
 * روش هزینه از resolvePolicy (کالا → انبار → سراسری) خوانده می‌شود — فقط MA در این heal
 * با replay زمانی اصلاح می‌شود؛ FIFO/specific گزارش و رد می‌شوند تا لایه بازسازی شود.
 *
 * پیش‌فرض: dry-run. اجرا: --apply
 * محدود: --product=ID  --invoice=NUM
 */
const path = require('path');
const fs = require('fs');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const onlyProduct = Number((args.find((a) => a.startsWith('--product=')) || '').split('=')[1]) || null;
const onlyInvoice = String((args.find((a) => a.startsWith('--invoice=')) || '').split('=')[1] || '').trim() || null;

process.chdir(path.join(__dirname, '..'));
const { getDB } = require('../db');
const { resolvePolicy } = require('../lib/inventory/valuation');
const { postToLedger } = require('../lib/ledger');
const { rialToLedger } = require('../lib/money');
const { acct } = require('../lib/coa-map');

const db = getDB();
const report = { dryRun: !APPLY, products: [], cogs: [], skipped: [], errors: [] };

function liveJe(refType, refId) {
  return db.prepare(`
    SELECT id, total_debit_rial FROM journal_entries
    WHERE ref_type=? AND ref_id=?
      AND COALESCE(deleted_at,0)=0
      AND COALESCE(status,'posted') NOT IN ('reversed','void')
    ORDER BY id
  `).all(refType, refId);
}

function cogsPostedRial(invoiceId) {
  let s = 0;
  for (const t of ['invoice_cogs', 'invoice_cogs_fix']) {
    for (const j of liveJe(t, invoiceId)) s += Math.round(Number(j.total_debit_rial) || 0);
  }
  return s;
}

function rebuildBuckets(productId) {
  try {
    require('../lib/inventory/valuation').rebuildBuckets(db, { productId });
  } catch (e) {
    report.errors.push({ product_id: productId, bucket: e.message });
  }
}

/**
 * Chronological MA replay: assign cost to zero-amount outs using running avg
 * from prior valued movements (by date, id — document chronology, not created_at).
 * Method = resolvePolicy(product → warehouse → global) per outbound warehouse —
 * never hardcode moving_average when FIFO/specific is selected for that scope.
 */
function healProductMa(productId) {
  const p = db.prepare('SELECT id,code,name,average_cost_rial FROM products WHERE id=?').get(productId);
  if (!p) return;

  const rows = db.prepare(`
    SELECT id, date, event_type, source_type, source_id, warehouse_id,
           qty_in, qty_out, unit_cost_rial, amount_rial, status, reversed_of, note
    FROM inventory_ledger
    WHERE product_id=? AND status='posted'
    ORDER BY COALESCE(date,''), id
  `).all(productId);

  // Method check: warehouses with zero outs OR prior v529 tags (for reheal).
  const candidateWh = new Set();
  for (const r of rows) {
    if (r.reversed_of) continue;
    if ((Number(r.qty_out) || 0) <= 0) continue;
    const zeroAmt = Math.round(Number(r.amount_rial) || 0) <= 0;
    const tagged = /\[v529/.test(String(r.note || ''));
    if (zeroAmt || tagged) candidateWh.add(r.warehouse_id || null);
  }
  if (!candidateWh.size) {
    report.products.push({ product_id: productId, code: p.code, name: p.name, fixes: 0 });
    return;
  }
  const methods = [...candidateWh].map((wid) => ({
    warehouse_id: wid,
    method: resolvePolicy(db, { productId, warehouseId: wid || undefined }).method,
  }));
  const nonMa = methods.filter((m) => m.method !== 'moving_average');
  if (nonMa.length && nonMa.length === methods.length) {
    report.skipped.push({
      product_id: productId, code: p.code, methods: nonMa,
      reason: 'heal_v529_only_moving_average — FIFO/specific نیاز به بازسازی لایه دارد',
    });
    return;
  }
  if (nonMa.length) {
    report.skipped.push({
      product_id: productId, code: p.code, methods: nonMa,
      reason: 'partial_skip_non_ma_warehouses — فقط انبارهای میانگین موزون ترمیم می‌شوند',
    });
  }
  const maWh = new Set(
    methods.filter((m) => m.method === 'moving_average').map((m) => m.warehouse_id)
  );

  // WIP / بسته برش در کاردکس فروش‌پذیر نیست — ورودشان میانگین زمانی FG را خراب می‌کند.
  const SKIP_EVENTS = new Set([
    'cutting_pack', 'wip_issue', 'wip_receipt', 'wip_transfer',
  ]);

  let qty = 0;
  let value = 0;
  const fixes = [];

  for (const r of rows) {
    if (r.reversed_of) continue;
    const et = String(r.event_type || '');
    if (SKIP_EVENTS.has(et)) continue;

    const qIn = Number(r.qty_in) || 0;
    const qOut = Number(r.qty_out) || 0;
    let amt = Math.round(Number(r.amount_rial) || 0);

    if (!qIn && !qOut) {
      // value-only (مثلاً تطبیق بهای رسید): فقط ارزش در گردش
      value += amt;
      if (qty > 1e-9 && value < 0) value = 0;
      continue;
    }

    if (qIn > 0) {
      qty += qIn;
      value += amt;
      continue;
    }

    if (qOut > 0) {
      const whKey = r.warehouse_id || null;
      const rowMethod = resolvePolicy(db, { productId, warehouseId: whKey || undefined }).method;
      const avg = qty > 1e-9
        ? Math.max(0, Math.round(value / qty))
        : Math.round(Number(p.average_cost_rial) || 0);
      const wasV529 = /\[v529/.test(String(r.note || ''));
      // صفر، یا ردیف قبلیِ ترمیم‌شده با میانگین WIP-آلوده که باید با replay بدون cutting_pack اصلاح شود
      const needsFix = avg > 0 && rowMethod === 'moving_average' && maWh.has(whKey)
        && (amt <= 0 || (wasV529 && Math.abs(amt - Math.round(avg * qOut)) > 1));
      if (needsFix) {
        const newAmt = Math.round(avg * qOut);
        const newUnit = Math.round(newAmt / qOut);
        fixes.push({
          ledger_id: r.id,
          date: r.date,
          event_type: r.event_type,
          source_type: r.source_type,
          source_id: r.source_id,
          warehouse_id: r.warehouse_id,
          qty_out: qOut,
          old_amount_rial: amt,
          new_amount_rial: newAmt,
          new_unit_cost_rial: newUnit,
          avg_used: avg,
          method: rowMethod,
          reheal: wasV529 && amt > 0,
        });
        amt = newAmt;
      }
      qty -= qOut;
      value -= amt;
      if (qty < 1e-9) { qty = 0; value = 0; }
      if (qty > 1e-9 && value < 0) value = 0;
    }
  }

  if (!fixes.length) {
    report.products.push({ product_id: productId, code: p.code, name: p.name, fixes: 0 });
    return;
  }

  if (APPLY) {
    const upd = db.prepare(`
      UPDATE inventory_ledger
      SET unit_cost_rial=?, amount_rial=?,
          note=TRIM(COALESCE(note,'') || ' [v529 بهای خروجی از میانگین زمانی]')
      WHERE id=? AND status='posted'
    `);
    for (const f of fixes) upd.run(f.new_unit_cost_rial, f.new_amount_rial, f.ledger_id);
    rebuildBuckets(productId);
  }

  report.products.push({
    product_id: productId, code: p.code, name: p.name,
    methods: methods,
    fixes: fixes.length,
    delta_rial: fixes.reduce((s, f) => s + f.new_amount_rial, 0),
    sample: fixes.slice(0, 8),
  });

  // Aggregate sale fixes by invoice → COGS delta (net of old→new for reheals)
  const byInv = new Map();
  for (const f of fixes) {
    if (f.source_type !== 'invoice' || f.event_type !== 'sale') continue;
    const k = Number(f.source_id);
    if (!k) continue;
    const delta = f.new_amount_rial - (Number(f.old_amount_rial) || 0);
    byInv.set(k, (byInv.get(k) || 0) + delta);
  }
  for (const [invId, added] of byInv) {
    const inv = db.prepare('SELECT id,num,date,warehouse_id FROM invoices WHERE id=?').get(invId);
    if (!inv) continue;
    if (onlyInvoice && inv.num !== onlyInvoice) continue;
    const ledTotal = Number(db.prepare(`
      SELECT COALESCE(SUM(amount_rial),0) v FROM inventory_ledger
      WHERE source_type='invoice' AND source_id=? AND event_type='sale'
        AND status='posted' AND reversed_of IS NULL
    `).get(invId).v) || 0;
    // After apply, ledTotal includes new amounts; before apply use old+netDelta
    const target = APPLY ? ledTotal : (ledTotal + added);
    const posted = cogsPostedRial(invId);
    const need = Math.max(0, target - posted);
    if (need <= 0) {
      report.cogs.push({ invoice: inv.num, skipped: 'cogs_already_covers', target, posted });
      continue;
    }
    if (APPLY) {
      const cogs = acct(db, 'coa_cogs');
      let invAcct;
      try { invAcct = acct(db, 'coa_finished_goods'); }
      catch (_) { invAcct = acct(db, 'coa_inventory'); }
      const L = rialToLedger(need);
      const jeId = postToLedger(db, {
        sourceType: 'invoice_cogs_fix',
        sourceId: invId,
        date: inv.date || '',
        description: `بهای تمام‌شده فاکتور ${inv.num} (ترمیم خروج صفر v529)`,
        createdBy: 1,
        warehouseId: inv.warehouse_id || null,
        lines: [
          { code: cogs.code, name: cogs.name, debit: L, credit: 0 },
          { code: invAcct.code, name: invAcct.name, debit: 0, credit: L },
        ],
      });
      report.cogs.push({ invoice: inv.num, jeId, need, target, posted });
    } else {
      report.cogs.push({ invoice: inv.num, dry: true, need, target, posted });
    }
  }
}

function main() {
  let sql = `
    SELECT DISTINCT l.product_id AS id
    FROM inventory_ledger l
    WHERE l.status='posted' AND l.reversed_of IS NULL
      AND l.qty_out>0
      AND l.event_type IN ('sale','transfer_out','issue','material_issue','production_issue')
      AND (
        COALESCE(l.amount_rial,0)=0
        OR COALESCE(l.note,'') LIKE '%[v529%'
      )
  `;
  const params = [];
  if (onlyProduct) {
    sql += ' AND l.product_id=?';
    params.push(onlyProduct);
  }
  if (onlyInvoice) {
    sql += ` AND l.source_type='invoice' AND l.source_id=(SELECT id FROM invoices WHERE num=? LIMIT 1)`;
    params.push(onlyInvoice);
  }
  sql += ' ORDER BY l.product_id';
  const products = db.prepare(sql).all(...params);

  const run = () => {
    for (const row of products) healProductMa(row.id);
  };
  if (APPLY) db.transaction(run)();
  else run();

  const outPath = path.join(__dirname, '..', '..', '_heal-zero-outbound-v529-report.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify({
    ok: true,
    apply: APPLY,
    productCount: products.length,
    fixedProducts: report.products.filter((p) => p.fixes > 0).length,
    skipped: report.skipped.length,
    cogsFixes: report.cogs.length,
    outPath,
  }, null, 2));
  console.log('---REPORT---');
  console.log(JSON.stringify(report, null, 2));
}

try {
  main();
} catch (e) {
  console.error('FATAL', e);
  process.exit(1);
}
