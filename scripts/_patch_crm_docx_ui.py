# -*- coding: utf-8 -*-
"""One-shot UI patch for crm.docx accounting fixes."""
from pathlib import Path

p = Path(__file__).resolve().parents[1] / 'server' / 'public' / 'index.html'
t = p.read_text(encoding='utf-8')
orig = t
n = 0

def repl(old, new, label):
    global t, n
    if old not in t:
        raise SystemExit(f'MISSING: {label}')
    t = t.replace(old, new, 1)
    n += 1
    print('OK', label)

# 1) Datepicker years 1300..today
repl(
    "  const yearOpts = [];\n  for(let y=1380;y<=1425;y++) yearOpts.push(`<option value=\"${y}\" ${y===DP.y?'selected':''}>${toFa(y)}</option>`);",
    "  const yearOpts = [];\n  const _ty=+todayJalali().split('/')[0]||1425;\n  for(let y=1300;y<=_ty;y++) yearOpts.push(`<option value=\"${y}\" ${y===DP.y?'selected':''}>${toFa(y)}</option>`);",
    'datepicker years'
)

# 2) paymentOpChooser -> 4 options
old_chooser = '''function paymentOpChooser(){
  openModal(`
    <div class="modal-head"><h3>نوع پرداخت را انتخاب کنید</h3><button class="x" onclick="closeModal()">×</button></div>
    <div class="modal-body" style="display:flex;flex-direction:column;gap:10px">
      <button class="btn" onclick="closeModal();go('acc-suppliers')">🚚 پرداخت به تأمین‌کننده (از لیست تأمین‌کنندگان)</button>
      <button class="btn" onclick="closeModal();go('acc-commissions')">🎯 پرداخت انگیزه فروش (از لیست کارشناسان)</button>
      <button class="btn green" onclick="expensePaymentModal()">🧾 پرداخت هزینه عمومی</button>
    </div>
    <div class="modal-foot"><button class="btn ghost" onclick="closeModal()">انصراف</button></div>`);
}'''

new_chooser = r'''function paymentOpChooser(){
  openModal(`
    <div class="modal-head"><h3>نوع پرداخت را انتخاب کنید</h3><button class="x" onclick="closeModal()">×</button></div>
    <div class="modal-body" style="display:flex;flex-direction:column;gap:10px">
      <button class="btn" onclick="closeModal();setTimeout(personPaymentModal,50)">👤 پرداخت به شخص</button>
      <button class="btn" onclick="closeModal();setTimeout(()=>transferModal('bank'),50)">🏦 پرداخت به بانک</button>
      <button class="btn green" onclick="closeModal();setTimeout(expensePaymentModal,50)">🧾 پرداخت هزینه</button>
      <button class="btn" onclick="closeModal();setTimeout(()=>transferModal('cash'),50)">💰 پرداخت به صندوق</button>
    </div>
    <div class="modal-foot"><button class="btn ghost" onclick="closeModal()">انصراف</button></div>`);
}
async function personPaymentModal(){
  if(!CACHE.banks) CACHE.banks=await api('GET','/banks')||[];
  if(!CACHE.cashBoxes) CACHE.cashBoxes=await api('GET','/cash-boxes')||[];
  if(!CACHE.checkCategories) CACHE.checkCategories=await api('GET','/check-categories')||[];
  const [partiesResp, reps]=await Promise.all([
    api('GET','/parties?limit=200')||{},
    api('GET','/reps')||[]
  ]);
  const parties=(partiesResp.data||partiesResp||[]);
  const suppliers=parties.filter(p=>(p.party_roles||[]).includes('supplier')||p.party_type==='supplier'||p.party_type==='both');
  openModal(`
    <div class="modal-head"><h3>👤 پرداخت به شخص</h3><button class="x" onclick="closeModal()">×</button></div>
    <div class="modal-body"><div class="form-grid">
      <div class="fg full"><label>نوع طرف حساب</label><select id="pp-kind" onchange="ppKindChanged()">
        <option value="supplier">تأمین‌کننده</option>
        <option value="incentive">کارشناس / انگیزه فروش</option>
        <option value="party">سایر اشخاص</option>
      </select></div>
      <div class="fg full" id="pp-target-wrap"></div>
      <div class="fg"><label>مبلغ (تومان) *</label><input id="pp-amount" type="text" inputmode="numeric" class="money"></div>
      <div class="fg"><label>نوع پرداخت</label><select id="pp-paytype" onchange="toggleBankFields('pp')"><option value="cash">نقد</option><option value="cheque">چک</option><option value="bank">بانکی</option></select></div>
      <div class="fg"><label>پرداخت از بانک</label><select id="pp-bank" onchange="updateCheckCategoryOptions('pp')">
        <option value="">—</option>${(CACHE.banks||[]).filter(b=>b.active).map(b=>`<option value="${b.id}">${esc(b.name)}</option>`).join('')}
      </select></div>
      <div class="fg"><label>پرداخت از صندوق</label><select id="pp-cashbox">
        <option value="">—</option>${(CACHE.cashBoxes||[]).filter(b=>b.active).map(b=>`<option value="${b.id}">${esc(b.name)}</option>`).join('')}
      </select></div>
      <div class="fg" id="pp-cc-wrap" style="display:none"><label>دسته چک</label><select id="pp-checkcat"><option value="">—</option></select></div>
      <div class="fg"><label>تاریخ</label><input id="pp-date" data-jdate value="${todayJalali()}"></div>
      <div class="fg full"><label>یادداشت</label><textarea id="pp-note"></textarea></div>
    </div></div>
    <div class="modal-foot"><button class="btn green" onclick="savePersonPayment()">💾 ثبت پرداخت</button>
      <button class="btn ghost" onclick="closeModal()">انصراف</button></div>`);
  window._ppSuppliers=suppliers; window._ppParties=parties; window._ppReps=reps||[];
  attachDatepickers(el('modalRoot'));
  ppKindChanged();
  toggleBankFields('pp');
}
function ppKindChanged(){
  const kind=el('pp-kind')?.value||'supplier';
  const wrap=el('pp-target-wrap'); if(!wrap) return;
  if(kind==='supplier'){
    wrap.innerHTML=`<label>تأمین‌کننده *</label><select id="pp-target"><option value="">— انتخاب —</option>${(window._ppSuppliers||[]).map(s=>{
      const sid=s.legacy_table==='suppliers'?s.legacy_id:s.id;
      return `<option value="${s.legacy_table==='suppliers'&&s.legacy_id?s.legacy_id:''}" data-party="${s.id}">${esc(s.full_name||s.biz||'-')}</option>`;
    }).join('')}</select><div class="muted" style="font-size:11px;margin-top:4px">اگر در لیست نبود، از اطلاعات اشخاص تأمین‌کننده بسازید.</div>`;
    // Prefer supplier legacy ids via API list
    api('GET','/suppliers').then(list=>{
      const sel=el('pp-target'); if(!sel) return;
      sel.innerHTML='<option value="">— انتخاب —</option>'+(list||[]).map(s=>`<option value="${s.id}">${esc(s.name)}</option>`).join('');
    }).catch(()=>{});
  } else if(kind==='incentive'){
    wrap.innerHTML=`<label>کارشناس *</label><select id="pp-target"><option value="">— انتخاب —</option>${(window._ppReps||[]).map(r=>`<option value="${r.id}" data-payable="${Math.round(r.payable||0)}">${esc(r.name)} — مانده: ${fmt(Math.round(r.payable||0))}</option>`).join('')}</select>`;
    if(!(window._ppReps||[]).length){
      api('GET','/accounting/commissions').then(d=>{
        const rows=d?.reps||d||[];
        const sel=el('pp-target'); if(!sel) return;
        sel.innerHTML='<option value="">— انتخاب —</option>'+rows.map(r=>`<option value="${r.id}" data-payable="${Math.round(r.payable||0)}">${esc(r.name)} — ${fmt(Math.round(r.payable||0))}</option>`).join('');
      }).catch(()=>{});
    }
  } else {
    wrap.innerHTML=`<label>شخص *</label><select id="pp-target"><option value="">— انتخاب —</option>${(window._ppParties||[]).map(p=>`<option value="${p.id}">${esc(p.full_name||p.biz||'-')}</option>`).join('')}</select>
      <div class="muted" style="font-size:11px;margin-top:4px">پرداخت سایر اشخاص به‌صورت هزینه ثبت می‌شود.</div>`;
  }
}
async function savePersonPayment(){
  const kind=el('pp-kind').value;
  const target=+el('pp-target')?.value||0;
  const amount=moneyVal('pp-amount');
  if(!target){ showToast('طرف حساب را انتخاب کنید','error'); return; }
  if(!amount||amount<=0){ showToast('مبلغ معتبر وارد کنید','error'); return; }
  const payload={
    amount, pay_type:el('pp-paytype').value, date:el('pp-date').value, note:el('pp-note').value,
    bank_id:+el('pp-bank').value||null, cash_box_id:+el('pp-cashbox')?.value||null,
    check_category_id:+el('pp-checkcat')?.value||null
  };
  try{
    if(kind==='supplier'){
      await api('POST','/purchases/payments',{...payload, supplier_id:target});
    } else if(kind==='incentive'){
      await api('POST','/accounting/incentive-payments',{...payload, rep_id:target});
    } else {
      const name=(el('pp-target').selectedOptions[0]?.textContent||'شخص').trim();
      await api('POST','/expenses',{...payload, category:'admin', title:'پرداخت به شخص: '+name, account_code:null});
    }
    closeModal(); showToast('پرداخت ثبت شد'); loadAccTab('settlements');
  }catch(e){}
}'''
repl(old_chooser, new_chooser, 'paymentOpChooser')

