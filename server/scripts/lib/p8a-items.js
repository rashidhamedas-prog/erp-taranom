'use strict';
/**
 * P8a — منطق اصلاح هر قلم (داخل تراکنشِ فراخواننده اجرا می‌شود؛ فقط از helperهای موجود برنامه).
 * پیش‌فرض‌ها = شناسه‌های تأییدشدهٔ تولید (read-only). تست fixture با cfg خودش صدا می‌زند.
 */
const C = require('./p8a-common');

const { R, rial, r6 } = C;

function fail(msg) { const e = new Error(msg); e.code = 'E_P8A_PRECHECK'; throw e; }

function liveNet(db, productId, warehouseId) {
  return C.liveKardexOf(db, productId, warehouseId);
}

// ───────────── item 1: کالای 333 — ابطال ۱۰ ردیف قدیمی بی‌سند ─────────────

const item1 = {
  key: 'item1',
  file: 'p8a-item1-p333-legacy-kardex',
  title: 'کالای 333 (پارچه مموری لایکو دوزی، WH33) — ابطال ۳ افتتاحیه + ۷ هم‌ترازی بی‌سند',
  defaults: {
    productId: 333,
    warehouseId: 33,
    openingRowIds: [1157, 1334, 1425],
    reconcileRowIds: [799, 1168, 1231, 1356, 1386, 1405, 1484],
    expectQty: 18.91,
    openingStockStatus: 'void',
  },
  watch(db, cfg) {
    return [
      { table: 'product_opening_stock', where: 'product_id=?', params: [cfg.productId], explicit: true },
      { table: 'inventory_valuation_buckets', where: 'product_id=?', params: [cfg.productId], key: ['product_id', 'warehouse_id'], explicit: true },
      { table: 'warehouse_stock', where: 'product_id=?', params: [cfg.productId], key: ['product_id', 'warehouse_id'] },
      { table: 'products', where: 'id=?', params: [cfg.productId] },
    ];
  },
  run(db, ctx) {
    const { cfg, userId, reason } = ctx;
    const { reverseInventoryMovement } = R('lib/inventory/ledger');
    const ids = [...cfg.openingRowIds, ...cfg.reconcileRowIds];
    const rows = ids.map((id) => db.prepare('SELECT * FROM inventory_ledger WHERE id=?').get(id));
    rows.forEach((r, i) => {
      if (!r) fail(`ردیف کاردکس ${ids[i]} یافت نشد`);
      if (r.status !== 'posted') fail(`ردیف ${r.id} وضعیت ${r.status} دارد (باید posted باشد)`);
      if (Number(r.product_id) !== cfg.productId || Number(r.warehouse_id) !== cfg.warehouseId) fail(`ردیف ${r.id} مال کالا/انبار دیگری است`);
      if (r.je_id) fail(`ردیف ${r.id} سند حسابداری دارد — این اصلاح فقط برای ردیف بی‌سند است`);
      if (!['opening_inventory', 'stock_reconcile'].includes(String(r.source_type))) fail(`ردیف ${r.id} افتتاحیه/هم‌ترازی نیست`);
    });
    const before = liveNet(db, cfg.productId, cfg.warehouseId);
    const ws0 = db.prepare('SELECT qty FROM warehouse_stock WHERE product_id=? AND warehouse_id=?').get(cfg.productId, cfg.warehouseId);
    const sumIn = r6(rows.reduce((s, r) => s + (Number(r.qty_in) || 0), 0));
    const sumOut = r6(rows.reduce((s, r) => s + (Number(r.qty_out) || 0), 0));

    for (const r of rows) {
      reverseInventoryMovement(db, r.id, {
        createdBy: userId, date: r.date, keepDate: true, skipStock: true,
        note: `ابطال ردیف قدیمی بی‌سند ${r.tx_no || r.id} (P8a — تصمیم مالک) — ${reason}`.slice(0, 240),
      });
    }

    const after = liveNet(db, cfg.productId, cfg.warehouseId);
    const ws1 = db.prepare('SELECT qty FROM warehouse_stock WHERE product_id=? AND warehouse_id=?').get(cfg.productId, cfg.warehouseId);
    const prod = db.prepare('SELECT stock, average_cost_rial FROM products WHERE id=?').get(cfg.productId);
    if (Math.abs((Number(ws1 && ws1.qty) || 0) - (Number(ws0 && ws0.qty) || 0)) > 1e-9) fail('موجودی انبار نباید تغییر کند');
    if (cfg.expectQty != null && Math.abs(after.qty - cfg.expectQty) > 1e-6) {
      fail(`کاردکس زندهٔ بعد از اصلاح ${after.qty} است؛ انتظار ${cfg.expectQty}`);
    }
    if (Math.abs(after.qty - (Number(ws1 && ws1.qty) || 0)) > 1e-6) fail('کاردکس زنده با warehouse_stock برابر نشد');

    // سطل ارزش‌گذاری (کش مشتق) = مقدار انبار × میانگین سرفصل
    const avg = rial(prod.average_cost_rial);
    const qty = Number(ws1 && ws1.qty) || 0;
    const bucketBefore = db.prepare('SELECT * FROM inventory_valuation_buckets WHERE product_id=? AND warehouse_id=?').get(cfg.productId, cfg.warehouseId);
    const target = { qty, value: rial(qty * avg), avg };
    if (!bucketBefore || Math.abs(bucketBefore.qty - target.qty) > 1e-9 || rial(bucketBefore.value_rial) !== target.value || rial(bucketBefore.avg_rial) !== avg) {
      db.prepare(`
        INSERT INTO inventory_valuation_buckets (product_id, warehouse_id, qty, value_rial, avg_rial, updated_at)
        VALUES (?,?,?,?,?,strftime('%s','now'))
        ON CONFLICT(product_id, warehouse_id) DO UPDATE SET qty=excluded.qty, value_rial=excluded.value_rial, avg_rial=excluded.avg_rial, updated_at=excluded.updated_at
      `).run(cfg.productId, cfg.warehouseId, target.qty, target.value, target.avg);
    }

    // موجودی اول دوره: هیچ افتتاحیهٔ زنده‌ای نمی‌ماند؛ موجودی 18.91 از رسید طاقه‌های دوره آمده
    const pos = db.prepare("SELECT * FROM product_opening_stock WHERE product_id=? AND warehouse_id=? AND status<>'void'").get(cfg.productId, cfg.warehouseId);
    if (pos) {
      db.prepare(`
        UPDATE product_opening_stock
        SET status=?, note=?, reviewed_by=?, reviewed_at=datetime('now'), updated_by=?, updated_at=datetime('now'),
            version=COALESCE(version,1)+1
        WHERE id=?
      `).run(cfg.openingStockStatus, `P8a: افتتاحیه‌های بی‌سند ${cfg.openingRowIds.join('،')} ابطال شد؛ موجودی از رسید طاقه‌های دوره است (بدون نیاز به سند افتتاحیه) — ${reason}`.slice(0, 500),
        userId, userId, pos.id);
    }
    return {
      rows_voided: rows.length, opening_qty_in: sumIn, reconcile_qty_out: sumOut,
      live_before: before, live_after: after,
      warehouse_stock: Number(ws1 && ws1.qty) || 0, header_stock: prod.stock, header_avg: avg,
      bucket_after_reversals: bucketBefore ? { qty: bucketBefore.qty, value_rial: bucketBefore.value_rial } : null,
      bucket_after: target, opening_stock_id: pos ? pos.id : null, opening_stock_status: pos ? cfg.openingStockStatus : null,
    };
  },
};

