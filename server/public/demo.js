// ══════════════════════════════════════════════════════════════
// SAMPLE DATA
// ══════════════════════════════════════════════════════════════
const D = {
  customers: [
    {id:1,biz:'بوتیک بهار',owner:'زهره احمدی',city:'مشهد',phone:'09151234567',type:'بوتیک',status:'vip',source:'instagram',balance:-2500000,user:'حامد رشید'},
    {id:2,biz:'فروشگاه نسیم',owner:'فاطمه حسینی',city:'تهران',phone:'09121234567',type:'فروشگاه',status:'active',source:'referral',balance:0,user:'حامد رشید'},
    {id:3,biz:'عمده‌فروشی گلستان',owner:'محمود قاسمی',city:'اصفهان',phone:'09131234567',type:'عمده‌فروش',status:'active',source:'exhibition',balance:1500000,user:'زهره میرزایی'},
    {id:4,biz:'بوتیک مروارید',owner:'سارا موسوی',city:'مشهد',phone:'09151111111',type:'بوتیک',status:'vip',source:'instagram',balance:-5000000,user:'حامد رشید'},
    {id:5,biz:'فروشگاه آفتاب',owner:'مریم نجفی',city:'تبریز',phone:'09141234567',type:'فروشگاه',status:'active',source:'referral',balance:0,user:'زهره میرزایی'},
    {id:6,biz:'بوتیک سبز',owner:'الهه کریمی',city:'مشهد',phone:'09152222222',type:'بوتیک',status:'followup',source:'store_front',balance:0,user:'حامد رشید'},
    {id:7,biz:'عمده‌فروشی ستاره',owner:'حسن محمدی',city:'شیراز',phone:'09171234567',type:'عمده‌فروش',status:'active',source:'exhibition',balance:3000000,user:'زهره میرزایی'},
    {id:8,biz:'بوتیک رز',owner:'نازنین اکبری',city:'مشهد',phone:'09153333333',type:'بوتیک',status:'vip',source:'instagram',balance:-8000000,user:'حامد رشید'},
    {id:9,biz:'فروشگاه سپید',owner:'فریده قادری',city:'کرج',phone:'09111234567',type:'فروشگاه',status:'silent',source:'other',balance:0,user:'زهره میرزایی'},
    {id:10,biz:'بوتیک طلایی',owner:'مهناز صادقی',city:'مشهد',phone:'09154444444',type:'بوتیک',status:'active',source:'instagram',balance:2000000,user:'حامد رشید'},
    {id:11,biz:'پوشاک کاوه',owner:'علی رضایی',city:'تهران',phone:'09125555555',type:'عمده‌فروش',status:'active',source:'referral',balance:0,user:'زهره میرزایی'},
    {id:12,biz:'بوتیک الماس',owner:'شیرین کیانی',city:'مشهد',phone:'09156666666',type:'بوتیک',status:'vip',source:'instagram',balance:-12000000,user:'حامد رشید'},
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
    {id:1,custId:1,cust:'بوتیک بهار',city:'مشهد',date:'1403/05/15',type:'تماس تلفنی',subject:'پیگیری سفارش مانتو لینن',priority:'high',status:'open',note:'درخواست ۲۰ عدد مانتو لینن بهاره'},
    {id:2,custId:2,cust:'فروشگاه نسیم',city:'تهران',date:'1403/05/18',type:'بازدید حضوری',subject:'معرفی محصولات پاییزه',priority:'mid',status:'open',note:'نمونه کاپشن ارسال شود'},
    {id:3,custId:3,cust:'عمده‌فروشی گلستان',city:'اصفهان',date:'1403/05/12',type:'پیام واتساپ',subject:'ارسال کاتالوگ جدید',priority:'low',status:'done',note:'کاتالوگ ارسال شد'},
    {id:4,custId:4,cust:'بوتیک مروارید',city:'مشهد',date:'1403/05/20',type:'تماس تلفنی',subject:'وصول مطالبات',priority:'high',status:'open',note:'۵ میلیون ریال بدهکاری'},
    {id:5,custId:5,cust:'فروشگاه آفتاب',city:'تبریز',date:'1403/05/22',type:'ارسال ایمیل',subject:'پیشنهاد ویژه عمده',priority:'mid',status:'open',note:'تخفیف ۱۰٪ برای سفارش بالای ۵۰ عدد'},
    {id:6,custId:6,cust:'بوتیک سبز',city:'مشهد',date:'1403/05/10',type:'بازدید حضوری',subject:'بررسی نیاز فصل پاییز',priority:'mid',status:'open',note:''},
    {id:7,custId:7,cust:'عمده‌فروشی ستاره',city:'شیراز',date:'1403/05/25',type:'تماس تلفنی',subject:'تایید سفارش پالتو',priority:'high',status:'open',note:'۴۰ عدد پالتو زمستانی'},
    {id:8,custId:8,cust:'بوتیک رز',city:'مشهد',date:'1403/05/08',type:'پیام واتساپ',subject:'پیگیری فاکتور T-0023',priority:'high',status:'open',note:''},
    {id:9,custId:9,cust:'فروشگاه سپید',city:'کرج',date:'1403/04/15',type:'تماس تلفنی',subject:'احیای ارتباط',priority:'low',status:'done',note:'پاسخ نداد'},
    {id:10,custId:10,cust:'بوتیک طلایی',city:'مشهد',date:'1403/05/30',type:'بازدید حضوری',subject:'نمایش کلکسیون جدید',priority:'mid',status:'open',note:''},
    {id:11,custId:11,cust:'پوشاک کاوه',city:'تهران',date:'1403/05/16',type:'پیام واتساپ',subject:'قیمت‌گذاری عمده شومیز',priority:'low',status:'open',note:''},
    {id:12,custId:12,cust:'بوتیک الماس',city:'مشهد',date:'1403/05/19',type:'تماس تلفنی',subject:'وصول مطالبات — فوری',priority:'high',status:'open',note:'۱۲ میلیون ریال بدهکاری — پیگیری فوری'},
  ]
};

// Generate realistic invoice data
(function genInvoices(){
  const months=['1403/01','1403/02','1403/03','1403/04','1403/05','1403/06'];
  const custData=D.customers;
  const prodData=D.products;
  D.invoices=[];
  const rng=(a,b)=>Math.floor(Math.random()*(b-a+1))+a;
  let seed=42;
  const rand=()=>{ seed=(seed*1664525+1013904223)&0xffffffff; return Math.abs(seed)/0x7fffffff; };
  for(let i=0;i<48;i++){
    const c=custData[Math.floor(rand()*custData.length)];
    const p=prodData[Math.floor(rand()*prodData.length)];
    const qty=Math.floor(rand()*18)+3;
    const m=months[Math.floor(rand()*months.length)];
    const d=Math.floor(rand()*27)+1;
    const disc=rand()<0.3?5:0;
    const subtotal=qty*p.price;
    const discAmt=Math.round(subtotal*disc/100);
    const final=subtotal-discAmt;
    D.invoices.push({
      id:i+1,num:`T-${String(i+1).padStart(4,'0')}`,
      custId:c.id,cust:c.biz,city:c.city,
      salesperson:c.id<=6?'حامد رشید':'زهره میرزایی',
      product:p.name,category:p.cat,
      qty,price:p.price,subtotal,disc,discAmt,final,
      type:rand()<0.35?'proforma':'final',
      month:m,date:`${m}/${String(d).padStart(2,'0')}`,
      paid:rand()<0.65
    });
  }
})();

// ══════════════════════════════════════════════════════════════
// UTILITIES
// ══════════════════════════════════════════════════════════════
const fmt = n => Number(n||0).toLocaleString('fa-IR');
const esc = s => (s==null?'':String(s)).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const statusLabel = {vip:'VIP 👑',active:'فعال',followup:'پیگیری',silent:'خاموش',new:'جدید'};
const statusClass = {vip:'vip',active:'active',followup:'followup',silent:'silent',new:'new'};
const priLabel = {high:'فوری',mid:'متوسط',low:'عادی'};
const priClass = {high:'high',mid:'mid',low:'low'};
const catEmoji = {'مانتو':'🧥','شومیز':'👚','دامن':'👗','بلوز':'👕','پالتو':'🧣','تونیک':'👘','شلوار':'👖','کاپشن':'🥻'};