# 3) transferModal accept preferred destination
repl(
    'function transferModal(){\n  openModal(`\n    <div class="modal-head"><h3>انتقال وجه جدید</h3><button class="x" onclick="closeModal()">×</button></div>',
    'function transferModal(preferTo){\n  openModal(`\n    <div class="modal-head"><h3>انتقال بین بانک و صندوق</h3><button class="x" onclick="closeModal()">×</button></div>',
    'transferModal title'
)
repl(
    "  el('tr-to-type').value='bank';\n}",
    "  el('tr-to-type').value=(preferTo==='cash'?'cash':'bank');\n  updateTransferSideOptions('to');\n}",
    'transferModal preferTo'
)

# 4) Fix exAcctShow / vcAcctShow pickers (JSON.stringify codes, wider filter)
repl(
    '''function exAcctShow(q){
  const drop=el('ex-acct-drop'), inp=el('ex-account-search'); if(!drop||!inp) return;
  const term=(q||'').trim().toLowerCase();
  let list=(CACHE.chartOfAccounts||[]).filter(a=>a.type==='expense'||a.type==='cogs');
  if(term){ const words=term.split(/\\s+/); list=list.filter(a=>{const hay=((a.code||'')+' '+(a.name||'')).toLowerCase(); return words.every(w=>hay.includes(w));}); }
  const rect=inp.getBoundingClientRect();
  drop.style.top=(rect.bottom+2)+'px'; drop.style.left=rect.left+'px'; drop.style.width=rect.width+'px'; drop.style.display='block';
  drop.innerHTML=list.slice(0,120).map(a=>`
    <div class="cust-si-item" onmousedown="exAcctPick('${esc(a.code)}')">
      <span>${esc(a.name)}</span><span class="cust-si-meta">${esc(a.code)}</span>
    </div>`).join('')||'<div class="cust-si-empty">حسابی یافت نشد</div>';
}''',
    '''function exAcctShow(q){
  const drop=el('ex-acct-drop'), inp=el('ex-account-search'); if(!drop||!inp) return;
  const term=(q||'').trim().toLowerCase();
  let list=(CACHE.chartOfAccounts||[]).filter(a=>{
    const t=(a.type||'').toLowerCase();
    const code=String(a.code||'');
    return t==='expense'||t==='cogs'||code.startsWith('6')||code.startsWith('5')||!t;
  });
  if(term){ const words=term.split(/\\s+/); list=list.filter(a=>{const hay=((a.code||'')+' '+(a.name||'')).toLowerCase(); return words.every(w=>hay.includes(w));}); }
  const rect=inp.getBoundingClientRect();
  drop.style.top=(rect.bottom+2)+'px'; drop.style.left=rect.left+'px'; drop.style.width=Math.max(rect.width,280)+'px'; drop.style.display='block'; drop.style.zIndex='9999';
  drop.innerHTML=list.slice(0,120).map(a=>`
    <div class="cust-si-item" onmousedown='exAcctPick(${JSON.stringify(a.code)})'>
      <span>${esc(a.name)}</span><span class="cust-si-meta">${esc(a.code)}</span>
    </div>`).join('')||'<div class="cust-si-empty">حسابی یافت نشد — کدینگ را در اطلاعات پایه بررسی کنید</div>';
}''',
    'exAcctShow'
)

repl(
    '''function vcAcctShow(i, q){
  const drop=el('vc-acctdrop-'+i), inp=el('vc-acct-'+i); if(!drop||!inp) return;
  const term=(q||'').trim().toLowerCase();
  let list=(CACHE.chartOfAccounts||[]);
  if(term){ const words=term.split(/\\s+/); list=list.filter(a=>{const hay=((a.code||'')+' '+(a.name||'')).toLowerCase(); return words.every(w=>hay.includes(w));}); }
  const rect=inp.getBoundingClientRect();
  drop.style.top=(rect.bottom+2)+'px'; drop.style.left=rect.left+'px'; drop.style.width=rect.width+'px'; drop.style.display='block';
  drop.innerHTML = list.slice(0,50).map(a=>`
    <div class="cust-si-item" onmousedown="vcAcctPick(${i},'${esc(a.code)}')">
      <span>${esc(a.name)}</span><span class="cust-si-meta">${esc(a.code)}${a.type?' · '+esc(ACC_TYPE_FA[a.type]||a.type):''}</span>
    </div>`).join('') || '<div class="cust-si-item muted">حسابی یافت نشد</div>';
}''',
    '''function vcAcctShow(i, q){
  const drop=el('vc-acctdrop-'+i), inp=el('vc-acct-'+i); if(!drop||!inp) return;
  const term=(q||'').trim().toLowerCase();
  let list=(CACHE.chartOfAccounts||[]);
  if(!list.length){ drop.style.display='block'; drop.innerHTML='<div class="cust-si-item muted">کدینگ بارگذاری نشده</div>'; return; }
  if(term){ const words=term.split(/\\s+/); list=list.filter(a=>{const hay=((a.code||'')+' '+(a.name||'')).toLowerCase(); return words.every(w=>hay.includes(w));}); }
  const rect=inp.getBoundingClientRect();
  drop.style.top=(rect.bottom+2)+'px'; drop.style.left=rect.left+'px'; drop.style.width=Math.max(rect.width,280)+'px'; drop.style.display='block'; drop.style.zIndex='9999';
  drop.innerHTML = list.slice(0,80).map(a=>`
    <div class="cust-si-item" onmousedown='vcAcctPick(${i},${JSON.stringify(a.code)})'>
      <span>${esc(a.name)}</span><span class="cust-si-meta">${esc(a.code)}${a.type?' · '+esc(ACC_TYPE_FA[a.type]||a.type):''}</span>
    </div>`).join('') || '<div class="cust-si-item muted">حسابی یافت نشد</div>';
}''',
    'vcAcctShow'
)

