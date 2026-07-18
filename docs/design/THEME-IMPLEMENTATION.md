# 🎨 دستور پیاده‌سازی تم — «زمرد مدرن» (روشن) + «شب مخملی» (حالت تاریک)

> **مخاطب:** Cursor — پروژه CRM ترنم
> **نویسنده:** Claude Code
> **پیش‌نیاز:** طبق قانون `CLAUDE.md`، اول `docs/CHANGE-LOG.md` را بخوان؛ بعد از اتمام هم ورودی جدید ثبت کن و push بزن.

---

## ۰) خلاصهٔ تصمیم

از بین ۴ بورد طراحی، این ترکیب تأیید شده است:

| نقش | بورد | توصیف |
|------|------|--------|
| **تم اصلی (پیش‌فرض)** | بورد ۱ — زمرد مدرن | روشن و هوادار؛ تکامل هویت فعلی: سبز زمردی + طلایی گرم، کارت‌های نرم، سایه‌های ملایم |
| **حالت تاریک (انتخابی)** | بورد ۲ — شب مخملی | تیرهٔ درخشان فین‌تکی؛ سبز نئونی `#3ddc8c` + طلایی `#e7c876` روی زمینهٔ سبز-مشکی مخملی |

بوردهای ۳ و ۴ پیاده **نمی‌شوند** (بورد ۳ فقط بعداً برای قالب چاپ الهام‌بخش خواهد بود).

## ۱) فایل‌های مرجع گرافیکی (داخل همین repo)

| فایل | توضیح |
|------|--------|
| `docs/design/board1-modern-emerald.png` | اسکرین‌شات هدف — تم روشن «زمرد مدرن» (داشبورد نمونه) |
| `docs/design/board2-velvet-night.png` | اسکرین‌شات هدف — دارک‌مود «شب مخملی» (داشبورد نمونه) |
| `docs/design/design-boards-reference.html` | فایل HTML زندهٔ هر ۴ بورد — **مقادیر دقیق CSS** هر بورد داخل همین فایل است (کلاس‌های `.b-emerald` و `.b-velvet`). موقع تردید، این فایل مرجع نهایی رنگ/سایه/شعاع است. در مرورگر بازش کن. |

هیچ asset تصویری دیگری لازم نیست — کل تم با CSS خالص (توکن‌ها + گرادیان + سایه) پیاده می‌شود. فونت Vazirmatn هم از قبل self-host شده (`server/public/vendor/`).

## ۲) معماری تم — قوانین ثابت (از این‌ها عدول نکن)

1. **تک‌فایل هدف:** همهٔ تغییرات در `server/public/index.html` (به‌جز bump نسخهٔ SW در `server/public/sw.js`).
2. سوییچ تم با attribute روی ریشه انجام می‌شود: `<html data-theme="light|dark">`. **هیچ کلاس theme روی body/کامپوننت‌ها نگذار.**
3. **فقط توکن‌ها عوض می‌شوند.** کامپوننت‌ها همیشه از `var(--…)` می‌خوانند؛ در بلوک دارک هیچ selector کامپوننتی ننویس مگر موارد بند ۸.
4. انتخاب کاربر در `localStorage` با کلید `crm_theme` ذخیره می‌شود؛ پیش‌فرض `light`. (سراسری برای دستگاه، نه per-user — ساده و آفلاین-سازگار.)
5. **چاپ همیشه روشن است** — فاکتور/گزارش چاپی هرگز تیره درنمی‌آید (بند ۹).
6. ضد-FOUC: تم باید **قبل از رندر** ست شود (اسکریپت inline در `<head>`، بند ۵).
7. نام متغیرهای موجود (`--purple`, `--gold`, `--bg`, `--card`, `--text`, `--muted`, `--border`, `--hero`, …) **حفظ می‌شوند** تا هزاران نقطهٔ مصرف دست نخورد — فقط مقدارشان به پالت جدید به‌روز می‌شود و چند توکن جدید اضافه می‌شود.

