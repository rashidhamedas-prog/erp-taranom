# -*- coding: utf-8 -*-
"""Apply mobile UX redesign patches for dash + accounting + reports (SW v274)."""
from pathlib import Path

APP = Path(__file__).resolve().parents[1] / "server" / "public" / "app.js"
t = APP.read_text(encoding="utf-8")
n = 0

def rep(old, new, label):
    global t, n
    if old not in t:
        print(f"MISS {label}")
        return False
    t = t.replace(old, new, 1)
    n += 1
    print(f"OK {label}")
    return True

# 1) Admin dash hero
rep(
    """    body.innerHTML = `
      ${pending.length?`<div class="panel"><div class="panel-head"><h4>اقدامات در انتظار (${fmt(pending.length)})</h4>
        <button class="btn sm ghost" data-csp-click="${CSP.bind('click',function(event){pollNotifications().then(()=>renderDashContent())})}">بروز</button></div>
        <div class="panel-body">${pending.slice(0,8).map(a=>`<div class="pending-action-item" data-csp-click="${CSP.bind('click',function(event){pendingActionClick(`${String((a.route||'') ?? '')}`,`${String((a.entity_type||'') ?? '')}`,(a.entity_id||0))})}">
          <b>${esc(a.title)}</b><div class="muted" data-csp-style="${CSP.style(`font-size:12px`)}">${esc(a.body||'')}</div></div>`).join('')}</div></div>`:''}
      <div class="cards bento-hero">""",
    """    body.innerHTML = `
      <div class="dash-hero">
        <div class="dash-hero-kicker">خانه · داشبورد</div>
        <h2 class="dash-hero-title">خلاصهٔ عملیاتی شرکت</h2>
        <p class="dash-hero-lead">فروش، مطالبات و کار باز — برای جزئیات کارت‌ها و جدول‌های پایین را ببینید.</p>
        <div class="dash-hero-metrics">
          <div class="dash-hero-metric"><div class="lbl">فروش کل</div><div class="val">${fmt(ov.totalRevenue)}</div></div>
          <div class="dash-hero-metric"><div class="lbl">مانده خالص</div><div class="val">${fmt(balT.netAbs)}</div></div>
          <div class="dash-hero-metric"><div class="lbl">پیگیری باز</div><div class="val">${fmt(ov.openFollowups)}</div></div>
        </div>
      </div>
      ${pending.length?`<div class="panel"><div class="panel-head"><h4>اقدامات در انتظار (${fmt(pending.length)})</h4>
        <button class="btn sm ghost" data-csp-click="${CSP.bind('click',function(event){pollNotifications().then(()=>renderDashContent())})}">بروز</button></div>
        <div class="panel-body">${pending.slice(0,8).map(a=>`<div class="pending-action-item" data-csp-click="${CSP.bind('click',function(event){pendingActionClick(`${String((a.route||'') ?? '')}`,`${String((a.entity_type||'') ?? '')}`,(a.entity_id||0))})}">
          <b>${esc(a.title)}</b><div class="muted" data-csp-style="${CSP.style(`font-size:12px`)}">${esc(a.body||'')}</div></div>`).join('')}</div></div>`:''}
      <div class="cards bento-hero">""",
    "admin-dash-hero",
)

# 2) Sales dash hero (non-admin branch starts with cards bento-hero after balT)
rep(
    """    body.innerHTML = `
      <div class="cards bento-hero">
        ${statCard('p','👥', fmt(CACHE.customers.length),'مشتریان من')}
        ${statCard('g','💰', fmt(sales),'فروش کل'+(periodOn?' · بازه':''))}""",
    """    body.innerHTML = `
      <div class="dash-hero">
        <div class="dash-hero-kicker">خانه · داشبورد من</div>
        <h2 class="dash-hero-title">عملکرد فروش شما</h2>
        <p class="dash-hero-lead">فروش، انگیزه و مانده مشتریان منتسب به شما.</p>
        <div class="dash-hero-metrics">
          <div class="dash-hero-metric"><div class="lbl">فروش کل</div><div class="val">${fmt(sales)}</div></div>
          <div class="dash-hero-metric"><div class="lbl">مانده خالص</div><div class="val">${fmt(balT.netAbs)}</div></div>
          <div class="dash-hero-metric"><div class="lbl">پیگیری باز</div><div class="val">${fmt(openF)}</div></div>
        </div>
      </div>
      <div class="cards bento-hero">
        ${statCard('p','👥', fmt(CACHE.customers.length),'مشتریان من')}
        ${statCard('g','💰', fmt(sales),'فروش کل'+(periodOn?' · بازه':''))}""",
    "sales-dash-hero",
)

