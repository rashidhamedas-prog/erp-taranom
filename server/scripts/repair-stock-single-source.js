'use strict';
/**
 * بازسازی موجودی تک‌منبع (فاز ۲).
 *
 * پیش‌فرض --dry-run (هیچ نوشتنی روی پایگاه نیست).
 * اعمال فقط با هر دو پرچم --apply و --i-have-go.
 *
 *   node scripts/repair-stock-single-source.js --db <copy> --out <dir>
 *   node scripts/repair-stock-single-source.js --db <copy> --out <dir> --backup-dir <dir> --apply --i-have-go
 *
 * کارها، به ترتیب، در حالت اعمال داخل یک تراکنش پس از پشتیبان better-sqlite3:
 *   ۱) مهر variant_id روی ردیف‌های کاردکس که فقط یک تطبیق قطعی با inventory_movements دارند
 *   ۲) اصلاح ارزش انتقال‌های صفر/صفر از API رسمی transfer-in-revalue (computePlan / applyInTx)
 *   ۳) rebuildAllStockCaches
 * اگر تراز آزمایشی نامیزان شود یا تطبیق زیرسیستم بدتر شود، تراکنش برمی‌گردد.
 *
 * PO-0019 هرگز لمس نمی‌شود. فایل .env خوانده نمی‌شود.
 * قاعدهٔ بها: asof_live_ledger در lib/inventory/transfer-in-revalue.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const QTY_EPS = 1e-6;
const PROD_SOURCE_TYPES = [
  'production_issue', 'production_receipt', 'production_material_return',
  'cutting_lay', 'cutting_pack', 'cutting_lay_fg_delta', 'order_cost_receipt_align',
  'production_receipt_reversal', 'production_scrap',
];
const PROD_DOC_TYPES = new Set([
  'production_fg', 'production_issue', 'production_receipt', 'cutting_pack', 'cutting_lay',
]);
const WATCH_NEGATIVE_PRODUCTS = new Set([103, 120, 122, 153]);

function parseArgs(argv) {
  const out = { apply: false, go: false, db: null, out: null, backupDir: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--dry-run') out.apply = false;
    else if (a === '--i-have-go') out.go = true;
    else if (a === '--db') out.db = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--backup-dir') out.backupDir = argv[++i];
    else if (a === '-h' || a === '--help') out.help = true;
    else {
      console.error('پرچم ناشناخته: ' + a);
      process.exit(2);
    }
  }
  return out;
}

function csvEscape(v) {
  const s = v == null ? '' : String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function writeCsv(file, headers, rows) {
  const lines = [headers.join(',')];
  for (const r of rows) lines.push(headers.map((h) => csvEscape(r[h])).join(','));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '\uFEFF' + lines.join('\n') + '\n', 'utf8');
}

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function round3(n) {
  const x = Math.round((Number(n) || 0) * 1000) / 1000;
  return Math.abs(x) < 1e-9 ? 0 : x;
}

function isReversalRow(row) {
  const et = String(row.event_type || '');
  return row.reversed_of != null || et === 'reversal' || /_reversal$/.test(et);
}

function isLiveRow(row) {
  return String(row.status || '') === 'posted'
    && row.reversed_of == null
    && String(row.event_type || '') !== 'reversal'
    && !/_reversal$/.test(String(row.event_type || ''));
}

/** Doc specs for one ledger row. Only mappings verified against the production copy. */
function docSpecs(row) {
  const st = String(row.source_type || '');
  const et = String(row.event_type || '');
  const qtyIn = Number(row.qty_in) || 0;
  const qtyOut = Number(row.qty_out) || 0;
  const sign = qtyIn > QTY_EPS ? 1 : (qtyOut > QTY_EPS ? -1 : 0);
  const qty = qtyIn > QTY_EPS ? qtyIn : qtyOut;
  const specs = [];
  const add = (docTypes, docIds, opts = {}) => {
    for (const dt of docTypes) {
      for (const id of docIds) {
        if (id == null || id === '') continue;
        specs.push({
          docType: dt,
          docId: Number(id),
          sign: opts.sign != null ? opts.sign : sign,
          qty: opts.qty != null ? opts.qty : qty,
          ignoreQty: !!opts.ignoreQty,
        });
      }
    }
  };
  if (st === 'warehouse_transfer' && et === 'transfer_out') add(['wh_transfer_out'], [row.source_id]);
  else if (st === 'warehouse_transfer' && et === 'transfer_in') add(['wh_transfer_in'], [row.source_id]);
  else if (st === 'warehouse_transfer' && (et === 'transfer_in_revalue' || et === 'transfer_out_revalue')) {
    add([et === 'transfer_out_revalue' ? 'wh_transfer_out' : 'wh_transfer_in'], [row.source_id], { ignoreQty: true, sign: 0 });
  }
  else if (st === 'warehouse_move' && (et === 'receipt' || et === 'purchase')) add(['wh_receipt'], [row.source_id]);
  else if (st === 'warehouse_move' && et === 'issue') add(['wh_issue'], [row.source_id]);
  else if (st === 'invoice' && et === 'sale') add(['invoice_sku'], [row.source_id]);
  else if (st === 'purchase') add(['purchase_sku'], [row.source_id]);
  else if ((st === 'sales_return' || st === 'sale_return') && (et === 'sale_return' || et === 'sales_return')) {
    add(['sale_return_sku'], [row.source_id]);
  }
  else if (st === 'opening_stock_doc') add(['opening_stock_doc'], [row.source_id]);
  else if (st === 'opening_inventory') add(['opening_seed'], [row.product_id]);
  else if (st === 'inventory_adjust' || st === 'stock_adjust') add(['inventory_adjust'], [row.id]);
  else if (st === 'cutting_pack') add(['cutting_pack'], [row.source_id]);
  else if (st === 'production_receipt') add(['production_fg'], [row.source_id]);
  return specs;
}