# 5) Voucher lines side labels
repl(
    '''function renderVoucherLines(){
  el('vcLines').innerHTML = voucherLines.map((l,i)=>`
    <div class="form-grid" style="margin-bottom:6px">
      <div class="fg"><label>نوع طرف حساب</label><select onchange="voucherLines[${i}].target_type=this.value;renderVoucherLines()">
        <option value="account" ${l.target_type!=='person'?'selected':''}>حساب (کدینگ)</option>
        <option value="person" ${l.target_type==='person'?'selected':''}>شخص</option>
      </select></div>
      <div class="fg">${l.target_type==='person'
        ?`<label>شخص</label><select onchange="voucherLines[${i}].person_id=+this.value">${personOptions(l.person_id)}</select>`
        :`<label>حساب</label>${acctSearchHtml(i,l.code)}`}</div>
      <div class="fg"><label>بدهکار</label><input type="text" inputmode="numeric" class="money" value="${moneyInit(l.debit)}" oninput="voucherLines[${i}].debit=(+this.value.replace(/[^\\d]/g,''))||0;voucherLines[${i}].credit=0;updateVoucherBalance()"></div>
      <div class="fg"><label>بستانکار</label><input type="text" inputmode="numeric" class="money" value="${moneyInit(l.credit)}" oninput="voucherLines[${i}].credit=(+this.value.replace(/[^\\d]/g,''))||0;voucherLines[${i}].debit=0;updateVoucherBalance()"></div>
      <div class="fg"><label>شرح ردیف</label><div style="display:flex;gap:6px">
        <input value="${esc(l.description||'')}" oninput="voucherLines[${i}].description=this.value" style="flex:1">
        ${voucherLines.length>2?`<button class="btn sm red icon" onclick="removeVoucherLine(${i})">🗑️</button>`:''}
      </div></div>
    </div>`).join('');
  updateVoucherBalance();
}''',
    '''function renderVoucherLines(){
  el('vcLines').innerHTML = voucherLines.map((l,i)=>{
    const sideLabel = i===0 ? '① طرف اول سند' : (i===1 ? '② طرف دوم سند' : `ردیف ${i+1}`);
    return `
    <div class="panel" style="margin-bottom:10px;border:1px solid var(--border);border-radius:10px;padding:10px">
      <div style="font-weight:700;font-size:13px;margin-bottom:8px;color:var(--purple)">${sideLabel}</div>
      <div class="form-grid">
      <div class="fg"><label>نوع طرف حساب</label><select onchange="voucherLines[${i}].target_type=this.value;renderVoucherLines()">
        <option value="account" ${l.target_type!=='person'?'selected':''}>حساب (کدینگ)</option>
        <option value="person" ${l.target_type==='person'?'selected':''}>شخص</option>
      </select></div>
      <div class="fg">${l.target_type==='person'
        ?`<label>شخص</label><select onchange="voucherLines[${i}].person_id=+this.value">${personOptions(l.person_id)}</select>`
        :`<label>حساب</label>${acctSearchHtml(i,l.code)}`}</div>
      <div class="fg"><label>بدهکار</label><input type="text" inputmode="numeric" class="money" value="${moneyInit(l.debit)}" oninput="voucherLines[${i}].debit=(+this.value.replace(/[^\\d]/g,''))||0;voucherLines[${i}].credit=0;updateVoucherBalance()"></div>
      <div class="fg"><label>بستانکار</label><input type="text" inputmode="numeric" class="money" value="${moneyInit(l.credit)}" oninput="voucherLines[${i}].credit=(+this.value.replace(/[^\\d]/g,''))||0;voucherLines[${i}].debit=0;updateVoucherBalance()"></div>
      <div class="fg full"><label>شرح ردیف</label><div style="display:flex;gap:6px">
        <input value="${esc(l.description||'')}" oninput="voucherLines[${i}].description=this.value" style="flex:1">
        ${voucherLines.length>2?`<button class="btn sm red icon" onclick="removeVoucherLine(${i})">🗑️</button>`:''}
      </div></div>
      </div>
    </div>`;
  }).join('');
  updateVoucherBalance();
}''',
    'renderVoucherLines'
)

# 6) Cheque branch/sheba fields
repl(
    '''          <div class="fg"><label>نام صادرکننده</label><input id="st-cowner"></div>
          <div class="fg full"><label>تاریخ سررسید *</label><input id="st-cdue" data-jdate></div>
        </div>
      </div>
    </div></div>
    <div class="modal-foot">
      <button class="btn green" onclick="saveSettlement()">💾 ثبت دریافت</button>''',
    '''          <div class="fg"><label>نام صادرکننده</label><input id="st-cowner"></div>
          <div class="fg"><label>شعبه</label><input id="st-cbranch" placeholder="شعبه بانک"></div>
          <div class="fg"><label>شماره شبا</label><input id="st-csheba" dir="ltr" placeholder="IR..."></div>
          <div class="fg full"><label>تاریخ سررسید *</label><input id="st-cdue" data-jdate></div>
        </div>
      </div>
      <div class="fg full"><label style="display:flex;align-items:center;gap:8px;cursor:pointer">
        <input type="checkbox" id="st-multicheque" onchange="stlToggleMultiCheque()" style="width:auto"> ثبت چند چک در یک سند دریافت
      </label></div>
      <div id="stlChequeList" style="display:none" class="fg full">
        <div class="tbl-wrap"><table class="tbl" style="font-size:12px"><thead><tr>
          <th>مبلغ</th><th>بانک</th><th>صیادی</th><th>شعبه</th><th>شبا</th><th>سررسید</th><th></th>
        </tr></thead><tbody id="stlChequeBody"></tbody></table></div>
        <button class="btn sm ghost" onclick="stlAddCheque()">➕ چک دیگر</button>
      </div>
    </div></div>
    <div class="modal-foot">
      <button class="btn green" onclick="saveSettlement()">💾 ثبت دریافت</button>''',
    'cheque branch sheba + multi'
)

# Insert multi-cheque helpers before saveSettlement
repl(
    'async function saveSettlement(){\n  const cust_id=+el(\'st-cust\').value;',
    r'''let stlCheques=[{amount:'',bank:'',sayadi:'',branch:'',sheba:'',due:todayJalali(),owner:'',number:''}];
function stlToggleMultiCheque(){
  const on=el('st-multicheque')?.checked;
  const box=el('stlChequeList'); if(box) box.style.display=on?'block':'none';
  const cf=el('chequeFields'); if(cf && on) cf.style.display='none';
  if(on){ el('st-paytype').value='cheque'; renderStlCheques(); }
}
function stlAddCheque(){ stlCheques.push({amount:'',bank:'',sayadi:'',branch:'',sheba:'',due:todayJalali(),owner:'',number:''}); renderStlCheques(); }
function renderStlCheques(){
  const body=el('stlChequeBody'); if(!body) return;
  body.innerHTML=stlCheques.map((c,i)=>`<tr>
    <td><input class="money" value="${esc(c.amount)}" onchange="stlCheques[${i}].amount=this.value" style="width:90px"></td>
    <td><input value="${esc(c.bank)}" onchange="stlCheques[${i}].bank=this.value" style="width:90px"></td>
    <td><input value="${esc(c.sayadi)}" onchange="stlCheques[${i}].sayadi=this.value" style="width:100px"></td>
    <td><input value="${esc(c.branch)}" onchange="stlCheques[${i}].branch=this.value" style="width:80px"></td>
    <td><input dir="ltr" value="${esc(c.sheba)}" onchange="stlCheques[${i}].sheba=this.value" style="width:120px"></td>
    <td><input data-jdate value="${esc(c.due)}" onchange="stlCheques[${i}].due=this.value" style="width:100px"></td>
    <td>${stlCheques.length>1?`<button class="btn sm red" onclick="stlCheques.splice(${i},1);renderStlCheques()">×</button>`:''}</td>
  </tr>`).join('');
  attachDatepickers(body);
}
async function saveSettlement(){
  const cust_id=+el('st-cust').value;''',
    'multi-cheque helpers'
)