# 3) Accounting dash redesign — replace from toolbar through quick actions panel
old_acc = """  el('view').innerHTML=`
    <div class="toolbar" data-csp-style="${CSP.style(`margin-bottom:12px;flex-wrap:wrap;gap:8px;align-items:center`)}">
      ${presetSelect('accPresetSel',accPreset,'applyAccPreset')}
      ${accPreset==='custom'?`
      <input id="accFrom" data-jdate placeholder="از تاریخ" data-csp-style="${CSP.style(`padding:7px 10px;border:1.5px solid var(--border);border-radius:8px;width:120px;font-size:12px`)}" value="${accDateFrom}" data-csp-change="${CSP.bind('change',function(event){accDateFrom=this.value})}">
      <input id="accTo" data-jdate placeholder="تا تاریخ" data-csp-style="${CSP.style(`padding:7px 10px;border:1.5px solid var(--border);border-radius:8px;width:120px;font-size:12px`)}" value="${accDateTo}" data-csp-change="${CSP.bind('change',function(event){accDateTo=this.value})}">
      <button class="btn sm ghost" data-csp-click="${CSP.bind('click',function(event){ROUTES['acc-dash']()})}">🔍 اعمال</button>`:''}
      <span class="muted" data-csp-style="${CSP.style(`font-size:12px`)}">مطالبات از دفتر مشتری تا ${esc(cutoffLabel)}؛ پرداختنی از دفتر کل</span>
    </div>
    ${booksMismatch?`<div class="panel" data-csp-style="${CSP.style(`margin-bottom:12px;border-color:#f59e0b`)}"><div class="panel-body" data-csp-style="${CSP.style(`color:#92400e;font-size:13px`)}">هشدار: مانده دفتر مشتری (${fmt(recv)}) با دفتر کل تفصیلی (${fmt(ov.totalReceivableGl||0)}) یکی نیست. کارت مطالبات از دفتر مشتری است و تاریخچهٔ قبل از تفصیلی را هم دارد.</div></div>`:''}
    ${dashAlerts.length?`<div class="panel" data-csp-style="${CSP.style(`margin-bottom:12px`)}"><div class="panel-body" data-csp-style="${CSP.style(`font-size:13px`)}">${dashAlerts.map(a=>`<div>${esc(a.message)}</div>`).join('')}</div></div>`:''}
    <div class="cards">
      ${statCard('g','🧾',fmt(ov.totalInvoiced),'کل فاکتور رسمی (ت)')}
      ${statCard('b','✅',fmt(ov.totalSettled),'تسویه شده (ت)')}
      ${statCard('r','⏳',fmt(recv),'مانده مطالبات مشتریان — دفتر مشتری (ت)')}
      ${cred?statCard('g','📥',fmt(cred),'مانده بستانکار مشتریان — دفتر مشتری (ت)'):''}
      ${statCard('o','🚚',fmt(totalPayable),'مانده پرداختنی تأمین‌کنندگان (ت)')}
      ${statCard('p','🔔',fmt(ov.pendingApproval),'فاکتور منتظر تأیید')}
      ${statCard('o','⏳',fmt(ov.pendingSettlements||0),'تسویه منتظر تأیید')}
      ${statCard(tbBalanced?'g':'r','⚖️',tbBalanced?'متوازن ✓':'نامتوازن!','وضعیت تراز آزمایشی')}
    </div>
    ${(pendingRep||[]).length?`<div class="panel" data-csp-style="${CSP.style(`margin-bottom:16px;border-color:#fde68a`)}">
      <div class="panel-head"><h4>⏳ تسویه‌های میدانی منتظر تأیید (${pendingRep.length})</h4>
        <button class="btn sm" data-csp-click="${CSP.bind('click',function(event){go('acc-settlements')})}">مشاهده همه</button></div>
      <div class="panel-body tbl-wrap"><table class="tbl" data-csp-style="${CSP.style(`font-size:12px`)}"><thead><tr>
        <th>تاریخ</th><th>نماینده</th><th>مشتری</th><th>مبلغ</th><th>رسید</th><th></th>
      </tr></thead><tbody>${pendingRep.slice(0,8).map(p=>`<tr>
        <td class="mono">${escDate(p.date)}</td><td>${esc(p.rep_name)}</td>
        <td>${esc(p.cust_biz||'-')}</td><td class="mono">${fmt(p.amount)}</td>
        <td>${repReceiptBtn(p.receipt_url)}</td>
        <td><button class="btn sm green" data-csp-click="${CSP.bind('click',function(event){approveRepPayment((p.id)).then(()=>go('acc-dash'))})}">✅</button></td>
      </tr>`).join('')}</tbody></table></div>
    </div>`:''}
    <div class="panel" data-csp-style="${CSP.style(`margin-bottom:16px`)}">
      <div class="panel-head"><h4>🚀 دسترسی سریع</h4></div>
      <div class="panel-body" data-csp-style="${CSP.style(`display:flex;flex-wrap:wrap;gap:10px`)}">
        <button class="btn" data-csp-click="${CSP.bind('click',function(event){go('acc-receivables')})}">🧾 مطالبات مشتریان</button>
        <button class="btn" data-csp-click="${CSP.bind('click',function(event){go('acc-sales-invoices')})}">🧾 فاکتور فروش</button>
        <button class="btn" data-csp-click="${CSP.bind('click',function(event){go('acc-settlements')})}">💵 ثبت پرداخت</button>
        <button class="btn" data-csp-click="${CSP.bind('click',function(event){go('acc-purchases')})}">📦 ثبت فاکتور خرید</button>
        <button class="btn" data-csp-click="${CSP.bind('click',function(event){go('acc-vouchers')})}">📝 سند حسابداری دستی</button>
        <button class="btn" data-csp-click="${CSP.bind('click',function(event){go('acc-trial-balance')})}">⚖️ تراز آزمایشی</button>
        <button class="btn" data-csp-click="${CSP.bind('click',function(event){go('acc-balance-sheet')})}">🏛️ ترازنامه</button>
        <button class="btn" data-csp-click="${CSP.bind('click',function(event){go('acc-general')})}">📈 سود و زیان</button>
        <button class="btn" data-csp-click="${CSP.bind('click',function(event){go('acc-statement')})}">📄 صورت‌حساب مشتری</button>
      </div>
    </div>"""