## ۳) گام ۱ — توکن‌های تم روشن (جایگزین `:root` فعلی، حدود خط ۱۷ index.html)

بلوک فعلی `:root{ --purple:#1A5C38; … }` را **کامل** با این جایگزین کن:

```css
:root{
  color-scheme:light;
  /* هویت برند — زمرد مدرن */
  --purple:#1A5C38;            /* سبز زمردی اصلی (نام تاریخی، دست نزن) */
  --purple2:#2E7D4F;           /* سبز روشن‌تر گرادیان */
  --purple-light:#EAF4EE;      /* tint سبز برای پس‌زمینهٔ آیتم فعال/pill */
  --gold:#C9A843;              /* طلایی گرم (کمی نرم‌تر از قبلی) */
  --gold-light:#FDF3D9;
  /* رنگ‌های معنایی (سود/زیان/هشدار) — دست‌نخورده */
  --green:#059669; --red:#DC2626; --orange:#D97706; --blue:#2563EB;
  /* سطوح */
  --bg:#F5F8F4;                /* زمینهٔ اپ — سبزفام بسیار روشن */
  --card:#FFFFFF;              /* سطح کارت/پنل/مودال */
  --text:#12271C;              /* مرکب اصلی */
  --muted:#5F7268;             /* متن ثانویه — سبزفام، نه خاکستری خالص */
  --border:rgba(18,39,28,.09); /* خطوط ظریف */
  --hero:linear-gradient(120deg,#1A5C38 0%,#2E7D4F 55%,#C9A843 135%);
  /* توکن‌های جدید */
  --side-bg:linear-gradient(180deg,var(--purple),var(--purple2)); /* سایدبار */
  --shadow-card:0 1px 0 var(--border),0 18px 30px -28px rgba(18,39,28,.45); /* سایهٔ امضای بورد۱ */
  --input-bg:#FFFFFF;
  --scroll-thumb:#A8C8B4;
}
```

## ۴) گام ۲ — بلوک دارک «شب مخملی» (دقیقاً بعد از `:root` اضافه کن)

```css
html[data-theme="dark"]{
  color-scheme:dark;
  --purple:#3DDC8C;            /* سبز نئونی — accent دارک */
  --purple2:#1A9E63;
  --purple-light:rgba(61,220,140,.14);
  --gold:#E7C876;
  --gold-light:rgba(231,200,118,.16);
  --green:#3DDC8C; --red:#F87171; --orange:#FBBF24; --blue:#60A5FA;
  --bg:#0D1512;
  --card:#131F1A;
  --text:#E8F1EB;
  --muted:#7F978A;
  --border:rgba(120,220,170,.12);
  --hero:radial-gradient(40rem 30rem at 85% -8rem,rgba(61,220,140,.10),transparent 65%),linear-gradient(160deg,#0D1512,#131F1A);
  --side-bg:linear-gradient(180deg,#101A15,#0D1512);
  --shadow-card:inset 0 1px 0 rgba(255,255,255,.04),0 20px 40px -30px #000;
  --input-bg:#18271F;
  --scroll-thumb:#2E4A3A;
}
```

⚠️ **نکتهٔ کنتراست:** در دارک، متن روی دکمه‌های accent (`background:var(--purple)`) باید **تیره** باشد نه سفید (سبز نئونی روشن است). یک توکن اضافه کن و در هر دو بلوک مقدار بده:

```css
:root{ --on-accent:#FFFFFF; }
html[data-theme="dark"]{ --on-accent:#04150C; }
```

سپس در دکمه‌های اصلی (`.login-card button`, `.btn-primary`, دکمه‌های سبز، …) `color:#fff` را به `color:var(--on-accent)` تبدیل کن.

## ۵) گام ۳ — ضد-FOUC + سوییچ + دکمهٔ UI

**الف)** اولین خط بعد از `<head>` (قبل از هر `<style>`):