# Add cheque_branch/sheba to single settlement save + multi-cheque branch
repl(
    '''      cheque_owner:pay_type==='cheque'?(el('st-cowner')?.value||''):'',
      cheque_due:pay_type==='cheque'?(el('st-cdue')?.value||''):'',
      cheque_status:'pending'
    });
    _accRecvCache=null; closeModal(); showToast('پرداخت ثبت شد');
    loadAccTab(accTab);
  }catch(e){}
}''',
    '''      cheque_owner:pay_type==='cheque'?(el('st-cowner')?.value||''):'',
      cheque_due:pay_type==='cheque'?(el('st-cdue')?.value||''):'',
      cheque_branch:pay_type==='cheque'?(el('st-cbranch')?.value||''):'',
      cheque_sheba:pay_type==='cheque'?(el('st-csheba')?.value||''):'',
      cheque_status:'pending'
    });
    _accRecvCache=null; closeModal(); showToast('پرداخت ثبت شد');
    loadAccTab(accTab);
  }catch(e){}
}''',
    'saveSettlement branch sheba'
)

# Inject multi-cheque save path after multi installment block start
repl(
    '''  const multi=el('st-multi')?.checked;
  if(multi){
    const payments=[];
    for(let i=0;i<stlRows.length;i++){''',
    '''  if(el('st-multicheque')?.checked){
    const payments=[];
    for(const c of stlCheques){
      const amount=parseInt(String(c.amount).replace(/[^\\d]/g,''))||0;
      if(!amount||!c.bank||!c.sayadi||!c.due){ showToast('برای هر چک مبلغ، بانک، صیادی و سررسید الزامی است','error'); return; }
      payments.push({
        amount, pay_type:'cheque', date:el('st-date')?.value||todayJalali(), invoice_id:+el('st-invoice')?.value||null,
        cheque_bank:c.bank, cheque_sayadi:c.sayadi, cheque_branch:c.branch||'', cheque_sheba:c.sheba||'',
        cheque_due:c.due, cheque_owner:c.owner||'', cheque_number:c.number||'', cheque_amount:amount, cheque_status:'pending',
        bank_id:+el('st-bank')?.value||null, cash_box_id:+el('st-cashbox')?.value||null
      });
    }
    try{
      await api('POST','/accounting/settlements/batch',{cust_id,payments,note:el('st-note')?.value||''});
      _accRecvCache=null; closeModal(); showToast(payments.length+' چک در یک سند ثبت شد'); loadAccTab(accTab);
    }catch(e){}
    return;
  }
  const multi=el('st-multi')?.checked;
  if(multi){
    const payments=[];
    for(let i=0;i<stlRows.length;i++){''',
    'multi-cheque save path'
)

# 7) Party toolbar excel + delete button
repl(
    '''        <div class="toolbar" style="margin-bottom:12px;flex-wrap:wrap;gap:8px">
          <button class="btn" onclick="partyModal()" ${!groupFilter?'disabled title="ابتدا یک گروه اشخاص انتخاب یا ایجاد کنید"':''}>➕ شخص جدید <span class="muted">F4</span></button>
          <input id="partySearch" placeholder="جستجو نام/تلفن/کد... F10" value="${esc(search)}" onchange="loadAccTab('parties')" style="padding:7px 10px;border:1.5px solid var(--border);border-radius:8px;font-size:13px;min-width:200px">
        </div>''',
    '''        <div class="toolbar" style="margin-bottom:12px;flex-wrap:wrap;gap:8px">
          <button class="btn" onclick="partyModal()" ${!groupFilter?'disabled title="ابتدا یک گروه اشخاص انتخاب یا ایجاد کنید"':''}>➕ شخص جدید <span class="muted">F4</span></button>
          <button class="btn ghost" onclick="exportPartiesExcel()">⬇️ خروجی اکسل</button>
          <button class="btn ghost" onclick="importPartiesExcel()">⬆️ ورود از اکسل</button>
          <input id="partySearch" placeholder="جستجو نام/تلفن/کد... F10" value="${esc(search)}" onchange="loadAccTab('parties')" style="padding:7px 10px;border:1.5px solid var(--border);border-radius:8px;font-size:13px;min-width:200px">
        </div>''',
    'party excel buttons'
)

repl(
    '''          <td style="white-space:nowrap">
            <button class="btn sm ghost" onclick="partyModal(${p.id})">✏️</button>
            <button class="btn sm blue" onclick="showPartyTurnover(${p.id},'${esc(p.full_name||p.biz||'')}')">📒 گردش</button>
          </td>''',
    '''          <td style="white-space:nowrap">
            <button class="btn sm ghost" onclick="partyModal(${p.id})">✏️</button>
            <button class="btn sm blue" onclick="showPartyTurnover(${p.id},'${esc(p.full_name||p.biz||'')}')">📒 گردش</button>
            <button class="btn sm red" onclick="deleteParty(${p.id})">🗑️</button>
          </td>''',
    'party delete button'
)

# 8) partyModal fields: prefix dropdown, coa readonly, expert, remove initJalaliPickers
repl(
    '''      <div class="fg"><label>کد حساب تفصیلی</label><input id="pty-coa" dir="ltr" class="mono" value="${esc(p.coa_code||'')}"></div>
      <div class="fg"><label>پیشوند (آقا/خانم)</label><input id="pty-prefix" value="${esc(p.prefix||'')}"></div>''',
    '''      <div class="fg"><label>کد حساب تفصیلی</label><input id="pty-coa" dir="ltr" class="mono" value="${esc(p.coa_code||'')}" placeholder="خودکار" readonly style="background:#f9fafb"></div>
      <div class="fg"><label>پیشوند</label><select id="pty-prefix">
        <option value="">—</option>
        ${['آقا','خانم','شرکت','مؤسسه','سایر'].map(x=>`<option value="${x}" ${(p.prefix||'')===x?'selected':''}>${x}</option>`).join('')}
      </select></div>''',
    'party prefix/coa'
)

repl(
    '''      <div class="fg"><label>ماهیت حساب</label><select id="pty-nature">
        <option value="" ${!p.account_nature?'selected':''}>—</option>
        <option value="debit" ${p.account_nature==='debit'?'selected':''}>بدهکار</option>
        <option value="credit" ${p.account_nature==='credit'?'selected':''}>بستانکار</option>
      </select></div>
      <div class="fg full"><label>یادداشت</label><textarea id="pty-note">${esc(p.notes||p.note||'')}</textarea></div>
    </div></div>
    <div class="modal-foot"><button class="btn" onclick="saveParty(${id||0})">💾 ذخیره</button>
      <button class="btn ghost" onclick="closeModal()">انصراف</button></div>`);
  initJalaliPickers();
}''',
    '''      <div class="fg"><label>ماهیت حساب</label><select id="pty-nature">
        <option value="" ${!p.account_nature?'selected':''}>—</option>
        <option value="debit" ${p.account_nature==='debit'?'selected':''}>بدهکار</option>
        <option value="credit" ${p.account_nature==='credit'?'selected':''}>بستانکار</option>
      </select></div>
      <div class="fg"><label>کارشناس مسئول</label><select id="pty-expert"><option value="">—</option>
        ${(CACHE.users||[]).filter(u=>u.active).map(u=>`<option value="${u.id}" ${(p.user_id||p.assigned_to)==u.id?'selected':''}>${esc(u.name)}</option>`).join('')}
      </select></div>
      <div class="fg full"><label>یادداشت</label><textarea id="pty-note">${esc(p.notes||p.note||'')}</textarea></div>
    </div></div>
    <div class="modal-foot"><button class="btn" onclick="saveParty(${id||0})">💾 ذخیره</button>
      <button class="btn ghost" onclick="closeModal()">انصراف</button></div>`);
  if(!CACHE.users?.length){ api('GET','/auth/users').then(u=>{CACHE.users=u||[]; const s=el('pty-expert'); if(s&&!s.options.length){ /* refreshed next open */ }}).catch(()=>{}); }
}''',
    'party expert + remove initJalali'
)

