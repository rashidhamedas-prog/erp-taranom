# ui.md
## طراحی رابط کاربری — ماژول عملیات تولید

> **پلتفرم:** SPA موجود در `server/public/index.html` + `acc-nav.js`
> **بدون فریم‌ورک** — همان الگوی فعلی (Vanilla JS + template literals)

---

## ۱. سیستم طراحی (Design System)

### ۱.۱ رنگ‌ها — برند ترنم

```css
:root {
  /* برند */
  --brand-dark:    #1B5C4A;   /* سبز تیره — هدر، منو */
  --brand-mid:     #2D7A5F;   /* سبز متوسط — دکمه اصلی، موفقیت */
  --brand-gold:    #C9A84C;   /* طلایی — برجسته، هشدار مثبت */

  /* وضعیت */
  --state-success: #2D7A5F;
  --state-warn:    #E67E22;
  --state-danger:  #C0392B;
  --state-info:    #2980B9;
  --state-neutral: #7F8C8D;

  /* وضعیت سفارش */
  --st-draft:      #95A5A6;   /* خاکستری */
  --st-released:   #C9A84C;   /* طلایی */
  --st-progress:   #E67E22;   /* نارنجی */
  --st-completed:  #2980B9;   /* آبی */
  --st-closed:     #2D7A5F;   /* سبز */
  --st-cancelled:  #C0392B;   /* قرمز */

  /* انحراف */
  --var-favorable:   #2D7A5F;  /* 🟢 مساعد */
  --var-unfavorable: #C0392B;  /* 🔴 نامساعد */
  --var-neutral:     #7F8C8D;

  /* سطوح */
  --bg:        #FFFFFF;
  --bg-alt:    #F7F9F8;
  --bg-locked: #F0F0F0;
  --border:    #E1E5E4;
  --text:      #1A1A1A;
  --text-mute: #6B7574;

  /* فاصله */
  --sp-1: 4px; --sp-2: 8px; --sp-3: 12px; --sp-4: 16px;
  --sp-5: 24px; --sp-6: 32px; --sp-8: 48px;

  --radius: 8px;
  --shadow: 0 1px 3px rgba(0,0,0,.08);
  --shadow-lg: 0 4px 16px rgba(0,0,0,.12);
}
```

### ۱.۲ تایپوگرافی

```css
body {
  font-family: Vazirmatn, system-ui, sans-serif;
  direction: rtl;
  font-feature-settings: "ss01";   /* اعداد فارسی */
}
.num { font-variant-numeric: tabular-nums; }   /* هم‌عرض برای جدول اعداد */
.money { font-weight: 600; letter-spacing: -0.2px; }
```

| نقش | اندازه | وزن |
|-----|-------:|----:|
| عنوان صفحه | ۲۰px | ۷۰۰ |
| عنوان بخش | ۱۶px | ۶۰۰ |
| متن | ۱۴px | ۴۰۰ |
| جدول | ۱۳px | ۴۰۰ |
| اعداد بزرگ (KPI) | ۲۸px | ۷۰۰ |
| کمکی | ۱۲px | ۴۰۰ |

### ۱.۳ نمایش اعداد

```js
/** ریال → تومان با جداکننده فارسی */
function toman(rial) {
  if (rial == null) return '—';
  return (rial / 10).toLocaleString('fa-IR', { maximumFractionDigits: 0 }) + ' ت';
}

/** ریال کامل */
function rial(v) {
  if (v == null) return '—';
  return v.toLocaleString('fa-IR') + ' ریال';
}

/** مقدار با ۲ رقم اعشار */
function qty(v, unit = '') {
  if (v == null) return '—';
  const n = Number(v);
  const s = Number.isInteger(n) ? n : n.toFixed(2);
  return Number(s).toLocaleString('fa-IR') + (unit ? ' ' + unit : '');
}

/** درصد با علامت */
function pct(v, signed = false) {
  if (v == null) return '—';
  const s = signed && v > 0 ? '+' : '';
  return s + Number(v).toLocaleString('fa-IR', { maximumFractionDigits: 1 }) + '٪';
}

/** انحراف با رنگ و آیکون */
function variance(rialValue) {
  if (!rialValue) return '<span class="var-neutral">۰</span>';
  const fav = rialValue < 0;
  const cls = fav ? 'var-favorable' : 'var-unfavorable';
  const icon = fav ? '🟢' : '🔴';
  const sign = fav ? '−' : '+';
  return `<span class="${cls}">${icon} ${sign}${Math.abs(rialValue).toLocaleString('fa-IR')}</span>`;
}

/** مبلغ بزرگ خلاصه: ۶۹۸٬۳۲۴٬۵۰۰ → ۶۹.۸ م.ت */
function short(rial) {
  const t = rial / 10;
  if (Math.abs(t) >= 1e9) return (t/1e9).toFixed(1) + ' میلیارد ت';
  if (Math.abs(t) >= 1e6) return (t/1e6).toFixed(1) + ' م.ت';
  if (Math.abs(t) >= 1e3) return (t/1e3).toFixed(0) + ' هزار ت';
  return t.toLocaleString('fa-IR') + ' ت';
}
```

