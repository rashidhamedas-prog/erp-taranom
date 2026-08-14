'use strict';

const MAKER = 'شرکت ترانه اندیشه پردازان ریان';

const D = {
  customers: [
    {id:1,biz:'بوتیک بهار',owner:'زهره احمدی',city:'مشهد',phone:'09151234567',type:'بوتیک',status:'vip',balance:-2500000,salesperson:'کارشناس فروش ۱',address:'بلوار سجاد'},
    {id:2,biz:'فروشگاه نسیم',owner:'فاطمه حسینی',city:'تهران',phone:'09121234567',type:'فروشگاه',status:'active',balance:0,salesperson:'کارشناس فروش ۱',address:'ولیعصر'},
    {id:3,biz:'عمده‌فروشی گلستان',owner:'محمود قاسمی',city:'اصفهان',phone:'09131234567',type:'عمده‌فروش',status:'active',balance:1500000,salesperson:'کارشناس فروش ۲',address:'چهارباغ'},
    {id:4,biz:'بوتیک مروارید',owner:'سارا موسوی',city:'مشهد',phone:'09151111111',type:'بوتیک',status:'vip',balance:-5000000,salesperson:'کارشناس فروش ۱',address:'احمدآباد'},
    {id:5,biz:'فروشگاه آفتاب',owner:'مریم نجفی',city:'تبریز',phone:'09141234567',type:'فروشگاه',status:'active',balance:0,salesperson:'کارشناس فروش ۲',address:'شهریار'},
    {id:6,biz:'بوتیک سبز',owner:'الهه کریمی',city:'مشهد',phone:'09152222222',type:'بوتیک',status:'followup',balance:0,salesperson:'کارشناس فروش ۱',address:'وکیل‌آباد'},
    {id:7,biz:'عمده‌فروشی ستاره',owner:'حسن محمدی',city:'شیراز',phone:'09171234567',type:'عمده‌فروش',status:'active',balance:3000000,salesperson:'کارشناس فروش ۲',address:'زند'},
    {id:8,biz:'بوتیک رز',owner:'نازنین اکبری',city:'مشهد',phone:'09153333333',type:'بوتیک',status:'vip',balance:-8000000,salesperson:'کارشناس فروش ۱',address:'راهنمایی'},
    {id:9,biz:'فروشگاه سپید',owner:'فریده قادری',city:'کرج',phone:'09111234567',type:'فروشگاه',status:'silent',balance:0,salesperson:'کارشناس فروش ۲',address:'گوهردشت'},
    {id:10,biz:'بوتیک طلایی',owner:'مهناز صادقی',city:'مشهد',phone:'09154444444',type:'بوتیک',status:'active',balance:2000000,salesperson:'کارشناس فروش ۱',address:'هاشمیه'},
    {id:11,biz:'پوشاک کاوه',owner:'علی رضایی',city:'تهران',phone:'09125555555',type:'عمده‌فروش',status:'active',balance:0,salesperson:'کارشناس فروش ۲',address:'جمهوری'},
    {id:12,biz:'بوتیک الماس',owner:'شیرین کیانی',city:'مشهد',phone:'09156666666',type:'بوتیک',status:'vip',balance:-12000000,salesperson:'کارشناس فروش ۱',address:'ملک‌آباد'},
  ],
  products: [
    {id:1,name:'مانتو لینن بهاره',cat:'مانتو',code:'MT-001',price:350000,stock:45},
    {id:2,name:'شومیز کتان',cat:'شومیز',code:'SH-001',price:280000,stock:30},
    {id:3,name:'دامن راحت',cat:'دامن',code:'DM-001',price:220000,stock:60},
    {id:4,name:'بلوز آستین کوتاه',cat:'بلوز',code:'BL-001',price:180000,stock:80},
    {id:5,name:'پالتو زمستانی',cat:'پالتو',code:'PT-001',price:650000,stock:20},
    {id:6,name:'مانتو جین',cat:'مانتو',code:'MT-002',price:420000,stock:35},
    {id:7,name:'تونیک گلدار',cat:'تونیک',code:'TN-001',price:310000,stock:50},
    {id:8,name:'شلوار راسته',cat:'شلوار',code:'SL-001',price:260000,stock:40},
    {id:9,name:'کاپشن پاییزه',cat:'کاپشن',code:'KP-001',price:480000,stock:25},
    {id:10,name:'بلوز راه‌راه',cat:'بلوز',code:'BL-002',price:195000,stock:55},
    {id:11,name:'مانتو کتان تابستانی',cat:'مانتو',code:'MT-003',price:320000,stock:40},
    {id:12,name:'شومیز ابریشمی',cat:'شومیز',code:'SH-002',price:380000,stock:25},
  ],
  followups: [
    {id:1,cust:'بوتیک بهار',city:'مشهد',date:'1403/05/15',type:'تماس تلفنی',subject:'پیگیری سفارش مانتو لینن',priority:'high',status:'open'},
    {id:2,cust:'فروشگاه نسیم',city:'تهران',date:'1403/05/18',type:'بازدید حضوری',subject:'معرفی محصولات پاییزه',priority:'mid',status:'open'},
    {id:3,cust:'عمده‌فروشی گلستان',city:'اصفهان',date:'1403/05/12',type:'پیام واتساپ',subject:'ارسال کاتالوگ جدید',priority:'low',status:'done'},
    {id:4,cust:'بوتیک مروارید',city:'مشهد',date:'1403/05/20',type:'تماس تلفنی',subject:'وصول مطالبات',priority:'high',status:'open'},
    {id:5,cust:'فروشگاه آفتاب',city:'تبریز',date:'1403/05/22',type:'ارسال ایمیل',subject:'پیشنهاد ویژه عمده',priority:'mid',status:'open'},
    {id:6,cust:'بوتیک سبز',city:'مشهد',date:'1403/05/10',type:'بازدید حضوری',subject:'بررسی نیاز فصل پاییز',priority:'mid',status:'open'},
    {id:7,cust:'عمده‌فروشی ستاره',city:'شیراز',date:'1403/05/25',type:'تماس تلفنی',subject:'تایید سفارش پالتو',priority:'high',status:'open'},
    {id:8,cust:'بوتیک رز',city:'مشهد',date:'1403/05/08',type:'پیام واتساپ',subject:'پیگیری فاکتور T-0023',priority:'high',status:'open'},
    {id:9,cust:'فروشگاه سپید',city:'کرج',date:'1403/04/15',type:'تماس تلفنی',subject:'احیای ارتباط',priority:'low',status:'done'},
    {id:10,cust:'بوتیک طلایی',city:'مشهد',date:'1403/05/30',type:'بازدید حضوری',subject:'نمایش کلکسیون جدید',priority:'mid',status:'open'},
    {id:11,cust:'پوشاک کاوه',city:'تهران',date:'1403/05/16',type:'پیام واتساپ',subject:'قیمت‌گذاری عمده شومیز',priority:'low',status:'open'},
    {id:12,cust:'بوتیک الماس',city:'مشهد',date:'1403/05/19',type:'تماس تلفنی',subject:'وصول مطالبات — فوری',priority:'high',status:'open'},
  ],
};