```html
<script>document.documentElement.setAttribute('data-theme',localStorage.getItem('crm_theme')||'light');</script>
```

**ب)** توابع سوییچ (داخل `<script>` اصلی):

```js
function applyTheme(t){
  document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem('crm_theme', t);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = (t === 'dark') ? '#0D1512' : '#1A5C38';
  rebuildChartsForTheme();               // بند ۷
  const btn = document.getElementById('themeToggleBtn');
  if (btn) btn.textContent = (t === 'dark') ? '☀️ حالت روشن' : '🌙 حالت تاریک';
}
function toggleTheme(){
  applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
}
```

**ج)** دکمهٔ سوییچ در **foot سایدبار** (کنار دکمهٔ خروج) با `id="themeToggleBtn"` و `onclick="toggleTheme()"`؛ متن اولیه را موقع boot با همان منطق `applyTheme` ست کن. یک دکمهٔ کوچک 🌙 هم گوشهٔ صفحهٔ login بگذار (قبل از ورود هم قابل استفاده باشد).

## ۶) گام ۴ — پاک‌سازی رنگ‌های هاردکد (مهم‌ترین بخش کار)

تم فقط وقتی درست کار می‌کند که سطح‌ها هاردکد نباشند. در `index.html` این جایگزینی‌ها را انجام بده (با دقت، نه blind replace — مواردی که واقعاً «سطح» هستند):

| الگوی فعلی | جایگزین | کجاها |
|---|---|---|
| `background:#fff` / `#ffffff` روی کارت/مودال/پنل/جدول | `background:var(--card)` | `.login-card`, مودال‌ها, پنل‌ها, dropdownها |
| `color:#fff` روی دکمه‌های accent | `color:var(--on-accent)` | دکمه‌های سبز اصلی |
| `background:linear-gradient(180deg,var(--purple),var(--purple2))` سایدبار | `background:var(--side-bg)` | `.sidebar` و سایدبار حسابداری |
| سایه‌های `box-shadow:0 …rgba(0,0,0,…)` روی کارت‌ها | `box-shadow:var(--shadow-card)` | `.card`, `.panel`, stat-cardها |
| `::-webkit-scrollbar-thumb{background:#a8c8b4}` | `background:var(--scroll-thumb)` | یک‌جا |
| `input/select/textarea` بدون background | `background:var(--input-bg);color:var(--text)` | استایل پایهٔ فرم‌ها |

**روش پیدا کردن:** جستجوی `#fff`, `#ffffff`, `white`, `rgba(0,0,0` در بلوک `<style>` و بررسی تک‌تک. متن‌های روی گرادیان سبز سایدبار (`color:#fff` و `rgba(255,255,255,…)`) **دست نزن** — سایدبار در هر دو تم تیره است و درست کار می‌کند.

**تست سریع دارک بعد از این گام:** هیچ لکهٔ سفید خالص در هیچ صفحه/مودالی نماند و هیچ متن تیره روی زمینهٔ تیره نباشد.

## ۷) گام ۵ — نمودارهای Chart.js تم-آگاه

رنگ‌های نمودار الان هاردکدند. یک helper اضافه کن و در همهٔ ساخت‌نمودارها استفاده کن:

```js
function chartTheme(){
  const dark = document.documentElement.getAttribute('data-theme') === 'dark';
  return {
    grid:  dark ? 'rgba(120,220,170,.08)' : 'rgba(18,39,28,.07)',
    ticks: dark ? '#7F978A' : '#5F7268',
    line:  dark ? '#3DDC8C' : '#1A5C38',
    fill:  dark ? 'rgba(61,220,140,.14)' : 'rgba(26,92,56,.10)',
    gold:  dark ? '#E7C876' : '#C9A843'
  };
}
function rebuildChartsForTheme(){
  // نمودارهای زندهٔ صفحهٔ فعلی را destroy و با chartTheme() دوباره بساز.
  // ساده‌ترین راه در این کدبیس: اگر صفحهٔ فعلی داشبورد/گزارشات است، همان render صفحه را دوباره صدا بزن.
}
```

