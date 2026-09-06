/**
 * ACC-STITCH-P2 — payable KPI from GL, general-ledger period/page/q,
 * chart-of-accounts?parent=, and postable-level voucher guard.
 * Run: node server/scripts/test-acc-stitch-p2.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const express = require('express');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-stitch-p2-'));
const dbFile = path.join(dir, 't.db');
try { fs.unlinkSync(dbFile); } catch (_) {}
process.env.DB_PATH = dbFile;
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-acc-stitch-p2-secret-at-least-32b';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');

delete require.cache[require.resolve('../db')];
try { delete require.cache[require.resolve('../lib/coa-map')]; } catch (_) {}

const { initDB, getDB } = require('../db');
initDB();
const db = getDB();

const { postToLedger } = require('../lib/ledger');
const { acct } = require('../lib/coa-map');
const { SQL_JL_DEBIT_RIAL, SQL_JL_CREDIT_RIAL } = require('../lib/money');

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  OK', label); }
  else { fail++; console.log(' FAIL', label, extra == null ? '' : extra); }
}

function isLeaf(code) {
  return !db.prepare(
    'SELECT 1 FROM chart_of_accounts WHERE parent_code=? AND is_active=1 LIMIT 1'
  ).get(code);
}

(async () => {
  const admin = db.prepare("SELECT * FROM users WHERE username='admin'").get();
  db.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(admin.id);
  const { issueStaffSession, closeSessionStore } = require('../lib/auth-sessions');
  const token = issueStaffSession(db, admin, {
    device_kind: 'test',
    device_name: 'acc-stitch-p2',
    device_fingerprint: 'acc-stitch-p2-fp',
  }).token;

  const app = express();
  app.use(express.json());
  app.use('/api/accounting', require('../routes/accounting'));
  app.use('/api/parties', require('../routes/parties'));
  app.use('/api/product-categories', require('../routes/product-categories'));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const BASE = `http://127.0.0.1:${port}`;

  async function api(method, p, body) {
    const res = await fetch(BASE + p, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + token,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch (_) {}
    return { status: res.status, data };
  }

  const payable = acct(db, 'coa_payable');
  const inventory = acct(db, 'coa_inventory');
  const cash = acct(db, 'coa_cash_default');
  ok(!!payable.code && isLeaf(payable.code), 'payable control is a leaf (' + payable.code + ')');
  ok(!!inventory.code && isLeaf(inventory.code), 'inventory is a leaf (' + inventory.code + ')');

  // Dedicated parent/leaf for GL + ACC-06 (does not pollute 2101).
  db.prepare(`
    INSERT INTO chart_of_accounts (code,name,type,parent_code,level,is_active)
    VALUES ('2188','تست والد پرداختنی','liability','2100',3,1)
  `).run();
  db.prepare(`
    INSERT INTO chart_of_accounts (code,name,type,parent_code,level,is_active)
    VALUES ('218801','تست برگ دفترکل','liability','2188',4,1)
  `).run();

  // ── ACC-02: payable KPI from posted GL, not empty supplier_ledger ──
  console.log('\n— ACC-02 overview.totalPayable from GL —');
  const supId = db.prepare("INSERT INTO suppliers (name) VALUES ('تأمین‌کننده صفر')").run().lastInsertRowid;
  db.prepare(`
    INSERT INTO supplier_ledger (supplier_id,date,entry_type,ref_type,ref_id,description,debit,credit,user_id)
    VALUES (?,'1405/01/01','opening','opening',NULL,'ردیف خالی',0,0,1)
  `).run(supId);
  db.prepare(`
    INSERT INTO supplier_ledger (supplier_id,date,entry_type,ref_type,ref_id,description,debit,credit,user_id)
    VALUES (?,'1405/01/02','adjustment','adj',NULL,'ردیف صفر دوم',0,0,1)
  `).run(supId);

  const PAY_RIAL = 1_250_000;
  postToLedger(db, {
    sourceType: 'test_ap',
    sourceId: 1,
    date: '1405/03/15',
    description: 'خرید نسیه تست KPI',
    createdBy: admin.id,
    lines: [
      { code: inventory.code, name: inventory.name, debit: PAY_RIAL / 10, credit: 0 },
      { code: payable.code, name: payable.name, debit: 0, credit: PAY_RIAL / 10 },
    ],
  });

  const glRow = db.prepare(`
    SELECT
      COALESCE(SUM(${SQL_JL_CREDIT_RIAL}),0) AS credit,
      COALESCE(SUM(${SQL_JL_DEBIT_RIAL}),0) AS debit
    FROM journal_lines jl
    JOIN journal_entries je ON jl.entry_id=je.id
    WHERE jl.account_code LIKE ?
      AND COALESCE(je.deleted_at,0)=0
      AND COALESCE(je.status,'posted')<>'reversed'
  `).get(payable.code + '%');
  const glPayable = Math.max(0, Number(glRow.credit) - Number(glRow.debit));
  ok(glPayable === PAY_RIAL, 'direct GL payable = posted amount', glPayable);

  let r = await api('GET', '/api/accounting/overview');
  ok(r.status === 200, 'GET /overview 200', r.data?.error);
  ok(Number(r.data?.totalPayable) === PAY_RIAL,
    'totalPayable equals GL control (not ledger)', r.data?.totalPayable);
  ok(Number(r.data?.totalPayableLedger) === 0,
    'totalPayableLedger is zero from empty ledger rows', r.data?.totalPayableLedger);
  ok(Number(r.data?.totalPayable) !== Number(r.data?.totalPayableLedger),
    'KPI is not fooled by present-but-zero supplier_ledger');

  r = await api('GET', '/api/accounting/overview?asOf=1405/03/01');
  ok(Number(r.data?.totalPayable) === 0, 'asOf before JE → payable 0', r.data?.totalPayable);
  r = await api('GET', '/api/accounting/overview?asOf=1405/03/15');
  ok(Number(r.data?.totalPayable) === PAY_RIAL, 'asOf on JE date includes amount', r.data?.totalPayable);

  // 12-digit child under control — LIKE prefix must include it
  db.prepare(`
    INSERT INTO chart_of_accounts (code,name,type,parent_code,level,is_active)
    VALUES ('210100000001','تفصیلی تأمین‌کننده تست','liability',?,3,1)
  `).run(payable.code);
  const CHILD_RIAL = 400_000;
  postToLedger(db, {
    sourceType: 'test_ap_child',
    sourceId: 2,
    date: '1405/03/16',
    description: 'بدهی تفصیلی ۱۲رقمی',
    createdBy: admin.id,
    lines: [
      { code: inventory.code, name: inventory.name, debit: CHILD_RIAL / 10, credit: 0 },
      { code: '210100000001', name: 'تفصیلی تأمین‌کننده تست', debit: 0, credit: CHILD_RIAL / 10 },
    ],
  });
  r = await api('GET', '/api/accounting/overview');
  ok(Number(r.data?.totalPayable) === PAY_RIAL + CHILD_RIAL,
    'LIKE prefix includes 12-digit child under control', r.data?.totalPayable);

  // ── ACC-03: GL period + pagination + search ──
  console.log('\n— ACC-03 general-ledger period / page / q —');
  const glPosts = [
    { date: '1405/01/10', desc: 'افتتاحیه دفتر تست', invDr: 500_000, leafCr: 500_000, leafDr: 0 },
    { date: '1405/03/15', desc: 'خرید دوره تست', invDr: 200_000, leafCr: 200_000, leafDr: 0 },
    { date: '1405/03/20', desc: 'پرداخت جزئی تست', invDr: 0, leafCr: 0, leafDr: 50_000, cashCr: 50_000 },
    { date: '1405/06/01', desc: 'بعد از دوره تست', invDr: 80_000, leafCr: 80_000, leafDr: 0 },
  ];
  glPosts.forEach((g, i) => {
    const lines = [];
    if (g.invDr) lines.push({ code: inventory.code, name: inventory.name, debit: g.invDr / 10, credit: 0 });
    if (g.leafCr) lines.push({ code: '218801', name: 'تست برگ دفترکل', debit: 0, credit: g.leafCr / 10, description: g.desc });
    if (g.leafDr) lines.push({ code: '218801', name: 'تست برگ دفترکل', debit: g.leafDr / 10, credit: 0, description: g.desc });
    if (g.cashCr) lines.push({ code: cash.code, name: cash.name, debit: 0, credit: g.cashCr / 10 });
    postToLedger(db, {
      sourceType: 'test_gl',
      sourceId: 10 + i,
      date: g.date,
      description: g.desc,
      createdBy: admin.id,
      lines,
    });
  });

  r = await api('GET', '/api/accounting/general-ledger/218801?from=1405/03/01&to=1405/04/01');
  ok(r.status === 200 && r.data?.account?.code === '218801', 'GL period 200', r.data?.error);
  ok(Number(r.data?.opening_rial) === 500_000, 'opening_rial before from', r.data?.opening_rial);
  ok(Number(r.data?.period_debit_rial) === 50_000, 'period_debit_rial', r.data?.period_debit_rial);
  ok(Number(r.data?.period_credit_rial) === 200_000, 'period_credit_rial', r.data?.period_credit_rial);
  ok(Number(r.data?.closing_rial) === 650_000, 'closing_rial = opening + credit-normal movement', r.data?.closing_rial);
  ok(Number(r.data?.total) === 2, 'period total = 2 lines', r.data?.total);
  ok(Array.isArray(r.data?.lines) && r.data.lines.length === 2, 'period returns both in-range lines');
  const lastRb = r.data?.lines?.[r.data.lines.length - 1]?.running_balance;
  ok(Number(lastRb) === 650_000, 'running_balance continues from opening', lastRb);

  r = await api('GET', '/api/accounting/general-ledger/218801?from=1405/01/01&to=1405/12/29&page=1&pageSize=2');
  ok(Number(r.data?.total) === 4, 'pagination total = 4', r.data?.total);
  ok(r.data?.page === 1 && r.data?.pageSize === 2, 'page/pageSize echoed');
  ok(Array.isArray(r.data?.lines) && r.data.lines.length === 2, 'page 1 has 2 lines');
  r = await api('GET', '/api/accounting/general-ledger/218801?from=1405/01/01&to=1405/12/29&page=2&pageSize=2');
  ok(Array.isArray(r.data?.lines) && r.data.lines.length === 2, 'page 2 has 2 lines');
  ok(Number(r.data?.lines?.[0]?.running_balance) === 650_000
    || Number(r.data?.lines?.[1]?.running_balance) === 730_000,
    'page 2 running_balance continues after page 1', r.data?.lines?.map((l) => l.running_balance));

  r = await api('GET', '/api/accounting/general-ledger/218801?from=1405/01/01&to=1405/12/29&q='
    + encodeURIComponent('خرید دوره'));
  ok(Number(r.data?.total) === 1, 'q filter total = 1', r.data?.total);
  ok(Number(r.data?.unfiltered_total) === 4, 'q does not drop unfiltered_total', r.data?.unfiltered_total);
  ok(Number(r.data?.closing_rial) === 730_000, 'q does not rewrite closing_rial', r.data?.closing_rial);
  ok(Number(r.data?.period_debit_rial) === 50_000, 'q does not rewrite period_debit', r.data?.period_debit_rial);
  ok(Number(r.data?.period_credit_rial) === 780_000, 'q does not rewrite period_credit', r.data?.period_credit_rial);
  ok(r.data?.lines?.[0]?.entry_description?.includes('خرید دوره')
    || r.data?.lines?.[0]?.description?.includes('خرید دوره'),
    'q matched description', r.data?.lines?.[0]?.entry_description);

  r = await api('GET', '/api/accounting/general-ledger/218801');
  ok(r.status === 200 && Number(r.data?.total) >= 4, 'no from/to/q/page returns all lines', r.data?.total);
  ok(r.data?.opening_rial === 0, 'no from → opening_rial 0');
  ok(typeof r.data?.closing_rial === 'number' && typeof r.data?.period_debit_rial === 'number',
    'legacy call includes new total fields');

  // ── ACC-05: children by parent ──
  console.log('\n— ACC-05 chart-of-accounts?parent= —');
  r = await api('GET', '/api/accounting/chart-of-accounts');
  ok(r.status === 200 && Array.isArray(r.data) && r.data.length > 10, 'full list default');
  const fullHas2101 = r.data.some((a) => a.code === payable.code);
  const fullHasRoot = r.data.some((a) => a.code === '2000');
  ok(fullHas2101 && fullHasRoot, 'full list includes control + root');

  r = await api('GET', '/api/accounting/chart-of-accounts?parent=2100');
  ok(r.status === 200 && Array.isArray(r.data) && r.data.length >= 1, 'parent=2100 returns children');
  ok(r.data.every((a) => a.parent_code === '2100'), 'all rows parent_code=2100');
  ok(r.data.some((a) => a.code === payable.code), '2100 children include payable control');

  r = await api('GET', '/api/accounting/chart-of-accounts?parent=');
  ok(r.status === 200 && Array.isArray(r.data) && r.data.length >= 1, 'parent= empty → roots');
  ok(r.data.every((a) => a.parent_code == null), 'empty parent → parent_code IS NULL');

  r = await api('GET', '/api/accounting/chart-of-accounts?parent=__root__');
  ok(r.status === 200 && r.data.every((a) => a.parent_code == null), '__root__ → roots');
  ok(r.data.some((a) => a.code === '2000'), '__root__ includes 2000');

  r = await api('GET', '/api/accounting/chart-of-accounts?parent=2188');
  ok(r.data.length === 1 && r.data[0].code === '218801', 'parent=2188 → only leaf child');

  // ── ACC-06: posting only on allowed (leaf) level ──
  console.log('\n— ACC-06 postable level —');
  r = await api('POST', '/api/accounting/vouchers', {
    date: '1405/04/01',
    description: 'سند روی حساب والد',
    lines: [
      { code: inventory.code, debit: 10_000, credit: 0 },
      { code: '2188', debit: 0, credit: 10_000 },
    ],
  });
  ok(r.status === 400, 'POST voucher to parent → 400', r.status);
  ok(r.data?.code === 'E_COA_NOT_POSTABLE', 'error code E_COA_NOT_POSTABLE', r.data?.code);
  ok(String(r.data?.error || '').includes('سطح پست نیست'), 'Persian not-postable message', r.data?.error);

  r = await api('POST', '/api/accounting/vouchers', {
    date: '1405/04/01',
    description: 'سند روی حساب برگ',
    lines: [
      { code: inventory.code, debit: 10_000, credit: 0 },
      { code: '218801', debit: 0, credit: 10_000 },
    ],
  });
  ok(r.status === 200 && r.data?.ok, 'POST voucher to leaf succeeds', r.data?.error || r.status);

  r = await api('POST', '/api/accounting/vouchers', {
    date: '1405/04/02',
    description: 'سند روی کنترل پرداختنی پس از افزودن تفصیلی',
    lines: [
      { code: inventory.code, debit: 10_000, credit: 0 },
      { code: payable.code, debit: 0, credit: 10_000 },
    ],
  });
  ok(r.status === 400 && r.data?.code === 'E_COA_NOT_POSTABLE',
    '2101 no longer postable after 12-digit child', r.data?.code);

  r = await api('POST', '/api/accounting/account-payments', {
    date: '1405/04/03', amount: 10000, account_code: '2188', pay_type: 'cash',
  });
  ok(r.status === 400 && r.data?.code === 'E_COA_NOT_POSTABLE',
    'account-payment to parent rejected', r.data?.code);

  r = await api('POST', '/api/accounting/account-receipts', {
    date: '1405/04/03', amount: 10000, account_code: '2188', pay_type: 'cash',
  });
  ok(r.status === 400 && r.data?.code === 'E_COA_NOT_POSTABLE',
    'account-receipt from parent rejected', r.data?.code);

  // ── ACC-01: tafsili identity survives group / client rewrite ──
  console.log('\n— ACC-01 stable tafsili —');
  const partyIns = db.prepare(`
    INSERT INTO parties (person_code, party_type, full_name, phone, coa_code)
    VALUES ('P-ACC01','customer','هویت پایدار','09120001111','11039901')
  `).run();
  const partyId = partyIns.lastInsertRowid;
  r = await api('PUT', '/api/parties/' + partyId, {
    full_name: 'هویت پایدار',
    phone: '09120001111',
    coa_code: '999999',
    party_group_id: null,
  });
  ok(r.status === 200 || r.data?.success, 'PUT party ok', r.status + ' ' + JSON.stringify(r.data));
  const afterPut = db.prepare('SELECT coa_code FROM parties WHERE id=?').get(partyId);
  ok(afterPut.coa_code === '11039901', 'coa_code unchanged after PUT rewrite attempt', afterPut.coa_code);

  const custId = db.prepare(
    "INSERT INTO customers (user_id, biz, phone, coa_code) VALUES (?, 'مشتری GL', '09120002222', '11039901')"
  ).run(admin.id).lastInsertRowid;
  r = await api('PATCH', '/api/accounting/link-coa', {
    entity_type: 'customer', entity_id: custId, coa_code: inventory.code,
  });
  ok(r.status === 400 && r.data?.code === 'E_COA_IDENTITY_LOCKED',
    'link-coa refuses overwrite', r.data?.code);

  // ── ACC-04: receivable KPI from GL + statement gl_closing ──
  console.log('\n— ACC-04 receivable GL / statement —');
  const receivable = acct(db, 'coa_receivable');
  db.prepare(`
    INSERT INTO chart_of_accounts (code,name,type,parent_code,level,is_active)
    VALUES ('11039901','تفصیلی مشتری تست','asset',?,4,1)
  `).run(receivable.code);
  const AR_RIAL = 750_000;
  postToLedger(db, {
    sourceType: 'test_ar',
    sourceId: 9,
    date: '1405/04/10',
    description: 'بدهکار مشتری تست',
    createdBy: admin.id,
    lines: [
      { code: '11039901', name: 'تفصیلی مشتری تست', debit: AR_RIAL / 10, credit: 0 },
      { code: inventory.code, name: inventory.name, debit: 0, credit: AR_RIAL / 10 },
    ],
  });
  r = await api('GET', '/api/accounting/overview');
  ok(Number(r.data?.totalReceivable) >= AR_RIAL,
    'totalReceivable includes GL AR child', r.data?.totalReceivable);
  r = await api('GET', '/api/accounting/overview?asOf=1405/04/10');
  const ovCut = Number(r.data?.totalReceivable);
  ok(ovCut === AR_RIAL, 'overview asOf cutoff equals AR', ovCut);
  r = await api('GET', '/api/accounting/overview?asOf=1405/04/01');
  ok(Number(r.data?.totalReceivable) === 0,
    'overview asOf before AR is 0', r.data?.totalReceivable);

  r = await api('GET', '/api/accounting/statement/' + custId);
  ok(r.status === 200, 'GET statement 200', r.data?.error);
  ok(r.data?.gl_account_code === '11039901', 'statement gl_account_code', r.data?.gl_account_code);
  ok(Number(r.data?.gl_closing_rial) === AR_RIAL,
    'statement gl_closing_rial matches posted AR', r.data?.gl_closing_rial);
  ok(Number(r.data?.closing) === AR_RIAL, 'statement primary closing is GL', r.data?.closing);
  ok(r.data?.source === 'gl', 'statement source=gl', r.data?.source);

  r = await api('GET', '/api/accounting/statement/' + custId + '?to=1405/04/10');
  ok(Number(r.data?.closing) === AR_RIAL, 'statement closing as-of to', r.data?.closing);
  r = await api('GET', '/api/accounting/statement/' + custId + '?to=1405/04/01');
  ok(Number(r.data?.closing) === 0, 'statement closing before AR date is 0', r.data?.closing);

  r = await api('GET', '/api/accounting/receivables?to=1405/04/10');
  ok(r.status === 200 && Array.isArray(r.data), 'GET receivables 200');
  const recvRow = (r.data || []).find((x) => Number(x.id) === Number(custId));
  ok(!!recvRow, 'JE-only customer appears on receivables', JSON.stringify(r.data?.map((x) => x.id)));
  ok(Number(recvRow?.outstanding) === AR_RIAL, 'receivables outstanding is GL', recvRow?.outstanding);
  ok(Number(recvRow?.gl_closing_rial) === AR_RIAL, 'receivables GL close is AR', recvRow?.gl_closing_rial);

  r = await api('GET', '/api/accounting/general-ledger/11039901?to=1405/04/10');
  ok(Number(r.data?.closing_rial) === AR_RIAL, 'GL tafsili close equals AR', r.data?.closing_rial);
  ok(ovCut === Number(r.data?.closing_rial) && ovCut === AR_RIAL,
    'dashboard KPI = GL tafsili close at cutoff', ovCut);

  const LEDGER_ONLY = 111_000;
  const ledCust = db.prepare(
    "INSERT INTO customers (user_id, biz, phone, coa_code) VALUES (?, 'مشتری فقط دفتر', '09120003333', '11039902')"
  ).run(admin.id).lastInsertRowid;
  db.prepare(`
    INSERT INTO chart_of_accounts (code,name,type,parent_code,level,is_active)
    VALUES ('11039902','تفصیلی دفتر-تنها','asset',?,4,1)
  `).run(receivable.code);
  db.prepare(`
    INSERT INTO customer_ledger (customer_id, date, entry_type, description, debit, credit, user_id)
    VALUES (?, '1405/04/10', 'opening', 'مانده دفتر بدون سند', ?, 0, ?)
  `).run(ledCust, LEDGER_ONLY, admin.id);
  r = await api('GET', '/api/accounting/statement/' + ledCust);
  ok(r.data?.books_mismatch === true, 'ledger-only opening vs empty GL is mismatch');
  ok(Number(r.data?.closing) === 0, 'ledger-only primary close is GL 0', r.data?.closing);
  ok(Number(r.data?.ledger_closing) === LEDGER_ONLY, 'ledger_closing keeps book', r.data?.ledger_closing);
  r = await api('GET', '/api/accounting/receivables');
  const ledRow = (r.data || []).find((x) => Number(x.id) === Number(ledCust));
  ok(Number(ledRow?.outstanding) === 0, 'ledger-only outstanding uses GL 0', ledRow?.outstanding);

  const OVERPAY = 1_000_000;
  postToLedger(db, {
    sourceType: 'test_ar_overpay',
    sourceId: 91,
    date: '1405/04/12',
    description: 'اضافه‌پرداخت مشتری تست',
    createdBy: admin.id,
    lines: [
      { code: cash.code, name: cash.name, debit: OVERPAY / 10, credit: 0 },
      { code: '11039901', name: 'تفصیلی مشتری تست', debit: 0, credit: OVERPAY / 10 },
    ],
  });
  const afterOver = AR_RIAL - OVERPAY;
  r = await api('GET', '/api/accounting/statement/' + custId);
  ok(Number(r.data?.closing) === afterOver, 'overpay → creditor GL closing', r.data?.closing);
  r = await api('GET', '/api/accounting/overview');
  ok(Number(r.data?.totalReceivable) === 0, 'overpay zeroes GL AR display', r.data?.totalReceivable);
  ok(Number(r.data?.creditorBalance) === Math.abs(afterOver),
    'overpay → creditorBalance from GL', r.data?.creditorBalance);
  r = await api('GET', '/api/accounting/receivables');
  const overRow = (r.data || []).find((x) => Number(x.id) === Number(custId));
  ok(Number(overRow?.outstanding) === afterOver, 'receivables outstanding creditor after overpay', overRow?.outstanding);

  // ── INV-01: product group moin must be a leaf ──
  console.log('\n— INV-01 product group coa_code —');
  r = await api('POST', '/api/product-categories', { name: 'گروه والد کدینگ', coa_code: '2188' });
  ok(r.status === 400 && r.data?.code === 'E_COA_NOT_POSTABLE',
    'group coa parent rejected', r.data?.code);
  r = await api('POST', '/api/product-categories', { name: 'گروه معین برگ', coa_code: '218801' });
  ok(r.status === 200 && r.data?.coa_code === '218801',
    'group coa leaf stored', r.data?.coa_code || r.data?.error);

  server.close();
  try { closeSessionStore(); } catch (_) {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}

  console.log();
  if (fail) {
    console.log(`ACC-STITCH-P2: ${pass} passed, ${fail} failed`);
    process.exit(1);
  }
  console.log(`ACC-STITCH-P2: ${pass} passed`);
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