(function genInvoices(){
  const months=['1403/01','1403/02','1403/03','1403/04','1403/05','1403/06'];
  D.invoices=[];
  let seed=42;
  const rand=()=>{ seed=(seed*1664525+1013904223)&0xffffffff; return Math.abs(seed)/0x7fffffff; };
  for(let i=0;i<48;i++){
    const c=D.customers[Math.floor(rand()*D.customers.length)];
    const p=D.products[Math.floor(rand()*D.products.length)];
    const qty=Math.floor(rand()*18)+3;
    const m=months[Math.floor(rand()*months.length)];
    const d=Math.floor(rand()*27)+1;
    const disc=rand()<0.3?5:0;
    const subtotal=qty*p.price;
    const discAmt=Math.round(subtotal*disc/100);
    const final=subtotal-discAmt;
    const x=rand();
    D.invoices.push({
      id:i+1,num:'T-'+String(i+1).padStart(4,'0'),
      cust:c.biz,city:c.city,salesperson:c.salesperson,
      product:p.name,category:p.cat,qty,price:p.price,subtotal,disc,discAmt,final,
      type:x<0.25?'proforma':x<0.62?'normal':'final',
      month:m,date:m+'/'+String(d).padStart(2,'0'),
      paid:rand()<0.65
    });
  }
})();

const NAV = [
  {id:'dash', icon:'📊', label:'داشبورد'},
  {id:'customers', icon:'👥', label:'مشتریان'},
  {id:'followups', icon:'📞', label:'پیگیری‌ها', group:'پیگیری CRM'},
  {id:'crm-dashboard', icon:'📉', label:'داشبورد و گزارش‌های CRM', group:'پیگیری CRM'},
  {id:'invoices', icon:'🧾', label:'فاکتور'},
  {id:'products', icon:'🛍️', label:'کالاها'},
  {id:'reminders', icon:'🔔', label:'یادآورها'},
  {id:'reports', icon:'📈', label:'گزارشات'},
  {id:'ai', icon:'🤖', label:'دستیار هوشمند'},
  {id:'b2bOrders', icon:'🛒', label:'سفارشات پورتال'},
  {id:'accounting', icon:'💰', label:'حسابداری'},
  {id:'messages', icon:'💬', label:'پیام‌ها'},
  {id:'settings', icon:'⚙️', label:'تنظیمات'},
  {id:'help', icon:'📖', label:'راهنما'},
];

const STATUS_LABEL = {vip:'VIP',active:'فعال',followup:'پیگیری',silent:'خاموش',new:'جدید',open:'باز',done:'انجام شد',cancel:'لغو',high:'فوری',mid:'متوسط',low:'عادی'};
const INV_LABEL = {proforma:'پیش‌فاکتور',normal:'فاکتور عادی',final:'فاکتور نهایی'};
const PAGE_TITLE = {
  dash:'داشبورد', customers:'مشتریان', followups:'پیگیری‌ها',
  'crm-dashboard':'داشبورد و گزارش‌های CRM', invoices:'فاکتور', products:'کالاها',
  reminders:'یادآورها', reports:'گزارشات', ai:'دستیار هوشمند',
  b2bOrders:'سفارشات پورتال', accounting:'حسابداری', messages:'پیام‌ها',
  settings:'تنظیمات', help:'راهنما',
};

const fmt = n => Number(n||0).toLocaleString('fa-IR');
const esc = s => (s==null?'':String(s)).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const isFirm = i => i.type==='normal'||i.type==='final';
const tag = (s) => `<span class="tag t-${esc(s)}">${esc(STATUS_LABEL[s]||s)}</span>`;
const debit = n => n<0 ? `<span class="mono demo-debit">${fmt(-n)}</span>` : '-';
const credit = n => n>0 ? `<span class="mono demo-credit">${fmt(n)}</span>` : '-';

function el(id){ return document.getElementById(id); }
function toast(msg){
  const box=el('toasts'); if(!box) return;
  const t=document.createElement('div'); t.className='demo-toast'; t.textContent=msg;
  box.appendChild(t); setTimeout(()=>t.remove(),2200);
}
function readOnly(){ toast('نسخه نمایشی — ذخیره روی سرور انجام نمی‌شود'); }

function statCard(c, icon, val, label){
  return `<div class="stat"><div class="ic ${c}">${icon}</div><div class="stat-body"><div class="v mono">${val}</div><div class="l">${label}</div></div></div>`;
}

let currentPage='dash';
let pageHistory=[];
let chartInstances=[];
let custFilter={q:'',status:''};
let invFilter={q:'',type:''};
let fupFilter={q:'',status:''};
let IN_ACC_SHELL=false;
const ACC_NAV_COLLAPSED=new Set();
if(typeof ACC_NAV_SECTIONS!=='undefined'){
  ACC_NAV_SECTIONS.forEach((_,i)=>ACC_NAV_COLLAPSED.add(i));
  const keepOpen=new Set(['حسابداری','فروش و خرید','انبار','بانک و صندوق','تولید','کالا','امکانات']);
  ACC_NAV_SECTIONS.forEach((sec,i)=>{ if(keepOpen.has(sec.title)) ACC_NAV_COLLAPSED.delete(i); });
}

function destroyCharts(){
  chartInstances.forEach(c=>{ try{c.destroy();}catch(e){} });
  chartInstances=[];
}

function accItemLabel(id){
  if(typeof accNavFlat==='function'){
    const it=accNavFlat().find(x=>x.id===id);
    if(it) return it.label;
  }
  return PAGE_TITLE[id]||id;
}

function buildNav(){
  const nav=el('nav');
  if(IN_ACC_SHELL && typeof ACC_NAV_SECTIONS!=='undefined'){
    const linkHtml=it=>`<a href="#${it.id}" data-page="${it.id}" class="${currentPage===it.id?'active':''}"><span class="ico">${it.icon||''}</span>${esc(it.label)}</a>`;
    nav.innerHTML=ACC_NAV_SECTIONS.map((sec,secIdx)=>{
      const collapsed=ACC_NAV_COLLAPSED.has(secIdx);
      let body='';
      if(sec.subgroups&&sec.subgroups.length){
        body=sec.subgroups.map(sg=>{
          const items=sg.items||[];
          if(!items.length) return '';
          return `<div class="nav-acc-sub"><div class="nav-acc-sub-title">${esc(sg.title)}</div>${items.map(linkHtml).join('')}</div>`;
        }).join('');
      } else {
        body=(sec.items||[]).map(linkHtml).join('');
      }
      return `<div class="nav-section">
        <div class="nav-section-title nav-acc-head ${collapsed?'':'open'}" data-acc-sec="${secIdx}">${esc(sec.title)}<span class="chev">▾</span></div>
        <div class="nav-acc-items" ${collapsed?'hidden':''}>${body}</div>
      </div>`;
    }).join('')+`<div class="demo-maker">ساخته‌شده توسط ${esc(MAKER)}<br>داده‌ها کاملاً ساختگی هستند</div>`;
    return;
  }
  let html='';
  let lastGroup=null;
  NAV.forEach(it=>{
    if(it.group && it.group!==lastGroup){
      html+=`<div class="nav-section-title">${esc(it.group)}</div>`;
      lastGroup=it.group;
    }
    if(!it.group) lastGroup=null;
    const badge=it.id==='followups'?'<span class="badge">7</span>':'';
    html+=`<a href="#${it.id}" data-page="${it.id}" class="${currentPage===it.id?'active':''}"><span class="ico">${it.icon}</span>${esc(it.label)}${badge}</a>`;
  });
  html+=`<div class="demo-maker">ساخته‌شده توسط ${esc(MAKER)}<br>داده‌ها کاملاً ساختگی هستند</div>`;
  nav.innerHTML=html;
}

