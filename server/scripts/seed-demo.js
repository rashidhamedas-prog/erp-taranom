#!/usr/bin/env node
// Seed a DEMO database for ERP Taranom — for presentations.
//
//   node server/scripts/seed-demo.js /path/to/demo.db [port]
//
// This is NOT a row-inserter: it boots the real server against the target DB
// and drives the real HTTP APIs, so every invoice/receipt/payroll goes through
// the actual double-entry posting logic — the demo's Trial Balance is balanced
// exactly like production. Rich Persian sample data across all modules:
// users, banks, cash boxes, warehouses, suppliers, product categories,
// ~60 products, ~15 purchase invoices (stock), ~40 customers, ~60 followups,
// ~150 sales invoices over ~4 months, ~100 receipts (cash/bank/cheque),
// expenses, production runs, payroll. Login for presenting: demo / demo1234.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { todayJalali, addDaysToJalali } = require('../jalali');

const DB = path.resolve(process.argv[2] || 'demo.db');
const PORT = parseInt(process.argv[3] || '4499', 10);
const BASE = `http://127.0.0.1:${PORT}`;

if (fs.existsSync(DB)) { console.error(`✋ ${DB} already exists — delete it first (demo seeds must start clean).`); process.exit(1); }
fs.mkdirSync(path.dirname(DB), { recursive: true });

// Deterministic PRNG so every demo build looks the same
let _s = 42;
function rnd() { _s = (_s * 1103515245 + 12345) % 2147483648; return _s / 2147483648; }
function ri(min, max) { return min + Math.floor(rnd() * (max - min + 1)); }
function pick(arr) { return arr[Math.floor(rnd() * arr.length)]; }