> **قاعده:** در جدول و کارت **تومان** · در برگه بها و سند **ریال کامل** · در KPI **مختصر**

### ۱.۴ Badge وضعیت

```html
<span class="badge badge-draft">📝 پیش‌نویس</span>
<span class="badge badge-released">🟡 آزادشده</span>
<span class="badge badge-progress">🟠 در جریان</span>
<span class="badge badge-completed">🔵 تکمیل</span>
<span class="badge badge-closed">🟢 بسته</span>
<span class="badge badge-cancelled">🔴 لغو</span>
```

```css
.badge {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 2px 10px; border-radius: 12px;
  font-size: 12px; font-weight: 600; white-space: nowrap;
}
.badge-draft     { background:#ECEFF1; color:#546E7A; }
.badge-released  { background:#FFF8E1; color:#8D6E00; }
.badge-progress  { background:#FFF3E0; color:#E65100; }
.badge-completed { background:#E3F2FD; color:#1565C0; }
.badge-closed    { background:#E8F5E9; color:#1B5C4A; }
.badge-cancelled { background:#FFEBEE; color:#C0392B; }
```

### ۱.۵ Mobile-First

```css
/* موبایل: جدول → کارت */
@media (max-width: 768px) {
  .data-table thead { display: none; }
  .data-table tr {
    display: block; margin-bottom: var(--sp-3);
    border: 1px solid var(--border); border-radius: var(--radius);
    padding: var(--sp-3); box-shadow: var(--shadow);
  }
  .data-table td {
    display: flex; justify-content: space-between;
    padding: var(--sp-2) 0; border: none;
  }
  .data-table td::before {
    content: attr(data-label);
    font-weight: 600; color: var(--text-mute);
  }
  .kpi-grid { grid-template-columns: repeat(2, 1fr); }
  .stage-flow { flex-direction: column; }
}
```

---

## ۲. ساختار منو

```
عملیات تولید  🏭
├── 📊 داشبورد تولید                    ← صفحه پیش‌فرض
├── ─────────────────
├── 📐 فرمول‌های تولید
│   ├── فهرست فرمول‌ها
│   ├── درخت محصولات
│   └── کالاهای بدون فرمول
├── ⚙️ مراکز هزینه و نرخ سربار
├── ─────────────────
├── 🧮 برآورد سریع                      ⭐ پرکاربردترین
├── 📦 برنامه‌ریزی مواد (MRP)
├── ─────────────────
├── 🏭 سفارش‌های تولید
│   ├── فهرست سفارش‌ها
│   ├── تابلوی خط (کانبان)
│   └── سفارش جدید
├── ─────────────────
├── 🔒 بستن دوره
├── ─────────────────
└── 📈 گزارشات تولید
    ├── عملیاتی (۵)
    ├── بهای تمام‌شده (۵)
    ├── انحرافات (۴)
    ├── ضایعات و کیفیت (۳)
    ├── منابع (۴)
    └── مالی و مدیریتی (۳)
        └── 💰 سود دقیق ماهانه         ⭐⭐
```

**ثبت در `acc-nav.js`:**
```js
const PRODUCTION_MENU = {
  id: 'production', label: 'عملیات تولید', icon: '🏭',
  permission: { resource: 'production', action: 'view' },
  children: [
    { id:'prod-dashboard', label:'داشبورد تولید', icon:'📊', route:'#production/dashboard' },
    { divider: true },
    { id:'prod-boms', label:'فرمول‌های تولید', icon:'📐', route:'#production/boms',
      permission:{ resource:'production_bom', action:'view' } },
    { id:'prod-cc', label:'مراکز هزینه و نرخ سربار', icon:'⚙️', route:'#production/cost-centers' },
    { divider: true },
    { id:'prod-estimate', label:'برآورد سریع', icon:'🧮', route:'#production/estimate' },
    { id:'prod-mrp', label:'برنامه‌ریزی مواد', icon:'📦', route:'#production/mrp' },
    { divider: true },
    { id:'prod-orders', label:'سفارش‌های تولید', icon:'🏭', route:'#production/orders' },
    { id:'prod-kanban', label:'تابلوی خط', icon:'📋', route:'#production/kanban' },
    { divider: true },
    { id:'prod-close', label:'بستن دوره', icon:'🔒', route:'#production/close',
      permission:{ resource:'production_close', action:'view' } },
    { divider: true },
    { id:'prod-reports', label:'گزارشات تولید', icon:'📈', route:'#production/reports',
      permission:{ resource:'production_reports', action:'view' } },
  ],
};
```

---

## ۳. صفحات کلیدی

> طرح‌های ASCII کامل در اسناد ماژول‌ها موجود است. اینجا فقط اشاره + نکات طراحی.

