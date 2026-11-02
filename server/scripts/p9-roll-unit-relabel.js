#!/usr/bin/env node
'use strict';
/**
 * P9 — اصلاح برچسب واحد طاقه/بچ به واحد خود کالا (عمومی، نه فقط کالای ۳۳۳).
 *
 * پیش‌فرض: DRY-RUN فقط‌خواندنی. هیچ نوشتنی در دیتابیس انجام نمی‌شود و یک CSV می‌سازد.
 *
 *   node server/scripts/p9-roll-unit-relabel.js [--db=path] [--csv=path] [--sqlite=path/to/better-sqlite3]
 *   node server/scripts/p9-roll-unit-relabel.js --apply --i-have-approval --product=333 --reason="..." [--user-id=1]
 *   node server/scripts/p9-roll-unit-relabel.js --reverse=<group_key> --i-have-approval --reason="..."
 *
 * طبقه‌بندی هر بچ با واحد ≠ واحد کالا:
 *   relabel             — فقط برچسب غلط است (مقدار/مبلغ از اول به واحد کالاست) → پیشنهاد اصلاح برچسب بدون تغییر مقدار/مبلغ.
 *   conversion_needed   — شواهد می‌گوید عددها واقعاً به واحد دیگری است (ردیف خرید/دفتر/ورود تبدیل‌نشده/لایه با واحد دیگر).
 *                          اصلاح برچسب پیشنهاد نمی‌شود؛ بررسی دستی و تبدیل مقدار لازم است.
 *   review_cross_dimension — بعد واحد بچ با بعد واحد کالا فرق دارد (مثلاً m روی کالای کیلویی) و سند خرید هم‌مقدار نیست.
 *   unknown_unit        — واحد بچ یا کالا در کاتالوگ شناخته نشد.
 *
 * apply: فقط ردیف‌های relabel همان کالاهای --product، در یک تراکنش؛ هر بچ یک ردیف fabric_roll_unit_relabels
 * (group_key مشترک) + audit_log. مقدار، مبلغ، دفتر انبار و سند حسابداری دست نمی‌خورند. reverse = بازگردانی همان گروه (R13).
 * Conversion only through server/lib/uom.js (single source).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const uom = require('../lib/uom');

const EPS = 1e-6;

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (m) out[m[1]] = m[2] == null ? true : m[2];
  }
  return out;
}

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function columns(db, table) {
  if (!tableExists(db, table)) return [];
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

function parseRows(raw) {
  if (Array.isArray(raw)) return raw;
  try {
    const v = JSON.parse(raw || '[]');
    return Array.isArray(v) ? v : [];
  } catch (_) {
    return [];
  }
}

function near(a, b, tol = EPS) {
  return Math.abs((Number(a) || 0) - (Number(b) || 0)) <= tol;
}

function liveQty(db, b) {
  const agg = db.prepare(`
    SELECT COALESCE(SUM(qty_in),0) qi, COALESCE(SUM(qty_out),0) qo, COUNT(*) n
    FROM inventory_ledger WHERE batch_id=?
  `).get(b.id);
  const received = Number(b.qty_received) || 0;
  if (!agg || !Number(agg.n)) return Number(b.qty_on_hand) || 0;
  if (received > 0 && Number(agg.qi) + 1e-9 < received) return received + Number(agg.qi) - Number(agg.qo);
  if (Number(agg.qi) > 0) return Number(agg.qi) - Number(agg.qo);
  return received - Number(agg.qo);
}

/** Receipt ledger row of the batch (batch.ledger_id, else first live qty_in row tagged with the batch). */
function receiptLedger(db, b) {
  if (b.ledger_id) {
    const r = db.prepare('SELECT id, qty_in, source_type, source_id, status FROM inventory_ledger WHERE id=?').get(b.ledger_id);
    if (r) return r;
  }
  return db.prepare(`
    SELECT id, qty_in, source_type, source_id, status FROM inventory_ledger
    WHERE batch_id=? AND qty_in > 0 AND COALESCE(status,'posted') <> 'reversed'
    ORDER BY id LIMIT 1
  `).get(b.id) || null;
}