repl(
    '''    credit_limit:moneyVal('pty-credit'), opening_balance:moneyVal('pty-opening'),
    account_nature:el('pty-nature').value, notes:el('pty-note').value,
    biz:full_name
  };''',
    '''    credit_limit:moneyVal('pty-credit'), opening_balance:moneyVal('pty-opening'),
    account_nature:el('pty-nature').value, notes:el('pty-note').value,
    user_id:+el('pty-expert')?.value||undefined,
    assigned_to:+el('pty-expert')?.value||undefined,
    biz:full_name
  };''',
    'saveParty expert'
)

# Add deleteParty + excel helpers after saveParty catch
repl(
    '''async function saveParty(id){
  const full_name=el('pty-name').value.trim();
  const phone=el('pty-phone').value.trim();
  if(!full_name||!phone){ showToast('نام و تلفن الزامی است','error'); return; }
  const roles=[...document.querySelectorAll('.pty-role:checked')].map(x=>x.value);
  if(!roles.length){ showToast('حداقل یک سمت انتخاب کنید','error'); return; }
  const party_group_id=el('pty-party_group_id').value;
  if(!party_group_id){ showToast('انتخاب گروه اشخاص الزامی است','error'); return; }
  const data={
    person_code:el('pty-code').value.trim()||undefined,
    coa_code:el('pty-coa').value.trim(),
    prefix:el('pty-prefix').value,''',
    '''async function deleteParty(id){
  if(!confirm('این شخص غیرفعال/حذف شود؟')) return;
  try{ await api('DELETE','/parties/'+id); showToast('حذف شد'); loadAccTab('parties'); }catch(e){}
}
function exportPartiesExcel(){
  const token=localStorage.getItem('crm_token');
  window.open('/api/parties/export/excel?token='+encodeURIComponent(token||''),'_blank');
  // fallback fetch blob
  fetch('/api/parties/export/excel',{headers:{Authorization:'Bearer '+token}}).then(r=>r.blob()).then(b=>{
    const a=document.createElement('a'); a.href=URL.createObjectURL(b); a.download='parties.csv'; a.click();
  }).catch(()=>{});
}
function importPartiesExcel(){
  const inp=document.createElement('input'); inp.type='file'; inp.accept='.csv,.xlsx,.xls,text/csv';
  inp.onchange=async()=>{
    const f=inp.files[0]; if(!f) return;
    const text=await f.text();
    const lines=text.replace(/^\\uFEFF/,'').split(/\\r?\\n/).filter(Boolean);
    if(lines.length<2){ showToast('فایل خالی است','error'); return; }
    const sep=lines[0].includes(';')?';':',';
    const headers=lines[0].split(sep).map(h=>h.replace(/^"|"$/g,'').trim());
    const rows=[];
    for(let i=1;i<lines.length;i++){
      const cols=lines[i].split(sep).map(c=>c.replace(/^"|"$/g,'').trim());
      const obj={};
      headers.forEach((h,idx)=>obj[h]=cols[idx]||'');
      rows.push({
        full_name: obj['نام']||obj['نام*']||obj.full_name||obj.name,
        phone: obj['تلفن']||obj['تلفن*']||obj.phone,
        prefix: obj['پیشوند']||obj.prefix,
        mobile: obj['موبایل']||obj.mobile,
        city: obj['شهر']||obj.city,
        party_group_name: obj['گروه']||obj.party_group_name,
        party_roles: (obj['سمت‌ها']||obj.roles||'customer').split(/[|,،]/).map(x=>x.trim()).filter(Boolean),
        email: obj['ایمیل']||obj.email,
        national_id: obj['کد ملی']||obj.national_id
      });
    }
    try{
      const r=await api('POST','/parties/import',{rows});
      showToast(`ورود انجام شد — جدید: ${r.created||0}، رد شده: ${r.skipped||0}`);
      loadAccTab('parties');
    }catch(e){}
  };
  inp.click();
}
async function saveParty(id){
  const full_name=el('pty-name').value.trim();
  const phone=el('pty-phone').value.trim();
  if(!full_name||!phone){ showToast('نام و تلفن الزامی است','error'); return; }
  const roles=[...document.querySelectorAll('.pty-role:checked')].map(x=>x.value);
  if(!roles.length){ showToast('حداقل یک سمت انتخاب کنید','error'); return; }
  const party_group_id=el('pty-party_group_id').value;
  if(!party_group_id){ showToast('انتخاب گروه اشخاص الزامی است','error'); return; }
  const data={
    person_code:el('pty-code').value.trim()||undefined,
    coa_code:el('pty-coa').value.trim(),
    prefix:el('pty-prefix').value,''',
    'deleteParty + import/export + saveParty head'
)

# 9) Expense modal categories from API
repl(
    '''async function expensePaymentModal(){
  if(!CACHE.chartOfAccounts?.length) CACHE.chartOfAccounts=await api('GET','/accounting/chart-of-accounts')||[];
  openModal(`
    <div class="modal-head"><h3>🧾 ثبت پرداخت هزینه</h3><button class="x" onclick="closeModal()">×</button></div>
    <div class="modal-body"><div class="form-grid">
      <div class="fg"><label>دسته هزینه</label><select id="ex-category">
        <option value="admin">عمومی و اداری</option><option value="sales">توزیع و فروش</option>
      </select></div>''',
    '''async function expensePaymentModal(){
  if(!CACHE.chartOfAccounts?.length) CACHE.chartOfAccounts=await api('GET','/accounting/chart-of-accounts')||[];
  if(!CACHE.expenseCategories) CACHE.expenseCategories=await api('GET','/expenses/categories').catch(()=>[])||[];
  const cats=CACHE.expenseCategories.length?CACHE.expenseCategories:[{code:'admin',name:'عمومی و اداری'},{code:'sales',name:'توزیع و فروش'}];
  openModal(`
    <div class="modal-head"><h3>🧾 ثبت پرداخت هزینه</h3><button class="x" onclick="closeModal()">×</button></div>
    <div class="modal-body"><div class="form-grid">
      <div class="fg"><label>دسته هزینه</label><select id="ex-category">
        ${cats.map(c=>`<option value="${esc(c.code||c.id)}">${esc(c.name)}</option>`).join('')}
      </select></div>''',
    'expense categories select'
)

# 10) loadAccTab expense-categories + ensure warehouses for invoice cart
repl(
    "  } else if(tab==='settlements'){\n    await renderCashOpsTab(body, dq);",
    '''  } else if(tab==='expense-categories'){
    await renderExpenseCategoriesTab(body);
  } else if(tab==='settlements'){
    await renderCashOpsTab(body, dq);''',
    'loadAccTab expense-categories'
)