## ۸) گام ۶ — پولیش امضای هر تم (بعد از این‌که توکن‌ها کار کردند)

**زمرد مدرن (روشن):**
- کارت آمار اولِ داشبورد (فروش این ماه): گرادیان `linear-gradient(155deg,var(--purple),var(--purple2))` با متن سفید — بقیه کارت‌ها سفید با `--shadow-card`.
- radius کارت‌ها ≈ `16px`، دکمه‌ها `10px`.
- آیتم فعال منو: `background:var(--purple-light); color:var(--purple)` (در سایدبارِ تیره همان حالت فعلی سفید-شفاف بماند).

**شب مخملی (تیره) — فقط همین سه selector اختصاصی مجاز است:**
```css
html[data-theme="dark"] .stat-card, html[data-theme="dark"] .panel{
  background:linear-gradient(160deg,#18271F,#131F1A);
}
html[data-theme="dark"] .sidebar .brand .emoji{
  filter:drop-shadow(0 0 10px rgba(61,220,140,.55));
}
html[data-theme="dark"] body{
  background:radial-gradient(40rem 30rem at 85% -8rem,rgba(61,220,140,.08),transparent 65%),var(--bg);
}
```
(نام کلاس‌های واقعی stat-card/panel را با کدبیس تطبیق بده.)

## ۹) گام ۷ — چاپ، PWA و Service Worker

**الف) چاپ همیشه روشن** — داخل `@media print` موجود اضافه کن:

```css
@media print{
  html[data-theme="dark"]{
    --bg:#fff; --card:#fff; --text:#111; --muted:#555;
    --border:#ddd; --purple:#1A5C38; --gold:#C9A843; --on-accent:#fff;
  }
}
```

**ب)** `<meta name="theme-color">` اگر نیست اضافه کن (مقدار اولیه `#1A5C38`؛ سوییچ در `applyTheme`).

**ج)** نسخهٔ cache در `server/public/sw.js` را یک واحد bump کن (الان `v20` است → `v21`).

## ۱۰) چک‌لیست QA (قبل از commit همه را رد کن)

- [ ] هر ۲ تم × صفحات: ورود، داشبورد، مشتریان، فاکتورها، پیگیری‌ها، پیام‌ها، **کل شل حسابداری** (داشبورد حسابداری، اسناد، دفتر کل، انبار، تولید، حقوق، گزارشات)، تنظیمات، راهنما.
- [ ] همهٔ مودال‌ها و dropdownها در دارک سفید نمانده باشند؛ هیچ متن کم‌کنتراست نباشد (حداقل AA).
- [ ] رفرش صفحه در دارک → فلش سفید ندهد (ضد-FOUC).
- [ ] چاپ فاکتور/گزارش در حالت دارک → خروجی روشن.
- [ ] نمودارها بعد از سوییچ بلافاصله رنگ درست بگیرند.
- [ ] موبایل (عرض ~۳۸۴px) هر دو تم.
- [ ] تست parse اسکریپت: استخراج بلوک `<script>` و `new Function(it)` — خطای syntax نداشته باشد.
- [ ] نسخهٔ دسکتاپ (Electron همان index.html را سرو می‌کند) — سوییچ تم کار کند.

## ۱۱) تعهدات پایانی (قانون پروژه)

1. به‌روزرسانی **راهنمای داخل برنامه** (`renderAdminGuide` / `renderSalesGuide`): معرفی دکمهٔ 🌙 و دو تم.
2. ثبت ورودی در `docs/CHANGE-LOG.md` (بالای تاریخچه، با commit hash و وضعیت deploy).
3. commit + push به `claude/claude-md-docs-2ssrpy`.
4. deploy طبق دستور استاندارد انتهای CHANGE-LOG.