function purchaseQty(db, b, led) {
  if (String(b.source_type || '') !== 'purchase' || !tableExists(db, 'purchase_invoices')) return null;
  const docType = led ? String(led.source_type || '') : 'purchase';
  const docId = led && led.source_id ? Number(led.source_id) : Number(b.source_id);
  if (docType !== 'purchase' || !docId) return null;
  const inv = db.prepare('SELECT id, rows FROM purchase_invoices WHERE id=?').get(docId);
  if (!inv) return null;
  const lines = parseRows(inv.rows).filter((r) => Number(r && r.product_id) === Number(b.product_id));
  if (!lines.length) return null;
  const received = Number(b.qty_received) || 0;
  const rollNo = String(b.batch_no || '');
  const hit = lines.find((r) => Number(r.batch_id) === Number(b.id))
    || lines.find((r) => rollNo && String(r.roll_no || r.batch_no || '') === rollNo)
    || lines.find((r) => near(r.qty, received))
    || lines[0];
  return Number(hit.qty) || 0;
}

function journalInfo(db, b) {
  if (!tableExists(db, 'journal_entries')) return { ids: [], meter_text: 0 };
  const cols = columns(db, 'journal_entries');
  const ids = new Set();
  if (b.journal_id) ids.add(Number(b.journal_id));
  if (cols.includes('source_type') && cols.includes('source_id')) {
    for (const r of db.prepare("SELECT id FROM journal_entries WHERE source_type IN ('fabric_roll','fabric_roll_edit') AND source_id=?").all(b.id)) ids.add(r.id);
  }
  const list = [...ids].filter(Boolean);
  let meterText = 0;
  for (const id of list) {
    const je = db.prepare('SELECT description FROM journal_entries WHERE id=?').get(id);
    if (je && /متر/.test(String(je.description || ''))) meterText = 1;
  }
  return { ids: list, meter_text: meterText };
}

function layUsage(db, b) {
  if (!tableExists(db, 'cutting_lay_rolls') || !tableExists(db, 'cutting_lays')) return [];
  const hasUnit = columns(db, 'cutting_lays').includes('qty_unit');
  return db.prepare(`
    SELECT l.id, ${hasUnit ? 'l.qty_unit' : 'NULL'} AS qty_unit, COALESCE(l.status,'posted') AS status,
           l.created_at, r.meters
    FROM cutting_lay_rolls r JOIN cutting_lays l ON l.id = r.lay_id
    WHERE r.batch_id=? AND COALESCE(l.status,'posted') <> 'reversed'
  `).all(b.id);
}

function tokenRow(db, token) {
  const t = String(token == null ? '' : token).trim();
  if (!t) return uom.matchText(db, 'm');
  const row = uom.matchText(db, t);
  if (row) return row;
  return uom.isLengthText(t) ? uom.matchText(db, 'm') : null;
}