| صفحه | مرجع طرح | اولویت |
|------|----------|:------:|
| داشبورد تولید | `06-production-reports.md §4 PR-24` | ⭐⭐⭐ |
| سود دقیق ماهانه | `06-production-reports.md §4 PR-23` | ⭐⭐⭐ |
| برآورد سریع | `05-production-estimation.md §19` | ⭐⭐⭐ |
| فرم ثبت تولید (ماژول ۲) | `02-fixed-analysis.md §20` | ⭐⭐⭐ |
| نمای مرحله‌ای سفارش | `07-fixed-analysis-advanced.md §17` | ⭐⭐⭐ |
| فرم حواله مواد | `03-variable-analysis.md §17` | ⭐⭐ |
| فرم حواله مرحله‌ای | `08-variable-analysis-advanced.md §17` | ⭐⭐ |
| ماتریس انحراف | `08-variable-analysis-advanced.md §17` | ⭐⭐ |
| فرم پیمانکاری | `07-fixed-analysis-advanced.md §17` | ⭐⭐ |
| فرمول — تب اقلام | `01-production-formulas.md §20` | ⭐⭐ |
| فرمول — تب مسیر عملیات | `04-advanced-formulas.md §17` | ⭐⭐ |
| فرمول — تب بهای تمام‌شده | `04-advanced-formulas.md §17` | ⭐⭐ |
| صفحه MRP | `05-production-estimation.md §19` | ⭐⭐ |
| برگه بهای تمام‌شده | `06-production-reports.md §4 PR-02` | ⭐ |
| مدیریت دسترسی | `permissions.md §9` | ⭐ |

---

## ۴. صفحه جدید — بستن دوره

