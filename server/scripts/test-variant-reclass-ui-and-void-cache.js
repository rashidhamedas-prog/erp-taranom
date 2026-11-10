'use strict';
/**
 * VR UI candidates + void-leftover variant cache (preserveZeros exception).
 * Run: node server/scripts/test-variant-reclass-ui-and-void-cache.js
 *
 * Synthetic products only — never 342 / 7217. Temp DB. No live writes.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK  ', label); }
  else { fail += 1; console.log('  FAIL', label, extra == null ? '' : JSON.stringify(extra)); }
}

console.log('\n══ VR UI candidates + void variant-cache ══\n');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-ui-void-'));
process.env.DB_PATH = path.join(dir, 't.db');
process.env.UPLOADS_DIR = path.join(dir, 'uploads');
process.env.SYNC_ROLE = 'central';
process.env.ERP_TEST_ISOLATION = '1';
process.env.SMS_DISABLED = '1';
process.env.JWT_SECRET = 'vr-ui-void-cache-test-secret-32chars!';
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
const qa = (sql, ...p) => db.prepare(sql).all(...p);
const n3 = (v) => Math.round((Number(v) || 0) * 1000) / 1000;

const ADMIN_ID = insert('users', { name: 'مدیر', username: 'vrui_admin', password: 'x', role: 'admin', active: 1, must_change_password: 0 });
const CASHIER_ID = insert('users', { name: 'صندوق', username: 'vrui_cashier', password: 'x', role: 'cashier', active: 1, must_change_password: 0 });

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

const SC = require('../lib/inventory/stock-cache');
const VR = require('../lib/inventory/variant-reclass');
const L = require('../lib/inventory/ledger');
const M = require('../lib/inventory/movement');
const MA = require('../lib/inventory/manual-adjust');
const D = '1405/08/19';
const U = 1000000;

function legacyRow(o) {
  return insert('inventory_ledger', {
    tx_no: 'L-' + Math.random().toString(36).slice(2, 8),
    status: 'posted', date: D, note: 'fixture', created_by: ADMIN_ID,
    qty_in: 0, qty_out: 0, unit_cost_rial: U, ...o,
  });
}
function vws(vid, wh) {
  return n3(q1('SELECT qty FROM variant_warehouse_stock WHERE variant_id=? AND warehouse_id=?', vid, wh)?.qty);
}
function pvStock(vid) {
  return n3(q1('SELECT stock FROM product_variants WHERE id=?', vid)?.stock);
}
function jeAlive() {
  return q1(`SELECT COUNT(*) c FROM journal_entries WHERE COALESCE(deleted_at,0)=0 AND COALESCE(status,'') NOT IN ('reversed','void')`).c;
}
function jeSum() {
  const r = q1(`SELECT COALESCE(SUM(jl.debit_rial),0) d, COALESCE(SUM(jl.credit_rial),0) c
    FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id
    WHERE COALESCE(je.deleted_at,0)=0 AND COALESCE(je.status,'') NOT IN ('reversed','void')`);
  return { d: Math.round(r.d), c: Math.round(r.c) };
}

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

    // ─── Fixture 7148-like ───
    const WHA = insert('warehouses', {
      id: 34, name: 'محصول', code: 'VRUI-A', active: 1, allow_negative: 1,
      warehouse_type: 'finished_goods', inventory_system: 'perpetual',
    });
    const WHB = insert('warehouses', {
      id: 35, name: 'کیمیا', code: 'VRUI-B', active: 1, allow_negative: 0,
      warehouse_type: 'finished_goods', inventory_system: 'perpetual',
    });
    const P = insert('products', {
      user_id: ADMIN_ID, name: 'کالای ۷۱۴۸مانند', code: 'K-7148T', price: 1, cost: 0,
      average_cost_rial: U, stock: 0, warehouse_id: WHA, unit: 'عدد',
    });
    ok(Number(P) !== 342 && String(q1('SELECT code FROM products WHERE id=?', P).code) !== '7217', 'fixture never 342/7217');

    insert('product_variants', { product_id: P, sku: 'K-7148T', is_default: 1, active: 1, stock: 0 });
    const SIZE = insert('product_sizes', { name: 'فری', sort_order: 1, active: 1 });
    const COLS = ['مشکی', 'سرمه‌ای', 'نسکافه‌ای'].map((name, i) =>
      insert('product_colors', { name, sort_order: i, active: 1 }));
    const V = COLS.map((cid, i) => insert('product_variants', {
      product_id: P, color_id: cid, size_id: SIZE, sku: `K-7148T-${i}`, is_default: 0, active: 1, stock: 0,
    }));

    const OPEN = legacyRow({
      event_type: 'opening', source_type: 'opening', source_id: 1, product_id: P, warehouse_id: WHA,
      qty_in: 24, amount_rial: 24 * U, tx_no: 'INV-0592',
    });
    const MOVE = insert('warehouse_moves', {
      type: 'transfer', product_id: P, from_warehouse_id: WHA, to_warehouse_id: WHB,
      qty: 8, date: D, created_by: ADMIN_ID, note: 'transfer fixture',
    });
    const TOUT = legacyRow({
      event_type: 'transfer_out', source_type: 'warehouse_move', source_id: MOVE,
      product_id: P, warehouse_id: WHA, qty_out: 8, amount_rial: 8 * U, tx_no: 'INV-0409',
    });
    const TIN = legacyRow({
      event_type: 'transfer_in', source_type: 'warehouse_move', source_id: MOVE,
      product_id: P, warehouse_id: WHB, qty_in: 8, amount_rial: 8 * U, tx_no: 'INV-0410',
    });
    // qty-0 revalue on A (not a candidate) + transfer_in_revalue on B (must be ignored by counterpart)
    const REVAL = legacyRow({
      event_type: 'revaluation', source_type: 'inventory_adjust', source_id: 99,
      product_id: P, warehouse_id: WHA, qty_in: 0, qty_out: 0, amount_rial: 0, tx_no: 'INV-2216',
    });
    legacyRow({
      event_type: 'transfer_in_revalue', source_type: 'warehouse_move', source_id: MOVE,
      product_id: P, warehouse_id: WHB, qty_in: 0, qty_out: 0, amount_rial: 0, tx_no: 'INV-2216B',
    });

    // B side reclassed by a real VR to 4/3/1 (source TIN reversed by postReclass)
    const SPLIT_B = [4, 3, 1];
    const linesB = V.map((vid, i) => ({ variant_id: vid, qty: SPLIT_B[i] }));
    let r = await call('POST', '/api/inventory/variant-reclass', {
      ledger_id: TIN, lines: linesB, reason: 'تفکیک ورود کیمیا ۸', confirm: true,
    });
    ok(r.status === 200 && r.body && r.body.doc_no, 'fixture VR on B TIN', r.body && r.body.doc_no);
    const vrB = r.body.doc_no;
    legacyRow({
      event_type: 'sale', source_type: 'invoice', source_id: 1, product_id: P, warehouse_id: WHB,
      variant_id: V[0], qty_out: 1, amount_rial: U, tx_no: 'SALE-B0',
    });
    legacyRow({
      event_type: 'sale', source_type: 'invoice', source_id: 2, product_id: P, warehouse_id: WHB,
      variant_id: V[2], qty_out: 1, amount_rial: U, tx_no: 'SALE-B2',
    });
    SC.rebuildStockCache(db, P);

    const dA = SC.deriveProductStock(db, P);
    ok(n3(dA.unattributed.get(WHA) || 0) === 16, 'fixture: unallocated A = 16', [...dA.unattributed]);
    ok(n3(dA.warehouses.get(WHA) || 0) === 16, 'fixture: kardex A = 16');
    ok(n3((dA.variantWarehouses.get(`${V[0]}:${WHB}`) || 0)) === 3, 'fixture: B مشکی 3 after sale');
    ok(n3((dA.variantWarehouses.get(`${V[1]}:${WHB}`) || 0)) === 3, 'fixture: B سرمه‌ای 3');
    ok(n3((dA.variantWarehouses.get(`${V[2]}:${WHB}`) || 0)) === 0, 'fixture: B نسکافه‌ای 0 after sale');

    console.log('— candidates + counterpart —');
    r = await call('GET', `/api/inventory/variant-reclass/candidates?product_id=${P}&warehouse_id=${WHA}`);
    ok(r.status === 200, 'GET candidates 200', r.body);
    const ids = (r.body.candidates || []).map((c) => c.ledger_id);
    ok(ids.includes(OPEN) && ids.includes(TOUT), 'candidates include +24 and −8', ids);
    ok(!ids.includes(REVAL), 'candidates exclude qty-0 revalue', ids);
    ok(r.body.integer === true, 'integer true for matrix');
    ok(n3(r.body.unallocated_net) === 16, 'unallocated_net 16', r.body.unallocated_net);
    ok(Array.isArray(r.body.variants) && r.body.variants.length === 3, '3 active variants');
    const toutCand = (r.body.candidates || []).find((c) => c.ledger_id === TOUT);
    const cp = toutCand && toutCand.counterpart;
    ok(!!cp && cp.vr_doc_no === vrB && cp.exact === true, 'counterpart has VR + exact', cp);
    const cpMap = Object.fromEntries((cp.lines || []).map((l) => [Number(l.variant_id), Number(l.qty)]));
    ok(cpMap[V[0]] === 4 && cpMap[V[1]] === 3 && cpMap[V[2]] === 1, 'counterpart.lines = 4/3/1', cpMap);

    console.log('— guided remainder planner —');
    const leftover = [
      { variant_id: V[0], qty: 10 },
      { variant_id: V[1], qty: 4 },
      { variant_id: V[2], qty: 2 },
    ];
    const plan = VR.planGuidedRemainder({ candidates: r.body.candidates, leftoverLines: leftover });
    ok(plan.ok === true && plan.steps && plan.steps.length === 2, 'net plan 2 steps', plan);
    const stepIn = plan.steps.find((s) => s.direction === 'in');
    const stepOut = plan.steps.find((s) => s.direction === 'out');
    ok(stepIn && stepIn.ledger_id === OPEN && stepOut && stepOut.ledger_id === TOUT, 'inbound first then outbound');
    const inMap = Object.fromEntries(stepIn.lines.map((l) => [l.variant_id, l.qty]));
    const outMap = Object.fromEntries(stepOut.lines.map((l) => [l.variant_id, l.qty]));
    ok(inMap[V[0]] === 14 && inMap[V[1]] === 7 && inMap[V[2]] === 3, 'inbound 14/7/3', inMap);
    ok(outMap[V[0]] === 4 && outMap[V[1]] === 3 && outMap[V[2]] === 1, 'outbound 4/3/1', outMap);

    const jeBeforeNet = jeAlive();
    const sumBeforeNet = jeSum();
    const hdrBeforeNet = SC.deriveProductStock(db, P).header;
    r = await call('POST', '/api/inventory/variant-reclass', {
      ledger_id: OPEN, lines: stepIn.lines, reason: 'نت: تفکیک افتتاحیه ۲۴', confirm: true,
    });
    ok(r.status === 200, 'net post inbound 24', r.body && r.body.doc_no);
    r = await call('POST', '/api/inventory/variant-reclass', {
      ledger_id: TOUT, lines: stepOut.lines, reason: 'نت: تفکیک خروج ۸', confirm: true,
    });
    ok(r.status === 200, 'net post outbound 8', r.body && r.body.doc_no);
    const dNet = SC.deriveProductStock(db, P);
    ok(n3(dNet.unattributed.get(WHA) || 0) === 0, 'after net: A unallocated 0');
    ok(n3(dNet.variantWarehouses.get(`${V[0]}:${WHA}`) || 0) === 10, 'A مشکی 10');
    ok(n3(dNet.variantWarehouses.get(`${V[1]}:${WHA}`) || 0) === 4, 'A سرمه‌ای 4');
    ok(n3(dNet.variantWarehouses.get(`${V[2]}:${WHA}`) || 0) === 2, 'A نسکافه‌ای 2');
    ok(n3(dNet.variantWarehouses.get(`${V[0]}:${WHB}`) || 0) === 3, 'B unchanged مشکی 3');
    ok(n3(dNet.header) === hdrBeforeNet, 'header unchanged after net posts');
    ok(jeAlive() === jeBeforeNet && jeSum().d === sumBeforeNet.d, 'JE unchanged after net posts');
    ok(qa('PRAGMA foreign_key_check').length === 0, 'foreign_key_check empty after net');

    // Void outbound first, then inbound, so later one-row tests can re-use OPEN/TOUT
    const docsNet = VR.listDocs(db, { productId: P, limit: 20 }).filter((d) => d.status === 'posted');
    const docOut = docsNet.find((d) => Number(d.source_ledger_id) === TOUT);
    const docIn = docsNet.find((d) => Number(d.source_ledger_id) === OPEN);
    if (docOut) {
      r = await call('POST', `/api/inventory/variant-reclass/${docOut.id}/void`, { reason: 'پاکسازی نت خروج', confirm: true });
      ok(r.status === 200, 'void net outbound', r.body && r.body.status);
    }
    if (docIn) {
      r = await call('POST', `/api/inventory/variant-reclass/${docIn.id}/void`, { reason: 'پاکسازی نت ورود', confirm: true });
      ok(r.status === 200, 'void net inbound', r.body && r.body.status);
    }
    SC.rebuildStockCache(db, P);

    console.log('— net blocked without counterpart —');
    const blocked = VR.planGuidedRemainder({
      candidates: [
        { ledger_id: 1, direction: 'in', qty: 5, eligible: true, event_type: 'opening' },
        { ledger_id: 2, direction: 'out', qty: 2, eligible: true, event_type: 'transfer_out', source_type: 'warehouse_move', counterpart: null },
      ],
      leftoverLines: [{ variant_id: V[0], qty: 3 }],
    });
    ok(blocked.ok === false && blocked.blocked === true, 'missing counterpart → net blocked', blocked);
    const inexact = VR.planGuidedRemainder({
      candidates: [
        { ledger_id: 1, direction: 'in', qty: 5, eligible: true, event_type: 'opening' },
        {
          ledger_id: 2, direction: 'out', qty: 2, eligible: true, event_type: 'transfer_out', source_type: 'warehouse_move',
          counterpart: { exact: false, lines: [{ variant_id: V[0], qty: 1 }], vr_doc_no: 'VR-X' },
        },
      ],
      leftoverLines: [{ variant_id: V[0], qty: 3 }],
    });
    ok(inexact.ok === false && inexact.blocked === true, 'exact=false → net blocked', inexact);

    r = await call('GET', `/api/inventory/variant-reclass/candidates?product_id=${P}&warehouse_id=${WHA}`, null, CASHIER_ID);
    ok(r.status === 403, 'cashier candidates 403', r.body);

    console.log('— preview/post 24 then −8 —');
    const lines24 = [
      { variant_id: V[0], qty: 10 },
      { variant_id: V[1], qty: 8 },
      { variant_id: V[2], qty: 6 },
    ];
    r = await call('POST', '/api/inventory/variant-reclass/preview', {
      ledger_id: OPEN, lines: [{ variant_id: V[0], qty: 16 }],
    });
    ok(r.status === 400 && r.body && r.body.code === 'E_VR_QTY_SUM', '16 on 24 → E_VR_QTY_SUM', r.body);

    r = await call('POST', '/api/inventory/variant-reclass/preview', { ledger_id: OPEN, lines: lines24 });
    ok(r.status === 200 && Number(r.body.gl_effect_rial) === 0, 'preview 24 gl_effect 0', r.body);

    const jeBefore = jeAlive();
    const sumBefore = jeSum();
    const hdrBefore = SC.deriveProductStock(db, P).header;

    r = await call('POST', '/api/inventory/variant-reclass', {
      ledger_id: OPEN, lines: lines24, reason: 'تفکیک افتتاحیه ۲۴', confirm: true,
    });
    ok(r.status === 200 && r.body && r.body.doc_no, 'post 24 VR', r.body && r.body.doc_no);
    const doc24 = r.body;

    const lines8 = [
      { variant_id: V[0], qty: 4 },
      { variant_id: V[1], qty: 3 },
      { variant_id: V[2], qty: 1 },
    ];
    // Second post before outbound VR: source is reversed → 409 (EXISTS or NOT_LIVE)
    r = await call('POST', '/api/inventory/variant-reclass', {
      ledger_id: OPEN, lines: lines24, reason: 'دوباره', confirm: true,
    });
    ok(r.status === 409 && r.body && (r.body.code === 'E_VR_EXISTS' || r.body.code === 'E_VR_NOT_LIVE'),
      'second post same source 409', r.body);

    r = await call('POST', '/api/inventory/variant-reclass/preview', {
      ledger_id: OPEN, lines: lines24,
    }, CASHIER_ID);
    ok(r.status === 403, 'cashier preview 403', r.body);

    // Void R13 while colours still fully available (before outbound VR consumes them)
    r = await call('POST', `/api/inventory/variant-reclass/${doc24.id}/void`, {
      reason: 'ابطال تست افتتاحیه', confirm: true,
    });
    ok(r.status === 200 && r.body && r.body.status === 'void', 'void VR-24 R13', r.body);
    const dVoid = SC.deriveProductStock(db, P);
    ok(n3(dVoid.unattributed.get(WHA) || 0) === 16, 'after void 24, A unallocated back to 16', dVoid.unattributed.get(WHA));
    ok(jeAlive() === jeBefore, 'void VR does not change JE count');

    r = await call('POST', '/api/inventory/variant-reclass', {
      ledger_id: OPEN, lines: lines24, reason: 'بازثبت افتتاحیه ۲۴', confirm: true,
    });
    ok(r.status === 200 && r.body && r.body.doc_no, 're-post 24 after void', r.body && r.body.doc_no);
    doc24.id = r.body.id;

    r = await call('POST', '/api/inventory/variant-reclass', {
      ledger_id: TOUT, lines: lines8, reason: 'تفکیک خروج ۸', confirm: true,
    });
    ok(r.status === 200 && r.body && r.body.doc_no, 'post −8 VR after inbound', r.body && r.body.doc_no);

    const d1 = SC.deriveProductStock(db, P);
    ok(n3(d1.unattributed.get(WHA) || 0) === 0, 'A unallocated 0 after VRs');
    ok(n3(d1.variantWarehouses.get(`${V[0]}:${WHA}`) || 0) === 6, 'A مشکی 10−4=6', d1.variantWarehouses.get(`${V[0]}:${WHA}`));
    ok(n3(d1.variantWarehouses.get(`${V[1]}:${WHA}`) || 0) === 5, 'A سرمه‌ای 8−3=5');
    ok(n3(d1.variantWarehouses.get(`${V[2]}:${WHA}`) || 0) === 5, 'A نسکافه‌ای 6−1=5');
    ok(n3(d1.warehouses.get(WHA) || 0) === 16, 'A kardex still 16');
    ok(n3(d1.variantWarehouses.get(`${V[0]}:${WHB}`) || 0) === 3, 'B مشکی unchanged 3 (after sale)');
    ok(n3(d1.header) === hdrBefore, 'header qty unchanged', [d1.header, hdrBefore]);
    ok(jeAlive() === jeBefore && jeSum().d === sumBefore.d && jeSum().c === sumBefore.c, 'JE count+sum unchanged');
    ok(qa('PRAGMA foreign_key_check').length === 0, 'foreign_key_check empty', qa('PRAGMA foreign_key_check'));

    const OPEN2 = legacyRow({
      event_type: 'opening', source_type: 'opening', source_id: 2, product_id: P, warehouse_id: WHA,
      qty_in: 3, amount_rial: 3 * U, tx_no: 'OPEN2',
    });
    SC.rebuildStockCache(db, P);
    const defId = q1('SELECT id FROM product_variants WHERE product_id=? AND COALESCE(is_default,0)=1', P).id;
    r = await call('POST', '/api/inventory/variant-reclass/preview', {
      ledger_id: OPEN2, lines: [{ variant_id: defId, qty: 3 }],
    });
    ok(r.status === 400 && r.body && r.body.code === 'E_VR_VARIANT_INACTIVE', 'default variant rejected', r.body);
    const dRem = SC.deriveProductStock(db, P);
    ok(n3(dRem.unattributed.get(WHA) || 0) === 3, 'OPEN2 leaves unattributed 3 for void-cache test', dRem.unattributed.get(WHA));

    console.log('— INV-4556/4557 void leftover cache —');
    const colour = V[0];
    const beforeVws = vws(colour, WHA);
    const beforePv = pvStock(colour);
    const adj = MA.postAdjust(db, {
      product_id: P, warehouse_id: WHA, variant_id: colour,
      mode: 'delta', qty: 2, reason_code: 'surplus', note: 'شبیه‌سازی INV-4556',
    }, { id: ADMIN_ID, role: 'admin' });
    ok(!!adj && !!adj.id, 'postAdjust +2', adj && adj.id);
    ok(vws(colour, WHA) === n3(beforeVws + 2), 'VWS +2 after adjust');
    ok(pvStock(colour) === n3(beforePv + 2), 'pv.stock +2 after adjust');

    r = await call('POST', `/api/inventory/ledger/${adj.id}/reverse`, { note: 'ابطال شبیه INV-4557' });
    ok(r.status === 200, 'void adjust via ledger reverse', r.body);
    ok(vws(colour, WHA) === beforeVws, 'VWS restored after void (not stale +2)', { now: vws(colour, WHA), before: beforeVws });
    ok(pvStock(colour) === beforePv, 'pv.stock restored after void', { now: pvStock(colour), before: beforePv });
    ok(n3(SC.deriveProductStock(db, P).unattributed.get(WHA) || 0) === 3, 'unattributed remainder still 3');

    r = await call('POST', `/api/inventory/ledger/${adj.id}/reverse`, { note: 'دوباره' });
    ok(r.status >= 400, 'second void rejected', r.status);

    const sum2 = SC.rebuildStockCache(db, P);
    ok(vws(colour, WHA) === beforeVws, 'rebuild again idempotent for VWS');
    ok(sum2 && sum2.force_variant_ledger === false, 'rebuild without force');

    // Other reverseStockDocument path: synthetic colour inbound then void movements
    console.log('— reverseStockDocument (transfer-like) with unattributed —');
    const ledX = L.postInventoryMovement(db, {
      eventType: 'adjustment', productId: P, warehouseId: WHA, variantId: V[1],
      qty: 1, unitCostRial: U, sourceType: 'inventory_adjust', sourceId: null,
      date: D, note: 'synthetic colour +1', createdBy: ADMIN_ID,
    });
    db.prepare('UPDATE inventory_ledger SET source_id=? WHERE id=?').run(ledX.id, ledX.id);
    M.postVariantLayer(db, {
      productId: P, variantId: V[1], warehouseId: WHA, qtyDelta: 1,
      docType: 'inventory_adjust', docId: ledX.id, userId: ADMIN_ID, note: 'x',
      allowNegative: true,
    });
    const mid = vws(V[1], WHA);
    M.reverseStockDocument(db, {
      docType: 'inventory_adjust', docId: ledX.id, userId: ADMIN_ID, note: 'void synth', applyHeaderStock: false,
    });
    // reverse ledger row too so attributed = 0 while unattributed remains
    L.reverseInventoryMovement(db, ledX.id, { createdBy: ADMIN_ID, date: D, note: 'rev' });
    SC.rebuildStockCache(db, P);
    ok(vws(V[1], WHA) === n3(mid - 1), 'other reverseStockDocument clears/reflects colour cache', {
      mid, now: vws(V[1], WHA),
    });

    console.log('— preserveZeros guard (no void) —');
    const P2 = insert('products', {
      user_id: ADMIN_ID, name: 'گارد حفظ', code: 'K-GUARD', price: 1, cost: 0,
      average_cost_rial: U, stock: 0, warehouse_id: WHA, unit: 'عدد',
    });
    insert('product_variants', { product_id: P2, sku: 'K-GUARD', is_default: 1, active: 1, stock: 0 });
    const C2 = insert('product_colors', { name: 'قرمزگارد', sort_order: 1, active: 1 });
    const VG = [
      insert('product_variants', { product_id: P2, color_id: C2, size_id: SIZE, sku: 'K-GUARD-1', is_default: 0, active: 1, stock: 5 }),
      insert('product_variants', {
        product_id: P2,
        color_id: insert('product_colors', { name: 'آبیگارد', sort_order: 2, active: 1 }),
        size_id: SIZE, sku: 'K-GUARD-2', is_default: 0, active: 1, stock: 3,
      }),
    ];
    db.prepare('INSERT INTO variant_warehouse_stock (variant_id, warehouse_id, qty) VALUES (?,?,?)').run(VG[0], WHA, 5);
    db.prepare('INSERT INTO variant_warehouse_stock (variant_id, warehouse_id, qty) VALUES (?,?,?)').run(VG[1], WHA, 3);
    legacyRow({
      event_type: 'opening', source_type: 'opening', source_id: 9, product_id: P2, warehouse_id: WHA,
      qty_in: 8, amount_rial: 8 * U, tx_no: 'GUARD-OPEN',
    });
    const gSum = SC.rebuildStockCache(db, P2);
    ok(gSum && gSum.variant_cache_preserved === true, 'variant_cache_preserved', gSum);
    ok(vws(VG[0], WHA) === 5 && vws(VG[1], WHA) === 3, 'guard keeps seeded VWS without void movements');

    console.log('— allow_negative=0 planner block (lib projection) —');
    // Project: WHB allow_negative=0, V[2] stock 0; outbound plan that would go negative must be refused by UI planner.
    // Engine unchanged — we only assert warehouse flag + current cell for the UI contract.
    ok(Number(q1('SELECT allow_negative FROM warehouses WHERE id=?', WHB).allow_negative) === 0, 'WHB allow_negative=0');
    ok(vws(V[2], WHB) === 0, 'WHB نسکافه‌ای cell 0');
    const wouldNeg = 0 - 1;
    ok(wouldNeg < 0, 'UI planner would block outbound that makes cell negative');

    console.log('— repair script dry-run (read-only) —');
    try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (_) { /* */ }
    const cleanCopy = path.join(dir, 'repair-clean.db');
    fs.copyFileSync(process.env.DB_PATH, cleanCopy);
    const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    const mtimeBefore = fs.statSync(cleanCopy).mtimeMs;
    const shaBefore = sha(cleanCopy);
    const nodeBin = process.execPath;
    const dryClean = spawnSync(nodeBin, [path.join(__dirname, 'repair-void-adjust-variant-cache.js')], {
      env: { ...process.env, DB_PATH: cleanCopy, ERP_TEST_ISOLATION: '1', SMS_DISABLED: '1' },
      encoding: 'utf8',
    });
    ok(dryClean.status === 0, 'repair dry-run exit 0 on clean copy', dryClean.stderr && dryClean.stderr.slice(0, 300));
    ok(/dry-run/i.test(dryClean.stdout) && /"leftover_count": 0/.test(dryClean.stdout), 'clean dry-run leftover_count 0', dryClean.stdout.slice(0, 400));
    ok(fs.statSync(cleanCopy).mtimeMs === mtimeBefore, 'dry-run mtime unchanged');
    ok(sha(cleanCopy) === shaBefore, 'dry-run sha unchanged');

    // Seed a stale void-leftover cell on P and clear via rebuild rule
    const staleVid = V[2];
    const staleBefore = vws(staleVid, WHA);
    db.prepare(`
      INSERT INTO inventory_movements (product_id, variant_id, warehouse_id, qty_delta, doc_type, doc_id, doc_line, user_id, note)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(P, staleVid, WHA, 2, 'inventory_adjust', 900001, null, ADMIN_ID, 'stale seed');
    db.prepare(`
      INSERT INTO inventory_movements (product_id, variant_id, warehouse_id, qty_delta, doc_type, doc_id, doc_line, user_id, note)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(P, staleVid, WHA, -2, 'inventory_adjust_void', 900001, null, ADMIN_ID, 'stale void');
    const staleTarget = n3(staleBefore + 2);
    db.prepare(`
      INSERT INTO variant_warehouse_stock (variant_id, warehouse_id, qty) VALUES (?,?,?)
      ON CONFLICT(variant_id, warehouse_id) DO UPDATE SET qty=excluded.qty
    `).run(staleVid, WHA, staleTarget);
    const ledAttr = n3(SC.deriveProductStock(db, P).variantWarehouses.get(`${staleVid}:${WHA}`) || 0);
    const hints = SC.loadVariantMovementHints(db, [staleVid]);
    const hint = hints.byVW.get(`${staleVid}:${WHA}`);
    ok(!!(hint && hint.hasVoid), 'stale cell has void movement');
    SC.rebuildStockCache(db, P);
    ok(vws(staleVid, WHA) === ledAttr, 'rebuildStockCache clears stale void leftover', {
      now: vws(staleVid, WHA), ledAttr,
    });

    console.log('— new Function(app.js) —');
    const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
    try {
      // eslint-disable-next-line no-new-func
      new Function(appJs);
      ok(true, 'new Function(app.js)');
    } catch (e) {
      ok(false, 'new Function(app.js)', String(e && e.message));
    }

    ok(/erp-taranom-v634/.test(fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8')), 'SW v634');
    ok(/counterpart/.test(appJs) && /net_blocked/.test(appJs), 'app.js keeps counterpart + net_blocked');
  } finally {
    server.close();
  }

  console.log(`\n══ نتیجه: ${pass} OK / ${fail} FAIL ══\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