new_acc = """  el('view').innerHTML=`
    <div class="acc-dash-shell">
    <div class="acc-dash-hero">
      <div class="acc-dash-hero-kicker">ماژول حسابداری</div>
      <h2 class="acc-dash-hero-title">داشبورد مالی</h2>
      <p class="acc-dash-hero-lead">مطالبات تا ${esc(cutoffLabel)} از دفتر مشتری؛ پرداختنی از دفتر کل. میانبرهای لمسی پایین برای کار روزمره.</p>
      <div class="acc-dash-hero-metrics">
        <div class="acc-dash-hero-metric"><div class="lbl">مطالبات</div><div class="val">${fmt(recv)}</div></div>
        <div class="acc-dash-hero-metric"><div class="lbl">پرداختنی</div><div class="val">${fmt(totalPayable)}</div></div>
        <div class="acc-dash-hero-metric"><div class="lbl">تراز</div><div class="val">${tbBalanced?'متوازن ✓':'نامتوازن!'}</div></div>
      </div>
    </div>
    <div class="toolbar acc-preset-rail" data-csp-style="${CSP.style(`margin-bottom:4px;flex-wrap:wrap;gap:8px;align-items:center`)}">
      ${presetSelect('accPresetSel',accPreset,'applyAccPreset')}
      ${accPreset==='custom'?`
      <input id="accFrom" data-jdate placeholder="از تاریخ" data-csp-style="${CSP.style(`padding:7px 10px;border:1.5px solid var(--border);border-radius:8px;width:120px;font-size:12px`)}" value="${accDateFrom}" data-csp-change="${CSP.bind('change',function(event){accDateFrom=this.value})}">
      <input id="accTo" data-jdate placeholder="تا تاریخ" data-csp-style="${CSP.style(`padding:7px 10px;border:1.5px solid var(--border);border-radius:8px;width:120px;font-size:12px`)}" value="${accDateTo}" data-csp-change="${CSP.bind('change',function(event){accDateTo=this.value})}">
      <button class="btn sm ghost" data-csp-click="${CSP.bind('click',function(event){ROUTES['acc-dash']()})}">🔍 اعمال</button>`:''}
      <span class="muted" data-csp-style="${CSP.style(`font-size:12px`)}">دفتر مشتری تا ${esc(cutoffLabel)}</span>
    </div>
    ${booksMismatch?`<div class="panel" data-csp-style="${CSP.style(`margin-bottom:12px;border-color:#f59e0b`)}"><div class="panel-body" data-csp-style="${CSP.style(`color:#92400e;font-size:13px`)}">هشدار: مانده دفتر مشتری (${fmt(recv)}) با دفتر کل تفصیلی (${fmt(ov.totalReceivableGl||0)}) یکی نیست. کارت مطالبات از دفتر مشتری است و تاریخچهٔ قبل از تفصیلی را هم دارد.</div></div>`:''}
    ${dashAlerts.length?`<div class="panel" data-csp-style="${CSP.style(`margin-bottom:12px`)}"><div class="panel-body" data-csp-style="${CSP.style(`font-size:13px`)}">${dashAlerts.map(a=>`<div>${esc(a.message)}</div>`).join('')}</div></div>`:''}
    <div class="cards bento-hero">
      ${statCard('g','🧾',fmt(ov.totalInvoiced),'کل فاکتور رسمی (ت)')}
      ${statCard('b','✅',fmt(ov.totalSettled),'تسویه شده (ت)')}
      ${statCard('r','⏳',fmt(recv),'مانده مطالبات مشتریان — دفتر مشتری (ت)')}
      ${cred?statCard('g','📥',fmt(cred),'مانده بستانکار مشتریان — دفتر مشتری (ت)'):''}
      ${statCard('o','🚚',fmt(totalPayable),'مانده پرداختنی تأمین‌کنندگان (ت)')}
      ${statCard('p','🔔',fmt(ov.pendingApproval),'فاکتور منتظر تأیید')}
      ${statCard('o','⏳',fmt(ov.pendingSettlements||0),'تسویه منتظر تأیید')}
      ${statCard(tbBalanced?'g':'r','⚖️',tbBalanced?'متوازن ✓':'نامتوازن!','وضعیت تراز آزمایشی')}
    </div>
    ${(pendingRep||[]).length?`<div class="panel" data-csp-style="${CSP.style(`margin-bottom:16px;border-color:#fde68a`)}">
      <div class="panel-head"><h4>⏳ تسویه‌های میدانی منتظر تأیید (${pendingRep.length})</h4>
        <button class="btn sm" data-csp-click="${CSP.bind('click',function(event){go('acc-settlements')})}">مشاهده همه</button></div>
      <div class="panel-body tbl-wrap"><table class="tbl m-stack" data-csp-style="${CSP.style(`font-size:12px`)}"><thead><tr>
        <th>تاریخ</th><th>نماینده</th><th>مشتری</th><th>مبلغ</th><th>رسید</th><th></th>
      </tr></thead><tbody>${pendingRep.slice(0,8).map(p=>`<tr>
        <td data-label="تاریخ" class="mono">${escDate(p.date)}</td><td data-label="نماینده">${esc(p.rep_name)}</td>
        <td data-label="مشتری">${esc(p.cust_biz||'-')}</td><td data-label="مبلغ" class="mono">${fmt(p.amount)}</td>
        <td data-label="رسید">${repReceiptBtn(p.receipt_url)}</td>
        <td data-label=""><button class="btn sm green" data-csp-click="${CSP.bind('click',function(event){approveRepPayment((p.id)).then(()=>go('acc-dash'))})}">✅</button></td>
      </tr>`).join('')}</tbody></table></div>
    </div>`:''}
    <div class="panel" data-csp-style="${CSP.style(`margin-bottom:16px`)}">
      <div class="panel-head"><h4>🚀 دسترسی سریع</h4></div>
      <div class="panel-body">
        <div class="acc-quick-grid">
          <button class="btn" data-csp-click="${CSP.bind('click',function(event){go('acc-receivables')})}">🧾 مطالبات<span class="aq-sub">دفتر مشتری</span></button>
          <button class="btn" data-csp-click="${CSP.bind('click',function(event){go('acc-sales-invoices')})}">🧾 فاکتور فروش<span class="aq-sub">صدور / پیگیری</span></button>
          <button class="btn" data-csp-click="${CSP.bind('click',function(event){go('acc-settlements')})}">💵 ثبت پرداخت<span class="aq-sub">تسویه</span></button>
          <button class="btn" data-csp-click="${CSP.bind('click',function(event){go('acc-purchases')})}">📦 فاکتور خرید<span class="aq-sub">تأمین</span></button>
          <button class="btn" data-csp-click="${CSP.bind('click',function(event){go('acc-vouchers')})}">📝 سند دستی<span class="aq-sub">دفتر کل</span></button>
          <button class="btn" data-csp-click="${CSP.bind('click',function(event){go('acc-trial-balance')})}">⚖️ تراز آزمایشی<span class="aq-sub">کنترل</span></button>
          <button class="btn" data-csp-click="${CSP.bind('click',function(event){go('acc-balance-sheet')})}">🏛️ ترازنامه<span class="aq-sub">وضعیت</span></button>
          <button class="btn" data-csp-click="${CSP.bind('click',function(event){go('acc-general')})}">📈 سود و زیان<span class="aq-sub">عملکرد</span></button>
          <button class="btn" data-csp-click="${CSP.bind('click',function(event){go('acc-statement')})}">📄 صورت‌حساب<span class="aq-sub">مشتری</span></button>
        </div>
      </div>
    </div>"""