function enterAccountingShell(){
  IN_ACC_SHELL=true;
  el('brandRole').textContent='🧮 ماژول حسابداری';
  go('acc-dash');
}
function exitAccountingShell(){
  IN_ACC_SHELL=false;
  el('brandRole').textContent='پنل مدیریت';
  go('dash');
}

function go(page, fromBack){
  if(page==='accounting'){ enterAccountingShell(); return; }
  if(page==='exit-acc-shell'){ exitAccountingShell(); return; }
  const known=PAGE_TITLE[page] || (page&&page.startsWith('acc-'));
  if(!known) page='dash';
  if(!fromBack && currentPage && currentPage!==page) pageHistory.push(currentPage);
  currentPage=page;
  el('pageTitle').textContent=PAGE_TITLE[page]||accItemLabel(page);
  buildNav();
  destroyCharts();
  const fn={
    dash:renderDash, customers:renderCustomers, followups:renderFollowups,
    'crm-dashboard':renderCrmDash, invoices:renderInvoices, products:renderProducts,
    reminders:renderReminders, reports:renderReports, ai:renderAi,
    b2bOrders:renderB2b, accounting:enterAccountingShell, messages:renderMessages,
    settings:renderSettings, help:renderHelp,
  };
  if(fn[page]) fn[page]();
  else if(page.startsWith('acc-')) renderAccPage(page);
  else renderDash();
}

function enterDemo(){
  el('login').style.display='none';
  el('app').classList.add('demo-on');
  go('dash');
}
function exitDemo(){
  closeDrawer();
  el('app').classList.remove('demo-on');
  el('login').style.display='flex';
  el('loginErr').textContent='';
}

function toggleTheme(){
  const dark=document.documentElement.getAttribute('data-theme')==='dark';
  document.documentElement.setAttribute('data-theme', dark?'light':'dark');
  const label=dark?'🌙 حالت تاریک':'☀️ حالت روشن';
  ['loginThemeBtn','acctThemeBtn'].forEach(id=>{ const b=el(id); if(b) b.textContent=label; });
}
function openDrawer(){
  el('acctFab').classList.add('open');
  el('acctDrawer').classList.add('open');
  el('acctDrawerBackdrop').classList.add('open');
  el('acctFab').setAttribute('aria-expanded','true');
}
function closeDrawer(){
  el('acctFab').classList.remove('open');
  el('acctDrawer').classList.remove('open');
  el('acctDrawerBackdrop').classList.remove('open');
  el('acctFab').setAttribute('aria-expanded','false');
}

function renderDash(){
  const firm=D.invoices.filter(isFirm);
  const totalRev=firm.reduce((s,i)=>s+i.final,0);
  const typeCount={proforma:0,normal:0,final:0};
  D.invoices.forEach(i=>{ typeCount[i.type]=(typeCount[i.type]||0)+1; });
  const openFup=D.followups.filter(f=>f.status==='open').length;
  const low=D.products.filter(p=>p.stock<15).length;
  const debitSum=D.customers.filter(c=>c.balance<0).reduce((s,c)=>s-c.balance,0);
  const creditSum=D.customers.filter(c=>c.balance>0).reduce((s,c)=>s+c.balance,0);
  const board=['کارشناس فروش ۱','کارشناس فروش ۲'].map(name=>{
    const custs=D.customers.filter(c=>c.salesperson===name);
    const sales=firm.filter(i=>i.salesperson===name).reduce((s,i)=>s+i.final,0);
    const fup=D.followups.filter(f=>custs.some(c=>c.biz===f.cust)&&f.status==='open').length;
    return {name,custCount:custs.length,totalSales:sales,openFup:fup};
  });
  el('view').innerHTML=`
    <div class="cards bento-hero">
      ${statCard('p','👥', fmt(D.customers.length),'کل مشتریان')}
      ${statCard('g','💰', fmt(totalRev),'فروش کل')}
      ${statCard('o','🧾', fmt(typeCount.normal+typeCount.final),'فاکتور رسمی')}
      ${statCard('b','📋', fmt(typeCount.proforma),'پیش‌فاکتور')}
      ${statCard('p','🛍️', fmt(D.products.length),'کالاها')}
      ${statCard('b','📞', fmt(openFup),'پیگیری باز')}
      ${statCard('r','📉', fmt(low),'موجودی کم')}
      ${statCard('r','📤', fmt(debitSum),'مانده جمع بدهکاران')}
      ${statCard('g','📥', fmt(creditSum),'مانده جمع بستانکاران')}
    </div>
    <div class="panel">
      <div class="panel-head"><h4>عملکرد کارشناسان</h4></div>
      <div class="panel-body tbl-wrap tbl-scroll">
        <table class="tbl m-stack">
          <thead><tr><th>کارشناس</th><th data-col-kind="qty">مشتریان</th><th data-col-kind="money">فروش</th><th data-col-kind="qty">پیگیری</th></tr></thead>
          <tbody>${board.map(u=>`<tr>
            <td data-label="کارشناس">${esc(u.name)}</td>
            <td data-label="مشتریان">${fmt(u.custCount)}</td>
            <td data-label="فروش" class="mono">${fmt(u.totalSales)}</td>
            <td data-label="پیگیری">${fmt(u.openFup)}</td></tr>`).join('')}</tbody>
        </table>
      </div>
    </div>
    <div class="panel">
      <div class="panel-head"><h4>مانده مشتریان</h4></div>
      <div class="panel-body tbl-wrap tbl-scroll">
        <table class="tbl m-stack">
          <thead><tr>
            <th>فروشگاه</th><th>نام</th><th>ماهیت</th>
            <th data-col-kind="debit">بدهکار</th><th data-col-kind="credit">بستانکار</th>
            <th>آدرس</th><th>کارشناس</th>
          </tr></thead>
          <tbody>${D.customers.map(c=>`<tr>
            <td>${esc(c.biz)}</td><td>${esc(c.owner)}</td>
            <td>${c.balance<0?'بدهکار':c.balance>0?'بستانکار':'—'}</td>
            <td class="mono">${debit(c.balance)}</td><td class="mono">${credit(c.balance)}</td>
            <td class="muted">${esc(c.address)}</td><td class="muted">${esc(c.salesperson)}</td>
          </tr>`).join('')}</tbody>
        </table>
      </div>
    </div>`;
}

