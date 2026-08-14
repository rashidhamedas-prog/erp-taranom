(function (global) {
  'use strict';

  var VERSION = '3.1';
  var COMPANY = 'پوشاک نمونه سپیدارگل';
  var MAKER = 'شرکت ترانه اندیشه پردازان ریان';
  var CURRENCY = 'تومان';
  var MONTHS = [
    '1404/06', '1404/07', '1404/08', '1404/09', '1404/10', '1404/11',
    '1404/12', '1405/01', '1405/02', '1405/03', '1405/04', '1405/05'
  ];
  var CITIES = ['مشهد', 'تهران', 'اصفهان', 'شیراز', 'تبریز', 'کرج', 'قم', 'اهواز'];
  var TYPES = ['بوتیک', 'فروشگاه', 'عمده‌فروش'];
  var STATUSES = ['vip', 'active', 'followup', 'silent', 'new'];
  var STAGES = ['lead', 'qualified', 'proposal', 'proforma', 'won', 'lost'];
  var OWNERS = [
    { id: 1, username: 'demo_manager', name: 'نرگس نمونه', role: 'sales_manager', roleLabel: 'مدیر فروش نمونه' },
    { id: 2, username: 'demo_sales', name: 'هستی نمونه', role: 'field_sales', roleLabel: 'کارشناس فروش نمونه' },
    { id: 3, username: 'demo_accountant', name: 'کیان نمونه', role: 'accounting', roleLabel: 'حسابدار نمونه' },
    { id: 4, username: 'demo_production', name: 'آرمین نمونه', role: 'production_manager', roleLabel: 'مدیر تولید نمونه' }
  ];
  var FG = [
    ['مانتو لینن بهاره', 'مانتو', 420000, 210000, 'کرم', 'L'],
    ['مانتو کتان تابستانی', 'مانتو', 380000, 190000, 'سبز', 'M'],
    ['مانتو جین', 'مانتو', 460000, 230000, 'آبی', 'L'],
    ['پالتو زمستانی', 'پالتو', 890000, 445000, 'شتری', 'XL'],
    ['کاپشن پاییزه', 'کاپشن', 620000, 310000, 'زیتونی', 'L'],
    ['شومیز کتان', 'شومیز', 280000, 120000, 'سفید', 'M'],
    ['شومیز ابریشمی', 'شومیز', 410000, 180000, 'صورتی', 'S'],
    ['بلوز آستین کوتاه', 'بلوز', 195000, 80000, 'نخودی', 'M'],
    ['بلوز راه‌راه', 'بلوز', 210000, 90000, 'سرمه‌ای', 'L'],
    ['تونیک گلدار', 'تونیک', 330000, 150000, 'گلبهی', 'L'],
    ['دامن راحت', 'دامن', 240000, 100000, 'مشکی', 'M'],
    ['شلوار راسته', 'شلوار', 270000, 110000, 'کرم', 'L'],
    ['شلوار پارچه‌ای', 'شلوار', 310000, 130000, 'خاکستری', 'M'],
    ['سارافون نخی', 'سارافون', 350000, 160000, 'آبی روشن', 'M'],
    ['کت رسمی', 'کت', 720000, 360000, 'ذغالی', 'L'],
    ['پیراهن بلند', 'پیراهن', 390000, 170000, 'سفید', 'L'],
    ['هودی پاییزه', 'هودی', 340000, 150000, 'سبز تیره', 'XL'],
    ['ست راحتی', 'ست', 480000, 220000, 'کرم', 'M'],
    ['مانتو اداری', 'مانتو', 510000, 250000, 'سورمه‌ای', 'L'],
    ['پالتو فوتر', 'پالتو', 980000, 490000, 'شتری', 'M'],
    ['شومیز گلدوزی', 'شومیز', 360000, 160000, 'سفید', 'S'],
    ['دامن کلوش', 'دامن', 260000, 110000, 'مشکی', 'M']
  ];
  var RM = [
    ['پارچه لینن نمونه', 'مواد اولیه', 85000, 85000, 'کرم', 'متر'],
    ['پارچه کتان نمونه', 'مواد اولیه', 72000, 72000, 'سفید', 'متر'],
    ['پارچه فوتر نمونه', 'مواد اولیه', 110000, 110000, 'شتری', 'متر'],
    ['آستر ساتن نمونه', 'مواد اولیه', 28000, 28000, 'کرم', 'متر'],
    ['دکمه صدفی نمونه', 'مواد اولیه', 4000, 4000, 'سفید', 'عدد'],
    ['نخ پلی‌استر نمونه', 'مواد اولیه', 12000, 12000, 'کرم', 'قرقره'],
    ['زیپ مخفی نمونه', 'مواد اولیه', 8000, 8000, 'مشکی', 'عدد'],
    ['برچسب بافت نمونه', 'مواد اولیه', 3000, 3000, 'کرم', 'عدد'],
    ['لایی سوزنی نمونه', 'مواد اولیه', 18000, 18000, 'سفید', 'متر'],
    ['نخ گلدوزی نمونه', 'مواد اولیه', 15000, 15000, 'طلایی', 'قرقره']
  ];

  function mulberry(seed) {
    var s = seed >>> 0;
    return function () {
      s = (Math.imul(1664525, s) + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }
  function pick(rand, arr) { return arr[Math.floor(rand() * arr.length)]; }
  function irand(rand, a, b) { return a + Math.floor(rand() * (b - a + 1)); }
  function phone(n) { return '0900001' + String(1000 + n).slice(-4); }
  function pad(n, w) { return String(n).padStart(w || 4, '0'); }
  function dateIn(month, rand) {
    return month + '/' + String(irand(rand, 1, 28)).padStart(2, '0');
  }

  function createSeed() {
    var rand = mulberry(20260815);
    var users = OWNERS.map(function (u) { return Object.assign({ sample: true }, u); });
    var warehouses = [
      { id: 1, name: 'انبار مرکزی مشهد', city: 'مشهد', sample: true },
      { id: 2, name: 'انبار پخش تهران', city: 'تهران', sample: true },
      { id: 3, name: 'انبار مواد اولیه', city: 'مشهد', sample: true }
    ];
    var first = ['زهره', 'سارا', 'مریم', 'نازنین', 'الهه', 'فریده', 'مهناز', 'شیرین', 'فاطمه', 'لیلا', 'محمود', 'حسن', 'علی', 'کیان', 'آرمین'];
    var last = ['احمدی', 'موسوی', 'حسینی', 'اکبری', 'کریمی', 'قادری', 'صادقی', 'کیانی', 'رضایی', 'نجفی', 'قاسمی', 'محمدی'];
    var shops = ['بهار', 'نسیم', 'گلستان', 'مروارید', 'آفتاب', 'سبز', 'ستاره', 'رز', 'سپید', 'طلایی', 'کاوه', 'الماس', 'لاله', 'یاس', 'شقایق', 'نرگس', 'سرو', 'باران', 'مهتاب', 'آذین'];

    var customers = [];
    var i;
    for (i = 0; i < 55; i++) {
      var kind = i < 40 ? 'customer' : (i < 50 ? 'lead' : 'rep');
      var owner = users[(i % 2) + 1];
      var balRoll = rand();
      var balance = 0;
      if (kind === 'customer') {
        if (balRoll < 0.45) balance = -irand(rand, 800000, 18000000);
        else if (balRoll > 0.82) balance = irand(rand, 400000, 6000000);
      }
      customers.push({
        id: i + 1,
        kind: kind,
        biz: (kind === 'rep' ? 'نماینده نمونه ' : 'فروشگاه نمونه ') + shops[i % shops.length] + ' ' + (Math.floor(i / shops.length) + 1),
        owner: pick(rand, first) + ' ' + pick(rand, last),
        city: pick(rand, CITIES),
        phone: phone(i + 1),
        type: pick(rand, TYPES),
        status: kind === 'lead' ? 'new' : pick(rand, STATUSES),
        balance: balance,
        salespersonId: owner.id,
        salesperson: owner.name,
        address: 'آدرس نمونه — ' + pick(rand, CITIES),
        risk: balRoll < 0.12 ? 'high' : (balRoll < 0.3 ? 'mid' : 'low'),
        lastOrderDate: dateIn(pick(rand, MONTHS), rand),
        sample: true
      });
    }

    var products = [];
    FG.forEach(function (row, idx) {
      products.push({
        id: idx + 1, name: row[0], cat: row[1], code: 'FG-' + pad(idx + 1, 3),
        price: row[2], cost: row[3], color: row[4], size: row[5], kind: 'fg', sample: true
      });
    });
    RM.forEach(function (row, idx) {
      products.push({
        id: FG.length + idx + 1, name: row[0], cat: row[1], code: 'RM-' + pad(idx + 1, 3),
        price: row[2], cost: row[3], color: row[4], size: row[5], kind: 'rm', sample: true
      });
    });

    var stock = [];
    var movements = [];
    var mid = 1;
    products.forEach(function (p) {
      warehouses.forEach(function (w) {
        if (p.kind === 'rm' && w.id !== 3) return;
        if (p.kind === 'fg' && w.id === 3) return;
        var reorder = p.kind === 'rm' ? 80 : 18;
        var qty = rand() < 0.22 ? irand(rand, 0, reorder - 1) : irand(rand, reorder + 8, reorder + 90);
        stock.push({ productId: p.id, warehouseId: w.id, qty: qty, reorderPoint: reorder, sample: true });
        movements.push({
          id: mid++, productId: p.id, warehouseId: w.id, qty: qty, kind: 'opening',
          date: '1404/06/01', ref: 'OPN-' + p.code, sample: true
        });
      });
    });

    var opportunities = [];
    for (i = 0; i < 45; i++) {
      var cust = customers[i % 50];
      opportunities.push({
        id: i + 1,
        customerId: cust.id,
        title: 'فرصت نمونه — ' + cust.biz,
        stage: STAGES[i % STAGES.length],
        amount: irand(rand, 2500000, 42000000),
        ownerId: cust.salespersonId,
        created: dateIn(MONTHS[i % MONTHS.length], rand),
        nextAction: 'پیگیری نمونه',
        sample: true
      });
    }

    var activities = [];
    var actTypes = ['تماس تلفنی', 'بازدید حضوری', 'پیام واتساپ', 'جلسه'];
    for (i = 0; i < 110; i++) {
      var opp = opportunities[i % opportunities.length];
      var oc = customers.find(function (c) { return c.id === opp.customerId; }) || customers[i % customers.length];
      activities.push({
        id: i + 1,
        customerId: oc.id,
        opportunityId: opp.id,
        date: dateIn(MONTHS[i % MONTHS.length], rand),
        type: pick(rand, actTypes),
        subject: 'پیگیری نمونه ' + (i + 1),
        priority: pick(rand, ['high', 'mid', 'low']),
        status: i % 5 === 0 ? 'done' : 'open',
        ownerId: oc.salespersonId,
        sample: true
      });
    }

    var invoices = [];
    var journals = [];
    var jid = 1;
    function addJournal(desc, date, lines, sourceType, sourceId) {
      var debit = 0, credit = 0;
      lines.forEach(function (ln) { debit += ln.debit; credit += ln.credit; });
      journals.push({
        id: jid, num: 'JE-' + pad(jid, 4), date: date, desc: desc,
        debit: debit, credit: credit, status: 'posted',
        sourceType: sourceType, sourceId: sourceId, lines: lines, sample: true
      });
      jid += 1;
    }

    for (i = 0; i < 110; i++) {
      var ic = customers[i % 40];
      var p1 = products[i % FG.length];
      var p2 = products[(i + 3) % FG.length];
      var qty1 = irand(rand, 3, 16);
      var qty2 = irand(rand, 2, 10);
      var disc = rand() < 0.28 ? irand(rand, 3, 12) : 0;
      var freight = rand() < 0.2 ? irand(rand, 80000, 350000) : 0;
      var subtotal = qty1 * p1.price + qty2 * p2.price;
      var discAmt = Math.round(subtotal * disc / 100);
      var finalAmt = subtotal - discAmt + freight;
      var type = i % 5 === 0 ? 'proforma' : (i % 5 === 1 ? 'final' : 'normal');
      var month = MONTHS[i % MONTHS.length];
      var invDate = dateIn(month, rand);
      var paid = type !== 'proforma' && rand() < 0.62;
      invoices.push({
        id: i + 1,
        num: 'T-' + pad(i + 1, 4),
        customerId: ic.id,
        cust: ic.biz,
        type: type,
        date: invDate,
        month: month,
        subtotal: subtotal,
        disc: disc,
        discAmt: discAmt,
        freight: freight,
        final: finalAmt,
        paid: paid,
        salespersonId: ic.salespersonId,
        lines: [
          { productId: p1.id, qty: qty1, price: p1.price },
          { productId: p2.id, qty: qty2, price: p2.price }
        ],
        sample: true
      });
      if (type !== 'proforma') {
        addJournal('فروش ' + 'T-' + pad(i + 1, 4), invDate, [
          { account: '1103 دریافتنی', debit: finalAmt, credit: 0 },
          { account: '4101 فروش', debit: 0, credit: subtotal - discAmt },
          { account: '4102 حمل', debit: 0, credit: freight }
        ].filter(function (ln) { return ln.debit || ln.credit; }), 'invoice', i + 1);
        var cogs = qty1 * p1.cost + qty2 * p2.cost;
        addJournal('بهای تمام‌شده ' + 'T-' + pad(i + 1, 4), invDate, [
          { account: '5101 بهای تمام‌شده', debit: cogs, credit: 0 },
          { account: '1105 موجودی کالا', debit: 0, credit: cogs }
        ], 'cogs', i + 1);
      }
    }

    var purchases = [];
    for (i = 0; i < 18; i++) {
      var mat = products[FG.length + (i % RM.length)];
      var pq = irand(rand, 40, 200);
      purchases.push({
        id: i + 1, num: 'P-' + pad(i + 1, 4), date: dateIn(MONTHS[i % MONTHS.length], rand),
        sup: 'تأمین‌کننده نمونه پارچه ' + (1 + (i % 4)),
        productId: mat.id, qty: pq, final: pq * mat.cost, status: 'ثبت‌شده', sample: true
      });
    }

    var returns = [];
    for (i = 0; i < 8; i++) {
      var ri = invoices[i * 7];
      returns.push({
        id: i + 1, num: 'RT-' + pad(i + 1, 3), invoiceId: ri.id, customerId: ri.customerId,
        date: ri.date, final: Math.round(ri.final * 0.15), reason: 'مرجوعی نمونه', sample: true
      });
    }

    var boms = [
      { id: 1, productId: 1, name: 'فرمول مانتو لینن بهاره', lines: [{ materialId: 23, qty: 2.4 }, { materialId: 26, qty: 1.2 }, { materialId: 27, qty: 8 }, { materialId: 28, qty: 1 }] },
      { id: 2, productId: 4, name: 'فرمول پالتو زمستانی', lines: [{ materialId: 25, qty: 3.1 }, { materialId: 26, qty: 2 }, { materialId: 31, qty: 2.2 }, { materialId: 27, qty: 10 }] },
      { id: 3, productId: 6, name: 'فرمول شومیز کتان', lines: [{ materialId: 24, qty: 1.6 }, { materialId: 28, qty: 1 }, { materialId: 32, qty: 1 }] },
      { id: 4, productId: 15, name: 'فرمول کت رسمی', lines: [{ materialId: 25, qty: 2.2 }, { materialId: 26, qty: 1.4 }, { materialId: 29, qty: 1 }, { materialId: 31, qty: 1 }] }
    ].map(function (b) { b.sample = true; return b; });

    var pStatuses = ['draft', 'in_progress', 'delayed', 'done', 'in_progress', 'done', 'delayed', 'draft', 'in_progress', 'done', 'delayed', 'done'];
    var productionOrders = [];
    for (i = 0; i < 12; i++) {
      var fp = products[i % 8];
      var moQty = irand(rand, 20, 80);
      productionOrders.push({
        id: i + 1, num: 'MO-' + pad(i + 1, 3), productId: fp.id, product: fp.name,
        qty: moQty, status: pStatuses[i],
        due: dateIn(MONTHS[6 + (i % 6)], rand), warehouseId: 1,
        cost: fp.cost * moQty, sample: true
      });
    }

    var receipts = [];
    var methods = ['cash', 'card', 'transfer', 'cheque'];
    invoices.filter(function (inv) { return inv.type !== 'proforma' && inv.paid; }).slice(0, 48).forEach(function (inv, idx) {
      receipts.push({
        id: idx + 1, customerId: inv.customerId, invoiceId: inv.id,
        method: methods[idx % 4], amount: inv.final, date: inv.date, sample: true
      });
      addJournal('دریافت فاکتور ' + inv.num, inv.date, [
        { account: idx % 4 === 0 ? '1101 صندوق' : '1102 بانک', debit: inv.final, credit: 0 },
        { account: '1103 دریافتنی', debit: 0, credit: inv.final }
      ], 'receipt', idx + 1);
    });

    var chequeStatus = ['open', 'cleared', 'bounced', 'overdue'];
    var cheques = [];
    for (i = 0; i < 16; i++) {
      var cq = customers[i];
      cheques.push({
        id: i + 1, num: 'CH-' + pad(8800 + i, 4), kind: i % 5 === 0 ? 'پرداختی' : 'دریافتی',
        partyId: cq.id, party: cq.biz, date: dateIn(MONTHS[8 + (i % 4)], rand),
        amount: irand(rand, 1200000, 14000000), status: chequeStatus[i % 4], sample: true
      });
    }

    var banks = [
      { id: 1, name: 'بانک نمونه ملت — جاری', no: '010-2200-001', balance: 186000000, sample: true },
      { id: 2, name: 'بانک نمونه صادرات — پشتیبان', no: '019-8800-014', balance: 54000000, sample: true }
    ];
    var cashBoxes = [
      { id: 1, name: 'صندوق فروشگاه نمونه', balance: 12800000, sample: true }
    ];

    customers.forEach(function (c) {
      var sold = 0, got = 0;
      invoices.forEach(function (inv) {
        if (inv.customerId === c.id && inv.type !== 'proforma') sold += inv.final;
      });
      receipts.forEach(function (r) {
        if (r.customerId === c.id) got += r.amount;
      });
      c.balance = got - sold;
    });
    if (!customers.some(function (c) { return c.balance > 0; })) {
      customers[0].balance += 2500000;
      receipts.push({
        id: receipts.length + 1, customerId: customers[0].id, invoiceId: invoices[0].id,
        method: 'transfer', amount: 2500000, date: '1405/05/01', sample: true
      });
      addJournal('پیش‌دریافت نمونه', '1405/05/01', [
        { account: '1102 بانک', debit: 2500000, credit: 0 },
        { account: '1103 دریافتنی', debit: 0, credit: 2500000 }
      ], 'receipt', receipts.length);
    }

    var coaMap = {};
    journals.forEach(function (j) {
      (j.lines || []).forEach(function (ln) {
        var key = ln.account;
        if (!coaMap[key]) coaMap[key] = { code: String(key).slice(0, 4), name: key, kind: 'حساب', debit: 0, credit: 0 };
        coaMap[key].debit += ln.debit || 0;
        coaMap[key].credit += ln.credit || 0;
      });
    });
    var coa = Object.keys(coaMap).map(function (k) { return coaMap[k]; });
    if (!coa.length) {
      coa = [{ code: '1103', name: 'دریافتنی', kind: 'دارایی', debit: 0, credit: 0 }];
    }

    var notifications = [
      { id: 1, text: 'سه چک دریافتی نزدیک سررسید است', level: 'warn' },
      { id: 2, text: 'دو سفارش تولید عقب افتاده است', level: 'danger' },
      { id: 3, text: 'موجودی مانتو لینن زیر نقطه سفارش است', level: 'warn' },
      { id: 4, text: 'یک مشتری VIP بدون پیگیری مانده', level: 'info' },
      { id: 5, text: 'سفارش پورتال B2B جدید ثبت شده', level: 'info' },
      { id: 6, text: 'فاکتور پیش‌نویس آماده تبدیل است', level: 'info' }
    ];
    var tasks = [
      { id: 1, title: 'وصول چک سررسید امروز', due: '1405/05/24', status: 'overdue' },
      { id: 2, title: 'تأیید سفارش تولید MO-003', due: '1405/05/22', status: 'overdue' },
      { id: 3, title: 'پیگیری بوتیک نمونه الماس', due: '1405/05/24', status: 'open' },
      { id: 4, title: 'بررسی کسری پارچه لینن', due: '1405/05/25', status: 'open' },
      { id: 5, title: 'مرور سود ماه', due: '1405/05/26', status: 'open' },
      { id: 6, title: 'پاسخ سفارش B2B', due: '1405/05/23', status: 'overdue' }
    ];
    var b2bOrders = [];
    for (i = 0; i < 8; i++) {
      var bc = customers[i];
      b2bOrders.push({
        id: i + 1, num: 'B2B-' + pad(i + 1, 3), customerId: bc.id, cust: bc.biz,
        date: dateIn(MONTHS[9 + (i % 3)], rand), final: irand(rand, 4000000, 22000000),
        status: pick(rand, ['جدید', 'تأیید شده', 'ارسال شده']), sample: true
      });
    }

    return {
      meta: {
        version: VERSION, company: COMPANY, maker: MAKER, currency: CURRENCY,
        generatedAt: '1405/05/24', sample: true
      },
      users: users,
      customers: customers,
      opportunities: opportunities,
      activities: activities,
      products: products,
      warehouses: warehouses,
      stock: stock,
      movements: movements,
      invoices: invoices,
      purchases: purchases,
      returns: returns,
      boms: boms,
      productionOrders: productionOrders,
      receipts: receipts,
      cheques: cheques,
      banks: banks,
      cashBoxes: cashBoxes,
      journals: journals,
      coa: coa,
      notifications: notifications,
      tasks: tasks,
      b2bOrders: b2bOrders
    };
  }

  function validateSeed(data) {
    var fails = [];
    if (!data || !data.meta) { return { ok: false, fails: ['داده خالی است'] }; }
    if (!/نمونه/.test(data.meta.company || '')) fails.push('نام شرکت نمونه نیست');
    var parties = (data.customers || []).filter(function (c) {
      return c.kind === 'customer' || c.kind === 'lead' || c.kind === 'rep';
    });
    if (parties.length < 50) fails.push('اشخاص کمتر از ۵۰');
    if ((data.opportunities || []).length < 40) fails.push('فرصت‌ها کمتر از ۴۰');
    var stages = {};
    (data.opportunities || []).forEach(function (o) { stages[o.stage] = 1; });
    ['lead', 'qualified', 'proposal', 'proforma', 'won', 'lost'].forEach(function (s) {
      if (!stages[s]) fails.push('مرحله فرصت نیست: ' + s);
    });
    if ((data.activities || []).length < 100) fails.push('پیگیری‌ها کمتر از ۱۰۰');
    if ((data.invoices || []).length < 100) fails.push('فاکتورها کمتر از ۱۰۰');
    var months = {};
    (data.invoices || []).forEach(function (inv) { months[inv.month] = 1; });
    if (Object.keys(months).length < 12) fails.push('بازه‌فروش کمتر از ۱۲ ماه');
    if ((data.products || []).length < 30) fails.push('کالاها کمتر از ۳۰');
    if (!(data.products || []).every(function (p) { return p.color && p.size && p.cat; })) fails.push('کالا بدون رنگ/سایز/دسته');
    if ((data.warehouses || []).length < 3) fails.push('انبار کمتر از ۳');
    if ((data.productionOrders || []).length < 10) fails.push('سفارش تولید کمتر از ۱۰');
    var pst = {};
    (data.productionOrders || []).forEach(function (o) { pst[o.status] = 1; });
    ['draft', 'in_progress', 'delayed', 'done'].forEach(function (s) {
      if (!pst[s]) fails.push('وضعیت تولید نیست: ' + s);
    });
    if ((data.boms || []).length < 3) fails.push('BOM کمتر از ۳');
    var methods = {};
    (data.receipts || []).forEach(function (r) { methods[r.method] = 1; });
    ['cash', 'card', 'transfer', 'cheque'].forEach(function (m) {
      if (!methods[m]) fails.push('روش دریافت نیست: ' + m);
    });
    var cst = {};
    (data.cheques || []).forEach(function (c) { cst[c.status] = 1; });
    ['open', 'cleared', 'bounced', 'overdue'].forEach(function (s) {
      if (!cst[s]) fails.push('وضعیت چک نیست: ' + s);
    });
    if ((data.banks || []).length < 2) fails.push('بانک کمتر از ۲');
    if ((data.cashBoxes || []).length < 1) fails.push('صندوق نیست');
    var jd = 0, jc = 0, unbalanced = 0;
    (data.journals || []).forEach(function (j) {
      jd += j.debit; jc += j.credit;
      if (j.debit !== j.credit) unbalanced += 1;
    });
    if (jd !== jc) fails.push('جمع اسناد متوازن نیست');
    if (unbalanced) fails.push('سند نامتوازن وجود دارد');
    var debC = (data.customers || []).some(function (c) { return c.balance < 0; });
    var credC = (data.customers || []).some(function (c) { return c.balance > 0; });
    if (!debC || !credC) fails.push('مانده بدهکار و بستانکار اشخاص ناقص است');
    if ((data.notifications || []).length < 5) fails.push('اعلان کمتر از ۵');
    if ((data.tasks || []).filter(function (t) { return t.status === 'overdue'; }).length < 1) fails.push('کار عقب‌افتاده نیست');
    if ((data.tasks || []).length < 5) fails.push('کارها کمتر از ۵');
    if ((data.b2bOrders || []).length < 5) fails.push('سفارش B2B کمتر از ۵');
    var roles = {};
    (data.users || []).forEach(function (u) { roles[u.role] = 1; if (u.password) fails.push('رمز در کاربر نمونه'); });
    ['sales_manager', 'field_sales', 'accounting', 'production_manager'].forEach(function (r) {
      if (!roles[r]) fails.push('نقش نیست: ' + r);
    });
    if (!(data.purchases || []).length) fails.push('خرید نیست');
    if (!(data.returns || []).length) fails.push('مرجوعی نیست');
    if (!(data.invoices || []).some(function (inv) { return inv.disc > 0; })) fails.push('تخفیف نیست');
    if (!(data.invoices || []).some(function (inv) { return inv.freight > 0; })) fails.push('هزینه حمل نیست');
    var low = (data.stock || []).some(function (s) { return s.qty < s.reorderPoint; });
    var ok = (data.stock || []).some(function (s) { return s.qty >= s.reorderPoint; });
    if (!low || !ok) fails.push('ترکیب موجودی سالم/کمبود ناقص است');
    function linked(list, field) {
      return (list || []).every(function (row) { return row[field]; });
    }
    if (!linked(data.opportunities, 'customerId')) fails.push('فرصت بدون مشتری');
    if (!linked(data.invoices, 'customerId')) fails.push('فاکتور بدون مشتری');
    if (!linked(data.activities, 'customerId')) fails.push('پیگیری بدون مشتری');
    if (!linked(data.receipts, 'invoiceId')) fails.push('دریافت بدون فاکتور');
    if (!linked(data.journals, 'sourceId')) fails.push('سند بدون منبع');
    if (!linked(data.productionOrders, 'productId')) fails.push('تولید بدون کالا');
    if (!(data.stock || []).every(function (s) { return s.productId && s.warehouseId; })) fails.push('موجودی بدون کالا/انبار');
    if (!linked(data.boms, 'productId')) fails.push('BOM بدون کالا');
    var custNames = {};
    (data.customers || []).forEach(function (c) { custNames[c.biz] = 1; });
    if ((data.cheques || []).some(function (c) { return !custNames[c.party]; })) fails.push('چک بدون شخص مرتبط');
    return { ok: fails.length === 0, fails: fails };
  }

  var api = {
    VERSION: VERSION,
    COMPANY: COMPANY,
    MAKER: MAKER,
    CURRENCY: CURRENCY,
    createSeed: createSeed,
    validateSeed: validateSeed
  };
  global.DemoV3Seed = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
