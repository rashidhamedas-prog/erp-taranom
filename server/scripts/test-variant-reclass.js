'use strict';
/**
 * سند اصلاح تفکیک واریانت (VR) + اسکریپت stock-variant-resolve.
 * Run: node server/scripts/test-variant-reclass.js
 *
 * Temp DB: matrix product with a legacy production_receipt row of 84 without variant (like ledger#2441,
 * PO-0019 → 14/20/18/16/16), invoices whose lines are unique / ambiguous by qty, one reversal twin.
 *  - preview read-only; 400/409 with zero writes; 403 for cashier
 *  - post: one row per variant (Σ qty / Σ amount = source), source reversed, no JE, trial balance and
 *    valuation value unchanged, cache = ledger, unattributed 0, header unchanged; second post 409
 *  - void (R13), also after the boot heal retired the reversal row: back to unattributed, value unchanged
 *  - void refused when a variant was sold after the document
 *  - planGroupA strict stamps unique lines only (twin inherits); planGroupB plans the receipt split
 *  - CLI: dry-run writes nothing + CSVs; apply without GO exits 2; phase-0 mismatch exits 3;
 *    apply on a copy stamps + posts VR with trial balance unchanged
 *  - sync registry / capture map
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

console.log('\n══ سند اصلاح تفکیک واریانت (VR) + stock-variant-resolve ══\n');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-reclass-'));
process.env.DB_PATH = path.join(dir, 'vr.db');
process.env.UPLOADS_DIR = path.join(dir, 'uploads');
process.env.SYNC_ROLE = 'central';
process.env.ERP_TEST_ISOLATION = '1';
process.env.SMS_DISABLED = '1';
process.env.JWT_SECRET = 'variant-reclass-test-secret-32-chars!!';
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
const changes = () => q1('SELECT total_changes() AS n').n;

const ADMIN_ID = insert('users', { name: 'مدیر تست', username: 'vr_admin', password: 'x', role: 'admin', active: 1, must_change_password: 0 });
const CASHIER_ID = insert('users', { name: 'صندوقدار', username: 'vr_cashier', password: 'x', role: 'cashier', active: 1, must_change_password: 0 });

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
const RES = require('./stock-variant-resolve');
const D = '1405/08/11';
const U = 5729900;
const SPLIT = [14, 20, 18, 16, 16];

function trial() {
  const t = q1(`SELECT COALESCE(SUM(debit),0) d, COALESCE(SUM(credit),0) c, COUNT(*) n FROM journal_lines`);
  return { d: Math.round(t.d), c: Math.round(t.c), n: t.n, e: q1('SELECT COUNT(*) c FROM journal_entries').c };
}
function bucketValue(pid) {
  try { return Math.round(q1('SELECT COALESCE(SUM(value_rial),0) v FROM inventory_valuation_buckets WHERE product_id=?', pid).v); }
  catch (_) { return 0; }
}
function legacyRow(o) {
  return insert('inventory_ledger', {
    tx_no: 'LEG-' + Math.random().toString(36).slice(2, 8), status: 'posted', date: D, note: 'legacy', created_by: ADMIN_ID,
    qty_in: 0, qty_out: 0, unit_cost_rial: U, ...o,
  });
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
    const WH = insert('warehouses', { id: 34, name: 'انبار محصول', code: 'VR-34', active: 1, allow_negative: 0,
      warehouse_type: 'finished_goods', inventory_system: 'perpetual' });
    const P = insert('products', { user_id: ADMIN_ID, name: 'شنل تست', code: 'K-T230', price: 9000000, cost: 0,
      average_cost_rial: U, stock: 0, warehouse_id: WH, unit: 'عدد' });
    const P2 = insert('products', { user_id: ADMIN_ID, name: 'ساده', code: 'S-1', price: 1, cost: 0, average_cost_rial: 1000, stock: 0, warehouse_id: WH, unit: 'عدد' });
    insert('product_variants', { product_id: P, sku: 'K-T230', is_default: 1, active: 1, stock: 0 });
    const SIZE = insert('product_sizes', { name: 'فری سایز تست', sort_order: 1, active: 1 });
    const COLORS = SPLIT.map((_, i) => insert('product_colors', { name: `رنگ تست ${i}`, sort_order: i, active: 1 }));
    const V = SPLIT.map((_, i) => insert('product_variants', { product_id: P, color_id: COLORS[i], size_id: SIZE, sku: `K-T230-${i}`, is_default: 0, active: 1, stock: 0 }));
    const VOTHER = insert('product_variants', { product_id: P2, sku: 'S-1-x', is_default: 0, active: 0, stock: 0 });

    console.log('— fixture —');
    const ORDER = insert('production_orders', { order_no: 'PO-T19', product_id: P, qty_planned: 84, qty_produced: 84, status: 'completed', date: D, warehouse_fg_id: WH });
    insert('production_receipts', { doc_no: 'PR-T14', order_id: ORDER, product_id: P, qty: 84, warehouse_id: WH, status: 'posted', date: D,
      unit_cost_rial: U, amount_rial: 84 * U, output_type: 'finished_good', cost_method: 'actual',
      variant_lines_json: JSON.stringify(V.map((v, i) => ({ variant_id: v, qty: SPLIT[i] }))) });
    const SRC = legacyRow({ event_type: 'production_receipt', source_type: 'production_receipt', source_id: ORDER, product_id: P, warehouse_id: WH,
      qty_in: 84, amount_rial: 84 * U + 7 });
    const CUST = insert('customers', { user_id: ADMIN_ID, biz: 'مشتری تست', owner: 'تست', name: 'مشتری تست', phone: '09000000001', city: 'مشهد' });
    const INV1 = insert('invoices', { cust_id: CUST, user_id: ADMIN_ID, num: 'T-9001', type: 'normal', date: D, rows: JSON.stringify([
      { product_id: P, qty: 2, variant_id: V[0] }, { product_id: P, qty: 3, variant_id: V[1] }]) });
    const INV2 = insert('invoices', { cust_id: CUST, user_id: ADMIN_ID, num: 'T-9002', type: 'normal', date: D, rows: JSON.stringify([
      { product_id: P, qty: 1, variant_id: V[2] }, { product_id: P, qty: 1, variant_id: V[3] }]) });
    const S1 = legacyRow({ event_type: 'sale', source_type: 'invoice', source_id: INV1, product_id: P, warehouse_id: WH, qty_out: 2, amount_rial: 2 * U });
    const S2 = legacyRow({ event_type: 'sale', source_type: 'invoice', source_id: INV1, product_id: P, warehouse_id: WH, qty_out: 3, amount_rial: 3 * U, status: 'reversed' });
    const S2R = legacyRow({ event_type: 'reversal', source_type: 'invoice', source_id: INV1, product_id: P, warehouse_id: WH, qty_in: 3, amount_rial: 3 * U, reversed_of: S2 });
    const S3 = legacyRow({ event_type: 'sale', source_type: 'invoice', source_id: INV2, product_id: P, warehouse_id: WH, qty_out: 1, amount_rial: U });
    SC.rebuildStockCache(db, P);
    const d0 = SC.deriveProductStock(db, P);
    ok(d0.header === 81 && (d0.unattributed.get(WH) || 0) === 81, 'fixture: header 81 (84 in − 2 − 1 live sales), all unattributed', [d0.header, [...d0.unattributed]]);

    const manualCsv = path.join(dir, 'manual.csv');
    fs.writeFileSync(manualCsv, 'kind,product_id,code,ledger_id,warehouse_id,variant_id,detail\n'
      + [S1, S2, S3].map((id) => `ambiguous_variant,${P},K-T230,${id},${WH},,"a|b"`).join('\n') + '\n');

    console.log('— planGroupA / planGroupB —');
    const A = RES.planGroupA(db, [S1, S2, S3]);
    const st = (id) => A.resolved.find((r) => r.ledger_id === id);
    ok(st(S1) && st(S1).variant_id === V[0], 'A: unique qty line → variant stamp', A.resolved);
    ok(st(S2) && st(S2).variant_id === V[1], 'A: reversed original matched by its own line');
    ok(st(S2R) && st(S2R).kind === 'stamp_twin' && st(S2R).variant_id === V[1], 'A: reversal twin inherits stamp');
    const u3 = A.unresolved.find((r) => r.ledger_id === S3);
    ok(u3 && u3.reason === 'multiple_lines' && u3.candidates === 2, 'A: two equal-qty lines → unresolved', A.unresolved);
    const B = RES.planGroupB(db, 'PO-T19');
    ok(B.docs.length === 1 && B.docs[0].ledger_id === SRC && B.docs[0].lines.map((l) => l.qty).join('/') === SPLIT.join('/'),
      'B: receipt split planned 14/20/18/16/16', B);
    ok(B.docs[0].lines.reduce((a, l) => a + l.amount_rial, 0) === 84 * U + 7, 'B: Σ line amounts = source amount (remainder on last)');

    console.log('— CLI on a copy —');
    const cliDb = path.join(dir, 'cli.db');
    await db.backup(cliDb);
    const script = path.join(__dirname, 'stock-variant-resolve.js');
    const env = { ...process.env, DB_PATH: cliDb };
    const run = (args) => spawnSync(process.execPath, [script, ...args], { env, encoding: 'utf8' });
    const sha = () => crypto.createHash('sha256').update(fs.readFileSync(cliDb)).digest('hex');
    const h0 = sha();
    const outDry = path.join(dir, 'out-dry');
    const dry = run(['--db', cliDb, '--manual-csv', manualCsv, '--order', 'PO-T19', '--out', outDry, '--expect-rows', '3', '--expect-products', '1']);
    const summ = (r) => { const l = (r.stdout || '').split('\n').find((x) => x.startsWith('SUMMARY ')); return l ? JSON.parse(l.slice(8)) : null; };
    const ds = summ(dry);
    ok(dry.status === 0 && ds && ds.mode === 'dry-run', 'dry-run exits 0', { status: dry.status, err: (dry.stderr || '').slice(0, 600) });
    ok(sha() === h0, 'dry-run leaves the DB byte-identical');
    ok(fs.existsSync(path.join(outDry, 'resolved.csv')) && fs.existsSync(path.join(outDry, 'unresolved.csv')), 'dry-run writes resolved/unresolved CSVs');
    ok(ds && ds.group_a.stamps === 2 && ds.group_a.twin_stamps === 1 && ds.group_a.unresolved === 1 && ds.group_b.docs.length === 1,
      'dry-run summary counts', ds && { a: ds.group_a, b: ds.group_b });
    const gateBad = run(['--db', cliDb, '--manual-csv', manualCsv, '--order', 'PO-T19', '--out', path.join(dir, 'o3'), '--expect-rows', '228']);
    ok(gateBad.status === 3, 'phase-0 count mismatch → exit 3', gateBad.status);
    const noGo = run(['--db', cliDb, '--manual-csv', manualCsv, '--order', 'PO-T19', '--out', path.join(dir, 'o2'), '--apply']);
    ok(noGo.status === 2 && sha() === h0, 'apply without --i-have-go exits 2 and writes nothing', noGo.status);
    const ap = run(['--db', cliDb, '--manual-csv', manualCsv, '--order', 'PO-T19', '--out', path.join(dir, 'o4'),
      '--backup-dir', path.join(dir, 'bak'), '--apply', '--i-have-go']);
    const as = summ(ap);
    ok(ap.status === 0 && as && !as.rolled_back, 'CLI apply on copy succeeds', { status: ap.status, err: (ap.stderr || '').slice(0, 800), s: as && as.error });
    ok(as && as.stamped === 3 && as.reclass_docs.length === 1, 'CLI apply: 3 stamps + 1 VR doc', as && { st: as.stamped, d: as.reclass_docs });
    ok(as && JSON.stringify(as.trial_before) === JSON.stringify(as.trial_after), 'CLI apply: trial balance + JE count unchanged');
    ok(as && fs.existsSync(as.backup), 'CLI apply: backup written');
    {
      const Database = require('better-sqlite3');
      const c = new Database(cliDb, { readonly: true });
      const vws = c.prepare(`SELECT variant_id, qty FROM variant_warehouse_stock WHERE warehouse_id=? AND variant_id IN (${V.join(',')}) ORDER BY variant_id`).all(WH);
      const want = V.map((v, i) => SPLIT[i] - (i === 0 ? 2 : 0));
      ok(vws.map((r) => r.qty).join('/') === want.join('/'), 'CLI apply: vws per variant from kardex (sale 2 on first variant)', vws);
      c.close();
    }

    console.log('— HTTP: guards (zero writes) —');
    const body = { ledger_id: SRC, lines: V.map((v, i) => ({ variant_id: v, qty: SPLIT[i] })), reason: 'تفکیک رسید PO-T19', confirm: true };
    let n0 = changes();
    const pv = await call('POST', '/api/inventory/variant-reclass/preview', body);
    ok(pv.status === 200 && pv.body.lines.length === 5 && pv.body.gl_effect_rial === 0, 'preview 200', pv);
    ok(changes() === n0, 'preview is read-only');
    const cases = [
      [{ ...body, reason: 'x' }, 400, 'E_VR_REASON_REQUIRED'],
      [{ ...body, confirm: false }, 400, 'E_VR_CONFIRM_REQUIRED'],
      [{ ...body, lines: body.lines.slice(1) }, 400, 'E_VR_QTY_SUM'],
      [{ ...body, lines: [...body.lines.slice(1), { variant_id: VOTHER, qty: 14 }] }, 400, 'E_VARIANT_MISMATCH'],
      [{ ...body, ledger_id: S2R }, 409, 'E_VR_NOT_LIVE'],
    ];
    n0 = changes();
    for (const [b, s, code] of cases) {
      const r = await call('POST', '/api/inventory/variant-reclass', b);
      ok(r.status === s && r.body && r.body.code === code, `POST → ${s} ${code}`, r);
    }
    const cz = await call('POST', '/api/inventory/variant-reclass', body, CASHIER_ID);
    ok(cz.status === 403, 'cashier → 403', cz.status);
    ok(changes() === n0, 'refused calls write nothing');

    const LA = require('../lib/inventory/line-availability');
    const round = (x) => Math.round(Number(x) * 1000) / 1000;
    const mvSum = (v) => round(q1('SELECT COALESCE(SUM(qty_delta),0) q FROM inventory_movements WHERE variant_id=? AND warehouse_id=?', v, WH).q);
    const driftV = (v) => LA.lineAvailability(db, { productId: P, variantId: v, warehouseIds: [WH] })[0];
    const mv0 = V.map(mvSum);

    console.log('— post —');
    const t0 = trial();
    const bv0 = bucketValue(P);
    const hdr0 = SC.deriveProductStock(db, P).header;
    const posted = await call('POST', '/api/inventory/variant-reclass', body);
    ok(posted.status === 200 && /^VR-\d{4}$/.test(posted.body.doc_no) && posted.body.status === 'posted', 'post 200 VR-####', posted);
    const doc = posted.body;
    const rows = qa(`SELECT * FROM inventory_ledger WHERE id IN (${doc.lines.map((l) => l.ledger_id).join(',')})`);
    ok(rows.length === 5 && rows.every((r) => r.event_type === 'production_receipt' && r.source_id === ORDER && r.status === 'posted' && r.date === D),
      'split rows keep event/source/date', rows.map((r) => [r.event_type, r.source_id, r.date]));
    ok(rows.reduce((a, r) => a + r.qty_in, 0) === 84 && rows.reduce((a, r) => a + r.amount_rial, 0) === 84 * U + 7, 'Σ split qty/amount = source');
    ok(q1('SELECT status FROM inventory_ledger WHERE id=?', SRC).status === 'reversed', 'source row reversed');
    ok(JSON.stringify(trial()) === JSON.stringify(t0), 'no JE, trial balance unchanged');
    ok(bucketValue(P) === bv0, 'valuation value unchanged', { before: bv0, after: bucketValue(P) });
    const d1 = SC.deriveProductStock(db, P);
    ok(d1.header === hdr0 && (d1.unattributed.get(WH) || 0) === -3, 'header unchanged; remaining unattributed = legacy sales only', [...d1.unattributed]);
    ok(V.every((v, i) => d1.variantWarehouses.get(`${v}:${WH}`) === SPLIT[i]), 'variant×warehouse = split');
    ok(SC.stockCacheVsLedger(db, { productId: P }).mismatch_count === 0, 'cache = ledger after post');
    const movRows = qa("SELECT * FROM inventory_movements WHERE doc_type='variant_reclass' AND doc_id=? ORDER BY id", doc.id);
    ok(movRows.length === 5 && doc.lines.every((l) => movRows.some((m) => m.id === l.movement_id && m.doc_line === l.ledger_id
      && m.variant_id === l.variant_id && m.warehouse_id === WH && m.qty_delta === l.qty && m.user_id === ADMIN_ID)),
    'post: one movement per line (+qty, doc_line = split ledger id, movement_id in lines_json)', { movRows, lines: doc.lines });
    ok(V.every((v, i) => mvSum(v) === round(mv0[i] + SPLIT[i])), 'post: Σ movements per variant×warehouse += split', V.map(mvSum));
    ok(V.every((v) => { const a = driftV(v); return a.drift_variant === false && a.movements_qty === a.on_hand; }),
      'post: lineAvailability drift_variant false (vws = Σ movements)', V.map((v) => driftV(v)));
    const vwsRows = qa(`SELECT variant_id, qty FROM variant_warehouse_stock WHERE warehouse_id=? AND variant_id IN (${V.join(',')}) ORDER BY variant_id`, WH);
    ok(vwsRows.map((r) => r.qty).join('/') === SPLIT.join('/'), 'post: vws = split exactly (no double-apply from movements)', vwsRows);
    const again = await call('POST', '/api/inventory/variant-reclass', { ...body, ledger_id: SRC });
    ok(again.status === 409 && again.body.code === 'E_VR_NOT_LIVE', 'second post on the same source → 409', again);
    const list = await call('GET', '/api/inventory/variant-reclass?product_id=' + P);
    ok(list.status === 200 && list.body.length === 1 && list.body[0].lines.length === 5, 'list returns the doc');

    console.log('— void after boot heal —');
    require('../lib/inventory/ledger').retirePostedReversalTwins(db);
    ok(q1('SELECT status FROM inventory_ledger WHERE id=?', doc.reversal_ledger_id).status === 'reversed', 'boot heal retired the reversal row');
    const vz = await call('POST', `/api/inventory/variant-reclass/${doc.id}/void`, { reason: 'ابطال آزمایشی', confirm: true });
    ok(vz.status === 200 && vz.body.status === 'void', 'void 200', vz);
    const d2 = SC.deriveProductStock(db, P);
    ok(d2.header === hdr0 && (d2.unattributed.get(WH) || 0) === 81 && V.every((v) => !d2.variantWarehouses.get(`${v}:${WH}`)),
      'void: back to unattributed 81, variants 0', { u: [...d2.unattributed], vw: [...d2.variantWarehouses] });
    ok(q1('SELECT status FROM inventory_ledger WHERE id=?', SRC).status === 'posted', 'void: source row live again');
    ok(JSON.stringify(trial()) === JSON.stringify(t0) && bucketValue(P) === bv0, 'void: trial balance and valuation unchanged');
    ok(SC.stockCacheVsLedger(db, { productId: P }).mismatch_count === 0, 'cache = ledger after void');
    const voidMov = qa("SELECT * FROM inventory_movements WHERE doc_type='variant_reclass_void' AND doc_id=?", doc.id);
    ok(voidMov.length === 5 && vz.body.lines.every((l) => voidMov.some((m) => m.id === l.void_movement_id && m.qty_delta === -l.qty)),
      'void: one counter movement per line (−qty, void_movement_id in lines_json)', { voidMov, lines: vz.body.lines });
    ok(V.every((v, i) => mvSum(v) === mv0[i]), 'void: Σ movements back to pre-reclass', V.map(mvSum));
    ok(V.every((v) => driftV(v).drift_variant === false), 'void: drift_variant false');
    const vz2 = await call('POST', `/api/inventory/variant-reclass/${doc.id}/void`, { reason: 'ابطال دوباره', confirm: true });
    ok(vz2.status === 409 && vz2.body.code === 'E_VR_ALREADY_VOID', 'second void → 409');

    console.log('— void refused after a sale of the variant —');
    const re = await call('POST', '/api/inventory/variant-reclass', body);
    ok(re.status === 200, 're-post after void allowed', re);
    const L = require('../lib/inventory/ledger');
    L.postInventoryMovement(db, { eventType: 'sale', productId: P, warehouseId: WH, variantId: V[0], qtyOut: 10, sourceType: 'invoice', sourceId: INV2, date: D, createdBy: ADMIN_ID });
    n0 = changes();
    const vz3 = await call('POST', `/api/inventory/variant-reclass/${re.body.id}/void`, { reason: 'ابطال پس از فروش', confirm: true });
    ok(vz3.status === 409 && vz3.body.code === 'E_VR_VARIANT_CONSUMED' && changes() === n0, 'void after sale → 409, zero writes', vz3);

    console.log('— outbound reclass: movements −qty —');
    const mvO = mvSum(V[3]);
    const outb = await call('POST', '/api/inventory/variant-reclass', { ledger_id: S3, lines: [{ variant_id: V[3], qty: 1 }], reason: 'تفکیک فروش T-9002', confirm: true });
    ok(outb.status === 200 && outb.body.lines[0].movement_id > 0, 'outbound post 200 with movement_id', outb);
    ok(mvSum(V[3]) === round(mvO - 1) && q1('SELECT qty_delta q FROM inventory_movements WHERE id=?', outb.body.lines[0].movement_id).q === -1,
      'outbound: movement qty_delta −1', mvSum(V[3]));
    ok(driftV(V[3]).drift_variant === false, 'outbound: drift_variant false', driftV(V[3]));
    const outv = await call('POST', `/api/inventory/variant-reclass/${outb.body.id}/void`, { reason: 'ابطال فروش تفکیکی', confirm: true });
    ok(outv.status === 200 && mvSum(V[3]) === mvO && driftV(V[3]).drift_variant === false, 'outbound void: Σ movements restored', outv);

    console.log('— legacy doc (posted before the movement layer) —');
    const leg = await call('POST', '/api/inventory/variant-reclass', { ledger_id: S1, lines: [{ variant_id: V[4], qty: 2 }], reason: 'سند قدیمی بدون حرکت', confirm: true });
    ok(leg.status === 200, 'legacy fixture post 200', leg);
    db.prepare("DELETE FROM inventory_movements WHERE doc_type='variant_reclass' AND doc_id=?").run(leg.body.id);
    db.prepare('UPDATE variant_reclass_docs SET lines_json=? WHERE id=?')
      .run(JSON.stringify(leg.body.lines.map(({ movement_id, ...l }) => l)), leg.body.id);
    const mvL = mvSum(V[4]);
    const legv = await call('POST', `/api/inventory/variant-reclass/${leg.body.id}/void`, { reason: 'ابطال سند قدیمی', confirm: true });
    ok(legv.status === 200 && mvSum(V[4]) === mvL
      && !q1("SELECT 1 x FROM inventory_movements WHERE doc_type='variant_reclass_void' AND doc_id=?", leg.body.id),
    'legacy void: no counter movement when the post wrote none', legv);

    console.log('— diag script (read-only) —');
    {
      const repost = await call('POST', '/api/inventory/variant-reclass', { ledger_id: S1, lines: [{ variant_id: V[4], qty: 2 }], reason: 'سند قدیمی دوم', confirm: true });
      db.prepare("DELETE FROM inventory_movements WHERE doc_type='variant_reclass' AND doc_id=?").run(repost.body.id);
      const diagDb = path.join(dir, 'diag.db');
      await db.backup(diagDb);
      const shaD = () => crypto.createHash('sha256').update(fs.readFileSync(diagDb)).digest('hex');
      const hD = shaD();
      const dg = spawnSync(process.execPath, [path.join(__dirname, '_diag-vr-missing-movements.js'), '--json'],
        { env: { ...process.env, DB_PATH: diagDb }, encoding: 'utf8' });
      let rep = null;
      try { rep = JSON.parse(dg.stdout); } catch (_) { rep = null; }
      ok(dg.status === 0 && rep && rep.missing_lines === 1 && rep.products.length === 1 && rep.products[0].product_id === P
        && rep.products[0].missing_lines === 1 && rep.lines[0].doc_id === repost.body.id && rep.lines[0].qty_delta === -2,
      'diag: lists the posted line without movement (per-product count)', { status: dg.status, rep, err: (dg.stderr || '').slice(0, 400) });
      ok(shaD() === hD, 'diag: DB byte-identical (read-only)');
    }

    console.log('— sync registry —');
    const { SYNCABLE_TABLES, FK_COLUMNS } = require('../sync/tables');
    ok(SYNCABLE_TABLES[SYNCABLE_TABLES.length - 1].name === 'variant_reclass_docs', 'variant_reclass_docs appended last');
    ok(FK_COLUMNS.some(([t, c]) => t === 'variant_reclass_docs' && c === 'source_ledger_id'), 'FK_COLUMNS registered');
    ok(cols('variant_reclass_docs').has('sync_seq'), 'sync_seq column present');
    const cap = require('../sync/capture');
    if (typeof cap.tableForPath === 'function') {
      ok(cap.tableForPath('/api/inventory/variant-reclass') === 'variant_reclass_docs', 'capture: POST ⇒ variant_reclass_docs');
      ok(cap.tableForPath('/api/inventory/variant-reclass/3/void') === 'variant_reclass_docs', 'capture: void ⇒ variant_reclass_docs');
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