function renderCustomers(){
  el('view').innerHTML=`
    <div class="toolbar">
      <input class="search" id="cSearch" placeholder="جستجو: نام کامل یا نام فروشگاه..." value="${esc(custFilter.q)}">
      <select id="cStatus">
        <option value="">همه وضعیت‌ها</option>
        ${['vip','active','followup','silent','new'].map(s=>`<option value="${s}" ${custFilter.status===s?'selected':''}>${STATUS_LABEL[s]}</option>`).join('')}
      </select>
      <button type="button" class="btn" data-act="readonly">➕ مشتری جدید</button>
      <button type="button" class="btn ghost" data-act="readonly">📥 اکسل</button>
    </div>
    <div class="panel"><div class="panel-body tbl-wrap tbl-scroll"><div id="custTable"></div></div></div>`;
  el('cSearch').addEventListener('input', e=>{ custFilter.q=e.target.value; paintCustomers(); });
  el('cStatus').addEventListener('change', e=>{ custFilter.status=e.target.value; paintCustomers(); });
  paintCustomers();
}
function paintCustomers(){
  let rows=D.customers.slice();
  const q=custFilter.q.trim();
  if(q) rows=rows.filter(c=>(c.biz+' '+c.owner+' '+c.city+' '+c.phone).includes(q));
  if(custFilter.status) rows=rows.filter(c=>c.status===custFilter.status);
  const debitSum=rows.filter(c=>c.balance<0).reduce((s,c)=>s-c.balance,0);
  const creditSum=rows.filter(c=>c.balance>0).reduce((s,c)=>s+c.balance,0);
  el('custTable').innerHTML=`<table class="tbl"><thead><tr>
    <th>نام کامل</th><th>نام فروشگاه</th><th>موبایل</th><th class="no-sort">عملیات</th>
    <th>شهر</th><th>آدرس</th><th>نوع</th><th>وضعیت</th>
    <th data-col-kind="debit">بدهکار</th><th data-col-kind="credit">بستانکار</th><th>کارشناس</th>
  </tr></thead><tbody>${rows.map(c=>`<tr>
    <td>${esc(c.owner)}</td><td>${esc(c.biz)}</td>
    <td class="mono">${esc(c.phone)}</td>
    <td class="no-sort"><button type="button" class="btn sm ghost" data-act="readonly">✏️</button>
      <button type="button" class="btn sm ghost" data-act="readonly">📋</button></td>
    <td>${esc(c.city)}</td><td class="muted">${esc(c.address)}</td>
    <td>${esc(c.type)}</td><td>${tag(c.status)}</td>
    <td class="mono">${debit(c.balance)}</td><td class="mono">${credit(c.balance)}</td>
    <td class="muted">${esc(c.salesperson)}</td>
  </tr>`).join('')||'<tr><td colspan="11" class="empty">موردی یافت نشد</td></tr>'}</tbody>
  <tfoot><tr>
    <td colspan="8">جمع (${fmt(rows.length)} مشتری)</td>
    <td class="mono">${debitSum?fmt(debitSum):'-'}</td>
    <td class="mono">${creditSum?fmt(creditSum):'-'}</td>
    <td></td>
  </tr></tfoot></table>`;
}

function renderFollowups(){
  el('view').innerHTML=`
    <div class="toolbar">
      <input class="search" id="fSearch" placeholder="جستجو مشتری / موضوع..." value="${esc(fupFilter.q)}">
      <select id="fStatus">
        <option value="">همه وضعیت‌ها</option>
        ${['open','done','cancel'].map(s=>`<option value="${s}" ${fupFilter.status===s?'selected':''}>${STATUS_LABEL[s]}</option>`).join('')}
      </select>
      <button type="button" class="btn sm" data-page="crm-dashboard">📉 داشبورد CRM</button>
      <button type="button" class="btn" data-act="readonly">➕ جدید</button>
    </div>
    <div class="panel"><div class="panel-body tbl-wrap tbl-scroll"><div id="fupTable"></div></div></div>`;
  el('fSearch').addEventListener('input', e=>{ fupFilter.q=e.target.value; paintFollowups(); });
  el('fStatus').addEventListener('change', e=>{ fupFilter.status=e.target.value; paintFollowups(); });
  paintFollowups();
}
function paintFollowups(){
  let rows=D.followups.slice().sort((a,b)=>b.date.localeCompare(a.date));
  const q=fupFilter.q.trim();
  if(q) rows=rows.filter(f=>(f.cust+' '+f.subject).includes(q));
  if(fupFilter.status) rows=rows.filter(f=>f.status===fupFilter.status);
  el('fupTable').innerHTML=`<table class="tbl"><thead><tr>
    <th>مشتری</th><th>شهر</th><th>تاریخ</th><th>نوع تماس</th><th>موضوع</th><th>اولویت</th><th>وضعیت</th>
  </tr></thead><tbody>${rows.map(f=>`<tr>
    <td>${esc(f.cust)}</td><td>${esc(f.city)}</td><td class="mono">${esc(f.date)}</td>
    <td>${esc(f.type)}</td><td>${esc(f.subject)}</td>
    <td>${tag(f.priority)}</td><td>${tag(f.status)}</td>
  </tr>`).join('')||'<tr><td colspan="7" class="empty">موردی یافت نشد</td></tr>'}</tbody></table>`;
}