/** Analyse one batch; null when its unit already equals the product unit. */
function analyseBatch(db, b, prod) {
  const pu = uom.productRollUnit(db, prod);
  const token = String(b.unit == null ? '' : b.unit).trim();
  if (pu.row && uom.rollTokenMatchesProduct(db, prod, token)) return null;
  if (!pu.row && (!token || uom.normKey(token) === uom.normKey(pu.token))) return null;

  const bRow = tokenRow(db, token);
  const led = receiptLedger(db, b);
  const pq = purchaseQty(db, b, led);
  const je = journalInfo(db, b);
  const lays = layUsage(db, b);
  const received = Number(b.qty_received) || 0;
  const entryUnit = b.entry_unit_id ? uom.getUnit(db, b.entry_unit_id) : null;
  const issues = [];
  const notes = [];

  if (led && !near(led.qty_in, received, 1e-3)) issues.push(`ledger_qty_in ${led.qty_in} ≠ qty_received ${received}`);
  if (pq != null && !near(pq, received, 1e-3)) issues.push(`purchase_qty ${pq} ≠ qty_received ${received}`);
  if (entryUnit && pu.row && Number(entryUnit.id) !== Number(pu.row.id)) {
    const sameDim = (entryUnit.dimension || 'count') === (pu.row.dimension || 'count')
      && Number(entryUnit.factor_to_ref) > 0 && Number(pu.row.factor_to_ref) > 0;
    const eq = b.entry_qty == null ? null : Number(b.entry_qty);
    if (sameDim && eq != null) {
      const k = uom.convertBetween(entryUnit, pu.row, 1);
      if (near(received, eq * k, 1e-3)) notes.push('entry already converted to product unit');
      else if (near(received, eq, 1e-3) && !near(k, 1)) issues.push(`entry ${eq} ${entryUnit.name} stored unconverted (factor ${k})`);
    }
  }
  for (const l of lays) {
    const lu = String(l.qty_unit || '').trim();
    if (lu && pu.row && !uom.rollTokenMatchesProduct(db, prod, lu)) {
      issues.push(`live lay #${l.id} consumed ${l.meters} in «${lu}»`);
    }
  }
  const legacyLays = lays.filter((l) => !String(l.qty_unit || '').trim()).map((l) => l.id);
  if (legacyLays.length) {
    notes.push(`legacy lays ${[...new Set(legacyLays)].join('/')} have no stored unit; their consumption is taken as product unit (confirm with cutting sheets)`);
  }
  if (je.meter_text && pu.row && pu.row.dimension === 'length' && uom.rollUnitToken(pu.row) !== 'm') {
    notes.push(`JE ${je.ids.join('/')} description says «متر» (text only; amount unchanged)`);
  }

  let classification;
  if (!pu.row || !bRow) classification = 'unknown_unit';
  else if (issues.length) classification = 'conversion_needed';
  else if ((bRow.dimension || 'count') !== (pu.row.dimension || 'count')) {
    classification = pq != null && near(pq, received, 1e-3) ? 'relabel' : 'review_cross_dimension';
  } else classification = 'relabel';

  return {
    product_id: prod.id,
    product_name: prod.name || '',
    product_unit: prod.unit || '',
    product_unit_token: pu.token,
    product_dimension: pu.row ? pu.row.dimension : '',
    batch_id: b.id,
    batch_no: b.batch_no || '',
    kind: b.kind || '',
    status: b.status || '',
    batch_unit: token,
    batch_unit_dimension: bRow ? (bRow.dimension || '') : '',
    qty_received: received,
    qty_live: Math.round(liveQty(db, b) * 1e6) / 1e6,
    unit_cost_rial: Number(b.unit_cost_rial) || 0,
    amount_rial: Math.round((Number(b.unit_cost_rial) || 0) * received),
    entry_unit: entryUnit ? entryUnit.code : '',
    entry_qty: b.entry_qty == null ? '' : b.entry_qty,
    entry_factor: b.entry_factor == null ? '' : b.entry_factor,
    source_type: b.source_type || '',
    source_id: b.source_id || '',
    ledger_qty_in: led ? Number(led.qty_in) : '',
    purchase_qty: pq == null ? '' : pq,
    journal_ids: je.ids.join('/'),
    je_mentions_meter: je.meter_text,
    live_lays: lays.map((l) => `${l.id}:${l.qty_unit || ''}`).join('/'),
    classification,
    proposed_new_unit: classification === 'relabel' ? pu.token : '',
    proposed_entry_unit_id: classification === 'relabel' && !b.entry_unit_id && pu.row ? pu.row.id : '',
    proposed_entry_factor: classification === 'relabel' && !b.entry_unit_id ? 1 : '',
    qty_change: 0,
    amount_change: 0,
    issues: issues.join(' | '),
    notes: notes.join(' | '),
  };
}

function scan(db, { productIds } = {}) {
  const where = ["COALESCE(b.kind,'generic') IN ('fabric','attr')", "COALESCE(b.status,'') <> 'reversed'"];
  const params = [];
  if (productIds && productIds.length) {
    where.push(`b.product_id IN (${productIds.map(() => '?').join(',')})`);
    params.push(...productIds);
  }
  const batches = db.prepare(`SELECT b.* FROM inventory_batches b WHERE ${where.join(' AND ')} ORDER BY b.product_id, b.id`).all(...params);
  const prodCache = new Map();
  const out = [];
  for (const b of batches) {
    if (!prodCache.has(b.product_id)) prodCache.set(b.product_id, db.prepare('SELECT * FROM products WHERE id=?').get(b.product_id) || null);
    const prod = prodCache.get(b.product_id);
    if (!prod) continue;
    const r = analyseBatch(db, b, prod);
    if (r) out.push(r);
  }
  return out;
}

