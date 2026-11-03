'use strict';
/**
 * سند موجودی اول دوره با واریانتِ غیرفعال‌شده (retireZeroStockColors).
 * Run: node server/scripts/test-opening-inactive-variant.js
 *
 * Isolated temp DB. Covers: draft with a retired variant (no reactivation at draft) → post by another
 * user reactivates it atomically (ledger.variant_id, variant layer, balanced JE); variant of another
 * product still E_VARIANT_MISMATCH; variant retired between draft and post; R13 void reverses cleanly.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK  ', label); }
  else { fail += 1; console.log('  FAIL', label, extra == null ? '' : JSON.stringify(extra)); }
}

console.log('\n══ opening stock — inactive variant reactivation ══\n');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opening-inactive-'));
process.env.DB_PATH = path.join(dir, 'oi.db');
process.env.SYNC_ROLE = 'central';
process.env.ERP_TEST_ISOLATION = '1';
process.env.SMS_DISABLED = '1';
process.env.JWT_SECRET = 'opening-inactive-variant-test-secret-32-chars!!';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');
delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;

const dbMods = require('../db');
dbMods.initDB();
const db = dbMods.getDB();

async function main() {
  const express = require('express');
  const http = require('http');
  const { issueStaffSession } = require('../lib/auth-sessions');
  const L = require('../lib/inventory/ledger');
  const M = require('../lib/inventory/movement');
  const PV = require('../lib/product-variants');
  const SE = require('../lib/inventory/shortage-error');
  const capture = require('../sync/capture');

  const colsCache = new Map();
  const cols = (t) => {
    if (!colsCache.has(t)) colsCache.set(t, new Set(db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name)));
    return colsCache.get(t);
  };
  function insert(table, obj) {
    const c = cols(table);
    const keys = Object.keys(obj).filter((k) => c.has(k));
    return db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
      .run(...keys.map((k) => obj[k])).lastInsertRowid;
  }
  const q1 = (sql, ...p) => db.prepare(sql).get(...p);
  const qa = (sql, ...p) => db.prepare(sql).all(...p);
  const n3 = (v) => Math.round(Number(v || 0) * 1000) / 1000;
  const whQty = (pid, wh) => n3(L.warehouseQty(db, pid, wh));
  const hdr = (pid) => n3(q1('SELECT stock FROM products WHERE id=?', pid)?.stock);
  const vwsQty = (vid, wh) => n3(q1('SELECT qty FROM variant_warehouse_stock WHERE variant_id=? AND warehouse_id=?', vid, wh)?.qty);
  const active = (vid) => Number(q1('SELECT active FROM product_variants WHERE id=?', vid)?.active);
  const jeLines = (jeId) => qa('SELECT account_code, debit_rial, credit_rial FROM journal_lines WHERE entry_id=?', jeId);
  const jeLive = (jeId) => {
    const h = q1('SELECT status, deleted_at FROM journal_entries WHERE id=?', jeId);
    return !!h && !(Number(h.deleted_at || 0) > 0) && !['reversed', 'void'].includes(String(h.status || ''));
  };
  const retire = (vid) => db.prepare("UPDATE product_variants SET active=0, status='inactive' WHERE id=?").run(vid);

  // ── seed ──
  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('inventory_allow_negative','0')").run();
  const adminA = insert('users', { name: 'مدیر ۱', username: 'oi_admin_a', password: 'x', role: 'admin', active: 1, must_change_password: 0 });
  const adminB = insert('users', { name: 'مدیر ۲', username: 'oi_admin_b', password: 'x', role: 'admin', active: 1, must_change_password: 0 });
  const acctId = insert('users', { name: 'حسابدار', username: 'oi_acct', password: 'x', role: 'accounting', active: 1, must_change_password: 0 });
  const whFG = insert('warehouses', { name: 'انبار کالای ساخته', code: 'FG', active: 1, allow_negative: 0, is_default: 1, warehouse_type: 'finished_goods', inventory_system: 'perpetual' });
  let pseq = 0;
  const product = (name, extra = {}) => insert('products', Object.assign({
    user_id: adminA, name, code: `OI-${++pseq}`, price: 100000, cost: 0, stock: 0, warehouse_id: whFG, average_cost_rial: 0, unit: 'عدد',
  }, extra));
  const PM = product('مانتو');
  const PO = product('شومیز');
  const red = insert('product_colors', { name: 'قرمز', code: 'RED', active: 1 });
  const blue = insert('product_colors', { name: 'آبی', code: 'BLUE', active: 1 });
  const sizeM = insert('product_sizes', { name: 'M', code: 'M', active: 1 });
  const V1 = insert('product_variants', { product_id: PM, color_id: red, size_id: sizeM, sku: 'OI-M-RED-M', stock: 0, active: 1, is_default: 0 });
  const V2 = insert('product_variants', { product_id: PM, color_id: blue, size_id: sizeM, sku: 'OI-M-BLUE-M', stock: 0, active: 1, is_default: 0 });
  const VO = insert('product_variants', { product_id: PO, color_id: red, size_id: sizeM, sku: 'OI-O-RED-M', stock: 0, active: 1, is_default: 0 });

  const tok = {};
  for (const [k, uid] of [['adminA', adminA], ['adminB', adminB], ['acct', acctId]]) {
    const u = q1('SELECT * FROM users WHERE id=?', uid);
    tok[k] = issueStaffSession(db, u, { device_kind: 'test', device_name: 'oi-' + k, device_fingerprint: 'oi-fp-' + k }).token;
  }
  const app = express();
  app.use(express.json());
  app.use('/api', SE.requestScope);
  app.use(capture.captureMiddleware);
  app.use('/api/opening-stock', require('../routes/opening-stock'));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const BASE = `http://127.0.0.1:${server.address().port}`;
  async function api(method, p, body, who = 'adminA') {
    const res = await fetch(BASE + p, {
      method,
      headers: { Authorization: 'Bearer ' + tok[who], 'Content-Type': 'application/json' },
      body: body == null ? undefined : JSON.stringify(body),
    });
    let data = null;
    try { data = await res.json(); } catch (_) { data = null; }
    return { status: res.status, data };
  }

  try {
    // ── 1. retire every zero-stock colour of PM ──
    console.log('— retire —');
    try { PV.retireZeroStockColors(db, PM); } catch (_) { /* fallback below */ }
    if (active(V1) || active(V2)) { retire(V1); retire(V2); }
    ok(active(V1) === 0 && active(V2) === 0, 'all PM variants inactive (retireZeroStockColors / direct UPDATE fallback)');
    ok(M.hasActiveMatrixVariants(db, PM) === false, 'hasActiveMatrixVariants(PM) = false when all retired');

    // ── 2. validation: mismatch / not-found still rejected ──
    console.log('\n— validation —');
    let r = await api('POST', '/api/opening-stock', { lines: [{ product_id: PM, warehouse_id: whFG, variant_id: VO, qty: 1, unit_cost_rial: 1000 }] }, 'acct');
    ok(r.status === 400 && r.data?.code === 'E_VARIANT_MISMATCH', 'variant of another product → 400 E_VARIANT_MISMATCH', r.data);
    r = await api('POST', '/api/opening-stock', { lines: [{ product_id: PM, warehouse_id: whFG, variant_id: 999999, qty: 1, unit_cost_rial: 1000 }] }, 'acct');
    ok(r.status === 404 && r.data?.code === 'E_VARIANT_NOT_FOUND', 'unknown variant → 404 E_VARIANT_NOT_FOUND', r.data);
    retire(VO);
    r = await api('POST', '/api/opening-stock', { lines: [{ product_id: PM, warehouse_id: whFG, variant_id: VO, qty: 1, unit_cost_rial: 1000 }] }, 'acct');
    ok(r.status === 400 && r.data?.code === 'E_VARIANT_MISMATCH', 'inactive variant of another product → still E_VARIANT_MISMATCH', r.data);
    ok(active(VO) === 0, 'rejected line did not reactivate foreign variant');

    // ── 3. draft with retired variant: accepted, no reactivation ──
    console.log('\n— draft —');
    r = await api('POST', '/api/opening-stock', { lines: [{ product_id: PM, warehouse_id: whFG, variant_id: V1, qty: 3, unit_cost_rial: 400000 }] }, 'acct');
    ok(r.status === 200 && r.data?.status === 'draft', 'draft with inactive variant → 200 draft', r.data);
    const doc1 = r.data;
    ok(active(V1) === 0, 'createDraft does NOT reactivate (active stays 0)');
    ok(vwsQty(V1, whFG) === 0 && hdr(PM) === 0, 'draft: stock untouched');

    // ── 4. post by another user reactivates atomically ──
    console.log('\n— post —');
    r = await api('POST', `/api/opening-stock/${doc1.id}/post`, null, 'acct');
    ok(r.status === 403 && r.data?.code === 'E_SOD_MAKER_CHECKER', 'creator cannot post', r.data);
    ok(active(V1) === 0, 'rejected post rolled back (variant still inactive)');
    r = await api('POST', `/api/opening-stock/${doc1.id}/post`, null, 'adminB');
    ok(r.status === 200 && r.data?.status === 'posted', 'other user posts → 200 posted', r.data);
    const posted = r.data;
    ok(active(V1) === 1 && q1('SELECT status FROM product_variants WHERE id=?', V1)?.status === 'active', 'variant reactivated (active=1, status=active)');
    ok(active(V2) === 0, 'other retired variant untouched');
    const led = qa("SELECT * FROM inventory_ledger WHERE source_type='opening_stock_doc' AND source_id=? AND event_type='opening'", doc1.id);
    ok(led.length === 1 && led[0].variant_id === V1 && led[0].je_id === posted.je_id, 'kardex/ledger row carries variant_id + je_id', led);
    ok(vwsQty(V1, whFG) === 3 && whQty(PM, whFG) === 3 && hdr(PM) === 3, 'variant layer 3 · warehouse 3 · header 3');
    const jl = jeLines(posted.je_id);
    const dr = jl.reduce((a, x) => a + Math.round(x.debit_rial || 0), 0);
    const cr = jl.reduce((a, x) => a + Math.round(x.credit_rial || 0), 0);
    ok(dr === cr && dr === 3 * 400000, 'JE balanced = 1,200,000', { dr, cr });

    // ── 5. variant retired between draft and post ──
    console.log('\n— retired after draft —');
    const PN = product('دامن');
    const V3 = insert('product_variants', { product_id: PN, color_id: red, size_id: sizeM, sku: 'OI-N-RED-M', stock: 0, active: 1, is_default: 0 });
    r = await api('POST', '/api/opening-stock', { lines: [{ product_id: PN, warehouse_id: whFG, variant_id: V3, qty: 2, unit_cost_rial: 300000 }] }, 'acct');
    ok(r.status === 200, 'draft with active variant', r.data);
    const doc2 = r.data;
    retire(V3);
    r = await api('POST', `/api/opening-stock/${doc2.id}/post`, null, 'adminB');
    ok(r.status === 200 && r.data?.status === 'posted' && active(V3) === 1 && vwsQty(V3, whFG) === 2, 'post after retire → reactivated + stock 2', r.data);

    // ── 6. void (R13) reverses cleanly ──
    console.log('\n— void —');
    r = await api('POST', `/api/opening-stock/${doc1.id}/void`, { reason: 'تست ابطال' }, 'adminA');
    ok(r.status === 200 && r.data?.status === 'void', 'void → 200 void', r.data);
    ok(vwsQty(V1, whFG) === 0 && whQty(PM, whFG) === 0 && hdr(PM) === 0, 'stock back to 0 (variant layer · warehouse · header)');
    ok(qa("SELECT status FROM inventory_ledger WHERE source_type='opening_stock_doc' AND source_id=? AND event_type='opening'", doc1.id).every((x) => x.status === 'reversed'), 'opening ledger row reversed');
    ok(qa("SELECT 1 FROM inventory_ledger WHERE source_type='opening_stock_doc' AND source_id=? AND event_type='reversal'", doc1.id).length === 1, 'one reversal ledger row');
    ok(!jeLive(posted.je_id), 'JE reversed');
    ok(qa('SELECT active FROM opening_stock_lines WHERE doc_id=?', doc1.id).every((x) => Number(x.active) === 0), 'lines released');
    r = await api('POST', '/api/opening-stock', { lines: [{ product_id: PM, warehouse_id: whFG, variant_id: V1, qty: 4, unit_cost_rial: 400000 }] }, 'acct');
    ok(r.status === 200, 'after void, same key accepted again (even if colour retired again)', r.data);
    r = await api('POST', `/api/opening-stock/${r.data.id}/post`, null, 'adminB');
    ok(r.status === 200 && active(V1) === 1 && vwsQty(V1, whFG) === 4, 're-post after void → active + stock 4', r.data);
  } finally {
    server.close();
  }
}

main().then(() => {
  console.log(`\nopening inactive variant: ${pass} passed, ${fail} failed`);
  try { db.close(); } catch (_) { /* */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* */ }
  process.exit(fail ? 1 : 0);
}).catch((e) => {
  console.error('FATAL', e);
  process.exit(2);
});