function loadPoGuard(db) {
  const ledgerIds = new Set();
  const movementIds = new Set();
  let orderId = null;
  if (tableExists(db, 'production_orders')) {
    const r = db.prepare("SELECT id FROM production_orders WHERE order_no='PO-0019'").get();
    if (r) orderId = Number(r.id);
  }
  const purchaseIds = new Set();
  for (const t of ['purchase_invoices', 'purchase_orders']) {
    if (!tableExists(db, t)) continue;
    for (const r of db.prepare(`SELECT id FROM ${t} WHERE num='PO-0019'`).all()) purchaseIds.add(Number(r.id));
  }
  const hasVariant = db.prepare("PRAGMA table_info(inventory_ledger)").all().some((c) => c.name === 'variant_id');
  const rows = db.prepare(`
    SELECT id, source_type, source_id, note, reversed_of${hasVariant ? ', variant_id' : ''}
    FROM inventory_ledger
  `).all();
  for (const r of rows) {
    const id = Number(r.id);
    if (String(r.note || '').includes('PO-0019')) ledgerIds.add(id);
    if (orderId && PROD_SOURCE_TYPES.includes(String(r.source_type || '')) && Number(r.source_id) === orderId) {
      ledgerIds.add(id);
    }
    if (purchaseIds.size && (r.source_type === 'purchase' || r.source_type === 'purchase_order')
      && purchaseIds.has(Number(r.source_id))) ledgerIds.add(id);
  }
  let grew = true;
  const byId = new Map(rows.map((r) => [Number(r.id), r]));
  while (grew) {
    grew = false;
    for (const r of rows) {
      const id = Number(r.id);
      if (ledgerIds.has(id) || r.reversed_of == null) continue;
      if (ledgerIds.has(Number(r.reversed_of))) { ledgerIds.add(id); grew = true; }
    }
  }
  if (tableExists(db, 'inventory_movements')) {
    const movs = db.prepare('SELECT id, note, doc_type, doc_id FROM inventory_movements').all();
    for (const m of movs) {
      if (String(m.note || '').includes('PO-0019')) movementIds.add(Number(m.id));
      else if (orderId && PROD_DOC_TYPES.has(String(m.doc_type || '')) && Number(m.doc_id) === orderId) {
        movementIds.add(Number(m.id));
      }
    }
  }
  return { ledgerIds, movementIds, orderId, byId };
}

function movementIndex(db, skipIds) {
  const map = new Map();
  if (!tableExists(db, 'inventory_movements')) return map;
  const rows = db.prepare(`
    SELECT id, product_id, variant_id, warehouse_id, qty_delta, doc_type, doc_id
    FROM inventory_movements
    WHERE variant_id IS NOT NULL AND variant_id > 0
  `).all();
  for (const m of rows) {
    if (skipIds.has(Number(m.id))) continue;
    const wh = m.warehouse_id == null ? '' : String(Number(m.warehouse_id));
    const k = `${m.doc_type}|${Number(m.doc_id)}|${Number(m.product_id)}|${wh}`;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(m);
  }
  return map;
}

function matchVariants(row, index) {
  const vids = new Set();
  const mids = [];
  for (const s of docSpecs(row)) {
    const wh = row.warehouse_id == null ? '' : String(Number(row.warehouse_id));
    const list = index.get(`${s.docType}|${s.docId}|${Number(row.product_id)}|${wh}`) || [];
    for (const m of list) {
      if (!s.ignoreQty) {
        const md = Number(m.qty_delta) || 0;
        if (s.sign > 0 && !(md > QTY_EPS)) continue;
        if (s.sign < 0 && !(md < -QTY_EPS)) continue;
        if (s.sign === 0) continue;
        if (Math.abs(Math.abs(md) - s.qty) > 1e-4) continue;
      }
      vids.add(Number(m.variant_id));
      mids.push(Number(m.id));
    }
  }
  return { variants: [...vids], movement_ids: mids };
}

function positiveVariant(v) {
  const n = Number(v);
  return n > 0 ? n : null;
}

/**
 * Plan variant stamps. Does not write.
 * @returns {{ stamps: object[], ambiguous: object[], unmatched: number }}
 */