# Insert renderExpenseCategoriesTab before renderCashOpsTab
repl(
    '/* ============================================================\n   CASH OPS — unified receive (settlements) + pay (outgoing) tab\n============================================================ */\nasync function renderCashOpsTab(body, dq){',
    r'''async function renderExpenseCategoriesTab(body){
  const rows=await api('GET','/expenses/categories')||[];
  CACHE.expenseCategories=rows;
  body.innerHTML=`
    <div class="toolbar" style="margin-bottom:12px"><button class="btn" onclick="expenseCategoryModal()">➕ دسته جدید</button></div>
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th>کد</th><th>نام</th><th>حساب دفتر کل</th><th>عملیات</th></tr></thead>
    <tbody>${rows.map(r=>`<tr>
      <td class="mono">${esc(r.code||'-')}</td><td>${esc(r.name)}</td><td class="mono">${esc(r.account_code||'-')}</td>
      <td><button class="btn sm ghost" onclick="expenseCategoryModal(${r.id})">✏️</button>
          <button class="btn sm red" onclick="deleteExpenseCategory(${r.id})">🗑️</button></td>
    </tr>`).join('')||emptyRow(4)}</tbody></table></div>`;
}
async function expenseCategoryModal(id){
  const row=id?(CACHE.expenseCategories||[]).find(x=>x.id===id)||{}:{};
  openModal(`
    <div class="modal-head"><h3>${id?'ویرایش دسته هزینه':'دسته هزینه جدید'}</h3><button class="x" onclick="closeModal()">×</button></div>
    <div class="modal-body"><div class="form-grid">
      <div class="fg"><label>کد</label><input id="ec-code" value="${esc(row.code||'')}"></div>
      <div class="fg"><label>نام *</label><input id="ec-name" value="${esc(row.name||'')}"></div>
      <div class="fg full"><label>کد حساب دفتر کل</label><input id="ec-account" dir="ltr" class="mono" value="${esc(row.account_code||'')}" placeholder="مثال: 6102"></div>
    </div></div>
    <div class="modal-foot"><button class="btn" onclick="saveExpenseCategory(${id||0})">💾 ذخیره</button>
      <button class="btn ghost" onclick="closeModal()">انصراف</button></div>`);
}
async function saveExpenseCategory(id){
  const name=el('ec-name').value.trim(); if(!name){ showToast('نام الزامی است','error'); return; }
  const data={name, code:el('ec-code').value.trim(), account_code:el('ec-account').value.trim()};
  try{
    if(id) await api('PUT','/expenses/categories/'+id,data); else await api('POST','/expenses/categories',data);
    closeModal(); showToast('ذخیره شد'); CACHE.expenseCategories=null; loadAccTab('expense-categories');
  }catch(e){}
}
async function deleteExpenseCategory(id){
  if(!confirm('این دسته حذف شود؟')) return;
  try{ await api('DELETE','/expenses/categories/'+id); showToast('حذف شد'); CACHE.expenseCategories=null; loadAccTab('expense-categories'); }catch(e){}
}

/* ============================================================
   CASH OPS — unified receive (settlements) + pay (outgoing) tab
============================================================ */
async function renderCashOpsTab(body, dq){''',
    'expense categories tab UI'
)

# 11) Invoice cart per-line warehouse
repl(
    "  invCart = inv ? (inv.rows||[]).map(r=>({product_id:r.product_id,name:r.name,qty:r.qty,price:r.price,disc:r.disc||0})) : [];",
    "  invCart = inv ? (inv.rows||[]).map(r=>({product_id:r.product_id,name:r.name,qty:r.qty,price:r.price,disc:r.disc||0,warehouse_id:r.warehouse_id||null})) : [];\n  if(!CACHE.warehouses) CACHE.warehouses=await api('GET','/warehouses')||[];",
    'invCart warehouse_id'
)

repl(
    '''function renderCart(){
  const showLineDisc=canAccounting();
  el('cartRows').innerHTML = invCart.map((r,i)=>{
    const gross=r.qty*r.price;
    const lineDisc=showLineDisc?(r.disc||0):0;
    const lineDiscAmt=Math.round(gross*lineDisc/100);
    return `
    <div class="cart-row">
      <span class="cn">${esc(r.name)}</span>
      <input type="number" min="1" value="${r.qty}" onchange="invCart[${i}].qty=Math.max(1,+this.value||1);renderCart();renderInvPicker()">
      <input class="price-in" type="number" value="${r.price}" onchange="invCart[${i}].price=+this.value||0;renderCart()">
      ${showLineDisc?`<input type="number" min="0" max="100" title="تخفیف ردیف (٪)" value="${r.disc||0}" style="width:52px" onchange="invCart[${i}].disc=Math.min(100,Math.max(0,+this.value||0));renderCart()">`:''}
      <button class="rm" onclick="invCart.splice(${i},1);renderCart();renderInvPicker()">×</button>
    </div>${showLineDisc&&lineDiscAmt>0?`<div class="muted" style="font-size:11px;margin:-4px 0 6px;padding-right:2px">تخفیف ردیف: ${fmt(lineDiscAmt)} ت</div>`:''}`;
  }).join('') || '<div class="muted center" style="padding:14px">سبد خالی است</div>';''',
    '''function renderCart(){
  const showLineDisc=canAccounting();
  const whOpts='<option value=\"\">پیش‌فرض</option>'+(CACHE.warehouses||[]).filter(w=>w.active!==0).map(w=>`<option value=\"${w.id}\">${esc(w.name)}</option>`).join('');
  el('cartRows').innerHTML = invCart.map((r,i)=>{
    const gross=r.qty*r.price;
    const lineDisc=showLineDisc?(r.disc||0):0;
    const lineDiscAmt=Math.round(gross*lineDisc/100);
    return `
    <div class="cart-row" style="flex-wrap:wrap">
      <span class="cn">${esc(r.name)}</span>
      <input type="number" min="1" value="${r.qty}" onchange="invCart[${i}].qty=Math.max(1,+this.value||1);renderCart();renderInvPicker()">
      <input class="price-in" type="number" value="${r.price}" onchange="invCart[${i}].price=+this.value||0;renderCart()">
      ${showLineDisc?`<input type="number" min="0" max="100" title="تخفیف ردیف (٪)" value="${r.disc||0}" style="width:52px" onchange="invCart[${i}].disc=Math.min(100,Math.max(0,+this.value||0));renderCart()">`:''}
      <select title="انبار ردیف" style="max-width:120px;font-size:11px" onchange="invCart[${i}].warehouse_id=+this.value||null">${whOpts.replace(`value=\"${r.warehouse_id||''}\"`,`value=\"${r.warehouse_id||''}\" selected`).replace(`value=\"${r.warehouse_id}\"`,`value=\"${r.warehouse_id}\" selected`)}</select>
      <button class="rm" onclick="invCart.splice(${i},1);renderCart();renderInvPicker()">×</button>
    </div>${showLineDisc&&lineDiscAmt>0?`<div class="muted" style="font-size:11px;margin:-4px 0 6px;padding-right:2px">تخفیف ردیف: ${fmt(lineDiscAmt)} ت</div>`:''}`;
  }).join('') || '<div class="muted center" style="padding:14px">سبد خالی است</div>';''',
    'renderCart warehouse select'
)

# Fix warehouse select properly - the replace above is hacky. Do a cleaner version.
# Actually the selected option logic is broken. Let me fix with another replace.
# Find the select line and fix it.

# Better fix for cart warehouse select after the hacky one:
if 'title="انبار ردیف"' in t:
    import re
    t2, c = re.subn(
        r'<select title="انبار ردیف"[^>]*>\$\{whOpts\.replace\([^)]+\)\.replace\([^)]+\)\}</select>',
        '''<select title="انبار ردیف" style="max-width:120px;font-size:11px" onchange="invCart[${i}].warehouse_id=+this.value||null"><option value="">پیش‌فرض</option>${(CACHE.warehouses||[]).filter(w=>w.active!==0).map(w=>`<option value="${w.id}" ${String(r.warehouse_id||'')===String(w.id)?'selected':''}>${esc(w.name)}</option>`).join('')}</select>''',
        t, count=1
    )
    if c:
        t = t2
        n += 1
        print('OK cart warehouse select fix')
    else:
        print('WARN cart warehouse select fix skipped')

