#!/usr/bin/env node
/**
 * چرخهٔ کامل کسب‌وکار تا گزارش‌گیری — حسابرسی end-to-end روی سرور واقعی:
 *   خرید نسیه → پرداخت به تأمین‌کننده → فروش رسمی نقدی → تسویه مشتری → هزینه
 *   سپس تطبیق ریز اعداد در: تراز آزمایشی، ترازنامه، صورت‌حساب مشتری،
 *   ارزش‌گذاری موجودی، دفتر معین؛ و در پایان ابطال فاکتور (R13) و برگشت کامل اثرها.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 3492;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-cycle-'));
const { todayJalali } = require('../jalali');
const TODAY = todayJalali();

let passed = 0, failed = 0;
const ok = (cond, name, extra) => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${extra !== undefined ? ' — ' + extra : ''}`);
  cond ? passed++ : failed++;
};
const approx = (a, b, tol = 1) => Math.abs(Number(a) - Number(b)) <= tol;

let TOKEN = '';
async function api(method, p, body) {
  const r = await fetch(BASE + '/api' + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const d = await r.json().catch(() => ({}));
  return { status: r.status, data: d };
}

(async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env, PORT: String(PORT), DB_PATH: path.join(TMP, 't.db'),
      UPLOADS_DIR: path.join(TMP, 'u'), JWT_SECRET: 'cycle-test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stderr.on('data', d => process.stderr.write('[srv] ' + d));
  const killAll = () => { try { srv.kill('SIGKILL'); } catch (_) {} };
  process.on('exit', killAll);

  try {
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch(BASE + '/api/system/time')).ok) break; } catch {}
      await new Promise(r => setTimeout(r, 500));
    }

    // ورود + تغییر رمز اجباری
    let login = await api('POST', '/auth/login', { username: 'admin', password: 'admin123' });
    if (login.data.must_change_password) {
      TOKEN = login.data.token;
      await api('POST', '/auth/change-password', { oldPass: 'admin123', newPass: 'Cycle!t3st' });
      login = await api('POST', '/auth/login', { username: 'admin', password: 'Cycle!t3st' });
    }
    TOKEN = login.data.token;
    ok(!!TOKEN, 'ورود مدیر');

    console.log('— اطلاعات پایه —');
    const whs = (await api('GET', '/warehouses')).data;
    const whId = whs[0]?.id;
    ok(!!whId, 'انبار پیش‌فرض موجود است');

    const prod = (await api('POST', '/products/quick', { name: 'مانتو چرخه', price: 3500000 })).data;
    ok(!!prod.id, 'کالا ساخته شد');

    const sup = (await api('POST', '/suppliers', { name: 'تأمین‌کننده چرخه', phone: '05138000000' })).data;
    ok(!!sup.id, 'تأمین‌کننده ساخته شد');

    const cust = (await api('POST', '/customers', { biz: 'بوتیک چرخه', owner: 'خریدار', phone: '09150001100' })).data;
    ok(!!cust.id, 'مشتری ساخته شد');

    console.log('— ۱) خرید نسیه: ۱۰ عدد × ۲٬۰۰۰٬۰۰۰ ریال —');
    const buy = await api('POST', '/purchases', {
      supplier_id: sup.id, date: TODAY, pay_type: 'credit', warehouse_id: whId,
      rows: [{ product_id: prod.id, qty: 10, price: 2000000 }],
    });
    ok(buy.status === 200 && buy.data.id, 'فاکتور خرید ثبت شد', buy.data.num || buy.data.error);
    const purchaseTotal = 10 * 2000000;

    let p = (await api('GET', '/products/' + prod.id)).data;
    ok(Number(p.stock) === 10, 'موجودی بعد از خرید = ۱۰', p.stock);

    console.log('— ۲) پرداخت بخشی از بدهی تأمین‌کننده (۵٬۰۰۰٬۰۰۰ نقدی) —');
    const boxes = (await api('GET', '/cash-boxes')).data;
    const boxId = Array.isArray(boxes) && boxes[0] ? boxes[0].id : null;
    const pay = await api('POST', '/purchases/payments', {
      supplier_id: sup.id, amount: 5000000, pay_type: 'cash', date: TODAY, cash_box_id: boxId,
    });
    ok(pay.status === 200, 'پرداخت به تأمین‌کننده ثبت شد', pay.data.error);

    console.log('— ۳) فروش رسمی نسیه: ۴ عدد × ۳٬۵۰۰٬۰۰۰ ریال —');
    const inv = await api('POST', '/invoices', {
      cust_id: cust.id, type: 'final', date: TODAY, pay_type: 'credit', warehouse_id: whId,
      rows: [{ product_id: prod.id, qty: 4, price: 3500000 }],
    });
    ok(inv.status === 200 && inv.data.id, 'فاکتور فروش ثبت شد', inv.data.num || inv.data.error);
    // مبلغ نهایی فاکتور شامل مالیات ارزش‌افزوده است — از پاسخ سرور بخوان
    const saleFinal = Number(inv.data.final || 0);
    ok(saleFinal >= 4 * 3500000, 'مبلغ نهایی فاکتور (با احتساب VAT)', saleFinal);

    p = (await api('GET', '/products/' + prod.id)).data;
    ok(Number(p.stock) === 6, 'موجودی بعد از فروش = ۶', p.stock);

    console.log('— ۴) تسویه بخشی از مطالبات مشتری (۴٬۰۰۰٬۰۰۰ نقدی) —');
    const settle = await api('POST', '/accounting/settlements', {
      cust_id: cust.id, invoice_id: inv.data.id, amount: 4000000, pay_type: 'cash', date: TODAY, cash_box_id: boxId,
    });
    ok(settle.status === 200 && settle.data.id, 'تسویه ثبت شد', settle.data.error);

    console.log('— ۵) پرداخت هزینه (اجاره ۱٬۲۰۰٬۰۰۰ نقدی) —');
    const exp = await api('POST', '/expenses', {
      category: 'rent', title: 'اجاره کارگاه', amount: 1200000, pay_type: 'cash', date: TODAY, cash_box_id: boxId,
    });
    ok(exp.status === 200, 'هزینه ثبت شد', exp.data.error);

    console.log('— ۶) گزارش‌گیری و تطبیق —');
    const tb = (await api('GET', '/accounting/trial-balance')).data;
    ok(tb.balanced === true, 'تراز آزمایشی متوازن', `D=${tb.totalDebit} C=${tb.totalCredit}`);

    const bs = (await api('GET', '/accounting/balance-sheet')).data;
    const assets = Number(bs.totalAssets ?? bs.assetsTotal ?? NaN);
    const liabEq = Number(
      (bs.totalLiabilities ?? bs.liabilitiesTotal ?? 0)) + Number(bs.totalEquity ?? bs.equityTotal ?? 0);
    ok(approx(assets, liabEq, 5), 'ترازنامه: دارایی = بدهی + سرمایه', `A=${assets} L+E=${liabEq}`);

    const st = (await api('GET', '/accounting/statement/' + cust.id)).data;
    const expectedCustBalance = saleFinal - 4000000;
    ok(approx(st.closing, expectedCustBalance), 'صورت‌حساب مشتری: مانده = فروش − تسویه', `${st.closing} vs ${expectedCustBalance}`);

    const ivRes = await api('GET', '/adv-reports/inventory-valuation');
    const iv = ivRes.data;
    const ivRows = iv.rows || iv;
    const ivRow = Array.isArray(ivRows) ? ivRows.find(r => r.product_id === prod.id || r.id === prod.id || r.name === 'مانتو چرخه') : null;
    ok(!!ivRow && approx(Number(ivRow.stock ?? ivRow.qty), 6), 'ارزش‌گذاری موجودی: تعداد = ۶', ivRow && (ivRow.stock ?? ivRow.qty));

    // دفتر معین حساب پرداختنی تأمین‌کننده: خرید نسیه − پرداخت = مانده بستانکار
    const supLedger = (await api('GET', '/purchases/suppliers/' + sup.id + '/ledger')).data;
    if (supLedger && (supLedger.balance !== undefined || Array.isArray(supLedger))) {
      const balance = supLedger.balance ?? null;
      if (balance !== null) {
        ok(approx(Math.abs(balance), purchaseTotal - 5000000), 'دفتر تأمین‌کننده: مانده = خرید − پرداخت', balance);
      }
    }

    console.log('— ۷) ابطال فاکتور فروش (R13: برگشت کامل اثرها) —');
    const preVoidTb = (await api('GET', '/accounting/trial-balance')).data;
    const del = await api('DELETE', '/invoices/' + inv.data.id);
    ok(del.status === 200, 'ابطال فاکتور انجام شد', del.data.error);

    p = (await api('GET', '/products/' + prod.id)).data;
    ok(Number(p.stock) === 10, 'موجودی بعد از ابطال به ۱۰ برگشت', p.stock);

    const tb2 = (await api('GET', '/accounting/trial-balance')).data;
    ok(tb2.balanced === true, 'تراز بعد از ابطال همچنان متوازن', `D=${tb2.totalDebit} C=${tb2.totalCredit}`);

    const st2 = (await api('GET', '/accounting/statement/' + cust.id)).data;
    // ابطال فاکتور، تسویهٔ وابسته را هم ابطال می‌کند → مانده مشتری صفر
    ok(approx(st2.closing, 0), 'مانده مشتری بعد از ابطال صفر شد', st2.closing);

    console.log('— ۸) گزارش‌های فروش بعد از ابطال (نباید فاکتور ابطالی را بشمارند) —');
    const sum2 = (await api('GET', '/reports/summary')).data;
    ok(Number(sum2.revenue) === 0 && Number(sum2.orders) === 0, 'reports/summary: درآمد و تعداد بعد از ابطال صفر', `rev=${sum2.revenue} orders=${sum2.orders}`);
    ok(Number(sum2.debt) === 0, 'reports/summary: بدهی معوق صفر', sum2.debt);

    const top2 = (await api('GET', '/reports/top-customers')).data;
    ok(Array.isArray(top2) && !top2.some(r => r.id === cust.id && Number(r.total) > 0), 'top-customers بدون فاکتور ابطالی');

    const monthly2 = (await api('GET', '/reports/monthly')).data;
    const mSum = (monthly2 || []).reduce((a, r) => a + Number(r.revenue || 0), 0);
    ok(mSum === 0, 'گزارش ماهانه بعد از ابطال صفر', mSum);

    const gen2 = (await api('GET', '/accounting/general')).data;
    ok(Number(gen2.revenue) === 0, 'سود و زیان: درآمد بعد از ابطال صفر', gen2.revenue);

    // گزارش‌های مالیاتی: فاکتور ابطالی نباید در ارزش‌افزوده/فصلی بیاید (خرید زنده می‌ماند)
    const y = TODAY.slice(0, 4);
    const q = Math.ceil(Number(TODAY.slice(5, 7)) / 3);
    const vat2 = (await api('GET', `/reports/vat-return?quarter=${y}-Q${q}`)).data;
    ok(Number(vat2.invoice_output_rial || 0) === 0, 'اظهارنامه VAT: فروش ابطالی حذف شد', vat2.invoice_output_rial);
    const s169 = (await api('GET', `/reports/seasonal-169?quarter=${y}-Q${q}`)).data;
    ok(Number(s169.totals?.sales_count || 0) === 0, 'گزارش فصلی ۱۶۹: فاکتور ابطالی حذف شد', s169.totals?.sales_count);
    ok(Number(s169.totals?.purchase_count || 0) === 1, 'گزارش فصلی ۱۶۹: خرید زنده باقی است', s169.totals?.purchase_count);

    console.log(`\n${failed ? '💥' : '🎉'} ${passed} passed, ${failed} failed`);
    process.exitCode = failed ? 1 : 0;
  } catch (e) {
    console.error('TEST HARNESS ERROR:', e.message);
    process.exitCode = 1;
  } finally {
    killAll();
    setTimeout(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} }, 500);
  }
})();
