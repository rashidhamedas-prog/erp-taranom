(function (global) {
  'use strict';

  var S = null;
  var page = 'dash';
  var history = [];
  var inAcc = false;
  var charts = [];
  var filters = { q: '', shortage: false, delayed: false, rm: false, saleJe: false, range: 'month' };
  var ACC_NAV_COLLAPSED = new Set();

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }
  function fmt(n) { return Number(n || 0).toLocaleString('fa-IR'); }
  function toman(n) { return fmt(n) + ' تومان'; }
  function el(id) {
    var n = typeof document !== 'undefined' && document.getElementById ? document.getElementById(id) : null;
    if (n) return n;
    if (id === 'view') return { innerHTML: '', focus: function () {}, addEventListener: function () {} };
    return null;
  }
  var viewBound = false;
  var lastDrill = null;
  var STAGE_LABEL = { lead: 'سرنخ', qualified: 'واجد شرایط', proposal: 'پیشنهاد', proforma: 'پیش‌فاکتور', won: 'برنده', lost: 'از دست رفته' };
  function product(id) { return S.products.find(function (p) { return p.id === id; }); }
  function customer(id) { return S.customers.find(function (c) { return c.id === id; }); }
  var INV_LABEL = { proforma: 'پیش‌فاکتور', normal: 'فاکتور عادی', final: 'فاکتور نهایی' };
  function firm(inv) { return inv.type === 'normal' || inv.type === 'final'; }
  function monthOf(d) { return String(d || '').slice(0, 7); }
  function currentMonth() { return '1405/05'; }
  function lastMonth() { return '1405/04'; }

  function persist() { if (global.DemoV3Store) global.DemoV3Store.saveState(S); }

  function toast(msg) {
    var box = el('toasts');
    if (!box) return;
    var t = document.createElement('div');
    t.className = 'demo-toast';
    t.textContent = msg || (global.DemoV3Store && global.DemoV3Store.TOAST) || '';
    box.appendChild(t);
    setTimeout(function () { t.remove(); }, 2800);
  }

  function destroyCharts() {
    charts.forEach(function (c) { try { c.destroy(); } catch (e) {} });
    charts = [];
  }

  function inRange(inv) {
    if (filters.range === '12m') return true;
    var m = inv.month || monthOf(inv.date);
    if (filters.range === 'last') return m === lastMonth();
    return m === currentMonth();
  }

  function kpis() {
    var invs = S.invoices.filter(function (i) { return firm(i) && inRange(i); });
    var sales = invs.reduce(function (a, i) { return a + i.final; }, 0);
    var cogs = 0;
    invs.forEach(function (i) {
      (i.lines || []).forEach(function (ln) {
        var p = product(ln.productId);
        if (p) cogs += p.cost * ln.qty;
      });
    });
    var profit = sales - cogs;
    var margin = sales ? Math.round(profit * 100 / sales) : 0;
    var collections = S.receipts.filter(function (r) { return inRange({ month: monthOf(r.date), date: r.date }); }).reduce(function (a, r) { return a + r.amount; }, 0);
    var overdue = S.customers.filter(function (c) { return c.balance < 0; }).reduce(function (a, c) { return a - c.balance; }, 0);
    var days = 28;
    var recs = S.receipts || [];
    var dayPairs = recs.map(function (r) {
      var inv = S.invoices.find(function (i) { return i.id === r.invoiceId; });
      if (!inv) return null;
      var a = String(inv.date || '').split('/');
      var b = String(r.date || '').split('/');
      return (Number(b[1] || 0) * 30 + Number(b[2] || 0)) - (Number(a[1] || 0) * 30 + Number(a[2] || 0));
    }).filter(function (n) { return n != null; });
    if (dayPairs.length) {
      days = Math.max(1, Math.round(dayPairs.reduce(function (a, n) { return a + Math.abs(n); }, 0) / dayPairs.length));
    }
    var low = S.stock.filter(function (s) { return s.qty < s.reorderPoint; }).length;
    var openInv = S.invoices.filter(function (i) { return i.type === 'proforma'; }).length;
    var wip = S.productionOrders.filter(function (o) { return o.status === 'in_progress' || o.status === 'delayed'; }).length;
    var won = S.opportunities.filter(function (o) { return o.stage === 'won'; }).length;
    var conv = S.opportunities.length ? Math.round(won * 100 / S.opportunities.length) : 0;
    return { sales: sales, profit: profit, margin: margin, collections: collections, overdue: overdue, low: low, openInv: openInv, wip: wip, conv: conv, days: days };
  }

  function icon(name) {
    var paths = {
      dash: 'M4 4h7v7H4zM13 4h7v4h-7zM13 10h7v10h-7zM4 13h7v7H4z',
      users: 'M16 11a4 4 0 10-8 0M4 20a8 8 0 0116 0',
      box: 'M3 7l9-4 9 4-9 4-9-4zm0 0v10l9 4 9-4V7',
      doc: 'M7 3h7l5 5v13H7z'
    };
    return '<svg class="nav-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="' + (paths[name] || paths.doc) + '"/></svg>';
  }

  var NAV = [
    { id: 'dash', label: 'داشبورد', icon: 'dash' },
    { id: 'customers', label: 'مشتریان', icon: 'users' },
    { id: 'opportunities', label: 'فرصت‌ها', icon: 'doc' },
    { id: 'followups', label: 'پیگیری‌ها', icon: 'doc' },
    { id: 'invoices', label: 'فاکتور و پیش‌فاکتور', icon: 'doc' },
    { id: 'products', label: 'کالاها', icon: 'box' },
    { id: 'stock', label: 'موجودی', icon: 'box' },
    { id: 'production', label: 'تولید', icon: 'box' },
    { id: 'boms', label: 'فرمول ساخت', icon: 'doc' },
    { id: 'receipts', label: 'دریافت‌ها', icon: 'doc' },
    { id: 'cheques', label: 'چک', icon: 'doc' },
    { id: 'journals', label: 'اسناد حسابداری', icon: 'doc' },
    { id: 'ledger', label: 'دفتر کل', icon: 'doc' },
    { id: 'parties', label: 'اشخاص', icon: 'users' },
    { id: 'trial', label: 'تراز آزمایشی', icon: 'doc' },
    { id: 'pnl', label: 'سود و زیان', icon: 'doc' },
    { id: 'banks', label: 'بانک و صندوق', icon: 'doc' },
    { id: 'warehouses', label: 'انبارها', icon: 'box' },
    { id: 'b2b', label: 'سفارشات پورتال', icon: 'doc' },
    { id: 'alerts', label: 'هشدارها', icon: 'doc' },
    { id: 'reports', label: 'گزارش کارشناسان', icon: 'doc' },
    { id: 'accounting', label: 'حسابداری', icon: 'doc' },
    { id: 'help', label: 'راهنما', icon: 'doc' }
  ];

  function buildNav() {
    var nav = el('nav');
    if (!nav) return;
    if (inAcc && typeof ACC_NAV_SECTIONS !== 'undefined') {
      nav.innerHTML = ACC_NAV_SECTIONS.map(function (sec, secIdx) {
        var collapsed = ACC_NAV_COLLAPSED.has(secIdx);
        var body = '';
        function link(it) {
          return '<a href="#' + esc(it.id) + '" data-page="' + esc(it.id) + '"' + (page === it.id ? ' class="active"' : '') + '>' + esc(it.label) + '</a>';
        }
        if (sec.subgroups) {
          body = sec.subgroups.map(function (sg) {
            return '<div class="nav-acc-sub"><div class="nav-acc-sub-title">' + esc(sg.title) + '</div>' + (sg.items || []).map(link).join('') + '</div>';
          }).join('');
        } else body = (sec.items || []).map(link).join('');
        return '<div class="nav-section"><div class="nav-section-title nav-acc-head ' + (collapsed ? '' : 'open') + '" data-acc-sec="' + secIdx + '">' + esc(sec.title) + '</div><div class="nav-acc-items"' + (collapsed ? ' hidden' : '') + '>' + body + '</div></div>';
      }).join('') + '<div class="demo-maker">ساخته‌شده توسط ' + esc(S.meta.maker) + '<br>داده‌ها کاملاً ساختگی هستند</div>';
      return;
    }
    nav.innerHTML = NAV.map(function (it) {
      return '<a href="#' + it.id + '" data-page="' + it.id + '" data-tour="' + it.id + '"' + (page === it.id ? ' class="active"' : '') + '>' + icon(it.icon) + esc(it.label) + '</a>';
    }).join('') + '<div class="demo-maker">ساخته‌شده توسط ' + esc(S.meta.maker) + '<br>داده‌ها کاملاً ساختگی هستند</div>';
  }

  function table(cols, rows) {
    return '<div class="panel"><div class="panel-body" style="overflow:auto"><table class="tbl"><thead><tr>' +
      cols.map(function (c) { return '<th>' + esc(c) + '</th>'; }).join('') +
      '</tr></thead><tbody>' + (rows.length ? rows.join('') : '<tr><td colspan="' + cols.length + '" class="empty">موردی نیست</td></tr>') +
      '</tbody></table></div></div>';
  }

  function toolbar(extra) {
    return '<div class="page-tools"><input class="search" id="qBox" value="' + esc(filters.q) + '" placeholder="جستجو..."><button type="button" class="ghost-btn" data-act="search">اعمال فیلتر</button>' + (extra || '') + '</div>';
  }

  function matchQ(parts) {
    if (!filters.q) return true;
    return parts.join(' ').indexOf(filters.q) !== -1;
  }

  function renderDash() {
    var k = kpis();
    var view = el('view');
    view.innerHTML =
      '<div class="dash-intro"><h2>پاسخ به سؤال‌های مدیر — ' + esc(S.meta.company) + '</h2><p class="muted">مبالغ به تومان است. بازه را عوض کنید و روی کارت کلیک کنید.</p>' +
      '<div class="range-row"><button type="button" class="ghost-btn" data-range="month">این ماه</button><button type="button" class="ghost-btn" data-range="last">ماه قبل</button><button type="button" class="ghost-btn" data-range="12m">۱۲ ماه</button></div></div>' +
      '<div class="cards bento-hero">' +
      kpiCard('kpi-sales', 'فروش خالص', toman(k.sales), 'این ماه چقدر فروخته‌ایم؟', 'sales') +
      kpiCard('kpi-profit', 'سود ناخالص', toman(k.profit), 'سود ناخالص چقدر است؟', 'profit') +
      kpiCard('kpi-margin', 'حاشیه سود', fmt(k.margin) + '٪', 'نسبت سود به فروش', 'profit') +
      kpiCard('kpi-col', 'وصولی', toman(k.collections), 'چقدر نقد شده؟', 'collections') +
      kpiCard('kpi-ar', 'مطالبات سررسیدشده', toman(k.overdue), 'چه مبلغی طلب داریم؟', 'ar') +
      kpiCard('kpi-low', 'موجودی کم', fmt(k.low), 'کدام کالاها کمبود دارند؟', 'low') +
      kpiCard('kpi-open', 'سفارش باز', fmt(k.openInv), 'پیش‌فاکتورهای باز', 'open') +
      kpiCard('kpi-wip', 'تولید در جریان', fmt(k.wip), 'کدام تولید عقب است؟', 'wip') +
      kpiCard('kpi-crm', 'نرخ تبدیل CRM', fmt(k.conv) + '٪', 'چند فرصت برنده شده؟', 'crm') +
      kpiCard('kpi-days', 'میانگین زمان وصول', fmt(k.days) + ' روز', 'سرعت نقد شدن', 'days') +
      '</div><div class="crm-chart-box"><canvas id="salesChart"></canvas></div><div id="drillBox"></div>';
    drawSalesChart();
  }

  function kpiCard(tour, title, value, q, drill) {
    return '<button type="button" class="stat" data-tour="' + tour + '" data-drill="' + drill + '"><div class="stat-body"><div class="l">' + esc(title) + '</div><div class="v mono">' + esc(value) + '</div><div class="muted">' + esc(q) + '</div></div></button>';
  }

  function drawSalesChart() {
    if (typeof Chart === 'undefined') return;
    var canvas = el('salesChart');
    if (!canvas) return;
    var months = {};
    S.invoices.filter(firm).forEach(function (i) {
      months[i.month] = (months[i.month] || 0) + i.final;
    });
    var labels = Object.keys(months).sort();
    charts.push(new Chart(canvas, {
      type: 'bar',
      data: { labels: labels, datasets: [{ label: 'فروش تومان', data: labels.map(function (m) { return months[m]; }), backgroundColor: '#1A5C38' }] },
      options: { plugins: { legend: { display: true } }, onClick: function () { showDrill('sales'); } }
    }));
  }

  function showDrill(kind) {
    lastDrill = kind;
    var box = el('drillBox');
    if (!box) {
      if (kind === 'sales' || kind === 'profit') go('invoices');
      else if (kind === 'ar') go('parties');
      return;
    }
    var rows = [];
    if (kind === 'sales' || kind === 'profit') {
      rows = S.invoices.filter(function (i) { return firm(i) && inRange(i); }).slice(0, 20).map(function (i) {
        return '<tr><td class="mono">' + esc(i.num) + '</td><td>' + esc(i.cust) + '</td><td class="mono">' + toman(i.final) + '</td></tr>';
      });
      box.innerHTML = '<h3>رکوردهای سازنده عدد</h3>' + table(['شماره', 'مشتری', 'مبلغ'], rows);
    } else if (kind === 'ar') {
      rows = S.customers.filter(function (c) { return c.balance < 0; }).map(function (c) {
        return '<tr><td>' + esc(c.biz) + '</td><td class="mono">' + toman(-c.balance) + '</td></tr>';
      });
      box.innerHTML = '<h3>بدهکاران</h3>' + table(['مشتری', 'مانده'], rows);
    } else if (kind === 'days') {
      rows = recsPreview();
      box.innerHTML = '<h3>رسیدهای مبنای میانگین وصول</h3>' + table(['شماره فاکتور', 'مبلغ'], rows);
    } else if (kind === 'low') { go('stock'); filters.shortage = true; render(); }
    else if (kind === 'wip') { go('production'); }
    else if (kind === 'collections') { go('receipts'); }
    else if (kind === 'crm') { go('opportunities'); }
    else if (kind === 'open') { go('invoices'); }
  }
  function recsPreview() {
    return (S.receipts || []).slice(0, 12).map(function (r) {
      var inv = S.invoices.find(function (i) { return i.id === r.invoiceId; });
      return '<tr><td class="mono">' + esc(inv ? inv.num : String(r.invoiceId)) + '</td><td class="mono">' + toman(r.amount) + '</td></tr>';
    });
  }

  function renderCustomers() {
    var rows = S.customers.filter(function (c) { return matchQ([c.biz, c.owner, c.city]); }).map(function (c) {
      return '<tr data-open="customer" data-id="' + c.id + '"><td>' + esc(c.biz) + '</td><td>' + esc(c.owner) + '</td><td>' + esc(c.kind) + '</td><td>' + esc(c.city) + '</td><td class="mono">' + toman(c.balance) + '</td><td>' + esc(c.salesperson) + '</td></tr>';
    });
    el('view').innerHTML = toolbar('<button type="button" class="primary-btn" data-act="add-customer" data-tour="customers">افزودن مشتری</button>') +
      table(['فروشگاه', 'نام', 'نوع', 'شهر', 'مانده', 'کارشناس'], rows);
  }

  function renderOpportunities() {
    var rows = S.opportunities.filter(function (o) { return matchQ([o.title, o.stage]); }).map(function (o) {
      var c = customer(o.customerId);
      return '<tr><td>' + esc(o.title) + '</td><td>' + esc(c ? c.biz : '') + '</td><td><select data-stage="' + o.id + '">' +
        ['lead', 'qualified', 'proposal', 'proforma', 'won', 'lost'].map(function (s) {
          return '<option value="' + s + '"' + (o.stage === s ? ' selected' : '') + '>' + esc(STAGE_LABEL[s] || s) + '</option>';
        }).join('') + '</select></td><td class="mono">' + toman(o.amount) + '</td></tr>';
    });
    el('view').innerHTML = toolbar('<button type="button" class="primary-btn" data-act="add-opportunity" data-tour="opportunities">فرصت جدید</button>') +
      table(['عنوان', 'مشتری', 'مرحله', 'مبلغ'], rows);
  }

  function renderFollowups() {
    var rows = S.activities.filter(function (a) { return matchQ([a.subject, a.type]); }).map(function (a) {
      var c = customer(a.customerId);
      return '<tr><td>' + esc(c ? c.biz : '') + '</td><td>' + esc(a.date) + '</td><td>' + esc(a.type) + '</td><td>' + esc(a.subject) + '</td><td>' + esc(a.status) + '</td></tr>';
    });
    el('view').innerHTML = toolbar('<button type="button" class="primary-btn" data-act="add-followup" data-tour="followups">ثبت پیگیری</button>') +
      table(['مشتری', 'تاریخ', 'نوع', 'موضوع', 'وضعیت'], rows);
  }

  function renderInvoices() {
    var rows = S.invoices.filter(function (i) { return matchQ([i.num, i.cust, i.type]); }).slice().reverse().map(function (i) {
      var conv = i.type === 'proforma' ? '<button type="button" class="ghost-btn" data-act="convert-one" data-id="' + i.id + '" data-tour="convert">تبدیل</button>' : '';
      var deliv = firm(i) && !i.delivered ? '<button type="button" class="ghost-btn" data-act="deliver-one" data-id="' + i.id + '">تحویل</button>' : (i.delivered ? 'تحویل شد' : '');
      return '<tr><td class="mono">' + esc(i.num) + '</td><td>' + esc(i.date) + '</td><td>' + esc(i.cust) + '</td><td>' + esc(INV_LABEL[i.type] || i.type) + '</td><td class="mono">' + toman(i.final) + '</td><td>' + (i.delivered ? 'تحویل‌شده' : 'باز') + '</td><td>' + conv + deliv + '</td></tr>';
    });
    el('view').innerHTML = toolbar('<button type="button" class="primary-btn" data-act="add-proforma" data-tour="invoices">پیش‌فاکتور</button><button type="button" class="ghost-btn" data-act="mark-delivered" data-tour="delivery">ثبت تحویل</button>') +
      table(['شماره', 'تاریخ', 'مشتری', 'نوع', 'مبلغ', 'تحویل', 'عملیات'], rows);
  }

  function renderProducts() {
    var list = S.products.filter(function (p) {
      if (filters.rm && p.kind !== 'rm') return false;
      return matchQ([p.name, p.code, p.cat]);
    });
    el('view').innerHTML = toolbar('<button type="button" class="ghost-btn" data-act="filter-rm" data-tour="materials">مواد اولیه</button>') +
      table(['کد', 'نام', 'دسته', 'رنگ', 'سایز', 'قیمت'], list.map(function (p) {
        return '<tr><td class="mono">' + esc(p.code) + '</td><td>' + esc(p.name) + '</td><td>' + esc(p.cat) + '</td><td>' + esc(p.color) + '</td><td>' + esc(p.size) + '</td><td class="mono">' + toman(p.price) + '</td></tr>';
      }));
  }

  function renderStock() {
    var rows = S.stock.filter(function (s) {
      if (filters.shortage && s.qty >= s.reorderPoint) return false;
      var p = product(s.productId);
      return matchQ([p ? p.name : '', String(s.qty)]);
    }).map(function (s) {
      var p = product(s.productId) || {};
      var w = S.warehouses.find(function (x) { return x.id === s.warehouseId; }) || {};
      var low = s.qty < s.reorderPoint;
      return '<tr class="' + (low ? 'is-low' : '') + '"><td>' + esc(p.name) + '</td><td>' + esc(w.name) + '</td><td class="mono">' + fmt(s.qty) + '</td><td class="mono">' + fmt(s.reorderPoint) + '</td><td>' + (low ? 'کمبود' : 'سالم') + '</td></tr>';
    });
    el('view').innerHTML = toolbar('<button type="button" class="ghost-btn" data-act="filter-shortage" data-tour="shortage">فقط کمبود</button><span data-tour="stock"></span><span data-tour="reorder"></span>') +
      table(['کالا', 'انبار', 'موجودی', 'نقطه سفارش', 'وضعیت'], rows);
  }

  function renderProduction() {
    var rows = S.productionOrders.filter(function (o) {
      if (filters.delayed && o.status !== 'delayed') return false;
      return matchQ([o.num, o.product, o.status]);
    }).map(function (o) {
      return '<tr><td class="mono">' + esc(o.num) + '</td><td>' + esc(o.product) + '</td><td class="mono">' + fmt(o.qty) + '</td><td>' + esc(o.status) + '</td><td class="mono">' + toman(o.cost) + '</td><td><button type="button" class="ghost-btn" data-act="advance-mo" data-id="' + o.id + '" data-tour="ops">وضعیت بعد</button></td></tr>';
    });
    el('view').innerHTML = toolbar('<button type="button" class="primary-btn" data-act="add-mo" data-tour="production">سفارش تولید</button><span data-tour="mo-done"></span><span data-tour="cost"></span>') +
      table(['شماره', 'محصول', 'تعداد', 'وضعیت', 'بهای تمام‌شده', 'عملیات'], rows);
  }

  function renderBoms() {
    var rows = [];
    S.boms.forEach(function (b) {
      var p = product(b.productId) || {};
      (b.lines || []).forEach(function (ln) {
        var m = product(ln.materialId) || {};
        rows.push('<tr><td>' + esc(b.name) + '</td><td>' + esc(p.name) + '</td><td>' + esc(m.name) + '</td><td class="mono">' + fmt(ln.qty) + '</td></tr>');
      });
    });
    el('view').innerHTML = '<div data-tour="boms"></div>' + table(['فرمول', 'کالای ساخته', 'ماده', 'مقدار'], rows);
  }

  function renderReceipts() {
    var rows = S.receipts.filter(function (r) { return matchQ([r.method, String(r.amount)]); }).map(function (r) {
      var c = customer(r.customerId);
      return '<tr><td>' + esc(r.date) + '</td><td>' + esc(c ? c.biz : '') + '</td><td>' + esc(r.method) + '</td><td class="mono">' + toman(r.amount) + '</td></tr>';
    });
    el('view').innerHTML = toolbar('<button type="button" class="primary-btn" data-act="add-receipt" data-tour="receipts">ثبت دریافت</button>') +
      table(['تاریخ', 'مشتری', 'روش', 'مبلغ'], rows);
  }

  function renderCheques() {
    el('view').innerHTML = '<div data-tour="cheques"></div>' + table(['شماره', 'نوع', 'طرف', 'سررسید', 'مبلغ', 'وضعیت'],
      S.cheques.map(function (c) {
        return '<tr><td class="mono">' + esc(c.num) + '</td><td>' + esc(c.kind) + '</td><td>' + esc(c.party) + '</td><td>' + esc(c.date) + '</td><td class="mono">' + toman(c.amount) + '</td><td>' + esc(c.status) + '</td></tr>';
      }));
  }

  function renderJournals() {
    var list = S.journals.filter(function (j) {
      if (filters.saleJe && j.sourceType !== 'invoice') return false;
      return matchQ([j.num, j.desc]);
    });
    el('view').innerHTML = toolbar('<span data-tour="journals"></span><span data-tour="sale-je"></span>') +
      table(['شماره', 'تاریخ', 'شرح', 'بدهکار', 'بستانکار'], list.slice(-40).reverse().map(function (j) {
        return '<tr><td class="mono">' + esc(j.num) + '</td><td>' + esc(j.date) + '</td><td>' + esc(j.desc) + '</td><td class="mono">' + toman(j.debit) + '</td><td class="mono">' + toman(j.credit) + '</td></tr>';
      }));
  }

  function renderLedger() {
    el('view').innerHTML = '<div data-tour="ledger"></div>' + table(['کد', 'حساب', 'بدهکار', 'بستانکار'],
      S.coa.map(function (a) {
        return '<tr><td class="mono">' + esc(a.code) + '</td><td>' + esc(a.name) + '</td><td class="mono">' + (a.debit ? toman(a.debit) : '-') + '</td><td class="mono">' + (a.credit ? toman(a.credit) : '-') + '</td></tr>';
      }));
  }

  function renderParties() {
    el('view').innerHTML = '<div data-tour="parties"></div><div data-tour="ledger-cust"></div>' + table(['فروشگاه', 'نام', 'مانده', 'کارشناس'],
      S.customers.map(function (c) {
        return '<tr data-open="customer" data-id="' + c.id + '"><td>' + esc(c.biz) + '</td><td>' + esc(c.owner) + '</td><td class="mono">' + toman(c.balance) + '</td><td>' + esc(c.salesperson) + '</td></tr>';
      }));
  }

  function renderTrial() {
    var d = S.coa.reduce(function (a, x) { return a + x.debit; }, 0);
    var c = S.coa.reduce(function (a, x) { return a + x.credit; }, 0);
    el('view').innerHTML = '<div data-tour="trial"></div><p class="muted">جمع بدهکار ' + toman(d) + ' — جمع بستانکار ' + toman(c) + (d === c ? ' — متوازن' : ' — نامتوازن') + '</p>' +
      table(['کد', 'حساب', 'بدهکار', 'بستانکار'], S.coa.map(function (a) {
        return '<tr><td class="mono">' + esc(a.code) + '</td><td>' + esc(a.name) + '</td><td class="mono">' + toman(a.debit) + '</td><td class="mono">' + toman(a.credit) + '</td></tr>';
      }));
  }

  function renderPnl() {
    var k = kpis();
    el('view').innerHTML = '<div data-tour="pnl"></div>' + table(['شرح', 'مبلغ'], [
      '<tr><td>فروش خالص</td><td class="mono">' + toman(k.sales) + '</td></tr>',
      '<tr><td>بهای تمام‌شده</td><td class="mono">' + toman(k.sales - k.profit) + '</td></tr>',
      '<tr><td>سود ناخالص</td><td class="mono">' + toman(k.profit) + '</td></tr>',
      '<tr><td>حاشیه</td><td class="mono">' + fmt(k.margin) + '٪</td></tr>'
    ]);
  }

  function renderBanks() {
    el('view').innerHTML = '<div data-tour="banks"></div>' + table(['حساب', 'شماره', 'مانده'],
      S.banks.map(function (b) { return '<tr><td>' + esc(b.name) + '</td><td class="mono">' + esc(b.no) + '</td><td class="mono">' + toman(b.balance) + '</td></tr>'; })
        .concat(S.cashBoxes.map(function (c) { return '<tr><td>' + esc(c.name) + '</td><td>صندوق</td><td class="mono">' + toman(c.balance) + '</td></tr>'; })));
  }

  function renderWarehouses() {
    el('view').innerHTML = '<div data-tour="moves"></div>' + table(['انبار', 'شهر'],
      S.warehouses.map(function (w) { return '<tr><td>' + esc(w.name) + '</td><td>' + esc(w.city) + '</td></tr>'; })) +
      table(['تاریخ', 'کالا', 'انبار', 'مقدار', 'مرجع'], S.movements.slice(-25).reverse().map(function (m) {
        var p = product(m.productId) || {};
        var w = S.warehouses.find(function (x) { return x.id === m.warehouseId; }) || {};
        return '<tr><td>' + esc(m.date) + '</td><td>' + esc(p.name) + '</td><td>' + esc(w.name) + '</td><td class="mono">' + fmt(m.qty) + '</td><td>' + esc(m.ref) + '</td></tr>';
      }));
  }

  function renderB2b() {
    el('view').innerHTML = table(['شماره', 'مشتری', 'تاریخ', 'مبلغ', 'وضعیت'],
      S.b2bOrders.map(function (o) {
        return '<tr><td class="mono">' + esc(o.num) + '</td><td>' + esc(o.cust) + '</td><td>' + esc(o.date) + '</td><td class="mono">' + toman(o.final) + '</td><td>' + esc(o.status) + '</td></tr>';
      }));
  }

  function renderAlerts() {
    el('view').innerHTML = '<div data-tour="alerts"></div>' + table(['هشدار', 'سطح'],
      S.notifications.map(function (n) { return '<tr><td>' + esc(n.text) + '</td><td>' + esc(n.level) + '</td></tr>'; })) +
      table(['کار', 'موعد', 'وضعیت'], S.tasks.map(function (t) {
        return '<tr><td>' + esc(t.title) + '</td><td>' + esc(t.due) + '</td><td>' + esc(t.status) + '</td></tr>';
      }));
  }

  function renderReports() {
    var reps = S.users.filter(function (u) { return u.role === 'field_sales' || u.role === 'sales_manager'; });
    var rows = reps.map(function (u) {
      var sales = S.invoices.filter(function (i) { return firm(i) && i.salespersonId === u.id; }).reduce(function (a, i) { return a + i.final; }, 0);
      var fup = S.activities.filter(function (a) { return a.ownerId === u.id && a.status === 'open'; }).length;
      return '<tr><td>' + esc(u.name) + '</td><td>' + esc(u.roleLabel) + '</td><td class="mono">' + toman(sales) + '</td><td class="mono">' + fmt(fup) + '</td></tr>';
    });
    el('view').innerHTML = '<div data-tour="reps"></div>' + table(['کارشناس', 'نقش', 'فروش', 'پیگیری باز'], rows);
  }

  function renderHelp() {
    el('view').innerHTML = '<div class="panel"><div class="panel-body"><h2>راهنمای نسخه نمایشی</h2><p>سه لایه: معرفی نقش، تور هدایت‌شده، محیط آزاد.</p><p>در تور، «اقدام این مرحله» نتیجه را همان‌جا نشان می‌دهد؛ «مرحله بعد» جلو می‌رود. توقف تور با دکمهٔ «ادامه تور» از سر گرفته می‌شود.</p><p>مسیر فروش نمونه: مشتری → فرصت → پیگیری → پیش‌فاکتور → تبدیل به فاکتور (کاهش موجودی + سند فروش و بهای تمام‌شده + مانده مشتری) → کسری → دستور تولید → تکمیل (مصرف BOM) → ثبت تحویل روی فاکتور → دریافت (کاهش مطالبات + سند بانک).</p><p>داده‌ها متعلق به «' + esc(S.meta.company) + '» است و کاملاً ساختگی‌اند.</p><p>ساخته‌شده توسط ' + esc(S.meta.maker) + '</p><p>بازنشانی فقط کلیدهای erp.taranom.demo.v3.1 را پاک می‌کند.</p></div></div>';
  }

  function nextId(list) { return list.reduce(function (m, x) { return Math.max(m, x.id || 0); }, 0) + 1; }

  function addCustomer() {
    var id = nextId(S.customers);
    S.customers.unshift({
      id: id, kind: 'customer', biz: 'فروشگاه نمونه تور ' + id, owner: 'میهمان نمونه',
      city: 'مشهد', phone: '0900001' + String(8000 + id).slice(-4), type: 'بوتیک', status: 'new',
      balance: 0, salespersonId: 2, salesperson: 'هستی نمونه', address: 'آدرس نمونه', risk: 'low',
      lastOrderDate: '1405/05/24', sample: true
    });
    persist(); toast(); renderCustomers();
  }

  function addOpportunity() {
    var c = S.customers[0];
    S.opportunities.unshift({
      id: nextId(S.opportunities), customerId: c.id, title: 'فرصت تور — ' + c.biz,
      stage: 'lead', amount: 8500000, ownerId: 2, created: '1405/05/24', nextAction: 'تماس', sample: true
    });
    persist(); toast(); renderOpportunities();
  }

  function addFollowup() {
    var c = S.customers[0];
    S.activities.unshift({
      id: nextId(S.activities), customerId: c.id, opportunityId: S.opportunities[0].id,
      date: '1405/05/24', type: 'تماس تلفنی', subject: 'پیگیری تور نمونه', priority: 'high', status: 'open', ownerId: 2, sample: true
    });
    persist(); toast(); renderFollowups();
  }

  function addProforma() {
    var c = S.customers[0];
    var p = S.products[0];
    var id = nextId(S.invoices);
    S.invoices.push({
      id: id, num: 'T-' + String(id).padStart(4, '0'), customerId: c.id, cust: c.biz,
      type: 'proforma', date: '1405/05/24', month: '1405/05', subtotal: p.price * 4, disc: 0, discAmt: 0, freight: 0,
      final: p.price * 4, paid: false, salespersonId: 2, lines: [{ productId: p.id, qty: 4, price: p.price }], sample: true
    });
    persist(); toast(); renderInvoices();
  }

  function postJournal(desc, sourceType, sourceId, lines) {
    var debit = 0, credit = 0;
    lines.forEach(function (ln) { debit += ln.debit; credit += ln.credit; });
    var jid = nextId(S.journals);
    S.journals.push({
      id: jid, num: 'JE-' + String(jid).padStart(4, '0'), date: '1405/05/24',
      desc: desc, debit: debit, credit: credit, status: 'posted',
      sourceType: sourceType, sourceId: sourceId, lines: lines, sample: true
    });
    rebuildCoaFromJournals();
  }

  function rebuildCoaFromJournals() {
    var map = {};
    (S.journals || []).forEach(function (j) {
      (j.lines || []).forEach(function (ln) {
        var key = ln.account;
        if (!map[key]) map[key] = { code: String(key).slice(0, 4), name: key, kind: 'حساب', debit: 0, credit: 0 };
        map[key].debit += ln.debit || 0;
        map[key].credit += ln.credit || 0;
      });
    });
    S.coa = Object.keys(map).map(function (k) { return map[k]; });
  }

  function convertProforma(id) {
    var inv = S.invoices.find(function (i) { return i.id === id && i.type === 'proforma'; }) || S.invoices.slice().reverse().find(function (i) { return i.type === 'proforma'; });
    if (!inv) { toast('پیش‌فاکتور باز نیست'); return; }
    inv.type = 'normal';
    inv.delivered = false;
    postJournal('فروش ' + inv.num, 'invoice', inv.id, [
      { account: '1103 دریافتنی', debit: inv.final, credit: 0 },
      { account: '4101 فروش', debit: 0, credit: inv.final }
    ]);
    var cogs = 0;
    (inv.lines || []).forEach(function (ln) {
      var p = product(ln.productId);
      if (p) cogs += p.cost * ln.qty;
      var st = S.stock.find(function (s) { return s.productId === ln.productId && s.warehouseId === 1; });
      if (st) st.qty = Math.max(0, st.qty - ln.qty);
      S.movements.push({ id: nextId(S.movements), productId: ln.productId, warehouseId: 1, qty: -ln.qty, kind: 'sale', date: '1405/05/24', ref: inv.num, sample: true });
    });
    if (cogs) {
      postJournal('بهای تمام‌شده ' + inv.num, 'cogs', inv.id, [
        { account: '5101 بهای تمام‌شده', debit: cogs, credit: 0 },
        { account: '1105 موجودی کالا', debit: 0, credit: cogs }
      ]);
    }
    var c = customer(inv.customerId);
    if (c) c.balance -= inv.final;
    persist(); toast(); renderInvoices();
  }

  function addReceipt() {
    var inv = S.invoices.filter(firm).slice(-1)[0];
    if (!inv) return;
    var amt = Math.round(inv.final / 2);
    S.receipts.push({ id: nextId(S.receipts), customerId: inv.customerId, invoiceId: inv.id, method: 'transfer', amount: amt, date: '1405/05/24', sample: true });
    var c = customer(inv.customerId);
    if (c) c.balance += amt;
    postJournal('دریافت فاکتور ' + inv.num, 'receipt', inv.id, [
      { account: '1102 بانک', debit: amt, credit: 0 },
      { account: '1103 دریافتنی', debit: 0, credit: amt }
    ]);
    persist(); toast(); renderReceipts();
  }

  function markDelivered(id) {
    var inv = S.invoices.find(function (i) { return i.id === id && firm(i); })
      || S.invoices.filter(firm).slice().reverse().find(function (i) { return !i.delivered; })
      || S.invoices.filter(firm).slice(-1)[0];
    if (!inv) return;
    inv.delivered = true;
    inv.deliveryDate = '1405/05/24';
    persist(); toast(); renderInvoices();
  }

  function addMo() {
    var p = S.products[0];
    S.productionOrders.unshift({
      id: nextId(S.productionOrders), num: 'MO-' + String(S.productionOrders.length + 1).padStart(3, '0'),
      productId: p.id, product: p.name, qty: 24, status: 'draft', due: '1405/06/10', warehouseId: 1, cost: p.cost * 24, sample: true
    });
    persist(); toast(); renderProduction();
  }

  function consumeBom(o) {
    if (o.consumed) return;
    var bom = (S.boms || []).find(function (b) { return b.productId === o.productId; });
    if (bom) {
      (bom.lines || []).forEach(function (ln) {
        var st = S.stock.find(function (s) { return s.productId === ln.materialId; });
        if (st) st.qty = Math.max(0, st.qty - Math.ceil(ln.qty * o.qty));
      });
    }
    var fg = S.stock.find(function (s) { return s.productId === o.productId && s.warehouseId === 1; });
    if (fg) fg.qty += o.qty;
    o.consumed = true;
  }

  function completeMo(id) {
    var o = S.productionOrders.find(function (x) { return x.id === id; }) || S.productionOrders[0];
    if (!o) return;
    o.status = 'done';
    consumeBom(o);
    persist(); toast(); renderProduction();
  }

  function advanceMo(id) {
    var o = S.productionOrders.find(function (x) { return x.id === id; });
    if (!o) return;
    var seq = { draft: 'in_progress', in_progress: 'done', delayed: 'in_progress', done: 'done' };
    o.status = seq[o.status] || 'in_progress';
    if (o.status === 'done') consumeBom(o);
    persist(); toast(); renderProduction();
  }

  function toggleAccSection(idx) {
    if (ACC_NAV_COLLAPSED.has(idx)) ACC_NAV_COLLAPSED.delete(idx);
    else ACC_NAV_COLLAPSED.add(idx);
    buildNav();
  }

  function applyTourAction(key) {
    var map = {
      'add-customer': addCustomer,
      'add-opportunity': addOpportunity,
      'add-followup': addFollowup,
      'add-proforma': addProforma,
      'convert-proforma': function () { convertProforma(); },
      'goto-stock': function () { go('stock'); },
      'filter-shortage': function () { filters.shortage = true; go('stock'); },
      'add-mo': addMo,
      'complete-mo': function () { completeMo(); },
      'mark-delivered': function () { markDelivered(); },
      'goto-journals': function () { go('journals'); },
      'add-receipt': addReceipt,
      'goto-dash': function () { go('dash'); },
      'drill-sales': function () { go('dash'); showDrill('sales'); },
      'drill-profit': function () { go('dash'); showDrill('profit'); },
      'drill-ar': function () { go('dash'); showDrill('ar'); },
      'goto-reports': function () { go('reports'); },
      'filter-delayed': function () { filters.delayed = true; go('production'); },
      'goto-receipts': function () { go('receipts'); },
      'goto-alerts': function () { go('alerts'); },
      'goto-ledger': function () { go('ledger'); },
      'goto-parties': function () { go('parties'); },
      'filter-sale-je': function () { filters.saleJe = true; go('journals'); },
      'goto-cheques': function () { go('cheques'); },
      'goto-banks': function () { go('banks'); },
      'goto-trial': function () { go('trial'); },
      'goto-pnl': function () { go('pnl'); },
      'open-party': function () { go('parties'); },
      'goto-moves': function () { go('warehouses'); },
      'goto-boms': function () { go('boms'); },
      'goto-production': function () { go('production'); },
      'filter-rm': function () { filters.rm = true; go('products'); },
      'advance-mo': function () { if (S.productionOrders[0]) advanceMo(S.productionOrders[0].id); },
      'goto-cost': function () { go('production'); }
    };
    if (map[key]) map[key]();
  }

  function renderPurchases() {
    el('view').innerHTML = table(['شماره', 'تاریخ', 'تأمین‌کننده', 'مبلغ', 'وضعیت'],
      (S.purchases || []).map(function (p) {
        return '<tr><td class="mono">' + esc(p.num) + '</td><td>' + esc(p.date) + '</td><td>' + esc(p.sup) + '</td><td class="mono">' + toman(p.final) + '</td><td>' + esc(p.status) + '</td></tr>';
      }));
  }
  function renderReturns() {
    el('view').innerHTML = table(['شماره', 'فاکتور', 'تاریخ', 'مبلغ', 'علت'],
      (S.returns || []).map(function (r) {
        return '<tr><td class="mono">' + esc(r.num) + '</td><td class="mono">' + esc(String(r.invoiceId)) + '</td><td>' + esc(r.date) + '</td><td class="mono">' + toman(r.final) + '</td><td>' + esc(r.reason) + '</td></tr>';
      }));
  }
  function renderNamedTable(title, cols, rows) {
    el('view').innerHTML = '<h2>' + esc(title) + '</h2><p class="muted">دادهٔ ساختگی «' + esc(S.meta.company) + '» — قابل مشاهده و فیلتر در نسخه نمایشی.</p>' + table(cols, rows);
  }

  function renderAccPage(p) {
    if (p === 'acc-dash' || p === 'dash') { renderDash(); return; }
    if (p === 'help') { renderHelp(); return; }
    if (p === 'acc-pl-statement' || p === 'pnl') { renderPnl(); return; }
    if (/parties|receivables|statement|customer/.test(p)) { renderParties(); return; }
    if (/product|unit|color|size/.test(p)) { renderProducts(); return; }
    if (/purchase-return|sales-return|return/.test(p)) { renderReturns(); return; }
    if (/purchase/.test(p)) { renderPurchases(); return; }
    if (/invoice|proforma|sales|order/.test(p)) { renderInvoices(); return; }
    if (/journal|opening|close|reval/.test(p)) { renderJournals(); return; }
    if (/bank-recon|recon/.test(p)) {
      renderNamedTable('مغایرت بانکی نمونه', ['حساب', 'مانده دفتر', 'مانده صورت'],
        (S.banks || []).map(function (b) {
          return '<tr><td>' + esc(b.name) + '</td><td class="mono">' + toman(b.balance) + '</td><td class="mono">' + toman(b.balance) + '</td></tr>';
        }));
      return;
    }
    if (/trial|financial/.test(p)) { renderTrial(); return; }
    if (/coa|ledger|kpi/.test(p)) { renderLedger(); return; }
    if (/bank|cash|petty|flow/.test(p)) { renderBanks(); return; }
    if (/warehouse|kardex|stock|batch|reserv|landed|consign/.test(p)) { renderStock(); return; }
    if (/cheque|check|trust/.test(p)) { renderCheques(); return; }
    if (/production|bom/.test(p)) { renderProduction(); return; }
    if (/settlement|receipt|payment/.test(p)) { renderReceipts(); return; }
    if (/payroll/.test(p)) {
      renderNamedTable('حقوق و دستمزد نمونه', ['نام', 'نقش'],
        S.users.map(function (u) { return '<tr><td>' + esc(u.name) + '</td><td>' + esc(u.roleLabel) + '</td></tr>'; }));
      return;
    }
    if (/fixed-asset|asset/.test(p)) {
      renderNamedTable('دارایی ثابت نمونه', ['کد', 'شرح', 'بهای تمام‌شده'],
        [{ n: 'FA-01', t: 'چرخ خیاطی نمونه', a: 45000000 }, { n: 'FA-02', t: 'میز برش نمونه', a: 18000000 }].map(function (a) {
          return '<tr><td class="mono">' + esc(a.n) + '</td><td>' + esc(a.t) + '</td><td class="mono">' + toman(a.a) + '</td></tr>';
        }));
      return;
    }
    renderNamedTable(p, ['عنوان', 'وضعیت'],
      ['<tr><td>' + esc(p) + '</td><td>فعال در نسخه نمایشی با دادهٔ ساختگی</td></tr>']);
  }

  function enterAccountingShell() {
    inAcc = true;
    if (el('brandRole')) el('brandRole').textContent = 'ماژول حسابداری';
    go('acc-dash');
  }
  function exitAccountingShell() {
    inAcc = false;
    if (el('brandRole')) el('brandRole').textContent = S.meta.company;
    go('dash');
  }

  var pages = {
    dash: renderDash, customers: renderCustomers, opportunities: renderOpportunities,
    followups: renderFollowups, invoices: renderInvoices, products: renderProducts,
    stock: renderStock, production: renderProduction, boms: renderBoms,
    receipts: renderReceipts, cheques: renderCheques, journals: renderJournals,
    ledger: renderLedger, parties: renderParties, trial: renderTrial, pnl: renderPnl,
    banks: renderBanks, warehouses: renderWarehouses, b2b: renderB2b,
    alerts: renderAlerts, reports: renderReports, help: renderHelp
  };

  function render() {
    destroyCharts();
    buildNav();
    if (el('pageTitle')) el('pageTitle').textContent = (NAV.find(function (n) { return n.id === page; }) || { label: page }).label;
    if (pages[page]) pages[page]();
    else if (page && page.indexOf('acc-') === 0) renderAccPage(page);
    else renderDash();
    var view = el('view');
    if (view) view.focus();
  }

  function go(next, fromBack) {
    if (next === 'accounting') { enterAccountingShell(); return; }
    if (next === 'exit-acc-shell') { exitAccountingShell(); return; }
    if (!fromBack && page && page !== next) history.push(page);
    page = next || 'dash';
    render();
  }

  function showSummary(role, done, total) {
    var box = el('summary');
    var body = el('summaryBody');
    var title = el('summaryTitle');
    if (title) title.textContent = 'جمع‌بندی تور';
    if (body) {
      body.innerHTML = '<p>نقش: ' + esc(role || '') + '</p><p>تکمیل‌شده: ' + fmt(done || 0) + ' از ' + fmt(total || 0) + '</p>' +
        '<ul><li>چرخه مشتری تا وصول دیده شد</li><li>ERP اعداد پراکنده را به یک روایت وصل می‌کند</li><li>ماژول‌های فروش، انبار، تولید و حسابداری برای این نقش مهم‌اند</li></ul>';
    }
    if (box) box.hidden = false;
  }

  function hideSummary() { var box = el('summary'); if (box) box.hidden = true; }

  function enterFree() {
    hideSummary();
    var welcome = el('welcome');
    var app = el('app');
    if (welcome) welcome.hidden = true;
    if (app) { app.hidden = false; app.removeAttribute('hidden'); }
    go('dash');
  }

  function confirmReset() {
    var root = el('confirmRoot');
    if (!root) return;
    root.innerHTML = '<div class="confirm-modal" role="dialog" aria-modal="true" aria-labelledby="confirmTitle" id="confirmDialog"><h2 id="confirmTitle">بازنشانی دمو</h2><p>بازنشانی فقط داده‌های نسخه نمایشی v3 همین مرورگر را پاک می‌کند. ادامه؟</p><button type="button" class="primary-btn" id="confirmYes">بازنشانی</button><button type="button" class="ghost-btn" id="confirmNo">انصراف</button></div>';
    var yes = el('confirmYes');
    var no = el('confirmNo');
    function close() { root.innerHTML = ''; document.removeEventListener('keydown', onKey); }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      if (e.key === 'Tab' && yes && no) {
        var first = yes, last = no;
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    }
    document.addEventListener('keydown', onKey);
    if (yes) yes.onclick = function () {
      global.DemoV3Store.resetDemo();
      S = global.DemoV3Store.freshState();
      global.DemoV3Store.saveState(S);
      close();
      toast('دمو بازنشانی شد');
      go('dash');
    };
    if (no) no.onclick = close;
    if (yes && yes.focus) yes.focus();
  }

  function bindView() {
    var view = el('view');
    if (!view) return;
    view.addEventListener('click', function (e) {
      var range = e.target.closest('[data-range]');
      if (range) { filters.range = range.getAttribute('data-range'); renderDash(); return; }
      var drill = e.target.closest('[data-drill]');
      if (drill) { showDrill(drill.getAttribute('data-drill')); return; }
      var act = e.target.closest('[data-act]');
      if (act) {
        var a = act.getAttribute('data-act');
        if (a === 'search') { filters.q = (el('qBox') && el('qBox').value) || ''; render(); }
        else if (a === 'add-customer') addCustomer();
        else if (a === 'add-opportunity') addOpportunity();
        else if (a === 'add-followup') addFollowup();
        else if (a === 'add-proforma') addProforma();
        else if (a === 'convert-one') convertProforma(Number(act.getAttribute('data-id')));
        else if (a === 'deliver-one' || a === 'mark-delivered') markDelivered(Number(act.getAttribute('data-id')) || 0);
        else if (a === 'add-receipt') addReceipt();
        else if (a === 'add-mo') addMo();
        else if (a === 'advance-mo') advanceMo(Number(act.getAttribute('data-id')));
        else if (a === 'filter-shortage') { filters.shortage = !filters.shortage; renderStock(); }
        else if (a === 'filter-rm') { filters.rm = !filters.rm; renderProducts(); }
        return;
      }
      var open = e.target.closest('[data-open="customer"]');
      if (open) {
        var c = customer(Number(open.getAttribute('data-id')));
        if (c) toast(c.biz + ' — مانده ' + toman(c.balance));
      }
    });
    view.addEventListener('change', function (e) {
      var sel = e.target.closest('[data-stage]');
      if (!sel) return;
      var o = S.opportunities.find(function (x) { return x.id === Number(sel.getAttribute('data-stage')); });
      if (o) { o.stage = sel.value; persist(); toast(); }
    });
  }

  function init() {
    S = global.DemoV3Store.getState();
    if (S && global.DemoV3Seed && typeof global.DemoV3Seed.validateSeed === 'function') {
      var chk = global.DemoV3Seed.validateSeed(S);
      if (!chk.ok) {
        S = global.DemoV3Store.freshState();
        persist();
      }
    }
    if (!viewBound) { bindView(); viewBound = true; }
    var n = el('notifBadge');
    if (n) n.textContent = String((S.notifications || []).length);
    if (el('userName')) el('userName').textContent = S.users[0].name;
    if (el('userRole')) el('userRole').textContent = S.users[0].roleLabel;
    if (el('brandRole')) el('brandRole').textContent = S.meta.company;
  }

  var api = {
    init: init,
    go: go,
    back: function () { var p = history.pop(); if (p) go(p, true); },
    applyTourAction: applyTourAction,
    showSummary: showSummary,
    hideSummary: hideSummary,
    enterFree: enterFree,
    enterAccountingShell: enterAccountingShell,
    toggleAccSection: toggleAccSection,
    renderAccPage: renderAccPage,
    getLastDrill: function () { return lastDrill; },
    confirmReset: confirmReset,
    getPage: function () { return page; },
    getState: function () { return S; }
  };
  global.DemoV3App = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