rep(old_acc, new_acc, "acc-dash-shell")

# Close acc-dash-shell before cacheSet — find the closing of last panel before cacheSet
# The original ends with `</div>`;` then cacheSet. After our change we opened acc-dash-shell
# so we need to close it before cacheSet.
rep(
    """      <div class="panel-body" id="accDashChart"><div class="muted">در حال بارگذاری کدینگ...</div></div>
    </div>`;
  cacheSet('page:acc-dash', el('view').innerHTML);""",
    """      <div class="panel-body" id="accDashChart"><div class="muted">در حال بارگذاری کدینگ...</div></div>
    </div>
    </div>`;
  cacheSet('page:acc-dash', el('view').innerHTML);""",
    "acc-dash-close-shell",
)

# 4) Reports tables → m-stack + data-labels
rep(
    """        <table class="tbl">
          <thead><tr>
            <th>کارشناس فروش</th><th>نقش</th><th>مشتریان</th><th>سفارشات</th><th>فروش کل (ریال)</th><th>بدهی معوق (ریال)</th><th>پیگیری باز</th><th>تعداد فاکتور</th>
          </tr></thead>
          <tbody>${(sales||[]).map(s=>`<tr>
            <td><b>${esc(s.name)}</b></td>
            <td><span class="tag">${esc(s.role||'-')}</span></td>
            <td class="mono">${fmt(s.customers)}</td>
            <td class="mono">${fmt(s.orders)}</td>
            <td class="mono" data-csp-style="${CSP.style(`font-weight:700`)}">${fmt(s.revenue)}</td>
            <td class="mono" data-csp-style="${CSP.style(`color:var(--red);font-weight:700`)}">${fmt(s.debt)}</td>
            <td>${fmt(s.openFollowups)}</td>
            <td class="mono">${fmt(s.invoices)}</td>
          </tr>`).join('')||emptyRow(8)}</tbody>
        </table>""",
    """        <table class="tbl m-stack">
          <thead><tr>
            <th>کارشناس فروش</th><th>نقش</th><th>مشتریان</th><th>سفارشات</th><th>فروش کل (ریال)</th><th>بدهی معوق (ریال)</th><th>پیگیری باز</th><th>تعداد فاکتور</th>
          </tr></thead>
          <tbody>${(sales||[]).map(s=>`<tr>
            <td data-label="کارشناس"><b>${esc(s.name)}</b></td>
            <td data-label="نقش"><span class="tag">${esc(s.role||'-')}</span></td>
            <td data-label="مشتریان" class="mono">${fmt(s.customers)}</td>
            <td data-label="سفارشات" class="mono">${fmt(s.orders)}</td>
            <td data-label="فروش کل" class="mono" data-csp-style="${CSP.style(`font-weight:700`)}">${fmt(s.revenue)}</td>
            <td data-label="بدهی معوق" class="mono" data-csp-style="${CSP.style(`color:var(--red);font-weight:700`)}">${fmt(s.debt)}</td>
            <td data-label="پیگیری باز">${fmt(s.openFollowups)}</td>
            <td data-label="فاکتور" class="mono">${fmt(s.invoices)}</td>
          </tr>`).join('')||emptyRow(8)}</tbody>
        </table>""",
    "reports-sales-mstack",
)