function renderInvoices(){
  el('view').innerHTML=`
    <div class="toolbar">
      <input class="search" id="iSearch" placeholder="جستجو شماره یا مشتری..." value="${esc(invFilter.q)}">
      <select id="iType">
        <option value="">همه انواع</option>
        <option value="proforma" ${invFilter.type==='proforma'?'selected':''}>پیش‌فاکتور</option>
        <option value="normal" ${invFilter.type==='normal'?'selected':''}>فاکتور عادی</option>
        <option value="final" ${invFilter.type==='final'?'selected':''}>فاکتور نهایی</option>
      </select>
      <button type="button" class="btn" data-act="readonly">➕ فاکتور جدید</button>
    </div>
    <div class="panel">
      <div class="panel-head"><h4>سه نوع فاکتور</h4></div>
      <div class="panel-body muted">پیش‌فاکتور: اعلام قیمت بدون کسر موجودی. فاکتور عادی: فروش قطعی. فاکتور نهایی: فروش قطعی + صف مودیان.</div>
    </div>
    <div class="panel"><div class="panel-body tbl-wrap tbl-scroll"><div id="invTable"></div></div></div>`;
  el('iSearch').addEventListener('input', e=>{ invFilter.q=e.target.value; paintInvoices(); });
  el('iType').addEventListener('change', e=>{ invFilter.type=e.target.value; paintInvoices(); });
  paintInvoices();
}
function paintInvoices(){
  let rows=D.invoices.slice().reverse();
  const q=invFilter.q.trim();
  if(q) rows=rows.filter(i=>(i.num+' '+i.cust).includes(q));
  if(invFilter.type) rows=rows.filter(i=>i.type===invFilter.type);
  el('invTable').innerHTML=`<table class="tbl"><thead><tr>
    <th>شماره</th><th>تاریخ</th><th>مشتری</th><th>نوع</th><th>کالا</th>
    <th data-col-kind="qty">تعداد</th><th data-col-kind="money">مبلغ</th><th>کارشناس</th>
  </tr></thead><tbody>${rows.map(i=>`<tr>
    <td class="mono">${esc(i.num)}</td><td class="mono">${esc(i.date)}</td>
    <td>${esc(i.cust)}</td>
    <td><span class="tag t-${i.type==='final'?'final':i.type==='proforma'?'proforma':'active'}">${esc(INV_LABEL[i.type])}</span></td>
    <td>${esc(i.product)}</td>
    <td class="mono">${fmt(i.qty)}</td><td class="mono">${fmt(i.final)}</td>
    <td class="muted">${esc(i.salesperson)}</td>
  </tr>`).join('')||'<tr><td colspan="8" class="empty">موردی یافت نشد</td></tr>'}</tbody></table>`;
}

function renderProducts(){
  el('view').innerHTML=`
    <div class="toolbar">
      <input class="search" id="pSearch" placeholder="جستجو نام یا کد کالا...">
      <button type="button" class="btn" data-act="readonly">➕ کالای جدید</button>
    </div>
    <div class="panel"><div class="panel-body tbl-wrap tbl-scroll"><div id="prodTable"></div></div></div>`;
  const paint=()=>{
    const q=(el('pSearch').value||'').trim();
    const rows=D.products.filter(p=>!q||p.name.includes(q)||p.code.includes(q));
    el('prodTable').innerHTML=`<table class="tbl"><thead><tr>
      <th>کد</th><th>نام کالا</th><th>گروه</th><th data-col-kind="money">قیمت</th><th data-col-kind="qty">موجودی</th>
    </tr></thead><tbody>${rows.map(p=>`<tr>
      <td class="mono">${esc(p.code)}</td><td>${esc(p.name)}</td><td>${esc(p.cat)}</td>
      <td class="mono">${fmt(p.price)}</td>
      <td class="mono">${p.stock<15?`<span class="demo-debit">${fmt(p.stock)}</span>`:fmt(p.stock)}</td>
    </tr>`).join('')}</tbody></table>`;
  };
  el('pSearch').addEventListener('input', paint);
  paint();
}

function renderCrmDash(){
  const firm=D.invoices.filter(isFirm);
  const months=['1403/01','1403/02','1403/03','1403/04','1403/05','1403/06'];
  const monthNames=['فروردین','اردیبهشت','خرداد','تیر','مرداد','شهریور'];
  const rev=months.map(m=>firm.filter(i=>i.month===m).reduce((s,i)=>s+i.final,0));
  const typeCount={proforma:0,normal:0,final:0};
  D.invoices.forEach(i=>{ typeCount[i.type]++; });
  el('view').innerHTML=`
    <div class="cards">
      ${statCard('g','💰', fmt(firm.reduce((s,i)=>s+i.final,0)),'فروش قطعی')}
      ${statCard('b','📋', fmt(typeCount.proforma),'پیش‌فاکتور')}
      ${statCard('o','🧾', fmt(typeCount.normal),'فاکتور عادی')}
      ${statCard('p','📄', fmt(typeCount.final),'فاکتور نهایی')}
    </div>
    <div class="panel"><div class="panel-head"><h4>روند فروش قطعی</h4></div>
      <div class="panel-body crm-chart-box"><canvas id="crmTrendChart"></canvas></div></div>
    <div class="panel"><div class="panel-head"><h4>اقدامات فوری</h4></div>
      <div class="panel-body tbl-wrap"><table class="tbl"><thead><tr><th>نوع</th><th>مشتری</th><th>موضوع</th></tr></thead>
      <tbody>${D.followups.filter(f=>f.priority==='high'&&f.status==='open').map(f=>`<tr>
        <td>${tag('high')}</td><td>${esc(f.cust)}</td><td>${esc(f.subject)}</td>
      </tr>`).join('')}</tbody></table></div></div>`;
  const canvas=el('crmTrendChart');
  if(canvas && window.Chart){
    chartInstances.push(new Chart(canvas,{
      type:'line',
      data:{labels:monthNames,datasets:[{label:'فروش',data:rev,borderColor:'#1A5C38',backgroundColor:'rgba(26,92,56,.12)',fill:true,tension:.3}]},
      options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}}}
    }));
  }
}

function modulePanel(title, body){
  el('view').innerHTML=`
    <div class="panel">
      <div class="panel-head"><h4>${esc(title)}</h4></div>
      <div class="panel-body">${body}</div>
    </div>`;
}

function renderReminders(){
  modulePanel('یادآورها', `
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th>تاریخ</th><th>موضوع</th><th>وضعیت</th></tr></thead>
    <tbody>${D.followups.filter(f=>f.status==='open').slice(0,6).map(f=>`<tr>
      <td class="mono">${esc(f.date)}</td><td>${esc(f.subject)} — ${esc(f.cust)}</td><td>${tag(f.priority)}</td>
    </tr>`).join('')}</tbody></table></div>`);
}
function renderReports(){
  const firm=D.invoices.filter(isFirm);
  modulePanel('گزارشات', `
    <div class="cards">
      ${statCard('g','💰', fmt(firm.reduce((s,i)=>s+i.final,0)),'فروش قطعی')}
      ${statCard('p','👥', fmt(D.customers.length),'مشتری')}
      ${statCard('o','🧾', fmt(firm.length),'فاکتور قطعی')}
    </div>
    <p class="muted">گزارش‌های کامل فروش، مانده و کارشناسان در همین شل برنامه در نسخه اصلی فعال است.</p>`);
}
function renderAi(){
  modulePanel('دستیار هوشمند', `<p class="muted">دستیار هوشمند در نسخه اصلی به دادهٔ واقعی وصل است. در نمایش ایستا شبکه قطع است و پاسخی ارسال نمی‌شود.</p>`);
}
function renderB2b(){
  modulePanel('سفارشات پورتال', `<p class="muted">سفارش‌های پورتال مشتریان در نسخه اصلی اینجا فهرست می‌شوند. دادهٔ این صفحه ساختگی است و سفارشی ثبت نمی‌شود.</p>`);
}
function renderAccounting(){ enterAccountingShell(); }
function renderMessages(){
  modulePanel('پیام‌ها', `<p class="muted">صندوق پیام داخلی نسخه اصلی. در نمایش ایستا پیامی ارسال یا ذخیره نمی‌شود.</p>`);
}
function renderSettings(){
  el('view').innerHTML=`
    <div class="sett-hero">
      <div class="sett-hero-top"><div>
        <h2>تنظیمات</h2>
        <p>ساخته‌شده توسط ${esc(MAKER)}. این صفحه فقط ظاهر تنظیمات را نشان می‌دهد.</p>
      </div></div>
    </div>
    <div class="panel"><div class="panel-head"><h4>شرکت سازنده</h4></div>
      <div class="panel-body">برنامه ERP ترنم توسط <b>${esc(MAKER)}</b> طراحی و پیاده‌سازی شده است.</div></div>`;
}
function renderHelp(){
  el('view').innerHTML=`
    <div class="help-section open">
      <div class="hs-head"><span class="hs-icon">🎯</span> نسخه نمایشی</div>
      <div class="hs-body">
        <p>این همان ظاهر برنامه ERP ترنم است. داده‌ها کاملاً ساختگی هستند و چیزی روی سرور ذخیره نمی‌شود.</p>
        <p>سازنده برنامه: <b>${esc(MAKER)}</b></p>
        <ul>
          <li><b>پیش‌فاکتور</b> اعلام قیمت است</li>
          <li><b>فاکتور عادی</b> فروش قطعی است</li>
          <li><b>فاکتور نهایی</b> فروش قطعی به‌همراه مودیان است</li>
          <li>منوی <b>حسابداری</b> همان شل کامل برنامه است (اشخاص، کالا، انبار، بانک، فروش، چک، اسناد، تولید، حقوق، دارایی)</li>
        </ul>
      </div>
    </div>`;
}

