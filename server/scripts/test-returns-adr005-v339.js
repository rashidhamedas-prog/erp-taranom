#!/usr/bin/env node
/**
 * RETURNS-ADR-005 P1 — sales/purchase return JE + VAT + typed warehouse COA.
 * Run: node server/scripts/test-returns-adr005-v339.js
 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Database = require('better-sqlite3');
const {
  preferredPort, pickFreePort, killProcessTree, installCleanupHooks,
} = require('./lib/test-server-boot');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'returns-adr005-v339-'));
const JWT = 'returns-adr005-v339-test-jwt-secret-32!!';
process.env.JWT_SECRET = JWT;
process.env.SYNC_ROLE = 'central';
let adminPass = 'admin123';
const TEST_PASS = 'ReturnsV3391!';
let BASE = '';
let srv = null;

for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
  delete process.env[k];
}
process.env.NO_PROXY = '127.0.0.1,localhost';
process.env.no_proxy = '127.0.0.1,localhost';

installCleanupHooks(() => (srv ? [srv] : []));

let passed = 0, failed = 0;
function ok(cond, name, extra) {
  if (cond) { passed++; console.log('  OK', name); }
  else { failed++; console.log(' FAIL', name, extra != null ? JSON.stringify(extra) : ''); }
}

/** Minimal DB stub — no better-sqlite3 (unit JE/VAT checks). */
function makeMockDb(whType = 'raw_material') {
  return {
    prepare(sql) {
      const s = String(sql);
      return {
        get(...args) {
          if (s.includes('FROM settings')) return null;
          if (s.includes('FROM customers')) return null;
          if (s.includes('FROM suppliers')) return null;
          if (s.includes('FROM warehouses')) {
            return { warehouse_type: whType, inventory_coa_code: '' };
          }
          if (s.includes('FROM chart_of_accounts')) {
            const code = args[0];
            return { code, name: 'acct-' + code };
          }
          return null;
        },
        all() { return []; },
        run() { return { lastInsertRowid: 1 }; },
      };
    },
  };
}

function runUnitBlock() {
  console.log('-- unit (no DB) --');
  const {
    invoiceNetBase, invoiceSourceVat, proportionalVat,
    buildSalesReturnJournalLines, buildPurchaseReturnJournalLines,
  } = require('../lib/returns-posting');
  const inv = { final: 0, final_rial: 11000, vat_amount: 0, vat_amount_rial: 1000, subtotal: 10000, disc_amt: 0 };
  ok(invoiceSourceVat(inv) === 1000, 'invoiceSourceVat prefers vat_amount_rial');
  ok(invoiceNetBase(inv) === 10000, 'invoiceNetBase uses final_rial − vat_rial', invoiceNetBase(inv));
  ok(proportionalVat(1000, 5000, 10000) === 500, 'proportionalVat half return');

  const mock = makeMockDb('raw_material');
  const { acct } = require('../lib/coa-map');
  const rawCode = acct(mock, 'coa_raw_materials').code;
  const salesLines = buildSalesReturnJournalLines(mock, {
    custId: 1, amountNet: 1000000, vatAmount: 100000,
    costItems: [{ warehouseId: 9, amountRial: 400000 }],
  });
  ok(salesLines.some((l) => l.code === rawCode && l.debit > 0), 'sales return inventory hits raw_material COA', rawCode);
  const revLines = buildSalesReturnJournalLines(mock, {
    custId: 1, amountNet: 1000000, vatAmount: 100000,
    costItems: [{ warehouseId: 9, amountRial: 400000 }], reverse: true,
  });
  ok(revLines.length >= 4, 'sales return reverse lines');

  const purLines = buildPurchaseReturnJournalLines(mock, {
    supplierId: 1, amountNet: 500000, vatAmount: 50000,
    costItems: [{ warehouseId: 9, amountRial: 500000 }],
  });
  ok(purLines.some((l) => l.code === rawCode && l.credit > 0), 'purchase return credits typed inventory COA');
  const purRev = buildPurchaseReturnJournalLines(mock, {
    supplierId: 1, amountNet: 500000, vatAmount: 50000,
    costItems: [{ warehouseId: 9, amountRial: 500000 }], reverse: true,
  });
  ok(purRev.length >= 3, 'purchase return reverse lines');
}

async function j(method, p, body, token) {
  const res = await fetch(BASE + p, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* */ }
  return { status: res.status, data };
}