rep(
    """        <table class="tbl">
          <thead><tr>
            <th>نام فروشگاه / مشتری</th><th>نام مالک</th><th>تعداد سفارش</th><th>مجموع خرید (ریال)</th><th>بدهی (ریال)</th><th>شهر</th><th>آدرس</th>
          </tr></thead>
          <tbody>${(top||[]).map(t=>`<tr>
            <td><b>${esc(t.biz)}</b></td>
            <td>${esc(t.owner||'-')}</td>
            <td class="mono">${fmt(t.orders)}</td>
            <td class="mono" data-csp-style="${CSP.style(`font-weight:700;color:var(--purple)`)}">${fmt(t.total)}</td>
            <td class="mono" data-csp-style="${CSP.style(`color:var(--red)`)}">${fmt(t.debt)}</td>
            <td>${esc(t.city||'-')}</td>
            ${tdClip(t.address||'-', 200, true)}
          </tr>`).join('')||emptyRow(7)}</tbody>
        </table>""",
    """        <table class="tbl m-stack">
          <thead><tr>
            <th>نام فروشگاه / مشتری</th><th>نام مالک</th><th>تعداد سفارش</th><th>مجموع خرید (ریال)</th><th>بدهی (ریال)</th><th>شهر</th><th>آدرس</th>
          </tr></thead>
          <tbody>${(top||[]).map(t=>`<tr>
            <td data-label="فروشگاه"><b>${esc(t.biz)}</b></td>
            <td data-label="مالک">${esc(t.owner||'-')}</td>
            <td data-label="سفارش" class="mono">${fmt(t.orders)}</td>
            <td data-label="خرید" class="mono" data-csp-style="${CSP.style(`font-weight:700;color:var(--purple)`)}">${fmt(t.total)}</td>
            <td data-label="بدهی" class="mono" data-csp-style="${CSP.style(`color:var(--red)`)}">${fmt(t.debt)}</td>
            <td data-label="شهر">${esc(t.city||'-')}</td>
            <td data-label="آدرس">${esc(t.address||'-')}</td>
          </tr>`).join('')||emptyRow(7)}</tbody>
        </table>""",
    "reports-top-mstack",
)