```
┌──────────────────────────────────────────────────────────────────────────┐
│ 🔒 بستن دوره تولید                              دوره: [۱۴۰۵/۰۴ ▾]        │
├──────────────────────────────────────────────────────────────────────────┤
│  ①━━━━━━━━━②━━━━━━━━━③━━━━━━━━━④                                        │
│  بررسی      محاسبه     تأیید      اجرا                                   │
│   ✅         ✅         ⏳         ⚪                                      │
├──────────────────────────────────────────────────────────────────────────┤
│ ▸ ① چک‌لیست پیش از بستن                                  [🔄 بررسی مجدد] │
│ ┌──────────────────────────────────────────────────────────────────────┐│
│ │ ✅ سال مالی ۱۴۰۵ باز است                                             ││
│ │ ✅ حقوق ۱۵ نفر ثبت شده (۲۶۵٬۰۰۰٬۰۰۰ ریال دستمزد مستقیم)             ││
│ │ ✅ نرخ سربار ۶ مرکز تعریف شده                                        ││
│ │ 🔴 ۲ سفارش تکمیل‌شده هنوز بسته نشده                                  ││
│ │      • PO-1405-0014  WIP: ۳٬۲۴۰٬۰۰۰ ت   [بستن]                      ││
│ │      • PO-1405-0016  WIP: ۲٬۳۸۰٬۰۰۰ ت   [بستن]                      ││
│ │ 🟡 آخرین هزینه سربار ۱۴۰۵/۰۴/۲۵ — ممکن است ناقص باشد   [بررسی]      ││
│ │ 🟡 انبارگردانی این ماه انجام نشده                       [رفتن]       ││
│ └──────────────────────────────────────────────────────────────────────┘│
│                                                                           │
│ ▸ ② محاسبه انحرافات                                        [▶️ محاسبه]  │
│ ┌─ دستمزد ─────────────────┐ ┌─ سربار ────────────────────────────────┐│
│ │ واقعی    ۲۶٬۵۰۰٬۰۰۰ ت   │ │ واقعی    ۵٬۱۵۵٬۰۰۰ ت                  ││
│ │ جذب‌شده  ۲۶٬۴۵۱٬۷۳۰ ت   │ │ جذب‌شده  ۵٬۰۰۶٬۸۸۴ ت                  ││
│ │ ─────────────────────    │ │ ──────────────────────                ││
│ │ 🔴 انحراف   ۴۸٬۲۷۰ ت    │ │ 🔴 کسر جذب ۱۴۸٬۱۱۶ ت  (۲.۹٪)          ││
│ └──────────────────────────┘ └───────────────────────────────────────┘│
│                                                                           │
│ ┌─ کسر/اضافه جذب به تفکیک مرکز ────────────────────────────────────────┐│
│ │ مرکز      │ واقعی      │ جذب‌شده    │ انحراف     │ نمودار            ││
│ │ برش       │ ۵۲۰٬۰۰۰ت  │ ۴۶۵٬۸۰۴ت  │🔴 +۵۴٬۱۹۶ت│ ████░░░░░░       ││
│ │ گلدوزی    │۱٬۷۵۰٬۰۰۰ت │۱٬۸۴۶٬۳۲۰ت │🟢 −۹۶٬۳۲۰ت│ ░░░░░░████       ││
│ │ دوخت      │۲٬۱۲۰٬۰۰۰ت │۱٬۹۳۸٬۶۳۶ت │🔴+۱۸۱٬۳۶۴ت│ ██████████ ◄ بدترین││
│ │ یراق      │ ۲۴۰٬۰۰۰ت  │ ۲۴۳٬۷۱۴ت  │🟢  −۳٬۷۱۴ت│ ░░               ││
│ │ شستشو     │ ۱۵۵٬۰۰۰ت  │ ۱۵۲٬۳۲۱ت  │🔴  +۲٬۶۷۹ت│ ▏                ││
│ │ اتو       │ ۳۷۰٬۰۰۰ت  │ ۳۶۰٬۰۸۸ت  │🔴  +۹٬۹۱۲ت│ ▌                ││
│ └───────────────────────────────────────────────────────────────────────┘│
│                                                                           │
│ ▸ ③ روش تسهیم                                                            │
│ ┌──────────────────────────────────────────────────────────────────────┐│
│ │ ℹ️ انحراف کل ۱۹۶٬۳۸۶ ت = ۰.۱٪ از بهای تولید ماه (۱۹۸٬۴۷۶٬۵۹۰ ت)     ││
│ │    زیر آستانه ۰.۵٪ → پیشنهاد سیستم: مستقیم به COGS                   ││
│ │                                                                       ││
│ │ ◉ تسهیم متناسب (proration) — دقیق‌تر                                  ││
│ │ ○ مستقیم به بهای فروش‌رفته (direct_cogs) — ساده‌تر  ← پیشنهاد سیستم   ││
│ │                                                                       ││
│ │ ┌────────────┬───────────┬──────────┬──────────┬──────────┐          ││
│ │ │ انحراف     │ کل        │ → WIP    │ → کالا   │ → COGS   │          ││
│ │ ├────────────┼───────────┼──────────┼──────────┼──────────┤          ││
│ │ │ دستمزد     │ ۴۸٬۲۷۰ت │  ۶٬۱۰۵ت │ ۱۰٬۰۳۰ت│ ۳۲٬۱۳۵ت│          ││
│ │ │ سربار      │۱۴۸٬۱۱۶ت │ ۱۸٬۷۳۲ت │ ۳۰٬۷۷۸ت│ ۹۸٬۶۰۷ت│          ││
│ │ ├────────────┼───────────┼──────────┼──────────┼──────────┤          ││
│ │ │ جمع        │۱۹۶٬۳۸۶ت │ ۲۴٬۸۳۶ت │ ۴۰٬۸۰۸ت│۱۳۰٬۷۴۲ت│          ││
│ │ │ پایه       │           │  ۱۲.۶۵٪ │  ۲۰.۷۸٪ │  ۶۶.۵۷٪ │          ││
│ │ └────────────┴───────────┴──────────┴──────────┴──────────┘          ││
│ │                                                                       ││
│ │ ℹ️ انحراف مواد تسهیم نمی‌شود — WIP از ابتدا به بهای واقعی است        ││
│ │ ℹ️ ضایعات غیرعادی تسهیم نمی‌شود — ۱۰۰٪ هزینه دوره                    ││
│ └──────────────────────────────────────────────────────────────────────┘│
│                                                                           │
│ ▸ پیش‌نمایش ۴ سند                                    [📄 مشاهده اسناد]  │
│ ▸ به‌روزرسانی میانگین ۳ کالا                          [📋 مشاهده]        │
│                                                                           │
│ ⚠️ پس از بستن، ثبت در دوره ۱۴۰۵/۰۴ غیرممکن می‌شود                        │
│    (بازکردن فقط توسط مدیر سیستم با دلیل)                                 │
│                                                                           │
│                          [انصراف]  [🔒 بستن نهایی دوره]                  │
│                                    ↑ غیرفعال تا همه 🔴 حل شوند           │
└──────────────────────────────────────────────────────────────────────────┘
```

**نکات تعاملی:**
- دکمه «بستن نهایی» تا رفع همه `severity=error` **غیرفعال**
- هشدارهای 🟡 مانع نمی‌شوند ولی نیاز به تیک «متوجه شدم» دارند
- تغییر روش تسهیم → جدول زنده بازمحاسبه شود
- بعد از موفقیت → redirect به PR-23 سود ماهانه

---

## ۵. صفحه جدید — تابلوی خط (کانبان)

