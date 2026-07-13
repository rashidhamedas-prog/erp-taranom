#!/usr/bin/env node
// E2E for Mahak phase 2: on a Mahak-mode DB, new operational documents must
// post to Mahak codes — customer tafsili receivable, mapped sales account,
// automatic COGS voucher, bank/cashbox tafsili on receipts — and the trial
// balance must stay balanced through create + settle + delete.
//
//   node server/scripts/test-mahak-phase2.js <mahak.db copy> [adminUser] [adminPass]
const path = require('path');
const { spawn } = require('child_process');

const DB = path.resolve(process.argv[2] || 'mahak-test.db');
const USER = process.argv[3] || 'admin';
const PASS = process.argv[4] || 'admin123';
const TEST_PASS = PASS + 'Mh2!';
const PORT = 4507;
const BASE = `http://127.0.0.1:${PORT}`;
let TOKEN = '';
let passed = 0, failed = 0;
const ok = (name, cond, extra) => { console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`); cond ? passed++ : failed++; };

async function api(method, p, body) {
  const r = await fetch(BASE + '/api' + p, {
    method, headers: { 'Content-Type': 'application/json', ...(TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${p} → ${r.status}: ${d.error || ''}`);
  return d;
}

(async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, DB_PATH: DB, PORT: String(PORT), JWT_SECRET: 'phase2-test' }, stdio: 'ignore'
  });
  try {
    for (let i = 0; i < 40; i++) { try { if ((await fetch(BASE + '/api/system/time')).ok) break; } catch { } await new Promise(r => setTimeout(r, 500)); }
    let login = await api('POST', '/auth/login', { username: USER, password: PASS });
    if (login.must_change_password && login.token) {
      const chg = await fetch(BASE + '/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + login.token },
        body: JSON.stringify({ oldPass: PASS, newPass: TEST_PASS })
      });
      const cd = await chg.json().catch(() => ({}));
      if (!chg.ok) throw new Error('change-password → ' + (cd.error || chg.status));
      login = await api('POST', '/auth/login', { username: USER, password: TEST_PASS });
    }
    TOKEN = login.token;

    const db = require('better-sqlite3')(DB);
    const tb = () => db.prepare(`SELECT ROUND(SUM(debit)) d, ROUND(SUM(credit)) c FROM journal_lines jl JOIN journal_entries je ON jl.entry_id=je.id WHERE COALESCE(je.deleted_at,0)=0`).get();

    // 1) new customer gets a tafsili under 203004
    const cust = await api('POST', '/customers', { biz: 'بوتیک تست فاز۲', city: 'مشهد', phone: '09150000000' });
    const custRow = db.prepare('SELECT coa_code FROM customers WHERE id=?').get(cust.id);
    ok('مشتری جدید تفصیلی گرفت', !!custRow.coa_code && custRow.coa_code.startsWith('203004'), custRow.coa_code);

    // 2) pick a Mahak product with stock & cost
    const prod = db.prepare("SELECT id,name,price,cost,coa_code,stock FROM products WHERE stock>2 AND cost>0 AND coa_code LIKE '202%' LIMIT 1").get();
    ok('محصول محک با موجودی/بها موجود است', !!prod, prod && `${prod.name} stock=${prod.stock} cost=${prod.cost}`);

    // 3) final invoice → mahak postings + COGS voucher
    const price = prod.price > 0 ? prod.price : 500000;
    const inv = await api('POST', '/invoices', { cust_id: cust.id, type: 'final', rows: [{ product_id: prod.id, qty: 2, price }], pay_type: 'cash' });
    const jinv = db.prepare("SELECT je.id FROM journal_entries je WHERE je.ref_type='invoice' AND je.ref_id=? AND COALESCE(je.deleted_at,0)=0").get(inv.id);
    const lines = db.prepare('SELECT account_code,debit,credit FROM journal_lines WHERE entry_id=?').all(jinv.id);
    ok('سند فروش: بدهکار تفصیلی مشتری', lines.some(l => l.account_code === custRow.coa_code && l.debit > 0));
    ok('سند فروش: بستانکار حساب فروش محک (601...)', lines.some(l => l.account_code.startsWith('601') && l.credit > 0));
    const cogs = db.prepare("SELECT je.id FROM journal_entries je WHERE je.ref_type='invoice_cogs' AND je.ref_id=?").get(inv.id);
    ok('سند COGS خودکار ثبت شد', !!cogs);
    if (cogs) {
      const cl = db.prepare('SELECT account_code,debit,credit FROM journal_lines WHERE entry_id=?').all(cogs.id);
      ok('COGS: بدهکار 801 به مبلغ cost×qty', cl.some(l => l.account_code.startsWith('801') && Math.round(l.debit) === Math.round(prod.cost * 2)));
      ok('COGS: بستانکار تفصیلی خود کالا', cl.some(l => l.account_code === prod.coa_code && l.credit > 0));
    }
    let t = tb(); ok('تراز بعد از فاکتور متوازن', t.d === t.c, `${t.d}`);

    // 4) receipt to صندوق مرکزی → bank/box tafsili
    const box = db.prepare("SELECT id,coa_code FROM cash_boxes WHERE coa_code IS NOT NULL LIMIT 1").get();
    await api('POST', '/accounting/settlements', { cust_id: cust.id, invoice_id: inv.id, amount: price, pay_type: 'cash', cash_box_id: box.id });
    const set = db.prepare("SELECT je.id FROM journal_entries je WHERE je.ref_type='settlement' ORDER BY je.id DESC LIMIT 1").get();
    const sl = db.prepare('SELECT account_code,debit,credit FROM journal_lines WHERE entry_id=?').all(set.id);
    ok('دریافت: بدهکار تفصیلی صندوق محک', sl.some(l => l.account_code === box.coa_code && l.debit > 0), box.coa_code);
    ok('دریافت: بستانکار تفصیلی مشتری', sl.some(l => l.account_code === custRow.coa_code && l.credit > 0));
    t = tb(); ok('تراز بعد از دریافت متوازن', t.d === t.c);

    // 5) new product gets its own tafsili (goes through multer route: use quick or normal)
    const np = await api('POST', '/products', { name: 'کالای تست فاز۲', price: 100000, cost: 60000, stock: 0 });
    const npRow = db.prepare('SELECT coa_code FROM products WHERE id=?').get(np.id);
    ok('محصول جدید تفصیلی گرفت (202001…)', !!npRow.coa_code && npRow.coa_code.startsWith('202001'), npRow.coa_code);

    // 6) delete invoice → reversal incl. COGS, balance kept, stock restored
    await api('DELETE', '/invoices/' + inv.id);
    const rcogs = db.prepare("SELECT id FROM journal_entries WHERE ref_type='invoice_cogs_reversal' AND ref_id=?").get(inv.id);
    ok('ابطال: سند معکوس COGS ثبت شد', !!rcogs);
    t = tb(); ok('تراز بعد از ابطال متوازن', t.d === t.c, `${t.d}`);

    db.close();
  } catch (e) {
    console.error('CRASH:', e.message); failed++;
  } finally { srv.kill(); }
  console.log(`\n${failed ? '❌' : '🎉'} ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