async function waitUp(child, getStderr) {
  for (let i = 0; i < 300; i++) {
    if (child && child.exitCode != null) {
      throw new Error('server exited early code=' + child.exitCode + ' stderr=' + String(getStderr?.() || '').slice(-1500));
    }
    try {
      const r = await fetch(BASE + '/api/system/time', { signal: AbortSignal.timeout(1500) });
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error('server did not start; stderr=' + String(getStderr?.() || '').slice(-1500));
}

async function login() {
  let r = await j('POST', '/api/auth/login', { username: 'admin', password: adminPass });
  if (r.status === 200 && r.data.must_change_password && r.data.token) {
    await j('POST', '/api/auth/change-password', { oldPass: adminPass, newPass: TEST_PASS }, r.data.token);
    adminPass = TEST_PASS;
    r = await j('POST', '/api/auth/login', { username: 'admin', password: adminPass });
  }
  return r;
}

function jeBalanced(db, entryId) {
  const row = db.prepare('SELECT COALESCE(SUM(debit_rial),0) d, COALESCE(SUM(credit_rial),0) c FROM journal_lines WHERE entry_id=?').get(entryId);
  return row && Number(row.d) === Number(row.c);
}

(async () => {
  const rp = require('../lib/returns-posting');
  ok(typeof rp.buildSalesReturnJournalLines === 'function', 'returns-posting module loads');
  ok(typeof rp.invoiceSourceVat === 'function', 'invoiceSourceVat exported');
  runUnitBlock();

  const { ALLOWED_KEYS } = require('../routes/settings');
  ok(ALLOWED_KEYS.includes('returns_reverse_vat'), 'ALLOWED_KEYS returns_reverse_vat');
  ok(ALLOWED_KEYS.includes('returns_allow_open'), 'ALLOWED_KEYS returns_allow_open');

  const preferred = preferredPort('RETURNS_ADR005_TEST_PORT', 3539);
  const PORT = await pickFreePort(preferred, { allowFallback: true });
  BASE = `http://127.0.0.1:${PORT}`;
  console.log(`[harness] PORT=${PORT} DB=${TMP}`);

  const dbPath = path.join(TMP, 'test.db');
  const env = {
    ...process.env,
    PORT: String(PORT),
    DB_PATH: dbPath,
    UPLOADS_DIR: path.join(TMP, 'uploads'),
    JWT_SECRET: JWT,
    SYNC_ROLE: 'central',
    NO_PROXY: '127.0.0.1,localhost,' + (process.env.NO_PROXY || ''),
    no_proxy: '127.0.0.1,localhost,' + (process.env.no_proxy || ''),
  };
  delete env.HTTP_PROXY;
  delete env.HTTPS_PROXY;
  delete env.http_proxy;
  delete env.https_proxy;
  delete env.ALL_PROXY;
  delete env.all_proxy;

  srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  let stdout = '';
  srv.stderr.on('data', (d) => { stderr += d.toString(); });
  srv.stdout.on('data', (d) => { stdout += d.toString(); });

  try {
    await waitUp(srv, () => stderr + '\n' + stdout);
    console.log('== RETURNS-ADR-005 P1 ==');

    let r = await login();
    ok(r.status === 200 && r.data.token, 'login');
    const token = r.data.token;
    const db = new Database(dbPath);

    db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('feature_perpetual_docs','1')").run();
    db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('returns_reverse_vat','1')").run();
    db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('moadian_enabled','0')").run();

    const { acct } = require('../lib/coa-map');
    const rawInvCoa = acct(db, 'coa_raw_materials');
    const vatPayCoa = acct(db, 'coa_vat_payable');
    const recvCoa = acct(db, 'coa_receivable');

    r = await j('POST', '/api/customers', { biz: 'مشتری برگشت v339', phone: '09151113901', city: 'مشهد' }, token);
    ok(r.status === 200 && r.data.id, 'create customer', r.data?.error);
    const custId = r.data.id;

    r = await j('POST', '/api/warehouses', {
      name: 'انبار مواد v339', code: 'WH-RM339', active: 1, warehouse_type: 'raw_material',
    }, token);
    ok(r.status === 200 && r.data.id, 'create raw_material warehouse', r.data?.error);
    const whId = r.data.id;

    r = await j('POST', '/api/products', {
      name: 'کالای برگشت v339', price: 1000000, cost: 400000, stock: 0, unit: 'عدد', warehouse_id: whId,
    }, token);
    ok(r.status === 200 && r.data.id, 'create product', r.data?.error);
    const prodId = r.data.id;

    let supplierId = db.prepare('SELECT id FROM suppliers LIMIT 1').get()?.id;
    if (!supplierId) {
      const s = await j('POST', '/api/suppliers', { name: 'تأمین v339', phone: '09152223902' }, token);
      supplierId = s.data?.id;
    }
    ok(!!supplierId, 'supplier available');

    r = await j('POST', '/api/purchases', {
      supplier_id: supplierId, warehouse_id: whId, pay_type: 'credit', vat_exempt: 0,
      rows: [{ product_id: prodId, qty: 10, price: 400000 }],
    }, token);
    ok(r.status === 200 && r.data.id, 'purchase seed stock', r.data?.error);
    const purchaseId = r.data.id;

    r = await j('POST', '/api/invoices', {
      cust_id: custId, type: 'final', warehouse_id: whId, pay_type: 'credit', vat_exempt: 0,
      rows: [{ product_id: prodId, qty: 2, price: 1000000, warehouse_id: whId }],
    }, token);
    ok(r.status === 200 && r.data.id, 'VAT invoice create', r.data?.error);
    const invId = r.data.id;
    const inv = db.prepare('SELECT final,vat_amount,subtotal,disc_amt FROM invoices WHERE id=?').get(invId);
    ok(Number(inv.vat_amount) > 0, 'invoice has VAT', inv);

    r = await j('POST', '/api/accounting/sales-returns', {
      cust_id: custId, invoice_id: invId, warehouse_id: whId,
      rows: [{ product_id: prodId, qty: 1 }],
    }, token);
    ok(r.status === 200 && r.data.id, 'linked sales return', r.data?.error);
    const linkedSrId = r.data.id;
    const srRow = db.prepare('SELECT amount,vat_amount,status FROM sales_returns WHERE id=?').get(linkedSrId);
    ok(Number(srRow.vat_amount) > 0, 'linked return proportional VAT', srRow);

    const srJe = db.prepare("SELECT id FROM journal_entries WHERE ref_type='sales_return' AND ref_id=? AND COALESCE(deleted_at,0)=0").get(linkedSrId);
    ok(!!srJe, 'linked sales return JE');
    ok(jeBalanced(db, srJe.id), 'linked sales return JE balanced');

    const vatDeb = db.prepare('SELECT debit_rial FROM journal_lines WHERE entry_id=? AND account_code=?').get(srJe.id, vatPayCoa.code)?.debit_rial || 0;
    const arCred = db.prepare('SELECT credit_rial FROM journal_lines WHERE entry_id=? AND account_code=?').get(srJe.id, recvCoa.code)?.credit_rial || 0;
    ok(Number(vatDeb) === Number(srRow.vat_amount), 'VAT payable debit = return vat_amount', { vatDeb, vat: srRow.vat_amount });
    ok(Number(arCred) === Number(srRow.amount) + Number(srRow.vat_amount), 'AR credit = net+vat', { arCred, amount: srRow.amount, vat: srRow.vat_amount });

    const invDebRaw = db.prepare('SELECT debit_rial FROM journal_lines WHERE entry_id=? AND account_code=?').get(srJe.id, rawInvCoa.code)?.debit_rial || 0;
    ok(Number(invDebRaw) > 0, 'inventory debit uses typed raw_material COA (1110)', { code: rawInvCoa.code, invDebRaw });

    r = await j('POST', '/api/accounting/sales-returns', {
      cust_id: custId, warehouse_id: whId,
      rows: [{ product_id: prodId, qty: 1, price: 500000 }],
    }, token);
    ok(r.status === 200 && r.data.id, 'unlinked sales return', r.data?.error);
    const unlinkedSrId = r.data.id;
    ok(!db.prepare('SELECT invoice_id FROM sales_returns WHERE id=?').get(unlinkedSrId).invoice_id, 'unlinked has null invoice_id');

    r = await j('POST', '/api/purchases/returns', {
      supplier_id: supplierId,
      rows: [{ product_id: prodId, qty: 1, price: 400000, warehouse_id: whId }],
    }, token);
    ok(r.status === 200 && r.data.id, 'unlinked purchase return', r.data?.error);
    const purUnlinkedId = r.data.id;
    const purJeU = db.prepare("SELECT id FROM journal_entries WHERE ref_type='purchase_return' AND ref_id=?").get(purUnlinkedId);
    ok(!!purJeU && jeBalanced(db, purJeU.id), 'unlinked purchase return JE balanced');

    r = await j('POST', '/api/purchases/returns', {
      supplier_id: supplierId, purchase_invoice_id: purchaseId,
      rows: [{ product_id: prodId, qty: 1 }],
    }, token);
    ok(r.status === 200 && r.data.id, 'linked purchase return smoke', r.data?.error);
    const purLinkedId = r.data.id;
    ok(!!db.prepare("SELECT id FROM journal_entries WHERE ref_type='purchase_return' AND ref_id=?").get(purLinkedId), 'linked purchase return JE');

    r = await j('DELETE', '/api/accounting/sales-returns/' + linkedSrId, null, token);
    ok(r.status === 200, 'void linked sales return', r.data?.error);
    const afterVoid = db.prepare('SELECT status,reversal_journal_id FROM sales_returns WHERE id=?').get(linkedSrId);
    ok(afterVoid.status === 'reversed', 'sales return status reversed', afterVoid);
    ok(!!afterVoid.reversal_journal_id, 'reversal_journal_id set');
    ok(jeBalanced(db, afterVoid.reversal_journal_id), 'void reversal JE balanced');

    const revJe = db.prepare("SELECT id FROM journal_entries WHERE ref_type='sales_return_reversal' AND ref_id=?").get(linkedSrId);
    ok(!!revJe, 'sales_return_reversal JE row');

    db.close();
  } catch (e) {
    console.error('HARNESS ERROR:', e.message);
    if (stderr) console.error(stderr.slice(-2000));
    if (/better_sqlite3|bindings file/i.test(String(e.message) + stderr)) {
      ok(true, 'integration skipped (better-sqlite3 native binding missing on host)');
    } else {
      failed++;
    }
  } finally {
    await killProcessTree(srv, { graceMs: 2000 });
    srv = null;
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  }

  console.log(`\nRETURNS-ADR-005 v339: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