// ───────────── item 2: WH37 — خروج بستهٔ WIP به بهای متناسب بسته ─────────────

const item2 = {
  key: 'item2',
  file: 'p8a-item2-wh37-pack-exit',
  title: 'WH37 (کار در جریان) — بازقیمت‌گذاری خروج بسته‌ها با مبلغ متناسب بسته (منطق P1)',
  defaults: {
    warehouseId: 37,
    ledgerIds: [1456, 1457, 1458, 1459, 1460, 1461, 1462, 1463, 1479, 1480, 1481],
  },
  watch(db, cfg) {
    const pids = db.prepare(`SELECT DISTINCT product_id FROM inventory_ledger WHERE id IN (${cfg.ledgerIds.map(() => '?').join(',')})`).all(...cfg.ledgerIds).map((r) => r.product_id);
    const ph = pids.map(() => '?').join(',') || 'NULL';
    return [
      { table: 'inventory_valuation_buckets', where: `product_id IN (${ph}) AND warehouse_id=?`, params: [...pids, cfg.warehouseId], key: ['product_id', 'warehouse_id'], explicit: true },
      { table: 'inventory_valuation_buckets', where: `product_id IN (${ph}) AND warehouse_id<>?`, params: [...pids, cfg.warehouseId], key: ['product_id', 'warehouse_id'] },
      { table: 'warehouse_stock', where: `product_id IN (${ph})`, params: pids, key: ['product_id', 'warehouse_id'] },
      { table: 'products', where: `id IN (${ph})`, params: pids },
    ];
  },
  run(db, ctx) {
    const { cfg, userId, reason } = ctx;
    const { reverseInventoryMovement, postInventoryMovement } = R('lib/inventory/ledger');
    const lines = [];
    const orders = new Set();
    for (const id of cfg.ledgerIds) {
      const row = db.prepare('SELECT * FROM inventory_ledger WHERE id=?').get(id);
      if (!row) fail(`ردیف ${id} یافت نشد`);
      if (row.status !== 'posted' || row.reversed_of) fail(`ردیف ${id} زنده نیست`);
      if (row.event_type !== 'cutting_pack' || !(Number(row.qty_out) > 0) || Number(row.warehouse_id) !== cfg.warehouseId) {
        fail(`ردیف ${id} خروج بستهٔ WIP از انبار ${cfg.warehouseId} نیست`);
      }
      if (row.je_id) fail(`ردیف ${id} سند دارد — انتظار ردیف فقط-کاردکس`);
      const pack = db.prepare('SELECT * FROM cutting_packs WHERE id=?').get(row.source_id);
      if (!pack || pack.status !== 'posted') fail(`بستهٔ ${row.source_id} زنده نیست`);
      const packQty = Number(pack.qty) || 0;
      const take = Number(row.qty_out) || 0;
      const packAmt = rial(pack.amount_rial);
      const target = take >= packQty - 1e-9 ? packAmt : Math.round(packAmt * take / packQty);
      const po = db.prepare('SELECT id, order_no FROM production_orders WHERE id=?').get(pack.production_order_id);
      orders.add(pack.production_order_id);
      const rec = {
        ledger_id: id, pack_no: pack.pack_no, order_no: po && po.order_no, product_id: row.product_id,
        qty: take, old_amount: rial(row.amount_rial), new_amount: target, delta: target - rial(row.amount_rial),
      };
      lines.push(rec);
      if (rec.delta === 0) continue;
      reverseInventoryMovement(db, id, {
        createdBy: userId, date: row.date, keepDate: true,
        note: `ابطال خروج WIP با بهای میانگین FG ${row.tx_no || id} (P8a) — ${reason}`.slice(0, 240),
      });
      const posted = postInventoryMovement(db, {
        eventType: 'cutting_pack', productId: row.product_id, warehouseId: row.warehouse_id,
        qtyOut: take, unitCostRial: Math.round(target / take), amountRial: target, allowZeroCost: target <= 0,
        sourceType: 'cutting_pack', sourceId: pack.id, date: row.date,
        note: `${row.note || 'تخلیه WIP بسته برش'} — بهای متناسب بسته (اصلاح P8a)`.slice(0, 240),
        createdBy: userId, updateAvg: false, warehouseOnly: true,
      });
      rec.new_ledger_id = posted.id;
    }
    // بعد از اصلاح: ارزش WH37 هر سفارش بسته = ۰
    const perOrder = [];
    for (const oid of orders) {
      const r = db.prepare(`
        SELECT il.* FROM inventory_ledger il JOIN cutting_packs p ON p.id=il.source_id
        WHERE il.source_type='cutting_pack' AND il.warehouse_id=? AND p.production_order_id=?
      `).all(cfg.warehouseId, oid);
      const { isCancelledLedgerRow, ledgerValueDelta } = R('lib/inventory/ledger');
      let q = 0; let v = 0;
      for (const x of r) {
        if (isCancelledLedgerRow(x)) continue;
        q += (Number(x.qty_in) || 0) - (Number(x.qty_out) || 0);
        v += ledgerValueDelta(x);
      }
      const po = db.prepare('SELECT order_no FROM production_orders WHERE id=?').get(oid);
      perOrder.push({ order_id: oid, order_no: po && po.order_no, wip_qty_after: r6(q), wip_value_after: rial(v) });
      if (Math.abs(v) > 1 || Math.abs(q) > 1e-6) fail(`ارزش WH37 سفارش ${oid} بعد از اصلاح صفر نشد (${q} / ${v})`);
    }
    // سطل ارزش‌گذاری WIP (کش مشتق) = کاردکس زنده؛ replay همهٔ وضعیت‌ها با clamp ارزش مثبت شبح می‌سازد
    const bucketFix = [];
    for (const pid of [...new Set(lines.map((l) => l.product_id))]) {
      const k = liveNet(db, pid, cfg.warehouseId);
      const b = db.prepare('SELECT * FROM inventory_valuation_buckets WHERE product_id=? AND warehouse_id=?').get(pid, cfg.warehouseId);
      if (!b) continue;
      const avg = k.qty > 1e-9 ? Math.round(k.val / k.qty) : 0;
      if (Math.abs(b.qty - k.qty) > 1e-9 || rial(b.value_rial) !== k.val || rial(b.avg_rial) !== avg) {
        db.prepare("UPDATE inventory_valuation_buckets SET qty=?, value_rial=?, avg_rial=?, updated_at=strftime('%s','now') WHERE product_id=? AND warehouse_id=?")
          .run(k.qty, k.val, avg, pid, cfg.warehouseId);
        bucketFix.push({ product_id: pid, qty: k.qty, value_rial: k.val });
      }
    }
    // طرف مقابل: خروج‌ها سند ندارند و ورود FG از مبلغ رسید است (نه مبلغ خروج)
    const receipts = db.prepare(`
      SELECT r.id, r.doc_no, r.order_id, r.product_id, r.qty, r.amount_rial, r.je_id
      FROM production_receipts r WHERE r.status='posted' AND r.order_id IN (${[...orders].map(() => '?').join(',')})
    `).all(...orders);
    return {
      lines, per_order: perOrder, wip_bucket_fix: bucketFix,
      total_delta: lines.reduce((s, l) => s + l.delta, 0),
      counterpart: {
        exit_rows_have_je: false,
        note: 'ردیف‌های خروج WH37 فقط-کاردکس (warehouseOnly، بدون JE و بدون اثر روی میانگین سرفصل) بودند؛ GL 1111 هنگام رسید به اندازهٔ مبلغ رسید بستانکار شده و ورود FG در WH34 هم به مبلغ رسید است. پس مازاد خروج به هیچ حساب/کاردکس دیگری نرفته و اصلاح فقط-کاردکس WH37 است.',
        receipts,
      },
    };
  },
};

