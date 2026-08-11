#!/usr/bin/env node
/**
 * Rebuild product-related documents after a keep-products wipe:
 *   1) تفصیلی کالا (coa_code) تحت موجودی
 *   2) هم‌ترازی products.stock ↔ warehouse_stock
 *   3) کاردکس (stock_logs) — موجودی اول دوره
 *   4) دفتر موجودی سازمانی (inventory_ledger) + رسید انبار (warehouse_moves)
 *   5) سند حسابداری opening_inventory (اگر بهای واحد موجود باشد)
 *
 * Idempotent — safe to re-run.
 *
 *   node server/scripts/rebuild-product-docs.js --confirm=REBUILD-PRODUCT-DOCS
 *   DB_PATH=... node server/scripts/rebuild-product-docs.js --confirm=REBUILD-PRODUCT-DOCS
 */
const fs = require('fs');
const path = require('path');

const CONFIRM = 'REBUILD-PRODUCT-DOCS';
const arg = process.argv.find((a) => a.startsWith('--confirm='));
const confirm = arg ? arg.slice('--confirm='.length) : '';
if (confirm !== CONFIRM) {
  console.error(`Refuse: pass --confirm=${CONFIRM}`);
  process.exit(1);
}

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'crm.db');
if (!fs.existsSync(dbPath)) {
  console.error('DB not found:', dbPath);
  process.exit(1);
}

process.env.DB_PATH = dbPath;
const { initDB, getDB } = require('../db');
const { allocTafsili } = require('../lib/coa-map');
const { postProductOpeningInventory } = require('../lib/opening-post');
const { postInventoryMovement } = require('../lib/inventory/ledger');
const { todayJalali } = require('../jalali');

initDB();
const db = getDB();

const OPENING_NOTE = 'موجودی اول دوره';
const adminId = db.prepare("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1").get()?.id
  || db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get()?.id
  || 1;

function tableCols(name) {
  try { return db.prepare(`PRAGMA table_info(${name})`).all().map((c) => c.name); } catch (_) { return []; }
}

const stockLogCols = tableCols('stock_logs');
const hasReason = stockLogCols.includes('reason');
const hasNote = stockLogCols.includes('note');

function unitCostRial(p) {
  const avg = Math.round(Number(p.average_cost_rial) || 0);
  if (avg > 0) return avg;
  const cost = Math.round(Number(p.cost) || 0);
  if (cost > 0) return cost;
  return Math.round(Number(p.opening_price) || 0);
}

function defaultWarehouseId(p) {
  if (p.warehouse_id) {
    const w = db.prepare('SELECT id FROM warehouses WHERE id=?').get(p.warehouse_id);
    if (w) return w.id;
  }
  const def = db.prepare('SELECT id FROM warehouses WHERE COALESCE(is_default,0)=1 ORDER BY id LIMIT 1').get()
    || db.prepare('SELECT id FROM warehouses ORDER BY id LIMIT 1').get();
  return def?.id || null;
}

const summary = {
  products: 0,
  tafsil_created: 0,
  stock_synced: 0,
  wh_rows_created: 0,
  stock_logs: 0,
  inventory_ledger: 0,
  warehouse_moves: 0,
  opening_je: 0,
  avg_cost_set: 0,
  skipped_no_qty: 0,
  errors: [],
};

const products = db.prepare('SELECT * FROM products ORDER BY id').all();
summary.products = products.length;

