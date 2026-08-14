(function (global) {
  'use strict';

  var SALES = [
    { id: 's1', title: 'مشتری جدید', body: 'هر فروش از یک هویت مشخص شروع می‌شود. مشتری نمونه را ببینید و یک پرونده تازه بسازید.', page: 'customers', target: '[data-tour="customers"]', actionLabel: 'ثبت مشتری نمونه', action: 'add-customer' },
    { id: 's2', title: 'فرصت فروش', body: 'فرصت، ارزش و مرحله مذاکره را شفاف می‌کند تا پیگیری گم نشود.', page: 'opportunities', target: '[data-tour="opportunities"]', actionLabel: 'ثبت فرصت', action: 'add-opportunity' },
    { id: 's3', title: 'پیگیری CRM', body: 'تماس بعدی روی تقویم می‌ماند؛ مدیر می‌بیند کدام پرونده بدون حرکت است.', page: 'followups', target: '[data-tour="followups"]', actionLabel: 'ثبت پیگیری', action: 'add-followup' },
    { id: 's4', title: 'پیش‌فاکتور', body: 'پیش‌فاکتور تعهد فروش نیست؛ فقط پیشنهاد قیمت را رسمی می‌کند.', page: 'invoices', target: '[data-tour="invoices"]', actionLabel: 'صدور پیش‌فاکتور', action: 'add-proforma' },
    { id: 's5', title: 'تبدیل به فروش قطعی', body: 'با تبدیل، موجودی و حسابداری همان لحظه اثر می‌گیرند.', page: 'invoices', target: '[data-tour="convert"]', actionLabel: 'تبدیل به فروش', action: 'convert-proforma' },
    { id: 's6', title: 'کنترل موجودی', body: 'قبل از وعده تحویل، موجودی سه انبار را ببینید.', page: 'stock', target: '[data-tour="stock"]', actionLabel: 'مشاهده موجودی', action: 'goto-stock' },
    { id: 's7', title: 'کسری کالا', body: 'نقطه سفارش کمبود را قبل از از دست رفتن فروش نشان می‌دهد.', page: 'stock', target: '[data-tour="shortage"]', actionLabel: 'نمایش کمبود', action: 'filter-shortage' },
    { id: 's8', title: 'سفارش تولید', body: 'کسری به درخواست تولید وصل می‌شود؛ نه به یادداشت پراکنده.', page: 'production', target: '[data-tour="production"]', actionLabel: 'ثبت سفارش تولید', action: 'add-mo' },
    { id: 's9', title: 'تکمیل تولید', body: 'اتمام تولید کالای ساخته‌شده را به انبار برمی‌گرداند.', page: 'production', target: '[data-tour="mo-done"]', actionLabel: 'تکمیل سفارش', action: 'complete-mo' },
    { id: 's10', title: 'تحویل کالا', body: 'تحویل، حلقه فروش را می‌بندد و آماده وصول می‌شود.', page: 'invoices', target: '[data-tour="delivery"]', actionLabel: 'ثبت تحویل', action: 'mark-delivered' },
    { id: 's11', title: 'اثر حسابداری', body: 'فروش قطعی سند متوازن می‌سازد؛ نیازی به ثبت دوباره نیست.', page: 'journals', target: '[data-tour="journals"]', actionLabel: 'مشاهده سند فروش', action: 'goto-journals' },
    { id: 's12', title: 'دریافت و چک', body: 'نقد، کارت، حواله یا چک؛ وصول به همان مشتری وصل است.', page: 'receipts', target: '[data-tour="receipts"]', actionLabel: 'ثبت دریافت', action: 'add-receipt' },
    { id: 's13', title: 'سود مدیریتی', body: 'حالا همان مسیر در سود ناخالص و حاشیه ماه دیده می‌شود.', page: 'dash', target: '[data-tour="kpi-profit"]', actionLabel: 'مشاهده سود', action: 'goto-dash' }
  ];

  var MANAGER = [
    { id: 'm1', title: 'فروش امروز و ماه', body: 'اولین سؤال مدیر: این ماه چقدر فروخته‌ایم و نسبت به ماه قبل چه تغییری داشته؟', page: 'dash', target: '[data-tour="kpi-sales"]', actionLabel: 'باز کردن جزئیات فروش', action: 'drill-sales' },
    { id: 'm2', title: 'سود ناخالص', body: 'فروش بدون سود گمراه‌کننده است. حاشیه را کنار مبلغ ببینید.', page: 'dash', target: '[data-tour="kpi-profit"]', actionLabel: 'جزئیات سود', action: 'drill-profit' },
    { id: 'm3', title: 'مطالبات سررسیدشده', body: 'پول فروش‌رفته‌ای که برنگشته، ریسک نقدینگی است.', page: 'dash', target: '[data-tour="kpi-ar"]', actionLabel: 'فهرست بدهکاران', action: 'drill-ar' },
    { id: 'm4', title: 'گردش موجودی', body: 'کالای کم‌گردش سرمایه را حبس می‌کند؛ کمبود فروش را می‌بُرد.', page: 'stock', target: '[data-tour="stock"]', actionLabel: 'موجودی کم', action: 'filter-shortage' },
    { id: 'm5', title: 'عملکرد کارشناسان', body: 'مقایسه فروش و پیگیری باز، مدیریت فروش را قابل گفتگو می‌کند.', page: 'reports', target: '[data-tour="reps"]', actionLabel: 'گزارش کارشناسان', action: 'goto-reports' },
    { id: 'm6', title: 'وضعیت تولید', body: 'تأخیر خط یعنی وعده تحویل در خطر است.', page: 'production', target: '[data-tour="production"]', actionLabel: 'سفارش‌های عقب‌افتاده', action: 'filter-delayed' },
    { id: 'm7', title: 'جریان نقد', body: 'وصولی و چک‌های نزدیک سررسید تصویر نقد را کامل می‌کنند.', page: 'receipts', target: '[data-tour="receipts"]', actionLabel: 'مشاهده وصولی', action: 'goto-receipts' },
    { id: 'm8', title: 'هشدارهای مدیریتی', body: 'کار امروز: چک، تولید تأخیری، مشتری در خطر ریزش.', page: 'alerts', target: '[data-tour="alerts"]', actionLabel: 'مشاهده هشدارها', action: 'goto-alerts' },
    { id: 'm9', title: 'از عدد به رکورد', body: 'هر KPI باید به فاکتور یا مشتری سازنده همان عدد برسد.', page: 'dash', target: '[data-tour="kpi-sales"]', actionLabel: 'Drill-down فروش', action: 'drill-sales' }
  ];

  var ACCOUNTING = [
    { id: 'a1', title: 'دفتر روزنامه', body: 'هر رویداد مالی یک سند دارد؛ فروش نمونه را در فهرست ببینید.', page: 'journals', target: '[data-tour="journals"]', actionLabel: 'باز کردن اسناد', action: 'goto-journals' },
    { id: 'a2', title: 'دفتر کل', body: 'حساب‌های کل جمع همان اسناد هستند، نه یک عدد جدا.', page: 'ledger', target: '[data-tour="ledger"]', actionLabel: 'دفتر کل', action: 'goto-ledger' },
    { id: 'a3', title: 'حساب اشخاص', body: 'مانده مشتری از فاکتور و دریافت ساخته می‌شود.', page: 'parties', target: '[data-tour="parties"]', actionLabel: 'اشخاص', action: 'goto-parties' },
    { id: 'a4', title: 'سند حاصل از فروش', body: 'فروش قطعی دریافتنی را بدهکار و درآمد را بستانکار می‌کند.', page: 'journals', target: '[data-tour="sale-je"]', actionLabel: 'سند فروش', action: 'filter-sale-je' },
    { id: 'a5', title: 'دریافت و پرداخت', body: 'وصول، مانده شخص و بانک را همزمان عوض می‌کند.', page: 'receipts', target: '[data-tour="receipts"]', actionLabel: 'ثبت دریافت', action: 'add-receipt' },
    { id: 'a6', title: 'چک', body: 'جاری، وصول‌شده، برگشتی و سررسیدشده باید در یک دفتر دیده شوند.', page: 'cheques', target: '[data-tour="cheques"]', actionLabel: 'دفتر چک', action: 'goto-cheques' },
    { id: 'a7', title: 'بانک و صندوق', body: 'نقد و بانک جدا هستند تا مغایرت پنهان نماند.', page: 'banks', target: '[data-tour="banks"]', actionLabel: 'مانده بانک', action: 'goto-banks' },
    { id: 'a8', title: 'تراز آزمایشی', body: 'جمع بدهکار و بستانکار باید یکی باشد.', page: 'trial', target: '[data-tour="trial"]', actionLabel: 'تراز آزمایشی', action: 'goto-trial' },
    { id: 'a9', title: 'سود و زیان', body: 'فروش منهای بهای تمام‌شده، سود ناخالص معنادار می‌سازد.', page: 'pnl', target: '[data-tour="pnl"]', actionLabel: 'سود و زیان', action: 'goto-pnl' },
    { id: 'a10', title: 'گردش مشتری', body: 'یک مشتری را تا فاکتور، دریافت و مانده دنبال کنید.', page: 'parties', target: '[data-tour="ledger-cust"]', actionLabel: 'گردش یک مشتری', action: 'open-party' }
  ];

  var WAREHOUSE = [
    { id: 'w1', title: 'موجودی کالا', body: 'موجودی به‌تفکیک انبار و رنگ/سایز دیده می‌شود.', page: 'stock', target: '[data-tour="stock"]', actionLabel: 'موجودی', action: 'goto-stock' },
    { id: 'w2', title: 'گردش انبار', body: 'هر ورود و خروج سند مرجع دارد.', page: 'warehouses', target: '[data-tour="moves"]', actionLabel: 'گردش', action: 'goto-moves' },
    { id: 'w3', title: 'نقطه سفارش', body: 'آستانه سفارش قبل از صفر شدن هشدار می‌دهد.', page: 'stock', target: '[data-tour="reorder"]', actionLabel: 'نقطه سفارش', action: 'filter-shortage' },
    { id: 'w4', title: 'کسری موجودی', body: 'کسری یعنی فروش در انتظار تولید یا خرید است.', page: 'stock', target: '[data-tour="shortage"]', actionLabel: 'کسری‌ها', action: 'filter-shortage' },
    { id: 'w5', title: 'فرمول ساخت', body: 'BOM مشخص می‌کند از چه موادی چه کالایی ساخته می‌شود.', page: 'boms', target: '[data-tour="boms"]', actionLabel: 'مشاهده BOM', action: 'goto-boms' },
    { id: 'w6', title: 'سفارش تولید', body: 'سفارش، مقدار و موعد را به خط می‌دهد.', page: 'production', target: '[data-tour="production"]', actionLabel: 'سفارش‌ها', action: 'goto-production' },
    { id: 'w7', title: 'مواد اولیه', body: 'بدون مواد، سفارش روی کاغذ می‌ماند.', page: 'products', target: '[data-tour="materials"]', actionLabel: 'مواد اولیه', action: 'filter-rm' },
    { id: 'w8', title: 'مراحل تولید', body: 'پیش‌نویس، در جریان، تأخیر و تکمیل وضعیت خط را می‌سازد.', page: 'production', target: '[data-tour="ops"]', actionLabel: 'تغییر وضعیت', action: 'advance-mo' },
    { id: 'w9', title: 'کالای تکمیل‌شده', body: 'اتمام تولید موجودی کالای ساخته را افزایش می‌دهد.', page: 'production', target: '[data-tour="mo-done"]', actionLabel: 'تکمیل', action: 'complete-mo' },
    { id: 'w10', title: 'بهای تمام‌شده', body: 'هزینه مواد روی سفارش می‌ماند تا سود فروش واقعی باشد.', page: 'production', target: '[data-tour="cost"]', actionLabel: 'بهای سفارش', action: 'goto-cost' }
  ];

  var TOURS = { sales: SALES, manager: MANAGER, accounting: ACCOUNTING, warehouse: WAREHOUSE };

  var state = { role: null, index: 0, done: [], paused: false };

  function persist() {
    if (global.DemoV3Store) {
      global.DemoV3Store.saveTour({ role: state.role, index: state.index, done: state.done, paused: state.paused });
    }
  }

  function reduced() {
    return global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function steps() { return TOURS[state.role] || []; }

  function current() { return steps()[state.index] || null; }

  function paintResumeBar() {
    var bar = document.getElementById('tourResumeBar');
    if (!bar) return;
    bar.hidden = !(state.role && state.paused);
  }

  function paintDock(opts) {
    var navigate = !opts || opts.navigate !== false;
    var force = !!(opts && opts.force);
    var dock = document.getElementById('tourDock');
    paintResumeBar();
    if (!dock) return;
    if (!state.role || state.paused) {
      dock.hidden = true;
      hideHighlight();
      return;
    }
    dock.hidden = false;
    var list = steps();
    var step = current();
    var prog = document.getElementById('tourProgress');
    var title = document.getElementById('tourTitle');
    var ol = document.getElementById('tourSteps');
    var body = document.getElementById('tourBody');
    var act = document.getElementById('tourAction');
    if (prog) prog.textContent = 'مرحله ' + (state.index + 1) + ' از ' + list.length;
    if (title) title.textContent = step ? step.title : 'تور';
    if (body) body.textContent = step ? step.body : '';
    if (act) act.textContent = step ? step.actionLabel : 'ادامه';
    if (ol) {
      ol.innerHTML = '';
      list.forEach(function (s, i) {
        var li = document.createElement('li');
        li.textContent = s.title;
        if (i === state.index) li.setAttribute('aria-current', 'step');
        if (state.done.indexOf(s.id) !== -1) li.className = 'is-done';
        ol.appendChild(li);
      });
    }
    if (navigate && step && global.DemoV3App && typeof global.DemoV3App.go === 'function') {
      var curPage = typeof global.DemoV3App.getPage === 'function' ? global.DemoV3App.getPage() : null;
      if (force || curPage !== step.page) global.DemoV3App.go(step.page);
    }
    requestAnimationFrame(function () { highlight(step && step.target); });
    var focusEl = act || dock;
    if (focusEl && typeof focusEl.focus === 'function') focusEl.focus();
  }

  function highlight(sel) {
    var box = document.getElementById('tourHighlight');
    if (!box) return;
    var el = sel ? document.querySelector(sel) : null;
    if (!el) { box.hidden = true; return; }
    var r = el.getBoundingClientRect();
    box.hidden = false;
    box.style.top = (r.top - 6) + 'px';
    box.style.left = (r.left - 6) + 'px';
    box.style.width = (r.width + 12) + 'px';
    box.style.height = (r.height + 12) + 'px';
    if (!reduced()) box.style.opacity = '1';
  }

  function hideHighlight() {
    var box = document.getElementById('tourHighlight');
    if (box) box.hidden = true;
  }

  function finish() {
    persist();
    var dock = document.getElementById('tourDock');
    if (dock) dock.hidden = true;
    hideHighlight();
    if (global.DemoV3App && typeof global.DemoV3App.showSummary === 'function') {
      global.DemoV3App.showSummary(state.role, state.done.length, steps().length);
    }
  }

  function advance() {
    var step = current();
    if (step && state.done.indexOf(step.id) === -1) state.done.push(step.id);
    if (state.index >= steps().length - 1) { persist(); finish(); return; }
    state.index += 1;
    persist();
    paintDock({ force: true });
  }

  function start(role) {
    if (role === 'free') { goFree(); return; }
    state = { role: role, index: 0, done: [], paused: false };
    persist();
    paintDock({ force: true });
  }

  function pause() { state.paused = true; persist(); paintDock(); }
  function resume() { state.paused = false; persist(); paintDock({ force: true }); }
  function togglePause() { if (state.paused) resume(); else pause(); }
  function skip() { advance(); }
  function restart() { if (!state.role) return; start(state.role); }
  function stop() { state.paused = true; persist(); paintDock(); }
  function goFree() {
    state = { role: null, index: 0, done: [], paused: true };
    persist();
    paintDock();
    if (global.DemoV3App && typeof global.DemoV3App.enterFree === 'function') global.DemoV3App.enterFree();
  }

  function restore() {
    var saved = global.DemoV3Store && global.DemoV3Store.loadTour();
    if (!saved || !saved.role) return false;
    state = { role: saved.role, index: saved.index || 0, done: saved.done || [], paused: !!saved.paused };
    if (state.paused) paintResumeBar();
    else paintDock();
    return true;
  }

  function onAction() {
    var step = current();
    if (!step) return;
    if (global.DemoV3App && typeof global.DemoV3App.applyTourAction === 'function') {
      global.DemoV3App.applyTourAction(step.action);
    }
    if (step && state.done.indexOf(step.id) === -1) state.done.push(step.id);
    persist();
    paintDock({ navigate: false });
  }

  function bind() {
    var act = document.getElementById('tourAction');
    var nx = document.getElementById('tourNext');
    var sk = document.getElementById('tourSkip');
    var ps = document.getElementById('tourPause');
    var rs = document.getElementById('tourRestart');
    var fr = document.getElementById('tourFree');
    var rb = document.getElementById('tourResumeBar');
    if (act) act.addEventListener('click', onAction);
    if (nx) nx.addEventListener('click', advance);
    if (sk) sk.addEventListener('click', skip);
    if (ps) ps.addEventListener('click', togglePause);
    if (rs) rs.addEventListener('click', restart);
    if (fr) fr.addEventListener('click', goFree);
    if (rb) rb.addEventListener('click', resume);
    document.addEventListener('keydown', function (e) {
      if (!state.role) return;
      if (e.key === 'Escape') { e.preventDefault(); if (state.paused) resume(); else pause(); }
      if (state.paused) return;
      if (e.altKey && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) { e.preventDefault(); skip(); }
    });
    function relayout() {
      var step = current();
      if (step && !state.paused) highlight(step.target);
    }
    global.addEventListener('resize', relayout);
    global.addEventListener('scroll', relayout, true);
  }

  var api = {
    TOURS: TOURS,
    start: start,
    pause: pause,
    resume: resume,
    togglePause: togglePause,
    runAction: onAction,
    advance: advance,
    skip: skip,
    restart: restart,
    stop: stop,
    goFree: goFree,
    restore: restore,
    bind: bind,
    getState: function () { return { role: state.role, index: state.index, done: state.done.slice(), paused: state.paused }; }
  };
  global.DemoV3Tour = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
