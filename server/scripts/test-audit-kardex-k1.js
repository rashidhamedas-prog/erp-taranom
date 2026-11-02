'use strict';
/**
 * audit-kardex K1 — revalue zero transfer_in legs whose paired transfer_out was re-priced (v529 heal).
 * Run: node server/scripts/test-audit-kardex-k1.js
 *
 * Temp DB like production: wh34/wh35 on the same inventory account, wh36 on another one.
 * Real transfers through POST /api/warehouses/moves/transfer, then the v529 history is replayed:
 * both legs zeroed (pre-heal) and only the out leg re-priced + buckets rebuilt (heal) ⇒ leaked pairs.
 * Fixtures: leaked 34→35 (×2, warehouse-level product), leaked 35→34, zero/zero, leaked + voided,
 * leaked 34→36 (COA mismatch), and a pre-heal zero pair healed through the script itself.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK  ', label); }
  else { fail += 1; console.log('  FAIL', label, extra == null ? '' : JSON.stringify(extra).slice(0, 1500)); }
}

console.log('\n══ audit-kardex K1 — revalue transfer_in ══\n');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-k1-'));
process.env.DB_PATH = path.join(dir, 'k1.db');
process.env.UPLOADS_DIR = path.join(dir, 'uploads');
process.env.SYNC_ROLE = 'central';
process.env.ERP_TEST_ISOLATION = '1';
process.env.SMS_DISABLED = '1';
process.env.JWT_SECRET = 'audit-kardex-k1-test-secret-0123456789!!';
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

const ADMIN_ID = insert('users', { name: 'مدیر تست', username: 'k1_admin', password: 'x', role: 'admin', active: 1, must_change_password: 0 });
const CASHIER_ID = insert('users', { name: 'صندوقدار', username: 'k1_cashier', password: 'x', role: 'cashier', active: 1, must_change_password: 0 });

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
const V = require('../lib/inventory/valuation');
const TI = require('../lib/inventory/transfer-in-revalue');
const { buildInventoryGlGapReport } = require('../lib/inventory-gl-gap-report');
const P3 = require('../lib/inventory/p3-recon-drafts');

const D = '1405/07/03';
const TODAY = require('../jalali').todayJalali();

function kardexWh(wid, pid) {
  const r = q1(`SELECT COALESCE(SUM(CASE WHEN qty_in>0 THEN amount_rial WHEN qty_out>0 THEN -amount_rial ELSE amount_rial END),0) v,
      COALESCE(SUM(qty_in-qty_out),0) q
    FROM inventory_ledger WHERE warehouse_id=? ${pid ? 'AND product_id=?' : ''} AND status='posted' AND reversed_of IS NULL
      AND COALESCE(event_type,'')<>'reversal'`, ...(pid ? [wid, pid] : [wid]));
  return { v: Math.round(r.v), q: Math.round(r.q * 1000) / 1000 };
}
function glSnap() {
  const l = q1(`SELECT COUNT(*) n, COALESCE(SUM(debit_rial),0) d, COALESCE(SUM(credit_rial),0) c FROM journal_lines`);
  const inv = q1(`SELECT COALESCE(SUM(debit_rial-credit_rial),0) b FROM journal_lines WHERE account_code LIKE '1104%'`);
  const je = q1('SELECT COUNT(*) n FROM journal_entries');
  return { lines: l.n, dr: Math.round(l.d), cr: Math.round(l.c), inv1104: Math.round(inv.b), je: je.n };
}
const ledgerCount = () => q1('SELECT COUNT(*) c FROM inventory_ledger').c;
const corrCount = () => q1(`SELECT COUNT(*) c FROM inventory_ledger WHERE event_type='transfer_in_revalue'`).c;
const auditCount = () => q1("SELECT COUNT(*) c FROM audit_log WHERE action='ledger_revalue_transfer_in'").c;
const bucketsOf = (pid) => qa('SELECT warehouse_id, qty, value_rial, avg_rial FROM inventory_valuation_buckets WHERE product_id=? ORDER BY warehouse_id', pid)
  .map((b) => ({ w: b.warehouse_id, q: Math.round(b.qty * 1000) / 1000, v: Math.round(b.value_rial), a: Math.round(b.avg_rial) }));
const avgOf = (pid) => Math.round(Number(q1('SELECT average_cost_rial a FROM products WHERE id=?', pid).a) || 0);

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
    for (const [code, name, parent, level] of [
      ['1104', 'موجودی کالا', null, 2], ['110499', 'موجودی کالا ۳۴/۳۵', '1104', 3], ['110498', 'موجودی کالا ۳۶', '1104', 3],
    ]) {
      db.prepare('INSERT OR IGNORE INTO chart_of_accounts (code,name,type,parent_code,level,is_active) VALUES (?,?,?,?,?,1)')
        .run(code, name, 'asset', parent, level);
    }
    const wh = (id, name, coa) => insert('warehouses', {
      id, name, code: 'K1-' + id, active: 1, allow_negative: 0,
      warehouse_type: 'finished_goods', inventory_system: 'perpetual', inventory_coa_code: coa,
    });
    const WH34 = wh(34, 'انبار نوبرت', '110499');
    const WH35 = wh(35, 'کیمیا', '110499');
    const WH36 = wh(36, 'انبار حساب دیگر', '110498');
    V.ready(db);
    const prod = (code, extra) => insert('products', {
      user_id: ADMIN_ID, name: 'کالای ' + code, code, price: 5000000, cost: 0,
      average_cost_rial: 0, stock: 0, warehouse_id: WH34, unit: 'عدد', ...(extra || {}),
    });
    const P1 = prod('K1-P1');
    db.prepare("UPDATE products SET valuation_level='warehouse' WHERE id=?").run(P1);
    const P2 = prod('K1-P2');
    const P3x = prod('K1-P3');
    const P4 = prod('K1-P4');
    const P5 = prod('K1-P5');
    const P6 = prod('K1-P6');
    const receipt = (pid, wid, qty, unit) => L.postInventoryMovement(db, {
      eventType: 'production_receipt', productId: pid, warehouseId: wid, qty, unitCostRial: unit,
      sourceType: 'production_order', sourceId: 900 + pid, date: '1405/07/01', createdBy: ADMIN_ID,
    });
    receipt(P1, WH34, 20, 1000000);
    receipt(P2, WH35, 10, 2500000);
    receipt(P3x, WH34, 4, 700000);
    receipt(P4, WH34, 6, 900000);
    receipt(P5, WH34, 6, 1100000);
    receipt(P6, WH34, 8, 1300000);

    const transfer = async (pid, from, to, qty) => {
      const t = await call('POST', '/api/warehouses/moves/transfer', {
        from_warehouse_id: from, to_warehouse_id: to, product_id: pid, qty, date: D, note: 'K1 fixture',
      });
      const out = q1(`SELECT * FROM inventory_ledger WHERE product_id=? AND event_type='transfer_out' AND source_type='warehouse_transfer'
        ORDER BY id DESC LIMIT 1`, pid);
      const inn = q1(`SELECT * FROM inventory_ledger WHERE source_type='warehouse_transfer' AND source_id=? AND event_type='transfer_in'`, out.source_id);
      return { ok: t.status === 200, t, out, inn, move: out.source_id };
    };
    // v529 history: the pre-heal transfer had both legs at 0 …
    const zeroBoth = (x) => {
      db.prepare('UPDATE inventory_ledger SET amount_rial=0, unit_cost_rial=0 WHERE id IN (?,?)').run(x.out.id, x.inn.id);
      db.prepare('UPDATE warehouse_moves SET amount_rial=0, unit_cost_rial=0 WHERE id=?').run(x.move);
      try {
        db.prepare('UPDATE warehouse_docs SET amount_rial_total=0 WHERE id=(SELECT doc_id FROM warehouse_moves WHERE id=?)').run(x.move);
      } catch (_) { /* column optional */ }
    };
    // … and the heal re-priced only the out leg, then rebuilt buckets (scripts/heal-zero-outbound-cost-v529.js).
    const healOut = (x, pid) => {
      db.prepare(`UPDATE inventory_ledger SET unit_cost_rial=?, amount_rial=?, note=TRIM(COALESCE(note,'') || ' [v529 بهای خروجی از میانگین زمانی]') WHERE id=?`)
        .run(x.out.unit_cost_rial, x.out.amount_rial, x.out.id);
      V.rebuildBuckets(db, { productId: pid });
    };

    console.log('— fixtures —');
    const A = await transfer(P1, WH34, WH35, 5);
    const C = await transfer(P1, WH34, WH35, 2);
    const B = await transfer(P2, WH35, WH34, 3);
    const Z = await transfer(P3x, WH34, WH35, 2);
    const R = await transfer(P4, WH34, WH35, 2);
    const M = await transfer(P5, WH34, WH36, 2);
    const G = await transfer(P6, WH34, WH35, 3);
    ok([A, B, C, Z, R, M, G].every((x) => x.ok && x.out && x.inn && x.inn.id === x.out.id + 1
      && Math.round(x.out.amount_rial) > 0 && Math.round(x.out.amount_rial) === Math.round(x.inn.amount_rial)),
    'fixture: 7 real transfers, in.id = out.id+1, in = out > 0');
    const amtA = Math.round(A.out.amount_rial);
    const amtB = Math.round(B.out.amount_rial);
    const amtC = Math.round(C.out.amount_rial);
    for (const x of [A, B, C, Z, R, M, G]) zeroBoth(x);
    healOut(A, P1); healOut(C, P1); healOut(B, P2); healOut(R, P4); healOut(M, P5);
    V.rebuildBuckets(db, { productId: P3x });
    V.rebuildBuckets(db, { productId: P6 });
    {
      const v = await call('POST', `/api/warehouses/moves/${R.move}/void`, {});
      ok(v.status === 200, 'fixture: leaked pair R voided before correction', v);
    }
    const jeM = q1(`SELECT COUNT(*) c FROM journal_entries`).c;
    ok(jeM >= 1, 'fixture: 34→36 transfer posted a reclass JE (different inventory accounts)', { jeM });

    const glgap = () => buildInventoryGlGapReport(db, { acct: '1104', warehouses: [34, 35], cutoff: '1499/12/29' });
    const causeA = () => (glgap().causes || {}).a_transfer_leakage || null;
    const gap0 = causeA();
    ok(gap0 && gap0.count === 4 && gap0.amount_rial === amtA + amtB + amtC + Math.round(M.out.amount_rial),
      'gl-gap before: 4 leaked pairs (A, B, C + M touching wh34) = Σ out', gap0 && { count: gap0.count, amount: gap0.amount_rial });
    const zi0 = P3.computeZeroInboundCogsShare(db, { warehouseId: 35 });
    ok(zi0.pairs === 2 && zi0.totals.restored_inbound_rial === amtA + amtC, 'p3 zero-inbound (wh35) before: 2 pairs (A, C)', zi0);
    const replay0 = V.previewReplay(db, { productId: P1 });

    console.log('— validation 400 (no read/write) —');
    const url = '/api/inventory/ledger/revalue-transfer-in';
    const cases = [
      [{}, 'E_REVALUE_CONFIRM_REQUIRED', 'empty body'],
      [{ reason: 'اصلاح نشت انتقال انبار' }, 'E_REVALUE_CONFIRM_REQUIRED', 'no confirm'],
      [{ confirm: false, reason: 'اصلاح نشت انتقال انبار' }, 'E_REVALUE_CONFIRM_REQUIRED', 'confirm=false'],
      [{ confirm: 'yes', reason: 'اصلاح نشت انتقال انبار' }, 'E_REVALUE_CONFIRM_REQUIRED', 'confirm="yes"'],
      [{ confirm: true }, 'E_REVALUE_REASON_REQUIRED', 'no reason'],
      [{ confirm: true, reason: '          ' }, 'E_REVALUE_REASON_REQUIRED', 'whitespace reason'],
      [{ confirm: true, reason: ' ۱۲۳۴۵۶۷۸۹ ' }, 'E_REVALUE_REASON_REQUIRED', 'reason 9 chars (trimmed)'],
      [{ confirm: true, reason: 'اصلاح نشت انتقال انبار', date: '1405-08-01' }, 'E_REVALUE_DATE', 'bad date'],
      [{ confirm: true, reason: 'اصلاح نشت انتقال انبار', ids: [1, 'x'] }, 'E_REVALUE_IDS', 'bad ids'],
      [{ confirm: true, reason: 'اصلاح نشت انتقال انبار', warehouse_id: -3 }, 'E_REVALUE_WAREHOUSE', 'bad warehouse'],
    ];
    for (const [body, code, label] of cases) {
      const c0 = changes();
      const r = await call('POST', url, body);
      ok(r.status === 400 && r.body && r.body.code === code && /[\u0600-\u06FF]/.test(r.body.error || '') && changes() === c0,
        `400 ${code} — ${label} (zero writes)`, r);
    }

    console.log('— permission / central-only —');
    {
      const c0 = changes();
      const r = await call('POST', url, { confirm: true, reason: 'اصلاح نشت انتقال انبار' }, CASHIER_ID);
      const p = await call('GET', '/api/inventory/ledger/revalue-transfer-in-preview', null, CASHIER_ID);
      ok(r.status === 403 && r.body.code === 'E_PERMISSION' && changes() === c0, 'cashier POST ⇒ 403 E_PERMISSION, no writes', r);
      ok(p.status === 403 && p.body.code === 'E_PERMISSION', 'cashier preview ⇒ 403 E_PERMISSION', p);
      const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'inventory.js'), 'utf8');
      ok(/revalue-transfer-in-preview', auth, revalueTransferInGate, centralOnlyStrict/.test(src)
        && /'\/ledger\/revalue-transfer-in', auth, revalueTransferInGate, centralOnlyStrict/.test(src),
      'both routes are centralOnlyStrict (403 on device builds)');
    }

    console.log('— preview (dry-run, writes=0) —');
    let pv;
    {
      const c0 = changes();
      const l0 = ledgerCount();
      const r = await call('GET', '/api/inventory/ledger/revalue-transfer-in-preview');
      pv = r.body || {};
      ok(r.status === 200 && pv.dry_run === true && pv.writes === 0 && changes() === c0 && ledgerCount() === l0, 'preview 200, dry_run, zero writes', r.status);
      const inIds = (pv.candidates || []).map((c) => c.in_id).sort((a, b) => a - b);
      ok(JSON.stringify(inIds) === JSON.stringify([A.inn.id, C.inn.id, B.inn.id].sort((a, b) => a - b)), 'candidates = A, C (→35) and B (→34)', inIds);
      ok(pv.totals && pv.totals.count === 3 && pv.totals.amount_rial === amtA + amtB + amtC, 'totals = 3 rows, Σ out', pv.totals);
      ok(pv.gl_effect_rial === 0 && pv.je === null, 'gl_effect_rial: 0, je: null');
      const ex = pv.excluded_summary || {};
      ok(ex.zero_zero === 2 && ex.reversed === 1 && ex.coa_mismatch === 1, 'excluded: zero_zero (Z + pre-heal G), reversed (R), coa_mismatch (M)', ex);
      const mEx = (pv.excluded || []).find((e) => e.in_id === M.inn.id);
      ok(mEx && mEx.from_coa === '110499' && mEx.to_coa === '110498' && /[\u0600-\u06FF]/.test(mEx.reason_fa || ''), 'COA mismatch row shows both accounts + Persian reason', mEx);
      const w35 = (pv.per_warehouse || []).find((w) => w.warehouse_id === 35);
      const w34 = (pv.per_warehouse || []).find((w) => w.warehouse_id === 34);
      ok(w35 && w35.count === 2 && w35.amount_rial === amtA + amtC && w35.kardex_before_rial === kardexWh(35).v
        && w35.kardex_after_rial === kardexWh(35).v + amtA + amtC, 'per-warehouse wh35: 2 rows, kardex before/after', w35);
      ok(w34 && w34.count === 1 && w34.amount_rial === amtB && w34.kardex_after_rial - w34.kardex_before_rial === amtB, 'per-warehouse wh34: 1 row (35→34)', w34);
      const a = (pv.candidates || []).find((c) => c.in_id === A.inn.id);
      ok(a && a.out_id === A.out.id && a.move_id === A.move && a.delta_rial === amtA && a.from_warehouse_id === 34 && a.to_warehouse_id === 35,
        'candidate A: pair (out_id, move_id), delta = out.amount', a);
      const f = await call('GET', '/api/inventory/ledger/revalue-transfer-in-preview?warehouse_id=34');
      ok(f.body && f.body.totals.count === 1 && f.body.candidates[0].in_id === B.inn.id, 'preview ?warehouse_id=34 ⇒ only B');
      const fi = await call('GET', `/api/inventory/ledger/revalue-transfer-in-preview?ids=${A.inn.id},${Z.inn.id}`);
      ok(fi.body && fi.body.totals.count === 1 && (fi.body.excluded || []).some((e) => e.in_id === Z.inn.id && e.reason === 'zero_zero'),
        'preview ?ids=A,Z ⇒ A candidate, Z excluded zero_zero');
    }

    console.log('— refusals roll back everything —');
    {
      const l0 = ledgerCount();
      const a0 = auditCount();
      const r = await call('POST', url, { confirm: true, reason: 'اصلاح نشت انتقال انبار', ids: [A.inn.id, Z.inn.id] });
      ok(r.status === 409 && r.body.code === 'E_REVALUE_ROW_NOT_ELIGIBLE' && ledgerCount() === l0 && auditCount() === a0,
        'explicit ids with a zero/zero row ⇒ 409, nothing written', r);
    }
    {
      const PL = require('../lib/inventory/period-lock');
      PL.ensurePeriodLockSchema(db);
      PL.closePeriod(db, TODAY.slice(0, 7), { id: ADMIN_ID }, { reason: 'تست قفل' });
      const l0 = ledgerCount();
      const p = await call('GET', '/api/inventory/ledger/revalue-transfer-in-preview');
      ok(p.body && p.body.blocker && p.body.blocker.code === 'E_INV_PERIOD_LOCKED' && p.body.ready === false, 'preview in closed month shows blocker', p.body && p.body.blocker);
      const r = await call('POST', url, { confirm: true, reason: 'اصلاح نشت انتقال انبار' });
      ok(r.status === 422 && r.body.code === 'E_INV_PERIOD_LOCKED' && /قفل/.test(r.body.error || '') && ledgerCount() === l0,
        'POST in closed month ⇒ 422 E_INV_PERIOD_LOCKED, nothing written', r);
      PL.reopenPeriod(db, TODAY.slice(0, 7), { id: ADMIN_ID }, { reason: 'تست قفل' });
    }
    {
      const l0 = ledgerCount();
      const b0 = JSON.stringify([bucketsOf(P1), bucketsOf(P2)]);
      const orig = L.postInventoryMovement;
      let n = 0;
      L.postInventoryMovement = function (...a) {
        n += 1;
        if (n === 2) throw Object.assign(new Error('خطای تزریقی آزمون'), { status: 500, code: 'E_TEST_INJECT' });
        return orig.apply(this, a);
      };
      let r;
      try { r = await call('POST', url, { confirm: true, reason: 'اصلاح نشت انتقال انبار' }); } finally { L.postInventoryMovement = orig; }
      ok(r.status === 500 && r.body.code === 'E_TEST_INJECT' && n === 2 && ledgerCount() === l0
        && JSON.stringify([bucketsOf(P1), bucketsOf(P2)]) === b0 && auditCount() === 0,
      'error on 2nd row ⇒ full rollback (no ledger row, buckets unchanged, no audit)', { status: r.status, n });
    }

    console.log('— POST —');
    const gl0 = glSnap();
    const k35 = kardexWh(35).v;
    const k34 = kardexWh(34).v;
    const avg1 = avgOf(P1);
    const avg2 = avgOf(P2);
    const ws0 = qa('SELECT product_id, warehouse_id, qty FROM warehouse_stock ORDER BY product_id, warehouse_id');
    let post;
    {
      const r = await call('POST', url, { confirm: true, reason: '  اصلاح نشت ورود انتقال پس از ترمیم v529  ' });
      post = r.body || {};
      ok(r.status === 200 && post.ok === true && post.created === 3, 'POST 200, 3 corrections', r);
      ok(JSON.stringify(post.rows.map((x) => [x.in_id, x.delta_rial])) === JSON.stringify(pv.candidates.map((x) => [x.in_id, x.delta_rial]))
        && JSON.stringify(post.totals) === JSON.stringify(pv.totals), 'POST rows/totals == preview rows/totals');
      ok(post.gl_effect_rial === 0 && post.je === null && post.reason === 'اصلاح نشت ورود انتقال پس از ترمیم v529', 'response: gl 0, je null, trimmed reason');
      const rows = qa(`SELECT * FROM inventory_ledger WHERE event_type='transfer_in_revalue' ORDER BY id`);
      ok(rows.length === 3 && rows.every((x) => x.qty_in === 0 && x.qty_out === 0 && x.status === 'posted' && x.je_id == null
        && x.source_type === 'warehouse_transfer' && x.reversed_of == null && x.date === TODAY), 'corrections: value-only, posted, no JE, source warehouse_transfer, dated today');
      const ra = rows.find((x) => x.source_id === A.move);
      ok(ra && ra.warehouse_id === 35 && ra.product_id === P1 && Math.round(ra.amount_rial) === amtA && ra.note.includes(`ledger#${A.inn.id}`),
        'correction A: wh35, product, amount = out, note references in-row', ra);
      const inA = q1('SELECT amount_rial, status FROM inventory_ledger WHERE id=?', A.inn.id);
      const outA = q1('SELECT amount_rial, status FROM inventory_ledger WHERE id=?', A.out.id);
      ok(Math.round(inA.amount_rial) === 0 && Math.round(outA.amount_rial) === amtA && inA.status === 'posted' && outA.status === 'posted',
        'original rows untouched (in still 0, out unchanged)');
    }
    {
      const gl1 = glSnap();
      ok(JSON.stringify(gl1) === JSON.stringify(gl0) && gl1.dr === gl1.cr, 'GL unchanged (lines/JE/Σdr=Σcr/1104)', { gl0, gl1 });
      ok(kardexWh(35).v - k35 === amtA + amtC && kardexWh(34).v - k34 === amtB, 'kardex value wh35 +A+C, wh34 +B (exact)',
        { d35: kardexWh(35).v - k35, d34: kardexWh(34).v - k34 });
      ok(avgOf(P1) === avg1 && avgOf(P2) === avg2, 'product header average unchanged', { avg1, now1: avgOf(P1), avg2, now2: avgOf(P2) });
      ok(JSON.stringify(qa('SELECT product_id, warehouse_id, qty FROM warehouse_stock ORDER BY product_id, warehouse_id')) === JSON.stringify(ws0), 'warehouse_stock unchanged');
      const b35 = bucketsOf(P1).find((b) => b.w === 35);
      ok(b35 && b35.q === 7 && b35.v === amtA + amtC, 'destination bucket wh35 (P1) value = A + C', b35);
      const inc = JSON.stringify([bucketsOf(P1), bucketsOf(P2)]);
      V.rebuildBuckets(db, { productId: P1 });
      V.rebuildBuckets(db, { productId: P2 });
      ok(JSON.stringify([bucketsOf(P1), bucketsOf(P2)]) === inc, 'buckets: incremental == rebuildBuckets replay');
      const au = qa("SELECT * FROM audit_log WHERE action='ledger_revalue_transfer_in'");
      const d = au[0] ? JSON.parse(au[0].detail) : {};
      ok(au.length === 1 && au[0].user_id === ADMIN_ID && d.reason === post.reason && d.totals.amount_rial === amtA + amtB + amtC
        && d.in_ids.length === 3 && d.correction_ids.length === 3 && d.gl_effect_rial === 0, 'one audit row: reason, ids, totals, user', au[0]);
    }

    console.log('— idempotent —');
    {
      const l0 = ledgerCount();
      const r = await call('POST', url, { confirm: true, reason: 'اجرای دوباره برای آزمون' });
      ok(r.status === 200 && r.body.created === 0 && r.body.noop === true && ledgerCount() === l0 && auditCount() === 1,
        'second POST ⇒ 0 new rows, no new audit', r.body && { created: r.body.created });
      ok((r.body.excluded_summary || {}).already_corrected === 3, 'second POST reports 3 already_corrected');
      const ri = await call('POST', url, { confirm: true, reason: 'اجرای دوباره برای آزمون', ids: [A.inn.id] });
      ok(ri.status === 200 && ri.body.created === 0 && ledgerCount() === l0, 'explicit id of a corrected row ⇒ 200, 0 rows (not an error)', ri);
      const p2 = await call('GET', '/api/inventory/ledger/revalue-transfer-in-preview');
      ok(p2.body.totals.count === 0 && p2.body.ready === false, 'preview after POST: nothing left');
    }

    console.log('— reports no longer flag corrected pairs —');
    {
      const g = causeA();
      ok(g && g.count === 1 && g.amount_rial === Math.round(M.out.amount_rial), 'gl-gap cause a: only the COA-mismatch pair M remains', g && { count: g.count, amount: g.amount_rial });
      const zi = P3.computeZeroInboundCogsShare(db, { warehouseId: 35 });
      ok(zi.pairs === 0 && zi.products.length === 0, 'p3 zero-inbound (wh35): 0 pairs', zi);
      const replay1 = V.previewReplay(db, { productId: P1 });
      const sig = (x) => JSON.stringify({ lines: x.lines.map((l) => [l.ledger_id, l.delta_rial]), rv: x.keys.map((k) => [k.warehouse_id, k.replay_value_rial, k.replay_qty]) });
      ok(sig(replay1) === sig(replay0), 'valuation replay: correction not double counted (same replay as before)', { before: sig(replay0), after: sig(replay1) });
      const k = L.getKardex(db, P1, { warehouseId: WH35 });
      ok(k && Math.round(k.value_only_rial || 0) === amtA + amtC, 'getKardex wh35 shows value_only_rial = A + C', k && k.value_only_rial);
    }

    console.log('— R13: voiding the transfer reverses the correction too —');
    {
      const corrA = q1(`SELECT * FROM inventory_ledger WHERE event_type='transfer_in_revalue' AND source_id=?`, A.move);
      const kq0 = kardexWh(35, P1);
      const avgBefore = avgOf(P1);
      const gl1 = glSnap();
      const v = await call('POST', `/api/warehouses/moves/${A.move}/void`, {});
      ok(v.status === 200, 'void transfer A 200', v);
      const c = q1('SELECT status FROM inventory_ledger WHERE id=?', corrA.id);
      const rev = q1('SELECT * FROM inventory_ledger WHERE reversed_of=?', corrA.id);
      ok(c.status === 'reversed' && rev && rev.event_type === 'reversal' && Math.round(rev.amount_rial) === -amtA && rev.qty_in === 0 && rev.qty_out === 0,
        'correction row reversed with an opposite value-only reversal', rev);
      const kq1 = kardexWh(35, P1);
      ok(kq0.v - kq1.v === amtA && kq0.q - kq1.q === 5, 'kardex wh35 (P1) drops by the corrected value and qty', { kq0, kq1 });
      ok(avgOf(P1) === avgBefore, 'void keeps the product header average (header-neutral transfer)', { avgBefore, now: avgOf(P1) });
      ok(JSON.stringify(glSnap()) === JSON.stringify(gl1), 'void: GL unchanged (same-account transfer)');
      const p3 = await call('GET', '/api/inventory/ledger/revalue-transfer-in-preview');
      ok(p3.body.totals.count === 0 && (p3.body.excluded || []).some((e) => e.in_id === A.inn.id && e.reason === 'reversed'), 'voided pair now excluded as reversed (not re-offered)');
      const g = causeA();
      ok(g && g.count === 1, 'gl-gap still clean after void (only M)', g && g.count);
    }

    console.log('— heal script —');
    const healScript = path.join(__dirname, 'heal-zero-outbound-cost-v529.js');
    const childEnv = { ...process.env };
    {
      const r = spawnSync(process.execPath, [healScript, '--apply'], { env: { ...childEnv, DB_PATH: path.join(dir, 'never.db') }, encoding: 'utf8' });
      ok(r.status === 2 && /revalue-transfer-in/.test(r.stderr || '') && !fs.existsSync(path.join(dir, 'never.db')),
        '--apply alone ⇒ refused (exit 2), points to the endpoint, DB never opened', { status: r.status, err: (r.stderr || '').slice(0, 300) });
      const r2 = spawnSync(process.execPath, [healScript, '--apply', '--revalue-transfer-in', '--reason=کوتاه'], { env: childEnv, encoding: 'utf8' });
      ok(r2.status === 2, '--apply --revalue-transfer-in without a ≥10-char reason ⇒ refused');
    }
    {
      const outFile = path.join(dir, 'heal-report.json');
      const gl1 = glSnap();
      const k35b = kardexWh(35, P6).v;
      const r = spawnSync(process.execPath, [healScript, '--apply', '--revalue-transfer-in', '--reason=ترمیم خروج صفر همراه ورود انتقال',
        `--product=${P6}`, `--out=${outFile}`], { env: childEnv, encoding: 'utf8' });
      const outG = q1('SELECT amount_rial FROM inventory_ledger WHERE id=?', G.out.id);
      const corrG = q1(`SELECT * FROM inventory_ledger WHERE event_type='transfer_in_revalue' AND source_id=? AND status='posted'`, G.move);
      ok(r.status === 0 && Math.round(outG.amount_rial) > 0, 'heal --apply --revalue-transfer-in: out leg re-priced', { status: r.status, err: (r.stderr || '').slice(0, 400) });
      ok(corrG && Math.round(corrG.amount_rial) === Math.round(outG.amount_rial) && corrG.warehouse_id === 35,
        'same run revalues the paired transfer_in through the shared lib (in + corr = out)', corrG);
      ok(kardexWh(35, P6).v - k35b === Math.round(outG.amount_rial) && JSON.stringify(glSnap()) === JSON.stringify(gl1),
        'heal: wh35 kardex + out amount, GL unchanged');
      const rep = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, 'utf8')) : {};
      ok(rep.transfer_in_revalue && rep.transfer_in_revalue.created === 1, 'heal report lists the transfer_in revalue', rep.transfer_in_revalue);
    }
  } catch (e) {
    fail += 1;
    console.log('  FAIL harness', e && e.stack);
  } finally {
    server.close();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  try { db.close(); } catch (_) { /* ignore */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  process.exit(fail ? 1 : 0);
}

main();
