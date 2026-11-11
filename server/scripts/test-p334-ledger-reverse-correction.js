'use strict';
/**
 * FR-P334-A — correction reversal of opening/alignment kardex rows + stock-vs-kardex mismatch report.
 * Run: node server/scripts/test-p334-ledger-reverse-correction.js
 *
 * Temp DB replicating product 334: production receipt 96 in wh34, sales 48 (incl. a re-sold 7),
 * a kardex-only stock_reconcile out 7 (like ledger#1273), a kardex-only opening_inventory in 8 in wh35
 * (like ledger#2003), warehouse_stock 49 / 8. Then via HTTP:
 *  - 400s (reason / confirm / stock_effect) with zero writes; 403 for cashier (POST + preview)
 *  - preview is read-only
 *  - reverse 2003 with_stock ⇒ kardex35 0, ws35 0; reverse 1273 kardex_only ⇒ kardex34 48, ws34 49
 *  - second reverse / reversal row ⇒ 409; document-born row ⇒ 409 E_REVERSE_VIA_SOURCE (both routes)
 *  - real transfer route 34→35 of 8 ⇒ kardex34 40, kardex35 8, ws34 41, ws35 8, no JE (same account)
 *  - row with je_id ⇒ voucher_draft (reversing lines), journal_entries unchanged
 *  - with_stock that would go negative ⇒ 409, zero writes
 *  - mismatch report: wh34 diff 1; Σ kardex value 34+35 change = −165,582,632 + 66,679,942
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK  ', label); }
  else { fail += 1; console.log('  FAIL', label, extra == null ? '' : JSON.stringify(extra)); }
}

console.log('\n══ FR-P334-A — ledger reverse-correction + stock/kardex mismatch ══\n');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p334-rc-'));
process.env.DB_PATH = path.join(dir, 'p334.db');
process.env.UPLOADS_DIR = path.join(dir, 'uploads');
process.env.SYNC_ROLE = 'central';
process.env.ERP_TEST_ISOLATION = '1';
process.env.SMS_DISABLED = '1';
process.env.JWT_SECRET = 'p334-ledger-reverse-correction-secret-32!!';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');
delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;

const dbMods = require('../db');
dbMods.initDB();
const db = dbMods.getDB();

const colsCache = new Map();
const cols = (t) => {
  if (!colsCache.has(t)) colsCache.set(t, new Set(db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name)));
  return colsCache.get(t);
};
function insert(table, obj) {
  const c = cols(table);
  const keys = Object.keys(obj).filter((k) => c.has(k));
  return Number(db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
    .run(...keys.map((k) => obj[k])).lastInsertRowid);
}
const q1 = (sql, ...p) => db.prepare(sql).get(...p);
const changes = () => q1('SELECT total_changes() AS n').n;

const ADMIN_ID = insert('users', { name: 'مدیر تست', username: 'p334_admin', password: 'x', role: 'admin', active: 1, must_change_password: 0 });
const CASHIER_ID = insert('users', { name: 'صندوقدار', username: 'p334_cashier', password: 'x', role: 'cashier', active: 1, must_change_password: 0 });

const authMw = require('../middleware/auth');
authMw.auth = (req, _res, next) => {
  const id = Number(req.headers['x-test-user']) || ADMIN_ID;
  const u = q1('SELECT id, role, name, username FROM users WHERE id=?', id);
  req.user = { id: u.id, role: u.role, name: u.name, username: u.username };
  next();
};

const express = require('express');
const app = express();
app.use(express.json());
app.use('/api/inventory', require('../routes/inventory'));
app.use('/api/warehouses', require('../routes/warehouses'));

const L = require('../lib/inventory/ledger');

const U = 9525706; // 66,679,942 / 7
const AMT_1273 = 66679942;
const AMT_2003 = 165582632;
const D = '1405/07/01';

function liveKardex(pid, wid) {
  const r = q1(`SELECT COALESCE(SUM(qty_in-qty_out),0) q,
    COALESCE(SUM(CASE WHEN qty_in>0 THEN amount_rial WHEN qty_out>0 THEN -amount_rial ELSE amount_rial END),0) v
    FROM inventory_ledger WHERE product_id=? AND warehouse_id=? AND status='posted' AND reversed_of IS NULL
      AND COALESCE(event_type,'')<>'reversal'`, pid, wid);
  return { q: Math.round(r.q * 1000) / 1000, v: Math.round(r.v) };
}
const ws = (pid, wid) => {
  const r = q1('SELECT qty FROM warehouse_stock WHERE product_id=? AND warehouse_id=?', pid, wid);
  return r ? Number(r.qty) : null;
};

async function main() {
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, userId) => {
    const res = await fetch(base + url, {
      method,
      headers: { 'content-type': 'application/json', 'x-test-user': String(userId || ADMIN_ID) },
      body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch (_) { json = null; }
    return { status: res.status, body: json };
  };

  try {
    db.prepare("INSERT OR IGNORE INTO settings (key,value) VALUES ('ledger_leaf_enforcement','warn')").run();
    db.prepare("INSERT OR IGNORE INTO chart_of_accounts (code,name,type,parent_code,level,is_active) VALUES ('1104','موجودی کالا','asset',NULL,2,1)").run();
    db.prepare("INSERT OR IGNORE INTO chart_of_accounts (code,name,type,parent_code,level,is_active) VALUES ('110499','موجودی تست P334','asset','1104',3,1)").run();
    db.prepare("INSERT OR IGNORE INTO chart_of_accounts (code,name,type,parent_code,level,is_active) VALUES ('3102','افتتاحیه','equity',NULL,3,1)").run();
    const WH34 = insert('warehouses', {
      id: 34, name: 'انبار نوبرت', code: 'P334-34', active: 1, allow_negative: 0,
      warehouse_type: 'finished_goods', inventory_system: 'perpetual', inventory_coa_code: '110499',
    });
    const WH35 = insert('warehouses', {
      id: 35, name: 'کیمیا', code: 'P334-35', active: 1, allow_negative: 0,
      warehouse_type: 'finished_goods', inventory_system: 'perpetual', inventory_coa_code: '110499',
    });
    const P = insert('products', {
      user_id: ADMIN_ID, name: 'کالای ۳۳۴', code: 'P334', price: 20000000, cost: 0,
      average_cost_rial: 0, stock: 0, warehouse_id: WH34, unit: 'عدد',
    });

    console.log('— fixture: product 334 scenario —');
    L.postInventoryMovement(db, {
      eventType: 'production_receipt', productId: P, warehouseId: WH34, qty: 96, unitCostRial: U,
      sourceType: 'production_order', sourceId: 14, date: D, createdBy: ADMIN_ID,
    });
    const sale1 = L.postInventoryMovement(db, {
      eventType: 'sale', productId: P, warehouseId: WH34, qty: -41, sourceType: 'invoice', sourceId: 1, date: D, createdBy: ADMIN_ID,
    });
    const r1273 = L.postInventoryMovement(db, {
      eventType: 'adjustment', productId: P, warehouseId: WH34, qtyOut: 7, amountRial: AMT_1273,
      sourceType: 'stock_reconcile', date: D, note: 'هم‌ترازی کاردکس', skipStock: true, createdBy: ADMIN_ID,
    });
    L.postInventoryMovement(db, {
      eventType: 'sale', productId: P, warehouseId: WH34, qty: -7, sourceType: 'invoice', sourceId: 9, date: D, createdBy: ADMIN_ID,
    });
    const r2003 = L.postInventoryMovement(db, {
      eventType: 'opening', productId: P, warehouseId: WH35, qtyIn: 8, amountRial: AMT_2003,
      sourceType: 'opening_inventory', date: D, note: 'موجودی اول دوره', skipStock: true, createdBy: ADMIN_ID,
    });
    db.prepare('UPDATE warehouse_stock SET qty=49 WHERE product_id=? AND warehouse_id=?').run(P, WH34);
    db.prepare('INSERT OR IGNORE INTO warehouse_stock (product_id, warehouse_id, qty) VALUES (?,?,0)').run(P, WH35);
    db.prepare('UPDATE warehouse_stock SET qty=8 WHERE product_id=? AND warehouse_id=?').run(P, WH35);
    db.prepare('UPDATE products SET stock=57 WHERE id=?').run(P);
    const ID1273 = Number(r1273.id);
    const ID2003 = Number(r2003.id);
    ok(liveKardex(P, WH34).q === 41 && liveKardex(P, WH35).q === 8 && ws(P, WH34) === 49 && ws(P, WH35) === 8,
      'fixture: kardex 41/8, warehouse_stock 49/8', { k34: liveKardex(P, WH34), k35: liveKardex(P, WH35) });
    ok(liveKardex(P, WH35).v === AMT_2003, 'fixture: kardex35 value = 165,582,632');
    const value0 = liveKardex(P, WH34).v + liveKardex(P, WH35).v;

    console.log('— existing /reverse still refuses alignment rows —');
    const legacy = await call('POST', `/api/inventory/ledger/${ID2003}/reverse`, {});
    ok(legacy.status === 409 && legacy.body.code === 'E_REVERSE_VIA_SOURCE', 'POST /ledger/2003/reverse ⇒ 409 E_REVERSE_VIA_SOURCE (unchanged)', legacy);

    console.log('— validation 400 with zero writes —');
    const url2003 = `/api/inventory/ledger/${ID2003}/reverse-correction`;
    const audits = () => q1("SELECT COUNT(*) c FROM audit_log WHERE action='ledger_reverse_correction'").c;
    const cases = [
      [{}, 'E_LEDGER_REVERSE_REASON_REQUIRED', 'empty body'],
      [{ confirm: true, stock_effect: 'with_stock' }, 'E_LEDGER_REVERSE_REASON_REQUIRED', 'no reason'],
      [{ reason: '    ', confirm: true, stock_effect: 'with_stock' }, 'E_LEDGER_REVERSE_REASON_REQUIRED', 'whitespace reason'],
      [{ reason: 'abcd', confirm: true, stock_effect: 'with_stock' }, 'E_LEDGER_REVERSE_REASON_REQUIRED', 'reason < 5'],
      [{ reason: 'دوباره‌شماری', stock_effect: 'with_stock' }, 'E_LEDGER_REVERSE_CONFIRM_REQUIRED', 'no confirm'],
      [{ reason: 'دوباره‌شماری', confirm: false, stock_effect: 'with_stock' }, 'E_LEDGER_REVERSE_CONFIRM_REQUIRED', 'confirm=false'],
      [{ reason: 'دوباره‌شماری', confirm: 'yes', stock_effect: 'with_stock' }, 'E_LEDGER_REVERSE_CONFIRM_REQUIRED', 'confirm="yes"'],
      [{ reason: 'دوباره‌شماری', confirm: true }, 'E_LEDGER_REVERSE_STOCK_EFFECT_REQUIRED', 'no stock_effect'],
      [{ reason: 'دوباره‌شماری', confirm: true, stock_effect: 'both' }, 'E_LEDGER_REVERSE_STOCK_EFFECT_REQUIRED', 'bad stock_effect'],
    ];
    for (const [body, code, label] of cases) {
      const c0 = changes();
      const a0 = audits();
      const r = await call('POST', url2003, body);
      ok(r.status === 400 && r.body && r.body.code === code && /[\u0600-\u06FF]/.test(r.body.error || '')
        && changes() === c0 && audits() === a0, `400 ${code} — ${label} (zero writes)`, r);
    }

    console.log('— permission —');
    {
      const c0 = changes();
      const r = await call('POST', url2003, { reason: 'دوباره‌شماری', confirm: true, stock_effect: 'with_stock' }, CASHIER_ID);
      const p = await call('GET', `/api/inventory/ledger/${ID2003}/reverse-correction-preview`, null, CASHIER_ID);
      const m = await call('GET', `/api/inventory/stock-kardex-mismatch?product_id=${P}`, null, CASHIER_ID);
      ok(r.status === 403 && r.body.code === 'E_PERMISSION' && changes() === c0, 'cashier POST ⇒ 403, no writes', r);
      ok(p.status === 403 && m.status === 403, 'cashier preview + mismatch report ⇒ 403');
    }

    console.log('— preview (read-only) —');
    {
      const c0 = changes();
      const p = await call('GET', `/api/inventory/ledger/${ID2003}/reverse-correction-preview?stock_effect=with_stock`);
      const b = p.body || {};
      ok(p.status === 200 && changes() === c0, 'preview 200, total_changes unchanged');
      ok(b.eligible === true && b.kardex.before.qty === 8 && b.kardex.after.qty === 0
        && b.kardex.before.value_rial === AMT_2003 && b.kardex.after.value_rial === 0, 'preview kardex35 8→0, value 165,582,632→0', b.kardex);
      ok(b.warehouse_stock.before === 8 && b.warehouse_stock.after_with_stock === 0 && b.warehouse_stock.after_kardex_only === 8
        && b.warehouse_stock.after === 0 && b.ready === true && b.with_stock_allowed === true, 'preview warehouse_stock 8 → 0 (with_stock) / 8 (kardex_only)', b.warehouse_stock);
      const p2 = await call('GET', `/api/inventory/ledger/${sale1.id}/reverse-correction-preview`);
      ok(p2.status === 200 && p2.body.eligible === false && p2.body.blocker.code === 'E_REVERSE_VIA_SOURCE', 'preview of document-born row ⇒ eligible=false (E_REVERSE_VIA_SOURCE)', p2.body && p2.body.blocker);
      const p404 = await call('GET', '/api/inventory/ledger/999999/reverse-correction-preview');
      ok(p404.status === 404 && p404.body.code === 'E_LEDGER_NOT_FOUND', 'preview unknown id ⇒ 404');
    }

    console.log('— reverse 2003 with_stock —');
    const jeCount0 = q1('SELECT COUNT(*) c FROM journal_entries').c;
    const draftCount0 = q1('SELECT COUNT(*) c FROM voucher_drafts').c;
    const hdr0 = Number(q1('SELECT stock FROM products WHERE id=?', P).stock);
    const r2003res = await call('POST', url2003, { reason: '  دوباره‌شماری بدون سند مبدأ (P334)  ', confirm: true, stock_effect: 'with_stock' });
    ok(r2003res.status === 200 && r2003res.body.ok === true && r2003res.body.stock_effect === 'with_stock', 'reverse 2003 with_stock ⇒ 200', r2003res);
    ok(liveKardex(P, WH35).q === 0 && liveKardex(P, WH35).v === 0, 'kardex35 = 0 (qty and value)', liveKardex(P, WH35));
    ok(ws(P, WH35) === 0, 'warehouse_stock35 = 0', ws(P, WH35));
    ok(Number(q1('SELECT stock FROM products WHERE id=?', P).stock) === liveKardex(P, WH34).q,
      'products.stock rebuilt from live ledger after reversal');
    const o2003 = q1('SELECT * FROM inventory_ledger WHERE id=?', ID2003);
    const rv2003 = q1('SELECT * FROM inventory_ledger WHERE reversed_of=?', ID2003);
    ok(o2003.status === 'reversed' && Number(o2003.qty_in) === 8 && Math.round(o2003.amount_rial) === AMT_2003,
      'original 2003 marked reversed, qty/amount untouched');
    ok(rv2003 && rv2003.event_type === 'reversal' && Number(rv2003.qty_out) === 8 && Math.round(rv2003.amount_rial) === AMT_2003
      && Number(rv2003.id) === r2003res.body.reversal_id, 'new reversal row qty_out 8 amount 165,582,632 (reversed_of=id)');
    ok(r2003res.body.reason === 'دوباره‌شماری بدون سند مبدأ (P334)', 'reason trimmed in response');
    const aud = q1("SELECT * FROM audit_log WHERE action='ledger_reverse_correction' AND entity_id=? ORDER BY id DESC LIMIT 1", ID2003);
    let audDetail = {};
    try { audDetail = JSON.parse(aud.detail); } catch (_) { audDetail = {}; }
    ok(aud && audDetail.reason === 'دوباره‌شماری بدون سند مبدأ (P334)' && audDetail.stock_effect === 'with_stock'
      && audDetail.qty === 8 && audDetail.amount_rial === AMT_2003, 'audit_log has reason, stock_effect, qty, amount', audDetail);
    ok(q1('SELECT COUNT(*) c FROM journal_entries').c === jeCount0 && q1('SELECT COUNT(*) c FROM voucher_drafts').c === draftCount0
      && r2003res.body.voucher_draft_id == null, 'no JE / no draft for a row without je_id');

    console.log('— idempotency —');
    {
      const c0 = changes();
      const again = await call('POST', url2003, { reason: 'تکرار ابطال', confirm: true, stock_effect: 'with_stock' });
      ok(again.status === 409 && again.body.code === 'E_ALREADY_REVERSED' && changes() === c0, 'second reverse 2003 ⇒ 409 E_ALREADY_REVERSED, no writes', again);
      const revRow = await call('POST', `/api/inventory/ledger/${rv2003.id}/reverse-correction`, { reason: 'ابطال برگشتی', confirm: true, stock_effect: 'kardex_only' });
      ok(revRow.status === 409 && revRow.body.code === 'E_REVERSE_OF_REVERSAL', 'reverse of the reversal row ⇒ 409 E_REVERSE_OF_REVERSAL', revRow);
    }

    console.log('— document-born / manual rows —');
    {
      const c0 = changes();
      const doc = await call('POST', `/api/inventory/ledger/${sale1.id}/reverse-correction`, { reason: 'تست سند فروش', confirm: true, stock_effect: 'kardex_only' });
      ok(doc.status === 409 && doc.body.code === 'E_REVERSE_VIA_SOURCE' && changes() === c0, 'sale row ⇒ 409 E_REVERSE_VIA_SOURCE', doc);
      const docOld = await call('POST', `/api/inventory/ledger/${sale1.id}/reverse`, {});
      ok(docOld.status === 409 && docOld.body.code === 'E_REVERSE_VIA_SOURCE', 'sale row on /reverse ⇒ still 409 E_REVERSE_VIA_SOURCE');
      const prod = L.postInventoryMovement(db, {
        eventType: 'production_receipt', productId: P, warehouseId: WH34, qtyIn: 1, unitCostRial: U, sourceType: 'production_order', sourceId: 15, date: D,
      });
      const xfer = L.postInventoryMovement(db, {
        eventType: 'transfer_in', productId: P, warehouseId: WH34, qtyIn: 1, unitCostRial: U, sourceType: 'warehouse_transfer', sourceId: 77, date: D,
      });
      const c1 = changes();
      const rp = await call('POST', `/api/inventory/ledger/${prod.id}/reverse-correction`, { reason: 'تست تولید', confirm: true, stock_effect: 'kardex_only' });
      const rx = await call('POST', `/api/inventory/ledger/${xfer.id}/reverse-correction`, { reason: 'تست انتقال', confirm: true, stock_effect: 'kardex_only' });
      ok(rp.status === 409 && rp.body.code === 'E_REVERSE_VIA_SOURCE' && rx.status === 409 && rx.body.code === 'E_REVERSE_VIA_SOURCE' && changes() === c1,
        'production / warehouse_transfer rows ⇒ 409 E_REVERSE_VIA_SOURCE');
      // undo the two probe rows through their normal reversal so the scenario stays exact
      db.transaction(() => {
        L.reverseInventoryMovement(db, prod.id, { createdBy: ADMIN_ID, date: D });
        L.reverseInventoryMovement(db, xfer.id, { createdBy: ADMIN_ID, date: D });
      })();
      const man = L.postInventoryMovement(db, {
        eventType: 'adjustment', productId: P, warehouseId: WH34, qtyIn: 1, unitCostRial: U, sourceType: 'stock_adjust', date: D,
      });
      const rm = await call('POST', `/api/inventory/ledger/${man.id}/reverse-correction`, { reason: 'تست دستی', confirm: true, stock_effect: 'kardex_only' });
      ok(rm.status === 409 && rm.body.code === 'E_REVERSE_USE_MANUAL_ROUTE', 'manual row ⇒ 409 E_REVERSE_USE_MANUAL_ROUTE', rm.body);
      db.transaction(() => { L.reverseInventoryMovement(db, man.id, { createdBy: ADMIN_ID, date: D }); })();
      ok(liveKardex(P, WH34).q === 41 && ws(P, WH34) === 41, 'probe rows undone: cache rebuilt to kardex34 41', { k: liveKardex(P, WH34), ws: ws(P, WH34) });
    }

    console.log('— kardex_only refused; reverse 1273 with_stock —');
    {
      const vws0 = q1('SELECT COUNT(*) c FROM inventory_movements').c;
      const refused = await call('POST', `/api/inventory/ledger/${ID1273}/reverse-correction`, { reason: 'خروج تکراری؛ فروش T-0009 همان ۷ عدد را کم کرده', confirm: true, stock_effect: 'kardex_only' });
      ok(refused.status === 409 && refused.body.code === 'E_LEDGER_SSOT_REQUIRES_STOCK_EFFECT',
        'kardex_only ⇒ 409 because cache must follow ledger', refused.body);
      const r = await call('POST', `/api/inventory/ledger/${ID1273}/reverse-correction`, { reason: 'خروج تکراری؛ فروش T-0009 همان ۷ عدد را کم کرده', confirm: true, stock_effect: 'with_stock' });
      ok(r.status === 200 && r.body.stock_effect === 'with_stock' && r.body.qty_delta === 7 && r.body.value_delta_rial === AMT_1273, 'reverse 1273 with_stock ⇒ 200 (+7, +66,679,942)', r.body);
      ok(liveKardex(P, WH34).q === 48, 'kardex34 = 48', liveKardex(P, WH34));
      ok(ws(P, WH34) === 48 && Number(q1('SELECT stock FROM products WHERE id=?', P).stock) === 48
        && q1('SELECT COUNT(*) c FROM inventory_movements').c === vws0, 'cache follows ledger; variant movement log untouched');
      ok(r.body.warehouse_stock.before === 41 && r.body.warehouse_stock.after === 48, 'response warehouse_stock 41→48');
    }

    console.log('— official transfer 34 → 35 of 8 (real route) —');
    {
      const jeBefore = q1('SELECT COUNT(*) c FROM journal_entries').c;
      const k34 = liveKardex(P, WH34);
      const expectUnit = Math.round(k34.v / k34.q);
      const t = await call('POST', '/api/warehouses/moves/transfer', {
        from_warehouse_id: WH34, to_warehouse_id: WH35, product_id: P, qty: 8, date: D, note: 'انتقال رسمی ۸ عدد به کیمیا (P334)',
      });
      ok(t.status === 200 && t.body.ok === true, 'transfer 200', t);
      ok(liveKardex(P, WH34).q === 40 && liveKardex(P, WH35).q === 8, 'kardex34 40, kardex35 8', { k34: liveKardex(P, WH34), k35: liveKardex(P, WH35) });
      ok(ws(P, WH34) === 40 && ws(P, WH35) === 8, 'warehouse_stock34 40, warehouse_stock35 8', { ws34: ws(P, WH34), ws35: ws(P, WH35) });
      const outRow = q1("SELECT * FROM inventory_ledger WHERE product_id=? AND event_type='transfer_out' ORDER BY id DESC LIMIT 1", P);
      const inRow = q1("SELECT * FROM inventory_ledger WHERE product_id=? AND event_type='transfer_in' AND warehouse_id=? ORDER BY id DESC LIMIT 1", P, WH35);
      ok(outRow && inRow && Math.round(outRow.amount_rial) === Math.round(inRow.amount_rial) && Number(outRow.source_id) === Number(inRow.source_id),
        'paired transfer_out/transfer_in rows, same amount and same move id');
      ok(Math.round(outRow.unit_cost_rial) === expectUnit && expectUnit === U, `transfer unit = wh34 moving average (${U})`, { unit: outRow.unit_cost_rial, expectUnit });
      ok(q1('SELECT COUNT(*) c FROM journal_entries').c === jeBefore && t.body.je_id == null, 'same inventory account ⇒ no JE');
    }

    console.log('— totals + mismatch report —');
    {
      const value1 = liveKardex(P, WH34).v + liveKardex(P, WH35).v;
      ok(value1 - value0 === -AMT_2003 + AMT_1273, 'Σ kardex value 34+35 change = −165,582,632 + 66,679,942 = −98,902,690', { delta: value1 - value0 });
      const c0 = changes();
      const m = await call('GET', `/api/inventory/stock-kardex-mismatch?product_id=${P}`);
      const row34 = (m.body.rows || []).find((x) => x.warehouse_id === WH34);
      const row35 = (m.body.rows || []).find((x) => x.warehouse_id === WH35);
      ok(m.status === 200 && changes() === c0, 'mismatch report 200, read-only');
      ok(!row34, 'wh34 cache matches the live ledger');
      ok(!row35, 'wh35 not listed (8 = 8)');
      const m34 = await call('GET', `/api/inventory/stock-kardex-mismatch?product_id=${P}&warehouse_id=${WH35}`);
      ok(m34.status === 200 && m34.body.count === 0, 'warehouse filter wh35 ⇒ 0 rows');
      const { stockKardexMismatch } = require('../lib/inventory/stock-kardex-mismatch');
      ok(stockKardexMismatch(db, { productId: P }).count === 0, 'lib (CLI path) reports no cache drift');
    }

    console.log('— row with je_id ⇒ voucher draft, no JE —');
    {
      const P2 = insert('products', { user_id: ADMIN_ID, name: 'کالای سند‌دار', code: 'P334-JE', price: 1, average_cost_rial: 1000000, stock: 0, unit: 'عدد' });
      const led = L.postInventoryMovement(db, {
        eventType: 'adjustment', productId: P2, warehouseId: WH34, qtyIn: 3, amountRial: 3000000,
        sourceType: 'stock_reconcile', date: D, note: 'هم‌ترازی کاردکس', skipStock: true,
      });
      const jeId = insert('journal_entries', {
        entry_date: D, description: 'JE هم‌ترازی تست', ref_type: 'stock_reconcile', ref_id: led.id, created_by: ADMIN_ID, status: 'approved', deleted_at: 0,
      });
      insert('journal_lines', { entry_id: jeId, account_code: '110499', account_name: 'موجودی تست P334', debit: 300000, credit: 0, debit_rial: 3000000, credit_rial: 0, line_no: 1 });
      insert('journal_lines', { entry_id: jeId, account_code: '3102', account_name: 'افتتاحیه', debit: 0, credit: 300000, debit_rial: 0, credit_rial: 3000000, line_no: 2 });
      db.prepare('UPDATE inventory_ledger SET je_id=? WHERE id=?').run(jeId, led.id);
      const prev = await call('GET', `/api/inventory/ledger/${led.id}/reverse-correction-preview`);
      ok(prev.status === 200 && prev.body.voucher_draft && prev.body.voucher_draft.will_create === true, 'preview announces voucher draft');
      const je0 = q1('SELECT COUNT(*) c FROM journal_entries').c;
      const jl0 = q1('SELECT COUNT(*) c FROM journal_lines').c;
      const r = await call('POST', `/api/inventory/ledger/${led.id}/reverse-correction`, { reason: 'ردیف هم‌ترازی سند‌دار', confirm: true, stock_effect: 'with_stock' });
      ok(r.status === 200 && Number(r.body.voucher_draft_id) > 0 && r.body.je_posted === false && r.body.je_id === jeId, 'reverse ⇒ 200 with voucher_draft_id', r.body);
      ok(q1('SELECT COUNT(*) c FROM journal_entries').c === je0 && q1('SELECT COUNT(*) c FROM journal_lines').c === jl0
        && q1('SELECT status FROM journal_entries WHERE id=?', jeId).status === 'approved', 'no JE posted / original JE untouched');
      const dr = q1('SELECT * FROM voucher_drafts WHERE id=?', r.body.voucher_draft_id);
      const lines = JSON.parse(dr.lines_json);
      const inv = lines.find((l) => l.code === '110499');
      const eq = lines.find((l) => l.code === '3102');
      ok(dr.description.includes(`ledger#${led.id}`) && inv && inv.credit === 3000000 && inv.debit === 0 && eq && eq.debit === 3000000 && eq.credit === 0,
        'draft tagged with ledger id, lines reversed (Cr 110499 / Dr 3102 = 3,000,000)', { desc: dr.description, lines });
    }

    console.log('— with_stock that would go negative ⇒ 409, zero writes —');
    {
      const P3 = insert('products', { user_id: ADMIN_ID, name: 'کالای منفی', code: 'P334-NEG', price: 1, average_cost_rial: 0, stock: 2, unit: 'عدد' });
      const led = L.postInventoryMovement(db, {
        eventType: 'opening', productId: P3, warehouseId: WH35, qtyIn: 5, amountRial: 500000,
        sourceType: 'opening_inventory', date: D, skipStock: true,
      });
      L.postInventoryMovement(db, {
        eventType: 'sale', productId: P3, warehouseId: WH35, qtyOut: 3, amountRial: 300000,
        sourceType: 'invoice', sourceId: 3003, date: D,
      });
      const prev = await call('GET', `/api/inventory/ledger/${led.id}/reverse-correction-preview?stock_effect=with_stock`);
      ok(prev.status === 200 && prev.body.with_stock_allowed === false && prev.body.ready === false && prev.body.warehouse_stock.after_with_stock === -3,
        'preview: with_stock not allowed (2 → −3)', prev.body);
      const warns = prev.body.warnings || [];
      ok(warns.some((w) => /منفی می‌شود/.test(w) && /انبار -3/.test(w))
        && !warns.some((w) => /رنگ‌سایز (?!-)/.test(w)),
        'blocked IN-void warning names the warehouse shortage (no positive variant-as-shortage)', warns);
      const c0 = changes();
      const r = await call('POST', `/api/inventory/ledger/${led.id}/reverse-correction`, { reason: 'تست منفی‌شدن', confirm: true, stock_effect: 'with_stock' });
      ok(r.status === 409 && r.body.code === 'E_REVERSE_STOCK_NEGATIVE' && changes() === c0
        && q1('SELECT status FROM inventory_ledger WHERE id=?', led.id).status === 'posted', '409 E_REVERSE_STOCK_NEGATIVE, zero writes, row still posted', r);
      const k = await call('POST', `/api/inventory/ledger/${led.id}/reverse-correction`, { reason: 'تست منفی‌شدن', confirm: true, stock_effect: 'kardex_only' });
      ok(k.status === 409 && k.body.code === 'E_LEDGER_SSOT_REQUIRES_STOCK_EFFECT' && ws(P3, WH35) === 2,
        'kardex_only fallback refused; cache remains ledger-derived');
    }

    console.log('— matrix product (row without variant) ⇒ with_stock allowed, VWS unchanged —');
    {
      const P4 = insert('products', { user_id: ADMIN_ID, name: 'کالای رنگ‌سایز', code: 'P334-MX', price: 1, average_cost_rial: 0, stock: 2, unit: 'عدد' });
      const V1 = insert('product_variants', { product_id: P4, sku: 'P334-MX-1', color: 'قرمز', size: '1', active: 1, is_default: 0, stock: 1 });
      const V2 = insert('product_variants', { product_id: P4, sku: 'P334-MX-2', color: 'آبی', size: '1', active: 1, is_default: 0, stock: 1 });
      const ledId = insert('inventory_ledger', {
        tx_no: 'P334-MATRIX-LEGACY', event_type: 'opening', product_id: P4, warehouse_id: WH35,
        qty_in: 2, qty_out: 0, unit_cost_rial: 100000, amount_rial: 200000,
        qty_balance: 2, avg_cost_after_rial: 100000, source_type: 'opening_inventory',
        date: D, status: 'posted',
      });
      const led = q1('SELECT * FROM inventory_ledger WHERE id=?', ledId);
      require('../lib/inventory/stock-cache').rebuildStockCache(db, P4);
      L.postInventoryMovement(db, {
        eventType: 'adjustment', productId: P4, warehouseId: WH35, variantId: V1, qtyIn: 1,
        amountRial: 0, sourceType: 'test_variant_seed', sourceId: led.id, date: D, allowNegative: true,
      });
      L.postInventoryMovement(db, {
        eventType: 'adjustment', productId: P4, warehouseId: WH35, variantId: V2, qtyIn: 1,
        amountRial: 0, sourceType: 'test_variant_seed', sourceId: led.id, date: D, allowNegative: true,
      });
      insert('inventory_ledger', {
        tx_no: 'P334-MATRIX-BALANCE', event_type: 'adjustment', product_id: P4, warehouse_id: WH35,
        qty_in: 0, qty_out: 2, unit_cost_rial: 0, amount_rial: 0,
        qty_balance: 0, avg_cost_after_rial: 0, source_type: 'test_variant_seed_balance',
        source_id: led.id, date: D, status: 'posted',
      });
      require('../lib/inventory/stock-cache').rebuildStockCache(db, P4);
      const vq = (v) => Number((q1('SELECT qty FROM variant_warehouse_stock WHERE variant_id=? AND warehouse_id=?', v, WH35) || {}).qty || 0);
      const url = `/api/inventory/ledger/${led.id}/reverse-correction`;
      const prev = await call('GET', `/api/inventory/ledger/${led.id}/reverse-correction-preview`);
      ok(prev.status === 200 && prev.body.variant_breakdown_required === false
        && prev.body.variant_breakdown_supported === false && prev.body.with_stock_allowed === true
        && (prev.body.variant_layer_in_warehouse || []).length === 2
        && prev.body.warehouse_stock.after_with_stock === 0,
      'preview: unattributed matrix with_stock allowed; VWS listed; ws → 0', prev.body);
      const base = { reason: 'تست رنگ‌سایز', confirm: true, stock_effect: 'with_stock' };
      const rBd = await call('POST', url, { ...base, variant_breakdown: [{ variant_id: V1, qty: 1 }, { variant_id: V2, qty: 1 }] });
      ok(rBd.status === 409 && rBd.body.code === 'E_LEDGER_REVERSE_USE_VARIANT_RECLASS'
        && ws(P4, WH35) === 2 && vq(V1) === 1 && vq(V2) === 1,
        'breakdown on this path → use VR; zero writes', { body: rBd.body, v1: vq(V1), v2: vq(V2) });
      const r5 = await call('POST', url, { reason: 'تست رنگ‌سایز', confirm: true, stock_effect: 'kardex_only' });
      ok(r5.status === 409 && r5.body.code === 'E_LEDGER_SSOT_REQUIRES_STOCK_EFFECT',
        'kardex_only still refused', r5.body);
      const r0 = await call('POST', url, base);
      ok(r0.status === 200 && ws(P4, WH35) === 0 && vq(V1) === 1 && vq(V2) === 1,
        'with_stock void of unattributed opening → ws 0, VWS unchanged',
        { body: r0.body, ws: ws(P4, WH35), v1: vq(V1), v2: vq(V2) });
    }

    console.log('— sync capture —');
    {
      const { tableForPath } = require('../sync/capture');
      ok(tableForPath(`/api/inventory/ledger/${ID2003}/reverse-correction`) === 'inventory_ledger', 'capture: /ledger/:id/reverse-correction ⇒ inventory_ledger');
    }
  } catch (e) {
    fail += 1;
    console.log('  FAIL exception', e && e.stack);
  } finally {
    server.close();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  try { db.close(); } catch (_) { /* ignore */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  process.exit(fail ? 1 : 0);
}

main();