(function seedAccounting(){
  D.coa=[
    {code:'1101',name:'صندوق',kind:'دارایی',debit:8500000,credit:0},
    {code:'1103',name:'حساب‌های دریافتنی',kind:'دارایی',debit:27500000,credit:0},
    {code:'1105',name:'موجودی کالا',kind:'دارایی',debit:42000000,credit:0},
    {code:'1201',name:'بانک ملت',kind:'دارایی',debit:18500000,credit:0},
    {code:'2101',name:'حساب‌های پرداختنی',kind:'بدهی',debit:0,credit:9200000},
    {code:'2103',name:'اسناد پرداختنی',kind:'بدهی',debit:0,credit:4500000},
    {code:'3101',name:'سرمایه',kind:'حقوق صاحبان سهام',debit:0,credit:50000000},
    {code:'4101',name:'فروش',kind:'درآمد',debit:0,credit:119846750},
    {code:'5101',name:'بهای تمام‌شده کالای فروش‌رفته',kind:'هزینه',debit:62000000,credit:0},
    {code:'6101',name:'هزینه عملیاتی',kind:'هزینه',debit:8400000,credit:0},
  ];
  D.journals=[
    {num:'JE-01402',date:'1403/06/12',desc:'فروش قطعی بوتیک بهار',debit:2450000,credit:2450000,status:'ثبت‌شده'},
    {num:'JE-01403',date:'1403/06/14',desc:'خرید پارچه از تأمین‌کننده',debit:6800000,credit:6800000,status:'ثبت‌شده'},
    {num:'JE-01404',date:'1403/06/18',desc:'دریافت چک بوتیک مروارید',debit:5000000,credit:5000000,status:'ثبت‌شده'},
    {num:'JE-01405',date:'1403/06/22',desc:'هزینه حمل انبار',debit:420000,credit:420000,status:'پیش‌نویس'},
    {num:'JE-01406',date:'1403/06/25',desc:'حقوق خرداد',debit:18700000,credit:18700000,status:'ثبت‌شده'},
  ];
  D.banks=[
    {name:'بانک ملت — جاری',no:'1234567890',balance:18500000},
    {name:'بانک ملی — کوتاه‌مدت',no:'0099887766',balance:6200000},
  ];
  D.cashBoxes=[{name:'صندوق فروشگاه',balance:3200000},{name:'صندوق کارگاه',balance:5300000}];
  D.warehouses=[{name:'انبار کارگاه',city:'مشهد',sku:12},{name:'انبار فروش',city:'مشهد',sku:8}];
  D.purchases=[
    {num:'P-0012',date:'1403/05/20',sup:'نساجی شرق',final:6800000,status:'ثبت‌شده'},
    {num:'P-0013',date:'1403/06/02',sup:'نخ و دوخت پارس',final:2100000,status:'ثبت‌شده'},
    {num:'P-0014',date:'1403/06/18',sup:'ملزومات بسته‌بندی',final:890000,status:'پیش‌فاکتور'},
  ];
  D.cheques=[
    {num:'889221',kind:'دریافتنی',party:'بوتیک مروارید',date:'1403/07/01',amount:5000000,status:'نزد صندوق'},
    {num:'441102',kind:'پرداختنی',party:'نساجی شرق',date:'1403/07/10',amount:3200000,status:'صادر شده'},
    {num:'889334',kind:'دریافتنی',party:'بوتیک رز',date:'1403/07/15',amount:8000000,status:'در جریان وصول'},
  ];
  D.payroll=[
    {name:'فاطمه نوری',role:'خیاط',base:14500000,net:12800000},
    {name:'حسین اکبری',role:'برشکار',base:13200000,net:11600000},
    {name:'مریم صالحی',role:'حسابدار',base:16000000,net:14100000},
  ];
  D.prodOrders=[
    {num:'MO-118',product:'مانتو لینن بهاره',qty:80,status:'در جریان'},
    {num:'MO-119',product:'پالتو زمستانی',qty:40,status:'برنامه‌ریزی'},
    {num:'MO-120',product:'شومیز کتان',qty:120,status:'بسته'},
  ];
  D.assets=[
    {name:'چرخ صنعتی جکی',code:'FA-01',cost:28000000,dep:4200000},
    {name:'وانت حمل',code:'FA-02',cost:65000000,dep:9800000},
  ];
})();

function accTable(title, cols, rows, extra){
  el('view').innerHTML=`
    <div class="toolbar">
      <button type="button" class="btn" data-act="readonly">➕ جدید</button>
      <button type="button" class="btn ghost" data-act="readonly">📥 اکسل</button>
    </div>
    ${extra||''}
    <div class="panel">
      <div class="panel-head"><h4>${esc(title)}</h4></div>
      <div class="panel-body tbl-wrap tbl-scroll">
        <table class="tbl"><thead><tr>${cols.map(c=>`<th>${esc(c)}</th>`).join('')}</tr></thead>
        <tbody>${rows.join('')||`<tr><td colspan="${cols.length}" class="empty">موردی یافت نشد</td></tr>`}</tbody></table>
      </div>
    </div>`;
}