repl(
    "    rows: invCart.map(r=>({product_id:r.product_id, qty:r.qty, price:r.price, disc:r.disc||0}))\n  };\n  try{\n    if(id) await api('PUT','/invoices/'+id,data); else await api('POST','/invoices',data);\n    CACHE.invoices=await api('GET','/invoices'); _invoicesFetched=true; closeModal();\n    if(el('invTable')) renderInvTable();\n    else if(IN_ACC_SHELL && accTab==='sales-invoices') loadAccTab('sales-invoices');\n    showToast('فاکتور ذخیره شد');\n  }catch(e){}\n}",
    "    rows: invCart.map(r=>({product_id:r.product_id, qty:r.qty, price:r.price, disc:r.disc||0, warehouse_id:r.warehouse_id||null}))\n  };\n  try{\n    const saved=id?await api('PUT','/invoices/'+id,data):await api('POST','/invoices',data);\n    CACHE.invoices=await api('GET','/invoices'); _invoicesFetched=true; closeModal();\n    if(el('invTable')) renderInvTable();\n    else if(IN_ACC_SHELL && accTab==='sales-invoices') loadAccTab('sales-invoices');\n    const whNames=(saved?.used_warehouses||[]).map(w=>w.name).filter(Boolean);\n    showToast(whNames.length?('فاکتور ذخیره شد — کسر از انبار: '+whNames.join('، ')):'فاکتور ذخیره شد');\n  }catch(e){}\n}",
    'saveInvoice warehouse rows'
)

