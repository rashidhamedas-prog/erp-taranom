/**
 * FR-POS-DRAFTS (part B) — store quick-sale: header/line discount (% | rial) caps, price_override RBAC
 * + audit, price floor (warn|block), header-discount allocation + per-line VAT (tax-ready), COGS
 * independence, returns/exchange at net sold, thermal/A5 print, credit-limit override, stock
 * warn/block, card trace optional, payment mismatch message, UI/static gates.
 * Run: node server/scripts/test-pos-drafts-b.js   (temp DB only)
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const express = require('express');
const bcrypt = require('bcryptjs');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK', label); }
  else { fail += 1; console.log(' FAIL', label, extra == null ? '' : (typeof extra === 'string' ? extra : JSON.stringify(extra))); }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-drafts-b-'));
process.env.DB_PATH = path.join(dir, 't.db');
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-pos-drafts-b-secret-32-bytes-min!!';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');
process.env.SMS_DISABLED = '1';
process.env.ERP_TEST_ISOLATION = '1';
delete process.env.POS_INTEGRATED_STUB;
for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) delete process.env[k];

const root = path.join(__dirname, '..');
const appSrc = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');

delete require.cache[require.resolve('../db')];
const { initDB, getDB, closeDB } = require('../db');
initDB();
const db = getDB();
const { todayJalali } = require('../jalali');
const { acct } = require('../lib/coa-map');
const rbac = require('../lib/rbac');
const sqs = require('../lib/store-quick-sale');
const printLib = require('../lib/invoice-print');
const { rialToLedger } = require('../lib/money');

function leaf(code, name, type, parent) {
  db.prepare('INSERT OR IGNORE INTO chart_of_accounts (code,name,type,parent_code,level) VALUES (?,?,?,?,?)')
    .run(code, name, type || 'asset', parent || '1102', 4);
}
const sum = (arr, f) => arr.reduce((a, x) => a + (Number(f(x)) || 0), 0);

(async () => {
  let server;
  try {
    const admin = db.prepare("SELECT * FROM users WHERE username='admin'").get();
    db.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(admin.id);
    const { issueStaffSession } = require('../lib/auth-sessions');
    const tokenFor = (u, tag) => issueStaffSession(db, u, {
      device_kind: 'test', device_name: 'posb-' + tag, device_fingerprint: 'posb-fp-' + tag,
    }).token;

    // ───────── fixtures ─────────
    const cashCoa = '110101';
    leaf(cashCoa, 'صندوق POS-B', 'asset', '1101');
    const cashBoxId = db.prepare("INSERT INTO cash_boxes (name, active, coa_code) VALUES ('صندوق POS-B',1,?)").run(cashCoa).lastInsertRowid;
    leaf('110297', 'بانک POS-B', 'asset', '1102');
    const bankId = db.prepare("INSERT INTO banks (name, account_number, active, coa_code) VALUES ('بانک POS-B','0202',1,'110297')").run().lastInsertRowid;
    const whId = db.prepare(`
      INSERT INTO warehouses (code, name, warehouse_type, active, allow_negative)
      VALUES ('WH-POSB','انبار فروشگاه POS-B','finished_goods',1,0)
    `).run().lastInsertRowid;
    db.prepare('UPDATE users SET sales_warehouse_id=?, sales_cash_box_id=? WHERE id=?').run(whId, cashBoxId, admin.id);
    const adminTok = tokenFor(admin, 'admin');
    const mkUser = (username, role) => {
      const id = db.prepare(`
        INSERT INTO users (name, username, password, role, active, must_change_password, sales_warehouse_id, sales_cash_box_id)
        VALUES (?,?,?,?,1,0,?,?)
      `).run('کاربر ' + role, username, bcrypt.hashSync('PosB-test-9aZ', 10), role, whId, cashBoxId).lastInsertRowid;
      return db.prepare('SELECT id,username,role,name,phone,auth_epoch,sales_warehouse_id,sales_cash_box_id FROM users WHERE id=?').get(id);
    };
    const mgrU = mkUser('posb.mgr', 'sales_manager');
    const accU = mkUser('posb.acc', 'accounting');
    const retU = mkUser('posb.store', 'store_retail');
    const distU = mkUser('posb.dist', 'distribution_office');
    const mgrTok = tokenFor(mgrU, 'mgr');
    const accTok = tokenFor(accU, 'acc');
    const retTok = tokenFor(retU, 'ret');
    const distTok = tokenFor(distU, 'dist');

    const app = express();
    app.use(express.json({ limit: '2mb' }));
    app.use('/api/store', require('../routes/store'));
    app.use('/api/invoices', require('../routes/invoices'));
    app.use('/api/pos', require('../routes/pos'));
    app.use('/api/settings', require('../routes/settings'));
    app.use('/api/customers', require('../routes/customers'));
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const BASE = `http://127.0.0.1:${server.address().port}`;
    async function api(method, p, body, tok) {
      const res = await fetch(BASE + p, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (tok || adminTok) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch (_) { data = text; }
      return { status: res.status, data };
    }

    const arLeaf = '110301000701';
    leaf(arLeaf, 'مشتری POS-B', 'asset', '1103');
    const mkCust = (biz, coa) => {
      leaf(coa, biz, 'asset', '1103');
      return db.prepare(`
        INSERT INTO customers (user_id, biz, owner, phone, status, type, coa_code)
        VALUES (?, ?, 'مالک', '0912000070', 'active', 'خرده', ?)
      `).run(admin.id, biz, coa).lastInsertRowid;
    };
    const custId = mkCust('مشتری POS-B', arLeaf);
    const COST = 1000000;
    const mkProd = (name, price, opts) => {
      const o = opts || {};
      const pid = db.prepare(`
        INSERT INTO products (user_id, name, code, price, price_rial, retail_price, retail_price_rial, stock, vat_class, average_cost_rial, cost, warehouse_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(admin.id, name, 'SKU-' + Math.random().toString(36).slice(2, 8), price, price, price, price,
        o.stock == null ? 500 : o.stock, o.vat_class || 'exempt', COST, COST, whId).lastInsertRowid;
      db.prepare('INSERT OR REPLACE INTO warehouse_stock (warehouse_id, product_id, qty) VALUES (?,?,?)').run(whId, pid, o.stock == null ? 500 : o.stock);
      if (o.min_price_rial) db.prepare('UPDATE products SET min_price_rial=? WHERE id=?').run(o.min_price_rial, pid);
      return pid;
    };
    const P_A = 10000000;
    const P_B = 6000000;
    const P_C = 3000000;
    const prodA = mkProd('مانتو A', P_A);
    const prodB = mkProd('شلوار B', P_B);
    const prodC = mkProd('شال مشمول C', P_C, { vat_class: 'standard' });
    const prodF = mkProd('کالای کف‌دار F', P_A, { min_price_rial: 9500000 });

    const row = (pid, qty, price, extra) => Object.assign({
      product_id: pid, qty, price, unit_price: price, warehouse_id: whId,
    }, extra || {});
    let seq = 0;
    const saleBody = (rows, final, extra) => Object.assign({
      cust_id: custId, type: 'normal', date: todayJalali(), warehouse_id: whId, rows,
      client_request_id: 'posb-' + (++seq) + '-' + Math.random().toString(36).slice(2, 7),
      pay_splits: [{ method: 'cash', amount: final, cash_box_id: cashBoxId }],
    }, extra || {});
    const invRows = (id) => JSON.parse(db.prepare('SELECT rows FROM invoices WHERE id=?').get(id).rows || '[]');
    const invCount = () => db.prepare('SELECT COUNT(*) c FROM invoices').get().c;

    // ───────── schema / RBAC ─────────
    console.log('\n— schema / RBAC defaults —');
    const pcols = db.prepare('PRAGMA table_info(products)').all().map((c) => c.name);
    ok(pcols.includes('min_price_rial'), 'products.min_price_rial column (no new table)');
    const R = rbac.RESOURCES;
    ok(R.indexOf('price_override') > R.indexOf('sales_amount') && R.indexOf('credit_override') > R.indexOf('price_override'),
      'RESOURCES append-only: price_override, credit_override after sales_amount');
    const D = rbac.DEFAULT_ROLE_PERMISSIONS;
    const po = (role) => !!(D[role] && D[role].price_override && D[role].price_override.edit);
    const co = (role) => !!(D[role] && D[role].credit_override && D[role].credit_override.approve);
    ok(po('admin') && po('accounting') && po('sales_manager'), 'price_override:edit default for admin/accounting/sales_manager');
    ok(!po('store_retail') && !po('distribution_office') && !po('field_sales'), 'price_override not default for store_retail/dist/field');
    ok(co('admin') && co('sales_manager') && !co('store_retail') && !co('accounting'), 'credit_override:approve default admin + sales_manager only');
    ok(rbac.CLOSED_DEFAULT_NONE.has ? (rbac.CLOSED_DEFAULT_NONE.has('price_override') && rbac.CLOSED_DEFAULT_NONE.has('credit_override'))
      : (rbac.CLOSED_DEFAULT_NONE.includes('price_override') && rbac.CLOSED_DEFAULT_NONE.includes('credit_override')),
    'new resources are closed-by-default');
    ok(sqs.canOverrideStorePrice(db, retU) === false && sqs.canOverrideStorePrice(db, mgrU) === true
      && sqs.canOverrideStorePrice(db, admin) === true, 'canOverrideStorePrice by role');
    const bootRet = await api('GET', '/api/store/bootstrap', undefined, retTok);
    ok(bootRet.status === 200 && bootRet.data.can_override_price === false && bootRet.data.price_floor_mode === 'warn',
      'bootstrap (store_retail): can_override_price=false, price_floor_mode=warn', bootRet.data && { c: bootRet.data.can_override_price, m: bootRet.data.price_floor_mode });
    const bootMgr = await api('GET', '/api/store/bootstrap', undefined, mgrTok);
    ok(bootMgr.status === 200 && bootMgr.data.can_override_price === true, 'bootstrap (sales_manager): can_override_price=true');

    // ───────── 5/6. discount caps ─────────
    console.log('\n— 5/6. header + line discount (% | rial) caps —');
    const lineOver = await api('POST', '/api/store/quick-sale', saleBody([
      row(prodA, 1, P_A, { disc_amount: P_A + 1 }),
    ], P_A));
    ok(lineOver.status === 400 && lineOver.data.code === 'E_DISC_OVER' && /تخفیف/.test(lineOver.data.error || ''),
      'line disc_amount > qty×price → 400 E_DISC_OVER (Persian)', lineOver.data);
    const lineNeg = await api('POST', '/api/store/quick-sale', saleBody([
      row(prodA, 1, P_A, { disc_amount: -5 }),
    ], P_A));
    ok(lineNeg.status === 400 && lineNeg.data.code === 'E_DISC_RANGE', 'negative line disc_amount → 400 E_DISC_RANGE', lineNeg.data);
    const hdrOver = await api('POST', '/api/store/quick-sale', saleBody([
      row(prodA, 1, P_A, { disc_amount: 1000000 }),
    ], P_A, { disc: 0, disc_amt: 9000001 }));
    ok(hdrOver.status === 400 && hdrOver.data.code === 'E_DISC_OVER' && hdrOver.data.cap_rial === 9000000,
      'header disc_amt > Σ after line discounts → 400 E_DISC_OVER cap=9,000,000', hdrOver.data);
    const hdrNeg = await api('POST', '/api/store/quick-sale', saleBody([row(prodA, 1, P_A)], P_A, { disc: 0, disc_amt: -1 }));
    ok(hdrNeg.status === 400 && hdrNeg.data.code === 'E_DISC_RANGE', 'negative header disc_amt → 400', hdrNeg.data);
    const hdrPctBad = await api('POST', '/api/store/quick-sale', saleBody([row(prodA, 1, P_A)], P_A, { disc: 120 }));
    ok(hdrPctBad.status === 400 && hdrPctBad.data.code === 'E_DISC_RANGE', 'header % > 100 → 400 E_DISC_RANGE');
    const retHdr = await api('POST', '/api/store/quick-sale', saleBody([row(prodA, 1, P_A)], P_A - 1000, { disc: 0, disc_amt: 1000 }), retTok);
    ok(retHdr.status === 403 && retHdr.data.code === 'E_STORE_DISC_FORBIDDEN', 'store_retail header discount (rial) → 403', retHdr.data);
    ok(invCount() === 0, 'no invoice persisted by rejected discount requests');

    // S1: rial line discount on A, % line discount on B, rial header discount (odd amount)
    const H1 = 2333333;
    const sub1 = (2 * P_A - 1000000) + (P_B - P_B * 0.1);
    const final1 = sub1 - H1;
    const est = sqs.estimateSaleFinalRial([
      { qty: 2, unit_price: P_A, disc_amt: 1000000 }, { qty: 1, unit_price: P_B, disc_pct: 10 },
    ], 0, H1);
    ok(est === final1, 'estimateSaleFinalRial: line rial + line % + header rial', { est, final1 });
    const s1 = await api('POST', '/api/store/quick-sale', saleBody([
      row(prodA, 2, P_A, { disc: 0, disc_amount: 1000000, list_price_rial: P_A }),
      row(prodB, 1, P_B, { disc: 10, list_price_rial: P_B }),
    ], final1, { disc: 0, disc_amt: H1 }), mgrTok);
    ok(s1.status === 200 && Number(s1.data.final) === final1 && Number(s1.data.disc_amt) === H1,
      'rial header mode: disc=0 + disc_amt → final = Σ − disc_amt', s1.data && { st: s1.status, f: s1.data.final, e: s1.data.error });
    const s1Id = s1.data && s1.data.id;

    // ───────── 8. allocation + tax-ready lines ─────────
    console.log('\n— 8. header-discount allocation (Σ exact, remainder on last line) —');
    const r1 = s1Id ? invRows(s1Id) : [];
    ok(r1.length === 2 && sum(r1, (r) => r.hdr_disc_share_rial) === H1, 'Σ hdr_disc_share_rial == header discount', r1.map((r) => r.hdr_disc_share_rial));
    const expA = Math.round(H1 * (2 * P_A - 1000000) / sub1);
    ok(r1[0] && r1[0].hdr_disc_share_rial === expA && r1[1].hdr_disc_share_rial === H1 - expA,
      'proportional by line net; remainder on last line', { a: r1[0] && r1[0].hdr_disc_share_rial, expA });
    ok(r1[0] && r1[0].line_disc_rial === 1000000 && r1[1].line_disc_rial === 600000, 'line_disc_rial (rial + %)');
    ok(r1.every((r) => r.gross_rial === Math.round(r.qty * r.price) && r.net_after_disc_rial === r.gross_rial - r.line_disc_rial - r.hdr_disc_share_rial),
      'gross/net_after_disc consistent per line');
    ok(sum(r1, (r) => r.line_total_rial) === final1 && r1.every((r) => r.line_vat_rial === 0), 'exempt lines: VAT 0; Σ line_total == final');

    db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('vat_rate','10')").run();
    const H2 = 1000001;
    const sub2 = 3 * P_C + P_A;
    const net2 = sub2 - H2;
    const taxBase2 = Math.round(3 * P_C * (1 - H2 / sub2));
    const vat2 = Math.round(taxBase2 * 10 / 100);
    const s2 = await api('POST', '/api/store/quick-sale', saleBody([
      row(prodC, 3, P_C), row(prodA, 1, P_A),
    ], net2 + vat2, { disc: 0, disc_amt: H2, vat_exempt: 0 }));
    ok(s2.status === 200 && Number(s2.data.vat_amount) === vat2 && Number(s2.data.final) === net2 + vat2,
      'VAT after discount on taxable lines (doc totals unchanged)', s2.data && { st: s2.status, vat: s2.data.vat_amount, f: s2.data.final, e: s2.data.error });
    const r2 = s2.data && s2.data.id ? invRows(s2.data.id) : [];
    ok(sum(r2, (r) => r.hdr_disc_share_rial) === H2, 'Σ shares == header discount (VAT invoice)');
    ok(sum(r2, (r) => r.line_vat_rial) === vat2, 'Σ line_vat_rial == vat_amount', r2.map((r) => r.line_vat_rial));
    ok(r2[1] && r2[1].line_vat_rial === 0 && r2[0].line_vat_rate === 10, 'exempt line VAT 0; taxable line rate 10');
    ok(sum(r2, (r) => r.line_total_rial) === net2 + vat2, 'Σ line_total_rial == final');
    db.prepare("DELETE FROM settings WHERE key='vat_rate'").run();

    // COGS from kardex/average cost, independent of discount
    console.log('\n— 8. COGS unaffected by discount —');
    const cogsCode = acct(db, 'coa_cogs').code;
    const cogsOf = (invId) => Math.round(Number(db.prepare(`
      SELECT COALESCE(SUM(jl.debit),0) - COALESCE(SUM(jl.credit),0) v FROM journal_lines jl
      JOIN journal_entries je ON je.id=jl.entry_id
      WHERE je.ref_id=? AND je.ref_type LIKE 'invoice%' AND COALESCE(je.deleted_at,0)=0
        AND (jl.account_code=? OR jl.account_code LIKE ?)
    `).get(invId, cogsCode, cogsCode + '%').v) || 0);
    const plain = await api('POST', '/api/store/quick-sale', saleBody([row(prodA, 2, P_A), row(prodB, 1, P_B)], 2 * P_A + P_B));
    ok(plain.status === 200, 'undiscounted twin sale 200', plain.data && plain.data.error);
    const cogsDisc = s1Id ? cogsOf(s1Id) : -1;
    const cogsPlain = plain.data && plain.data.id ? cogsOf(plain.data.id) : -2;
    ok(cogsDisc > 0 && cogsDisc === cogsPlain, 'COGS(discounted) == COGS(undiscounted) > 0', { cogsDisc, cogsPlain });
    ok(cogsDisc === Math.round(rialToLedger(3 * COST)), 'COGS == Σ qty × kardex average cost (3 × 1,000,000 ریال, ledger units)', cogsDisc);

    // ───────── 7. price override ─────────
    console.log('\n— 7. price_override RBAC + audit —');
    const OVR = 9000000;
    const n0 = invCount();
    const retOvr = await api('POST', '/api/store/quick-sale', saleBody([row(prodA, 1, OVR)], OVR), retTok);
    ok(retOvr.status === 403 && retOvr.data.code === 'E_PRICE_OVERRIDE_FORBIDDEN' && /قیمت/.test(retOvr.data.error || ''),
      'store_retail price ≠ list → 403 E_PRICE_OVERRIDE_FORBIDDEN (Persian)', retOvr.data);
    const distOvr = await api('POST', '/api/store/quick-sale', saleBody([row(prodA, 1, OVR)], OVR), distTok);
    ok(distOvr.status === 403 && distOvr.data.code === 'E_PRICE_OVERRIDE_FORBIDDEN', 'distribution_office price ≠ list → 403', distOvr.data);
    ok(invCount() === n0, 'nothing persisted on forbidden override');
    const retList = await api('POST', '/api/store/quick-sale', saleBody([row(prodA, 1, P_A)], P_A), retTok);
    ok(retList.status === 200, 'store_retail at list price → 200', retList.data && retList.data.error);
    const retListRow = retList.data && retList.data.id ? invRows(retList.data.id)[0] : null;
    ok(retListRow && retListRow.list_price_rial === P_A && Number(retListRow.price_overridden) === 0, 'list sale: list_price_rial stored, price_overridden=0', retListRow);
    const retLineDisc = await api('POST', '/api/store/quick-sale', saleBody([row(prodA, 1, P_A, { disc: 20 })], P_A), retTok);
    ok(retLineDisc.status === 200 && Number(retLineDisc.data.final) === P_A, 'store_retail line discount ignored (no discount right)', retLineDisc.data && retLineDisc.data.final);

    const mgrOvr = await api('POST', '/api/store/quick-sale', saleBody([row(prodA, 1, OVR)], OVR), mgrTok);
    ok(mgrOvr.status === 200 && Number(mgrOvr.data.final) === OVR, 'sales_manager override → 200 at 9,000,000', mgrOvr.data && mgrOvr.data.error);
    const ovrId = mgrOvr.data && mgrOvr.data.id;
    const ovrRow = ovrId ? invRows(ovrId)[0] : null;
    ok(ovrRow && ovrRow.list_price_rial === P_A && Number(ovrRow.price_overridden) === 1 && ovrRow.price === OVR,
      'row stores list_price_rial + price_overridden=1', ovrRow);
    const aud = ovrId ? db.prepare("SELECT * FROM audit_log WHERE action='price_override' AND entity_id=?").get(ovrId) : null;
    const audD = aud ? JSON.parse(aud.detail || '{}') : {};
    ok(aud && aud.user_id === mgrU.id && audD.before_price_rial === P_A && audD.after_price_rial === OVR,
      'audit_log price_override {before, after, user}', aud);
    const accOvr = await api('POST', '/api/store/quick-sale', saleBody([row(prodB, 1, 5500000)], 5500000), accTok);
    ok(accOvr.status === 200, 'accounting override allowed', accOvr.data && accOvr.data.error);
    const admOvr = await api('POST', '/api/store/quick-sale', saleBody([row(prodB, 1, 5800000)], 5800000));
    ok(admOvr.status === 200, 'admin override allowed', admOvr.data && admOvr.data.error);

    // floor
    console.log('\n— 7. price floor (min_price_rial / cost) warn | block —');
    ok(sqs.getPriceFloorMode(db) === 'warn', 'default store_price_floor_mode = warn');
    const fMin = await api('POST', '/api/store/quick-sale', saleBody([row(prodF, 1, 9000000)], 9000000), mgrTok);
    const wMin = fMin.data && Array.isArray(fMin.data.warnings) ? fMin.data.warnings.find((w) => w.code === 'W_PRICE_BELOW_MIN') : null;
    ok(fMin.status === 200 && wMin && /حداقل/.test(wMin.message || ''), 'warn: below min_price_rial → 200 + W_PRICE_BELOW_MIN', fMin.data && (fMin.data.warnings || fMin.data.error));
    const fCost = await api('POST', '/api/store/quick-sale', saleBody([row(prodB, 1, 900000)], 900000), mgrTok);
    const wCost = fCost.data && Array.isArray(fCost.data.warnings) ? fCost.data.warnings.find((w) => w.code === 'W_PRICE_BELOW_COST') : null;
    ok(fCost.status === 200 && wCost, 'warn: below cost → W_PRICE_BELOW_COST', fCost.data && (fCost.data.warnings || fCost.data.error));
    ok(wCost && wCost.cost_rial == null && !String(wCost.message || '').includes('1,000,000') && !/۱٬?۰۰۰٬?۰۰۰/.test(String(wCost.message || '')),
      'cost figure hidden without cost_visibility:view (sales_manager)', wCost);
    const fCostAdm = await api('POST', '/api/store/quick-sale', saleBody([row(prodB, 1, 900000)], 900000));
    const wCostAdm = fCostAdm.data && Array.isArray(fCostAdm.data.warnings) ? fCostAdm.data.warnings.find((w) => w.code === 'W_PRICE_BELOW_COST') : null;
    ok(wCostAdm && wCostAdm.cost_rial === COST, 'cost figure shown with cost_visibility (admin)', wCostAdm);
    const setFloorMgr = await api('PUT', '/api/settings', { store_price_floor_mode: 'block' }, mgrTok);
    ok(setFloorMgr.status === 403, 'sales_manager cannot set store_price_floor_mode (admin setting)', setFloorMgr.status);
    const setFloorBad = await api('PUT', '/api/settings', { store_price_floor_mode: 'maybe' });
    ok(setFloorBad.status === 400 && setFloorBad.data.code === 'E_STORE_PRICE_FLOOR_MODE', 'invalid floor mode → 400', setFloorBad.data);
    const setFloor = await api('PUT', '/api/settings', { store_price_floor_mode: 'block' });
    ok(setFloor.status === 200 && sqs.getPriceFloorMode(db) === 'block', 'admin sets store_price_floor_mode=block');
    const n1 = invCount();
    const fBlock = await api('POST', '/api/store/quick-sale', saleBody([row(prodF, 1, 9000000)], 9000000), mgrTok);
    ok(fBlock.status === 422 && fBlock.data.code === 'E_PRICE_BELOW_FLOOR' && /کف|حداقل/.test(fBlock.data.error || ''),
      'block: overridden line below floor → 422 E_PRICE_BELOW_FLOOR', fBlock.data);
    ok(invCount() === n1, 'block: nothing persisted');
    const fBlockDisc = await api('POST', '/api/store/quick-sale', saleBody([row(prodF, 1, P_A, { disc: 10 })], 9000000), mgrTok);
    ok(fBlockDisc.status === 422 && fBlockDisc.data.code === 'E_PRICE_BELOW_FLOOR', 'block: line discount pushing below min → 422', fBlockDisc.data);
    const fBlockOk = await api('POST', '/api/store/quick-sale', saleBody([row(prodF, 1, P_A)], P_A), mgrTok);
    ok(fBlockOk.status === 200, 'block: unchanged list price passes', fBlockOk.data && fBlockOk.data.error);
    await api('PUT', '/api/settings', { store_price_floor_mode: 'warn' });

    // ───────── 9. returns / exchange at net sold ─────────
    console.log('\n— 9. quick-return / quick-exchange = net sold —');
    const netUnitA = (2 * P_A - 1000000 - expA) / 2;
    const avail = s1Id ? await api('GET', '/api/store/exchange-available/' + s1Id + '?cust_id=' + custId, undefined, mgrTok) : { status: 0 };
    const availA = avail.data && Array.isArray(avail.data.rows) ? avail.data.rows.find((r) => Number(r.product_id) === prodA) : null;
    ok(availA && Number(availA.net_unit_final) === netUnitA, 'exchange-available exposes net_unit_final (line + header share)', availA && { n: availA.net_unit_final, netUnitA });
    const qr = s1Id ? await api('POST', '/api/store/quick-return', {
      cust_id: custId, invoice_id: s1Id, warehouse_id: whId, refund_cash_box_id: cashBoxId,
      return_rows: [{ product_id: prodA, qty: 1, warehouse_id: whId }],
      client_request_id: 'posb-qr-1',
    }, mgrTok) : { status: 0, data: {} };
    ok(qr.status === 200 && Number(qr.data.return_gross) === netUnitA && Number(qr.data.refund_rial) === netUnitA,
      'quick-return (discounted invoice): refund = net sold (not list)', qr.data && { st: qr.status, g: qr.data.return_gross, e: qr.data.error, netUnitA });
    const qx = s1Id ? await api('POST', '/api/store/quick-exchange', {
      cust_id: custId, invoice_id: s1Id, warehouse_id: whId, refund_cash_box_id: cashBoxId,
      return_rows: [{ product_id: prodA, qty: 1, warehouse_id: whId }],
      sale: { rows: [row(prodB, 1, P_B)], warehouse_id: whId, pay_type: 'cash', cash_box_id: cashBoxId, type: 'normal', client_request_id: 'posb-qx-1' },
      client_request_id: 'posb-qx-1',
    }, mgrTok) : { status: 0, data: {} };
    const lastUnit = (2 * P_A - 1000000 - expA) - netUnitA;
    ok(qx.status === 200 && Number(qx.data.return_gross) === lastUnit && qx.data.settlement_case === 'refund'
      && Number(qx.data.refund_rial) === lastUnit - P_B,
    'quick-exchange (discounted invoice): credit = net sold of last unit; refund diff', qx.data && { st: qx.status, g: qx.data.return_gross, c: qx.data.settlement_case, r: qx.data.refund_rial, e: qx.data.error, lastUnit });
    ok(Number(qr.data && qr.data.return_gross) + Number(qx.data && qx.data.return_gross) === 2 * P_A - 1000000 - expA,
      'Σ returned A == A net sold exactly (remainder lands on last slice)');
    const qrOvr = ovrId ? await api('POST', '/api/store/quick-return', {
      cust_id: custId, invoice_id: ovrId, warehouse_id: whId, refund_cash_box_id: cashBoxId,
      return_rows: [{ product_id: prodA, qty: 1, warehouse_id: whId }],
    }, mgrTok) : { status: 0, data: {} };
    ok(qrOvr.status === 200 && Number(qrOvr.data.return_gross) === OVR, 'quick-return (overridden price): refund = applied 9,000,000 not list 10,000,000', qrOvr.data);
    const ovr2 = await api('POST', '/api/store/quick-sale', saleBody([row(prodA, 1, OVR)], OVR), mgrTok);
    const qxOvr = ovr2.data && ovr2.data.id ? await api('POST', '/api/store/quick-exchange', {
      cust_id: custId, invoice_id: ovr2.data.id, warehouse_id: whId, refund_cash_box_id: cashBoxId,
      return_rows: [{ product_id: prodA, qty: 1, warehouse_id: whId }],
      sale: { rows: [row(prodA, 1, P_A)], warehouse_id: whId, pay_type: 'cash', cash_box_id: cashBoxId, type: 'normal',
        pay_splits: [{ method: 'cash', amount: P_A, cash_box_id: cashBoxId }], client_request_id: 'posb-qx-2' },
      client_request_id: 'posb-qx-2',
    }, mgrTok) : { status: 0, data: {} };
    ok(qxOvr.status === 200 && Number(qxOvr.data.return_gross) === OVR && qxOvr.data.settlement_case === 'collect'
      && Number(qxOvr.data.net_collect) === P_A - OVR,
    'quick-exchange (overridden price): collect = list − applied', qxOvr.data && { st: qxOvr.status, g: qxOvr.data.return_gross, n: qxOvr.data.net_collect, e: qxOvr.data.error });

    // ───────── 10. print ─────────
    console.log('\n— 10. thermal / A5 print —');
    const pl = printLib._posDrafts;
    ok(pl.discCellHtml({ qty: 2, price: P_A, disc: 0, disc_amount: 1000000 }).indexOf('٪') < 0, 'rial-mode line discount: no «٪»');
    ok(pl.discCellHtml({ qty: 1, price: P_B, disc: 10 }).includes('٪'), 'percent-mode line discount: shows «٪»');
    ok(pl.priceCellHtml({ price: OVR, list_price_rial: P_A }).includes('list-price'), 'price cell: struck list price + applied');
    ok(pl.priceCellHtml({ price: P_A, list_price_rial: P_A }).indexOf('list-price') < 0, 'price cell: no list price when unchanged');
    ok(pl.thermalPriceLine({ price: OVR, list_price_rial: P_A }).includes('فهرست'), 'thermal line: «فهرست» + «فی»');
    const fa = (n) => printLib.faNum(n);
    const thermal = ovrId ? await api('GET', '/api/invoices/' + ovrId + '/print?paper=THERMAL') : { data: '' };
    ok(typeof thermal.data === 'string' && thermal.data.includes('list-price') && thermal.data.includes(fa(P_A)) && thermal.data.includes(fa(OVR)),
      'thermal (overridden): list + applied price', typeof thermal.data === 'string' ? thermal.data.length : thermal.data);
    const a5 = s1Id ? await api('GET', '/api/invoices/' + s1Id + '/print?paper=A5&template=formal-official') : { data: '' };
    const a5s = typeof a5.data === 'string' ? a5.data : '';
    ok(a5s.includes(fa(1000000)) && a5s.includes(fa(600000)) && a5s.includes('(' + fa(10) + '٪)'),
      'A5: per-line discount in rial (+ ٪ only for the % line)');
    ok(a5s.includes(fa(H1)), 'A5: header discount amount');
    ok(a5s.includes(fa(final1)), 'A5: payable');
    const th1 = s1Id ? await api('GET', '/api/invoices/' + s1Id + '/print?paper=THERMAL') : { data: '' };
    const th1s = typeof th1.data === 'string' ? th1.data : '';
    ok(th1s.includes(fa(H1)) && th1s.includes(fa(final1)), 'thermal: header discount + payable');
    const s2Id = s2.data && s2.data.id;
    const thVat = s2Id ? await api('GET', '/api/invoices/' + s2Id + '/print?paper=THERMAL') : { data: '' };
    ok(typeof thVat.data === 'string' && thVat.data.includes(fa(vat2)), 'thermal: VAT amount');

    // ───────── 11. credit limit + override ─────────
    console.log('\n— 11. credit limit + manager override —');
    const cLim = mkCust('مشتری سقف POS-B', '110301000702');
    const setLim = await api('PUT', `/api/customers/${cLim}/credit-limit`, { credit_limit_rial: 1000000 }, mgrTok);
    ok(setLim.status === 200, 'ceiling 1,000,000 set');
    const creditBody = (extra) => saleBody([row(prodB, 1, P_B)], P_B, Object.assign({
      cust_id: cLim,
      pay_splits: [{ method: 'cash', amount: P_B - 3000000, cash_box_id: cashBoxId }, { method: 'credit', amount: 3000000 }],
    }, extra || {}));
    const over = await api('POST', '/api/store/quick-sale', creditBody(), accTok);
    ok(over.status === 422 && over.data.code === 'E_CREDIT_LIMIT' && over.data.can_override === false,
      'over ceiling (accounting, no credit_override) → 422, can_override=false', over.data);
    const overFlagNoPerm = await api('POST', '/api/store/quick-sale', creditBody({ credit_limit_override: true }), accTok);
    ok(overFlagNoPerm.status === 422 && overFlagNoPerm.data.code === 'E_CREDIT_LIMIT', 'override flag without permission still 422');
    const overMgr = await api('POST', '/api/store/quick-sale', creditBody(), mgrTok);
    ok(overMgr.status === 422 && overMgr.data.can_override === true, 'manager without explicit flag → 422 + can_override=true (never silent)', overMgr.data);
    const ovMgr = await api('POST', '/api/store/quick-sale', creditBody({ credit_limit_override: true }), mgrTok);
    ok(ovMgr.status === 200 && ovMgr.data.credit_limit_override && ovMgr.data.credit_limit_override.customer_id === cLim,
      'manager + credit_limit_override → 200', ovMgr.data && (ovMgr.data.error || ovMgr.data.credit_limit_override));
    const audC = ovMgr.data && ovMgr.data.id ? db.prepare("SELECT * FROM audit_log WHERE action='credit_limit_override' AND entity_id=?").get(ovMgr.data.id) : null;
    ok(audC && audC.user_id === mgrU.id, 'credit_limit_override audited', audC);

    // walk-in
    const walkinId = sqs.ensureWalkinCustomer(db);
    const wCredit = await api('POST', '/api/store/quick-sale', saleBody([row(prodB, 1, P_B)], P_B, {
      cust_id: walkinId, pay_splits: [{ method: 'credit', amount: P_B }],
    }), retTok);
    ok(wCredit.status >= 400 && /نسیه|مشتری/.test(wCredit.data.error || ''), 'walk-in credit rejected server-side', wCredit.data);

    // ───────── 12. stock warn/block, card trace optional, payment mismatch ─────────
    console.log('\n— 12. stock warn/block · card · payment mismatch —');
    const low = mkProd('کالای کم POS-B', P_B, { stock: 1 });
    const lw = await api('POST', '/api/store/quick-sale', saleBody([row(low, 3, P_B)], 3 * P_B), mgrTok);
    ok(lw.status === 200 && (lw.data.warnings || []).some((w) => w.code === 'W_STORE_INSUFFICIENT_STOCK'), 'stock default warn → 200 + warning', lw.data && (lw.data.warnings || lw.data.error));
    await api('PUT', '/api/settings', { store_insufficient_stock_mode: 'block' }, mgrTok);
    const low2 = mkProd('کالای کم ۲ POS-B', P_B, { stock: 1 });
    const lb = await api('POST', '/api/store/quick-sale', saleBody([row(low2, 3, P_B)], 3 * P_B), mgrTok);
    ok(lb.status === 422 && lb.data.code === 'E_STORE_INSUFFICIENT_STOCK', 'stock block → 422', lb.data);
    await api('PUT', '/api/settings', { store_insufficient_stock_mode: 'warn' });

    const tMan = await api('POST', '/api/pos/terminals', { name: 'دستی POS-B', terminal_id: 'POSB-M', bank_id: bankId, mode: 'manual' });
    const tInt = await api('POST', '/api/pos/terminals', { name: 'یکپارچه POS-B', terminal_id: 'POSB-I', bank_id: bankId, mode: 'integrated' });
    ok(tMan.status === 200 && tInt.status === 200, 'manual + integrated terminals defined', [tMan.data, tInt.data]);
    const cardNoTrace = await api('POST', '/api/store/quick-sale', saleBody([row(prodB, 1, P_B)], P_B, {
      pay_splits: [{ method: 'card', amount: P_B, terminal_id: tMan.data.id }],
    }), retTok);
    ok(cardNoTrace.status === 200, 'manual card without trace number → 200 (trace optional)', cardNoTrace.data && cardNoTrace.data.error);
    const cardInt = await api('POST', '/api/store/quick-sale', saleBody([row(prodB, 1, P_B)], P_B, {
      pay_splits: [{ method: 'card', amount: P_B, terminal_id: tInt.data.id, trace: 'RRN-1' }],
    }), retTok);
    ok(cardInt.status === 200, 'integrated terminal card sale → 200', cardInt.data && cardInt.data.error);
    const mism = await api('POST', '/api/store/quick-sale', saleBody([row(prodB, 1, P_B)], P_B - 1000, {
      pay_splits: [{ method: 'card', amount: P_B - 1000, terminal_id: tMan.data.id }],
    }), retTok);
    ok(mism.status === 400 && mism.data.code === 'E_STORE_TOTAL_MISMATCH' && /کم است/.test(mism.data.error || '')
      && mism.data.paid === P_B - 1000 && mism.data.final === P_B,
    'payment Σ ≠ payable → 400 E_STORE_TOTAL_MISMATCH, clear Persian + paid/final', mism.data);

    // ───────── static UI / help gates ─────────
    console.log('\n— UI / help (static) —');
    ok(appSrc.includes("function storeQsToggleHdrDiscMode") && appSrc.includes('function storeQsToggleLineDiscMode'), 'UI: %/ریال toggles (header + line)');
    ok(/if\(e\.key==='F6'\)[\s\S]{0,260}storeQsToggleHdrDiscMode\(\)/.test(appSrc), 'UI: F6 focus, F6 again toggles mode');
    ok(/e\.code==='KeyN'[\s\S]{0,80}storeQsNewInvoiceClick/.test(appSrc), 'UI: Alt+N new invoice');
    ok(appSrc.includes('<kbd class="pos-kbd">Alt+N</kbd>') && appSrc.includes('F6 دوباره = تغییر ٪ ↔ ریال'), '? panel documents F6 toggle + Alt+N');
    ['F2', 'F4', 'F6', 'F9', 'F10'].forEach((k) => ok(appSrc.includes('<kbd class="pos-kbd">' + k + '</kbd></li>') || appSrc.includes('<kbd class="pos-kbd">' + k + '</kbd> /'), '? panel lists ' + k));
    ok(appSrc.includes("'۰ ریال'") && appSrc.includes("storeQsEmptySaleCart()?'—'"), 'UI: zero → «۰ ریال», empty cart → «—»');
    ok(appSrc.includes('readonly aria-readonly="true"') && appSrc.includes('storeQsCanOverridePrice()'), 'UI: price read-only without price_override');
    ok(/aria-disabled="true" aria-describedby="posTenderCustHint" disabled/.test(appSrc), 'UI: credit/cheque disabled for walk-in');
    ok(appSrc.includes('disc_amt:_storeQs.discMode===\'rial\'?storeQsHeaderDiscRial():undefined'), 'UI: rial header mode sends disc_amt (disc=0)');
    ok(appSrc.includes('credit_limit_override:true') && appSrc.includes('p1.can_override'), 'UI: explicit credit override confirm');
    ok(appSrc.includes('net_unit_final'), 'UI: return lines use net_unit_final');
    ok(appSrc.includes("storeQsCanSalesAmt()?' — '+fmt(") && appSrc.includes('function storeQsCanSeeCost'), 'UI: sales amount / cost gated in POS');
    ok(appSrc.includes("price_override:'تغییر قیمت فروش (POS)") && appSrc.includes("credit_override:'عبور از سقف اعتبار"), 'RBAC matrix labels');
    ok(appSrc.includes('FR-POS-DRAFTS (تخفیف)') && appSrc.includes('store_price_floor_mode') && appSrc.includes('E_PRICE_OVERRIDE_FORBIDDEN'), 'admin help updated');
    ok(appSrc.includes('<b>تخفیف و قیمت:</b>'), 'store/sales help updated');
    try { new Function(appSrc); ok(true, 'app.js parses'); } catch (e) { ok(false, 'app.js parses', e.message); }
  } catch (e) {
    ok(false, 'suite threw', e && (e.stack || e.message));
  } finally {
    try { if (server) server.close(); } catch (_) { /* */ }
    try { require('../lib/auth-sessions').closeSessionStore(); } catch (_) { /* */ }
    try { closeDB(); } catch (_) { /* */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* */ }
    console.log('\nFR-POS-DRAFTS (B): ' + (fail ? '❌ ' : '✅ ') + pass + ' پاس، ' + fail + ' رد');
    process.exit(fail ? 1 : 0);
  }
})();