function renderAccDash(){
  const firm=D.invoices.filter(isFirm);
  const sales=firm.reduce((s,i)=>s+i.final,0);
  const recv=D.customers.filter(c=>c.balance<0).reduce((s,c)=>s-c.balance,0);
  const pay=D.customers.filter(c=>c.balance>0).reduce((s,c)=>s+c.balance,0);
  el('view').innerHTML=`
    <div class="cards bento-hero">
      ${statCard('g','💰', fmt(sales),'فروش قطعی')}
      ${statCard('r','📤', fmt(recv),'مطالبات')}
      ${statCard('b','🏦', fmt(D.banks.reduce((s,b)=>s+b.balance,0)),'مانده بانک')}
      ${statCard('o','📝', fmt(D.journals.length),'اسناد دوره')}
      ${statCard('p','📦', fmt(D.products.length),'کالا')}
      ${statCard('g','🏭', fmt(D.prodOrders.length),'سفارش تولید')}
    </div>
    <div class="panel">
      <div class="panel-head"><h4>آخرین اسناد حسابداری</h4></div>
      <div class="panel-body tbl-wrap"><table class="tbl"><thead><tr>
        <th>شماره</th><th>تاریخ</th><th>شرح</th><th>بدهکار</th><th>بستانکار</th><th>وضعیت</th>
      </tr></thead><tbody>${D.journals.map(j=>`<tr>
        <td class="mono">${esc(j.num)}</td><td class="mono">${esc(j.date)}</td><td>${esc(j.desc)}</td>
        <td class="mono">${fmt(j.debit)}</td><td class="mono">${fmt(j.credit)}</td>
        <td><span class="tag ${j.status==='ثبت‌شده'?'t-active':'t-pending'}">${esc(j.status)}</span></td>
      </tr>`).join('')}</tbody></table></div>
    </div>
    <div class="panel">
      <div class="panel-head"><h4>کدینگ حساب‌ها</h4></div>
      <div class="panel-body tbl-wrap"><table class="tbl"><thead><tr>
        <th>کد</th><th>حساب</th><th>ماهیت</th><th>بدهکار</th><th>بستانکار</th>
      </tr></thead><tbody>${D.coa.map(a=>`<tr>
        <td class="mono">${esc(a.code)}</td><td>${esc(a.name)}</td><td>${esc(a.kind)}</td>
        <td class="mono">${a.debit?fmt(a.debit):'-'}</td><td class="mono">${a.credit?fmt(a.credit):'-'}</td>
      </tr>`).join('')}</tbody></table></div>
    </div>`;
}

function renderAccPage(page){
  const title=accItemLabel(page);
  const firm=D.invoices.filter(isFirm);
  if(page==='acc-dash'){ renderAccDash(); return; }
  if(page==='help'){ renderHelp(); return; }

  if(page==='acc-parties'||page==='acc-customer-groups'){
    accTable(title,['نام کامل','فروشگاه','شهر','بدهکار','بستانکار','کارشناس'],
      D.customers.map(c=>`<tr><td>${esc(c.owner)}</td><td>${esc(c.biz)}</td><td>${esc(c.city)}</td>
        <td class="mono">${debit(c.balance)}</td><td class="mono">${credit(c.balance)}</td>
        <td class="muted">${esc(c.salesperson)}</td></tr>`));
    return;
  }
  if(page==='acc-receivables'||page==='acc-statement'){
    accTable(title,['فروشگاه','نام','بدهکار','بستانکار','کارشناس'],
      D.customers.filter(c=>c.balance!==0).map(c=>`<tr><td>${esc(c.biz)}</td><td>${esc(c.owner)}</td>
        <td class="mono">${debit(c.balance)}</td><td class="mono">${credit(c.balance)}</td>
        <td class="muted">${esc(c.salesperson)}</td></tr>`));
    return;
  }
  if(page==='acc-products'||page==='acc-product-groups'||page==='acc-units'||page==='acc-product-colors'||page==='acc-product-sizes'){
    accTable(title,['کد','نام','گروه','قیمت','موجودی'],
      D.products.map(p=>`<tr><td class="mono">${esc(p.code)}</td><td>${esc(p.name)}</td><td>${esc(p.cat)}</td>
        <td class="mono">${fmt(p.price)}</td><td class="mono">${fmt(p.stock)}</td></tr>`));
    return;
  }
  if(page==='acc-sales-invoices'||page==='acc-normal-invoices'||page==='acc-final-invoices'||page==='acc-proforma'||page==='acc-invoice-list-tax'){
    const type=page==='acc-proforma'?'proforma':page==='acc-normal-invoices'?'normal':page==='acc-final-invoices'?'final':'';
    const rows=type?D.invoices.filter(i=>i.type===type):D.invoices;
    accTable(title,['شماره','تاریخ','مشتری','نوع','مبلغ'],
      rows.slice().reverse().map(i=>`<tr><td class="mono">${esc(i.num)}</td><td class="mono">${esc(i.date)}</td>
        <td>${esc(i.cust)}</td><td><span class="tag t-${i.type==='final'?'final':i.type==='proforma'?'proforma':'active'}">${esc(INV_LABEL[i.type])}</span></td>
        <td class="mono">${fmt(i.final)}</td></tr>`),
      `<div class="panel"><div class="panel-body muted">پیش‌فاکتور اثر دفتر ندارد. فاکتور عادی فروش قطعی است. فاکتور نهایی فروش قطعی + مودیان است.</div></div>`);
    return;
  }
  if(page==='acc-purchases'||page==='acc-purchase-returns'||page==='acc-sales-returns'||page==='acc-orders-list'){
    accTable(title,['شماره','تاریخ','طرف‌حساب','مبلغ','وضعیت'],
      D.purchases.map(p=>`<tr><td class="mono">${esc(p.num)}</td><td class="mono">${esc(p.date)}</td>
        <td>${esc(p.sup)}</td><td class="mono">${fmt(p.final)}</td><td>${esc(p.status)}</td></tr>`));
    return;
  }
  if(page==='acc-journal-docs'||page==='acc-journal-entry'||page==='acc-journal-book'||page==='acc-opening-voucher'||page==='acc-close-temp'||page==='acc-close-perm'||page==='acc-revaluation'){
    accTable(title,['شماره','تاریخ','شرح','بدهکار','بستانکار','وضعیت'],
      D.journals.map(j=>`<tr><td class="mono">${esc(j.num)}</td><td class="mono">${esc(j.date)}</td><td>${esc(j.desc)}</td>
        <td class="mono">${fmt(j.debit)}</td><td class="mono">${fmt(j.credit)}</td><td>${esc(j.status)}</td></tr>`));
    return;
  }
  if(page==='acc-coa-codes'||page==='acc-account-groups'||page==='acc-ledger-accounts'||page==='acc-subsidiary-accounts'||page==='acc-detail-accounts'||page==='acc-detail-categories'||page==='acc-other-details'||page==='acc-trial-balance'||page==='acc-financial-statement'||page==='acc-pl-statement'||page==='acc-reconciliation'){
    const deb=D.coa.reduce((s,a)=>s+a.debit,0);
    const cred=D.coa.reduce((s,a)=>s+a.credit,0);
    accTable(title,['کد','حساب','ماهیت','بدهکار','بستانکار'],
      D.coa.map(a=>`<tr><td class="mono">${esc(a.code)}</td><td>${esc(a.name)}</td><td>${esc(a.kind)}</td>
        <td class="mono">${a.debit?fmt(a.debit):'-'}</td><td class="mono">${a.credit?fmt(a.credit):'-'}</td></tr>`),
      `<div class="cards">${statCard('r','📤',fmt(deb),'جمع بدهکار')}${statCard('g','📥',fmt(cred),'جمع بستانکار')}</div>`);
    return;
  }
  if(page==='acc-banks'||page==='acc-account-transfer'||page==='acc-bank-recon'||page==='acc-cash-flow-std'){
    accTable(title,['حساب','شماره','مانده'],
      D.banks.map(b=>`<tr><td>${esc(b.name)}</td><td class="mono">${esc(b.no)}</td><td class="mono">${fmt(b.balance)}</td></tr>`));
    return;
  }
  if(page==='acc-cash-boxes'||page==='acc-petty-cash-ops'){
    accTable(title,['صندوق','مانده'],
      D.cashBoxes.map(c=>`<tr><td>${esc(c.name)}</td><td class="mono">${fmt(c.balance)}</td></tr>`));
    return;
  }
  if(page==='acc-warehouses'||page==='acc-warehouse-ops'||page==='acc-warehouse-report'||page==='acc-stocktaking'||page==='acc-item-kardex'||page==='acc-inv-batches'||page==='acc-inv-reservations'||page==='acc-inv-landed'||page==='acc-consignments'){
    accTable(title,['انبار','شهر','تعداد کالا'],
      D.warehouses.map(w=>`<tr><td>${esc(w.name)}</td><td>${esc(w.city)}</td><td class="mono">${fmt(w.sku)}</td></tr>`));
    return;
  }
  if(page.startsWith('acc-cheques')||page==='acc-cheque-register'||page==='acc-trust-checks'||page==='acc-opening-recv-cheques'||page==='acc-opening-pay-cheques'||page==='acc-check-categories'){
    accTable(title,['شماره چک','نوع','طرف‌حساب','سررسید','مبلغ','وضعیت'],
      D.cheques.map(c=>`<tr><td class="mono">${esc(c.num)}</td><td>${esc(c.kind)}</td><td>${esc(c.party)}</td>
        <td class="mono">${esc(c.date)}</td><td class="mono">${fmt(c.amount)}</td><td>${esc(c.status)}</td></tr>`));
    return;
  }
  if(page.startsWith('acc-payroll')){
    accTable(title,['کارمند','سمت','حقوق پایه','خالص پرداختی'],
      D.payroll.map(p=>`<tr><td>${esc(p.name)}</td><td>${esc(p.role)}</td>
        <td class="mono">${fmt(p.base)}</td><td class="mono">${fmt(p.net)}</td></tr>`));
    return;
  }
  if(page.startsWith('acc-production')){
    accTable(title,['شماره','محصول','تعداد','وضعیت'],
      D.prodOrders.map(o=>`<tr><td class="mono">${esc(o.num)}</td><td>${esc(o.product)}</td>
        <td class="mono">${fmt(o.qty)}</td><td>${esc(o.status)}</td></tr>`));
    return;
  }
  if(page==='acc-fixed-assets'){
    accTable(title,['کد','دارایی','بهای تمام‌شده','استهلاک انباشته'],
      D.assets.map(a=>`<tr><td class="mono">${esc(a.code)}</td><td>${esc(a.name)}</td>
        <td class="mono">${fmt(a.cost)}</td><td class="mono">${fmt(a.dep)}</td></tr>`));
    return;
  }
  if(page==='acc-settlements'||page==='acc-receipts'||page==='acc-payments'){
    accTable(title,['تاریخ','طرف‌حساب','نوع','مبلغ'],
      D.journals.filter(j=>/دریافت|فروش|حقوق/.test(j.desc)).map(j=>`<tr>
        <td class="mono">${esc(j.date)}</td><td>${esc(j.desc)}</td><td>دریافت/پرداخت</td>
        <td class="mono">${fmt(j.debit)}</td></tr>`));
    return;
  }
  accTable(title,['عنوان','وضعیت'],
    [`<tr><td>${esc(title)}</td><td><span class="tag t-active">فعال در نسخه نمایشی</span></td></tr>`],
    `<div class="panel"><div class="panel-body muted">این بخش از آخرین منوی حسابداری برنامه است. داده ساختگی است و سندی روی سرور ثبت نمی‌شود.</div></div>`);
}