function planVariantBackfill(db, po) {
  const hasVariant = db.prepare('PRAGMA table_info(inventory_ledger)').all().some((c) => c.name === 'variant_id');
  if (!hasVariant) return { stamps: [], ambiguous: [], unmatched: 0, error: 'inventory_ledger.variant_id نیست' };
  const index = movementIndex(db, po.movementIds);
  const rows = db.prepare(`
    SELECT id, product_id, warehouse_id, variant_id, qty_in, qty_out, event_type, source_type, source_id,
           status, reversed_of, note
    FROM inventory_ledger
    WHERE variant_id IS NULL
  `).all();
  const stamps = [];
  const ambiguous = [];
  let unmatched = 0;
  const planned = new Map();
  const originals = rows.filter((r) => !isReversalRow(r) && !po.ledgerIds.has(Number(r.id)));
  for (const row of originals) {
    const hit = matchVariants(row, index);
    if (hit.variants.length === 1) {
      const rec = {
        ledger_id: Number(row.id), product_id: Number(row.product_id),
        warehouse_id: row.warehouse_id == null ? null : Number(row.warehouse_id),
        event_type: row.event_type, source_type: row.source_type, source_id: row.source_id,
        qty_in: Number(row.qty_in) || 0, qty_out: Number(row.qty_out) || 0,
        status: row.status, reversed_of: row.reversed_of,
        variant_id: hit.variants[0], via: 'movement', movement_ids: hit.movement_ids.join('|'),
      };
      stamps.push(rec);
      planned.set(rec.ledger_id, rec.variant_id);
    } else if (hit.variants.length > 1) {
      ambiguous.push({
        ledger_id: Number(row.id), product_id: Number(row.product_id),
        warehouse_id: row.warehouse_id, event_type: row.event_type, source_type: row.source_type,
        source_id: row.source_id, variants: hit.variants.join('|'), movement_ids: hit.movement_ids.join('|'),
        detail: 'بیش از یک واریانت در حرکت‌های هم‌مشخصات',
      });
    } else unmatched += 1;
  }
  const variantOf = (id) => {
    if (planned.has(id)) return planned.get(id);
    const row = po.byId.get(id);
    if (!row) {
      const live = db.prepare('SELECT variant_id FROM inventory_ledger WHERE id=?').get(id);
      return positiveVariant(live && live.variant_id);
    }
    return positiveVariant(row.variant_id);
  };
  // Revalue legs have qty 0, so the qty join misses them. Copy the sibling leg's variant.
  const revalueLeft = rows.filter((r) => !po.ledgerIds.has(Number(r.id)) && !planned.has(Number(r.id))
    && String(r.source_type || '') === 'warehouse_transfer'
    && (r.event_type === 'transfer_in_revalue' || r.event_type === 'transfer_out_revalue'));
  for (const row of revalueLeft) {
    const sibs = db.prepare(`
      SELECT id, variant_id FROM inventory_ledger
      WHERE source_type='warehouse_transfer' AND source_id=? AND product_id=?
        AND event_type IN ('transfer_in','transfer_out')
        AND status='posted' AND reversed_of IS NULL
    `).all(row.source_id, row.product_id);
    const vids = new Set();
    for (const s of sibs) {
      const v = variantOf(Number(s.id));
      if (v) vids.add(v);
    }
    if (vids.size === 1) {
      const vid = [...vids][0];
      const rec = {
        ledger_id: Number(row.id), product_id: Number(row.product_id),
        warehouse_id: row.warehouse_id == null ? null : Number(row.warehouse_id),
        event_type: row.event_type, source_type: row.source_type, source_id: row.source_id,
        qty_in: 0, qty_out: 0, status: row.status, reversed_of: row.reversed_of,
        variant_id: vid, via: 'sibling_leg', movement_ids: '',
      };
      stamps.push(rec);
      planned.set(rec.ledger_id, vid);
    } else if (vids.size > 1) {
      ambiguous.push({
        ledger_id: Number(row.id), product_id: Number(row.product_id),
        warehouse_id: row.warehouse_id, event_type: row.event_type, source_type: row.source_type,
        source_id: row.source_id, variants: [...vids].join('|'), movement_ids: '',
        detail: 'واریانت دو طرف انتقال یکسان نیست',
      });
    } else unmatched += 1;
  }
  const reversals = rows.filter((r) => isReversalRow(r) && !po.ledgerIds.has(Number(r.id)) && !planned.has(Number(r.id)));
  for (const row of reversals) {
    const orig = Number(row.reversed_of);
    if (!orig) { unmatched += 1; continue; }
    if (po.ledgerIds.has(orig)) continue;
    const vid = variantOf(orig);
    if (!vid) { unmatched += 1; continue; }
    const rec = {
      ledger_id: Number(row.id), product_id: Number(row.product_id),
      warehouse_id: row.warehouse_id == null ? null : Number(row.warehouse_id),
      event_type: row.event_type, source_type: row.source_type, source_id: row.source_id,
      qty_in: Number(row.qty_in) || 0, qty_out: Number(row.qty_out) || 0,
      status: row.status, reversed_of: row.reversed_of,
      variant_id: vid, via: 'reversal_inherit', movement_ids: '',
    };
    stamps.push(rec);
    planned.set(rec.ledger_id, vid);
  }
  return { stamps, ambiguous, unmatched };
}

function applyStamps(db, stamps, userId) {
  const upd = db.prepare('UPDATE inventory_ledger SET variant_id=? WHERE id=? AND variant_id IS NULL');
  let n = 0;
  const audit = db.prepare('INSERT INTO audit_log (user_id, action, entity, entity_id, detail) VALUES (?,?,?,?,?)');
  for (const s of stamps) {
    const info = upd.run(s.variant_id, s.ledger_id);
    if (!info.changes) continue;
    n += 1;
    try {
      audit.run(userId || null, 'ledger_variant_backfill', 'inventory_ledger', s.ledger_id,
        JSON.stringify({ variant_id: s.variant_id, via: s.via, movement_ids: s.movement_ids }).slice(0, 4000));
    } catch (_) { /* audit optional */ }
  }
  return n;
}

function zeroCandidates(plan) {
  return (plan.candidates || []).filter((c) => c.kind === 'zero_zero');
}

function perWarehouse(db, cands) {
  const m = new Map();
  const nameOf = (id) => {
    try {
      const r = db.prepare('SELECT name FROM warehouses WHERE id=?').get(id);
      return r ? r.name : '';
    } catch (_) { return ''; }
  };
  const add = (id, amt) => {
    if (id == null) return;
    if (!m.has(id)) m.set(id, { warehouse_id: id, warehouse_name: nameOf(id), count: 0, amount_rial: 0 });
    const w = m.get(id);
    w.count += 1;
    w.amount_rial += amt;
  };
  for (const c of cands) {
    add(c.from_warehouse_id, -c.delta_rial);
    add(c.to_warehouse_id, c.delta_rial);
  }
  return [...m.values()].sort((a, b) => a.warehouse_id - b.warehouse_id);
}