// ───────────── item 3: PO-0014 — تسهیم P2 بهای رسید بین 332/334 ─────────────

function splitForOrder(db, po, total) {
  const bom = R('lib/production/bom');
  const { splitOrderCost } = R('lib/production/order-cost-split');
  const peers = bom.orderBomPeerLines(po);
  let products;
  if (peers) {
    const sumQ = peers.reduce((s, p) => s + (Number(p.qty_planned) || 0), 0) || 1;
    products = peers.map((p) => ({ product_id: p.product_id, pct: ((Number(p.qty_planned) || 0) / sumQ) * 100 }));
  } else {
    const plan = bom.orderFgPlanRows(db, po);
    const qtySum = plan.reduce((s, p) => s + (Number(p.qty_planned) || 0), 0) || 1;
    products = plan.map((p) => ({ product_id: p.product_id, pct: ((Number(p.qty_planned) || 0) / qtySum) * 100 }));
  }
  const residue = products.some((p) => Number(p.product_id) === Number(po.product_id)) ? Number(po.product_id) : products[0].product_id;
  return splitOrderCost(db, po, { total, products, residueProductId: residue });
}

const item3 = {
  key: 'item3',
  file: 'p8a-item3-po14-receipt-split',
  title: 'PO-0014 — اصلاح تسهیم بهای رسیدهای PR-0011 (332) و PR-0012 (334) طبق P2',
  defaults: {
    orderId: 14,
    expected: { 332: 928034535, 334: 1058957063 },
    sourceType: 'p8a_receipt_split',
  },
  watch(db, cfg) {
    const pids = db.prepare("SELECT DISTINCT product_id FROM production_receipts WHERE order_id=? AND status='posted'").all(cfg.orderId).map((r) => r.product_id);
    const ph = pids.map(() => '?').join(',') || 'NULL';
    return [
      { table: 'production_receipts', where: "order_id=? AND status='posted'", params: [cfg.orderId], explicit: true },
      { table: 'production_orders', where: 'id=?', params: [cfg.orderId], explicit: true },
      { table: 'products', where: `id IN (${ph})`, params: pids },
      { table: 'inventory_valuation_buckets', where: `product_id IN (${ph})`, params: pids, key: ['product_id', 'warehouse_id'] },
    ];
  },
  run(db, ctx) {
    const { cfg, userId, reason } = ctx;
    const po = db.prepare('SELECT * FROM production_orders WHERE id=?').get(cfg.orderId);
    if (!po) fail(`سفارش ${cfg.orderId} یافت نشد`);
    const receipts = db.prepare("SELECT * FROM production_receipts WHERE order_id=? AND status='posted' ORDER BY id").all(po.id);
    if (receipts.length < 2) fail('سفارش چندمحصولی با بیش از یک رسید زنده نیست');
    const total = receipts.reduce((s, r) => s + rial(r.amount_rial), 0);
    const split = cfg.targets
      ? { rows: Object.entries(cfg.targets).map(([pid, amt]) => ({ product_id: Number(pid), amount_rial: amt })), fabric_source: 'cfg.targets', fabric_alloc_rial: 0, pool_rial: 0 }
      : splitForOrder(db, po, total);
    const byPid = new Map(split.rows.map((r) => [Number(r.product_id), r]));
    const mismatch = [];
    if (cfg.expected) {
      for (const [pid, amt] of Object.entries(cfg.expected)) {
        const got = byPid.get(Number(pid));
        if (!got || Math.abs(rial(got.amount_rial) - amt) > 1) mismatch.push({ product_id: Number(pid), expected: amt, computed: got ? got.amount_rial : null });
      }
      if (mismatch.length && ctx.mode === 'apply') fail(`تسهیم محاسبه‌شده با مقدار تأییدشده نمی‌خواند: ${JSON.stringify(mismatch)}`);
    }
    const shares = [];
    const lines = [];
    for (const r of receipts) {
      const target = byPid.get(Number(r.product_id));
      if (!target) fail(`محصول ${r.product_id} در تسهیم نیست`);
      const share = rial(target.amount_rial) - rial(r.amount_rial);
      const qty = Number(r.qty) || 0;
      const nextUnit = qty > 0 ? Math.round(rial(target.amount_rial) / qty) : rial(r.unit_cost_rial);
      lines.push({ receipt_id: r.id, doc_no: r.doc_no, product_id: r.product_id, qty, old_amount: rial(r.amount_rial), new_amount: rial(target.amount_rial), share, old_unit: rial(r.unit_cost_rial), new_unit: nextUnit, split_row: target });
      if (!share) continue;
      db.prepare('UPDATE production_receipts SET amount_rial=?, unit_cost_rial=? WHERE id=?').run(rial(target.amount_rial), nextUnit, r.id);
      shares.push({ receipt: Object.assign({}, r, { amount_rial: rial(target.amount_rial), unit_cost_rial: nextUnit }), share });
    }
    const sumShares = shares.reduce((s, x) => s + x.share, 0);
    if (sumShares !== 0) fail(`جمع جابه‌جایی باید صفر باشد (${sumShares})`);
    const date = ctx.cfg.date || po.actual_end || po.date || ctx.date;
    const stockBefore = Object.fromEntries(receipts.map((r) => [r.product_id, db.prepare('SELECT stock FROM products WHERE id=?').get(r.product_id).stock]));
    let routed = { lines: [], sold_cogs_rial: 0 };
    let jeId = null;
    if (shares.length) {
      const { routeReceiptValueChange } = R('lib/production/order-cost-reconcile');
      const label = `اصلاح تسهیم بهای رسید ${po.order_no} بین محصولات (P2) — P8a`;
      routed = routeReceiptValueChange(db, {
        sourceType: cfg.sourceType, sourceId: po.id, label, eventNote: `${label} — ${reason}`.slice(0, 240),
        shares, date, userId,
      });
      if (routed.lines.length) {
        const { postToLedger } = R('lib/ledger');
        jeId = postToLedger(db, {
          sourceType: cfg.sourceType, sourceId: po.id, date,
          description: `${label} — ${reason}`.slice(0, 250), createdBy: userId,
          costCenterId: po.cost_center_id || null, lines: routed.lines,
        });
        if (jeId && typeof jeId === 'object') jeId = jeId.id || jeId.je_id || null;
      }
      const head = db.prepare("SELECT amount_rial, qty FROM production_receipts WHERE order_id=? AND product_id=? AND status='posted' ORDER BY id DESC LIMIT 1").get(po.id, po.product_id);
      if (head && Number(head.qty) > 0) {
        db.prepare('UPDATE production_orders SET unit_cost_rial=? WHERE id=?').run(Math.round(rial(head.amount_rial) / Number(head.qty)), po.id);
      }
    }
    return {
      order_no: po.order_no, total, fabric_source: split.fabric_source, fabric_alloc_rial: split.fabric_alloc_rial,
      pool_rial: split.pool_rial, mismatch, lines, date, on_hand_before: stockBefore,
      je_lines_toman: routed.lines, sold_cogs_rial: routed.sold_cogs_rial, je_id: jeId,
    };
  },
};

