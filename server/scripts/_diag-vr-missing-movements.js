'use strict';
/**
 * تشخیص فقط‌خواندنی: سطرهای اسناد VR ثبت‌شده (variant_reclass_docs.status='posted') که ردیف کاردکس
 * تفکیکی‌شان ردیف inventory_movements متناظر ندارد (اسناد قبل از لایهٔ حرکت) — علت drift_variant.
 *
 * Run: DB_PATH=/path/erp.db node server/scripts/_diag-vr-missing-movements.js [--db path] [--json]
 * DB با { readonly: true } باز می‌شود؛ هیچ نوشتنی ندارد.
 *
 * Match key (همان که postReclass می‌نویسد): doc_type='variant_reclass', doc_id=سند، doc_line=ledger_id
 * ردیف تفکیکی، variant_id/warehouse_id سطر؛ یا movement_id ثبت‌شده در lines_json.
 */
const path = require('path');
const Database = require('better-sqlite3');

const args = process.argv.slice(2);
const argVal = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const asJson = args.includes('--json');
const dbPath = argVal('--db') || process.env.DB_PATH;
if (!dbPath) {
  console.error('DB_PATH یا --db الزامی است');
  process.exit(2);
}

const r3 = (x) => Math.round((Number(x) || 0) * 1000) / 1000;
const db = new Database(path.resolve(dbPath), { readonly: true, fileMustExist: true });
const has = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);

const report = { db: path.resolve(dbPath), docs_scanned: 0, lines_scanned: 0, missing_lines: 0, products: [], variants: [], lines: [] };
try {
  if (!has('variant_reclass_docs') || !has('inventory_movements') || !has('inventory_ledger')) {
    report.skipped = 'variant_reclass_docs / inventory_movements / inventory_ledger missing';
  } else {
    const docs = db.prepare("SELECT * FROM variant_reclass_docs WHERE status='posted' ORDER BY id").all();
    const ledger = db.prepare('SELECT id, status, variant_id, warehouse_id, qty_in, qty_out FROM inventory_ledger WHERE id=?');
    const byId = db.prepare('SELECT id FROM inventory_movements WHERE id=? AND doc_type=?');
    const byKey = db.prepare(`
      SELECT id FROM inventory_movements
      WHERE doc_type='variant_reclass' AND doc_id=? AND COALESCE(doc_line,-1)=?
        AND COALESCE(warehouse_id,0)=COALESCE(?,0) AND COALESCE(variant_id,0)=COALESCE(?,0)
      LIMIT 1
    `);
    const mvSum = db.prepare('SELECT COALESCE(SUM(qty_delta),0) q FROM inventory_movements WHERE variant_id=? AND warehouse_id=?');
    const vws = has('variant_warehouse_stock')
      ? db.prepare('SELECT qty FROM variant_warehouse_stock WHERE variant_id=? AND warehouse_id=?') : null;
    const prodName = has('products') ? db.prepare('SELECT code, name FROM products WHERE id=?') : null;
    const perProduct = new Map();
    const perVariant = new Map();

    for (const d of docs) {
      report.docs_scanned += 1;
      let lines = [];
      try { lines = JSON.parse(d.lines_json || '[]'); } catch (_) { lines = []; }
      for (const l of lines) {
        report.lines_scanned += 1;
        const lid = Number(l.ledger_id) || 0;
        const led = lid ? ledger.get(lid) : null;
        const wh = Number((led && led.warehouse_id) || d.warehouse_id) || null;
        const vid = Number(l.variant_id) || null;
        const found = (l.movement_id && byId.get(l.movement_id, 'variant_reclass'))
          || (lid && byKey.get(d.id, lid, wh, vid));
        if (found) continue;
        const inbound = led ? Number(led.qty_in) > 0 : true;
        const qty = r3(led ? (Number(led.qty_in) || Number(led.qty_out)) : l.qty);
        const qtyDelta = r3(inbound ? qty : -qty);
        report.missing_lines += 1;
        report.lines.push({
          doc_id: d.id, doc_no: d.doc_no, product_id: d.product_id, warehouse_id: wh, variant_id: vid,
          ledger_id: lid || null, ledger_status: led ? led.status : 'missing', qty, qty_delta: qtyDelta,
        });
        const p = perProduct.get(d.product_id) || { product_id: d.product_id, missing_lines: 0, missing_qty_delta: 0, docs: new Set() };
        p.missing_lines += 1;
        p.missing_qty_delta = r3(p.missing_qty_delta + qtyDelta);
        p.docs.add(d.doc_no);
        perProduct.set(d.product_id, p);
        const vk = `${vid}:${wh}`;
        const v = perVariant.get(vk) || { product_id: d.product_id, variant_id: vid, warehouse_id: wh, missing_qty_delta: 0 };
        v.missing_qty_delta = r3(v.missing_qty_delta + qtyDelta);
        perVariant.set(vk, v);
      }
    }
    report.products = [...perProduct.values()].map((p) => {
      const n = prodName && prodName.get(p.product_id);
      return { ...p, code: n ? n.code : '', name: n ? n.name : '', docs: [...p.docs] };
    }).sort((a, b) => a.product_id - b.product_id);
    report.variants = [...perVariant.values()].map((v) => {
      const mv = r3(mvSum.get(v.variant_id, v.warehouse_id).q);
      const vq = vws ? r3((vws.get(v.variant_id, v.warehouse_id) || {}).qty) : null;
      return { ...v, vws_qty: vq, movements_qty: mv, movements_if_backfilled: r3(mv + v.missing_qty_delta),
        drift_now: vq != null && Math.abs(vq - mv) > 0.001,
        drift_if_backfilled: vq != null && Math.abs(vq - (mv + v.missing_qty_delta)) > 0.001 };
    }).sort((a, b) => a.product_id - b.product_id || a.variant_id - b.variant_id);
  }
} finally {
  db.close();
}

if (asJson) {
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
} else {
  console.log(`DB: ${report.db}${report.skipped ? '  (skipped: ' + report.skipped + ')' : ''}`);
  console.log(`posted VR docs: ${report.docs_scanned}, lines: ${report.lines_scanned}, lines without movement: ${report.missing_lines}`);
  for (const p of report.products) {
    console.log(`  product #${p.product_id} ${p.code} ${p.name}: ${p.missing_lines} line(s), Σqty_delta=${p.missing_qty_delta}, docs=${p.docs.join(',')}`);
  }
  for (const v of report.variants) {
    console.log(`    variant ${v.variant_id}@wh${v.warehouse_id}: vws=${v.vws_qty} mov=${v.movements_qty} → ${v.movements_if_backfilled}`
      + ` drift ${v.drift_now} → ${v.drift_if_backfilled}`);
  }
}