function matrixIds(db) {
  if (!tableExists(db, 'product_variants')) return new Set();
  const cols = new Set(db.prepare('PRAGMA table_info(product_variants)').all().map((c) => c.name));
  const active = cols.has('active') ? 'COALESCE(active,1)=1' : '1=1';
  const def = cols.has('is_default') ? 'COALESCE(is_default,0)=0' : '1=1';
  return new Set(db.prepare(`SELECT DISTINCT product_id FROM product_variants WHERE ${active} AND ${def}`).all()
    .map((r) => Number(r.product_id)));
}

function manualRows(db, { ambiguous, plan, stamps }) {
  const { LEDGER_LIVE_SQL } = require('../lib/inventory/layer-reconcile');
  const codes = new Map(db.prepare('SELECT id, code FROM products').all().map((p) => [Number(p.id), p.code || '']));
  const rows = [];
  const inv = db.prepare('SELECT id, product_id, variant_id, warehouse_id, qty_in, amount_rial, date, source_type, source_id, note, tx_no FROM inventory_ledger WHERE id=2347').get();
  let movWh = [];
  if (tableExists(db, 'inventory_movements')) {
    movWh = db.prepare('SELECT DISTINCT warehouse_id FROM inventory_movements WHERE product_id=9 AND variant_id=202').all()
      .map((r) => r.warehouse_id);
  }
  rows.push({
    kind: 'inv_2347',
    product_id: inv ? inv.product_id : 9,
    code: codes.get(inv ? Number(inv.product_id) : 9) || '',
    ledger_id: 2347,
    warehouse_id: inv ? inv.warehouse_id : '',
    variant_id: inv ? inv.variant_id : 202,
    detail: inv
      ? `کاردکس ${inv.tx_no || 2347} افتتاحیه در انبار ${inv.warehouse_id}؛ حرکت‌های واریانت ۲۰۲ در انبارهای ${movWh.join('|') || '—'} — جابه‌جا نمی‌شود`
      : 'ردیف ۲۳۴۷ در این پایگاه نیست',
  });
  if (tableExists(db, 'inventory_ledger')) {
    const neg = db.prepare(`
      SELECT l.product_id, p.code, l.warehouse_id,
             ROUND(SUM(COALESCE(l.qty_in,0)-COALESCE(l.qty_out,0)), 3) AS qty
      FROM inventory_ledger l
      LEFT JOIN products p ON p.id=l.product_id
      WHERE ${LEDGER_LIVE_SQL.replace(/\bstatus\b/g, 'l.status').replace(/\breversed_of\b/g, 'l.reversed_of').replace(/\bevent_type\b/g, 'l.event_type')}
      GROUP BY l.product_id, l.warehouse_id
      HAVING SUM(COALESCE(l.qty_in,0)-COALESCE(l.qty_out,0)) < -0.0000001
    `).all();
    for (const n of neg) {
      const watched = WATCH_NEGATIVE_PRODUCTS.has(Number(n.product_id));
      rows.push({
        kind: 'live_negative',
        product_id: n.product_id,
        code: n.code || '',
        ledger_id: '',
        warehouse_id: n.warehouse_id,
        variant_id: '',
        detail: `موجودی زنده ${n.qty}${watched ? ' — قلم شناخته‌شده؛ اصلاح خودکار نمی‌شود' : ''}`,
      });
    }
  }
  const stampMap = new Map(stamps.map((s) => [s.ledger_id, s.variant_id]));
  const live = db.prepare(`
    SELECT id, product_id, warehouse_id, variant_id, qty_in, qty_out
    FROM inventory_ledger WHERE ${LEDGER_LIVE_SQL}
  `).all();
  const mx = matrixIds(db);
  const ua = new Map();
  for (const r of live) {
    if (!mx.has(Number(r.product_id))) continue;
    const vid = stampMap.get(Number(r.id)) || positiveVariant(r.variant_id);
    if (vid) continue;
    const k = `${r.product_id}:${r.warehouse_id == null ? '' : r.warehouse_id}`;
    ua.set(k, (ua.get(k) || 0) + (Number(r.qty_in) || 0) - (Number(r.qty_out) || 0));
  }
  for (const [k, q] of ua) {
    if (Math.abs(q) < 1e-6) continue;
    const [pid, wh] = k.split(':');
    rows.push({
      kind: 'unattributed_matrix',
      product_id: Number(pid),
      code: codes.get(Number(pid)) || '',
      ledger_id: '',
      warehouse_id: wh,
      variant_id: '',
      detail: `مقدار بدون واریانت پس از مهر قطعی: ${round3(q)}`,
    });
  }
  for (const e of (plan.excluded || [])) {
    if (e.reason !== 'coa_mismatch') continue;
    rows.push({
      kind: 'coa_mismatch',
      product_id: e.product_id || '',
      code: codes.get(Number(e.product_id)) || '',
      ledger_id: e.in_id || '',
      warehouse_id: e.to_warehouse_id || '',
      variant_id: e.variant_id || '',
      detail: `مبدأ ${e.from_warehouse_id || '—'} حساب ${e.from_coa || '—'} → مقصد حساب ${e.to_coa || '—'}`,
    });
  }
  for (const a of ambiguous) {
    rows.push({
      kind: 'ambiguous_variant',
      product_id: a.product_id,
      code: codes.get(Number(a.product_id)) || '',
      ledger_id: a.ledger_id,
      warehouse_id: a.warehouse_id == null ? '' : a.warehouse_id,
      variant_id: a.variants,
      detail: a.detail,
    });
  }
  return rows;
}

