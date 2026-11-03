'use strict';
/**
 * Phase 2 — multi-WH COGS, negative override, slip sections, report CLI.
 * Run: node server/scripts/test-sales-cross-warehouse-posting.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const http = require('http');
const express = require('express');

const NODE = process.env.NODE_TEST_BIN
  || (process.platform === 'win32'
    ? 'D:\\proje\\erp-taranom1\\.tmp-node20\\node-v20.19.5-win-x64\\node.exe'
    : process.execPath);

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK  ', label); }
  else { fail += 1; console.log('  FAIL', label, extra == null ? '' : extra); }
}

console.log('\n══ sales cross-warehouse Phase 2 posting ══\n');

  // report CLI
{
  const reportScript = path.join(__dirname, 'report-cross-warehouse-sales.js');
  const noDb = spawnSync(NODE, [reportScript], { encoding: 'utf8' });
  ok(noDb.status === 2, 'report exits 2 without --db', noDb.status);
}

// slip sections (mock db)
{
  const { buildSalesInvoiceSlip } = require('../lib/warehouse-slip-print');
  const whNames = { 34: 'انبار محصول', 35: 'انبار کیمیا' };
  const slipDb = {
    prepare(sql) {
      return {
        get(id) {
          if (/warehouses/i.test(sql)) return whNames[id] ? { name: whNames[id] } : null;
          return null;
        },
        all() { return []; },
      };
    },
  };
  const html = buildSalesInvoiceSlip(slipDb, {
    num: 'T-XWH-2', date: '1405/08/05', type: 'normal', warehouse_id: 34,
    cust_biz: 'مشتری', seller_name: 'تست',
  }, [
    { product_id: 1, name: 'کالا الف', qty: 2, unit: 'عدد', warehouse_id: 34 },
    { product_id: 2, name: 'کالا ب', qty: 1, unit: 'عدد', warehouse_id: 35 },
  ], { company_name: 'ترنم' }, 'A4');
  ok(/wh-section-title/.test(html) && /انبار محصول/.test(html) && /انبار کیمیا/.test(html),
    'slip HTML has two warehouse section titles');
  ok(/page-break-before|wh-section-break/.test(html), 'slip multi-WH page-break CSS');
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sales-xwh-p2-'));
process.env.DB_PATH = path.join(dir, 'xwh-p2.db');
process.env.SYNC_ROLE = 'central';
process.env.ERP_TEST_ISOLATION = '1';
process.env.SMS_DISABLED = '1';
process.env.JWT_SECRET = 'sales-cross-warehouse-p2-test-secret-32chars!!';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');
delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;

const dbMods = require('../db');
dbMods.initDB();
const db = dbMods.getDB();
const { RESOURCES, hasPermission } = require('../lib/rbac');
const { issueStaffSession } = require('../lib/auth-sessions');
const { todayJalali } = require('../jalali');

ok(RESOURCES.includes('inventory_negative'), 'RESOURCES has inventory_negative');
ok(RESOURCES[RESOURCES.length - 1] === 'inventory_negative'
  || RESOURCES.indexOf('inventory_negative') > RESOURCES.indexOf('sales_cross_warehouse'),
  'inventory_negative append-only after sales_cross_warehouse');

async function main() {
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

  // Ensure distinct inventory COAs for two FG warehouses
  try {
    db.prepare("INSERT OR IGNORE INTO chart_of_accounts (code,name,type,is_active) VALUES ('1104','موجودی محصول','asset',1)").run();
    db.prepare("INSERT OR IGNORE INTO chart_of_accounts (code,name,type,is_active) VALUES ('1104K','موجودی کیمیا','asset',1)").run();
    db.prepare("INSERT OR IGNORE INTO chart_of_accounts (code,name,type,is_active) VALUES ('5101','بهای تمام‌شده','expense',1)").run();
  } catch (_) {}

  const adminId = insert('users', { name: 'مدیر', username: 'xwh2_admin', password: 'x', role: 'admin', active: 1, must_change_password: 0 });
  const acctId = insert('users', { name: 'حسابدار', username: 'xwh2_acct', password: 'x', role: 'accounting', active: 1, must_change_password: 0 });
  db.prepare('INSERT OR REPLACE INTO user_permissions (user_id,resource,action,allowed) VALUES (?,?,?,1)')
    .run(acctId, 'sales_cross_warehouse', 'create');

  const whA = insert('warehouses', {
    name: 'انبار محصول', code: 'FG-A', active: 1, allow_negative: 0, is_default: 1,
    warehouse_type: 'finished_goods', inventory_system: 'perpetual', inventory_coa_code: '1104',
  });
  const whB = insert('warehouses', {
    name: 'انبار کیمیا', code: 'FG-B', active: 1, allow_negative: 0,
    warehouse_type: 'finished_goods', inventory_system: 'perpetual', inventory_coa_code: '1104K',
  });
  try {
    db.prepare('UPDATE warehouses SET inventory_coa_code=? WHERE id=?').run('1104', whA);
    db.prepare('UPDATE warehouses SET inventory_coa_code=? WHERE id=?').run('1104K', whB);
  } catch (_) {}

  const custId = insert('customers', { user_id: adminId, biz: 'مشتری P2', owner: 'تست', city: 'مشهد', phone: '09121112233', status: 'active' });
  const prodA = insert('products', {
    user_id: adminId, name: 'کالای A', code: 'PA', price: 100000, cost: 40000,
    average_cost_rial: 40000, stock: 0, warehouse_id: whA, unit: 'عدد',
  });
  const prodB = insert('products', {
    user_id: adminId, name: 'کالای B', code: 'PB', price: 80000, cost: 30000,
    average_cost_rial: 30000, stock: 0, warehouse_id: whB, unit: 'عدد',
  });
  try {
    db.prepare('UPDATE products SET average_cost_rial=? WHERE id=?').run(40000, prodA);
    db.prepare('UPDATE products SET average_cost_rial=? WHERE id=?').run(30000, prodB);
  } catch (_) {}
  // Stock single source: stock enters as ledger receipt documents (warehouse_stock is a derived cache).
  const { seedStock, setStock } = require('./lib/stock-fixture');
  seedStock(db, { productId: prodA, warehouseId: whA, qty: 10, unitCostRial: 40000 });
  seedStock(db, { productId: prodB, warehouseId: whB, qty: 10, unitCostRial: 30000 });

  const tok = {};
  for (const [k, uid] of [['admin', adminId], ['acct', acctId]]) {
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(uid);
    tok[k] = issueStaffSession(db, u, { device_kind: 'test', device_name: 'p2-' + k, device_fingerprint: 'p2-' + k }).token;
  }

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/invoices', require('../routes/invoices'));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const BASE = `http://127.0.0.1:${server.address().port}`;
  let idem = 0;
  const key = (t) => `p2-${t}-${Date.now()}-${++idem}`;
  async function api(method, p, body, who) {
    const res = await fetch(BASE + p, {
      method,
      headers: { Authorization: 'Bearer ' + tok[who], 'Content-Type': 'application/json' },
      body: body == null ? undefined : JSON.stringify(body),
    });
    let data = null;
    try { data = await res.json(); } catch (_) { data = null; }
    return { status: res.status, data };
  }

  const today = todayJalali();
  const firm = await api('POST', '/api/invoices', {
    cust_id: custId, type: 'normal', date: today, warehouse_id: whA, pay_type: 'credit', vat_exempt: 1,
    client_request_id: key('firm'),
    rows: [
      { product_id: prodA, name: 'کالای A', qty: 2, price: 100000, warehouse_id: whA },
      { product_id: prodB, name: 'کالای B', qty: 1, price: 80000, warehouse_id: whB },
    ],
  }, 'acct');
  ok(firm.status === 200 && firm.data && firm.data.id, 'multi-WH firm create 200', firm);

  if (firm.status === 200) {
    const invId = firm.data.id;
    const je = db.prepare("SELECT id FROM journal_entries WHERE ref_type='invoice_cogs' AND ref_id=? AND COALESCE(deleted_at,0)=0").get(invId);
    ok(!!je, 'invoice_cogs JE exists');
    const lines = je
      ? db.prepare('SELECT account_code, debit, credit, debit_rial, credit_rial FROM journal_lines WHERE entry_id=?').all(je.id)
      : [];
    const crA = lines.find((l) => l.account_code === '1104');
    const crB = lines.find((l) => l.account_code === '1104K');
    const drCogs = lines.find((l) => Number(l.debit) > 0 || Number(l.debit_rial) > 0);
    ok(!!crA && !!crB, 'COGS credits both warehouse inventory accounts', lines.map((l) => l.account_code));
    const amtA = Math.round(Number(crA && (crA.credit_rial || crA.credit * 10)) || 0);
    const amtB = Math.round(Number(crB && (crB.credit_rial || crB.credit * 10)) || 0);
    const dr = Math.round(Number(drCogs && (drCogs.debit_rial || drCogs.debit * 10)) || 0);
    ok(amtA === 80000, 'Cr whA = 2×40000', amtA);
    ok(amtB === 30000, 'Cr whB = 1×30000', amtB);
    ok(dr === amtA + amtB, 'Dr COGS = sum Cr', { dr, amtA, amtB });

    const qtyA = Number(db.prepare('SELECT qty FROM warehouse_stock WHERE product_id=? AND warehouse_id=?').get(prodA, whA)?.qty);
    const qtyB = Number(db.prepare('SELECT qty FROM warehouse_stock WHERE product_id=? AND warehouse_id=?').get(prodB, whB)?.qty);
    ok(qtyA === 8, 'kardex/stock whA 10-2', qtyA);
    ok(qtyB === 9, 'kardex/stock whB 10-1', qtyB);

    // void → soft-void original multi-line COGS (no separate _reversal voucher since v285)
    const { voidInvoiceFully } = require('../lib/void-invoice');
    const adminUser = db.prepare('SELECT * FROM users WHERE id=?').get(adminId);
    voidInvoiceFully(db, invId, adminUser, {});
    const cogsAfter = db.prepare("SELECT id, deleted_at, status FROM journal_entries WHERE ref_type='invoice_cogs' AND ref_id=?").get(invId);
    ok(!!cogsAfter && (Number(cogsAfter.deleted_at) > 0
      || ['reversed', 'void'].includes(String(cogsAfter.status || ''))),
      'COGS JE soft-voided on cancel', cogsAfter);
    const liveCogs = db.prepare("SELECT id FROM journal_entries WHERE ref_type='invoice_cogs' AND ref_id=? AND COALESCE(deleted_at,0)=0").get(invId);
    ok(!liveCogs, 'no live invoice_cogs after void');
  }

  // Without inventory_negative.approve → 403 (user present, warehouse forbids negative)
  setStock(db, { productId: prodA, warehouseId: whA, target: 0 });
  const acctUser = db.prepare('SELECT * FROM users WHERE id=?').get(acctId);
  ok(!hasPermission(db, acctUser, 'inventory_negative', 'approve'), 'acct lacks inventory_negative.approve');
  const neg403 = await api('POST', '/api/invoices', {
    cust_id: custId, type: 'normal', date: today, warehouse_id: whA, pay_type: 'credit', vat_exempt: 1,
    client_request_id: key('neg1'),
    rows: [{ product_id: prodA, name: 'کالای A', qty: 1, price: 100000, warehouse_id: whA }],
  }, 'acct');
  // ATP fires first (409) when stock is short; stock-layer 403 applies if ATP is bypassed.
  ok(
    (neg403.status === 403 && neg403.data && neg403.data.code === 'E_NEGATIVE_OVERRIDE_FORBIDDEN')
    || (neg403.status === 409 && neg403.data && (neg403.data.code === 'E_ATP_INSUFFICIENT' || neg403.data.code === 'E_NEGATIVE_STOCK')),
    'without override access → blocked (403/409)',
    neg403
  );

  // Warehouse allow_negative=0 and no user override path via ledger: also covered by 403 above.
  // Grant override → 200 + audit
  db.prepare('INSERT OR REPLACE INTO user_permissions (user_id,resource,action,allowed) VALUES (?,?,?,1)')
    .run(acctId, 'inventory_negative', 'approve');
  const negOk = await api('POST', '/api/invoices', {
    cust_id: custId, type: 'normal', date: today, warehouse_id: whA, pay_type: 'credit', vat_exempt: 1,
    client_request_id: key('neg2'),
    rows: [{ product_id: prodA, name: 'کالای A', qty: 1, price: 100000, warehouse_id: whA }],
  }, 'acct');
  ok(negOk.status === 200 && negOk.data && negOk.data.id, 'override with grant → 200', negOk);
  if (negOk.status === 200) {
    const audits = db.prepare("SELECT * FROM audit_log WHERE action='negative_stock_override' AND entity_id=?").all(negOk.data.id);
    ok(audits.length >= 1, 'audit negative_stock_override', audits.length);
    const q = Number(db.prepare('SELECT qty FROM warehouse_stock WHERE product_id=? AND warehouse_id=?').get(prodA, whA)?.qty);
    ok(q === -1, 'stock went negative with override', q);
  }

  // Explicit allow_negative on warehouse → 200 without override grant (409 not raised)
  db.prepare('DELETE FROM user_permissions WHERE user_id=? AND resource=?').run(acctId, 'inventory_negative');
  db.prepare('UPDATE warehouses SET allow_negative=1 WHERE id=?').run(whA);
  setStock(db, { productId: prodA, warehouseId: whA, target: 0 });
  const negWh = await api('POST', '/api/invoices', {
    cust_id: custId, type: 'normal', date: today, warehouse_id: whA, pay_type: 'credit', vat_exempt: 1,
    client_request_id: key('neg3'),
    rows: [{ product_id: prodA, name: 'کالای A', qty: 1, price: 100000, warehouse_id: whA }],
  }, 'acct');
  ok(negWh.status === 200, 'warehouse allow_negative=1 → 200 without override perm', negWh.status);

  // Header periodic + line perpetual → still posts COGS for the perpetual line warehouse
  {
    const { saleUsesPerpetualValuation } = require('../lib/sales-document');
    const whPeriodic = insert('warehouses', {
      name: 'انبار ادواری', code: 'PER', active: 1, allow_negative: 0,
      warehouse_type: 'finished_goods', inventory_system: 'periodic', inventory_coa_code: '1104',
    });
    try { db.prepare('UPDATE warehouses SET inventory_system=? WHERE id=?').run('periodic', whPeriodic); } catch (_) {}
    ok(saleUsesPerpetualValuation(db, [{ product_id: prodB, warehouse_id: whB, qty: 1 }], whPeriodic) === true,
      'saleUsesPerpetualValuation: header periodic + line perpetual → true');
    ok(saleUsesPerpetualValuation(db, [{ product_id: prodA, warehouse_id: whPeriodic, qty: 1 }], whPeriodic) === false,
      'saleUsesPerpetualValuation: all periodic → false');

    setStock(db, { productId: prodB, warehouseId: whB, target: 5 });
    const mixed = await api('POST', '/api/invoices', {
      cust_id: custId, type: 'normal', date: today, warehouse_id: whPeriodic, pay_type: 'credit', vat_exempt: 1,
      client_request_id: key('hdr-periodic'),
      rows: [{ product_id: prodB, name: 'کالای B', qty: 1, price: 80000, warehouse_id: whB }],
    }, 'acct');
    ok(mixed.status === 200 && mixed.data && mixed.data.id, 'create with periodic header + perpetual line → 200', mixed);
    if (mixed.status === 200) {
      const je = db.prepare("SELECT id FROM journal_entries WHERE ref_type='invoice_cogs' AND ref_id=? AND COALESCE(deleted_at,0)=0").get(mixed.data.id);
      ok(!!je, 'COGS JE posted when only line WH is perpetual');
      if (je) {
        const lines = db.prepare('SELECT account_code, credit, credit_rial FROM journal_lines WHERE entry_id=?').all(je.id);
        const crB = lines.find((l) => l.account_code === '1104K');
        const amtB = Math.round(Number(crB && (crB.credit_rial || crB.credit * 10)) || 0);
        ok(!!crB && amtB === 30000, 'COGS Cr uses perpetual line warehouse account', { amtB, lines });
      }
    }
  }

  // report --out writes a file against the live test DB
  {
    const reportScript = path.join(__dirname, 'report-cross-warehouse-sales.js');
    const outFile = path.join(dir, 'xwh-p2-out.txt');
    const withOut = spawnSync(NODE, [reportScript, `--db=${process.env.DB_PATH}`, `--out=${outFile}`], { encoding: 'utf8' });
    ok(withOut.status === 0 && fs.existsSync(outFile) && fs.statSync(outFile).size > 0,
      'report writes --out file', { status: withOut.status, err: (withOut.stderr || '').slice(0, 200) });
  }

  server.close();
  try { db.close(); } catch (_) {}
  console.log(`\n══ Result: ${pass} passed, ${fail} failed ══\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