const tx = db.transaction(() => {
  for (const p of products) {
    try {
      // 1) Tafsil
      if (!p.coa_code) {
        const cc = allocTafsili(db, 'product', p.name || ('کالا ' + p.id));
        if (cc) {
          db.prepare('UPDATE products SET coa_code=? WHERE id=?').run(cc, p.id);
          p.coa_code = cc;
          summary.tafsil_created++;
        }
      }

      // 2) Align stock ↔ warehouse_stock
      const whRows = db.prepare(
        'SELECT warehouse_id, qty FROM warehouse_stock WHERE product_id=?'
      ).all(p.id);
      let whSum = whRows.reduce((s, r) => s + (Number(r.qty) || 0), 0);
      const prodStock = Number(p.stock) || 0;

      if (!whRows.length && prodStock > 0) {
        const wid = defaultWarehouseId(p);
        if (wid) {
          db.prepare(
            'INSERT OR REPLACE INTO warehouse_stock (product_id,warehouse_id,qty) VALUES (?,?,?)'
          ).run(p.id, wid, prodStock);
          whSum = prodStock;
          summary.wh_rows_created++;
          if (!p.warehouse_id) {
            db.prepare('UPDATE products SET warehouse_id=? WHERE id=?').run(wid, p.id);
            p.warehouse_id = wid;
          }
        }
      } else if (whSum !== prodStock) {
        // Prefer warehouse_stock after keep-products wipe
        db.prepare('UPDATE products SET stock=? WHERE id=?').run(whSum, p.id);
        p.stock = whSum;
        summary.stock_synced++;
      }

      const qty = Number(p.stock) || whSum || 0;
      if (qty <= 0) {
        summary.skipped_no_qty++;
        continue;
      }

      const unit = unitCostRial(p);
      if (unit > 0 && !(Number(p.average_cost_rial) > 0)) {
        db.prepare('UPDATE products SET average_cost_rial=? WHERE id=?').run(unit, p.id);
        p.average_cost_rial = unit;
        summary.avg_cost_set++;
      }

      const hasLog = db.prepare(
        'SELECT COUNT(*) c FROM stock_logs WHERE product_id=?'
      ).get(p.id).c > 0;
      const hasLed = db.prepare(
        'SELECT COUNT(*) c FROM inventory_ledger WHERE product_id=? AND COALESCE(status,\'posted\')=\'posted\''
      ).get(p.id).c > 0;
      const hasMove = db.prepare(
        "SELECT COUNT(*) c FROM warehouse_moves WHERE product_id=? AND type='receipt' AND (note LIKE '%اول دوره%' OR note LIKE '%افتتاحیه%')"
      ).get(p.id).c > 0;
      const hasJe = db.prepare(
        "SELECT COUNT(*) c FROM journal_entries WHERE ref_type='opening_inventory' AND ref_id=? AND COALESCE(deleted_at,0)=0"
      ).get(p.id).c > 0;

      // Refresh WH lines after possible insert
      const lines = db.prepare(
        'SELECT warehouse_id, qty FROM warehouse_stock WHERE product_id=? AND COALESCE(qty,0)>0'
      ).all(p.id);
      const date = todayJalali();

      // 3–4) inventory_ledger (+ stock_logs via helper) + warehouse_moves
      if (!hasLed) {
        for (const line of lines) {
          const q = Number(line.qty) || 0;
          if (q <= 0) continue;
          const led = postInventoryMovement(db, {
            eventType: 'opening',
            productId: p.id,
            warehouseId: line.warehouse_id,
            qty: q,
            unitCostRial: unit,
            sourceType: 'opening_inventory',
            sourceId: p.id,
            date,
            note: OPENING_NOTE,
            createdBy: adminId,
            updateAvg: unit > 0,
            skipStock: true, // stock already present
          });
          summary.inventory_ledger++;
          // postInventoryMovement also writes stock_logs
          if (!hasLog) summary.stock_logs++;

          if (!hasMove) {
            const mv = db.prepare(`
              INSERT INTO warehouse_moves
                (type,product_id,to_warehouse_id,qty,date,note,created_by,ledger_id,unit_cost_rial,amount_rial,status,je_id)
              VALUES ('receipt',?,?,?,?,?,?,?,?,?,'posted',NULL)
            `).run(
              p.id, line.warehouse_id, q, date, OPENING_NOTE, adminId,
              led.id, led.unit_cost_rial || unit, led.amount_rial || (unit * q)
            );
            db.prepare('UPDATE inventory_ledger SET source_id=? WHERE id=?')
              .run(mv.lastInsertRowid, led.id);
            summary.warehouse_moves++;
          }
        }
      } else if (!hasLog) {
        // Ledger exists but legacy kardex empty — add opening log only
        if (hasReason && hasNote) {
          db.prepare(
            'INSERT INTO stock_logs (product_id,change,reason,note,user_id) VALUES (?,?,?,?,?)'
          ).run(p.id, qty, OPENING_NOTE, OPENING_NOTE, adminId);
        } else if (hasReason) {
          db.prepare(
            'INSERT INTO stock_logs (product_id,change,reason,user_id) VALUES (?,?,?,?)'
          ).run(p.id, qty, OPENING_NOTE, adminId);
        } else {
          db.prepare(
            'INSERT INTO stock_logs (product_id,change,note,user_id) VALUES (?,?,?,?)'
          ).run(p.id, qty, OPENING_NOTE, adminId);
        }
        summary.stock_logs++;
      }

      if (!hasMove && hasLed) {
        // Ledger already there from partial run — still expose warehouse receipt docs
        for (const line of lines) {
          const q = Number(line.qty) || 0;
          if (q <= 0) continue;
          const ledId = db.prepare(
            "SELECT id FROM inventory_ledger WHERE product_id=? AND warehouse_id=? AND event_type='opening' ORDER BY id LIMIT 1"
          ).get(p.id, line.warehouse_id)?.id || null;
          db.prepare(`
            INSERT INTO warehouse_moves
              (type,product_id,to_warehouse_id,qty,date,note,created_by,ledger_id,unit_cost_rial,amount_rial,status)
            VALUES ('receipt',?,?,?,?,?,?,?,?,?,'posted')
          `).run(
            p.id, line.warehouse_id, q, date, OPENING_NOTE, adminId,
            ledId, unit, unit * q
          );
          summary.warehouse_moves++;
        }
      }

      // 5) Accounting JE (one per product, requires unit cost)
      if (!hasJe && unit > 0 && qty > 0) {
        const jeId = postProductOpeningInventory(db, {
          productId: p.id,
          qty,
          unitCostRial: unit,
          date,
          userId: adminId,
          description: `${OPENING_NOTE} — ${p.name || p.code || p.id} × ${qty}`,
          srcSystem: 'rebuild-product-docs',
        });
        if (jeId) {
          summary.opening_je++;
          try {
            db.prepare(
              "UPDATE warehouse_moves SET je_id=? WHERE product_id=? AND type='receipt' AND note=? AND je_id IS NULL"
            ).run(jeId, p.id, OPENING_NOTE);
          } catch (_) { /* je_id column may be missing on ancient DBs */ }
        }
      }
    } catch (e) {
      summary.errors.push({ id: p.id, code: p.code, error: e.message });
      if (db.inTransaction) throw e;
    }
  }
});