function simulateDerive(db, pid, stamps) {
  const d = require('../lib/inventory/stock-cache').deriveProductStock(db, pid);
  for (const s of stamps) {
    if (Number(s.product_id) !== Number(pid) || !isLiveRow(s)) continue;
    const q = (Number(s.qty_in) || 0) - (Number(s.qty_out) || 0);
    const hq = s.event_type === 'cutting_pack' ? 0 : q;
    const wh = s.warehouse_id != null ? Number(s.warehouse_id) : null;
    const vid = Number(s.variant_id);
    if (wh) d.unattributed.set(wh, round3((d.unattributed.get(wh) || 0) - q));
    d.variants.set(vid, round3((d.variants.get(vid) || 0) + hq));
    if (wh) {
      const k = `${vid}:${wh}`;
      d.variantWarehouses.set(k, round3((d.variantWarehouses.get(k) || 0) + q));
    }
  }
  return d;
}

function cacheDiffFromDerive(db, stamps) {
  const products = db.prepare('SELECT id, code, COALESCE(stock,0) AS stock FROM products').all();
  const diff = [];
  const whRows = tableExists(db, 'warehouse_stock')
    ? db.prepare('SELECT product_id, warehouse_id, qty FROM warehouse_stock').all() : [];
  const vsRows = tableExists(db, 'product_variants')
    ? db.prepare('SELECT id, product_id, COALESCE(stock,0) AS stock FROM product_variants').all() : [];
  const vwsRows = tableExists(db, 'variant_warehouse_stock')
    ? db.prepare('SELECT variant_id, warehouse_id, qty FROM variant_warehouse_stock').all() : [];
  const whByP = new Map();
  for (const r of whRows) {
    const pid = Number(r.product_id);
    if (!whByP.has(pid)) whByP.set(pid, []);
    whByP.get(pid).push(r);
  }
  const vsByP = new Map();
  for (const r of vsRows) {
    const pid = Number(r.product_id);
    if (!vsByP.has(pid)) vsByP.set(pid, []);
    vsByP.get(pid).push(r);
  }
  const vOf = new Map(vsRows.map((r) => [Number(r.id), Number(r.product_id)]));
  const vwsByP = new Map();
  for (const r of vwsRows) {
    const pid = vOf.get(Number(r.variant_id));
    if (!pid) continue;
    if (!vwsByP.has(pid)) vwsByP.set(pid, []);
    vwsByP.get(pid).push(r);
  }
  const push = (rec) => {
    if (round3(rec.before) === round3(rec.after)) return;
    diff.push(rec);
  };
  for (const p of products) {
    const pid = Number(p.id);
    const d = simulateDerive(db, pid, stamps);
    push({ product: pid, code: p.code || '', level: 'product', warehouse: '', variant: '', before: round3(p.stock), after: d.header });
    const seenW = new Set();
    for (const r of whByP.get(pid) || []) {
      const wh = Number(r.warehouse_id);
      seenW.add(wh);
      push({ product: pid, code: p.code || '', level: 'warehouse', warehouse: wh, variant: '', before: round3(r.qty), after: d.warehouses.get(wh) || 0 });
    }
    for (const [wh, q] of d.warehouses) {
      if (seenW.has(wh)) continue;
      push({ product: pid, code: p.code || '', level: 'warehouse', warehouse: wh, variant: '', before: 0, after: q });
    }
    const seenV = new Set();
    for (const v of vsByP.get(pid) || []) {
      const vid = Number(v.id);
      seenV.add(vid);
      push({ product: pid, code: p.code || '', level: 'variant', warehouse: '', variant: vid, before: round3(v.stock), after: d.variants.get(vid) || 0 });
    }
    const seenK = new Set();
    for (const r of vwsByP.get(pid) || []) {
      const k = `${Number(r.variant_id)}:${Number(r.warehouse_id)}`;
      seenK.add(k);
      push({
        product: pid, code: p.code || '', level: 'variant_warehouse',
        warehouse: Number(r.warehouse_id), variant: Number(r.variant_id),
        before: round3(r.qty), after: d.variantWarehouses.get(k) || 0,
      });
    }
    for (const [k, q] of d.variantWarehouses) {
      if (seenK.has(k)) continue;
      const [vid, wh] = k.split(':').map(Number);
      if (!seenV.has(vid)) continue;
      push({ product: pid, code: p.code || '', level: 'variant_warehouse', warehouse: wh, variant: vid, before: 0, after: q });
    }
  }
  return diff;
}

