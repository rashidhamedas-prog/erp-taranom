/**
 * portal-ui.js — پرتال عملیاتی + گزارشات/تطبیق/بودجه/ذخایر (Accounting Gap UI)
 * IIFE — توابع render روی globalThis برای loadAccTab و onclick
 */
(function (global) {
  'use strict';

  let _portalUnitId = null;
  let _portalParamId = null;
  let _bankReconId = null;
  let _budgetId = null;

  function deptColor(st) {
    return ({
      completed: '#22c55e',
      in_progress: '#eab308',
      under_review: '#f97316',
      pending: '#d1d5db',
    }[st] || '#d1d5db');
  }

  function timelineHtml(logs) {
    if (!logs || !logs.length) return '<span class="muted">—</span>';
    return `<div style="display:flex;gap:3px;align-items:center">${logs.map(l =>
      `<div title="${esc(l.department_name || '')} (${esc(l.status || '')})" style="flex:1;min-width:12px;height:10px;border-radius:3px;background:${deptColor(l.status)}"></div>`
    ).join('')}</div>`;
  }

  async function ensurePortalCaches() {
    if (!CACHE.persons) CACHE.persons = await api('GET', '/persons') || [];
    if (!CACHE.warehouses) CACHE.warehouses = await api('GET', '/warehouses') || [];
    if (!CACHE.allProducts && !CACHE.products) {
      CACHE.allProducts = await api('GET', '/products') || [];
    }
  }

  async function renderPortalUnitsTab(body) {
    await ensurePortalCaches();
    const units = await api('GET', '/portal/units') || [];
    const params = await api('GET', '/portal/parameters') || [];
    const selUnit = _portalUnitId ? units.find(u => u.id === _portalUnitId) : null;
    let detailHtml = '';
    if (selUnit) {
      const u = await api('GET', '/portal/units/' + selUnit.id) || selUnit;
      const unitParams = params.filter(p => p.unit_id === u.id);
      detailHtml = `
        <div class="panel" style="margin-top:12px">
          <div class="panel-head"><h4>🏢 ${esc(u.name)} — بخش‌ها و پارامترها</h4>
            <button class="btn sm ghost" onclick="PortalUI.openCreateParamModal(${u.id})">➕ پارامتر جدید</button>
          </div>
          <div class="panel-body">
            <h5 style="margin:0 0 8px;font-size:13px">بخش‌های عملیاتی</h5>
            <div class="tbl-wrap" style="margin-bottom:14px"><table class="tbl" style="font-size:12px"><thead><tr>
              <th>ترتیب</th><th>نام</th><th>مدیر</th><th>انبار</th><th>امکانات/وظایف</th>
            </tr></thead><tbody>${(u.departments || []).map(d => `<tr>
              <td class="mono">${fmt(d.sequence_order)}</td>
              <td>${esc(d.name)}</td>
              <td>${esc(d.manager_name || '-')}</td>
              <td>${esc(d.warehouse_name || '-')}</td>
              <td style="white-space:nowrap">
                <button class="btn sm ghost" onclick="PortalUI.addDeptCapability(${d.id})" title="امکان/خدمت">➕ امکان</button>
                <button class="btn sm ghost" onclick="PortalUI.addDeptTask(${d.id})" title="شرح وظیفه">➕ وظیفه</button>
              </td>
            </tr>`).join('') || emptyRow(5)}</tbody></table></div>
            <h5 style="margin:0 0 8px;font-size:13px">پارامترها</h5>
            <div class="tbl-wrap"><table class="tbl" style="font-size:12px"><thead><tr>
              <th>شماره</th><th>نام</th><th>وضعیت</th><th>خط زمانی بخش‌ها</th><th></th>
            </tr></thead><tbody>${unitParams.map(p => `<tr>
              <td class="mono">${esc(p.num || p.id)}</td>
              <td>${esc(p.name)}</td>
              <td><span class="tag">${esc(p.status || '-')}</span></td>
              <td id="ptl-${p.id}"><span class="muted">…</span></td>
              <td><button class="btn sm" onclick="PortalUI.showParamDetail(${p.id})">جزئیات</button></td>
            </tr>`).join('') || emptyRow(5)}</tbody></table></div>
            <div id="portalParamDetail"></div>
          </div>
        </div>`;
      setTimeout(() => {
        unitParams.forEach(async p => {
          try {
            const full = await api('GET', '/portal/parameters/' + p.id);
            const cell = document.getElementById('ptl-' + p.id);
            if (cell) cell.innerHTML = timelineHtml(full.dept_logs);
          } catch (_) {}
        });
      }, 0);
    }
    body.innerHTML = `
      <div class="toolbar" style="margin-bottom:12px;gap:8px;flex-wrap:wrap">
        <button class="btn sm" onclick="PortalUI.openCreateUnitModal()">➕ واحد عملیاتی</button>
        <button class="btn sm ghost" onclick="loadAccTab('portal-units')">🔄</button>
      </div>
      <div class="tbl-wrap"><table class="tbl"><thead><tr>
        <th>نام واحد</th><th>نوع خروجی</th><th>وضعیت</th><th>عملیات</th>
      </tr></thead><tbody>${units.map(u => `<tr style="${_portalUnitId === u.id ? 'background:var(--purple-light)' : ''}">
        <td>${esc(u.name)}</td>
        <td class="muted">${esc(u.output_type || '-')}</td>
        <td>${esc(u.status || 'active')}</td>
        <td><button class="btn sm ${ _portalUnitId === u.id ? '' : 'ghost'}" onclick="PortalUI.selectUnit(${u.id})">مدیریت</button></td>
      </tr>`).join('') || emptyRow(4)}</tbody></table></div>
      ${detailHtml}`;
  }

  function selectUnit(id) {
    _portalUnitId = id;
    _portalParamId = null;
    loadAccTab('portal-units');
  }

  async function openCreateUnitModal() {
    await ensurePortalCaches();
    const persons = CACHE.persons || [];
    const whs = CACHE.warehouses || [];
    openModal(`
      <div class="modal-head"><h3>➕ واحد عملیاتی جدید</h3><button class="x" onclick="closeModal()">×</button></div>
      <div class="modal-body"><div class="form-grid">
        <div class="fg full"><label>نام واحد *</label><input id="pu-name"></div>
        <div class="fg full"><label>مدیر واحد *</label>
          <select id="pu-mgr"><option value="">—</option>
            ${persons.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}
          </select></div>
        <div class="fg full"><label>انبارهای متصل (چند انتخاب — Ctrl+Click)</label>
          <select id="pu-whs" multiple size="5" style="min-height:100px">
            ${whs.map(w => `<option value="${w.id}">${esc(w.name)}</option>`).join('')}
          </select></div>
      </div></div>
      <div class="modal-foot"><button class="btn" onclick="PortalUI.saveUnit()">💾 ذخیره</button>
        <button class="btn ghost" onclick="closeModal()">انصراف</button></div>`);
  }

  async function saveUnit() {
    const name = el('pu-name').value.trim();
    const manager_person_id = +el('pu-mgr').value;
    const whSel = el('pu-whs');
    const warehouse_ids = whSel ? [...whSel.selectedOptions].map(o => +o.value).filter(Boolean) : [];
    if (!name || !manager_person_id) { showToast('نام و مدیر الزامی است', 'error'); return; }
    try {
      await api('POST', '/portal/units', { name, manager_person_id, warehouse_ids });
      closeModal(); showToast('واحد ایجاد شد'); loadAccTab('portal-units');
    } catch (e) {}
  }

  async function openCreateParamModal(unitId) {
    await ensurePortalCaches();
    const prods = CACHE.allProducts || CACHE.products || [];
    const whs = CACHE.warehouses || [];
    openModal(`
      <div class="modal-head"><h3>➕ پارامتر جدید</h3><button class="x" onclick="closeModal()">×</button></div>
      <div class="modal-body"><div class="form-grid">
        <div class="fg full"><label>نام پارامتر *</label><input id="pp-name"></div>
        <div class="fg full"><label>انبار مبدأ</label>
          <select id="pp-src-wh"><option value="">— پیش‌فرض واحد —</option>
            ${whs.map(w => `<option value="${w.id}">${esc(w.name)}</option>`).join('')}
          </select></div>
        <div class="fg full"><label>اقلام (کالا | مقدار — هر خط)</label>
          <textarea id="pp-items" rows="5" dir="ltr" placeholder="product_id | qty&#10;12 | 100"></textarea></div>
        <div class="fg full"><label>توضیحات</label><textarea id="pp-desc"></textarea></div>
      </div>
      <p class="muted" style="font-size:11px;margin-top:8px">شناسه کالا از ${prods.length} محصول — یا از لیست کالاها ببینید.</p></div>
      <div class="modal-foot"><button class="btn" onclick="PortalUI.saveParameter(${unitId})">💾 ایجاد</button>
        <button class="btn ghost" onclick="closeModal()">انصراف</button></div>`);
  }

  async function saveParameter(unitId) {
    const name = el('pp-name').value.trim();
    const items = (el('pp-items').value || '').split(/\r?\n/).filter(Boolean).map(line => {
      const [pid, qty] = line.split('|').map(x => x.trim());
      return { product_id: +pid, quantity: +qty };
    }).filter(it => it.product_id && it.quantity > 0);
    if (!name || !items.length) { showToast('نام و حداقل یک قلم الزامی است', 'error'); return; }
    const data = {
      name, unit_id: unitId, items,
      description: el('pp-desc').value || '',
      source_warehouse_id: +el('pp-src-wh').value || undefined,
    };
    try {
      await api('POST', '/portal/parameters', data);
      closeModal(); showToast('پارامتر ایجاد شد'); loadAccTab('portal-units');
    } catch (e) {}
  }

  async function showParamDetail(id) {
    _portalParamId = id;
    const p = await api('GET', '/portal/parameters/' + id);
    const box = document.getElementById('portalParamDetail');
    if (!box) return;
    const canFinal = p.status === 'dept_completed' || p.status === 'in_progress';
    box.innerHTML = `
      <div class="panel" style="margin-top:12px;border:1px solid var(--purple)">
        <div class="panel-head"><h4>📋 ${esc(p.num || p.id)} — ${esc(p.name)}</h4>
          ${canFinal ? `<button class="btn sm green" onclick="PortalUI.finalOutput(${p.id})">🏁 ثبت خروجی نهایی</button>` : ''}
        </div>
        <div class="panel-body">
          ${timelineHtml(p.dept_logs)}
          <div class="tbl-wrap" style="margin-top:10px"><table class="tbl" style="font-size:12px"><thead><tr>
            <th>بخش</th><th>وضعیت</th><th>تأیید</th><th>مقدار</th><th>پرداخت</th>
          </tr></thead><tbody>${(p.dept_logs || []).map(l => `<tr>
            <td>${esc(l.department_name)}</td>
            <td>${esc(l.status)}</td>
            <td>${l.confirmed ? '✅' : '—'}</td>
            <td class="mono">${l.received_quantity != null ? fmt(l.received_quantity) : '—'}</td>
            <td class="muted" style="font-size:11px">${esc(l.payment_status || '—')}${l.payment_amount ? ' · '+fmt(l.payment_amount)+' ریال' : ''}</td>
          </tr>`).join('')}</tbody></table></div>
          <div class="tbl-wrap" style="margin-top:8px"><table class="tbl" style="font-size:12px"><thead><tr>
            <th>کالا</th><th>مقدار</th>
          </tr></thead><tbody>${(p.items || []).map(it => `<tr>
            <td>${esc(it.product_name || it.product_id)}</td>
            <td class="mono">${fmt(it.quantity)}</td>
          </tr>`).join('')}</tbody></table></div>
        </div>
      </div>`;
  }

  async function renderPortalMyDeptTab(body) {
    const rows = await api('GET', '/portal/parameters') || [];
    body.innerHTML = `
      <div class="muted" style="font-size:12px;margin-bottom:12px">پارامترهای در صف بخش شما — دکمه‌های عملیات روی بخش فعلی اعمال می‌شوند.</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px">
        ${rows.length ? rows.map(p => `<div class="panel" style="margin:0">
          <div class="panel-head"><h4>${esc(p.num || p.id)}</h4><span class="tag">${esc(p.status)}</span></div>
          <div class="panel-body">
            <div style="font-weight:600;margin-bottom:6px">${esc(p.name)}</div>
            <div class="muted" style="font-size:11px;margin-bottom:10px">بخش جاری: #${fmt(p.current_department_id || '-')}</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">
              <button class="btn sm" onclick="PortalUI.deptConfirm(${p.id},${p.current_department_id || 0})">✅ تأیید مقدار</button>
              <button class="btn sm ghost" onclick="PortalUI.deptReview(${p.id},${p.current_department_id || 0})">🔍 بازبینی</button>
              <button class="btn sm" onclick="PortalUI.deptPayment(${p.id},${p.current_department_id || 0})">💳 درخواست پرداخت</button>
              <button class="btn sm orange" onclick="PortalUI.deptApprovePayment(${p.id},${p.current_department_id || 0})">✔ تأیید پرداخت</button>
              <button class="btn sm ghost" onclick="PortalUI.deptConvert(${p.id},${p.current_department_id || 0})">🔄 تبدیل</button>
              <button class="btn sm green" style="grid-column:1/-1" onclick="PortalUI.deptComplete(${p.id},${p.current_department_id || 0})">🏁 اتمام بخش</button>
            </div>
          </div>
        </div>`).join('') : '<div class="empty" style="grid-column:1/-1">پارامتری در صف بخش شما نیست</div>'}
      </div>`;
  }

  async function deptConfirm(paramId, deptId) {
    if (!deptId) { showToast('بخش فعال مشخص نیست', 'error'); return; }
    openModal(`
      <div class="modal-head"><h3>✅ تأیید مقدار دریافتی</h3><button class="x" onclick="closeModal()">×</button></div>
      <div class="modal-body"><div class="form-grid">
        <div class="fg full"><label>مقدار دریافتی *</label><input id="pd-qty" type="number" step="0.001" min="0" value="0"></div>
      </div></div>
      <div class="modal-foot"><button class="btn green" onclick="PortalUI.saveDeptConfirm(${paramId},${deptId})">💾 تأیید</button>
        <button class="btn ghost" onclick="closeModal()">انصراف</button></div>`);
  }
  async function saveDeptConfirm(paramId, deptId) {
    const q = +el('pd-qty')?.value;
    if (q == null || isNaN(q)) { showToast('مقدار نامعتبر', 'error'); return; }
    try {
      await api('POST', `/portal/parameters/${paramId}/dept/${deptId}/confirm`, { received_quantity: q });
      closeModal(); showToast('تأیید شد'); loadAccTab('portal-my-dept');
    } catch (e) {}
  }

  async function deptReview(paramId, deptId) {
    if (!deptId) return;
    if (!confirm('درخواست بازبینی ثبت شود؟')) return;
    try {
      await api('POST', `/portal/parameters/${paramId}/dept/${deptId}/request-review`, {});
      showToast('بازبینی درخواست شد'); loadAccTab('portal-my-dept');
    } catch (e) {}
  }

  async function deptPayment(paramId, deptId) {
    if (!deptId) return;
    if (!CACHE.persons?.length) {
      try { CACHE.persons = await api('GET', '/persons') || []; } catch (_) { CACHE.persons = []; }
    }
    openModal(`
      <div class="modal-head"><h3>💳 درخواست پرداخت</h3><button class="x" onclick="closeModal()">×</button></div>
      <div class="modal-body"><div class="form-grid">
        <div class="fg full"><label>شخص *</label><select id="pd-person"><option value="">— انتخاب —</option>
          ${(CACHE.persons || []).map(p => `<option value="${p.id}">${esc(p.name || '')}${p.phone ? ' — ' + esc(p.phone) : ''}</option>`).join('')}
        </select></div>
        <div class="fg"><label>مبلغ (ریال) *</label><input id="pd-amt" type="text" inputmode="numeric" class="money" value="0"></div>
        <div class="fg"><label>وضعیت</label><select id="pd-status">
          <option value="awaiting_accounting">در انتظار تأیید حسابداری</option>
          <option value="awaiting_payment">در انتظار پرداخت</option>
        </select></div>
        <div class="fg full"><label>یادداشت</label><input id="pd-note"></div>
      </div></div>
      <div class="modal-foot"><button class="btn" onclick="PortalUI.saveDeptPayment(${paramId},${deptId})">📤 ارسال</button>
        <button class="btn ghost" onclick="closeModal()">انصراف</button></div>`);
  }
  async function saveDeptPayment(paramId, deptId) {
    const person_id = +el('pd-person')?.value;
    const amount_rial = typeof moneyVal === 'function' ? moneyVal('pd-amt') : Math.round(+el('pd-amt')?.value || 0);
    if (!person_id || !amount_rial) { showToast('شخص و مبلغ الزامی است', 'error'); return; }
    try {
      await api('POST', `/portal/parameters/${paramId}/dept/${deptId}/payment`, {
        person_id, amount_rial, payment_status: el('pd-status')?.value || 'awaiting_accounting',
        note: el('pd-note')?.value || '',
      });
      closeModal(); showToast('درخواست پرداخت برای حسابداری ارسال شد'); loadAccTab('portal-my-dept');
    } catch (e) {}
  }

  async function deptApprovePayment(paramId, deptId) {
    if (!deptId) return;
    if (!confirm('تأیید پرداخت و ثبت سند حسابداری؟')) return;
    try {
      await api('POST', `/portal/parameters/${paramId}/dept/${deptId}/approve-payment`, {});
      showToast('پرداخت تأیید و سند ثبت شد'); loadAccTab('portal-my-dept');
    } catch (e) {}
  }

  async function finalOutput(paramId) {
    if (!CACHE.warehouses) {
      try { CACHE.warehouses = await api('GET', '/warehouses') || []; } catch (_) { CACHE.warehouses = []; }
    }
    openModal(`
      <div class="modal-head"><h3>🏁 ثبت خروجی نهایی</h3><button class="x" onclick="closeModal()">×</button></div>
      <div class="modal-body"><div class="form-grid">
        <div class="fg"><label>تعداد نهایی *</label><input id="fo-qty" type="number" step="0.001" min="0.001" value="1"></div>
        <div class="fg"><label>انبار مقصد *</label><select id="fo-wh"><option value="">— انتخاب —</option>
          ${(CACHE.warehouses || []).filter(w => w.active !== 0).map(w => `<option value="${w.id}">${esc(w.name)}</option>`).join('')}
        </select></div>
        <div class="fg full"><label>هزینه‌های اضافه</label>
          <div id="fo-costs"></div>
          <button type="button" class="btn sm ghost" onclick="PortalUI.addFinalCostRow()">➕ هزینه بعدی</button>
        </div>
      </div></div>
      <div class="modal-foot"><button class="btn green" onclick="PortalUI.saveFinalOutput(${paramId})">💾 ثبت نهایی</button>
        <button class="btn ghost" onclick="closeModal()">انصراف</button></div>`);
    _foCosts = [{ description: '', amount_rial: '' }];
    renderFinalCostRows();
  }
  let _foCosts = [];
  function addFinalCostRow() { _foCosts.push({ description: '', amount_rial: '' }); renderFinalCostRows(); }
  function renderFinalCostRows() {
    const box = el('fo-costs'); if (!box) return;
    window._foCosts = _foCosts;
    box.innerHTML = _foCosts.map((c, i) => `
      <div style="display:flex;gap:8px;margin-bottom:6px;align-items:center">
        <input placeholder="شرح" value="${esc(c.description || '')}" oninput="window._foCosts[${i}].description=this.value" style="flex:1">
        <input placeholder="مبلغ ریال" type="text" inputmode="numeric" class="money" value="${esc(String(c.amount_rial || ''))}" oninput="window._foCosts[${i}].amount_rial=this.value" style="width:140px">
        ${_foCosts.length > 1 ? `<button type="button" class="btn sm red" onclick="window._foCosts.splice(${i},1);PortalUI.renderFinalCostRows()">×</button>` : ''}
      </div>`).join('');
  }
  async function saveFinalOutput(paramId) {
    _foCosts = window._foCosts || _foCosts;
    const quantity = +el('fo-qty')?.value;
    const destination_warehouse_id = +el('fo-wh')?.value;
    if (!quantity || !destination_warehouse_id) { showToast('تعداد و انبار مقصد الزامی است', 'error'); return; }
    const extra = (_foCosts || []).map(c => ({
      description: String(c.description || '').trim(),
      amount_rial: Math.round(parseInt(String(c.amount_rial || '').replace(/[^\d]/g, ''), 10) || 0),
    })).filter(c => c.description && c.amount_rial > 0);
    try {
      await api('POST', `/portal/parameters/${paramId}/final-output`, {
        quantity, destination_warehouse_id, extra_costs: extra,
      });
      closeModal(); showToast('خروجی نهایی ثبت شد'); loadAccTab('portal-units');
    } catch (e) {}
  }

  async function addDeptCapability(deptId) {
    openModal(`
      <div class="modal-head"><h3>➕ امکان / خدمت دپارتمان</h3><button class="x" onclick="closeModal()">×</button></div>
      <div class="modal-body"><div class="form-grid">
        <div class="fg full"><label>نام *</label><input id="cap-name"></div>
        <div class="fg full"><label>توضیحات</label><textarea id="cap-desc"></textarea></div>
      </div></div>
      <div class="modal-foot"><button class="btn" onclick="PortalUI.saveDeptCapability(${deptId})">💾 ذخیره</button>
        <button class="btn ghost" onclick="closeModal()">انصراف</button></div>`);
  }
  async function saveDeptCapability(deptId) {
    const name = el('cap-name')?.value?.trim();
    if (!name) { showToast('نام الزامی است', 'error'); return; }
    try {
      await api('POST', `/portal/departments/${deptId}/capabilities`, { name, description: el('cap-desc')?.value || '' });
      closeModal(); showToast('امکان ثبت شد');
    } catch (e) {}
  }
  async function addDeptTask(deptId) {
    openModal(`
      <div class="modal-head"><h3>➕ شرح وظیفه دپارتمان</h3><button class="x" onclick="closeModal()">×</button></div>
      <div class="modal-body"><div class="form-grid">
        <div class="fg full"><label>نام *</label><input id="task-name"></div>
        <div class="fg full"><label>توضیحات</label><textarea id="task-desc"></textarea></div>
      </div></div>
      <div class="modal-foot"><button class="btn" onclick="PortalUI.saveDeptTask(${deptId})">💾 ذخیره</button>
        <button class="btn ghost" onclick="closeModal()">انصراف</button></div>`);
  }
  async function saveDeptTask(deptId) {
    const name = el('task-name')?.value?.trim();
    if (!name) { showToast('نام الزامی است', 'error'); return; }
    try {
      await api('POST', `/portal/departments/${deptId}/tasks`, { name, description: el('task-desc')?.value || '' });
      closeModal(); showToast('وظیفه ثبت شد');
    } catch (e) {}
  }

  async function deptConvert(paramId, deptId) {
    if (!deptId) return;
    if (!CACHE.products?.length && typeof ensureProductsCache === 'function') {
      try { await ensureProductsCache(); } catch (_) {}
    }
    if (!CACHE.products?.length) {
      try { CACHE.products = await api('GET', '/products') || []; } catch (_) { CACHE.products = []; }
    }
    const list = (CACHE.products || CACHE.allProducts || []).slice(0, 500);
    openModal(`
      <div class="modal-head"><h3>🔄 تبدیل کالا</h3><button class="x" onclick="closeModal()">×</button></div>
      <div class="modal-body"><div class="form-grid">
        <div class="fg full"><label>کالای خروجی *</label><select id="cv-prod"><option value="">— انتخاب —</option>
          ${list.map(p => `<option value="${p.id}">${esc(p.name)}${p.code ? ' (' + esc(p.code) + ')' : ''}</option>`).join('')}
        </select></div>
        <div class="fg"><label>مقدار *</label><input id="cv-qty" type="number" step="0.001" min="0.001" value="1"></div>
      </div></div>
      <div class="modal-foot"><button class="btn" onclick="PortalUI.saveDeptConvert(${paramId},${deptId})">💾 ثبت تبدیل</button>
        <button class="btn ghost" onclick="closeModal()">انصراف</button></div>`);
  }
  async function saveDeptConvert(paramId, deptId) {
    const product_id = +el('cv-prod')?.value;
    const quantity = +el('cv-qty')?.value;
    if (!product_id || !quantity) { showToast('کالا و مقدار الزامی است', 'error'); return; }
    try {
      await api('POST', `/portal/parameters/${paramId}/dept/${deptId}/convert`, { product_id, quantity });
      closeModal(); showToast('تبدیل انجام شد'); loadAccTab('portal-my-dept');
    } catch (e) {}
  }

  async function deptComplete(paramId, deptId) {
    if (!deptId) return;
    if (!confirm('اتمام این بخش و انتقال به بخش بعد؟')) return;
    try {
      await api('POST', `/portal/parameters/${paramId}/dept/${deptId}/complete`, {});
      showToast('بخش تکمیل شد'); loadAccTab('portal-my-dept');
    } catch (e) {}
  }

  async function renderBankReconTab(body) {
    if (!CACHE.banks) CACHE.banks = await api('GET', '/banks') || [];
    const rows = await api('GET', '/bank-reconciliation') || [];
    let detail = '';
    if (_bankReconId) {
      const r = await api('GET', '/bank-reconciliation/' + _bankReconId) || {};
      const diff = (r.statement_balance_rial || 0) - (r.book_balance_rial || 0);
      detail = `
        <div class="panel" style="margin-top:12px">
          <div class="panel-head"><h4>تطبیق #${fmt(r.id)} — ${esc(r.bank_name)}</h4>
            ${r.status !== 'closed' ? `<button class="btn sm green" onclick="PortalUI.closeBankRecon(${r.id})">🔒 بستن تطبیق</button>` : ''}
          </div>
          <div class="panel-body">
            <div class="cards" style="margin-bottom:12px">
              ${statCard('b', '📒', fmt(r.book_balance_rial || 0), 'مانده دفتر (ریال)')}
              ${statCard('o', '🏦', fmt(r.statement_balance_rial || 0), 'مانده صورت‌حساب (ریال)')}
              ${statCard('r', 'Δ', fmt(diff), 'اختلاف (ریال)')}
            </div>
            <div class="tbl-wrap"><table class="tbl" style="font-size:12px"><thead><tr>
              <th>طرف</th><th>شرح</th><th>مبلغ (ریال)</th><th>تطبیق</th>
            </tr></thead><tbody>${(r.items || []).map(it => `<tr>
              <td>${it.side === 'bank' ? 'بانک' : 'دفتر'}</td>
              <td>${esc(it.description || '-')}</td>
              <td class="mono">${fmt(it.amount_rial || 0)}</td>
              <td>${it.matched ? '✅' : '—'}</td>
            </tr>`).join('') || emptyRow(4)}</tbody></table></div>
          </div>
        </div>`;
    }
    body.innerHTML = `
      <div class="toolbar" style="margin-bottom:12px;gap:8px">
        <button class="btn sm" onclick="PortalUI.openBankReconModal()">➕ تطبیق جدید</button>
      </div>
      <div class="tbl-wrap"><table class="tbl"><thead><tr>
        <th>#</th><th>بانک</th><th>تاریخ صورت‌حساب</th><th>مانده بانک</th><th>مانده دفتر</th><th>وضعیت</th><th></th>
      </tr></thead><tbody>${rows.map(r => `<tr>
        <td class="mono">${fmt(r.id)}</td>
        <td>${esc(r.bank_name)}</td>
        <td class="mono">${escDate(r.statement_date)}</td>
        <td class="mono">${fmt(r.statement_balance_rial || 0)}</td>
        <td class="mono">${fmt(r.book_balance_rial || 0)}</td>
        <td><span class="tag ${r.status === 'closed' ? 't-done' : ''}">${esc(r.status)}</span></td>
        <td><button class="btn sm ghost" onclick="PortalUI.showBankRecon(${r.id})">مشاهده</button></td>
      </tr>`).join('') || emptyRow(7)}</tbody></table></div>${detail}`;
    if (typeof fitStatNums === 'function') fitStatNums();
  }

  function showBankRecon(id) { _bankReconId = id; loadAccTab('bank-recon'); }

  async function openBankReconModal() {
    if (!CACHE.banks) CACHE.banks = await api('GET', '/banks') || [];
    openModal(`
      <div class="modal-head"><h3>➕ تطبیق بانک</h3><button class="x" onclick="closeModal()">×</button></div>
      <div class="modal-body"><div class="form-grid">
        <div class="fg full"><label>بانک *</label><select id="br-bank"><option value="">—</option>
          ${(CACHE.banks || []).filter(b => b.active !== 0).map(b => `<option value="${b.id}">${esc(b.name)}</option>`).join('')}
        </select></div>
        <div class="fg"><label>تاریخ صورت‌حساب *</label><input id="br-date" data-jdate value="${todayJalali()}"></div>
        <div class="fg"><label>مانده صورت‌حساب (ریال) *</label><input id="br-bal" class="money" inputmode="numeric"></div>
        <div class="fg full"><label>یادداشت</label><textarea id="br-note"></textarea></div>
      </div></div>
      <div class="modal-foot"><button class="btn" onclick="PortalUI.saveBankRecon()">💾 ثبت</button>
        <button class="btn ghost" onclick="closeModal()">انصراف</button></div>`);
    if (typeof initJalaliPickers === 'function') initJalaliPickers();
  }

  async function saveBankRecon() {
    const bank_id = +el('br-bank').value;
    const statement_date = el('br-date').value;
    const statement_balance_rial = Math.round(moneyVal('br-bal'));
    if (!bank_id || !statement_date) { showToast('بانک و تاریخ الزامی است', 'error'); return; }
    try {
      const r = await api('POST', '/bank-reconciliation', {
        bank_id, statement_date, statement_balance_rial, notes: el('br-note').value || '',
      });
      closeModal(); showToast('تطبیق ثبت شد');
      _bankReconId = r.id; loadAccTab('bank-recon');
    } catch (e) {}
  }

  async function closeBankRecon(id) {
    if (!confirm('تطبیق بسته شود؟ در صورت اختلاف، سند تعدیل خودکار ثبت می‌شود.')) return;
    try {
      await api('POST', '/bank-reconciliation/' + id + '/close', {});
      showToast('تطبیق بسته شد'); loadAccTab('bank-recon');
    } catch (e) {}
  }

  async function renderBudgetingTab(body) {
    const rows = await api('GET', '/budgeting') || [];
    let varHtml = '';
    if (_budgetId) {
      const v = await api('GET', '/budgeting/' + _budgetId + '/variance') || {};
      varHtml = `
        <div class="panel" style="margin-top:12px">
          <div class="panel-head"><h4>📊 انحراف بودجه #${fmt(_budgetId)} (${esc(v.year_label || '')})</h4></div>
          <div class="panel-body tbl-wrap"><table class="tbl" style="font-size:12px"><thead><tr>
            <th>حساب</th><th>ماه</th><th>بودجه</th><th>واقعی</th><th>انحراف</th>
          </tr></thead><tbody>${(v.rows || []).slice(0, 100).map(r => `<tr>
            <td class="mono">${esc(r.account_code)}</td>
            <td class="mono">${fmt(r.month)}</td>
            <td class="mono">${fmt(r.budget_rial)}</td>
            <td class="mono">${fmt(r.actual_rial)}</td>
            <td class="mono" style="color:${(r.variance_rial || 0) >= 0 ? 'var(--green)' : 'var(--red)'}">${fmt(r.variance_rial)}</td>
          </tr>`).join('') || emptyRow(5)}</tbody>
          ${v.totals ? `<tfoot><tr style="font-weight:700;border-top:2px solid var(--border)">
            <td colspan="2">جمع</td>
            <td class="mono">${fmt(v.totals.budget_rial)}</td>
            <td class="mono">${fmt(v.totals.actual_rial)}</td>
            <td class="mono">${fmt(v.totals.variance_rial)}</td>
          </tr></tfoot>` : ''}</table></div>
        </div>`;
    }
    body.innerHTML = `
      <div class="toolbar" style="margin-bottom:12px"><button class="btn sm" onclick="PortalUI.openBudgetModal()">➕ بودجه جدید</button></div>
      <div class="tbl-wrap"><table class="tbl"><thead><tr>
        <th>نام</th><th>سال</th><th>وضعیت</th><th>ردیف‌ها</th><th></th>
      </tr></thead><tbody>${rows.map(b => `<tr>
        <td>${esc(b.name)}</td>
        <td>${esc(b.year_label || '-')}</td>
        <td>${esc(b.status)}</td>
        <td class="mono">${fmt(b.line_count || 0)}</td>
        <td><button class="btn sm ghost" onclick="PortalUI.showBudgetVariance(${b.id})">انحراف</button></td>
      </tr>`).join('') || emptyRow(5)}</tbody></table></div>${varHtml}`;
  }

  function showBudgetVariance(id) { _budgetId = id; loadAccTab('budgeting'); }

  async function openBudgetModal() {
    openModal(`
      <div class="modal-head"><h3>➕ بودجه</h3><button class="x" onclick="closeModal()">×</button></div>
      <div class="modal-body"><div class="form-grid">
        <div class="fg full"><label>نام *</label><input id="bg-name"></div>
        <div class="fg"><label>برچسب سال (مثلاً 1404/01)</label><input id="bg-year" value="${todayJalali().slice(0, 4)}"></div>
        <div class="fg full"><label>یادداشت</label><textarea id="bg-note"></textarea></div>
      </div></div>
      <div class="modal-foot"><button class="btn" onclick="PortalUI.saveBudget()">💾 ذخیره</button>
        <button class="btn ghost" onclick="closeModal()">انصراف</button></div>`);
  }

  async function saveBudget() {
    const name = el('bg-name').value.trim();
    if (!name) { showToast('نام بودجه الزامی است', 'error'); return; }
    try {
      await api('POST', '/budgeting', {
        name, year_label: el('bg-year').value || '', notes: el('bg-note').value || '', status: 'draft',
      });
      closeModal(); showToast('بودجه ایجاد شد'); loadAccTab('budgeting');
    } catch (e) {}
  }

  async function renderReservesTab(body) {
    const stale = await api('GET', '/reserves/stale-products?months=6') || {};
    body.innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px">
        <div class="panel"><div class="panel-head"><h4>⚖️ اندوخته قانونی</h4></div>
          <div class="panel-body"><div class="form-grid">
            <div class="fg"><label>سود قابل تخصیص (ریال)</label><input id="lr-profit" class="money" inputmode="numeric"></div>
            <div class="fg"><label>سرمایه (ریال — اختیاری)</label><input id="lr-capital" class="money" inputmode="numeric"></div>
            <div class="fg"><label>تاریخ</label><input id="lr-date" data-jdate value="${todayJalali()}"></div>
          </div>
          <button class="btn sm" style="margin-top:10px" onclick="PortalUI.postLegalReserve()">ثبت اندوخته</button>
          </div></div>
        <div class="panel"><div class="panel-head"><h4>📉 ذخیره مطالبات مشکوک‌الوصول</h4></div>
          <div class="panel-body"><div class="form-grid">
            <div class="fg"><label>تاریخ</label><input id="dp-date" data-jdate value="${todayJalali()}"></div>
            <div class="fg"><label>درصد (bp — خالی=روش سنی)</label><input id="dp-bp" type="number" placeholder="مثلاً 500 = 5%"></div>
          </div>
          <button class="btn sm" style="margin-top:10px" onclick="PortalUI.postDoubtful()">محاسبه و ثبت</button>
          </div></div>
      </div>
      <div class="panel" style="margin-bottom:16px"><div class="panel-head"><h4>📦 ذخیره کاهش ارزش موجودی (NRV)</h4></div>
        <div class="panel-body">
          <label class="muted" style="font-size:12px">هر خط: product_id | qty | cost_rial | nrv_rial</label>
          <textarea id="nrv-lines" rows="4" dir="ltr" style="width:100%;margin:8px 0" placeholder="5 | 10 | 1000000 | 800000"></textarea>
          <button class="btn sm" onclick="PortalUI.postInventoryNrv()">ثبت NRV</button>
        </div></div>
      <div class="panel"><div class="panel-head"><h4>🕐 کالاهای راکد (${fmt(stale.count || 0)} مورد — ${stale.months || 6} ماه)</h4></div>
        <div class="panel-body tbl-wrap"><table class="tbl" style="font-size:12px"><thead><tr>
          <th>کد</th><th>نام</th><th>موجودی</th>
        </tr></thead><tbody>${(stale.rows || []).slice(0, 50).map(p => `<tr>
          <td class="mono">${esc(p.code || p.id)}</td>
          <td>${esc(p.name)}</td>
          <td class="mono">${fmt(p.stock)}</td>
        </tr>`).join('') || emptyRow(3)}</tbody></table></div>
      </div>`;
    if (typeof initJalaliPickers === 'function') initJalaliPickers(body);
  }

  async function postLegalReserve() {
    try {
      const r = await api('POST', '/reserves/legal-reserve', {
        profit_rial: Math.round(moneyVal('lr-profit')),
        capital_rial: moneyVal('lr-capital') ? Math.round(moneyVal('lr-capital')) : undefined,
        date: el('lr-date').value,
      });
      showToast('اندوخته: ' + fmt(r.reserve_rial || 0) + ' ریال');
    } catch (e) {}
  }

  async function postDoubtful() {
    const bp = el('dp-bp').value;
    try {
      const r = await api('POST', '/reserves/doubtful', {
        as_of_date: el('dp-date').value,
        percent_bp: bp ? +bp : undefined,
      });
      showToast('ذخیره: ' + fmt(r.total_rial || 0) + ' ریال');
    } catch (e) {}
  }

  async function postInventoryNrv() {
    const lines = (el('nrv-lines').value || '').split(/\r?\n/).filter(Boolean).map(line => {
      const [product_id, qty, cost_rial, nrv_rial] = line.split('|').map(x => x.trim());
      return { product_id: +product_id, qty: +qty, cost_rial: +cost_rial, nrv_rial: +nrv_rial };
    }).filter(l => l.product_id);
    if (!lines.length) { showToast('حداقل یک ردیف الزامی است', 'error'); return; }
    try {
      const r = await api('POST', '/reserves/inventory-nrv', { lines, as_of_date: todayJalali() });
      showToast('NRV: ' + fmt(r.total_rial || 0) + ' ریال');
    } catch (e) {}
  }

  function quarterBar(prefix) {
    const y = todayJalali().slice(0, 4);
    return `<div class="toolbar" style="margin-bottom:12px;gap:8px;flex-wrap:wrap">
      <label class="muted" style="font-size:12px">فصل:
        <input id="${prefix}-q" value="${y}-Q1" dir="ltr" style="width:100px;padding:6px 8px;border-radius:6px;border:1px solid var(--border)">
      </label>
      <button class="btn sm ghost" onclick="PortalUI.reloadReport('${prefix}')">🔍</button>
    </div>`;
  }

  async function renderVatReturnTab(body) {
    body.innerHTML = quarterBar('vat') + '<div id="vatReportBox"><div class="muted">در حال بارگذاری...</div></div>';
    await reloadReport('vat');
  }

  async function renderSeasonal169Tab(body) {
    body.innerHTML = quarterBar('s169') + '<div id="s169ReportBox"><div class="muted">در حال بارگذاری...</div></div>';
    await reloadReport('s169');
  }

  async function renderCashFlowStdTab(body) {
    const qp = [];
    if (accDateFrom) qp.push('from=' + encodeURIComponent(accDateFrom));
    if (accDateTo) qp.push('to=' + encodeURIComponent(accDateTo));
    const d = await api('GET', '/adv-reports/cash-flow' + (qp.length ? '?' + qp.join('&') : '')) || {};
    const sec = (name, s) => `
      <div class="panel"><div class="panel-head"><h4>${name}</h4></div><div class="panel-body">
        <div style="display:flex;gap:12px;margin-bottom:8px;font-size:13px">
          <span>ورودی: <b class="mono">${fmt(s.inflow_rial || 0)}</b></span>
          <span>خروجی: <b class="mono">${fmt(s.outflow_rial || 0)}</b></span>
          <span>خالص: <b class="mono" style="color:${(s.net_rial || 0) >= 0 ? 'var(--green)' : 'var(--red)'}">${fmt(s.net_rial || 0)}</b></span>
        </div>
      </div></div>`;
    body.innerHTML = `
      <div class="muted" style="font-size:12px;margin-bottom:10px">بازه: ${esc(d.from || '—')} تا ${esc(d.to || '—')} — فیلتر تاریخ از نوار بالا</div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:12px">
        ${sec('عملیاتی', d.sections?.operating || {})}
        ${sec('سرمایه‌گذاری', d.sections?.investing || {})}
        ${sec('تأمین مالی', d.sections?.financing || {})}
      </div>
      <div class="panel"><div class="panel-body" style="font-weight:700;text-align:center">
        خالص جریان وجوه نقد: <span class="mono">${fmt(d.total_net_rial || 0)}</span> ریال
      </div></div>`;
  }

  async function renderKpiDashboardTab(body) {
    const d = await api('GET', '/adv-reports/kpi-dashboard') || {};
    body.innerHTML = `
      <div class="cards" style="margin-bottom:16px">
        ${statCard('b', '📅', fmt(d.dso_days || 0), 'DSO (روز)')}
        ${statCard('o', '📦', fmt(d.dio_days || 0), 'DIO (روز)')}
        ${statCard('g', '💳', fmt(d.dpo_days || 0), 'DPO (روز)')}
        ${statCard('r', '🔄', fmt(d.cash_cycle_days || 0), 'چرخه نقد (روز)')}
      </div>
      <div class="panel"><div class="panel-head"><h4>تمرکز فروش — ۳ مشتری برتر: ${fmt(d.top3_concentration_pct || 0)}٪</h4></div>
        <div class="panel-body tbl-wrap"><table class="tbl"><thead><tr>
          <th>مشتری</th><th>فروش (ریال)</th><th>سهم٪</th>
        </tr></thead><tbody>${(d.top_customers || []).map(c => `<tr>
          <td>${esc(c.biz || c.name)}</td>
          <td class="mono">${fmt(c.revenue_rial || 0)}</td>
          <td class="mono">${fmt(c.concentration_pct || 0)}٪</td>
        </tr>`).join('') || emptyRow(3)}</tbody></table></div>
      </div>`;
    if (typeof fitStatNums === 'function') fitStatNums();
  }

  async function reloadReport(kind) {
    const q = el(kind === 'vat' ? 'vat-q' : 's169-q')?.value || (todayJalali().slice(0, 4) + '-Q1');
    const boxId = kind === 'vat' ? 'vatReportBox' : 's169ReportBox';
    const box = document.getElementById(boxId);
    if (!box) return;
    try {
      if (kind === 'vat') {
        const d = await api('GET', '/adv-reports/vat-return?quarter=' + encodeURIComponent(q)) || {};
        box.innerHTML = `
          <div class="cards" style="margin-bottom:12px">
            ${statCard('r', '📤', fmt(d.output_vat_rial || 0), 'مالیات فروش (ریال)')}
            ${statCard('b', '📥', fmt(d.input_vat_rial || 0), 'مالیات خرید (ریال)')}
            ${statCard('o', '💰', fmt(d.net_payable_rial || 0), 'خالص قابل پرداخت (ریال)')}
          </div>
          <div class="muted" style="font-size:12px">بازه ${esc(d.from)} — ${esc(d.to)} ${d.quarter ? '(' + esc(d.quarter) + ')' : ''}</div>`;
      } else {
        const d = await api('GET', '/adv-reports/seasonal-169?quarter=' + encodeURIComponent(q)) || {};
        box.innerHTML = `
          <div class="cards" style="margin-bottom:12px">
            ${statCard('g', '🛒', fmt(d.totals?.sales_rial || 0), 'فروش فصلی (' + fmt(d.totals?.sales_count || 0) + ' فاکتور)')}
            ${statCard('b', '📦', fmt(d.totals?.purchase_rial || 0), 'خرید فصلی (' + fmt(d.totals?.purchase_count || 0) + ' فاکتور)')}
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
            <div class="panel"><div class="panel-head"><h4>فروش</h4></div><div class="panel-body tbl-wrap"><table class="tbl" style="font-size:11px"><thead><tr>
              <th>شماره</th><th>تاریخ</th><th>طرف</th><th>مبلغ</th>
            </tr></thead><tbody>${(d.sales || []).slice(0, 30).map(r => `<tr>
              <td class="mono">${esc(r.num)}</td><td>${escDate(r.date)}</td><td>${esc(r.party_name)}</td><td class="mono">${fmt(r.amount_rial)}</td>
            </tr>`).join('') || emptyRow(4)}</tbody></table></div></div>
            <div class="panel"><div class="panel-head"><h4>خرید</h4></div><div class="panel-body tbl-wrap"><table class="tbl" style="font-size:11px"><thead><tr>
              <th>شماره</th><th>تاریخ</th><th>طرف</th><th>مبلغ</th>
            </tr></thead><tbody>${(d.purchases || []).slice(0, 30).map(r => `<tr>
              <td class="mono">${esc(r.num)}</td><td>${escDate(r.date)}</td><td>${esc(r.party_name)}</td><td class="mono">${fmt(r.amount_rial)}</td>
            </tr>`).join('') || emptyRow(4)}</tbody></table></div></div>
          </div>`;
      }
      if (typeof fitStatNums === 'function') fitStatNums();
    } catch (e) {
      box.innerHTML = `<div class="empty">${esc(e.message || 'خطا')}</div>`;
    }
  }

  const PortalUI = {
    renderPortalUnitsTab,
    renderPortalMyDeptTab,
    renderBankReconTab,
    renderBudgetingTab,
    renderReservesTab,
    renderVatReturnTab,
    renderSeasonal169Tab,
    renderCashFlowStdTab,
    renderKpiDashboardTab,
    selectUnit,
    openCreateUnitModal,
    saveUnit,
    openCreateParamModal,
    saveParameter,
    showParamDetail,
    deptConfirm,
    saveDeptConfirm,
    deptReview,
    deptPayment,
    saveDeptPayment,
    deptApprovePayment,
    deptConvert,
    saveDeptConvert,
    deptComplete,
    finalOutput,
    addFinalCostRow,
    renderFinalCostRows,
    saveFinalOutput,
    addDeptCapability,
    saveDeptCapability,
    addDeptTask,
    saveDeptTask,
    showBankRecon,
    openBankReconModal,
    saveBankRecon,
    closeBankRecon,
    showBudgetVariance,
    openBudgetModal,
    saveBudget,
    postLegalReserve,
    postDoubtful,
    postInventoryNrv,
    reloadReport,
  };

  global.PortalUI = PortalUI;
  global.renderPortalUnitsTab = renderPortalUnitsTab;
  global.renderPortalMyDeptTab = renderPortalMyDeptTab;
  global.renderBankReconTab = renderBankReconTab;
  global.renderBudgetingTab = renderBudgetingTab;
  global.renderReservesTab = renderReservesTab;
  global.renderVatReturnTab = renderVatReturnTab;
  global.renderSeasonal169Tab = renderSeasonal169Tab;
  global.renderCashFlowStdTab = renderCashFlowStdTab;
  global.renderKpiDashboardTab = renderKpiDashboardTab;

}(typeof globalThis !== 'undefined' ? globalThis : window));