try {
  tx();
} catch (e) {
  console.error('FAILED:', e.message);
  if (summary.errors.length) console.error(JSON.stringify(summary.errors.slice(0, 20), null, 2));
  process.exit(1);
}

const verify = {
  products: db.prepare('SELECT COUNT(*) c FROM products').get().c,
  with_coa: db.prepare("SELECT COUNT(*) c FROM products WHERE coa_code IS NOT NULL AND coa_code<>''").get().c,
  stock_logs: db.prepare('SELECT COUNT(*) c FROM stock_logs').get().c,
  inventory_ledger: db.prepare('SELECT COUNT(*) c FROM inventory_ledger').get().c,
  warehouse_moves: db.prepare('SELECT COUNT(*) c FROM warehouse_moves').get().c,
  opening_je: db.prepare(
    "SELECT COUNT(*) c FROM journal_entries WHERE ref_type='opening_inventory' AND COALESCE(deleted_at,0)=0"
  ).get().c,
  wh_mismatch: db.prepare(`
    SELECT COUNT(*) c FROM products p
    WHERE COALESCE(p.stock,0) <> COALESCE((SELECT SUM(qty) FROM warehouse_stock ws WHERE ws.product_id=p.id),0)
  `).get().c,
};

console.log(JSON.stringify({ summary, verify, errors: summary.errors.slice(0, 30) }, null, 2));
if (summary.errors.length) {
  console.error(`⚠️ completed with ${summary.errors.length} per-product errors`);
  process.exit(2);
}
console.log('✅ rebuild-product-docs complete');