const CSV_COLS = [
  'product_id', 'product_name', 'product_unit', 'product_unit_token', 'product_dimension',
  'batch_id', 'batch_no', 'kind', 'status', 'batch_unit', 'batch_unit_dimension',
  'qty_received', 'qty_live', 'unit_cost_rial', 'amount_rial',
  'entry_unit', 'entry_qty', 'entry_factor', 'source_type', 'source_id',
  'ledger_qty_in', 'purchase_qty', 'journal_ids', 'je_mentions_meter', 'live_lays',
  'classification', 'proposed_new_unit', 'proposed_entry_unit_id', 'proposed_entry_factor',
  'qty_change', 'amount_change', 'issues', 'notes',
];

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function toCsv(rows) {
  return '\uFEFF' + [CSV_COLS.join(','), ...rows.map((r) => CSV_COLS.map((c) => csvCell(r[c])).join(','))].join('\n') + '\n';
}

function summarize(rows) {
  const byProduct = new Map();
  for (const r of rows) {
    let p = byProduct.get(r.product_id);
    if (!p) {
      p = { product_id: r.product_id, product_name: r.product_name, product_unit: r.product_unit, batches: 0, classes: {}, from_units: new Set(), proposed: '' };
      byProduct.set(r.product_id, p);
    }
    p.batches += 1;
    p.classes[r.classification] = (p.classes[r.classification] || 0) + 1;
    p.from_units.add(r.batch_unit || '(خالی)');
    if (r.proposed_new_unit) p.proposed = r.proposed_new_unit;
  }
  return [...byProduct.values()].map((p) => ({ ...p, from_units: [...p.from_units].join('/') }));
}

function applyRelabel(db, { productIds, reason, userId }) {
  if (!productIds || !productIds.length) throw new Error('apply needs --product=ID[,ID]');
  const why = String(reason || '').trim();
  if (!why) throw new Error('apply needs --reason="..."');
  if (!tableExists(db, 'fabric_roll_unit_relabels')) throw new Error('fabric_roll_unit_relabels table missing');
  const batchCols = columns(db, 'inventory_batches');
  const hasEntry = ['entry_unit_id', 'entry_qty', 'entry_factor'].every((c) => batchCols.includes(c));
  const hasAudit = tableExists(db, 'audit_log');
  return db.transaction(() => {
    const rows = scan(db, { productIds });
    const todo = rows.filter((r) => r.classification === 'relabel');
    const skipped = rows.filter((r) => r.classification !== 'relabel');
    const groupKey = 'p9-rru-' + Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex');
    const ins = db.prepare(`
      INSERT INTO fabric_roll_unit_relabels
        (batch_id, product_id, old_unit, new_unit, old_entry_unit_id, old_entry_qty, old_entry_factor,
         entry_reset, reason, user_id, group_key)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `);
    const ids = [];
    for (const r of todo) {
      const b = db.prepare('SELECT * FROM inventory_batches WHERE id=?').get(r.batch_id);
      const entryReset = hasEntry && !b.entry_unit_id ? 1 : 0;
      const id = Number(ins.run(
        b.id, b.product_id, b.unit || '', r.proposed_new_unit,
        hasEntry ? (b.entry_unit_id || null) : null,
        hasEntry && b.entry_qty != null ? Number(b.entry_qty) : null,
        hasEntry && b.entry_factor != null ? Number(b.entry_factor) : null,
        entryReset, `P9: ${why}`, userId || null, groupKey
      ).lastInsertRowid);
      ids.push(id);
      db.prepare('UPDATE inventory_batches SET unit=? WHERE id=?').run(r.proposed_new_unit, b.id);
      if (entryReset) {
        db.prepare('UPDATE inventory_batches SET entry_unit_id=?, entry_qty=?, entry_factor=1 WHERE id=?')
          .run(r.proposed_entry_unit_id || null, Number(b.qty_received) || 0, b.id);
      }
      if (hasAudit) {
        db.prepare('INSERT INTO audit_log (user_id, action, entity, entity_id, detail) VALUES (?,?,?,?,?)').run(
          userId || null, 'p9_roll_unit_relabel', 'inventory_batches', b.id,
          JSON.stringify({ group_key: groupKey, relabel_id: id, old_unit: b.unit || '', new_unit: r.proposed_new_unit, entry_reset: entryReset, reason: why })
        );
      }
    }
    return { group_key: groupKey, relabeled: ids.length, relabel_ids: ids, batch_ids: todo.map((r) => r.batch_id), skipped: skipped.map((r) => ({ batch_id: r.batch_id, classification: r.classification, issues: r.issues })) };
  })();
}