function tickClock(){
  const c=el('clock'); if(!c) return;
  c.textContent=new Date().toLocaleString('fa-IR',{hour:'2-digit',minute:'2-digit'});
}

function bindShell(){
  document.querySelectorAll('img[src*="logo-sm"]').forEach(img=>{
    img.addEventListener('error', ()=> img.classList.add('is-broken'));
  });
  el('loginForm').addEventListener('submit', e=>{ e.preventDefault(); enterDemo(); });
  el('loginThemeBtn').addEventListener('click', toggleTheme);
  el('acctThemeBtn').addEventListener('click', toggleTheme);
  el('acctBtnOut').addEventListener('click', exitDemo);
  el('acctFab').addEventListener('click', ()=>{
    el('acctDrawer').classList.contains('open')?closeDrawer():openDrawer();
  });
  el('acctDrawerBackdrop').addEventListener('click', closeDrawer);
  el('menuBtn').addEventListener('click', ()=>{
    el('sidebar').classList.toggle('open');
    el('sidebarBackdrop').classList.toggle('show');
  });
  el('sidebarBackdrop').addEventListener('click', ()=>{
    el('sidebar').classList.remove('open');
    el('sidebarBackdrop').classList.remove('show');
  });
  el('navBackBtn').addEventListener('click', ()=>{
    const prev=pageHistory.pop();
    if(prev) go(prev, true);
  });
  el('nav').addEventListener('click', e=>{
    const head=e.target.closest('[data-acc-sec]');
    if(head){
      const i=Number(head.getAttribute('data-acc-sec'));
      if(ACC_NAV_COLLAPSED.has(i)) ACC_NAV_COLLAPSED.delete(i); else ACC_NAV_COLLAPSED.add(i);
      buildNav();
      return;
    }
    const a=e.target.closest('a[data-page]');
    if(!a) return;
    e.preventDefault();
    go(a.getAttribute('data-page'));
    el('sidebar').classList.remove('open');
    el('sidebarBackdrop').classList.remove('show');
  });
  el('view').addEventListener('click', e=>{
    const act=e.target.closest('[data-act]');
    if(act && act.getAttribute('data-act')==='readonly'){ e.preventDefault(); readOnly(); return; }
    const page=e.target.closest('[data-page]');
    if(page){ e.preventDefault(); go(page.getAttribute('data-page')); }
  });
  el('notifBell').addEventListener('click', ()=>go('followups'));
  tickClock();
  setInterval(tickClock, 30000);
}

bindShell();