function snapshotFigures(db) {
  const rows = [];
  for (const p of db.prepare('SELECT id, code, COALESCE(stock,0) AS stock FROM products').all()) {
    rows.push({ product: Number(p.id), code: p.code || '', level: 'product', warehouse: '', variant: '', qty: round3(p.stock) });
  }
  if (tableExists(db, 'warehouse_stock')) {
    const codes = new Map(db.prepare('SELECT id, code FROM products').all().map((p) => [Number(p.id), p.code || '']));
    for (const r of db.prepare('SELECT product_id, warehouse_id, qty FROM warehouse_stock').all()) {
      rows.push({
        product: Number(r.product_id), code: codes.get(Number(r.product_id)) || '',
        level: 'warehouse', warehouse: Number(r.warehouse_id), variant: '', qty: round3(r.qty),
      });
    }
  }
  if (tableExists(db, 'product_variants')) {
    for (const r of db.prepare(`
      SELECT v.id, v.product_id, COALESCE(v.stock,0) AS stock, p.code
      FROM product_variants v LEFT JOIN products p ON p.id=v.product_id
    `).all()) {
      rows.push({
        product: Number(r.product_id), code: r.code || '', level: 'variant',
        warehouse: '', variant: Number(r.id), qty: round3(r.stock),
      });
    }
  }
  if (tableExists(db, 'variant_warehouse_stock') && tableExists(db, 'product_variants')) {
    for (const r of db.prepare(`
      SELECT s.variant_id, s.warehouse_id, s.qty, v.product_id, p.code
      FROM variant_warehouse_stock s
      JOIN product_variants v ON v.id=s.variant_id
      LEFT JOIN products p ON p.id=v.product_id
    `).all()) {
      rows.push({
        product: Number(r.product_id), code: r.code || '', level: 'variant_warehouse',
        warehouse: Number(r.warehouse_id), variant: Number(r.variant_id), qty: round3(r.qty),
      });
    }
  }
  return rows;
}

function diffSnapshots(before, after) {
  const key = (r) => `${r.product}|${r.level}|${r.warehouse}|${r.variant}`;
  const b = new Map(before.map((r) => [key(r), r]));
  const a = new Map(after.map((r) => [key(r), r]));
  const diff = [];
  for (const k of new Set([...b.keys(), ...a.keys()])) {
    const x = b.get(k);
    const y = a.get(k);
    const beforeQty = x ? x.qty : 0;
    const afterQty = y ? y.qty : 0;
    if (round3(beforeQty) === round3(afterQty)) continue;
    const src = y || x;
    diff.push({
      product: src.product, code: src.code, level: src.level,
      warehouse: src.warehouse, variant: src.variant, before: beforeQty, after: afterQty,
    });
  }
  return diff;
}

function trialBalance(db) {
  const GM = require('../lib/gl-metrics');
  const { SQL_JL_DEBIT_RIAL, SQL_JL_CREDIT_RIAL } = require('../lib/money');
  const unbalanced = GM.unbalancedEntryCount(db);
  const tot = db.prepare(`
    SELECT COALESCE(SUM(${SQL_JL_DEBIT_RIAL}),0) AS d, COALESCE(SUM(${SQL_JL_CREDIT_RIAL}),0) AS c
    FROM journal_lines jl JOIN journal_entries je ON jl.entry_id = je.id
    WHERE ${GM.JE_ALIVE} AND ${GM.JE_APPROVED}
  `).get();
  const debit = Math.round(Number(tot.d) || 0);
  const credit = Math.round(Number(tot.c) || 0);
  return { balanced: unbalanced === 0 && debit === credit, unbalanced, debit, credit };
}

function packRecon(r) {
  const s = (r && r.summary) || {};
  const abs = ((r && r.checks) || []).reduce((n, c) => n + Math.abs(Math.round(Number(c.diff_rial) || 0)), 0);
  return {
    ok: s.ok || 0, warn: s.warn || 0, error: s.error || 0, info: s.info || 0, rounding: s.rounding || 0,
    score: (s.error || 0) * 100 + (s.warn || 0) * 10 + (s.rounding || 0),
    abs_diff_rial: abs,
  };
}

function reconWorse(before, after) {
  return after.score > before.score || after.error > before.error || after.abs_diff_rial > before.abs_diff_rial + 1;
}

/**
 * Prod copies can still carry the pre-SSOT negative triggers, which reject a cache
 * rebuild that mirrors a live negative. Boot replaces those triggers (schema.js /
 * pack-matrix-schema.js) so stock_cache_writer_flag is exempt. Do the same here,
 * inside the repair transaction, before rebuildAllStockCaches.
 */