function reverseRelabel(db, { groupKey, reason, userId }) {
  const why = String(reason || '').trim();
  if (!why) throw new Error('reverse needs --reason="..."');
  const hasAudit = tableExists(db, 'audit_log');
  return db.transaction(() => {
    const rows = db.prepare('SELECT * FROM fabric_roll_unit_relabels WHERE group_key=? AND reversed_at IS NULL ORDER BY id').all(String(groupKey));
    if (!rows.length) throw new Error(`group ${groupKey}: nothing to reverse (missing or already reversed)`);
    for (const r of rows) {
      const b = db.prepare('SELECT id, unit FROM inventory_batches WHERE id=?').get(r.batch_id);
      if (!b) throw new Error(`batch #${r.batch_id} missing`);
      if (String(b.unit || '') !== String(r.new_unit || '')) throw new Error(`batch #${r.batch_id} unit changed after relabel (${b.unit})`);
      const laysAfter = tableExists(db, 'cutting_lay_rolls') ? db.prepare(`
        SELECT l.id FROM cutting_lay_rolls x JOIN cutting_lays l ON l.id = x.lay_id
        WHERE x.batch_id=? AND COALESCE(l.status,'posted') <> 'reversed' AND COALESCE(l.created_at,0) >= ?
      `).all(r.batch_id, Number(r.created_at) || 0) : [];
      if (laysAfter.length) throw new Error(`batch #${r.batch_id} used by lay #${laysAfter[0].id} after relabel; void the lay first`);
    }
    for (const r of rows) {
      db.prepare('UPDATE inventory_batches SET unit=? WHERE id=?').run(r.old_unit, r.batch_id);
      if (Number(r.entry_reset) === 1) {
        db.prepare('UPDATE inventory_batches SET entry_unit_id=?, entry_qty=?, entry_factor=? WHERE id=?')
          .run(r.old_entry_unit_id, r.old_entry_qty, r.old_entry_factor, r.batch_id);
      }
      db.prepare("UPDATE fabric_roll_unit_relabels SET reversed_at=strftime('%s','now'), reversed_by=?, reverse_reason=? WHERE id=?")
        .run(userId || null, `P9: ${why}`, r.id);
      if (hasAudit) {
        db.prepare('INSERT INTO audit_log (user_id, action, entity, entity_id, detail) VALUES (?,?,?,?,?)').run(
          userId || null, 'p9_roll_unit_relabel_reverse', 'inventory_batches', r.batch_id,
          JSON.stringify({ group_key: groupKey, relabel_id: r.id, restored_unit: r.old_unit, reason: why })
        );
      }
    }
    return { group_key: groupKey, reversed: rows.length, batch_ids: rows.map((r) => r.batch_id) };
  })();
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const Database = require(args.sqlite || 'better-sqlite3');
  const dbPath = args.db || process.env.DB_PATH || path.join(__dirname, '..', 'crm.db');
  const productIds = args.product ? String(args.product).split(',').map(Number).filter((n) => n > 0) : null;
  const userId = args['user-id'] ? Number(args['user-id']) : null;
  const writing = !!(args.apply || args.reverse);
  if (writing && args['i-have-approval'] !== true) {
    console.error('Refusing to write: --apply/--reverse need --i-have-approval (owner approval).');
    process.exit(2);
  }
  const db = new Database(dbPath, writing ? {} : { readonly: true, fileMustExist: true });
  try {
    if (args.reverse) {
      console.log(JSON.stringify(reverseRelabel(db, { groupKey: args.reverse, reason: args.reason, userId }), null, 2));
      return;
    }
    if (args.apply) {
      console.log(JSON.stringify(applyRelabel(db, { productIds, reason: args.reason, userId }), null, 2));
      return;
    }
    const rows = scan(db, { productIds });
    const csvPath = args.csv || path.join(__dirname, '..', '..', 'reports', 'prodcycle-p9', 'roll-unit-relabel-dryrun-20261102.csv');
    fs.mkdirSync(path.dirname(csvPath), { recursive: true });
    fs.writeFileSync(csvPath, toCsv(rows), 'utf8');
    console.log(JSON.stringify({ mode: 'dry-run', db: dbPath, csv: csvPath, mismatched_batches: rows.length, products: summarize(rows) }, null, 2));
  } finally {
    db.close();
  }
}

if (require.main === module) {
  try { main(); } catch (e) { console.error('ERROR:', e.message); process.exit(1); }
}

module.exports = { scan, analyseBatch, applyRelabel, reverseRelabel, toCsv, summarize, CSV_COLS };