let TOKEN = '';
async function api(method, p, body) {
  const r = await fetch(BASE + '/api' + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${p} → ${r.status}: ${data.error || JSON.stringify(data)}`);
  return data;
}

async function main() {
  console.log('==> booting server for seeding:', DB);
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, DB_PATH: DB, PORT: String(PORT), JWT_SECRET: 'demo-seed-secret', UPLOADS_DIR: path.join(path.dirname(DB), 'uploads') },
    stdio: 'ignore', detached: false
  });
  try {
    // wait until it answers
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      try { const r = await fetch(BASE + '/api/system/time'); up = r.ok; } catch { }
      if (!up) await new Promise(r => setTimeout(r, 500));
    }
    if (!up) throw new Error('server did not come up');

    const login = await api('POST', '/auth/login', { username: 'admin', password: 'admin123' });
    TOKEN = login.token;
    const today = todayJalali();
    const daysAgo = n => addDaysToJalali(today, -n);

    // ---- demo presenter account + staff ----
    await api('POST', '/admin/users', { name: 'مدیر نمایشی', username: 'demo', password: 'demo1234', role: 'admin' });
    const sara = (await api('POST', '/admin/users', { name: 'سارا محمدی', username: 'sara', password: 'demo1234', role: 'salesperson', phone: '09151112233' })).id;
    const reza = (await api('POST', '/admin/users', { name: 'رضا کریمی', username: 'reza', password: 'demo1234', role: 'salesperson', phone: '09153334455' })).id;
    await api('POST', '/admin/users', { name: 'مریم حسینی', username: 'maryam', password: 'demo1234', role: 'accounting', phone: '09155556677' });
    console.log('✓ users');

    // ---- treasury ----
    const bankMellat = (await api('POST', '/banks', { name: 'بانک ملت — جاری', account_number: '4587-221001', branch: 'شعبه احمدآباد مشهد' })).id;
    const bankMelli = (await api('POST', '/banks', { name: 'بانک ملی — جاری', account_number: '0110-885542', branch: 'شعبه خیام' })).id;
    const boxMain = (await api('POST', '/cash-boxes', { name: 'صندوق فروشگاه' })).id;
    await api('POST', '/cash-boxes', { name: 'تنخواه کارگاه', custodian: 'آقای رحیمی', is_petty_cash: 1 });
    try { await api('POST', '/check-categories', { name: 'دسته‌چک ملت ۴۵۸۷' }); } catch { }
    console.log('✓ banks / cash boxes');

    // ---- warehouses ----
    try {
      await api('POST', '/warehouses', { name: 'انبار مرکزی', location: 'کارگاه تولید — مشهد' });
      await api('POST', '/warehouses', { name: 'انبار نمایشگاه', location: 'فروشگاه مرکزی' });
    } catch (e) { console.log('  (warehouses:', e.message.slice(0, 80), ')'); }

    // ---- suppliers ----
    const supplierNames = ['پارچه‌سرای ابریشم', 'نساجی خاوران', 'تولیدی نخ و پود', 'پخش یراق آلات شرق', 'چاپ و تکمیل پارچه رضوی'];
    const suppliers = [];
    for (const name of supplierNames) suppliers.push((await api('POST', '/suppliers', { name, phone: '0513' + ri(1000000, 9999999) })).id);
    console.log('✓ suppliers');

    // ---- product categories + products ----
    const catNames = ['مانتو', 'شومیز', 'شلوار', 'پیراهن', 'ست راحتی', 'اکسسوری'];
    const cats = {};
    for (const c of catNames) { try { cats[c] = (await api('POST', '/products/categories', { name: c })).id; } catch { cats[c] = null; } }
    const models = ['آیلین', 'رز', 'ترمه', 'نیلا', 'گلاره', 'یاس', 'افرا', 'دلسا', 'رها', 'مهتاب'];
    const fabrics = ['کرپ', 'لینن', 'حریر', 'مازراتی', 'ژاکارد', 'نخی'];
    const products = [];
    for (let i = 0; i < 60; i++) {
      const cat = catNames[i % catNames.length];
      const name = `${cat} ${pick(fabrics)} مدل ${pick(models)}${i >= 30 ? ' ' + (i - 28) : ''}`;
      const price = ri(38, 260) * 10000;                     // 380,000 تا 2,600,000 ریال
      const cost = Math.round(price * (0.55 + rnd() * 0.15) / 1000) * 1000;
      const p = await api('POST', '/products', {
        name, code: 'T-' + String(101 + i), category_id: cats[cat] || undefined, category: cat,
        price, cost, stock: 0, stock_alert: 6, unit: 'عدد', pack_size: pick([1, 3, 6])
      });
      products.push({ id: p.id, price, cost });
    }
    console.log('✓ 60 products');

    // ---- purchases (stock in, oldest first) ----
    // هر ۶۰ محصول در هر خرید حضور دارند تا موجودی کافی برای ۱۵۰ فاکتور فروش ساخته شود
    for (let i = 0; i < 15; i++) {
      const slice = products.slice((i % 3) * 20, (i % 3) * 20 + 20);
      const rows = slice.map(pr => ({ product_id: pr.id, qty: ri(40, 90), price: pr.cost }));
      await api('POST', '/purchases', {
        supplier_id: pick(suppliers), date: daysAgo(ri(95, 120)), rows,
        pay_type: pick(['credit', 'credit', 'cash', 'bank']), bank_id: bankMellat, note: 'خرید فصل'
      });
    }
    console.log('✓ 15 purchase invoices (stock loaded)');

    // ---- customers ----
    const shopKinds = ['بوتیک', 'پوشاک', 'گالری', 'مزون', 'فروشگاه'];
    const shopNames = ['گلاره', 'نگین', 'آوا', 'سُها', 'رویال', 'ماهور', 'آرام', 'شمیم', 'پرنیان', 'دنیز',
      'هستی', 'باران', 'ارغوان', 'ملورین', 'ترانه', 'لیان', 'آناهید', 'مروارید', 'صدف', 'یلدا',
      'نارین', 'شب‌بو', 'افسون', 'رخ', 'بانو', 'دیبا', 'حریر', 'ونوس', 'ماندگار', 'آبان',
      'کژال', 'ژینا', 'روناک', 'سایان', 'المیرا', 'شکوه', 'بهار', 'غزال', 'نیلوفر', 'ستاره'];
    const owners = ['خانم احمدی', 'خانم رضایی', 'آقای موسوی', 'خانم کریمی', 'خانم صادقی', 'آقای قاسمی', 'خانم نادری', 'خانم شریفی'];
    const cities = ['مشهد', 'مشهد', 'مشهد', 'نیشابور', 'سبزوار', 'بجنورد', 'گرگان', 'بیرجند', 'تهران', 'قوچان', 'تربت حیدریه'];
    const customers = [];
    for (let i = 0; i < 40; i++) {
      const c = await api('POST', '/customers', {
        biz: `${pick(shopKinds)} ${shopNames[i]}`, owner: pick(owners), city: pick(cities),
        phone: '0915' + ri(1000000, 9999999), type: pick(['بوتیک', 'عمده‌فروش', 'بوتیک']),
        status: pick(['active', 'active', 'vip', 'new', 'followup']),
        assigned_to: i % 2 ? sara : reza, auto_followup: 0,
        note: i % 5 === 0 ? 'بازدید حضوری هر دوشنبه — سلیقه: رنگ‌های خنثی' : ''
      });
      customers.push(c.id);
    }
    console.log('✓ 40 customers');

    // ---- followups / pipeline ----
    const subjects = ['معرفی کالکشن جدید', 'پیگیری سفارش قبلی', 'اعلام موجودی مانتو کرپ', 'هماهنگی ارسال بار', 'مذاکره تخفیف حجمی', 'دعوت به نمایشگاه'];
    for (let i = 0; i < 60; i++) {
      await api('POST', '/followups', {
        cust_id: pick(customers), date: daysAgo(ri(0, 60)), type: pick(['call', 'visit', 'message']),
        subject: pick(subjects), note: 'در تماس تلفنی توضیح داده شد.',
        next_date: rnd() < 0.5 ? addDaysToJalali(today, ri(1, 14)) : '',
        status: pick(['open', 'open', 'done']), priority: pick(['high', 'mid', 'mid', 'low']),
        pipeline_stage: pick(['lead', 'contact', 'proposal', 'negotiation', 'won']),
        interest_level: pick(['mid', 'high', 'very_high'])
      });
    }
    console.log('✓ 60 followups');

    // ---- sales invoices over ~4 months (ascending dates) ----
    let createdFinal = 0, createdProforma = 0, invErrors = [];
    for (let i = 0; i < 150; i++) {
      const age = Math.round(92 - (i / 149) * 92);           // 92 روز پیش → امروز
      const rows = [];
      const n = ri(2, 5);
      for (let k = 0; k < n; k++) { const pr = pick(products); rows.push({ product_id: pr.id, qty: ri(2, 6), price: pr.price, disc: rnd() < 0.2 ? 5 : 0 }); }
      const isFinal = rnd() < 0.8;
      const payload = {
        cust_id: pick(customers), type: isFinal ? 'final' : 'proforma', date: daysAgo(age),
        rows, disc: rnd() < 0.25 ? 3 : 0, pay_type: 'cash'
      };
      try {
        await api('POST', '/invoices', payload);
        isFinal ? createdFinal++ : createdProforma++;
      } catch (e) {
        // موجودی ناکافی؟ همان فاکتور را با تعداد ۱ عدد در هر ردیف دوباره بزن
        try {
          payload.rows = payload.rows.map(r => ({ ...r, qty: 1 }));
          await api('POST', '/invoices', payload);
          isFinal ? createdFinal++ : createdProforma++;
        } catch (e2) { if (invErrors.length < 3) invErrors.push(e2.message); }
      }
    }
    console.log(`✓ invoices: ${createdFinal} final + ${createdProforma} proforma`);
    if (invErrors.length) console.log('  sample invoice errors:', invErrors.join(' | '));

    // ---- receipts: cash / bank / cheque, partial + full ----
    const invDetails = await api('GET', '/invoices');
    const finals = (Array.isArray(invDetails) ? invDetails : invDetails.rows || []).filter(v => v.type === 'final');
    let receipts = 0;
    for (const inv of finals) {
      if (rnd() < 0.25) continue;                            // ~۲۵٪ کاملاً نسیه بمانند (مطالبات)
      const full = rnd() < 0.6;
      const amount = full ? inv.final : Math.round(inv.final * pick([0.3, 0.5, 0.7]) / 1000) * 1000;
      const kind = pick(['cash', 'cash', 'bank', 'cheque']);
      const body = {
        cust_id: inv.cust_id, invoice_id: inv.id, amount, pay_type: kind,
        date: addDaysToJalali(inv.date || today, ri(1, 12)), note: ''
      };
      if (kind === 'cash') body.cash_box_id = boxMain;
      if (kind === 'bank') body.bank_id = pick([bankMellat, bankMelli]);
      if (kind === 'cheque') Object.assign(body, {
        cheque_bank: pick(['ملت', 'ملی', 'صادرات']), cheque_number: String(ri(100000, 999999)),
        cheque_sayadi: String(ri(1e15, 9e15)), cheque_amount: amount,
        cheque_owner: 'صاحب فروشگاه', cheque_due: addDaysToJalali(today, ri(10, 60)), cheque_status: 'pending'
      });
      try { await api('POST', '/accounting/settlements', body); receipts++; } catch { }
    }
    console.log(`✓ ${receipts} receipts (cash/bank/cheque)`);

    // ---- expenses ----
    const expenses = [
      ['اجاره', 'اجاره کارگاه تیرماه', 25000000], ['حقوق و دستمزد', 'اضافه‌کار بسته‌بندی', 4500000],
      ['آب و برق و گاز', 'قبض برق کارگاه', 3800000], ['حمل و نقل', 'باربری ارسال گرگان', 2200000],
      ['ملزومات', 'خرید کاور و آویز', 1600000], ['تبلیغات', 'کمپین اینستاگرام', 8000000],
      ['اینترنت و تلفن', 'اینترنت + خط ثابت', 900000], ['تعمیرات', 'سرویس چرخ راسته‌دوزی', 1200000]
    ];
    for (const [category, title, amount] of expenses) {
      await api('POST', '/expenses', { category, title, amount, pay_type: 'cash', cash_box_id: boxMain, date: daysAgo(ri(3, 40)), is_overhead: ['اجاره', 'آب و برق و گاز'].includes(category) ? 1 : 0 });
    }
    console.log('✓ expenses');

    // ---- production runs ----
    for (let i = 0; i < 6; i++) {
      const pr = pick(products);
      const qty = ri(30, 80);
      await api('POST', '/production', {
        product_id: pr.id, qty_produced: qty,
        material_cost: qty * ri(90, 160) * 1000, labor_cost: qty * ri(25, 45) * 1000,
        overhead_cost: qty * 8000, packaging_cost: qty * 4000,
        date: daysAgo(ri(5, 70)), update_stock: 1, update_cost: 0, note: 'سری تولید ' + (i + 1)
      });
    }
    console.log('✓ 6 production runs');

    // ---- staff persons + payroll ----
    let empCat = null;
    try { empCat = (await api('POST', '/persons/categories', { name: 'کارمند' })).id; } catch { }
    const staff = [['فاطمه یزدانی', 850000], ['زهرا کاظمی', 820000], ['علی رستمی', 900000], ['نرگس عابدی', 800000], ['حسین توکلی', 870000]];
    const period = today.slice(0, 7);                        // '1404/04'
    for (const [name, rate] of staff) {
      const person = await api('POST', '/persons', { name, category_id: empCat || undefined, phone: '0915' + ri(1000000, 9999999), hourly_rate: rate, overtime_rate: Math.round(rate * 1.4) });
      const rec = await api('POST', '/payroll', {
        person_id: person.id, period_label: period, regular_hours: ri(170, 192), overtime_hours: ri(0, 24),
        hourly_rate: rate, overtime_rate: Math.round(rate * 1.4), bonuses: ri(0, 3) * 1000000,
        insurance_deduction: 2400000, tax_deduction: 800000, date: today
      });
      if (rnd() < 0.6) { try { await api('POST', `/payroll/${rec.id}/pay`, { pay_type: 'bank', bank_id: bankMellat, date: today }); } catch { } }
    }
    console.log('✓ 5 staff + payroll (some paid)');

    // ---- reminders ----
    for (const [title, days] of [['پیگیری چک‌های سررسید هفته آینده', 3], ['تماس با پارچه‌سرای ابریشم — سفارش پارچه پاییزه', 5], ['آماده‌سازی کالکشن نمایشگاه', 10]]) {
      try { await api('POST', '/reminders', { title, date: addDaysToJalali(today, days), note: '' }); } catch { }
    }

    // ---- verify the books ----
    let balanced = null;
    try {
      const tb = await api('GET', '/accounting/trial-balance');
      balanced = !!tb.balanced;
      console.log(`==> Trial balance: debit=${Math.round(tb.totalDebit)} credit=${Math.round(tb.totalCredit)} → ${balanced ? 'BALANCED ✅' : 'NOT BALANCED ❌'}`);
    } catch (e) { console.log('  (trial-balance check skipped:', e.message.slice(0, 60), ')'); }

    console.log('\n🎬 DEMO DB ready:', DB);
    console.log('   ورود ارائه: demo / demo1234   (فروشنده: sara یا reza / demo1234)');
    if (balanced === false) process.exitCode = 1;
  } finally {
    srv.kill();
  }
}

main().catch(e => { console.error('SEED FAILED:', e.message); process.exit(1); });