```
┌──────────────────────────────────────────────────────────────────────────┐
│ 📋 تابلوی خط تولید                    [🔄 خودکار ۳۰ثانیه] [🔍 فیلتر]     │
├────────┬────────┬────────┬────────┬────────┬────────┬────────────────────┤
│ منتظر  │ ۱۰ برش │۲۰گلدوزی│۳۰ دوخت │۴۰ یراق │۵۰شستشو│ ۶۰ اتو │ تمام‌شده │
│  (۲)   │  (۱)   │  (۰)   │  (۲)   │  (۱)   │  (۱)🏭│  (۰)  │   (۱۲)   │
├────────┼────────┼────────┼────────┼────────┼────────┼───────┼──────────┤
│┌──────┐│┌──────┐│        │┌──────┐│┌──────┐│┌──────┐│       │          │
││PO-18 │││PO-15 ││        ││PO-14 │││PO-12 │││PO-16 ││       │  ۱۲ سفارش│
││شومیز ││ │مانتو ││        ││مانتو │││مانتو │││مانتو ││       │  ۸۵۷ عدد │
││۳۵۰عدد│││۳۱۴عدد││        ││۲۰۰عدد│││۱۰۰عدد│││۱۰۰عدد││       │          │
││🟡آزاد│││🟠۲روز││        ││🟠۵روز│││🟠۳روز│││🏭۸روز││       │ [مشاهده] │
│└──────┘│└──────┘│        │└──────┘│└──────┘│└──────┘│       │          │
│┌──────┐│        │        │┌──────┐│        │  ⚠️    │       │          │
││PO-19 ││        │        ││PO-17 ││        │ تأخیر  │       │          │
││مانتو ││        │        ││شومیز ││        │        │       │          │
││۱۵۰عدد││        │        ││۸۰عدد ││        │        │       │          │
││📝پیش ││        │        ││🟠۱روز││        │        │       │          │
│└──────┘│        │        │└──────┘│        │        │       │          │
├────────┴────────┴────────┴────────┴────────┴────────┴───────┴──────────┤
│ بار مراکز:  برش ▓▓▓▓▓░░░░░ ۵۲٪ │ دوخت ▓▓▓▓▓▓▓▓▓░ ۸۹٪ 🟡 ◄ گلوگاه      │
│ WIP کل: ۵۶٬۲۰۰٬۰۰۰ ت   ·   ۷ سفارش باز   ·   ⚠️ ۱ تأخیر پیمانکار      │
└──────────────────────────────────────────────────────────────────────────┘
```

**نکات:**
- کارت‌ها **قابل کلیک** → صفحه سفارش
- **بدون drag & drop** — انتقال فقط با ثبت خروجی مرحله (حسابداری دارد)
- رنگ حاشیه کارت = وضعیت · عدد = روز در این مرحله
- ⚠️ اگر روز > میانگین × ۱.۵ → هشدار
- Auto-refresh ۳۰ ثانیه (قابل خاموش کردن)

---

## ۶. الگوهای تعاملی

### ۶.۱ محاسبه زنده (Live Preview)

```js
// الگوی مشترک همه فرم‌های ثبت
let previewTimer;
function onQtyChange() {
  clearTimeout(previewTimer);
  setPreviewLoading(true);
  document.querySelector('#btn-submit').disabled = true;

  previewTimer = setTimeout(async () => {
    try {
      const r = await api.get(`/production/orders/${orderId}/preview`, collectForm());
      renderPreview(r);
      document.querySelector('#btn-submit').disabled = false;
    } catch (e) {
      showError(e);
    } finally {
      setPreviewLoading(false);
    }
  }, 400);   // debounce
}
```

> **قاعده:** دکمه ثبت تا پایان محاسبه **غیرفعال** — جلوگیری از ثبت با عدد قدیمی.

**استثنا:** فرم حواله مواد (ماژول ۳/۸) → **محاسبه سمت کلاینت** (فرمول ساده است، سرور لازم نیست):
```js
function calcVariance(AQ, SQ, AP, SP) {
  const varQty   = AQ - SQ;
  const varPrice = Math.round((AP - SP) * AQ);
  const varQtyR  = Math.round(varQty * SP);
  const pct      = SQ ? (varQty / SQ) * 100 : (AQ > 0 ? 100 : 0);
  return { varQty, varPrice, varQtyR, total: varPrice + varQtyR, pct,
           favorable: (varPrice + varQtyR) < 0 };
}
```

### ۶.۲ الزام دلیل

```js
function checkReasonRequired() {
  const threshold = config.production_variance_reason_threshold_pct;
  let blocked = false;
  for (const row of rows) {
    const v = calcVariance(row.AQ, row.SQ, row.AP, row.SP);
    const cell = row.el.querySelector('.reason');
    if (Math.abs(v.pct) > threshold && !cell.value.trim()) {
      cell.classList.add('required-error');
      cell.placeholder = `دلیل انحراف ${v.pct.toFixed(1)}٪ الزامی`;
      blocked = true;
    } else {
      cell.classList.remove('required-error');
    }
  }
  document.querySelector('#btn-submit').disabled = blocked;
}
```

```css
.required-error {
  border: 2px solid var(--state-danger) !important;
  background: #FFEBEE;
  animation: shake .3s;
}
```

### ۶.۳ پیش‌نمایش سند