# 12) Multi-line warehouse modals
repl(
    '''function warehouseReceiptModal(){
  openModal(`
    <div class="modal-head"><h3>⬇️ رسید انبار</h3><button class="x" onclick="closeModal()">×</button></div>
    <div class="modal-body"><div class="form-grid">
      <div class="fg full"><label>کالا * ${hlp('اگر کالا در انبار دیگری بود، با ثبت رسید در این انبار جابه‌جا می‌شود.')}</label><select id="wr-product">${productOptions()}</select></div>
      <div class="fg"><label>انبار مقصد *</label><select id="wr-warehouse">${(CACHE.warehouses||[]).filter(w=>w.active).map(w=>`<option value="${w.id}">${esc(w.name)}</option>`).join('')}</select></div>
      <div class="fg"><label>تعداد *</label><input id="wr-qty" type="number" min="1"></div>
      <div class="fg"><label>تاریخ</label><input id="wr-date" data-jdate value="${todayJalali()}"></div>
      <div class="fg full"><label>یادداشت</label><input id="wr-note" placeholder="مثال: موجودی اولیه، کالای یافت‌شده، ..."></div>
    </div></div>
    <div class="modal-foot"><button class="btn green" onclick="saveWarehouseReceipt()">💾 ثبت رسید</button>
      <button class="btn ghost" onclick="closeModal()">انصراف</button></div>`);
  attachDatepickers(el('modalRoot'));
}
async function saveWarehouseReceipt(){
  const product_id=+el('wr-product').value, warehouse_id=+el('wr-warehouse').value, qty=+el('wr-qty').value;
  if(!product_id||!warehouse_id||!qty){ showToast('همه فیلدهای الزامی را پر کنید','error'); return; }
  try{
    await api('POST','/warehouses/moves/receipt',{product_id,warehouse_id,qty,date:el('wr-date').value,note:el('wr-note').value});
    closeModal(); showToast('رسید انبار ثبت شد'); CACHE.allProducts=await api('GET','/products')||[]; loadAccTab('warehouse-ops');
  }catch(e){}
}
function warehouseIssueModal(){
  openModal(`
    <div class="modal-head"><h3>⬆️ حواله انبار</h3><button class="x" onclick="closeModal()">×</button></div>
    <div class="modal-body"><div class="form-grid">
      <div class="fg full"><label>کالا *</label><select id="wi-product">${productOptions()}</select></div>
      <div class="fg"><label>انبار مبدأ *</label><select id="wi-warehouse">${(CACHE.warehouses||[]).filter(w=>w.active).map(w=>`<option value="${w.id}">${esc(w.name)}</option>`).join('')}</select></div>
      <div class="fg"><label>تعداد *</label><input id="wi-qty" type="number" min="1"></div>
      <div class="fg"><label>تاریخ</label><input id="wi-date" data-jdate value="${todayJalali()}"></div>
      <div class="fg full"><label>یادداشت</label><input id="wi-note" placeholder="مثال: ضایعات، مصرف داخلی، ..."></div>
    </div></div>
    <div class="modal-foot"><button class="btn orange" onclick="saveWarehouseIssue()">💾 ثبت حواله</button>
      <button class="btn ghost" onclick="closeModal()">انصراف</button></div>`);
  attachDatepickers(el('modalRoot'));
}
async function saveWarehouseIssue(){
  const product_id=+el('wi-product').value, warehouse_id=+el('wi-warehouse').value, qty=+el('wi-qty').value;
  if(!product_id||!warehouse_id||!qty){ showToast('همه فیلدهای الزامی را پر کنید','error'); return; }
  try{
    await api('POST','/warehouses/moves/issue',{product_id,warehouse_id,qty,date:el('wi-date').value,note:el('wi-note').value});
    closeModal(); showToast('حواله انبار ثبت شد'); CACHE.allProducts=await api('GET','/products')||[]; loadAccTab('warehouse-ops');
  }catch(e){}
}
function warehouseTransferModal(){
  openModal(`
    <div class="modal-head"><h3>🔄 انتقال بین انبارها</h3><button class="x" onclick="closeModal()">×</button></div>
    <div class="modal-body"><div class="form-grid">
      <div class="fg full"><label>کالا *</label><select id="wt-product">${productOptions()}</select></div>
      <div class="fg"><label>انبار مبدأ *</label><select id="wt-from">${(CACHE.warehouses||[]).filter(w=>w.active).map(w=>`<option value="${w.id}">${esc(w.name)}</option>`).join('')}</select></div>
      <div class="fg"><label>انبار مقصد *</label><select id="wt-to">${(CACHE.warehouses||[]).filter(w=>w.active).map(w=>`<option value="${w.id}">${esc(w.name)}</option>`).join('')}</select></div>
      <div class="fg"><label>تعداد انتقال * ${hlp('مقدار کالایی که از انبار مبدأ به مقصد منتقل می‌شود.')}</label><input id="wt-qty" type="number" min="1" value="1"></div>
      <div class="fg"><label>تاریخ</label><input id="wt-date" data-jdate value="${todayJalali()}"></div>
      <div class="fg full"><label>یادداشت</label><input id="wt-note"></div>
    </div></div>
    <div class="modal-foot"><button class="btn" onclick="saveWarehouseTransfer()">💾 ثبت انتقال</button>
      <button class="btn ghost" onclick="closeModal()">انصراف</button></div>`);
  attachDatepickers(el('modalRoot'));
}
async function saveWarehouseTransfer(){
  const product_id=+el('wt-product').value, from_warehouse_id=+el('wt-from').value, to_warehouse_id=+el('wt-to').value, qty=+el('wt-qty').value;
  if(!product_id||!from_warehouse_id||!to_warehouse_id||!qty){ showToast('همه فیلدهای الزامی را پر کنید','error'); return; }
  try{
    await api('POST','/warehouses/moves/transfer',{product_id,from_warehouse_id,to_warehouse_id,qty,date:el('wt-date').value,note:el('wt-note').value});
    closeModal(); showToast('انتقال ثبت شد'); CACHE.allProducts=await api('GET','/products')||[]; loadAccTab('warehouse-ops');
  }catch(e){}
}''',
    r'''let whDocLines=[{product_id:'',qty:1}];
function whDocLinesHtml(){
  return `<div class="tbl-wrap" style="margin-bottom:8px"><table class="tbl" style="font-size:12px"><thead><tr><th>کالا</th><th>تعداد</th><th></th></tr></thead>
    <tbody id="whDocBody">${whDocLines.map((l,i)=>`<tr>
      <td><select onchange="whDocLines[${i}].product_id=this.value">${productOptions(l.product_id)}</select></td>
      <td><input type="number" min="1" value="${l.qty||1}" onchange="whDocLines[${i}].qty=+this.value||1" style="width:80px"></td>
      <td>${whDocLines.length>1?`<button class="btn sm red" onclick="whDocLines.splice(${i},1);renderWhDocLines()">×</button>`:''}</td>
    </tr>`).join('')}</tbody></table></div>
    <button class="btn sm ghost" type="button" onclick="whDocLines.push({product_id:'',qty:1});renderWhDocLines()">➕ کالای دیگر</button>`;
}
function renderWhDocLines(){ const box=el('whDocLines'); if(box) box.innerHTML=whDocLinesHtml(); }
function warehouseReceiptModal(){
  whDocLines=[{product_id:'',qty:1}];
  openModal(`
    <div class="modal-head"><h3>⬇️ رسید انبار (چند کالا)</h3><button class="x" onclick="closeModal()">×</button></div>
    <div class="modal-body"><div class="form-grid">
      <div class="fg"><label>انبار مقصد *</label><select id="wr-warehouse">${(CACHE.warehouses||[]).filter(w=>w.active).map(w=>`<option value="${w.id}">${esc(w.name)}</option>`).join('')}</select></div>
      <div class="fg"><label>تاریخ</label><input id="wr-date" data-jdate value="${todayJalali()}"></div>
      <div class="fg full"><label>یادداشت</label><input id="wr-note"></div>
      <div class="fg full" id="whDocLines">${whDocLinesHtml()}</div>
    </div></div>
    <div class="modal-foot"><button class="btn green" onclick="saveWarehouseReceipt()">💾 ثبت رسید</button>
      <button class="btn ghost" onclick="closeModal()">انصراف</button></div>`);
  attachDatepickers(el('modalRoot'));
}
async function saveWarehouseReceipt(){
  const warehouse_id=+el('wr-warehouse').value;
  const lines=whDocLines.map(l=>({product_id:+l.product_id, qty:+l.qty||0})).filter(l=>l.product_id&&l.qty>0);
  if(!warehouse_id||!lines.length){ showToast('انبار و حداقل یک کالا الزامی است','error'); return; }
  try{
    const r=await api('POST','/warehouses/moves/batch',{type:'receipt',warehouse_id,lines,date:el('wr-date').value,note:el('wr-note').value});
    closeModal(); showToast((r.count||lines.length)+' ردیف رسید ثبت شد'); CACHE.allProducts=await api('GET','/products')||[]; loadAccTab('warehouse-ops');
  }catch(e){}
}
function warehouseIssueModal(){
  whDocLines=[{product_id:'',qty:1}];
  openModal(`
    <div class="modal-head"><h3>⬆️ حواله انبار (چند کالا)</h3><button class="x" onclick="closeModal()">×</button></div>
    <div class="modal-body"><div class="form-grid">
      <div class="fg"><label>انبار مبدأ *</label><select id="wi-warehouse">${(CACHE.warehouses||[]).filter(w=>w.active).map(w=>`<option value="${w.id}">${esc(w.name)}</option>`).join('')}</select></div>
      <div class="fg"><label>تاریخ</label><input id="wi-date" data-jdate value="${todayJalali()}"></div>
      <div class="fg full"><label>یادداشت</label><input id="wi-note"></div>
      <div class="fg full" id="whDocLines">${whDocLinesHtml()}</div>
    </div></div>
    <div class="modal-foot"><button class="btn orange" onclick="saveWarehouseIssue()">💾 ثبت حواله</button>
      <button class="btn ghost" onclick="closeModal()">انصراف</button></div>`);
  attachDatepickers(el('modalRoot'));
}
async function saveWarehouseIssue(){
  const warehouse_id=+el('wi-warehouse').value;
  const lines=whDocLines.map(l=>({product_id:+l.product_id, qty:+l.qty||0})).filter(l=>l.product_id&&l.qty>0);
  if(!warehouse_id||!lines.length){ showToast('انبار و حداقل یک کالا الزامی است','error'); return; }
  try{
    const r=await api('POST','/warehouses/moves/batch',{type:'issue',warehouse_id,lines,date:el('wi-date').value,note:el('wi-note').value});
    closeModal(); showToast((r.count||lines.length)+' ردیف حواله ثبت شد'); CACHE.allProducts=await api('GET','/products')||[]; loadAccTab('warehouse-ops');
  }catch(e){}
}
function warehouseTransferModal(){
  whDocLines=[{product_id:'',qty:1}];
  openModal(`
    <div class="modal-head"><h3>🔄 انتقال بین انبارها (چند کالا)</h3><button class="x" onclick="closeModal()">×</button></div>
    <div class="modal-body"><div class="form-grid">
      <div class="fg"><label>انبار مبدأ *</label><select id="wt-from">${(CACHE.warehouses||[]).filter(w=>w.active).map(w=>`<option value="${w.id}">${esc(w.name)}</option>`).join('')}</select></div>
      <div class="fg"><label>انبار مقصد *</label><select id="wt-to">${(CACHE.warehouses||[]).filter(w=>w.active).map(w=>`<option value="${w.id}">${esc(w.name)}</option>`).join('')}</select></div>
      <div class="fg"><label>تاریخ</label><input id="wt-date" data-jdate value="${todayJalali()}"></div>
      <div class="fg full"><label>یادداشت</label><input id="wt-note"></div>
      <div class="fg full" id="whDocLines">${whDocLinesHtml()}</div>
    </div></div>
    <div class="modal-foot"><button class="btn" onclick="saveWarehouseTransfer()">💾 ثبت انتقال</button>
      <button class="btn ghost" onclick="closeModal()">انصراف</button></div>`);
  attachDatepickers(el('modalRoot'));
}
async function saveWarehouseTransfer(){
  const from_warehouse_id=+el('wt-from').value, to_warehouse_id=+el('wt-to').value;
  const lines=whDocLines.map(l=>({product_id:+l.product_id, qty:+l.qty||0})).filter(l=>l.product_id&&l.qty>0);
  if(!from_warehouse_id||!to_warehouse_id||!lines.length){ showToast('انبارها و حداقل یک کالا الزامی است','error'); return; }
  try{
    const r=await api('POST','/warehouses/moves/batch',{type:'transfer',from_warehouse_id,to_warehouse_id,lines,date:el('wt-date').value,note:el('wt-note').value});
    closeModal(); showToast((r.count||lines.length)+' ردیف انتقال ثبت شد'); CACHE.allProducts=await api('GET','/products')||[]; loadAccTab('warehouse-ops');
  }catch(e){}
}''',
    'warehouse multi-line modals'
)

# Check productOptions signature - may not accept selected id
# Grep later if needed

if t == orig:
    raise SystemExit('No changes applied')
p.write_text(t, encoding='utf-8')
print(f'DONE patches={n} size={len(t)} delta={len(t)-len(orig)}')