function ensureCacheWriterTriggers(db) {
  require('../lib/inventory/stock-cache').ensureStockCacheSchema(db);
  if (tableExists(db, 'warehouse_stock')) {
    db.exec(`
      DROP TRIGGER IF EXISTS trg_ws_no_negative;
      DROP TRIGGER IF EXISTS trg_ws_no_negative_ins;
      CREATE TRIGGER trg_ws_no_negative
      BEFORE UPDATE ON warehouse_stock
      WHEN NEW.qty < 0
      BEGIN
        SELECT RAISE(ABORT, 'E_NEGATIVE_STOCK: موجودی انبار منفی می‌شود')
        WHERE NOT EXISTS (
          SELECT 1 FROM warehouses w
          WHERE w.id = NEW.warehouse_id AND COALESCE(w.allow_negative, 0) = 1
        )
        AND NOT EXISTS (
          SELECT 1 FROM settings s
          WHERE s.key = 'inventory_allow_negative' AND s.value = '1'
        )
        AND NOT EXISTS (
          SELECT 1 FROM erp_neg_override_flags o WHERE o.id=1 AND COALESCE(o.active,0)=1
        )
        AND NOT EXISTS (
          SELECT 1 FROM stock_cache_writer_flag f WHERE f.id=1 AND COALESCE(f.active,0)=1
        );
      END;
      CREATE TRIGGER trg_ws_no_negative_ins
      BEFORE INSERT ON warehouse_stock
      WHEN NEW.qty < 0
      BEGIN
        SELECT RAISE(ABORT, 'E_NEGATIVE_STOCK: موجودی انبار منفی می‌شود')
        WHERE NOT EXISTS (
          SELECT 1 FROM warehouses w
          WHERE w.id = NEW.warehouse_id AND COALESCE(w.allow_negative, 0) = 1
        )
        AND NOT EXISTS (
          SELECT 1 FROM settings s
          WHERE s.key = 'inventory_allow_negative' AND s.value = '1'
        )
        AND NOT EXISTS (
          SELECT 1 FROM erp_neg_override_flags o WHERE o.id=1 AND COALESCE(o.active,0)=1
        )
        AND NOT EXISTS (
          SELECT 1 FROM stock_cache_writer_flag f WHERE f.id=1 AND COALESCE(f.active,0)=1
        );
      END;
    `);
  }
  if (tableExists(db, 'variant_warehouse_stock')) {
    db.exec(`
      DROP TRIGGER IF EXISTS trg_vws_no_negative;
      DROP TRIGGER IF EXISTS trg_vws_no_negative_ins;
      CREATE TRIGGER trg_vws_no_negative
      BEFORE UPDATE ON variant_warehouse_stock
      WHEN NEW.qty < 0
      BEGIN
        SELECT RAISE(ABORT, 'E_NEGATIVE_STOCK: موجودی واریانت×انبار منفی می‌شود')
        WHERE NOT EXISTS (
          SELECT 1 FROM warehouses w
          WHERE w.id = NEW.warehouse_id AND COALESCE(w.allow_negative, 0) = 1
        )
        AND NOT EXISTS (
          SELECT 1 FROM settings s
          WHERE s.key = 'inventory_allow_negative' AND s.value = '1'
        )
        AND NOT EXISTS (
          SELECT 1 FROM stock_cache_writer_flag f WHERE f.id=1 AND COALESCE(f.active,0)=1
        );
      END;
      CREATE TRIGGER trg_vws_no_negative_ins
      BEFORE INSERT ON variant_warehouse_stock
      WHEN NEW.qty < 0
      BEGIN
        SELECT RAISE(ABORT, 'E_NEGATIVE_STOCK: موجودی واریانت×انبار منفی می‌شود')
        WHERE NOT EXISTS (
          SELECT 1 FROM warehouses w
          WHERE w.id = NEW.warehouse_id AND COALESCE(w.allow_negative, 0) = 1
        )
        AND NOT EXISTS (
          SELECT 1 FROM settings s
          WHERE s.key = 'inventory_allow_negative' AND s.value = '1'
        )
        AND NOT EXISTS (
          SELECT 1 FROM stock_cache_writer_flag f WHERE f.id=1 AND COALESCE(f.active,0)=1
        );
      END;
    `);
  }
}

function adminId(db) {
  try {
    const r = db.prepare("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1").get();
    return r ? Number(r.id) : null;
  } catch (_) { return null; }
}