```
┌────────────────────────────────────────────────────┐
│ 📄 پیش‌نمایش اسناد حسابداری               [بستن ✕]│
├────────────────────────────────────────────────────┤
│ ▸ سند ۱ — PRD-01 مصرف مواد                        │
│ ┌────────┬──────────────────┬──────────┬─────────┐│
│ │ کد     │ نام حساب         │ بدهکار   │بستانکار││
│ ├────────┼──────────────────┼──────────┼─────────┤│
│ │ ۱۱۱۱   │ کالای در جریان ساخت│۵۳۹٬۲۴۲٬۶۳۲│        ││
│ │        │ ← PO-1405-0001    │          │         ││
│ │ ۱۱۱۰   │ موجودی مواد اولیه │          │۵۳۴٬۶۰۳٬۴۵۷││
│ │ ۱۱۱۲   │ موجودی بسته‌بندی  │          │  ۴٬۶۳۹٬۱۷۵││
│ ├────────┴──────────────────┼──────────┼─────────┤│
│ │ جمع                        │۵۳۹٬۲۴۲٬۶۳۲│۵۳۹٬۲۴۲٬۶۳۲││
│ │                            │      ✅ تراز       ││
│ └────────────────────────────┴──────────┴─────────┘│
│                                                     │
│ ▸ سند ۲ — PRD-03 جذب دستمزد          [نمایش ▾]    │
│ ▸ سند ۳ — PRD-05 جذب سربار           [نمایش ▾]    │
│ ▸ سند ۴ — PRD-09 ضایعات غیرعادی      [نمایش ▾]    │
│ ▸ سند ۵ — PRD-10 ضایعات قابل فروش    [نمایش ▾]    │
│ ▸ سند ۶ — PRD-07 رسید تولید          [نمایش ▾]    │
│                                                     │
│ ✅ مانده WIP پس از ثبت: ۰ ریال                     │
└────────────────────────────────────────────────────┘
```

### ۶.۴ حالت قفل

```html
<div class="locked-banner">
  🔒 فرمول فعال — برای تغییر «نسخه جدید» بسازید
  <button class="btn-sm">نسخه جدید</button>
</div>
```

```css
.locked-banner {
  background: var(--bg-locked); border-right: 4px solid var(--state-warn);
  padding: var(--sp-3); border-radius: var(--radius);
  display: flex; align-items: center; justify-content: space-between;
  margin-bottom: var(--sp-4);
}
.locked input, .locked select {
  background: var(--bg-locked); cursor: not-allowed; pointer-events: none;
}
```

### ۶.۵ نوار پیشرفت مرحله‌ای

```html
<div class="stage-flow">
  <div class="stage done">    <span class="dot">✅</span><span class="label">۱۰ برش</span>   <span class="qty">۳۰۷.۷۲</span></div>
  <div class="stage done">    <span class="dot">✅</span><span class="label">۲۰ گلدوزی</span><span class="qty">۳۰۷.۷۲</span></div>
  <div class="stage active">  <span class="dot">🔵</span><span class="label">۳۰ دوخت</span>  <span class="qty">در جریان</span></div>
  <div class="stage pending">  <span class="dot">⚪</span><span class="label">۴۰ یراق</span>  <span class="qty">منتظر</span></div>
  <div class="stage pending sub"><span class="dot">⚪</span><span class="label">۵۰ شستشو 🏭</span><span class="qty">منتظر</span></div>
  <div class="stage pending qc"> <span class="dot">⚪</span><span class="label">۶۰ اتو ✅</span> <span class="qty">منتظر</span></div>
</div>
```

```css
.stage-flow { display:flex; gap:0; align-items:flex-start; }
.stage { flex:1; text-align:center; position:relative; padding-top:var(--sp-4); }
.stage:not(:last-child)::after {
  content:''; position:absolute; top:12px; left:0; right:50%;
  height:2px; background:var(--border); z-index:0;
}
.stage.done::after { background: var(--brand-mid); }
.stage .dot { position:relative; z-index:1; font-size:18px; }
.stage.active .label { font-weight:700; color: var(--state-info); }
.stage.pending { opacity:.5; }
```

---

## ۷. کامپوننت‌های مشترک

| کامپوننت | کاربرد | فایل |
|----------|--------|------|
| `<ProdBadge status>` | Badge وضعیت | `prod-ui.js` |
| `<MoneyCell rial hidden>` | مبلغ + مخفی‌سازی | `prod-ui.js` |
| `<VarianceCell rial>` | انحراف با رنگ | `prod-ui.js` |
| `<StageFlow stages>` | نوار مراحل | `prod-ui.js` |
| `<JePreview entries>` | پیش‌نمایش سند | `prod-ui.js` |
| `<KpiCard value delta>` | کارت داشبورد | `prod-ui.js` |
| `<LoadBar pct>` | نوار بار مرکز | `prod-ui.js` |
| `<JalaliInput>` | تاریخ جلالی | موجود |
| `<ProductPicker type>` | انتخاب کالا + فیلتر `item_type` | جدید |
| `<CostCenterPicker>` | انتخاب مرکز (فیلتر `user_cost_centers`) | جدید |