function sparkline(data, color='#7c3aed'){
  const mx=Math.max(...data,1);
  return `<span class="sparkline">${data.map(v=>`<span class="sparkline-bar" data-csp-style="${CSP.style(`height:${Math.round(v/mx*100)}%;background:${color}`)}"></span>`).join('')}</span>`;
}

// ══════════════════════════════════════════════════════════════
// APP NAVIGATION
// ══════════════════════════════════════════════════════════════
function startDemo(){
  document.getElementById('splash').classList.add('hidden');
  setTimeout(()=>{
    document.getElementById('app').style.display='block';
    renderDash();
  },500);
}

let currentTab='dash';
let chartInstances={};

function showTab(tab){
  currentTab=tab;
  document.querySelectorAll('.nav-tab').forEach(t=>t.classList.remove('active'));
  document.getElementById('tab-'+tab).classList.add('active');
  const fns={dash:renderDash,customers:renderCustomers,analytics:renderAnalytics,
    invoices:renderInvoices,products:renderProducts,followups:renderFollowups};
  Object.values(chartInstances).forEach(c=>{ try{c.destroy()}catch(e){} });
  chartInstances={};
  (fns[tab]||renderDash)();
}

// ══════════════════════════════════════════════════════════════
// DASHBOARD
// ══════════════════════════════════════════════════════════════
function renderDash(){
  const finals=D.invoices.filter(i=>i.type==='final');
  const totalRev=finals.reduce((s,i)=>s+i.final,0);
  const totalCust=D.customers.length;
  const openFup=D.followups.filter(f=>f.status==='open').length;
  const vipCount=D.customers.filter(c=>c.status==='vip').length;
  const monthlyRev={};
  finals.forEach(i=>{ monthlyRev[i.month]=(monthlyRev[i.month]||0)+i.final; });
  const months=['1403/01','1403/02','1403/03','1403/04','1403/05','1403/06'];
  const monthNames=['فروردین','اردیبهشت','خرداد','تیر','مرداد','شهریور'];
  const revValues=months.map(m=>monthlyRev[m]||0);
  const statusCount={};
  D.customers.forEach(c=>{ statusCount[c.status]=(statusCount[c.status]||0)+1; });
  const catRev={};
  finals.forEach(i=>{ catRev[i.category]=(catRev[i.category]||0)+i.final; });
  const topCats=Object.entries(catRev).sort((a,b)=>b[1]-a[1]).slice(0,6);

  // Recent invoices for activity feed
  const recent=D.invoices.slice(-6).reverse();

  document.getElementById('appBody').innerHTML=`
    <div class="kpi-row">
      <div class="kpi"><div class="kpi-icon" data-csp-style="${CSP.style(`background:#f0fdf4`)}">💰</div>
        <div><div class="kpi-v">${fmt(totalRev)} ت</div><div class="kpi-l">درآمد کل</div>
          <div class="kpi-chg up">↑ ۱۸٪ نسبت به دوره قبل</div></div></div>
      <div class="kpi"><div class="kpi-icon" data-csp-style="${CSP.style(`background:#f5f3ff`)}">👥</div>
        <div><div class="kpi-v">${fmt(totalCust)}</div><div class="kpi-l">مشتری فعال</div>
          <div class="kpi-chg up">↑ ${vipCount} مشتری VIP</div></div></div>
      <div class="kpi"><div class="kpi-icon" data-csp-style="${CSP.style(`background:#dbeafe`)}">📄</div>
        <div><div class="kpi-v">${fmt(finals.length)}</div><div class="kpi-l">فاکتور رسمی</div>
          <div class="kpi-chg up">↑ ۲۳٪ رشد ماهانه</div></div></div>
      <div class="kpi"><div class="kpi-icon" data-csp-style="${CSP.style(`background:#fef9c3`)}">📌</div>
        <div><div class="kpi-v">${fmt(openFup)}</div><div class="kpi-l">پیگیری باز</div>
          <div class="kpi-chg dn">${D.followups.filter(f=>f.priority==='high'&&f.status==='open').length} فوری</div></div></div>
      <div class="kpi"><div class="kpi-icon" data-csp-style="${CSP.style(`background:#fee2e2`)}">⚠️</div>
        <div><div class="kpi-v">${fmt(D.products.filter(p=>p.stock<10).length)}</div><div class="kpi-l">موجودی کم</div>
          <div class="kpi-chg dn">نیاز به سفارش مجدد</div></div></div>
    </div>
    <div class="charts-row">
      <div class="chart-card">
        <div class="chart-title"><span class="dot" data-csp-style="${CSP.style(`background:#7c3aed`)}"></span>درآمد ماهانه (ریال)</div>
        <canvas id="cRevenue" height="200"></canvas>
      </div>
      <div class="chart-card">
        <div class="chart-title"><span class="dot" data-csp-style="${CSP.style(`background:#16a34a`)}"></span>وضعیت مشتریان</div>
        <canvas id="cStatus" height="200"></canvas>
      </div>
      <div class="chart-card">
        <div class="chart-title"><span class="dot" data-csp-style="${CSP.style(`background:#d97706`)}"></span>فروش بر اساس دسته</div>
        <canvas id="cCat" height="200"></canvas>
      </div>
    </div>
    <div data-csp-style="${CSP.style(`display:grid;grid-template-columns:1fr 1fr;gap:16px`)}">
      <div class="tbl-wrap">
        <div class="tbl-head"><h3>📋 آخرین تراکنش‌ها</h3></div>
        <table class="data-tbl">
          <thead><tr><th>شماره</th><th>مشتری</th><th>مبلغ</th><th>وضعیت</th></tr></thead>
          <tbody>${recent.map(i=>`<tr>
            <td><span class="tag">${i.num}</span></td>
            <td>${esc(i.cust)}</td>
            <td class="mono">${fmt(i.final)}</td>
            <td><span class="badge ${i.type}">${i.type==='final'?'رسمی':'پیش'}</span></td>
          </tr>`).join('')}</tbody>
        </table>
      </div>
      <div class="tbl-wrap">
        <div class="tbl-head"><h3>🔥 مشتریان برتر</h3></div>
        <table class="data-tbl">
          <thead><tr><th>مشتری</th><th>شهر</th><th>فروش</th><th>رتبه</th></tr></thead>
          <tbody>${getTopCustomers().map((c,i)=>`<tr>
            <td><strong>${esc(c.biz)}</strong></td>
            <td><span class="city-tag">${esc(c.city)}</span></td>
            <td class="mono">${fmt(c.total)}</td>
            <td>${['🥇','🥈','🥉','4️⃣','5️⃣'][i]||''}</td>
          </tr>`).join('')}</tbody>
        </table>
      </div>
    </div>`;

  requestAnimationFrame(()=>{
    const fmtM = v => (v/1000000).toFixed(1)+'M';
    chartInstances.rev=new Chart(document.getElementById('cRevenue'),{
      type:'bar',
      data:{labels:monthNames,datasets:[{
        label:'درآمد (ریال)',data:revValues,
        backgroundColor:'rgba(124,58,237,.75)',borderRadius:8,
        borderSkipped:false
      },{
        label:'میانگین',data:Array(6).fill(revValues.reduce((a,b)=>a+b,0)/6),
        type:'line',borderColor:'#f97316',borderWidth:2,pointRadius:0,tension:.4,fill:false
      }]},
      options:{responsive:true,plugins:{legend:{display:false}},scales:{y:{ticks:{callback:fmtM}}}}
    });
    chartInstances.status=new Chart(document.getElementById('cStatus'),{
      type:'doughnut',
      data:{labels:['VIP','فعال','پیگیری','خاموش','جدید'],
        datasets:[{data:[statusCount.vip||0,statusCount.active||0,statusCount.followup||0,statusCount.silent||0,statusCount.new||0],
        backgroundColor:['#854d0e','#15803d','#1d4ed8','#6b7280','#9d174d'],borderWidth:2,borderColor:'#fff'}]},
      options:{responsive:true,plugins:{legend:{position:'bottom',labels:{font:{size:11}}}}}
    });
    chartInstances.cat=new Chart(document.getElementById('cCat'),{
      type:'bar',
      data:{labels:topCats.map(([k])=>k),datasets:[{data:topCats.map(([,v])=>v),
        backgroundColor:['#7c3aed','#a855f7','#c084fc','#ddd6fe','#ede9fe','#f5f3ff'],borderRadius:6}]},
      options:{indexAxis:'y',responsive:true,plugins:{legend:{display:false}},
        scales:{x:{ticks:{callback:fmtM}}}}
    });
  });
}

function getTopCustomers(){
  const totals={};
  D.invoices.filter(i=>i.type==='final').forEach(i=>{ totals[i.custId]=(totals[i.custId]||0)+i.final; });
  return D.customers.map(c=>({...c,total:totals[c.id]||0})).sort((a,b)=>b.total-a.total).slice(0,5);
}

// ══════════════════════════════════════════════════════════════
// CUSTOMERS
// ══════════════════════════════════════════════════════════════
let custFilter='all', custSearch='';

function renderCustomers(){
  document.getElementById('appBody').innerHTML=`
    <div class="section-head"><h2>👥 مشتریان</h2>
      <div class="sh-sub">مدیریت مشتریان عمده</div></div>
    <div data-csp-style="${CSP.style(`display:flex;gap:10px;margin-bottom:16px;flex-wrap:wrap;align-items:center`)}">
      <input class="search-box" placeholder="🔍 جستجو نام فروشگاه یا مالک..." id="custSrch"
        data-csp-input="${CSP.bind('input',function(event){custSearch=this.value;renderCustTable()})}" value="${esc(custSearch)}">
      <div class="filters-row" data-csp-style="${CSP.style(`margin:0`)}">
        ${['all','vip','active','followup','silent'].map(s=>`
          <button class="filter-btn ${custFilter===s?'active':''}" data-csp-click="${CSP.bind('click',function(event){custFilter=`${String((s) ?? '')}`;renderCustomers()})}">
            ${s==='all'?'همه':statusLabel[s]}
          </button>`).join('')}
      </div>
    </div>
    <div class="tbl-wrap"><table class="data-tbl" id="custTbl">
      <thead><tr>
        <th>#</th><th>نام فروشگاه</th><th>مالک</th><th>شهر</th><th>نوع</th>
        <th>وضعیت</th><th>فروش کل</th><th>موجودی حساب</th><th>اکانت‌منیجر</th>
      </tr></thead>
      <tbody id="custBody"></tbody>
    </table></div>
    <div id="custKanban" data-csp-style="${CSP.style(`margin-top:24px`)}">
      <div class="section-head" data-csp-style="${CSP.style(`margin-top:4px`)}"><h2>📋 کانبان مشتریان</h2></div>
    </div>`;
  renderCustTable();
  renderCustKanban();
}

function renderCustTable(){
  const q=custSearch.toLowerCase();
  const totals={};
  D.invoices.filter(i=>i.type==='final').forEach(i=>{ totals[i.custId]=(totals[i.custId]||0)+i.final; });
  const filtered=D.customers.filter(c=>{
    if(custFilter!=='all'&&c.status!==custFilter)return false;
    if(q&&!c.biz.toLowerCase().includes(q)&&!c.owner.toLowerCase().includes(q))return false;
    return true;
  });
  const monthRev=cid=>{
    const months=['1403/04','1403/05','1403/06'];
    return months.map(m=>D.invoices.filter(i=>i.custId===cid&&i.type==='final'&&i.month===m).reduce((s,i)=>s+i.final,0));
  };
  document.getElementById('custBody').innerHTML=filtered.map(c=>`<tr>
    <td>${c.id}</td>
    <td><strong>${esc(c.biz)}</strong></td>
    <td>${esc(c.owner)}</td>
    <td><span class="city-tag">${esc(c.city)}</span></td>
    <td><span class="tag">${esc(c.type)}</span></td>
    <td><span class="badge ${statusClass[c.status]}">${statusLabel[c.status]}</span></td>
    <td class="mono">${fmt(totals[c.id]||0)}</td>
    <td class="mono" data-csp-style="${CSP.style(`color:${c.balance<0?'#dc2626':c.balance>0?'#16a34a':'#6b7280'}`)}">${c.balance!==0?(c.balance<0?'-':'+')+'':' '}${fmt(Math.abs(c.balance))}</td>
    <td>${esc(c.user)} ${sparkline(monthRev(c.id))}</td>
  </tr>`).join('')||`<tr><td colspan="9" data-csp-style="${CSP.style(`text-align:center;color:#9ca3af;padding:32px`)}">موردی یافت نشد</td></tr>`;
}

function renderCustKanban(){
  const cols=['vip','active','followup','silent'];
  const colCfg={
    vip:{label:'VIP 👑',bg:'#fef9c3',txt:'#854d0e'},
    active:{label:'فعال ✅',bg:'#dcfce7',txt:'#14532d'},
    followup:{label:'پیگیری 🔔',bg:'#dbeafe',txt:'#1e40af'},
    silent:{label:'خاموش 😶',bg:'#f3f4f6',txt:'#374151'},
  };
  document.getElementById('custKanban').innerHTML+=`<div class="kanban">${
    cols.map(s=>{
      const cards=D.customers.filter(c=>c.status===s);
      return `<div class="kanban-col">
        <div class="kanban-col-head" data-csp-style="${CSP.style(`background:${colCfg[s].bg};color:${colCfg[s].txt}`)}">
          ${colCfg[s].label}<span class="kcol-badge">${cards.length}</span></div>
        <div class="kanban-cards">
          ${cards.map(c=>`<div class="kanban-card" data-csp-click="${CSP.bind('click',function(event){showCustDetail((c.id))})}">
            <div class="kc-name">${esc(c.biz)}</div>
            <div class="kc-owner">👤 ${esc(c.owner)}</div>
            <div class="kc-meta">
              <span class="kc-tag" data-csp-style="${CSP.style(`background:#f5f3ff;color:#7c3aed`)}">${esc(c.city)}</span>
              <span class="kc-tag" data-csp-style="${CSP.style(`background:#f9fafb;color:#374151`)}">${esc(c.type)}</span>
            </div>
          </div>`).join('')}
        </div>
      </div>`;
    }).join('')
  }</div>`;
}

function showCustDetail(id){
  const c=D.customers.find(x=>x.id===id);
  if(!c)return;
  const invs=D.invoices.filter(i=>i.custId===id);
  const fups=D.followups.filter(f=>f.custId===id);
  const total=invs.filter(i=>i.type==='final').reduce((s,i)=>s+i.final,0);
  document.getElementById('drillTitle').textContent=c.biz;
  document.getElementById('drillContent').innerHTML=`
    <div data-csp-style="${CSP.style(`display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px`)}">
      <div><div class="kpi-l">مالک</div><strong>${esc(c.owner)}</strong></div>
      <div><div class="kpi-l">موبایل</div><strong>${esc(c.phone)}</strong></div>
      <div><div class="kpi-l">شهر</div><span class="city-tag">${esc(c.city)}</span></div>
      <div><div class="kpi-l">وضعیت</div><span class="badge ${statusClass[c.status]}">${statusLabel[c.status]}</span></div>
      <div><div class="kpi-l">فروش کل</div><strong data-csp-style="${CSP.style(`color:#16a34a`)}">${fmt(total)} ت</strong></div>
      <div><div class="kpi-l">موجودی حساب</div><strong data-csp-style="${CSP.style(`color:${c.balance<0?'#dc2626':'#16a34a'}`)}">${fmt(c.balance)} ت</strong></div>
    </div>
    <h4 data-csp-style="${CSP.style(`margin-bottom:8px`)}">آخرین فاکتورها (${invs.length})</h4>
    <table class="data-tbl" data-csp-style="${CSP.style(`margin-bottom:16px`)}">
      <thead><tr><th>شماره</th><th>تاریخ</th><th>محصول</th><th>مبلغ</th><th>نوع</th></tr></thead>
      <tbody>${invs.slice(-5).reverse().map(i=>`<tr>
        <td><span class="tag">${i.num}</span></td><td>${i.date}</td>
        <td>${esc(i.product)}</td><td class="mono">${fmt(i.final)}</td>
        <td><span class="badge ${i.type}">${i.type==='final'?'رسمی':'پیش'}</span></td>
      </tr>`).join('')}</tbody>
    </table>
    <h4 data-csp-style="${CSP.style(`margin-bottom:8px`)}">پیگیری‌ها (${fups.length})</h4>
    ${fups.map(f=>`<div data-csp-style="${CSP.style(`padding:8px;background:#f9fafb;border-radius:8px;margin-bottom:6px;font-size:13px`)}">
      <span class="badge ${priClass[f.priority]}">${priLabel[f.priority]}</span>
      <strong data-csp-style="${CSP.style(`margin-right:8px`)}">${esc(f.subject)}</strong>
      <span data-csp-style="${CSP.style(`color:var(--muted)`)}">${f.date}</span>
    </div>`).join('')||`<div data-csp-style="${CSP.style(`color:var(--muted);font-size:13px`)}">پیگیری‌ای ثبت نشده</div>`}`;
  document.getElementById('drillOverlay').style.display='flex';
}
function closeDrill(){ document.getElementById('drillOverlay').style.display='none'; }

// ══════════════════════════════════════════════════════════════
// ════════════ ADVANCED ANALYTICS — PIVOT TABLE ═══════════════
// ══════════════════════════════════════════════════════════════
const PIVOT_FIELDS=[
  {id:'cust',label:'مشتری',type:'dim'},
  {id:'city',label:'شهر',type:'dim'},
  {id:'category',label:'دسته‌بندی',type:'dim'},
  {id:'product',label:'محصول',type:'dim'},
  {id:'month',label:'ماه',type:'dim'},
  {id:'salesperson',label:'فروشنده',type:'dim'},
  {id:'type',label:'نوع فاکتور',type:'dim'},
  {id:'final',label:'مبلغ (ت)',type:'msr'},
  {id:'qty',label:'تعداد',type:'msr'},
];
let pivotRows=['cust'];
let pivotCols=['month'];
let pivotVal='final';
let pivotAgg='sum';
let pivotHeatmap=true;
let pivotMode='table'; // table | chart
let pivotChart=null;

// Build a flat record for each invoice line
function getPivotData(){
  return D.invoices.map(i=>({
    cust:i.cust, city:i.city, category:i.category, product:i.product,
    month:i.month, salesperson:i.salesperson, type:i.type==='final'?'رسمی':'پیش‌فاکتور',
    final:i.final, qty:i.qty
  }));
}

const AGGS={
  sum:{label:'جمع',fn:arr=>arr.reduce((a,b)=>a+b,0)},
  count:{label:'تعداد',fn:arr=>arr.length},
  avg:{label:'میانگین',fn:arr=>Math.round(arr.reduce((a,b)=>a+b,0)/arr.length)},
  min:{label:'کمترین',fn:arr=>Math.min(...arr)},
  max:{label:'بیشترین',fn:arr=>Math.max(...arr)},
};

function computePivot(){
  const data=getPivotData();
  const agg=AGGS[pivotAgg]?.fn||AGGS.sum.fn;
  const getRowKey=d=>pivotRows.map(r=>d[r]||'').join('\n▸\n');
  const getColKey=d=>pivotCols.map(c=>d[c]||'').join('\n▸\n');
  const rowKeys=[...new Set(data.map(getRowKey))].sort();
  const colKeys=[...new Set(data.map(getColKey))].sort();
  const cells={};
  const rowBucket={};
  const colBucket={};
  const grandArr=[];
  for(const d of data){
    const rk=getRowKey(d);
    const ck=getColKey(d);
    const v=Number(d[pivotVal])||0;
    if(!cells[rk])cells[rk]={};
    if(!cells[rk][ck])cells[rk][ck]=[];
    cells[rk][ck].push(v);
    if(!rowBucket[rk])rowBucket[rk]=[];
    rowBucket[rk].push(v);
    if(!colBucket[ck])colBucket[ck]=[];
    colBucket[ck].push(v);
    grandArr.push(v);
  }
  const result={};
  for(const rk of rowKeys){
    result[rk]={};
    for(const ck of colKeys)result[rk][ck]=cells[rk]?.[ck]?.length?agg(cells[rk][ck]):null;
  }
  const rowTots=Object.fromEntries(Object.entries(rowBucket).map(([k,v])=>[k,agg(v)]));
  const colTots=Object.fromEntries(Object.entries(colBucket).map(([k,v])=>[k,agg(v)]));
  const grandTotal=grandArr.length?agg(grandArr):0;
  return{rowKeys,colKeys,result,rowTots,colTots,grandTotal,rawCells:cells};
}

function heatColor(v,min,max){
  if(!pivotHeatmap||v===null)return'';
  const ratio=max===min?0.5:(v-min)/(max-min);
  const r=Math.round(255-ratio*180);
  const g=Math.round(80+ratio*140);
  return `data-csp-style="${CSP.style(`background:rgba(${r},${g},80,0.18)`)}"`;
}

function renderAnalytics(){
  const dimFields=PIVOT_FIELDS.filter(f=>f.type==='dim');
  const msrFields=PIVOT_FIELDS.filter(f=>f.type==='msr');
  const availableFields=PIVOT_FIELDS.filter(f=>![...pivotRows,...pivotCols].includes(f.id));

  document.getElementById('appBody').innerHTML=`
    <div class="section-head">
      <h2>🧮 تحلیل پیشرفته — جدول محوری هوشمند</h2>
      <div class="sh-sub" data-csp-style="${CSP.style(`background:#fee2e2;color:#991b1b;padding:4px 12px;border-radius:20px;font-size:12px;font-weight:700`)}">
        ✨ ویژگی منحصربه‌فرد — قابلیت Drag & Drop کامل
      </div>
    </div>
    <div class="pivot-wrap">
      <div class="pivot-controls">
        <h3>⚙️ تنظیم جدول — فیلدها را بکشید و رها کنید</h3>
        <div class="pivot-builder">
          <div class="field-pool" id="availPool" data-csp-dragover="${CSP.bind('dragover',function(event){event.preventDefault()})}"
            data-csp-drop="${CSP.bind('drop',function(event){handleDrop(event,'avail')})}">
            <h4>📦 فیلدهای موجود</h4>
            <div id="availChips"></div>
          </div>
          <div data-csp-style="${CSP.style(`display:flex;flex-direction:column;gap:10px;flex:1`)}">
            <div class="drop-zone" data-csp-dragover="${CSP.bind('dragover',function(event){event.preventDefault();this.classList.add('dragover')})}"
              data-csp-dragleave="${CSP.bind('dragleave',function(event){this.classList.remove('dragover')})}" data-csp-drop="${CSP.bind('drop',function(event){handleDrop(event,'rows');this.classList.remove('dragover')})}">
              <h4>↕ ردیف‌ها</h4>
              <div class="dz-chips" id="rowChips"></div>
            </div>
            <div class="drop-zone" data-csp-dragover="${CSP.bind('dragover',function(event){event.preventDefault();this.classList.add('dragover')})}"
              data-csp-dragleave="${CSP.bind('dragleave',function(event){this.classList.remove('dragover')})}" data-csp-drop="${CSP.bind('drop',function(event){handleDrop(event,'cols');this.classList.remove('dragover')})}">
              <h4>↔ ستون‌ها</h4>
              <div class="dz-chips" id="colChips"></div>
            </div>
          </div>
          <div data-csp-style="${CSP.style(`display:flex;flex-direction:column;gap:10px`)}">
            <div class="field-pool" data-csp-style="${CSP.style(`min-width:180px`)}">
              <h4>📐 مقدار</h4>
              <select class="opt-select" data-csp-style="${CSP.style(`width:100%;margin-top:4px`)}" data-csp-change="${CSP.bind('change',function(event){pivotVal=this.value;refreshPivot()})}">
                ${msrFields.map(f=>`<option value="${f.id}" ${pivotVal===f.id?'selected':''}>${f.label}</option>`).join('')}
              </select>
              <h4 data-csp-style="${CSP.style(`margin-top:12px`)}">∑ تجمیع</h4>
              <select class="opt-select" data-csp-style="${CSP.style(`width:100%;margin-top:4px`)}" data-csp-change="${CSP.bind('change',function(event){pivotAgg=this.value;refreshPivot()})}">
                ${Object.entries(AGGS).map(([k,v])=>`<option value="${k}" ${pivotAgg===k?'selected':''}>${v.label}</option>`).join('')}
              </select>
            </div>
          </div>
        </div>
        <div class="pivot-options">
          <button class="toggle-btn ${pivotHeatmap?'active':''}" data-csp-click="${CSP.bind('click',function(event){pivotHeatmap=!pivotHeatmap;this.classList.toggle('active');refreshPivot()})}">🌡 نقشه حرارتی</button>
          <button class="toggle-btn ${pivotMode==='table'?'active':''}" data-csp-click="${CSP.bind('click',function(event){pivotMode='table';refreshPivot()})}">📊 جدول</button>
          <button class="toggle-btn ${pivotMode==='chart'?'active':''}" data-csp-click="${CSP.bind('click',function(event){pivotMode='chart';refreshPivot()})}">📈 نمودار</button>
          <button class="btn ghost sm" data-csp-click="${CSP.bind('click',function(event){exportPivotCSV()})}">💾 خروجی CSV</button>
          <button class="btn ghost sm" data-csp-click="${CSP.bind('click',function(event){resetPivot()})}">🔄 بازنشانی</button>
          <span data-csp-style="${CSP.style(`font-size:12px;color:var(--muted);margin-right:auto`)}">💡 فیلدها را بین بخش‌ها بکشید تا جدول تغییر کند</span>
        </div>
      </div>
      <div id="pivotTableArea" data-csp-style="${CSP.style(`padding:0 0 0 0`)}"></div>
    </div>`;
  refreshPivotChips();
  refreshPivot();
}

function refreshPivotChips(){
  const pool=document.getElementById('availPool');
  if(!pool)return;
  const usedFields=new Set([...pivotRows,...pivotCols]);
  const available=PIVOT_FIELDS.filter(f=>!usedFields.has(f.id)&&f.type==='dim');
  document.getElementById('availChips').innerHTML=available.map(f=>
    `<span class="field-chip" draggable="true"
      data-csp-dragstart="${CSP.bind('dragstart',function(event){dragField(event,`${String((f.id) ?? '')}`)})}">${f.label}</span>`
  ).join('');
  document.getElementById('rowChips').innerHTML=pivotRows.map(id=>{
    const f=PIVOT_FIELDS.find(x=>x.id===id);
    return`<span class="dz-chip" draggable="true" data-csp-dragstart="${CSP.bind('dragstart',function(event){dragField(event,`${String((id) ?? '')}`,'rows')})}">
      ${f?.label||id}<span class="rm" data-csp-click="${CSP.bind('click',function(event){removeFromZone(`${String((id) ?? '')}`,'rows')})}">×</span></span>`;
  }).join('');
  document.getElementById('colChips').innerHTML=pivotCols.map(id=>{
    const f=PIVOT_FIELDS.find(x=>x.id===id);
    return`<span class="dz-chip" draggable="true" data-csp-dragstart="${CSP.bind('dragstart',function(event){dragField(event,`${String((id) ?? '')}`,'cols')})}">
      ${f?.label||id}<span class="rm" data-csp-click="${CSP.bind('click',function(event){removeFromZone(`${String((id) ?? '')}`,'cols')})}">×</span></span>`;
  }).join('');
}

let _dragId=null,_dragFrom=null;
function dragField(e,id,from=null){ _dragId=id; _dragFrom=from; e.dataTransfer.effectAllowed='move'; }
function handleDrop(e,to){
  e.preventDefault();
  if(!_dragId)return;
  if(_dragFrom==='rows')pivotRows=pivotRows.filter(x=>x!==_dragId);
  if(_dragFrom==='cols')pivotCols=pivotCols.filter(x=>x!==_dragId);
  if(to==='rows'&&!pivotRows.includes(_dragId))pivotRows.push(_dragId);
  else if(to==='cols'&&!pivotCols.includes(_dragId))pivotCols.push(_dragId);
  _dragId=null;_dragFrom=null;
  refreshPivotChips();
  refreshPivot();
}
function removeFromZone(id,zone){
  if(zone==='rows')pivotRows=pivotRows.filter(x=>x!==id);
  if(zone==='cols')pivotCols=pivotCols.filter(x=>x!==id);
  refreshPivotChips();refreshPivot();
}
function resetPivot(){
  pivotRows=['cust'];pivotCols=['month'];pivotVal='final';pivotAgg='sum';
  pivotHeatmap=true;pivotMode='table';
  renderAnalytics();
}

function refreshPivot(){
  const area=document.getElementById('pivotTableArea');
  if(!area)return;
  if(!pivotRows.length||!pivotCols.length){
    area.innerHTML=`<div data-csp-style="${CSP.style(`padding:32px;text-align:center;color:var(--muted)`)}">حداقل یک فیلد در ردیف‌ها و ستون‌ها انتخاب کنید</div>`;
    return;
  }
  if(pivotMode==='chart'){renderPivotChart(area);return;}
  const{rowKeys,colKeys,result,rowTots,colTots,grandTotal,rawCells}=computePivot();
  const allVals=[];
  for(const rk of rowKeys)for(const ck of colKeys){const v=result[rk][ck];if(v!==null)allVals.push(v);}
  const minV=allVals.length?Math.min(...allVals):0;
  const maxV=allVals.length?Math.max(...allVals):1;

  // Split multi-level row/col keys
  const splitKey=k=>k.split('\n▸\n');

  // Build multi-level column headers
  let colHeader='';
  if(pivotCols.length>1){
    // Group by first-level
    const topVals=[...new Set(colKeys.map(k=>splitKey(k)[0]))].sort();
    const topSpans={};
    topVals.forEach(tv=>{ topSpans[tv]=colKeys.filter(k=>splitKey(k)[0]===tv).length; });
    colHeader+=`<tr><th class="ph-corner" rowspan="2">${pivotRows.map(r=>PIVOT_FIELDS.find(x=>x.id===r)?.label||r).join(' › ')}</th>`;
    topVals.forEach(tv=>{ colHeader+=`<th class="ph-col" colspan="${topSpans[tv]}">${esc(tv)}</th>`; });
    colHeader+=`<th class="ph-col" rowspan="2">جمع</th></tr>`;
    colHeader+=`<tr>`;
    colKeys.forEach(ck=>{ colHeader+=`<th class="ph-col-sub">${esc(splitKey(ck).slice(1).join(' › '))}</th>`; });
    colHeader+=`</tr>`;
  } else {
    const rLabel=pivotRows.map(r=>PIVOT_FIELDS.find(x=>x.id===r)?.label||r).join(' › ');
    colHeader=`<tr><th class="ph-corner">${esc(rLabel)} \\ ${PIVOT_FIELDS.find(x=>x.id===pivotCols[0])?.label||pivotCols[0]}</th>`;
    colKeys.forEach(ck=>{ colHeader+=`<th class="ph-col">${esc(ck)}</th>`; });
    colHeader+=`<th class="ph-col">جمع</th></tr>`;
  }

  // Build body with multi-level row grouping
  let tbody='';
  if(pivotRows.length>1){
    const topRowVals=[...new Set(rowKeys.map(k=>splitKey(k)[0]))].sort();
    topRowVals.forEach(topVal=>{
      const subKeys=rowKeys.filter(k=>splitKey(k)[0]===topVal);
      tbody+=`<tr><td class="ph-row" rowspan="${subKeys.length+1}">${esc(topVal)}</td>`;
      const subTotal=colKeys.reduce((acc,ck)=>{
        const vs=subKeys.flatMap(rk=>rawCells[rk]?.[ck]||[]);
        return vs.length?acc+(AGGS[pivotAgg]?.fn(vs)||0):acc;
      },0);
      tbody+=`</tr>`;
      subKeys.forEach(rk=>{
        tbody+=`<tr>`;
        const subLabel=splitKey(rk).slice(1).join(' › ');
        tbody+=`<td class="ph-row-sub">${esc(subLabel)}</td>`;
        colKeys.forEach(ck=>{
          const v=result[rk][ck];
          tbody+=`<td class="pv-cell" ${heatColor(v,minV,maxV)} data-csp-click="${CSP.bind('click',function(event){drillPivot((rk),(ck))})}">${v!==null?fmt(v):'—'}</td>`;
        });
        tbody+=`<td class="pv-tot">${fmt(rowTots[rk])}</td></tr>`;
      });
    });
  } else {
    rowKeys.forEach(rk=>{
      tbody+=`<tr><td class="ph-row">${esc(rk)}</td>`;
      colKeys.forEach(ck=>{
        const v=result[rk][ck];
        tbody+=`<td class="pv-cell" ${heatColor(v,minV,maxV)} data-csp-click="${CSP.bind('click',function(event){drillPivot((rk),(ck))})}">${v!==null?fmt(v):'—'}</td>`;
      });
      tbody+=`<td class="pv-tot">${fmt(rowTots[rk]||0)}</td></tr>`;
    });
  }

  const tfoot=`<tr>
    <th data-csp-style="${CSP.style(`background:#4c1d95;color:#fff;text-align:right`)}">جمع کل</th>
    ${colKeys.map(ck=>`<th class="pv-coltot">${fmt(colTots[ck]||0)}</th>`).join('')}
    <th class="pv-grand">${fmt(grandTotal)}</th>
  </tr>`;

  const valLabel=PIVOT_FIELDS.find(x=>x.id===pivotVal)?.label||pivotVal;
  const aggLabel=AGGS[pivotAgg]?.label||'جمع';
  area.innerHTML=`
    <div data-csp-style="${CSP.style(`padding:10px 16px;background:#f9fafb;border-bottom:1px solid var(--border);font-size:12px;color:var(--muted)`)}">
      <strong data-csp-style="${CSP.style(`color:#4c1d95`)}">نمایش: ${aggLabel} ${valLabel}</strong> |
      ردیف: ${pivotRows.map(r=>PIVOT_FIELDS.find(x=>x.id===r)?.label||r).join(', ')} |
      ستون: ${pivotCols.map(c=>PIVOT_FIELDS.find(x=>x.id===c)?.label||c).join(', ')} |
      تعداد ردیف: ${rowKeys.length} | تعداد ستون: ${colKeys.length} |
      روی هر سلول کلیک کنید برای مشاهده جزئیات
    </div>
    <div class="pivot-table-scroll">
      <table class="pivot-table">
        <thead>${colHeader}</thead>
        <tbody>${tbody}</tbody>
        <tfoot>${tfoot}</tfoot>
      </table>
    </div>`;
}

function renderPivotChart(area){
  const{rowKeys,colKeys,result}=computePivot();
  const colors=['#7c3aed','#a855f7','#3b82f6','#10b981','#f59e0b','#ef4444','#8b5cf6','#06b6d4'];
  if(pivotChart){try{pivotChart.destroy()}catch(e){}}
  area.innerHTML=`<div data-csp-style="${CSP.style(`padding:20px`)}"><canvas id="pivotChartCanvas" height="300"></canvas></div>`;
  const datasets=rowKeys.slice(0,8).map((rk,i)=>({
    label:rk.replace(/\n▸\n/g,' › '),
    data:colKeys.map(ck=>result[rk][ck]||0),
    backgroundColor:colors[i%colors.length]+'cc',
    borderColor:colors[i%colors.length],
    borderWidth:1,borderRadius:4
  }));
  pivotChart=new Chart(document.getElementById('pivotChartCanvas'),{
    type:'bar',
    data:{labels:colKeys.map(k=>k.replace(/\n▸\n/g,' › ')),datasets},
    options:{responsive:true,plugins:{legend:{position:'bottom'}},scales:{x:{stacked:true},y:{stacked:true}}}
  });
  chartInstances.pivotChart=pivotChart;
}

function drillPivot(rk,ck){
  const data=getPivotData();
  const rowDims=pivotRows.map(r=>({id:r,label:PIVOT_FIELDS.find(x=>x.id===r)?.label||r}));
  const colDims=pivotCols.map(c=>({id:c,label:PIVOT_FIELDS.find(x=>x.id===c)?.label||c}));
  const rkParts=rk.split('\n▸\n');
  const ckParts=ck.split('\n▸\n');
  const filtered=data.filter(d=>{
    for(let i=0;i<rowDims.length;i++) if(d[rowDims[i].id]!==rkParts[i])return false;
    for(let i=0;i<colDims.length;i++) if(d[colDims[i].id]!==ckParts[i])return false;
    return true;
  });
  document.getElementById('drillTitle').textContent=`جزئیات: ${rk.replace(/\n▸\n/g,' › ')} — ${ck.replace(/\n▸\n/g,' › ')}`;
  const invIds=filtered.map(f=>D.invoices.find(i=>i.cust===f.cust&&i.month===f.month&&i.product===f.product));
  document.getElementById('drillContent').innerHTML=`
    <div data-csp-style="${CSP.style(`margin-bottom:12px;font-size:13px;color:var(--muted)`)}">${filtered.length} رکورد | جمع: ${fmt(filtered.reduce((s,d)=>s+(Number(d[pivotVal])||0),0))} ت</div>
    <table class="data-tbl">
      <thead><tr><th>شماره</th><th>مشتری</th><th>محصول</th><th>تعداد</th><th>مبلغ</th><th>ماه</th></tr></thead>
      <tbody>${filtered.map(d=>{
        const inv=D.invoices.find(i=>i.cust===d.cust&&i.month===d.month&&i.product===d.product);
        return`<tr>
          <td><span class="tag">${inv?.num||'—'}</span></td>
          <td>${esc(d.cust)}</td><td>${esc(d.product)}</td>
          <td>${fmt(d.qty)}</td><td class="mono">${fmt(d.final)}</td>
          <td>${esc(d.month)}</td></tr>`;
      }).join('')}</tbody>
    </table>`;
  document.getElementById('drillOverlay').style.display='flex';
}

function exportPivotCSV(){
  const{rowKeys,colKeys,result,rowTots,colTots,grandTotal}=computePivot();
  const rLabel=pivotRows.map(r=>PIVOT_FIELDS.find(x=>x.id===r)?.label||r).join('-');
  let csv=`${rLabel},${colKeys.join(',')},جمع\n`;
  rowKeys.forEach(rk=>{
    csv+=`"${rk}",${colKeys.map(ck=>result[rk][ck]!==null?result[rk][ck]:'').join(',')},${rowTots[rk]||0}\n`;
  });
  csv+=`جمع کل,${colKeys.map(ck=>colTots[ck]||0).join(',')},${grandTotal}\n`;
  const a=document.createElement('a');
  a.href='data:text/csv;charset=utf-8,﻿'+encodeURIComponent(csv);
  a.download='pivot-export.csv'; a.click();
}

// ══════════════════════════════════════════════════════════════
// INVOICES
// ══════════════════════════════════════════════════════════════
let selInv=null, invFilter='all';

function renderInvoices(){
  document.getElementById('appBody').innerHTML=`
    <div class="section-head"><h2>📄 فاکتورها</h2></div>
    <div class="filters-row">
      ${['all','final','proforma'].map(t=>`<button class="filter-btn ${invFilter===t?'active':''}"
        data-csp-click="${CSP.bind('click',function(event){invFilter=`${String((t) ?? '')}`;renderInvoices()})}">${t==='all'?'همه':t==='final'?'رسمی':'پیش‌فاکتور'}</button>`).join('')}
    </div>
    <div class="inv-layout">
      <div class="tbl-wrap">
        <div class="tbl-head"><h3>لیست فاکتورها</h3>
          <input class="search-box" id="invSrch" placeholder="🔍 جستجو..." data-csp-input="${CSP.bind('input',function(event){renderInvList()})}"></div>
        <table class="data-tbl"><thead><tr>
          <th>شماره</th><th>تاریخ</th><th>مشتری</th><th>محصول</th><th>تعداد</th><th>مبلغ نهایی</th><th>نوع</th>
        </tr></thead><tbody id="invBody"></tbody></table>
      </div>
      <div id="invPrev"><div class="inv-preview" data-csp-style="${CSP.style(`text-align:center;color:var(--muted);padding:48px`)}">
        <div data-csp-style="${CSP.style(`font-size:36px`)}">📄</div>
        <div data-csp-style="${CSP.style(`margin-top:12px`)}">روی یک فاکتور کلیک کنید تا پیش‌نمایش آن را ببینید</div>
      </div></div>
    </div>`;
  renderInvList();
}

function renderInvList(){
  const q=(document.getElementById('invSrch')?.value||'').toLowerCase();
  const filtered=D.invoices.filter(i=>{
    if(invFilter!=='all'&&i.type!==invFilter)return false;
    if(q&&!i.cust.toLowerCase().includes(q)&&!i.num.toLowerCase().includes(q))return false;
    return true;
  });
  document.getElementById('invBody').innerHTML=filtered.map(i=>`<tr data-csp-style="${CSP.style(`cursor:pointer`)}" data-csp-click="${CSP.bind('click',function(event){showInvPreview((i.id))})}">
    <td><span class="tag">${i.num}</span></td>
    <td>${i.date}</td>
    <td>${esc(i.cust)}</td>
    <td data-csp-style="${CSP.style(`max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap`)}">${esc(i.product)}</td>
    <td>${fmt(i.qty)}</td>
    <td class="mono" data-csp-style="${CSP.style(`font-weight:700`)}">${fmt(i.final)}</td>
    <td><span class="badge ${i.type}">${i.type==='final'?'رسمی':'پیش'}</span></td>
  </tr>`).join('');
}

function showInvPreview(id){
  const i=D.invoices.find(x=>x.id===id); if(!i)return;
  document.getElementById('invPrev').innerHTML=`
    <div class="inv-preview">
      <div class="inv-prev-header">
        <div data-csp-style="${CSP.style(`font-size:22px;margin-bottom:6px`)}">🧾</div>
        <div class="inv-prev-num">${i.num}</div>
        <div data-csp-style="${CSP.style(`font-size:13px;color:var(--muted);margin-top:4px`)}">پوشاک ترنم — مشهد</div>
      </div>
      <div data-csp-style="${CSP.style(`display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:12px;margin-bottom:12px`)}">
        <div><div data-csp-style="${CSP.style(`color:var(--muted)`)}">مشتری</div><strong>${esc(i.cust)}</strong></div>
        <div><div data-csp-style="${CSP.style(`color:var(--muted)`)}">تاریخ</div><strong>${i.date}</strong></div>
        <div><div data-csp-style="${CSP.style(`color:var(--muted)`)}">شهر</div><span class="city-tag">${esc(i.city)}</span></div>
        <div><div data-csp-style="${CSP.style(`color:var(--muted)`)}">نوع</div><span class="badge ${i.type}">${i.type==='final'?'رسمی':'پیش'}</span></div>
      </div>
      <table class="inv-prev-rows">
        <thead><tr><th>محصول</th><th>تعداد</th><th>قیمت</th><th>جمع</th></tr></thead>
        <tbody><tr>
          <td>${esc(i.product)}</td>
          <td>${fmt(i.qty)}</td>
          <td class="mono">${fmt(i.price)}</td>
          <td class="mono">${fmt(i.subtotal)}</td>
        </tr></tbody>
      </table>
      <div class="inv-total-row"><span>جمع کل</span><span class="mono">${fmt(i.subtotal)} ت</span></div>
      ${i.disc?`<div class="inv-total-row"><span>تخفیف (${i.disc}٪)</span><span class="mono" data-csp-style="${CSP.style(`color:var(--red)`)}">- ${fmt(i.discAmt)} ت</span></div>`:''}
      <div class="inv-total-row final"><span>مبلغ نهایی</span><span class="mono">${fmt(i.final)} ت</span></div>
      <div data-csp-style="${CSP.style(`margin-top:16px;text-align:center`)}">
        <button class="btn primary sm" data-csp-click="${CSP.bind('click',function(event){window.print()})}">🖨️ چاپ</button>
      </div>
    </div>`;
}

// ══════════════════════════════════════════════════════════════
// PRODUCTS
// ══════════════════════════════════════════════════════════════
let prodCatFilter='all';

function renderProducts(){
  const cats=['all',...new Set(D.products.map(p=>p.cat))];
  document.getElementById('appBody').innerHTML=`
    <div class="section-head"><h2>📦 محصولات</h2>
      <div class="sh-sub">${D.products.length} محصول — ${D.products.filter(p=>p.stock<15).length} با موجودی کم</div></div>
    <div class="filters-row">
      <input class="search-box" id="prodSrch" placeholder="🔍 جستجو..." data-csp-input="${CSP.bind('input',function(event){renderProdGrid()})}">
      ${cats.map(c=>`<button class="filter-btn ${prodCatFilter===c?'active':''}"
        data-csp-click="${CSP.bind('click',function(event){prodCatFilter=`${String((c) ?? '')}`;renderProducts()})}">${c==='all'?'همه':c}</button>`).join('')}
    </div>
    <div id="prodGridDiv"></div>`;
  renderProdGrid();
}

function renderProdGrid(){
  const q=(document.getElementById('prodSrch')?.value||'').toLowerCase();
  const icons={مانتو:'🧥',شومیز:'👚',دامن:'👗',بلوز:'👕',پالتو:'🧣',تونیک:'👘',شلوار:'👖',کاپشن:'🥻'};
  const filtered=D.products.filter(p=>{
    if(prodCatFilter!=='all'&&p.cat!==prodCatFilter)return false;
    if(q&&!p.name.toLowerCase().includes(q)&&!p.code.toLowerCase().includes(q))return false;
    return true;
  });
  const soldMap={};
  D.invoices.filter(i=>i.type==='final').forEach(i=>{ soldMap[i.product]=(soldMap[i.product]||0)+i.qty; });
  document.getElementById('prodGridDiv').innerHTML=`<div class="prod-grid">${filtered.map(p=>{
    const icon=icons[p.cat]||'📦';
    const sold=soldMap[p.name]||0;
    const low=p.stock<15;
    return `<div class="prod-card" data-csp-click="${CSP.bind('click',function(event){showProdDetail((p.id))})}">
      <div class="prod-img">${icon}</div>
      <div class="prod-body">
        <div class="prod-name">${esc(p.name)}</div>
        <div class="prod-code">${esc(p.code)} · ${esc(p.cat)}</div>
        <div class="prod-price">${fmt(p.price)} ت</div>
        <div class="prod-stock ${low?'low':''}">موجودی: ${fmt(p.stock)} عدد ${low?'⚠️':''}</div>
        <div data-csp-style="${CSP.style(`margin-top:6px;font-size:11px;color:var(--muted)`)}">فروخته شده: ${fmt(sold)} عدد</div>
      </div>
    </div>`;
  }).join('')||'<div class="empty-state"><div class="ei">📦</div>موردی یافت نشد</div>'}</div>`;
}

function showProdDetail(id){
  const p=D.products.find(x=>x.id===id); if(!p)return;
  const invs=D.invoices.filter(i=>i.product===p.name&&i.type==='final');
  const totalSold=invs.reduce((s,i)=>s+i.qty,0);
  const totalRev=invs.reduce((s,i)=>s+i.final,0);
  const icons={مانتو:'🧥',شومیز:'👚',دامن:'👗',بلوز:'👕',پالتو:'🧣',تونیک:'👘',شلوار:'👖',کاپشن:'🥻'};
  document.getElementById('drillTitle').textContent=p.name;
  document.getElementById('drillContent').innerHTML=`
    <div data-csp-style="${CSP.style(`text-align:center;font-size:64px;margin-bottom:16px`)}">${icons[p.cat]||'📦'}</div>
    <div data-csp-style="${CSP.style(`display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px;font-size:13px`)}">
      <div><div data-csp-style="${CSP.style(`color:var(--muted)`)}">کد محصول</div><strong>${esc(p.code)}</strong></div>
      <div><div data-csp-style="${CSP.style(`color:var(--muted)`)}">دسته‌بندی</div><strong>${esc(p.cat)}</strong></div>
      <div><div data-csp-style="${CSP.style(`color:var(--muted)`)}">قیمت فروش</div><strong data-csp-style="${CSP.style(`color:var(--green)`)}">${fmt(p.price)} ت</strong></div>
      <div><div data-csp-style="${CSP.style(`color:var(--muted)`)}">موجودی</div><strong data-csp-style="${CSP.style(`color:${p.stock<15?'var(--red)':'var(--green)'}`)}">${fmt(p.stock)} عدد</strong></div>
      <div><div data-csp-style="${CSP.style(`color:var(--muted)`)}">فروخته شده</div><strong>${fmt(totalSold)} عدد</strong></div>
      <div><div data-csp-style="${CSP.style(`color:var(--muted)`)}">درآمد حاصله</div><strong data-csp-style="${CSP.style(`color:var(--purple)`)}">${fmt(totalRev)} ت</strong></div>
    </div>
    <h4 data-csp-style="${CSP.style(`margin-bottom:8px`)}">مشتریانی که خریداری کردند</h4>
    ${[...new Set(invs.map(i=>i.cust))].slice(0,6).map(cust=>`
      <div data-csp-style="${CSP.style(`padding:6px 10px;background:#f9fafb;border-radius:6px;margin-bottom:4px;font-size:12px;display:flex;justify-content:space-between`)}">
        <span>${esc(cust)}</span>
        <span class="mono">${fmt(invs.filter(i=>i.cust===cust).reduce((s,i)=>s+i.qty,0))} عدد</span>
      </div>`).join('')}`;
  document.getElementById('drillOverlay').style.display='flex';
}

// ══════════════════════════════════════════════════════════════
// FOLLOW-UPS (KANBAN)
// ══════════════════════════════════════════════════════════════
function renderFollowups(){
  const open=D.followups.filter(f=>f.status==='open');
  const done=D.followups.filter(f=>f.status==='done');
  const high=open.filter(f=>f.priority==='high');
  document.getElementById('appBody').innerHTML=`
    <div class="section-head">
      <h2>📌 پیگیری‌ها</h2>
      <div data-csp-style="${CSP.style(`display:flex;gap:10px`)}">
        <span data-csp-style="${CSP.style(`background:#fee2e2;color:#991b1b;padding:4px 12px;border-radius:20px;font-size:12px;font-weight:700`)}">${high.length} فوری</span>
        <span data-csp-style="${CSP.style(`background:#dcfce7;color:#14532d;padding:4px 12px;border-radius:20px;font-size:12px;font-weight:700`)}">${done.length} انجام شده</span>
      </div>
    </div>
    <div class="kanban">
      ${renderFupColumn('🔴 فوری','فوری','high',open.filter(f=>f.priority==='high'),'#fee2e2','#991b1b')}
      ${renderFupColumn('🟡 متوسط','متوسط','mid',open.filter(f=>f.priority==='mid'),'#fef9c3','#854d0e')}
      ${renderFupColumn('🟢 عادی','عادی','low',open.filter(f=>f.priority==='low'),'#dcfce7','#14532d')}
      ${renderFupColumn('✅ انجام شده','done','done',done,'#f3f4f6','#374151')}
    </div>
    <div data-csp-style="${CSP.style(`margin-top:24px`)}" class="tbl-wrap">
      <div class="tbl-head"><h3>📅 جدول زمانی پیگیری‌ها</h3></div>
      <table class="data-tbl"><thead><tr>
        <th>مشتری</th><th>شهر</th><th>تاریخ</th><th>نوع تماس</th><th>موضوع</th><th>اولویت</th><th>وضعیت</th>
      </tr></thead><tbody>${D.followups.sort((a,b)=>b.date.localeCompare(a.date)).map(f=>`<tr>
        <td><strong>${esc(f.cust)}</strong></td>
        <td><span class="city-tag">${esc(f.city)}</span></td>
        <td>${f.date}</td>
        <td><span class="tag">${esc(f.type)}</span></td>
        <td>${esc(f.subject)}</td>
        <td><span class="badge ${priClass[f.priority]}">${priLabel[f.priority]}</span></td>
        <td><span class="badge ${f.status==='open'?'active':'new'}">${f.status==='open'?'باز':'انجام شد'}</span></td>
      </tr>`).join('')}</tbody></table>
    </div>`;
}

function renderFupColumn(title,label,pri,items,bg,txt){
  return `<div class="kanban-col">
    <div class="kanban-col-head" data-csp-style="${CSP.style(`background:${bg};color:${txt}`)}">
      ${title} <span class="kcol-badge">${items.length}</span></div>
    <div class="kanban-cards">
      ${items.map(f=>`<div class="kanban-card">
        <div class="kc-name">${esc(f.cust)}</div>
        <div class="kc-owner" data-csp-style="${CSP.style(`font-size:12px;margin-bottom:6px`)}">📋 ${esc(f.subject)}</div>
        <div class="kc-meta">
          <span class="kc-tag" data-csp-style="${CSP.style(`background:#f5f3ff;color:#7c3aed`)}">${f.date}</span>
          <span class="kc-tag" data-csp-style="${CSP.style(`background:#f9fafb;color:#374151`)}">${esc(f.type)}</span>
        </div>
        ${f.note?`<div data-csp-style="${CSP.style(`margin-top:6px;font-size:11px;color:var(--muted);background:#fafafa;padding:4px 8px;border-radius:6px`)}">${esc(f.note)}</div>`:''}
      </div>`).join('')||`<div data-csp-style="${CSP.style(`text-align:center;color:var(--muted);font-size:12px;padding:16px`)}">موردی ندارد</div>`}
    </div>
  </div>`;
}

// ══════════════════════════════════════════════════════════════
// INIT
// ══════════════════════════════════════════════════════════════
// Auto-show app in demo mode (click splash to proceed normally)
window.onload=()=>{
  // Pre-warm: nothing needed
};

/* Static actions migrated from demo.html. */
CSP.register('s_da784bcbfc3f2826447c7a25','click',function(event){closeDrill()});
CSP.register('s_49b270bca13117f8006785a6','click',function(event){if(event.target===this)closeDrill()});
CSP.register('s_3497e0ac1290753f4254ec7f','click',function(event){showTab('followups')});
CSP.register('s_5fc61ee62261f75101997be3','click',function(event){showTab('products')});
CSP.register('s_3fa5c975d436eb1fca02c8ff','click',function(event){showTab('invoices')});
CSP.register('s_415d025ee5124fe26b5a5409','click',function(event){showTab('analytics')});
CSP.register('s_eb7f9da34f1f6980d3fe17dc','click',function(event){showTab('customers')});
CSP.register('s_bfedc9fbfcb4385a521e9144','click',function(event){showTab('dash')});
CSP.register('s_b942ab6cdfbd7df99193fadc','click',function(event){startDemo()});

/* Static styles migrated from demo.html. */
CSP.registerStyle('s_6bfe90c4d0e533daee331b3a',"display:none");