function help() {
  console.log(`بازسازی موجودی تک‌منبع
  --dry-run          پیش‌فرض؛ فقط گزارش و CSV
  --apply            نوشتن (حتماً با --i-have-go)
  --i-have-go        تأیید آگاهانهٔ اعمال
  --db <path>        پیش‌فرض DB_PATH یا server/crm.db
  --out <dir>        پوشهٔ CSV
  --backup-dir <dir> پوشهٔ پشتیبان (پیش‌فرض ~/backups یا STOCK_REPAIR_BACKUP_DIR)`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { help(); return; }
  if (args.apply && !args.go) {
    console.error('اعمال نیاز به هر دو پرچم --apply و --i-have-go دارد. بدون آن‌ها هیچ نوشتنی انجام نمی‌شود.');
    process.exit(2);
  }
  const dbPath = path.resolve(args.db || process.env.DB_PATH || path.join(__dirname, '..', 'crm.db'));
  if (!fs.existsSync(dbPath)) {
    console.error('پایگاه پیدا نشد: ' + dbPath);
    process.exit(1);
  }
  if (args.apply && /prod-copy\.db$/i.test(path.basename(dbPath))) {
    console.error('اعمال روی prod-copy.db ممنوع است. ابتدا یک کپی بگیرید.');
    process.exit(1);
  }
  process.env.DB_PATH = dbPath;
  const outDir = path.resolve(args.out || path.join(os.tmpdir(), 'stock-repair-' + Date.now()));
  fs.mkdirSync(outDir, { recursive: true });
  const Database = require('better-sqlite3');
  const db = new Database(dbPath, { readonly: !args.apply, fileMustExist: true });
  if (args.apply) db.pragma('foreign_keys = ON');

  const po = loadPoGuard(db);
  const backfill = planVariantBackfill(db, po);
  const TI = require('../lib/inventory/transfer-in-revalue');
  const plan = TI.computePlan(db, { includeZeroZero: true });
  const zeros = zeroCandidates(plan);
  const wh = perWarehouse(db, zeros);
  const manual = manualRows(db, { ambiguous: backfill.ambiguous, plan, stamps: backfill.stamps });
  const diff = args.apply ? null : cacheDiffFromDerive(db, backfill.stamps);
  const changedProducts = new Set((diff || []).map((r) => r.product));

  const summary = {
    mode: args.apply ? 'apply' : 'dry-run',
    db: dbPath,
    out: outDir,
    po_0019_ledger_rows: po.ledgerIds.size,
    variant_backfill: {
      count: backfill.stamps.length,
      ambiguous: backfill.ambiguous.length,
      unmatched: backfill.unmatched,
    },
    revalue: {
      rule: TI.COST_RULE,
      candidates: zeros.length,
      sum_rial: zeros.reduce((s, c) => s + c.delta_rial, 0),
      per_warehouse: wh,
      excluded_by_reason: plan.excluded_summary,
      inbound_leak_not_posted: (plan.candidates || []).filter((c) => c.kind === 'inbound_leak').length,
      blocker: plan.blocker ? plan.blocker.code : null,
      posted: 0,
    },
    figures_changed_products: changedProducts.size,
    manual: {
      count: manual.length,
      by_kind: manual.reduce((m, r) => { m[r.kind] = (m[r.kind] || 0) + 1; return m; }, {}),
    },
  };

  writeCsv(path.join(outDir, 'variant-backfill.csv'),
    ['ledger_id', 'product_id', 'warehouse_id', 'event_type', 'variant_id', 'via', 'movement_ids'],
    backfill.stamps);
  writeCsv(path.join(outDir, 'variant-ambiguous.csv'),
    ['ledger_id', 'product_id', 'warehouse_id', 'event_type', 'source_type', 'source_id', 'variants', 'movement_ids', 'detail'],
    backfill.ambiguous);
  writeCsv(path.join(outDir, 'revalue-candidates.csv'),
    ['kind', 'in_id', 'out_id', 'product_id', 'variant_id', 'from_warehouse_id', 'to_warehouse_id', 'qty', 'delta_rial', 'unit_rial', 'transfer_date', 'rule'],
    zeros);
  writeCsv(path.join(outDir, 'revalue-excluded.csv'),
    ['in_id', 'out_id', 'product_id', 'reason', 'reason_fa', 'from_warehouse_id', 'to_warehouse_id'],
    plan.excluded || []);
  writeCsv(path.join(outDir, 'manual.csv'),
    ['kind', 'product_id', 'code', 'ledger_id', 'warehouse_id', 'variant_id', 'detail'],
    manual);

  if (!args.apply) {
    writeCsv(path.join(outDir, 'cache-diff.csv'),
      ['product', 'code', 'level', 'warehouse', 'variant', 'before', 'after'], diff);
    db.close();
    console.log('حالت پیش‌نمایش. هیچ ردیفی نوشته نشد.');
    console.log('SUMMARY ' + JSON.stringify(summary));
    printManual(manual);
    return;
  }

  const beforeSnap = snapshotFigures(db);
  const trialBefore = trialBalance(db);
  const { runRecon } = require('../lib/subledger-recon');
  const reconBefore = packRecon(runRecon(db, { persist: false }));
  summary.trial_before = trialBefore;
  summary.recon_before = reconBefore;

  const backupDir = path.resolve(args.backupDir || process.env.STOCK_REPAIR_BACKUP_DIR || path.join(os.homedir(), 'backups'));
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(backupDir, 'crm.db.pre-stock-rebuild-' + stamp);
  await db.backup(backupPath);
  summary.backup = backupPath;

  const uid = adminId(db);
  const reason = 'بازسازی موجودی تک‌منبع — اصلاح انتقال با بهای صفر';
  let posted = 0;
  const tx = db.transaction(() => {
    ensureCacheWriterTriggers(db);
    applyStamps(db, backfill.stamps, uid);
    if (!plan.blocker && zeros.length) {
      const applied = TI.applyInTx(db, {
        includeZeroZero: true,
        ids: zeros.map((c) => c.in_id),
        reason,
        user: uid ? { id: uid } : null,
      });
      posted = applied.rows.length;
    }
    require('../lib/inventory/stock-cache').rebuildAllStockCaches(db);
    const trialAfter = trialBalance(db);
    const reconAfter = packRecon(runRecon(db, { persist: false }));
    if (!trialAfter.balanced) {
      const err = new Error('تراز آزمایشی پس از بازسازی میزان نیست؛ تراکنش برگشت');
      err.trialAfter = trialAfter;
      err.reconAfter = reconAfter;
      throw err;
    }
    if (reconWorse(reconBefore, reconAfter)) {
      const err = new Error('تطبیق زیرسیستم‌ها بدتر شد؛ تراکنش برگشت');
      err.trialAfter = trialAfter;
      err.reconAfter = reconAfter;
      throw err;
    }
    return { posted, trialAfter, reconAfter };
  });

  let result;
  try {
    result = tx();
  } catch (e) {
    summary.rolled_back = true;
    summary.error = e.message;
    summary.trial_after = e.trialAfter || null;
    summary.recon_after = e.reconAfter || null;
    db.close();
    console.error(e.message);
    console.log('SUMMARY ' + JSON.stringify(summary));
    process.exit(1);
  }
  summary.revalue.posted = result.posted;
  summary.trial_after = result.trialAfter;
  summary.recon_after = result.reconAfter;
  const afterSnap = snapshotFigures(db);
  const appliedDiff = diffSnapshots(beforeSnap, afterSnap);
  summary.figures_changed_products = new Set(appliedDiff.map((r) => r.product)).size;
  const SC = require('../lib/inventory/stock-cache');
  const vs = SC.stockCacheVsLedger(db, { limit: 5000 });
  summary.stock_cache = {
    mismatch_count: vs.mismatch_count,
    mismatched_products: vs.mismatched_products,
    unattributed_count: vs.unattributed_count,
  };
  writeCsv(path.join(outDir, 'cache-diff.csv'),
    ['product', 'code', 'level', 'warehouse', 'variant', 'before', 'after'], appliedDiff);
  db.close();
  console.log('اعمال شد. پشتیبان: ' + backupPath);
  console.log('SUMMARY ' + JSON.stringify(summary));
  printManual(manual);
}

function printManual(manual) {
  console.log('--- تصمیم دستی (' + manual.length + ') ---');
  for (const r of manual) {
    console.log([r.kind, r.product_id, r.code, r.ledger_id, r.warehouse_id, r.detail].join('\t'));
  }
}

main().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