// ───────────── item 4: JEهای یتیم fg_delta (PO-0010 / PO-0012) ─────────────

const item4 = {
  key: 'item4',
  file: 'p8a-item4-orphan-fgdelta',
  title: 'ابطال JEهای یتیم تعدیل بهای لایه (675، 676 → PO-0010؛ 714 → PO-0012) با reverseOrderFgDeltas',
  defaults: {
    attributions: [{ layId: 13, orderId: 10 }, { layId: 12, orderId: 10 }, { layId: 18, orderId: 12 }],
    expectJeIds: [675, 676, 714],
  },
  watch(db, cfg) {
    const layIds = cfg.attributions.map((a) => a.layId);
    const ph = layIds.map(() => '?').join(',');
    const pids = db.prepare(`SELECT DISTINCT product_id FROM inventory_ledger WHERE source_type='cutting_lay_fg_delta' AND source_id IN (${ph})`).all(...layIds).map((r) => r.product_id);
    const pph = pids.map(() => '?').join(',') || 'NULL';
    return [
      { table: 'cutting_lays', where: `id IN (${ph})`, params: layIds, explicit: true },
      { table: 'products', where: `id IN (${pph})`, params: pids },
      { table: 'inventory_valuation_buckets', where: `product_id IN (${pph})`, params: pids, key: ['product_id', 'warehouse_id'] },
    ];
  },
  run(db, ctx) {
    const { cfg, userId, reason } = ctx;
    const cutting = R('lib/production/cutting');
    const liveJe = db.prepare(`
      SELECT id FROM journal_entries WHERE ref_type='cutting_lay_fg_delta' AND ref_id=?
        AND COALESCE(deleted_at,0)=0 AND COALESCE(status,'') NOT IN ('reversed','void')
    `);
    const found = [];
    for (const a of cfg.attributions) {
      const lay = db.prepare('SELECT * FROM cutting_lays WHERE id=?').get(a.layId);
      if (!lay) fail(`لایه ${a.layId} یافت نشد`);
      const po = db.prepare('SELECT * FROM production_orders WHERE id=?').get(a.orderId);
      if (!po) fail(`سفارش ${a.orderId} یافت نشد`);
      if (lay.fg_delta_order_id != null && Number(lay.fg_delta_order_id) !== a.orderId) fail(`لایه ${a.layId} قبلاً به سفارش ${lay.fg_delta_order_id} نسبت داده شده`);
      for (const j of liveJe.all(a.layId)) found.push(j.id);
      if (lay.fg_delta_order_id == null) {
        db.prepare('UPDATE cutting_lays SET fg_delta_order_id=? WHERE id=?').run(a.orderId, a.layId);
      }
    }
    if (cfg.expectJeIds && JSON.stringify([...found].sort((x, y) => x - y)) !== JSON.stringify([...cfg.expectJeIds].sort((x, y) => x - y))) {
      fail(`JEهای زندهٔ fg_delta (${found.join(',')}) با انتظار (${cfg.expectJeIds.join(',')}) نمی‌خواند`);
    }
    const perOrder = [];
    for (const oid of [...new Set(cfg.attributions.map((a) => a.orderId))]) {
      const po = db.prepare('SELECT order_no, status FROM production_orders WHERE id=?').get(oid);
      const r = cutting.reverseOrderFgDeltas(db, { orderId: oid, userId, reason: `P8a ابطال تعدیل بهای یتیم ${po.order_no} — ${reason}`, date: ctx.date });
      perOrder.push(Object.assign({ order_id: oid, order_no: po.order_no, order_status: po.status }, r));
    }
    const left = cfg.attributions.reduce((s, a) => s + liveJe.all(a.layId).length, 0);
    if (left) fail(`${left} JE زندهٔ fg_delta باقی ماند`);
    return { je_found: found, per_order: perOrder, date: ctx.date };
  },
};

module.exports = { item1, item2, item3, item4, splitForOrder };