# 5) Help — extend MDI section with overlay/mobile note
rep(
    """    helpSec('🗔','پنجره‌های چندگانه (شبیه ویندوز)',`
      <p>فعال/غیرفعال کردن از <b>تنظیمات → عمومی → پنجره‌های چندگانه</b>. فقط داخل <b>ماژول حسابداری</b> هر زیرمنو در پنجره جدا باز می‌شود.</p>
      <ul>
        <li><b>داشبورد</b> (CRM و حسابداری) همیشه تک‌صفحه‌ای است — مثل قبل.</li>
        <li>نوار وظایف <b>شناور</b> پایین صفحه است؛ روی محتوا می‌نشیند و سایدبار را کوتاه نمی‌کند.</li>
        <li>روی دکمهٔ هر پنجره بزنید تا جلو بیاید؛ چینش و خاموش/روشن از همان نوار.</li>
        <li>نوار عنوان هر پنجره: جابجایی | دکمه‌ها: کوچک / بزرگ / بستن</li>
      </ul>`),""",
    """    helpSec('🗔','پنجره‌ها، مودال و موبایل',`
      <p>فعال/غیرفعال کردن پنجره‌های چندگانه از <b>تنظیمات → عمومی → پنجره‌های چندگانه</b>. فقط داخل <b>ماژول حسابداری</b> هر زیرمنو در پنجره جدا باز می‌شود.</p>
      <ul>
        <li><b>داشبورد</b> (CRM و حسابداری) همیشه تک‌صفحه‌ای است — مثل قبل.</li>
        <li>نوار وظایف <b>شناور</b> پایین صفحه است؛ روی محتوا می‌نشیند و سایدبار را کوتاه نمی‌کند.</li>
        <li>روی دکمهٔ هر پنجره بزنید تا جلو بیاید؛ چینش و خاموش/روشن از همان نوار.</li>
        <li>نوار عنوان هر پنجره: جابجایی | دکمه‌ها: کوچک / بزرگ / بستن — پنجرهٔ شناور نمی‌تواند زیر سایدبار برود.</li>
        <li><b>مودال‌ها</b> همیشه بالای منوی کناری باز می‌شوند؛ در دسکتاپ داخل ناحیه محتوا وسط‌چین‌اند و در موبایل از پایین صفحه به‌صورت شیت باز می‌شوند.</li>
        <li><b>موبایل:</b> داشبورد خانه و داشبورد حسابداری با هیرو خلاصه، ریل فیلتر افقی، کارت‌های لمسی و جدول‌های کارتی (بدون اسکرول افقی اجباری) بازطراحی شده‌اند. منو با ☰ باز می‌شود.</li>
      </ul>`),""",
    "help-overlay-mobile",
)

APP.write_text(t, encoding="utf-8")
print(f"DONE patches={n} bytes={len(t)}")