```js
// server/public/prod-ui.js

/** مبلغ با مخفی‌سازی خودکار */
function MoneyCell(rial, opts = {}) {
  if (!window.__canSeeCost) return '<span class="text-mute">—</span>';
  if (rial == null) return '—';
  const cls = opts.big ? 'money num text-lg' : 'money num';
  const title = rial.toLocaleString('fa-IR') + ' ریال';
  return `<span class="${cls}" title="${title}">${toman(rial)}</span>`;
}

/** کارت KPI */
function KpiCard({ icon, label, value, delta, deltaGood, sub }) {
  const arrow = delta > 0 ? '▲' : delta < 0 ? '▼' : '';
  const good  = deltaGood === undefined ? delta > 0 : (delta > 0) === deltaGood;
  const cls   = !delta ? 'neutral' : good ? 'good' : 'bad';
  return `
    <div class="kpi-card">
      <div class="kpi-icon">${icon}</div>
      <div class="kpi-label">${label}</div>
      <div class="kpi-value num">${value}</div>
      ${delta ? `<div class="kpi-delta ${cls}">${arrow} ${pct(Math.abs(delta))}</div>` : ''}
      ${sub ? `<div class="kpi-sub">${sub}</div>` : ''}
    </div>`;
}

/** نوار بار */
function LoadBar(pct, label) {
  const cls = pct > 100 ? 'danger' : pct > 85 ? 'warn' : 'ok';
  const w = Math.min(pct, 100);
  return `
    <div class="load-row">
      <span class="load-label">${label}</span>
      <div class="load-track"><div class="load-fill ${cls}" style="width:${w}%"></div></div>
      <span class="load-pct num">${pct(pct)}</span>
      ${pct > 85 ? '<span class="load-flag">◄ گلوگاه</span>' : ''}
    </div>`;
}
```

---

## ۸. دسترس‌پذیری و کیفیت

| مورد | الزام |
|------|-------|
| **کنتراست** | حداقل ۴.۵:۱ — `#1B5C4A` روی سفید = ۷.۲:۱ ✅ |
| **صفحه‌کلید** | همه فرم‌ها با Tab قابل تکمیل · `Enter` = ثبت · `Esc` = انصراف |
| **Focus** | `outline: 2px solid var(--brand-gold)` |
| **ARIA** | `aria-label` روی همه دکمه‌های آیکونی |
| **رنگ تنها** | هرگز — همیشه آیکون یا متن همراه (🔴 + «نامساعد») |
| **Loading** | Skeleton نه Spinner — برای جدول‌ها |
| **خطا** | Toast قرمز ۵ ثانیه + متن فارسی + کد خطا در `title` |
| **موفقیت** | Toast سبز ۳ ثانیه + لینک به نتیجه |
| **تأیید حذف** | Modal با تایپ نام برای عملیات پرخطر |

```css
*:focus-visible { outline: 2px solid var(--brand-gold); outline-offset: 2px; }
```

---

## ۹. کارایی UI

| تکنیک | جزئیات |
|-------|--------|
| **Debounce** | ۴۰۰ms روی محاسبه زنده |
| **Virtual scroll** | جدول بالای ۲۰۰ سطر |
| **کش** | `explodeBom` نتیجه در `sessionStorage` (کلید: `bomId+qty`) |
| **Lazy** | Chart.js فقط در صفحه داشبورد/گزارش import شود |
| **Skeleton** | به‌جای Spinner برای جدول |
| **Optimistic UI** | ❌ **ممنوع** — عملیات مالی باید تأیید سرور بگیرد |

---

## ۱۰. تست‌کیس‌های UI

| # | عنوان | انتظار |
|---|-------|--------|
| TU-01 | محاسبه زنده | تغییر تعداد → پیش‌نمایش پس از ۴۰۰ms |
| TU-02 | دکمه غیرفعال | حین محاسبه → `disabled` |
| TU-03 | الزام دلیل | انحراف ۶٪ بدون دلیل → دکمه ثبت غیرفعال + border قرمز |
| TU-04 | **مخفی‌سازی بها** | `field_sales` → هیچ ستون بها render نشود |
| TU-05 | قفل فرمول | BOM فعال → همه input ها `disabled` + بنر |
| TU-06 | موبایل | زیر ۷۶۸px → جدول به کارت تبدیل شود |
| TU-07 | RTL | همه صفحات `direction: rtl` |
| TU-08 | اعداد فارسی | ۵۳۹٬۲۴۲٬۶۳۲ با جداکننده `٬` |
| TU-09 | تومان/ریال | جدول تومان · برگه بها ریال |
| TU-10 | Badge وضعیت | ۶ وضعیت با رنگ و آیکون صحیح |
| TU-11 | نوار مراحل | مرحله جاری برجسته · قبلی‌ها ✅ |
| TU-12 | پیش‌نمایش سند | تراز نمایش داده شود |
| TU-13 | کانبان | Auto-refresh ۳۰ ثانیه |
| TU-14 | بستن دوره | دکمه تا رفع 🔴 غیرفعال |
| TU-15 | صفحه‌کلید | فرم ثبت با Tab + Enter کامل شود |
| TU-16 | کنتراست | همه متن‌ها ≥ ۴.۵:۱ |
| TU-17 | خطا | `409 E_NEGATIVE_STOCK` → Toast فارسی |
| TU-18 | Skeleton | جدول در حال بارگذاری → skeleton |
| TU-19 | چاپ | برگه بها در A4 بدون منو |
| TU-20 | مرکز هزینه | operator با `[CC-10]` → picker فقط CC-10 |

---

## ۱۱. پرامپت اجرایی مخصوص Cursor

````
# TASK: پیاده‌سازی UI ماژول تولید

## اسناد مرجع
- docs/Production/ui.md            ← این سند (سیستم طراحی + الگوها)
- طرح ASCII هر صفحه در سند ماژول مربوطه (§3 جدول مرجع)
- docs/Production/permissions.md   ← مخفی‌سازی بها

## ⚠️ قواعد قطعی
1. **بدون فریم‌ورک** — همان الگوی موجود index.html (Vanilla JS + template literals)
2. **RTL + Vazirmatn + اعداد فارسی** در همه صفحات
3. رنگ‌ها فقط از CSS variables (§1.1) — هیچ رنگ hard-code
4. **مخفی‌سازی بها:** `window.__canSeeCost` از پاسخ `/auth/me` بیاید.
   ولی امنیت واقعی سمت **سرور** است (stripCostFields) — این فقط UX.
5. **Optimistic UI ممنوع** — هر عملیات مالی باید تأیید سرور بگیرد.
6. دکمه ثبت حین محاسبه زنده `disabled`.
7. Mobile-first: زیر ۷۶۸px جدول → کارت (§1.5)
8. Chart.js از `vendor/chart.umd.js` موجود — lazy load

## گام‌ها

### گام ۱ — پایه
server/public/prod-ui.css:
  - CSS variables (§1.1)
  - badge, kpi-card, load-bar, stage-flow, locked-banner (§1.4, §6.5)
  - media query موبایل (§1.5)

server/public/prod-ui.js:
  - toman, rial, qty, pct, variance, short (§1.3)
  - ProdBadge, MoneyCell, VarianceCell, StageFlow, JePreview,
    KpiCard, LoadBar, ProductPicker, CostCenterPicker (§7)

### گام ۲ — منو
server/public/acc-nav.js:
  PRODUCTION_MENU (§2) با کنترل permission

### گام ۳ — صفحات (به ترتیب اولویت)
⭐⭐⭐ اول این ۵ صفحه:
  1. داشبورد تولید       ← 06-production-reports.md §4 PR-24
  2. برآورد سریع         ← 05-production-estimation.md §19
  3. فرم ثبت تولید       ← 02-fixed-analysis.md §20
  4. نمای مرحله‌ای سفارش ← 07-fixed-analysis-advanced.md §17
  5. سود دقیق ماهانه     ← 06-production-reports.md §4 PR-23

⭐⭐ سپس:
  6. فرمول (۴ تب)        ← 01 §20 + 04 §17
  7. فرم حواله مواد      ← 03 §17 + 08 §17
  8. ماتریس انحراف       ← 08 §17
  9. فرم پیمانکاری       ← 07 §17
  10. صفحه MRP           ← 05 §19
  11. بستن دوره          ← ui.md §4
  12. تابلوی خط          ← ui.md §5

⭐ آخر:
  13. برگه بها (چاپی A4) ← 06 §4 PR-02
  14. مدیریت دسترسی      ← permissions.md §9
  15. مراکز هزینه و نرخ

### گام ۴ — الگوها
همه فرم‌های ثبت:
  - محاسبه زنده debounce 400ms (§6.1)
  - الزام دلیل (§6.2)
  - پیش‌نمایش سند (§6.3)
  - حالت قفل (§6.4)

### گام ۵ — تست
server/scripts/test-production-ui.js — ۲۰ تست از §10
(تست‌های DOM با jsdom یا دستی طبق چک‌لیست)

## معیار پذیرش
- [ ] `field_sales` login → هیچ ستون بها در DOM نیست
- [ ] موبایل ۳۷۵px → همه صفحات بدون scroll افقی
- [ ] فرم ثبت تولید کامل با صفحه‌کلید قابل تکمیل
- [ ] کنتراست همه متن‌ها ≥ ۴.۵:۱
- [ ] برگه بها در A4 چاپ می‌شود
- [ ] هیچ رنگ hard-code (grep برای `#` در JS)

## ممنوعیت‌ها
- ❌ React/Vue/فریم‌ورک
- ❌ رنگ hard-code
- ❌ Optimistic UI
- ❌ مخفی‌سازی بها فقط با CSS (سرور هم باید حذف کند)
- ❌ اعداد لاتین در نمایش
````
