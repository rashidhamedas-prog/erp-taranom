/**
 * portal-ui.js — پورتال عملیاتی + گزارشات/تطبیق/بودجه/ذخایر (Accounting Gap UI)
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
    return `<div data-csp-style="${CSP.style(`display:flex;gap:3px;align-items:center`)}">${logs.map(l =>
      `<div title="${esc(l.department_name || '')} (${esc(l.status || '')})" data-csp-style="${CSP.style(`flex:1;min-width:12px;height:10px;border-radius:3px;background:${deptColor(l.status)}`)}"></div>`
    ).join('')}</div>`;
  }

  async function ensurePortalCaches() {
    if (typeof ensureWarehouses === 'function') await ensureWarehouses();
    else if (!CACHE.warehouses?.length) CACHE.warehouses = await api('GET', '/warehouses') || [];
    if (!CACHE.persons?.length) CACHE.persons = await api('GET', '/persons') || [];
    if (!CACHE.allProducts?.length && !CACHE.products?.length) {
      CACHE.allProducts = await api('GET', '/products') || [];
    }
  }

  const PARAM_STATUS_FA = {
    pending: 'در انتظار',
    in_progress: 'در جریان',
    under_review: 'بازبینی',
    awaiting_payment: 'در انتظار پرداخت',
    payment_pending_approval: 'پرداخت در انتظار تأیید',
    dept_completed: 'بخش تکمیل',
    completed: 'تکمیل‌شده',
    cancelled: 'لغو',
  };
  function paramStatusLabel(st) { return PARAM_STATUS_FA[st] || st || '—'; }

  function personOptionsHtml(selectedId) {
    return (CACHE.persons || []).map(p =>
      `<option value="${p.id}" ${String(selectedId) === String(p.id) ? 'selected' : ''}>${esc(p.name || '')}${p.phone ? ' — ' + esc(p.phone) : ''}</option>`
    ).join('');
  }

  function portalModuleOptions() {
    const secs = (typeof ACC_NAV_SECTIONS !== 'undefined' && ACC_NAV_SECTIONS) ? ACC_NAV_SECTIONS : [];
    const out = [];
    secs.forEach(s => (s.items || []).forEach(it => {
      if (it.id === 'exit-acc-shell') return;
      out.push({ key: it.id, label: (s.title ? s.title + ' / ' : '') + (it.label || it.id) });
    }));
    [['customers', 'CRM / مشتریان'], ['followups', 'CRM / پیگیری‌ها'], ['products', 'کالاها'], ['invoices', 'فاکتورها']].forEach(([key, label]) => {
      if (!out.find(o => o.key === key)) out.push({ key, label });
    });
    return out;
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
      const mgrNames = [u.manager_person_id, u.manager2_person_id, u.manager3_person_id]
        .filter(Boolean)
        .map(id => (CACHE.persons || []).find(p => p.id === id)?.name || ('#' + id))
        .join('، ');
      detailHtml = `
        <div class="panel" data-csp-style="${CSP.style(`margin-top:12px`)}">
          <div class="panel-head"><h4>🏢 ${esc(u.name)} — بخش‌ها و پارامترها</h4>
            <div data-csp-style="${CSP.style(`display:flex;gap:6px;flex-wrap:wrap`)}">
              <button class="btn sm ghost" data-csp-click="${CSP.bind('click',function(event){PortalUI.openEditUnitModal((u.id))})}">✏️ ویرایش واحد</button>
              <button class="btn sm red" data-csp-click="${CSP.bind('click',function(event){PortalUI.deleteUnit((u.id),(u.name || ""))})}">🗑️ حذف واحد</button>
              <button class="btn sm" data-csp-click="${CSP.bind('click',function(event){PortalUI.openCreateDeptModal((u.id))})}">➕ دپارتمان</button>
              <button class="btn sm ghost" data-csp-click="${CSP.bind('click',function(event){PortalUI.openCreateParamModal((u.id))})}">➕ پارامتر جدید</button>
            </div>
          </div>
          <div class="panel-body">
            <div class="muted" data-csp-style="${CSP.style(`font-size:12px;margin-bottom:10px;line-height:1.7`)}">
              <b>مدیران:</b> ${esc(mgrNames || '—')}
              &nbsp;|&nbsp; <b>نوع خروجی:</b> ${esc(u.output_type || '—')}
              &nbsp;|&nbsp; <b>انبارها:</b> ${(u.warehouses || []).map(w => esc(w.name)).join('، ') || '—'}
              &nbsp;|&nbsp; <b>اشخاص در جریان:</b> ${(u.persons || []).map(p => esc(p.name)).join('، ') || '—'}
              &nbsp;|&nbsp; <b>اتصالات:</b> ${(u.module_links || []).map(m => esc(m.module_key)).join('، ') || '—'}
            </div>
            <h5 data-csp-style="${CSP.style(`margin:0 0 8px;font-size:13px`)}">بخش‌های عملیاتی (مرحله‌بندی مسیر)</h5>
            <div class="tbl-wrap" data-csp-style="${CSP.style(`margin-bottom:14px`)}"><table class="tbl" data-csp-style="${CSP.style(`font-size:12px`)}"><thead><tr>
              <th>ترتیب</th><th>نام</th><th>مدیر</th><th>انبار</th><th>عملیات</th>
            </tr></thead><tbody>${(u.departments || []).map((d, i, arr) => `<tr>
              <td class="mono">${fmt(d.sequence_order)}</td>
              <td>${esc(d.name)}</td>
              <td>${esc(d.manager_name || '-')}</td>
              <td>${esc(d.warehouse_name || '-')}</td>
              <td data-csp-style="${CSP.style(`white-space:nowrap`)}">
                <button class="btn sm ghost" ${i === 0 ? 'disabled' : ''} data-csp-click="${CSP.bind('click',function(event){PortalUI.moveDept((d.id),(d.sequence_order - 1),(u.id))})}" title="بالا">↑</button>
                <button class="btn sm ghost" ${i === arr.length - 1 ? 'disabled' : ''} data-csp-click="${CSP.bind('click',function(event){PortalUI.moveDept((d.id),(d.sequence_order + 1),(u.id))})}" title="پایین">↓</button>
                <button class="btn sm ghost" data-csp-click="${CSP.bind('click',function(event){PortalUI.openEditDeptModal((d.id),(u.id))})}">✏️</button>
                <button class="btn sm ghost" data-csp-click="${CSP.bind('click',function(event){PortalUI.openDeptExtrasModal((d.id))})}" title="امکان و وظیفه">📋 امکانات</button>
                <button class="btn sm ghost" data-csp-click="${CSP.bind('click',function(event){PortalUI.openDelegateModal((d.id))})}" title="واگذاری موقت">🔀 واگذاری</button>
              </td>
            </tr>`).join('') || emptyRow(5)}</tbody></table></div>
            <h5 data-csp-style="${CSP.style(`margin:0 0 8px;font-size:13px`)}">پارامترها</h5>
            <div class="tbl-wrap"><table class="tbl" data-csp-style="${CSP.style(`font-size:12px`)}"><thead><tr>
              <th>شماره</th><th>نام</th><th>وضعیت</th><th>خط زمانی بخش‌ها</th><th></th>
            </tr></thead><tbody>${unitParams.map(p => `<tr>
              <td class="mono">${esc(p.num || p.id)}</td>
              <td>${esc(p.name)}</td>
              <td><span class="tag">${esc(paramStatusLabel(p.status))}</span></td>
              <td id="ptl-${p.id}"><span class="muted">…</span></td>
              <td><button class="btn sm" data-csp-click="${CSP.bind('click',function(event){PortalUI.showParamDetail((p.id))})}">جزئیات</button></td>
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
    let pendingHtml = '';
    try {
      const pending = await api('GET', '/portal/products/pending') || [];
      if (pending.length) {
        pendingHtml = `
          <div class="panel" data-csp-style="${CSP.style(`margin-top:12px`)}">
            <div class="panel-head"><h4>⏳ کالاهای در انتظار تأیید</h4></div>
            <div class="panel-body"><div class="tbl-wrap"><table class="tbl" data-csp-style="${CSP.style(`font-size:12px`)}"><thead><tr>
              <th>کد</th><th>نام</th><th></th>
            </tr></thead><tbody>${pending.map(p => `<tr>
              <td class="mono">${esc(p.code || p.id)}</td>
              <td>${esc(p.name)}</td>
              <td><button class="btn sm green" data-csp-click="${CSP.bind('click',function(event){PortalUI.approvePortalProduct((p.id))})}">✅ تأیید</button></td>
            </tr>`).join('')}</tbody></table></div></div>
          </div>`;
      }
    } catch (_) { /* optional */ }

    body.innerHTML = `
      <div class="toolbar" data-csp-style="${CSP.style(`margin-bottom:12px;gap:8px;flex-wrap:wrap`)}">
        <button class="btn sm" data-csp-click="${CSP.bind('click',function(event){PortalUI.openCreateUnitModal()})}">➕ واحد عملیاتی</button>
        <button class="btn sm ghost" data-csp-click="${CSP.bind('click',function(event){loadAccTab('portal-units')})}">🔄</button>
      </div>
      <p class="muted" data-csp-style="${CSP.style(`font-size:12px;margin-bottom:10px`)}">مسئول واحد از <b>اطلاعات اشخاص</b> انتخاب می‌شود؛ با ذخیره، حساب کاربری با نام کاربری=تلفن و رمز تصادفی ساخته می‌شود. برای ورود فوری، ارسال رمز موقت با پیامک را فعال کنید؛ در غیر این صورت کاربر باید از بازیابی رمز تأییدشده یا بازنشانی توسط مدیر استفاده کند.</p>
      <div class="tbl-wrap"><table class="tbl"><thead><tr>
        <th>نام واحد</th><th>نوع خروجی</th><th>وضعیت</th><th>عملیات</th>
      </tr></thead><tbody>${units.map(u => `<tr data-csp-style="${CSP.style(`${_portalUnitId === u.id ? 'background:var(--purple-light)' : ''}`)}">
        <td>${esc(u.name)}</td>
        <td class="muted">${esc(u.output_type || '-')}</td>
        <td>${u.status === 'inactive' ? '<span class="tag t-cancel">غیرفعال</span>' : '<span class="tag t-done">فعال</span>'}</td>
        <td data-csp-style="${CSP.style(`white-space:nowrap`)}">
          <button class="btn sm ${ _portalUnitId === u.id ? '' : 'ghost'}" data-csp-click="${CSP.bind('click',function(event){PortalUI.selectUnit((u.id))})}">مدیریت</button>
          <button class="btn sm ghost" data-csp-click="${CSP.bind('click',function(event){PortalUI.openEditUnitModal((u.id))})}" title="ویرایش">✏️</button>
          <button class="btn sm red" data-csp-click="${CSP.bind('click',function(event){PortalUI.deleteUnit((u.id),(u.name || ""))})}" title="حذف کامل">🗑️</button>
        </td>
      </tr>`).join('') || emptyRow(4)}</tbody></table></div>
      ${pendingHtml}
      ${detailHtml}`;
  }

  async function approvePortalProduct(id) {
    try {
      await api('POST', `/portal/products/${id}/approve`, {});
      showToast('کالا تأیید شد');
      loadAccTab('portal-units');
    } catch (e) {}
  }

  function selectUnit(id) {
    _portalUnitId = id;
    _portalParamId = null;
    loadAccTab('portal-units');
  }

  function multiSelectHtml(id, options, selectedIds, size) {
    const sel = new Set((selectedIds || []).map(String));
    return `<select id="${id}" multiple size="${size || 5}" data-csp-style="${CSP.style(`min-height:${(size || 5) * 22}px;width:100%`)}">
      ${options.map(o => `<option value="${o.id}" ${sel.has(String(o.id)) ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
    </select>`;
  }

  function unitFormFieldsHtml(u) {
    u = u || {};
    const persons = CACHE.persons || [];
    const whs = (CACHE.warehouses || []).filter(w => w.active !== 0);
    const mods = portalModuleOptions();
    const selectedWh = (u.warehouses || []).map(w => w.id);
    const selectedPersons = (u.persons || []).map(p => p.id);
    const selectedMods = (u.module_links || []).map(m => m.module_key);
    return `
      <div class="fg full"><label>نام واحد اجرایی *</label><input id="pu-name" value="${esc(u.name || '')}" placeholder="مثال: واحد خط تولید"></div>
      <div class="fg"><label>مسئول واحد * ${typeof hlp === 'function' ? hlp('از اشخاص — کاربر خودکار با تلفن شخص ساخته می‌شود') : ''}</label>
        <select id="pu-mgr"><option value="">— انتخاب شخص —</option>${personOptionsHtml(u.manager_person_id)}</select></div>
      <div class="fg"><label>مسئول دوم (اختیاری)</label>
        <select id="pu-mgr2"><option value="">—</option>${personOptionsHtml(u.manager2_person_id)}</select></div>
      <div class="fg"><label>مسئول سوم (اختیاری)</label>
        <select id="pu-mgr3"><option value="">—</option>${personOptionsHtml(u.manager3_person_id)}</select></div>
      <div class="fg full"><label>نوع خروجی واحد</label>
        <input id="pu-output" value="${esc(u.output_type || '')}" placeholder="مثال: کالای دوخته‌شده / محصول نهایی"></div>
      <div class="fg full"><label>انبارهای واحد اجرایی *</label>
        ${multiSelectHtml('pu-whs', whs.map(w => ({ id: w.id, label: w.name })), selectedWh, 6)}</div>
      <div class="fg full"><label>اشخاص در جریان</label>
        ${multiSelectHtml('pu-persons', persons.map(p => ({ id: p.id, label: (p.name || '') + (p.phone ? ' — ' + p.phone : '') })), selectedPersons, 5)}</div>
      <div class="fg full"><label>اتصالات اضافه (بخش‌های نرم‌افزار)</label>
        ${multiSelectHtml('pu-modules', mods.map(m => ({ id: m.key, label: m.label })), selectedMods, 8)}</div>
      ${u.id ? `<div class="fg"><label>وضعیت</label><select id="pu-status">
        <option value="active" ${u.status !== 'inactive' ? 'selected' : ''}>فعال</option>
        <option value="inactive" ${u.status === 'inactive' ? 'selected' : ''}>غیرفعال</option>
      </select></div>` : ''}
      <p class="muted" data-csp-style="${CSP.style(`font-size:11px;grid-column:1/-1`)}">چندانتخابی: Ctrl+کلیک (ویندوز) یا Cmd+کلیک (مک).</p>`;
  }

  function collectUnitPayload() {
    const name = el('pu-name')?.value?.trim();
    const manager_person_id = +el('pu-mgr')?.value;
    const manager2_person_id = +el('pu-mgr2')?.value || null;
    const manager3_person_id = +el('pu-mgr3')?.value || null;
    const output_type = el('pu-output')?.value?.trim() || '';
    const whSel = el('pu-whs');
    const warehouse_ids = whSel ? [...whSel.selectedOptions].map(o => +o.value).filter(Boolean) : [];
    const pSel = el('pu-persons');
    const person_ids = pSel ? [...pSel.selectedOptions].map(o => +o.value).filter(Boolean) : [];
    const mSel = el('pu-modules');
    const module_keys = mSel ? [...mSel.selectedOptions].map(o => o.value).filter(Boolean) : [];
    const status = el('pu-status')?.value || 'active';
    return {
      name, manager_person_id, manager2_person_id, manager3_person_id,
      output_type, warehouse_ids, person_ids, module_keys, status,
    };
  }

  async function openCreateUnitModal() {
    await ensurePortalCaches();
    openModal(`
      <div class="modal-head"><h3>➕ واحد عملیاتی جدید</h3><button class="x" data-csp-click="${CSP.bind('click',function(event){closeModal()})}">×</button></div>
      <div class="modal-body"><div class="form-grid">${unitFormFieldsHtml({})}</div></div>
      <div class="modal-foot"><button class="btn" data-csp-click="${CSP.bind('click',function(event){PortalUI.saveUnit(0)})}">💾 ذخیره</button>
        <button class="btn ghost" data-csp-click="${CSP.bind('click',function(event){closeModal()})}">انصراف</button></div>`);
  }

  async function openEditUnitModal(id) {
    await ensurePortalCaches();
    const u = await api('GET', '/portal/units/' + id);
    openModal(`
      <div class="modal-head"><h3>✏️ ویرایش واحد عملیاتی</h3><button class="x" data-csp-click="${CSP.bind('click',function(event){closeModal()})}">×</button></div>
      <div class="modal-body"><div class="form-grid">${unitFormFieldsHtml(u)}</div></div>
      <div class="modal-foot"><button class="btn" data-csp-click="${CSP.bind('click',function(event){PortalUI.saveUnit((id))})}">💾 ذخیره</button>
        <button class="btn ghost" data-csp-click="${CSP.bind('click',function(event){closeModal()})}">انصراف</button></div>`);
  }

  async function saveUnit(id) {
    const data = collectUnitPayload();
    if (!data.name || !data.manager_person_id) {
      showToast('نام و مسئول واحد الزامی است', 'error'); return;
    }
    if (!data.warehouse_ids.length) {
      showToast('حداقل یک انبار انتخاب کنید', 'error'); return;
    }
    try {
      if (id) await api('PUT', '/portal/units/' + id, data);
      else await api('POST', '/portal/units', data);
      closeModal();
      showToast(id ? 'واحد به‌روز شد' : 'واحد ایجاد شد — حساب مدیر با رمز ۱۲۳۴۵ ساخته شد');
      if (!id) {
        const list = await api('GET', '/portal/units') || [];
        const created = list.find(x => x.name === data.name);
        if (created) _portalUnitId = created.id;
      } else _portalUnitId = id;
      loadAccTab('portal-units');
    } catch (e) {}
  }

  async function deleteUnit(id, name) {
    const label = name || ('#' + id);
    if (!confirm(`واحد «${label}» به‌طور کامل حذف شود؟\nهمه بخش‌ها، پارامترها و تنظیمات مرتبط پاک می‌شوند.\nاسناد حسابداری/انبار ثبت‌شده قبلی دست نخورده می‌مانند.\nاین عمل برگشت‌پذیر نیست.`)) return;
    try {
      await api('DELETE', '/portal/units/' + id);
      if (_portalUnitId === id) _portalUnitId = null;
      showToast('واحد به‌طور کامل حذف شد');
      loadAccTab('portal-units');
    } catch (e) {}
  }

  async function openCreateDeptModal(unitId) {
    await ensurePortalCaches();
    const u = await api('GET', '/portal/units/' + unitId);
    const whs = u.warehouses || [];
    if (!whs.length) {
      showToast('اول انبارهای واحد را در ویرایش واحد تعریف کنید', 'error'); return;
    }
    openModal(`
      <div class="modal-head"><h3>➕ دپارتمان جدید</h3><button class="x" data-csp-click="${CSP.bind('click',function(event){closeModal()})}">×</button></div>
      <div class="modal-body"><div class="form-grid">
        <div class="fg full"><label>نام دپارتمان *</label><input id="pd-name" placeholder="مثال: دپارتمان برش"></div>
        <div class="fg full"><label>مسئول دپارتمان *</label>
          <select id="pd-mgr"><option value="">—</option>${personOptionsHtml()}</select></div>
        <div class="fg full"><label>انبار دپارتمان * (فقط انبارهای همین واحد)</label>
          <select id="pd-wh"><option value="">—</option>
            ${whs.map(w => `<option value="${w.id}">${esc(w.name)}</option>`).join('')}
          </select></div>
        <div class="fg"><label>ترتیب مرحله (خالی=آخر)</label><input id="pd-seq" type="number" min="1" placeholder="خودکار"></div>
      </div></div>
      <div class="modal-foot"><button class="btn" data-csp-click="${CSP.bind('click',function(event){PortalUI.saveDept(0,(unitId))})}">💾 ذخیره</button>
        <button class="btn ghost" data-csp-click="${CSP.bind('click',function(event){closeModal()})}">انصراف</button></div>`);
  }

  async function openEditDeptModal(deptId, unitId) {
    await ensurePortalCaches();
    const u = await api('GET', '/portal/units/' + unitId);
    const d = (u.departments || []).find(x => x.id === deptId);
    if (!d) { showToast('دپارتمان یافت نشد', 'error'); return; }
    const whs = u.warehouses || [];
    openModal(`
      <div class="modal-head"><h3>✏️ ویرایش دپارتمان</h3><button class="x" data-csp-click="${CSP.bind('click',function(event){closeModal()})}">×</button></div>
      <div class="modal-body"><div class="form-grid">
        <div class="fg full"><label>نام دپارتمان *</label><input id="pd-name" value="${esc(d.name || '')}"></div>
        <div class="fg full"><label>مسئول دپارتمان *</label>
          <select id="pd-mgr"><option value="">—</option>${personOptionsHtml(d.manager_person_id)}</select></div>
        <div class="fg full"><label>انبار دپارتمان *</label>
          <select id="pd-wh"><option value="">—</option>
            ${whs.map(w => `<option value="${w.id}" ${String(d.warehouse_id) === String(w.id) ? 'selected' : ''}>${esc(w.name)}</option>`).join('')}
          </select></div>
      </div></div>
      <div class="modal-foot"><button class="btn" data-csp-click="${CSP.bind('click',function(event){PortalUI.saveDept((deptId),(unitId))})}">💾 ذخیره</button>
        <button class="btn ghost" data-csp-click="${CSP.bind('click',function(event){closeModal()})}">انصراف</button></div>`);
  }

  async function saveDept(deptId, unitId) {
    const name = el('pd-name')?.value?.trim();
    const manager_person_id = +el('pd-mgr')?.value;
    const warehouse_id = +el('pd-wh')?.value;
    if (!name || !manager_person_id || !warehouse_id) {
      showToast('نام، مسئول و انبار الزامی است', 'error'); return;
    }
    try {
      if (deptId) {
        await api('PUT', '/portal/departments/' + deptId, { name, manager_person_id, warehouse_id });
      } else {
        const sequence_order = +el('pd-seq')?.value || undefined;
        await api('POST', `/portal/units/${unitId}/departments`, {
          name, manager_person_id, warehouse_id, sequence_order,
        });
      }
      closeModal(); showToast('دپارتمان ذخیره شد');
      _portalUnitId = unitId; loadAccTab('portal-units');
    } catch (e) {}
  }

  async function moveDept(deptId, newSeq, unitId) {
    if (!newSeq || newSeq < 1) return;
    try {
      await api('PUT', `/portal/departments/${deptId}/sequence`, { sequence_order: newSeq });
      showToast('ترتیب به‌روز شد');
      _portalUnitId = unitId; loadAccTab('portal-units');
    } catch (e) {}
  }

  let _paramItems = [];
  async function openCreateParamModal(unitId) {
    await ensurePortalCaches();
    const prods = CACHE.allProducts || CACHE.products || [];
    const u = await api('GET', '/portal/units/' + unitId);
    const whs = u.warehouses || CACHE.warehouses || [];
    _paramItems = [{ product_id: '', quantity: '1' }];
    openModal(`
      <div class="modal-head"><h3>➕ پارامتر جدید</h3><button class="x" data-csp-click="${CSP.bind('click',function(event){closeModal()})}">×</button></div>
      <div class="modal-body"><div class="form-grid">
        <div class="fg full"><label>نام پارامتر *</label><input id="pp-name"></div>
        <div class="fg full"><label>انبار مبدأ (مواد)</label>
          <select id="pp-src-wh"><option value="">— پیش‌فرض واحد —</option>
            ${whs.map(w => `<option value="${w.id}">${esc(w.name)}</option>`).join('')}
          </select></div>
        <div class="fg full"><label>اقلام پارامتر *</label>
          <div id="pp-items-box"></div>
          <button type="button" class="btn sm ghost" data-csp-click="${CSP.bind('click',function(event){PortalUI.addParamItemRow()})}">➕ مقدار / کالای بعدی</button>
        </div>
        <div class="fg full"><label>توضیحات</label><textarea id="pp-desc"></textarea></div>
      </div></div>
      <div class="modal-foot"><button class="btn" data-csp-click="${CSP.bind('click',function(event){PortalUI.saveParameter((unitId))})}">💾 ایجاد و تحویل به اولین دپارتمان</button>
        <button class="btn ghost" data-csp-click="${CSP.bind('click',function(event){closeModal()})}">انصراف</button></div>`);
    window._paramItems = _paramItems;
    window._paramProds = prods;
    renderParamItemRows();
  }

  function addParamItemRow() {
    _paramItems = window._paramItems || _paramItems;
    _paramItems.push({ product_id: '', quantity: '1' });
    window._paramItems = _paramItems;
    renderParamItemRows();
  }

  function renderParamItemRows() {
    _paramItems = window._paramItems || _paramItems;
    const prods = window._paramProds || CACHE.allProducts || CACHE.products || [];
    const box = el('pp-items-box'); if (!box) return;
    box.innerHTML = _paramItems.map((it, i) => `
      <div data-csp-style="${CSP.style(`display:flex;gap:8px;margin-bottom:6px;align-items:center;flex-wrap:wrap`)}">
        <select data-csp-style="${CSP.style(`flex:1;min-width:180px`)}" data-csp-change="${CSP.bind('change',function(event){window._paramItems[(i)].product_id=this.value})}">
          <option value="">— انتخاب کالا —</option>
          ${prods.slice(0, 800).map(p => `<option value="${p.id}" ${String(it.product_id) === String(p.id) ? 'selected' : ''}>${esc(p.name)}${p.code ? ' (' + esc(p.code) + ')' : ''}</option>`).join('')}
        </select>
        <input type="number" step="0.001" min="0.001" placeholder="مقدار" value="${esc(String(it.quantity || '1'))}"
          data-csp-input="${CSP.bind('input',function(event){window._paramItems[(i)].quantity=this.value})}" data-csp-style="${CSP.style(`width:110px`)}">
        ${_paramItems.length > 1 ? `<button type="button" class="btn sm red" data-csp-click="${CSP.bind('click',function(event){window._paramItems.splice((i),1);PortalUI.renderParamItemRows()})}">×</button>` : ''}
      </div>`).join('');
  }

  async function saveParameter(unitId) {
    _paramItems = window._paramItems || _paramItems;
    const name = el('pp-name')?.value?.trim();
    const items = (_paramItems || []).map(it => ({
      product_id: +it.product_id,
      quantity: parseFloat(it.quantity) || 0,
    })).filter(it => it.product_id && it.quantity > 0);
    if (!name || !items.length) { showToast('نام و حداقل یک قلم کالا الزامی است', 'error'); return; }
    const description = el('pp-desc')?.value || '';
    try {
      const r = await api('POST', '/portal/parameters', {
        name, unit_id: unitId, items, description,
        source_warehouse_id: +el('pp-src-wh')?.value || undefined,
      });
      if (description && (r.id || r.parameter_id)) {
        try {
          await api('POST', '/portal/field-followups', {
            entity_type: 'op_parameter',
            entity_id: r.id || r.parameter_id,
            field_key: 'description',
            note: description,
          });
        } catch (_) {}
      }
      closeModal(); showToast('پارامتر ایجاد و به اولین دپارتمان تحویل شد');
      _portalUnitId = unitId; loadAccTab('portal-units');
    } catch (e) {}
  }

  async function showParamDetail(id) {
    _portalParamId = id;
    const p = await api('GET', '/portal/parameters/' + id);
    const box = document.getElementById('portalParamDetail');
    if (!box) return;
    const canFinal = p.status === 'dept_completed' || p.status === 'in_progress';
    box.innerHTML = `
      <div class="panel" data-csp-style="${CSP.style(`margin-top:12px;border:1px solid var(--purple)`)}">
        <div class="panel-head"><h4>📋 ${esc(p.num || p.id)} — ${esc(p.name)}</h4>
          ${canFinal ? `<button class="btn sm green" data-csp-click="${CSP.bind('click',function(event){PortalUI.finalOutput((p.id))})}">🏁 ثبت خروجی نهایی</button>` : ''}
        </div>
        <div class="panel-body">
          ${timelineHtml(p.dept_logs)}
          <div class="tbl-wrap" data-csp-style="${CSP.style(`margin-top:10px`)}"><table class="tbl" data-csp-style="${CSP.style(`font-size:12px`)}"><thead><tr>
            <th>بخش</th><th>وضعیت</th><th>تأیید</th><th>مقدار</th><th>پرداخت</th>
          </tr></thead><tbody>${(p.dept_logs || []).map(l => `<tr>
            <td>${esc(l.department_name)}</td>
            <td>${esc(l.status)}</td>
            <td>${l.confirmed ? '✅' : '—'}</td>
            <td class="mono">${l.received_quantity != null ? fmt(l.received_quantity) : '—'}</td>
            <td class="muted" data-csp-style="${CSP.style(`font-size:11px`)}">${esc(l.payment_status || '—')}${l.payment_amount ? ' · '+fmt(l.payment_amount)+' ریال' : ''}</td>
          </tr>`).join('')}</tbody></table></div>
          <div class="tbl-wrap" data-csp-style="${CSP.style(`margin-top:8px`)}"><table class="tbl" data-csp-style="${CSP.style(`font-size:12px`)}"><thead><tr>
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
    const canApprovePay = (typeof canPerm === 'function' && canPerm('portal', 'approve'))
      || ['admin', 'accounting', 'unit_manager'].includes(ME?.role);
    const active = rows.filter(p => p.status !== 'completed' && p.status !== 'cancelled');
    body.innerHTML = `
      <div class="toolbar" data-csp-style="${CSP.style(`margin-bottom:12px;gap:8px;flex-wrap:wrap`)}">
        <button class="btn sm ghost" data-csp-click="${CSP.bind('click',function(event){loadAccTab('portal-my-dept')})}">🔄 بروزرسانی</button>
        <span class="muted" data-csp-style="${CSP.style(`font-size:12px`)}">${fmt(active.length)} پارامتر فعال در صف</span>
      </div>
      <div class="muted" data-csp-style="${CSP.style(`font-size:12px;margin-bottom:12px`)}">پارامترهای در صف بخش شما — دکمه‌های عملیات روی بخش فعلی اعمال می‌شوند.</div>
      <div data-csp-style="${CSP.style(`display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px`)}">
        ${active.length ? active.map(p => `<div class="panel" data-csp-style="${CSP.style(`margin:0`)}">
          <div class="panel-head"><h4>${esc(p.num || ('#'+p.id))}</h4>
            <span class="tag">${esc(paramStatusLabel(p.status))}</span></div>
          <div class="panel-body">
            <div data-csp-style="${CSP.style(`font-weight:600;margin-bottom:6px`)}">${esc(p.name)}</div>
            <div class="muted" data-csp-style="${CSP.style(`font-size:11px;margin-bottom:4px`)}">واحد: ${esc(p.unit_name || '—')}</div>
            <div class="muted" data-csp-style="${CSP.style(`font-size:11px;margin-bottom:10px`)}">بخش جاری: <b>${esc(p.current_department_name || (p.current_department_id ? ('#'+p.current_department_id) : '—'))}</b>${p.current_department_seq != null ? ` <span class="tag" data-csp-style="${CSP.style(`font-size:10px`)}">مرحله ${fmt(p.current_department_seq)}</span>` : ''}</div>
            <div data-csp-style="${CSP.style(`display:grid;grid-template-columns:1fr 1fr;gap:6px`)}">
              <button class="btn sm" data-csp-click="${CSP.bind('click',function(event){PortalUI.deptConfirm((p.id),(p.current_department_id || 0))})}">✅ تأیید مقدار</button>
              <button class="btn sm ghost" data-csp-click="${CSP.bind('click',function(event){PortalUI.deptReview((p.id),(p.current_department_id || 0))})}">🔍 بازبینی</button>
              <button class="btn sm" data-csp-click="${CSP.bind('click',function(event){PortalUI.deptPayment((p.id),(p.current_department_id || 0))})}">💳 درخواست پرداخت</button>
              ${canApprovePay ? `<button class="btn sm orange" data-csp-click="${CSP.bind('click',function(event){PortalUI.deptApprovePayment((p.id),(p.current_department_id || 0))})}">✔ تأیید پرداخت</button>` : ''}
              <button class="btn sm ghost" data-csp-click="${CSP.bind('click',function(event){PortalUI.deptConvert((p.id),(p.current_department_id || 0))})}">🔄 تبدیل</button>
              <button class="btn sm green" data-csp-style="${CSP.style(`grid-column:1/-1`)}" data-csp-click="${CSP.bind('click',function(event){PortalUI.deptComplete((p.id),(p.current_department_id || 0))})}">🏁 اتمام بخش</button>
            </div>
          </div>
        </div>`).join('') : `<div class="empty" data-csp-style="${CSP.style(`grid-column:1/-1`)}">پارامتری در صف بخش شما نیست</div>`}
      </div>`;
  }

  async function deptConfirm(paramId, deptId) {
    if (!deptId) { showToast('بخش فعال مشخص نیست', 'error'); return; }
    openModal(`
      <div class="modal-head"><h3>✅ تأیید مقدار دریافتی</h3><button class="x" data-csp-click="${CSP.bind('click',function(event){closeModal()})}">×</button></div>
      <div class="modal-body"><div class="form-grid">
        <div class="fg full"><label>مقدار دریافتی *</label><input id="pd-qty" type="number" step="0.001" min="0" value="0"></div>
      </div></div>
      <div class="modal-foot"><button class="btn green" data-csp-click="${CSP.bind('click',function(event){PortalUI.saveDeptConfirm((paramId),(deptId))})}">💾 تأیید</button>
        <button class="btn ghost" data-csp-click="${CSP.bind('click',function(event){closeModal()})}">انصراف</button></div>`);
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
    let persons = CACHE.persons || [];
    if (!persons.length) {
      try { persons = CACHE.persons = await api('GET', '/persons') || []; } catch (_) { persons = []; }
    }
    // Prefer unit persons-in-flow when known
    let unitPersons = persons;
    try {
      const param = await api('GET', '/portal/parameters/' + paramId);
      if (param?.unit_id) {
        const unit = await api('GET', '/portal/units/' + param.unit_id);
        if (unit?.persons?.length) unitPersons = unit.persons;
        window._portalPayUnitWh = (unit?.warehouses || []).map(w => w.id);
      }
    } catch (_) {}
    openModal(`
      <div class="modal-head"><h3>💳 درخواست پرداخت</h3><button class="x" data-csp-click="${CSP.bind('click',function(event){closeModal()})}">×</button></div>
      <div class="modal-body"><div class="form-grid">
        <div class="fg full"><label>شخص * ${unitPersons !== persons ? '(اشخاص در جریان واحد)' : ''}</label>
          <select id="pd-person"><option value="">— انتخاب —</option>
          ${unitPersons.map(p => `<option value="${p.id}">${esc(p.name || '')}${p.phone ? ' — ' + esc(p.phone) : ''}</option>`).join('')}
        </select></div>
        <div class="fg"><label>مبلغ (ریال) *</label><input id="pd-amt" type="text" inputmode="numeric" class="money" value="0"></div>
        <div class="fg"><label>وضعیت</label><select id="pd-status">
          <option value="awaiting_accounting">در انتظار تأیید حسابداری</option>
          <option value="awaiting_payment">در انتظار پرداخت</option>
        </select></div>
        <div class="fg full"><label>یادداشت</label><input id="pd-note"></div>
      </div></div>
      <div class="modal-foot"><button class="btn" data-csp-click="${CSP.bind('click',function(event){PortalUI.saveDeptPayment((paramId),(deptId))})}">📤 ارسال</button>
        <button class="btn ghost" data-csp-click="${CSP.bind('click',function(event){closeModal()})}">انصراف</button></div>`);
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
    if (typeof ensureWarehouses === 'function') await ensureWarehouses();
    else if (!CACHE.warehouses?.length) {
      try { CACHE.warehouses = await api('GET', '/warehouses') || []; } catch (_) { CACHE.warehouses = null; }
    }
    let whs = (CACHE.warehouses || []).filter(w => w.active !== 0);
    try {
      const param = await api('GET', '/portal/parameters/' + paramId);
      if (param?.unit_id) {
        const unit = await api('GET', '/portal/units/' + param.unit_id);
        if (unit?.warehouses?.length) whs = unit.warehouses;
      }
    } catch (_) {}
    openModal(`
      <div class="modal-head"><h3>🏁 ثبت خروجی نهایی</h3><button class="x" data-csp-click="${CSP.bind('click',function(event){closeModal()})}">×</button></div>
      <div class="modal-body"><div class="form-grid">
        <div class="fg"><label>تعداد نهایی *</label><input id="fo-qty" type="number" step="0.001" min="0.001" value="1"></div>
        <div class="fg"><label>انبار مقصد *</label><select id="fo-wh"><option value="">— انتخاب —</option>
          ${whs.map(w => `<option value="${w.id}">${esc(w.name)}</option>`).join('')}
        </select></div>
        <div class="fg full"><label>هزینه‌های اضافه</label>
          <div id="fo-costs"></div>
          <button type="button" class="btn sm ghost" data-csp-click="${CSP.bind('click',function(event){PortalUI.addFinalCostRow()})}">➕ هزینه بعدی</button>
        </div>
      </div></div>
      <div class="modal-foot"><button class="btn green" data-csp-click="${CSP.bind('click',function(event){PortalUI.saveFinalOutput((paramId))})}">💾 ثبت نهایی</button>
        <button class="btn ghost" data-csp-click="${CSP.bind('click',function(event){closeModal()})}">انصراف</button></div>`);
    _foCosts = [{ description: '', amount_rial: '' }];
    renderFinalCostRows();
  }
  let _foCosts = [];
  function addFinalCostRow() { _foCosts.push({ description: '', amount_rial: '' }); renderFinalCostRows(); }
  function renderFinalCostRows() {
    const box = el('fo-costs'); if (!box) return;
    window._foCosts = _foCosts;
    box.innerHTML = _foCosts.map((c, i) => `
      <div data-csp-style="${CSP.style(`display:flex;gap:8px;margin-bottom:6px;align-items:center`)}">
        <input placeholder="شرح" value="${esc(c.description || '')}" data-csp-input="${CSP.bind('input',function(event){window._foCosts[(i)].description=this.value})}" data-csp-style="${CSP.style(`flex:1`)}">
        <input placeholder="مبلغ ریال" type="text" inputmode="numeric" class="money" value="${esc(String(c.amount_rial || ''))}" data-csp-input="${CSP.bind('input',function(event){window._foCosts[(i)].amount_rial=this.value})}" data-csp-style="${CSP.style(`width:140px`)}">
        ${_foCosts.length > 1 ? `<button type="button" class="btn sm red" data-csp-click="${CSP.bind('click',function(event){window._foCosts.splice((i),1);PortalUI.renderFinalCostRows()})}">×</button>` : ''}
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
      <div class="modal-head"><h3>➕ امکان / خدمت دپارتمان</h3><button class="x" data-csp-click="${CSP.bind('click',function(event){closeModal()})}">×</button></div>
      <div class="modal-body"><div class="form-grid">
        <div class="fg full"><label>نام *</label><input id="cap-name"></div>
        <div class="fg full"><label>توضیحات</label><textarea id="cap-desc"></textarea></div>
      </div></div>
      <div class="modal-foot"><button class="btn" data-csp-click="${CSP.bind('click',function(event){PortalUI.saveDeptCapability((deptId))})}">💾 ذخیره</button>
        <button class="btn ghost" data-csp-click="${CSP.bind('click',function(event){closeModal()})}">انصراف</button></div>`);
  }
  async function saveDeptCapability(deptId) {
    const name = el('cap-name')?.value?.trim();
    if (!name) { showToast('نام الزامی است', 'error'); return; }
    try {
      await api('POST', `/portal/departments/${deptId}/capabilities`, { name, description: el('cap-desc')?.value || '' });
      closeModal(); showToast('امکان ثبت شد');
      openDeptExtrasModal(deptId);
    } catch (e) {}
  }
  async function addDeptTask(deptId) {
    openModal(`
      <div class="modal-head"><h3>➕ شرح وظیفه دپارتمان</h3><button class="x" data-csp-click="${CSP.bind('click',function(event){closeModal()})}">×</button></div>
      <div class="modal-body"><div class="form-grid">
        <div class="fg full"><label>نام *</label><input id="task-name"></div>
        <div class="fg full"><label>توضیحات</label><textarea id="task-desc"></textarea></div>
      </div></div>
      <div class="modal-foot"><button class="btn" data-csp-click="${CSP.bind('click',function(event){PortalUI.saveDeptTask((deptId))})}">💾 ذخیره</button>
        <button class="btn ghost" data-csp-click="${CSP.bind('click',function(event){closeModal()})}">انصراف</button></div>`);
  }
  async function saveDeptTask(deptId) {
    const name = el('task-name')?.value?.trim();
    if (!name) { showToast('نام الزامی است', 'error'); return; }
    try {
      await api('POST', `/portal/departments/${deptId}/tasks`, { name, description: el('task-desc')?.value || '' });
      closeModal(); showToast('وظیفه ثبت شد');
      openDeptExtrasModal(deptId);
    } catch (e) {}
  }

  async function openDeptExtrasModal(deptId) {
    const [caps, tasks] = await Promise.all([
      api('GET', `/portal/departments/${deptId}/capabilities`).catch(() => []),
      api('GET', `/portal/departments/${deptId}/tasks`).catch(() => []),
    ]);
    openModal(`
      <div class="modal-head"><h3>📋 امکانات و وظایف دپارتمان</h3><button class="x" data-csp-click="${CSP.bind('click',function(event){closeModal()})}">×</button></div>
      <div class="modal-body">
        <div data-csp-style="${CSP.style(`display:flex;justify-content:space-between;align-items:center;margin-bottom:8px`)}">
          <h5 data-csp-style="${CSP.style(`margin:0;font-size:13px`)}">امکانات / خدمات</h5>
          <button class="btn sm" data-csp-click="${CSP.bind('click',function(event){PortalUI.addDeptCapability((deptId))})}">➕ امکان</button>
        </div>
        <div class="tbl-wrap" data-csp-style="${CSP.style(`margin-bottom:16px`)}"><table class="tbl" data-csp-style="${CSP.style(`font-size:12px`)}"><thead><tr>
          <th>نام</th><th>توضیح</th>
        </tr></thead><tbody>${(caps || []).map(c => `<tr>
          <td>${esc(c.name)}</td><td class="muted">${esc(c.description || '-')}</td>
        </tr>`).join('') || emptyRow(2)}</tbody></table></div>
        <div data-csp-style="${CSP.style(`display:flex;justify-content:space-between;align-items:center;margin-bottom:8px`)}">
          <h5 data-csp-style="${CSP.style(`margin:0;font-size:13px`)}">شرح وظایف</h5>
          <button class="btn sm" data-csp-click="${CSP.bind('click',function(event){PortalUI.addDeptTask((deptId))})}">➕ وظیفه</button>
        </div>
        <div class="tbl-wrap"><table class="tbl" data-csp-style="${CSP.style(`font-size:12px`)}"><thead><tr>
          <th>نام</th><th>توضیح</th>
        </tr></thead><tbody>${(tasks || []).map(t => `<tr>
          <td>${esc(t.name)}</td><td class="muted">${esc(t.description || '-')}</td>
        </tr>`).join('') || emptyRow(2)}</tbody></table></div>
      </div>
      <div class="modal-foot"><button class="btn ghost" data-csp-click="${CSP.bind('click',function(event){closeModal()})}">بستن</button></div>`);
  }

  async function openDelegateModal(deptId) {
    await ensurePortalCaches();
    const list = await api('GET', `/portal/departments/${deptId}/delegations`).catch(() => []) || [];
    openModal(`
      <div class="modal-head"><h3>🔀 واگذاری موقت مدیریت بخش</h3><button class="x" data-csp-click="${CSP.bind('click',function(event){closeModal()})}">×</button></div>
      <div class="modal-body"><div class="form-grid">
        <div class="fg full"><label>شخص جایگزین *</label>
          <select id="dlg-person"><option value="">— انتخاب —</option>${personOptionsHtml()}</select></div>
        <div class="fg"><label>مدت (ساعت)</label><input id="dlg-hours" type="number" min="1" max="720" value="72"></div>
        <div class="fg full"><label>یادداشت</label><input id="dlg-note" placeholder="دلیل واگذاری"></div>
      </div>
      <h5 data-csp-style="${CSP.style(`margin:14px 0 8px;font-size:13px`)}">واگذاری‌های اخیر</h5>
      <div class="tbl-wrap"><table class="tbl" data-csp-style="${CSP.style(`font-size:11px`)}"><thead><tr>
        <th>شخص</th><th>از</th><th>تا</th><th>فعال</th><th></th>
      </tr></thead><tbody>${list.map(d => `<tr>
        <td>${esc(d.delegate_name || '#' + d.delegate_person_id)}</td>
        <td class="mono">${fmt(d.starts_at)}</td>
        <td class="mono">${fmt(d.ends_at)}</td>
        <td>${d.active ? '✅' : '—'}</td>
        <td>${d.active ? `<button class="btn sm red" data-csp-click="${CSP.bind('click',function(event){PortalUI.revokeDelegation((deptId),(d.id))})}">ابطال</button>` : ''}</td>
      </tr>`).join('') || emptyRow(5)}</tbody></table></div>
      </div>
      <div class="modal-foot"><button class="btn" data-csp-click="${CSP.bind('click',function(event){PortalUI.saveDelegation((deptId))})}">💾 ثبت واگذاری</button>
        <button class="btn ghost" data-csp-click="${CSP.bind('click',function(event){closeModal()})}">انصراف</button></div>`);
  }
  async function saveDelegation(deptId) {
    const delegate_person_id = +el('dlg-person')?.value;
    const hours = +el('dlg-hours')?.value || 72;
    if (!delegate_person_id) { showToast('شخص جایگزین الزامی است', 'error'); return; }
    try {
      await api('POST', `/portal/departments/${deptId}/delegate`, {
        delegate_person_id, hours, note: el('dlg-note')?.value || '',
      });
      showToast('واگذاری ثبت شد — کاربر در صورت نیاز ساخته می‌شود (تغییر رمز در اولین ورود)');
      openDelegateModal(deptId);
    } catch (e) {}
  }
  async function revokeDelegation(deptId, delId) {
    if (!confirm('واگذاری ابطال شود؟')) return;
    try {
      await api('POST', `/portal/departments/${deptId}/delegations/${delId}/revoke`, {});
      showToast('واگذاری ابطال شد');
      openDelegateModal(deptId);
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
    const list = (CACHE.products || CACHE.allProducts || [])
      .filter(p => !p.approval_status || p.approval_status === 'approved')
      .slice(0, 500);
    openModal(`
      <div class="modal-head"><h3>🔄 تبدیل کالا</h3><button class="x" data-csp-click="${CSP.bind('click',function(event){closeModal()})}">×</button></div>
      <div class="modal-body"><div class="form-grid">
        <div class="fg full"><label>کالای خروجی موجود</label><select id="cv-prod"><option value="">— انتخاب یا نام جدید زیر —</option>
          ${list.map(p => `<option value="${p.id}">${esc(p.name)}${p.code ? ' (' + esc(p.code) + ')' : ''}</option>`).join('')}
        </select></div>
        <div class="fg full"><label>یا نام کالای جدید (در انتظار تأیید ادمین)</label>
          <input id="cv-new-name" type="text" placeholder="نام کالا اگر در لیست نیست"></div>
        <div class="fg"><label>مقدار *</label><input id="cv-qty" type="number" step="0.001" min="0.001" value="1"></div>
      </div></div>
      <div class="modal-foot"><button class="btn" data-csp-click="${CSP.bind('click',function(event){PortalUI.saveDeptConvert((paramId),(deptId))})}">💾 ثبت تبدیل</button>
        <button class="btn ghost" data-csp-click="${CSP.bind('click',function(event){closeModal()})}">انصراف</button></div>`);
  }
  async function saveDeptConvert(paramId, deptId) {
    const product_id = +el('cv-prod')?.value || null;
    const product_name = (el('cv-new-name')?.value || '').trim();
    const quantity = +el('cv-qty')?.value;
    if ((!product_id && !product_name) || !quantity) {
      showToast('کالا (انتخاب یا نام جدید) و مقدار الزامی است', 'error');
      return;
    }
    try {
      const body = { quantity };
      if (product_id) body.product_id = product_id;
      if (product_name) body.product_name = product_name;
      const r = await api('POST', `/portal/parameters/${paramId}/dept/${deptId}/convert`, body);
      closeModal();
      showToast(r?.created_pending ? 'تبدیل انجام شد — کالا در انتظار تأیید ادمین' : 'تبدیل انجام شد');
      loadAccTab('portal-my-dept');
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

  function bankReconStatusLabel(status) {
    if (status === 'closed') return 'بسته';
    if (status === 'void') return 'باطل';
    return 'باز';
  }
  function bankReconKindOptions(selected) {
    const opts = [
      ['unclassified', 'بدون طبقه'],
      ['outstanding_check', 'چک معوق'],
      ['deposit_in_transit', 'واریز در راه'],
      ['bank_charge', 'کارمزد بانک'],
      ['bank_interest', 'سود سپرده'],
      ['book_error', 'اصلاح دفتر'],
    ];
    return opts.map(([v, l]) => `<option value="${v}" ${selected === v ? 'selected' : ''}>${l}</option>`).join('');
  }

  async function renderBankReconTab(body) {
    if (!CACHE.banks) CACHE.banks = await api('GET', '/banks') || [];
    const rows = await api('GET', '/bank-reconciliation') || [];
    let detail = '';
    if (_bankReconId) {
      const r = await api('GET', '/bank-reconciliation/' + _bankReconId) || {};
      const b = r.bridge || {};
      const open = r.status === 'open';
      const liveBook = r.live_book_balance_rial != null ? r.live_book_balance_rial : (r.book_balance_rial || 0);
      let chequeSuggestHtml = '';
      if (open) {
        let sug = { suggestions: [] };
        try {
          sug = await api('GET', '/bank-reconciliation/' + _bankReconId + '/cheque-suggestions', null, false, true) || {};
        } catch (_) { sug = { suggestions: [] }; }
        const suggestions = sug.suggestions || [];
        chequeSuggestHtml = `
          <div class="panel" data-csp-style="${CSP.style(`margin-top:12px`)}">
            <div class="panel-head"><h4>چک‌های پیشنهادی برای تطبیق</h4>
              <button class="btn sm ghost" data-csp-click="${CSP.bind('click', function () { loadAccTab('bank-recon'); })}">↻</button>
            </div>
            <div class="panel-body">
              <p class="muted" data-csp-style="${CSP.style(`font-size:12px;margin-bottom:8px`)}">
                فقط پیشنهاد از چک‌های وصول‌شده (<code>cleared</code>) و پاس‌شده (<code>cleared_out</code>)؛ تأیید دستی لازم است و سند جدید زده نمی‌شود.
              </p>
              <div class="tbl-wrap"><table class="tbl" data-csp-style="${CSP.style(`font-size:12px`)}"><thead><tr>
                <th>چک</th><th>طرف</th><th>وضعیت</th><th>مبلغ</th><th>ردیف صورت‌حساب</th><th>اطمینان</th><th></th>
              </tr></thead><tbody>${suggestions.map((s) => {
                const cid = Number(s.cheque_id);
                const fixedLine = Number(s.statement_line_id) || 0;
                const lineLabel = fixedLine
                  ? (`#${fixedLine} · ${esc(s.line_date || '')} · ${fmt(s.line_amount_rial || 0)}`)
                  : (s.status === 'ambiguous'
                    ? `<select class="br-chq-line" data-cheque-id="${cid}">
                        <option value="">— انتخاب ردیف —</option>
                        ${(s.candidates || []).map((c) =>
                          `<option value="${c.statement_line_id}">#${c.statement_line_id} · ${esc(c.line_date || '')} · ${fmt(c.amount_rial || 0)}</option>`
                        ).join('')}
                      </select>`
                    : '—');
                const confirmBtn = `<button class="btn sm green" data-csp-click="${CSP.bind('click', function () {
                  PortalUI.confirmBankChequeMatch(r.id, cid, fixedLine);
                })}">تأیید</button>`;
                return `<tr>
                  <td class="mono">${esc(s.cheque_number || ('#' + cid))}</td>
                  <td>${esc(s.party_name || '—')}</td>
                  <td class="mono muted">${esc(s.lifecycle_status || '')}</td>
                  <td class="mono">${fmt(s.amount_rial || 0)}</td>
                  <td>${lineLabel}</td>
                  <td class="mono">${fmt(s.confidence || 0)}٪${s.status === 'ambiguous' ? ' ⚠️' : ''}</td>
                  <td>${confirmBtn}</td>
                </tr>`;
              }).join('') || emptyRow(7)}</tbody></table></div>
            </div>
          </div>`;
      }
      detail = `
        <div class="panel" data-csp-style="${CSP.style(`margin-top:12px`)}">
          <div class="panel-head"><h4>تطبیق #${fmt(r.id)} — ${esc(r.bank_name || '')}</h4>
            <div data-csp-style="${CSP.style(`display:flex;gap:6px;flex-wrap:wrap`)}">
              ${open ? `<button class="btn sm" data-csp-click="${CSP.bind('click',function(event){PortalUI.openBankReconItemModal((r.id))})}">➕ ردیف</button>` : ''}
              ${open ? `<button class="btn sm ghost" data-csp-click="${CSP.bind('click',function(event){PortalUI.openBankReconImport((r.id))})}">📥 واردات صورتحساب</button>` : ''}
              ${open ? `<button class="btn sm ghost" data-csp-click="${CSP.bind('click',function(event){PortalUI.autoMatchBankRecon((r.id))})}">⚡ تطبیق خودکار</button>` : ''}
              ${open ? `<button class="btn sm ghost" data-csp-click="${CSP.bind('click',function(event){PortalUI.matchBankReconItems((r.id))})}">🔗 تطبیق انتخاب‌شده</button>` : ''}
              ${open ? `<button class="btn sm ghost" data-csp-click="${CSP.bind('click',function(event){PortalUI.refreshBankReconBook((r.id))})}">↻ مانده دفتر</button>` : ''}
              ${open ? `<button class="btn sm green" data-csp-click="${CSP.bind('click',function(event){PortalUI.closeBankRecon((r.id))})}">🔒 بستن</button>` : ''}
              ${r.status !== 'void' ? `<button class="btn sm danger" data-csp-click="${CSP.bind('click',function(event){PortalUI.voidBankRecon((r.id))})}">ابطال</button>` : ''}
            </div>
          </div>
          <div class="panel-body">
            <div class="cards" data-csp-style="${CSP.style(`margin-bottom:12px`)}">
              ${statCard('b', '📒', fmt(liveBook), 'مانده دفتر زنده')}
              ${statCard('o', '🏦', fmt(r.statement_balance_rial || 0), 'مانده صورتحساب')}
              ${statCard('g', '✓', fmt(b.adjusted_statement_rial || 0), 'صورتحساب تعدیل‌شده')}
              ${statCard('r', 'Δ', fmt(b.unexplained_rial || 0), 'اختلاف توجیه‌نشده')}
            </div>
            <p class="muted" data-csp-style="${CSP.style(`font-size:12px;margin-bottom:8px`)}">
              چک معوق ${fmt(b.outstanding_checks_rial || 0)} · واریز در راه ${fmt(b.deposits_in_transit_rial || 0)} ·
              کارمزد ${fmt(b.bank_charges_rial || 0)} · سود ${fmt(b.bank_interest_rial || 0)} ·
              بدون طبقه ${fmt(b.unclassified_rial || 0)}.
              بستن فقط وقتی اختلاف صفر است و ردیف بدون طبقه نمانده. چک معوق و واریز در راه سند نمی‌زنند.
            </p>
            <div class="tbl-wrap"><table class="tbl" data-csp-style="${CSP.style(`font-size:12px`)}"><thead><tr>
              ${open ? '<th></th>' : ''}<th>طرف</th><th>طبقه</th><th>شرح</th><th>مبلغ (ریال)</th><th>تطبیق</th>
            </tr></thead><tbody>${(r.items || []).filter(it => !it.voided).map(it => `<tr>
              ${open ? `<td><input type="checkbox" class="br-match" value="${it.id}" ${it.matched ? 'disabled' : ''}></td>` : ''}
              <td>${it.side === 'bank' ? 'بانک' : 'دفتر'}</td>
              <td>${open && !it.matched
                ? `<select data-csp-change="${CSP.bind('change', function(event){ PortalUI.classifyBankItem(r.id, it.id, this.value); })}">${bankReconKindOptions(it.item_kind || 'unclassified')}</select>`
                : esc(it.item_kind || '-')}</td>
              <td>${esc(it.description || '-')}</td>
              <td class="mono">${fmt(it.amount_rial || 0)}</td>
              <td>${it.matched ? '✅' : '—'}</td>
            </tr>`).join('') || emptyRow(open ? 6 : 5)}</tbody></table></div>
          </div>
        </div>${chequeSuggestHtml}`;
    }
    body.innerHTML = `
      <div class="toolbar" data-csp-style="${CSP.style(`margin-bottom:12px;gap:8px`)}">
        <button class="btn sm" data-csp-click="${CSP.bind('click',function(event){PortalUI.openBankReconModal()})}">➕ تطبیق جدید</button>
      </div>
      <div class="tbl-wrap"><table class="tbl"><thead><tr>
        <th>#</th><th>بانک</th><th>تاریخ صورت‌حساب</th><th>مانده بانک</th><th>مانده دفتر</th><th>وضعیت</th><th></th>
      </tr></thead><tbody>${rows.map(r => `<tr>
        <td class="mono">${fmt(r.id)}</td>
        <td>${esc(r.bank_name)}</td>
        <td class="mono">${escDate(r.statement_date)}</td>
        <td class="mono">${fmt(r.statement_balance_rial || 0)}</td>
        <td class="mono">${fmt(r.book_balance_rial || 0)}</td>
        <td><span class="tag ${r.status === 'closed' ? 't-done' : ''}">${bankReconStatusLabel(r.status)}</span></td>
        <td><button class="btn sm ghost" data-csp-click="${CSP.bind('click',function(event){PortalUI.showBankRecon((r.id))})}">مشاهده</button></td>
      </tr>`).join('') || emptyRow(7)}</tbody></table></div>${detail}`;
    if (typeof fitStatNums === 'function') fitStatNums();
  }

  function showBankRecon(id) { _bankReconId = id; loadAccTab('bank-recon'); }

  async function openBankReconModal() {
    if (!CACHE.banks) CACHE.banks = await api('GET', '/banks') || [];
    openModal(`
      <div class="modal-head"><h3>➕ تطبیق بانک</h3><button class="x" data-csp-click="${CSP.bind('click',function(event){closeModal()})}">×</button></div>
      <div class="modal-body"><div class="form-grid">
        <div class="fg full"><label>بانک *</label><select id="br-bank"><option value="">—</option>
          ${(CACHE.banks || []).filter(b => b.active !== 0).map(b => `<option value="${b.id}">${esc(b.name)}</option>`).join('')}
        </select></div>
        <div class="fg"><label>تاریخ صورت‌حساب *</label><input id="br-date" data-jdate value="${todayJalali()}"></div>
        <div class="fg"><label>مانده صورت‌حساب (ریال) *</label><input id="br-bal" class="money" inputmode="numeric"></div>
        <div class="fg full"><label>یادداشت</label><textarea id="br-note"></textarea></div>
      </div></div>
      <div class="modal-foot"><button class="btn" data-csp-click="${CSP.bind('click',function(event){PortalUI.saveBankRecon()})}">💾 ثبت</button>
        <button class="btn ghost" data-csp-click="${CSP.bind('click',function(event){closeModal()})}">انصراف</button></div>`);
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

  async function openBankReconItemModal(reconId) {
    openModal(`
      <div class="modal-head"><h3>➕ ردیف تطبیق</h3><button class="x" data-csp-click="${CSP.bind('click',function(event){closeModal()})}">×</button></div>
      <div class="modal-body"><div class="form-grid">
        <div class="fg"><label>طرف *</label><select id="bri-side">
          <option value="bank">بانک (صورت‌حساب)</option>
          <option value="book">دفتر</option>
        </select></div>
        <div class="fg"><label>طبقه</label><select id="bri-kind">
          <option value="unclassified">بدون طبقه</option>
          <option value="outstanding_check">چک معوق (سند نمی‌زند)</option>
          <option value="deposit_in_transit">واریز در راه (سند نمی‌زند)</option>
          <option value="bank_charge">کارمزد بانک</option>
          <option value="bank_interest">سود سپرده</option>
          <option value="book_error">اصلاح دفتر (مبلغ مثبت = افزایش بانک)</option>
        </select></div>
        <div class="fg"><label>تاریخ ردیف</label><input id="bri-date" data-jdate value="${todayJalali()}"></div>
        <div class="fg"><label>مبلغ (ریال) *</label><input id="bri-amt" class="money" inputmode="numeric"></div>
        <div class="fg full"><label>شرح</label><input id="bri-desc"></div>
        <div class="fg"><label><input type="checkbox" id="bri-stmt" data-csp-style="${CSP.style(`width:auto;margin-left:6px`)}"> خط صورت‌حساب</label></div>
      </div></div>
      <div class="modal-foot"><button class="btn" data-csp-click="${CSP.bind('click',function(event){PortalUI.saveBankReconItem((reconId))})}">💾 افزودن</button>
        <button class="btn ghost" data-csp-click="${CSP.bind('click',function(event){closeModal()})}">انصراف</button></div>`);
  }
  async function saveBankReconItem(reconId) {
    const amount_rial = Math.round(typeof moneyVal === 'function' ? moneyVal('bri-amt') : +el('bri-amt')?.value || 0);
    if (!amount_rial) { showToast('مبلغ الزامی است', 'error'); return; }
    try {
      await api('POST', `/bank-reconciliation/${reconId}/items`, {
        side: el('bri-side')?.value || 'bank',
        item_kind: el('bri-kind')?.value || 'unclassified',
        line_date: el('bri-date')?.value || '',
        description: el('bri-desc')?.value || '',
        amount_rial,
        statement_line: el('bri-stmt')?.checked ? 1 : 0,
      });
      closeModal(); showToast('ردیف افزوده شد'); loadAccTab('bank-recon');
    } catch (e) {}
  }
  async function matchBankReconItems(reconId) {
    const ids = [...document.querySelectorAll('.br-match:checked')].map(c => +c.value).filter(Boolean);
    if (ids.length < 2) { showToast('حداقل دو ردیف انتخاب کنید', 'error'); return; }
    try {
      await api('POST', `/bank-reconciliation/${reconId}/match`, { item_ids: ids });
      showToast('تطبیق شد'); loadAccTab('bank-recon');
    } catch (e) {}
  }

  async function closeBankRecon(id) {
    if (!confirm('تطبیق بسته شود؟ فقط اگر اختلاف صفر باشد. کارمزد و سود به تفصیلی همین بانک سند می‌خورند؛ چک معوق و واریز در راه سند نمی‌زنند.')) return;
    try {
      await api('POST', '/bank-reconciliation/' + id + '/close', {});
      showToast('تطبیق بسته شد'); loadAccTab('bank-recon');
    } catch (e) {}
  }

  async function classifyBankItem(reconId, itemId, item_kind) {
    try {
      await api('POST', `/bank-reconciliation/${reconId}/classify`, { item_id: itemId, item_kind });
      loadAccTab('bank-recon');
    } catch (e) {}
  }

  async function openBankReconImport(reconId) {
    openModal(`
      <div class="modal-head"><h3>📥 واردات صورتحساب</h3><button class="x" data-csp-click="${CSP.bind('click',function(event){closeModal()})}">×</button></div>
      <div class="modal-body">
        <p class="muted" data-csp-style="${CSP.style(`font-size:12px;margin-bottom:8px`)}">ستون‌ها: تاریخ، مبلغ، شرح، پیگیری — یا تاریخ، برداشت، واریز، شرح، پیگیری. تاریخ به صورت ۱۴۰۵/۰۱/۱۵ با ارقام لاتین و خط مورب.</p>
        <textarea id="br-csv" data-csp-style="${CSP.style(`width:100%;min-height:140px;font-family:monospace`)}" placeholder="date,amount_rial,description,ref"></textarea>
      </div>
      <div class="modal-foot"><button class="btn" data-csp-click="${CSP.bind('click',function(event){PortalUI.saveBankReconImport((reconId))})}">وارد کردن</button>
        <button class="btn ghost" data-csp-click="${CSP.bind('click',function(event){closeModal()})}">انصراف</button></div>`);
  }

  async function saveBankReconImport(reconId) {
    const csv_text = el('br-csv')?.value || '';
    if (!csv_text.trim()) { showToast('متن صورتحساب خالی است', 'error'); return; }
    try {
      const r = await api('POST', `/bank-reconciliation/${reconId}/import-lines`, { csv_text });
      closeModal();
      showToast((r && r.imported != null) ? ('وارد شد: ' + r.imported) : 'وارد شد');
      loadAccTab('bank-recon');
    } catch (e) {}
  }

  async function autoMatchBankRecon(reconId) {
    try {
      const r = await api('POST', `/bank-reconciliation/${reconId}/auto-match-1to1`, {});
      showToast(r ? ('تطبیق خودکار: ' + (r.matched || 0)) : 'انجام شد');
      loadAccTab('bank-recon');
    } catch (e) {}
  }

  async function refreshBankReconBook(reconId) {
    try {
      await api('POST', `/bank-reconciliation/${reconId}/refresh-book`, {});
      showToast('مانده دفتر تازه شد');
      loadAccTab('bank-recon');
    } catch (e) {}
  }

  async function voidBankRecon(id) {
    if (!confirm('این تطبیق باطل شود؟ اگر سند تعدیل دارد، همان سند برمی‌گردد.')) return;
    try {
      await api('POST', '/bank-reconciliation/' + id + '/void', {});
      showToast('تطبیق باطل شد');
      loadAccTab('bank-recon');
    } catch (e) {}
  }

  async function confirmBankChequeMatch(reconId, chequeId, statementLineId) {
    let lineId = Number(statementLineId) || 0;
    if (!lineId) {
      const sel = document.querySelector('.br-chq-line[data-cheque-id="' + chequeId + '"]');
      lineId = Number(sel && sel.value) || 0;
    }
    if (!chequeId || !lineId) {
      showToast('ردیف صورت‌حساب را انتخاب کنید', 'error');
      return;
    }
    if (!confirm('تطبیق این چک با ردیف صورت‌حساب تأیید شود؟ (فقط لینک؛ سند حسابداری جدید زده نمی‌شود)')) return;
    try {
      await api('POST', `/bank-reconciliation/${reconId}/confirm-cheque-match`, {
        cheque_id: chequeId,
        statement_line_id: lineId,
      });
      showToast('تطبیق چک تأیید شد');
      loadAccTab('bank-recon');
    } catch (e) {}
  }

  async function renderBudgetingTab(body) {
    const rows = await api('GET', '/budgeting') || [];
    let varHtml = '';
    if (_budgetId) {
      const v = await api('GET', '/budgeting/' + _budgetId + '/variance') || {};
      varHtml = `
        <div class="panel" data-csp-style="${CSP.style(`margin-top:12px`)}">
          <div class="panel-head"><h4>📊 انحراف بودجه #${fmt(_budgetId)} (${esc(v.year_label || '')})</h4>
            <button class="btn sm ghost" data-csp-click="${CSP.bind('click',function(event){PortalUI.openBudgetLinesModal((_budgetId))})}">✏️ ردیف‌های بودجه</button>
          </div>
          <div class="panel-body tbl-wrap"><table class="tbl" data-csp-style="${CSP.style(`font-size:12px`)}"><thead><tr>
            <th>حساب</th><th>ماه</th><th>بودجه</th><th>واقعی</th><th>انحراف</th>
          </tr></thead><tbody>${(v.rows || []).slice(0, 100).map(r => `<tr>
            <td class="mono">${esc(r.account_code)}</td>
            <td class="mono">${fmt(r.month)}</td>
            <td class="mono">${fmt(r.budget_rial)}</td>
            <td class="mono">${fmt(r.actual_rial)}</td>
            <td class="mono" data-csp-style="${CSP.style(`color:${(r.variance_rial || 0) >= 0 ? 'var(--green)' : 'var(--red)'}`)}">${fmt(r.variance_rial)}</td>
          </tr>`).join('') || emptyRow(5)}</tbody>
          ${v.totals ? `<tfoot><tr data-csp-style="${CSP.style(`font-weight:700;border-top:2px solid var(--border)`)}">
            <td colspan="2">جمع</td>
            <td class="mono">${fmt(v.totals.budget_rial)}</td>
            <td class="mono">${fmt(v.totals.actual_rial)}</td>
            <td class="mono">${fmt(v.totals.variance_rial)}</td>
          </tr></tfoot>` : ''}</table></div>
        </div>`;
    }
    body.innerHTML = `
      <div class="toolbar" data-csp-style="${CSP.style(`margin-bottom:12px`)}"><button class="btn sm" data-csp-click="${CSP.bind('click',function(event){PortalUI.openBudgetModal()})}">➕ بودجه جدید</button></div>
      <div class="tbl-wrap"><table class="tbl"><thead><tr>
        <th>نام</th><th>سال</th><th>وضعیت</th><th>ردیف‌ها</th><th></th>
      </tr></thead><tbody>${rows.map(b => `<tr>
        <td>${esc(b.name)}</td>
        <td>${esc(b.year_label || '-')}</td>
        <td>${esc(b.status)}</td>
        <td class="mono">${fmt(b.line_count || 0)}</td>
        <td>
          <button class="btn sm ghost" data-csp-click="${CSP.bind('click',function(event){PortalUI.showBudgetVariance((b.id))})}">انحراف</button>
          <button class="btn sm ghost" data-csp-click="${CSP.bind('click',function(event){PortalUI.openBudgetLinesModal((b.id))})}">ردیف‌ها</button>
        </td>
      </tr>`).join('') || emptyRow(5)}</tbody></table></div>${varHtml}`;
  }

  function showBudgetVariance(id) { _budgetId = id; loadAccTab('budgeting'); }

  async function openBudgetModal() {
    openModal(`
      <div class="modal-head"><h3>➕ بودجه</h3><button class="x" data-csp-click="${CSP.bind('click',function(event){closeModal()})}">×</button></div>
      <div class="modal-body"><div class="form-grid">
        <div class="fg full"><label>نام *</label><input id="bg-name"></div>
        <div class="fg"><label>برچسب سال (مثلاً 1404/01)</label><input id="bg-year" value="${todayJalali().slice(0, 4)}"></div>
        <div class="fg full"><label>یادداشت</label><textarea id="bg-note"></textarea></div>
      </div></div>
      <div class="modal-foot"><button class="btn" data-csp-click="${CSP.bind('click',function(event){PortalUI.saveBudget()})}">💾 ذخیره</button>
        <button class="btn ghost" data-csp-click="${CSP.bind('click',function(event){closeModal()})}">انصراف</button></div>`);
  }

  async function saveBudget() {
    const name = el('bg-name').value.trim();
    if (!name) { showToast('نام بودجه الزامی است', 'error'); return; }
    try {
      const r = await api('POST', '/budgeting', {
        name, year_label: el('bg-year').value || '', notes: el('bg-note').value || '', status: 'draft',
      });
      closeModal(); showToast('بودجه ایجاد شد');
      if (r?.id) { _budgetId = r.id; openBudgetLinesModal(r.id); }
      else loadAccTab('budgeting');
    } catch (e) {}
  }

  async function openBudgetLinesModal(budgetId) {
    const b = await api('GET', '/budgeting/' + budgetId) || { lines: [] };
    window._budgetLines = (b.lines || []).map(l => ({
      account_code: l.account_code || '',
      month: l.month || 1,
      amount_rial: l.amount_rial || 0,
      category: l.category || '',
      notes: l.notes || '',
    }));
    if (!window._budgetLines.length) {
      window._budgetLines.push({ account_code: '', month: 1, amount_rial: 0, category: '', notes: '' });
    }
    openModal(`
      <div class="modal-head"><h3>✏️ ردیف‌های بودجه — ${esc(b.name || '#' + budgetId)}</h3>
        <button class="x" data-csp-click="${CSP.bind('click',function(event){closeModal()})}">×</button></div>
      <div class="modal-body">
        <div id="bg-lines"></div>
        <button type="button" class="btn sm ghost" data-csp-style="${CSP.style(`margin-top:8px`)}" data-csp-click="${CSP.bind('click',function(event){PortalUI.addBudgetLineRow()})}">➕ ردیف</button>
      </div>
      <div class="modal-foot"><button class="btn" data-csp-click="${CSP.bind('click',function(event){PortalUI.saveBudgetLines((budgetId))})}">💾 ذخیره ردیف‌ها</button>
        <button class="btn ghost" data-csp-click="${CSP.bind('click',function(event){closeModal()})}">انصراف</button></div>`);
    renderBudgetLineRows();
  }
  function addBudgetLineRow() {
    window._budgetLines = window._budgetLines || [];
    window._budgetLines.push({ account_code: '', month: 1, amount_rial: 0, category: '', notes: '' });
    renderBudgetLineRows();
  }
  function renderBudgetLineRows() {
    const box = el('bg-lines'); if (!box) return;
    const lines = window._budgetLines || [];
    box.innerHTML = lines.map((l, i) => `
      <div data-csp-style="${CSP.style(`display:grid;grid-template-columns:1.2fr 70px 1fr 1fr 28px;gap:6px;margin-bottom:6px;align-items:center`)}">
        <input placeholder="کد حساب" value="${esc(l.account_code || '')}" data-csp-input="${CSP.bind('input',function(event){window._budgetLines[(i)].account_code=this.value})}" dir="ltr">
        <input type="number" min="1" max="12" title="ماه" value="${l.month || 1}" data-csp-input="${CSP.bind('input',function(event){window._budgetLines[(i)].month=+this.value||1})}">
        <input placeholder="مبلغ ریال" class="money" inputmode="numeric" value="${esc(String(l.amount_rial || ''))}" data-csp-input="${CSP.bind('input',function(event){window._budgetLines[(i)].amount_rial=this.value})}">
        <input placeholder="دسته / یادداشت" value="${esc(l.category || l.notes || '')}" data-csp-input="${CSP.bind('input',function(event){window._budgetLines[(i)].category=this.value;window._budgetLines[(i)].notes=this.value})}">
        ${lines.length > 1 ? `<button type="button" class="btn sm red" data-csp-click="${CSP.bind('click',function(event){window._budgetLines.splice((i),1);PortalUI.renderBudgetLineRows()})}">×</button>` : '<span></span>'}
      </div>`).join('');
  }
  async function saveBudgetLines(budgetId) {
    const lines = (window._budgetLines || []).map(l => ({
      account_code: String(l.account_code || '').trim(),
      month: Math.min(12, Math.max(1, parseInt(l.month, 10) || 1)),
      amount_rial: Math.round(parseInt(String(l.amount_rial || '').replace(/[^\d-]/g, ''), 10) || 0),
      category: String(l.category || '').trim(),
      notes: String(l.notes || '').trim(),
    })).filter(l => l.account_code && l.amount_rial);
    if (!lines.length) { showToast('حداقل یک ردیف با کد حساب و مبلغ لازم است', 'error'); return; }
    try {
      await api('PUT', '/budgeting/' + budgetId, { lines });
      closeModal(); showToast('ردیف‌های بودجه ذخیره شد');
      _budgetId = budgetId; loadAccTab('budgeting');
    } catch (e) {}
  }

  async function renderReservesTab(body) {
    const stale = await api('GET', '/reserves/stale-products?months=6') || {};
    body.innerHTML = `
      <div data-csp-style="${CSP.style(`display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px`)}">
        <div class="panel"><div class="panel-head"><h4>⚖️ اندوخته قانونی</h4></div>
          <div class="panel-body"><div class="form-grid">
            <div class="fg"><label>سود قابل تخصیص (ریال)</label><input id="lr-profit" class="money" inputmode="numeric"></div>
            <div class="fg"><label>سرمایه (ریال — اختیاری)</label><input id="lr-capital" class="money" inputmode="numeric"></div>
            <div class="fg"><label>تاریخ</label><input id="lr-date" data-jdate value="${todayJalali()}"></div>
          </div>
          <button class="btn sm" data-csp-style="${CSP.style(`margin-top:10px`)}" data-csp-click="${CSP.bind('click',function(event){PortalUI.postLegalReserve()})}">ثبت اندوخته</button>
          </div></div>
        <div class="panel"><div class="panel-head"><h4>📉 ذخیره مطالبات مشکوک‌الوصول</h4></div>
          <div class="panel-body"><div class="form-grid">
            <div class="fg"><label>تاریخ</label><input id="dp-date" data-jdate value="${todayJalali()}"></div>
            <div class="fg"><label>درصد (bp — خالی=روش سنی)</label><input id="dp-bp" type="number" placeholder="مثلاً 500 = 5%"></div>
          </div>
          <button class="btn sm" data-csp-style="${CSP.style(`margin-top:10px`)}" data-csp-click="${CSP.bind('click',function(event){PortalUI.postDoubtful()})}">محاسبه و ثبت</button>
          </div></div>
      </div>
      <div class="panel" data-csp-style="${CSP.style(`margin-bottom:16px`)}"><div class="panel-head"><h4>📦 ذخیره کاهش ارزش موجودی (NRV)</h4></div>
        <div class="panel-body">
          <label class="muted" data-csp-style="${CSP.style(`font-size:12px`)}">هر خط: product_id | qty | cost_rial | nrv_rial</label>
          <textarea id="nrv-lines" rows="4" dir="ltr" data-csp-style="${CSP.style(`width:100%;margin:8px 0`)}" placeholder="5 | 10 | 1000000 | 800000"></textarea>
          <button class="btn sm" data-csp-click="${CSP.bind('click',function(event){PortalUI.postInventoryNrv()})}">ثبت NRV</button>
        </div></div>
      <div class="panel"><div class="panel-head"><h4>🕐 کالاهای راکد (${fmt(stale.count || 0)} مورد — ${stale.months || 6} ماه)</h4></div>
        <div class="panel-body tbl-wrap"><table class="tbl" data-csp-style="${CSP.style(`font-size:12px`)}"><thead><tr>
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
    return `<div class="toolbar" data-csp-style="${CSP.style(`margin-bottom:12px;gap:8px;flex-wrap:wrap`)}">
      <label class="muted" data-csp-style="${CSP.style(`font-size:12px`)}">فصل:
        <input id="${prefix}-q" value="${y}-Q1" dir="ltr" data-csp-style="${CSP.style(`width:100px;padding:6px 8px;border-radius:6px;border:1px solid var(--border)`)}">
      </label>
      <button class="btn sm ghost" data-csp-click="${CSP.bind('click',function(event){PortalUI.reloadReport(`${String((prefix) ?? '')}`)})}">🔍</button>
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
    let d = {};
    try {
      d = await api('GET', '/adv-reports/cash-flow' + (qp.length ? '?' + qp.join('&') : ''), null, false, true) || {};
    } catch (e) {
      d = { sections: {}, total_net_rial: 0, warning: (e && e.message) || 'گزارش در دسترس نیست' };
    }
    const sec = (name, s) => `
      <div class="panel"><div class="panel-head"><h4>${name}</h4></div><div class="panel-body">
        <div data-csp-style="${CSP.style(`display:flex;gap:12px;margin-bottom:8px;font-size:13px`)}">
          <span>ورودی: <b class="mono">${fmt(s.inflow_rial || 0)}</b></span>
          <span>خروجی: <b class="mono">${fmt(s.outflow_rial || 0)}</b></span>
          <span>خالص: <b class="mono" data-csp-style="${CSP.style(`color:${(s.net_rial || 0) >= 0 ? 'var(--green)' : 'var(--red)'}`)}">${fmt(s.net_rial || 0)}</b></span>
        </div>
      </div></div>`;
    body.innerHTML = `
      <div class="muted" data-csp-style="${CSP.style(`font-size:12px;margin-bottom:10px`)}">بازه: ${esc(d.from || '—')} تا ${esc(d.to || '—')} — فیلتر تاریخ از نوار بالا. گردش همه صندوق‌ها و بانک‌ها (نه فقط حساب پیش‌فرض).</div>
      ${d.warning ? `<div class="empty" data-csp-style="${CSP.style(`margin-bottom:10px`)}">${esc(d.warning)}</div>` : ''}
      <div data-csp-style="${CSP.style(`display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:12px`)}">
        ${sec('عملیاتی', d.sections?.operating || {})}
        ${sec('سرمایه‌گذاری', d.sections?.investing || {})}
        ${sec('تأمین مالی', d.sections?.financing || {})}
      </div>
      <div class="panel"><div class="panel-body" data-csp-style="${CSP.style(`font-weight:700;text-align:center`)}">
        خالص جریان وجوه نقد: <span class="mono">${fmt(d.total_net_rial || 0)}</span> ریال
      </div></div>`;
  }

  async function renderKpiDashboardTab(body) {
    const d = await api('GET', '/adv-reports/kpi-dashboard') || {};
    body.innerHTML = `
      <div class="cards" data-csp-style="${CSP.style(`margin-bottom:16px`)}">
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

  function treasuryStatusChip(status) {
    const map = {
      ok: { cls: 'trsy-ok', label: 'سالم' },
      warn: { cls: 'trsy-warn', label: 'هشدار' },
      fail: { cls: 'trsy-fail', label: 'نیازمند اقدام' },
      high: { cls: 'trsy-fail', label: 'بحرانی' },
      medium: { cls: 'trsy-warn', label: 'توجه' },
    };
    const m = map[status] || map.warn;
    return `<span class="trsy-chip ${m.cls}">${m.label}</span>`;
  }

  function treasuryShareBar(pct) {
    const p = Math.max(0, Math.min(100, Number(pct) || 0));
    return `<div class="trsy-bar" title="${p}٪"><i data-csp-style="${CSP.style(`width:${p}%`)}"></i></div>`;
  }

  function treasuryMoneyTone(n) {
    const v = Number(n) || 0;
    if (v < 0) return 'var(--red)';
    if (v > 0) return 'var(--green)';
    return 'var(--text)';
  }

  async function renderTreasuryDashboardTab(body) {
    body.innerHTML = `
      <div class="trsy-wrap">
        <div class="trsy-hero">
          <div>
            <div class="trsy-kicker">بانک و صندوق · گزارش مدیریتی</div>
            <h3 class="trsy-title">داشبورد نقدینگی و الزامات</h3>
            <p class="trsy-lead">یک نگاه واحد به مانده زنده دفتر، جریان دوره، تطبیق بانک و چک‌لیست الزامات حسابداری — بدون پیچیدگی اضافه.</p>
          </div>
          <div class="trsy-hero-actions">
            <button class="btn sm ghost" data-csp-click="${CSP.bind('click', function () { loadAccTab('treasury-dashboard'); })}">↻ بروزرسانی</button>
            <button class="btn sm" data-csp-click="${CSP.bind('click', function () { go('acc-bank-recon'); })}">تطبیق بانک</button>
            <button class="btn sm ghost" data-csp-click="${CSP.bind('click', function () { go('acc-cash-flow-std'); })}">جریان وجوه</button>
          </div>
        </div>
        <div id="trsyBody"><div class="muted">در حال بارگذاری داشبورد خزانه…</div></div>
      </div>`;
    await loadTreasuryDashboard();
  }

  async function loadTreasuryDashboard() {
    const box = document.getElementById('trsyBody');
    if (!box) return;
    box.innerHTML = '<div class="muted">در حال بارگذاری داشبورد خزانه…</div>';
    const qp = [];
    if (typeof accDateFrom !== 'undefined' && accDateFrom) qp.push('from=' + encodeURIComponent(accDateFrom));
    if (typeof accDateTo !== 'undefined' && accDateTo) qp.push('to=' + encodeURIComponent(accDateTo));
    let d = {};
    try {
      d = await api('GET', '/adv-reports/treasury-dashboard' + (qp.length ? '?' + qp.join('&') : ''), null, false, true) || {};
    } catch (e) {
      box.innerHTML = `<div class="empty">${esc((e && e.message) || 'خواندن داشبورد ناموفق بود')}</div>`;
      return;
    }
    window._trsyLast = d;
    const k = d.kpis || {};
    const liveAt = new Date(d.generated_at || Date.now()).toLocaleString('fa-IR');
    const health = Number(d.health_score) || 0;
    const healthCls = health >= 85 ? 'trsy-ok' : (health >= 60 ? 'trsy-warn' : 'trsy-fail');
    const sec = d.cash_flow && d.cash_flow.sections ? d.cash_flow.sections : {};
    const cfLabel = { operating: 'عملیاتی', investing: 'سرمایه‌گذاری', financing: 'تأمین مالی' };

    const instrumentRows = (rows, kindLabel) => (rows || []).map((r) => `
      <tr>
        <td><b>${esc(r.name)}</b>${r.alerts && r.alerts.length ? ` ${r.alerts.map(() => '⚠️').join('')}` : ''}</td>
        <td class="mono muted">${esc(r.coa_code || '—')}</td>
        <td class="mono" data-csp-style="${CSP.style(`font-weight:700;color:${treasuryMoneyTone(r.balance_rial)}`)}">${fmt(r.balance_rial || 0)}</td>
        <td class="mono muted">${fmt(r.opening_balance_rial || 0)}</td>
        <td>
          <div class="trsy-share-cell">
            <span class="mono">${fmt(r.share_pct || 0)}٪</span>
            ${treasuryShareBar(r.share_pct)}
          </div>
        </td>
        <td data-csp-style="${CSP.style(`white-space:nowrap`)}">
          <button class="btn sm ghost" data-csp-click="${CSP.bind('click', function () { go(kindLabel === 'بانک' ? 'acc-banks' : 'acc-cash-boxes'); })}">لیست</button>
        </td>
      </tr>`).join('') || emptyRow(6);

    box.innerHTML = `
      <div class="trsy-meta">
        <span class="inv-badge moadian-approved">🟢 اعداد زنده از دفتر کل</span>
        <span>بازه: <b>${esc(d.from || 'ابتدا')}</b> تا <b>${esc(d.to || 'اکنون')}</b> — فیلتر از نوار بالای صفحه</span>
        <span>بروزرسانی: ${esc(liveAt)}</span>
        <span class="trsy-chip ${healthCls}">سلامت الزامات ${fmt(health)}٪</span>
      </div>

      <div class="rep-kpi-grid trsy-kpi">
        <div class="rep-kpi-card">
          <div class="kpi-icon">💎</div>
          <div class="kpi-label">نقدینگی کل (دفتر)</div>
          <div class="kpi-val" data-csp-style="${CSP.style(`color:${treasuryMoneyTone(k.total_liquidity_rial)}`)}">${fmt(k.total_liquidity_rial || 0)}</div>
          <div class="kpi-sub">ریال · بانک + صندوق (IAS نقد)</div>
        </div>
        <div class="rep-kpi-card" data-csp-click="${CSP.bind('click', function () { go('acc-banks'); })}">
          <div class="kpi-icon">🏦</div>
          <div class="kpi-label">مانده بانک‌ها</div>
          <div class="kpi-val">${fmt(k.banks_total_rial || 0)}</div>
          <div class="kpi-sub">${fmt(k.bank_count_active || 0)} بانک فعال</div>
        </div>
        <div class="rep-kpi-card" data-csp-click="${CSP.bind('click', function () { go('acc-cash-boxes'); })}">
          <div class="kpi-icon">💰</div>
          <div class="kpi-label">مانده صندوق‌ها</div>
          <div class="kpi-val">${fmt(k.cash_total_rial || 0)}</div>
          <div class="kpi-sub">${fmt(k.cash_count_active || 0)} صندوق · تنخواه ${fmt(k.petty_cash_rial || 0)}</div>
        </div>
        <div class="rep-kpi-card">
          <div class="kpi-icon">⬇️</div>
          <div class="kpi-label">ورود نقد دوره</div>
          <div class="kpi-val" data-csp-style="${CSP.style(`color:var(--green)`)}">${fmt(k.period_inflow_rial || 0)}</div>
          <div class="kpi-sub">بدهکار حساب‌های نقد/بانک</div>
        </div>
        <div class="rep-kpi-card">
          <div class="kpi-icon">⬆️</div>
          <div class="kpi-label">خروج نقد دوره</div>
          <div class="kpi-val" data-csp-style="${CSP.style(`color:var(--red)`)}">${fmt(k.period_outflow_rial || 0)}</div>
          <div class="kpi-sub">خالص دوره: <b data-csp-style="${CSP.style(`color:${treasuryMoneyTone(k.period_net_rial)}`)}">${fmt(k.period_net_rial || 0)}</b></div>
        </div>
      </div>

      <div class="trsy-grid-2">
        <div class="panel">
          <div class="panel-head"><h4>✅ چک‌لیست الزامات گزارش‌دهی</h4>
            <span class="muted" data-csp-style="${CSP.style(`font-size:11px`)}">طبق استاندارد تطبیق بانک و IAS 7</span>
          </div>
          <div class="panel-body">
            <div class="trsy-compliance">
              ${(d.compliance || []).map((c) => `
                <button type="button" class="trsy-comp-row" data-csp-click="${CSP.bind('click', function () { if (c.action_nav) go(c.action_nav); })}">
                  ${treasuryStatusChip(c.status)}
                  <div class="trsy-comp-text">
                    <div class="trsy-comp-label">${esc(c.label)}</div>
                    <div class="trsy-comp-detail">${esc(c.detail)}</div>
                  </div>
                  <span class="trsy-comp-go">‹</span>
                </button>`).join('') || '<div class="empty">موردی نیست</div>'}
            </div>
          </div>
        </div>
        <div class="panel">
          <div class="panel-head"><h4>💧 جریان وجوه نقد (IAS 7)</h4>
            <button class="btn sm ghost" data-csp-click="${CSP.bind('click', function () { go('acc-cash-flow-std'); })}">گزارش کامل</button>
          </div>
          <div class="panel-body">
            ${d.cash_flow && d.cash_flow.warning ? `<div class="empty" data-csp-style="${CSP.style(`margin-bottom:8px`)}">${esc(d.cash_flow.warning)}</div>` : ''}
            <div class="trsy-cf-grid">
              ${['operating', 'investing', 'financing'].map((key) => {
                const s = sec[key] || {};
                return `<div class="trsy-cf-card">
                  <div class="trsy-cf-name">${cfLabel[key]}</div>
                  <div class="trsy-cf-net mono" data-csp-style="${CSP.style(`color:${treasuryMoneyTone(s.net_rial)}`)}">${fmt(s.net_rial || 0)}</div>
                  <div class="trsy-cf-io muted">ورودی ${fmt(s.inflow_rial || 0)} · خروجی ${fmt(s.outflow_rial || 0)}</div>
                </div>`;
              }).join('')}
            </div>
            <div class="trsy-cf-total">خالص جریان دوره:
              <b class="mono" data-csp-style="${CSP.style(`color:${treasuryMoneyTone(d.cash_flow && d.cash_flow.total_net_rial)}`)}">${fmt((d.cash_flow && d.cash_flow.total_net_rial) || 0)}</b> ریال
            </div>
            <div class="trsy-conc">
              تمرکز نقدینگی:
              <b>${esc((d.concentration && d.concentration.top_name) || '—')}</b>
              · ${fmt((d.concentration && d.concentration.top_pct) || 0)}٪
              ${treasuryStatusChip((d.concentration && d.concentration.risk) || 'ok')}
            </div>
          </div>
        </div>
      </div>

      ${(d.alerts || []).length ? `
      <div class="panel trsy-alerts" data-csp-style="${CSP.style(`margin-top:12px`)}">
        <div class="panel-head"><h4>🔔 اقدام‌های پیشنهادی</h4></div>
        <div class="panel-body">
          <div class="trsy-alert-list">
            ${(d.alerts || []).map((a) => `
              <button type="button" class="trsy-alert-item" data-csp-click="${CSP.bind('click', function () { if (a.action_nav) go(a.action_nav); })}">
                ${treasuryStatusChip(a.severity)}
                <div><b>${esc(a.title)}</b><div class="muted" data-csp-style="${CSP.style(`font-size:12px;margin-top:2px`)}">${esc(a.detail)}</div></div>
              </button>`).join('')}
          </div>
        </div>
      </div>` : ''}

      <div class="trsy-grid-2" data-csp-style="${CSP.style(`margin-top:12px`)}">
        <div class="panel">
          <div class="panel-head"><h4>🏦 ترکیب بانک‌ها</h4>
            <span class="muted" data-csp-style="${CSP.style(`font-size:11px`)}">مانده زنده دفتر</span>
          </div>
          <div class="panel-body tbl-wrap">
            <table class="tbl" data-csp-style="${CSP.style(`font-size:12px`)}"><thead><tr>
              <th>بانک</th><th>کد</th><th data-col-kind="money">مانده</th><th data-col-kind="money">اول دوره</th><th>سهم</th><th class="no-sort"></th>
            </tr></thead><tbody>${instrumentRows(d.banks, 'بانک')}</tbody></table>
          </div>
        </div>
        <div class="panel">
          <div class="panel-head"><h4>💰 ترکیب صندوق‌ها</h4>
            <span class="muted" data-csp-style="${CSP.style(`font-size:11px`)}">شامل تنخواه</span>
          </div>
          <div class="panel-body tbl-wrap">
            <table class="tbl" data-csp-style="${CSP.style(`font-size:12px`)}"><thead><tr>
              <th>صندوق</th><th>کد</th><th data-col-kind="money">مانده</th><th data-col-kind="money">اول دوره</th><th>سهم</th><th class="no-sort"></th>
            </tr></thead><tbody>${instrumentRows(d.cash_boxes, 'صندوق')}</tbody></table>
          </div>
        </div>
      </div>

      <div class="trsy-grid-2" data-csp-style="${CSP.style(`margin-top:12px`)}">
        <div class="panel">
          <div class="panel-head"><h4>🧾 وضعیت تطبیق بانک</h4>
            <button class="btn sm ghost" data-csp-click="${CSP.bind('click', function () { go('acc-bank-recon'); })}">باز کردن</button>
          </div>
          <div class="panel-body">
            <div class="trsy-recon-kpis">
              <div><span class="muted">صورت باز</span><b class="mono">${fmt((d.reconciliation && d.reconciliation.open_count) || 0)}</b></div>
              <div><span class="muted">بسته‌شده</span><b class="mono">${fmt((d.reconciliation && d.reconciliation.closed_count) || 0)}</b></div>
              <div><span class="muted">اقلام تطبیق‌نشده</span><b class="mono">${fmt((d.reconciliation && d.reconciliation.unmatched_open_items) || 0)}</b></div>
            </div>
            ${((d.reconciliation && d.reconciliation.open) || []).length ? `
            <div class="tbl-wrap" data-csp-style="${CSP.style(`margin-top:10px`)}"><table class="tbl" data-csp-style="${CSP.style(`font-size:12px`)}"><thead><tr>
              <th>بانک</th><th>تاریخ صورت</th><th data-col-kind="money">مانده صورت</th><th data-col-kind="money">مانده دفتر</th><th data-col-kind="money">اختلاف خام</th><th>تطبیق‌نشده</th>
            </tr></thead><tbody>${(d.reconciliation.open || []).map((r) => `<tr>
              <td>${esc(r.bank_name)}</td>
              <td class="mono">${esc(r.statement_date || '—')}</td>
              <td class="mono">${fmt(r.statement_balance_rial || 0)}</td>
              <td class="mono">${fmt(r.live_book_balance_rial || 0)}</td>
              <td class="mono" data-csp-style="${CSP.style(`color:${treasuryMoneyTone(-(Math.abs(r.raw_difference_rial || 0)))}`)}">${fmt(r.raw_difference_rial || 0)}</td>
              <td class="mono">${fmt((r.unmatched_items || 0) + (r.unmatched_lines || 0))}</td>
            </tr>`).join('')}</tbody></table></div>` : '<div class="muted" data-csp-style="${CSP.style(`margin-top:8px;font-size:12px`)}">صورت بازی نیست. برای بانک‌های ریالی از «تطبیق بانک» صورت جدید بسازید.</div>'}
            ${((d.reconciliation && d.reconciliation.banks_without_open) || []).length ? `
            <div class="muted" data-csp-style="${CSP.style(`margin-top:8px;font-size:12px`)}">بانک ریالی بدون صورت باز:
              ${(d.reconciliation.banks_without_open || []).slice(0, 8).map((b) => esc(b.name)).join('، ')}${(d.reconciliation.banks_without_open || []).length > 8 ? '…' : ''}
            </div>` : ''}
          </div>
        </div>
        <div class="panel">
          <div class="panel-head"><h4>📈 روند ماهانه ورود/خروج نقد</h4></div>
          <div class="panel-body">
            <div class="crm-chart-box" data-csp-style="${CSP.style(`height:220px`)}"><canvas id="trsyMonthChart"></canvas></div>
            <div class="trsy-cheque-strip">
              <div><span class="muted">چک دریافتنی در جریان</span><b class="mono">${fmt((d.cheques && d.cheques.pending_in_rial) || 0)}</b></div>
              <div><span class="muted">چک پرداختنی باز</span><b class="mono">${fmt((d.cheques && d.cheques.pending_out_rial) || 0)}</b></div>
              <div><span class="muted">سررسیدگذشته دریافتنی</span><b class="mono" data-csp-style="${CSP.style(`color:${(d.cheques && d.cheques.overdue_in_count) ? 'var(--red)' : 'inherit'}`)}">${fmt((d.cheques && d.cheques.overdue_in_count) || 0)} · ${fmt((d.cheques && d.cheques.overdue_in_rial) || 0)}</b></div>
            </div>
          </div>
        </div>
      </div>

      <div class="trsy-footnote muted">
        مبالغ به <b>ریال</b> است. مانده‌ها از دفتر کل روی کد تفصیلی بانک/صندوق خوانده می‌شوند (نه فقط فیلد اطلاعات پایه).
        اقلام زمان‌بندی تطبیق بانک (چک معوق / واریز در راه) سند نمی‌زنند؛ بستن فقط با اختلاف توجیه‌شدهٔ صفر مجاز است.
      </div>`;

    if (typeof enhanceAccTables === 'function') enhanceAccTables(box);
    try {
      const months = d.monthly_net || [];
      const canvas = document.getElementById('trsyMonthChart');
      if (canvas && typeof Chart !== 'undefined') {
        if (window._trsyChart) { try { window._trsyChart.destroy(); } catch (_) { /* */ } }
        window._trsyChart = new Chart(canvas.getContext('2d'), {
          type: 'bar',
          data: {
            labels: months.map((m) => m.month),
            datasets: [
              { label: 'ورود', data: months.map((m) => m.inflow_rial || 0), backgroundColor: 'rgba(34,197,94,0.55)', borderRadius: 6 },
              { label: 'خروج', data: months.map((m) => m.outflow_rial || 0), backgroundColor: 'rgba(239,68,68,0.45)', borderRadius: 6 },
            ],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { position: 'bottom', labels: { font: { family: 'Vazirmatn, Tahoma' } } } },
            scales: {
              x: { ticks: { font: { family: 'Vazirmatn, Tahoma', size: 11 } } },
              y: { ticks: { font: { family: 'Vazirmatn, Tahoma', size: 10 }, callback: (v) => (Number(v) || 0).toLocaleString('fa-IR') } },
            },
          },
        });
      } else if (canvas && !months.length) {
        canvas.parentElement.innerHTML = '<div class="empty">در این بازه گردش ماهانه‌ای نیست</div>';
      }
    } catch (_) { /* chart optional */ }
  }

  async function renderSalesPurchaseDashboardTab(body) {
    body.innerHTML = `
      <div class="trsy-wrap sp-dash">
        <div class="trsy-hero">
          <div>
            <div class="trsy-kicker">فروش و خرید · تحلیل مدیریتی ۲۰۲۶</div>
            <h3 class="trsy-title">داشبورد فروش و خرید</h3>
            <p class="trsy-lead">KPIهای اقدام‌پذیر، مقایسه دوره قبل، ترکیب مشتری/تأمین‌کننده/کالا، روند ماهانه و drill-down به فاکتور — اعداد زنده از فاکتور قطعی و خرید.</p>
          </div>
          <div class="trsy-hero-actions">
            <button class="btn sm ghost" data-csp-click="${CSP.bind('click', function () { loadAccTab('sales-purchase-dashboard'); })}">↻ بروزرسانی</button>
            <button class="btn sm" data-csp-click="${CSP.bind('click', function () { go('acc-sales-invoices'); })}">فاکتور فروش</button>
            <button class="btn sm ghost" data-csp-click="${CSP.bind('click', function () { go('acc-purchases'); })}">فاکتور خرید</button>
          </div>
        </div>
        <div class="sp-filter-bar" id="spDashFilters">
          <select id="spCust" data-csp-style="${CSP.style(`padding:7px 10px;border:1.5px solid var(--border);border-radius:8px;font-size:12px;min-width:140px`)}">
            <option value="">همه مشتریان</option>
          </select>
          <select id="spSupplier" data-csp-style="${CSP.style(`padding:7px 10px;border:1.5px solid var(--border);border-radius:8px;font-size:12px;min-width:140px`)}">
            <option value="">همه تأمین‌کنندگان</option>
          </select>
          <select id="spRep" data-csp-style="${CSP.style(`padding:7px 10px;border:1.5px solid var(--border);border-radius:8px;font-size:12px;min-width:120px`)}">
            <option value="">همه کارشناسان</option>
          </select>
          <button class="btn sm" data-csp-click="${CSP.bind('click', function () { loadSalesPurchaseDashboard(); })}">اعمال فیلتر</button>
        </div>
        <div id="spDashBody"><div class="muted">در حال بارگذاری داشبورد فروش و خرید…</div></div>
      </div>`;
    try {
      const listify = (x) => {
        if (Array.isArray(x)) return x;
        if (x && Array.isArray(x.rows)) return x.rows;
        if (typeof listRows === 'function') return listRows(x) || [];
        return [];
      };
      let custList = (typeof CACHE !== 'undefined' && CACHE.customers) || [];
      let supList = (typeof CACHE !== 'undefined' && CACHE.suppliers) || [];
      let userList = (typeof CACHE !== 'undefined' && CACHE.users) || [];
      if (!custList.length) custList = listify(await api('GET', '/customers', null, false, true).catch(() => []));
      if (!supList.length) supList = listify(await api('GET', '/suppliers', null, false, true).catch(() => []));
      if (!userList.length) userList = listify(await api('GET', '/users', null, false, true).catch(() => []));
      const custSel = document.getElementById('spCust');
      const supSel = document.getElementById('spSupplier');
      const repSel = document.getElementById('spRep');
      if (custSel) {
        custList.slice(0, 400).forEach((c) => {
          const o = document.createElement('option');
          o.value = c.id;
          o.textContent = c.biz || c.name || ('#' + c.id);
          custSel.appendChild(o);
        });
      }
      if (supSel) {
        supList.slice(0, 400).forEach((s) => {
          const o = document.createElement('option');
          o.value = s.id;
          o.textContent = s.name || ('#' + s.id);
          supSel.appendChild(o);
        });
      }
      if (repSel) {
        userList.filter((u) => u && u.active !== 0).slice(0, 200).forEach((u) => {
          const o = document.createElement('option');
          o.value = u.id;
          o.textContent = u.name || u.username || ('#' + u.id);
          repSel.appendChild(o);
        });
      }
    } catch (_) { /* filters optional */ }
    await loadSalesPurchaseDashboard();
  }

  function spDashDrill(type, id) {
    window._spDashDrill = { type: String(type || ''), id: id != null && id !== '' ? Number(id) : null };
    loadSalesPurchaseDashboard();
  }
  function spDashClearDrill() {
    window._spDashDrill = null;
    loadSalesPurchaseDashboard();
  }
  function spDashOpenDoc(kind, id) {
    if (typeof openAccTradeDoc === 'function') openAccTradeDoc(kind, id);
    else if (String(kind) === 'purchase' && typeof printPurchase === 'function') printPurchase(id);
    else if (typeof openInvBuilder === 'function') openInvBuilder(id);
  }
  function spDashDocRows(docs) {
    return (docs || []).map((r) => `
      <tr class="sp-doc-row" data-csp-click="${CSP.bind('click', function (ev) {
        if (ev && ev.target && ev.target.closest && ev.target.closest('button')) return;
        spDashOpenDoc(r.kind, r.id);
      })}">
        <td>${r.kind === 'sales' ? 'فروش' : 'خرید'}</td>
        <td class="mono"><b>${esc(r.num || ('#' + r.id))}</b></td>
        <td class="mono">${esc(r.date || '—')}</td>
        <td>${esc(r.party_name || '—')}</td>
        <td class="mono">${fmt(r.amount_rial || 0)}</td>
        <td data-csp-style="${CSP.style(`white-space:nowrap`)}">
          <button class="btn sm" data-csp-click="${CSP.bind('click', function () { spDashOpenDoc(r.kind, r.id); })}" title="باز کردن سند">باز کردن</button>
          ${r.kind === 'sales' && typeof printInvoice === 'function'
            ? `<button class="btn sm ghost" data-csp-click="${CSP.bind('click', function () { printInvoice(r.id); })}" title="چاپ">🖨️</button>`
            : (r.kind === 'purchase' && typeof printPurchase === 'function'
              ? `<button class="btn sm ghost" data-csp-click="${CSP.bind('click', function () { printPurchase(r.id); })}" title="چاپ">🖨️</button>`
              : '')}
          <button class="btn sm ghost" data-csp-click="${CSP.bind('click', function () { go(r.nav || (r.kind === 'purchase' ? 'acc-purchases' : 'acc-sales-invoices')); })}" title="لیست">لیست</button>
        </td>
      </tr>`).join('') || emptyRow(6);
  }

  async function loadSalesPurchaseDashboard() {
    const box = document.getElementById('spDashBody');
    if (!box) return;
    box.innerHTML = '<div class="muted">در حال بارگذاری داشبورد فروش و خرید…</div>';
    const qp = [];
    if (typeof accDateFrom !== 'undefined' && accDateFrom) qp.push('from=' + encodeURIComponent(accDateFrom));
    if (typeof accDateTo !== 'undefined' && accDateTo) qp.push('to=' + encodeURIComponent(accDateTo));
    const cust = document.getElementById('spCust');
    const sup = document.getElementById('spSupplier');
    const rep = document.getElementById('spRep');
    if (cust && cust.value) qp.push('cust_id=' + encodeURIComponent(cust.value));
    if (sup && sup.value) qp.push('supplier_id=' + encodeURIComponent(sup.value));
    if (rep && rep.value) qp.push('user_id=' + encodeURIComponent(rep.value));
    const drill = window._spDashDrill || null;
    if (drill && drill.type) {
      qp.push('drill_type=' + encodeURIComponent(drill.type));
      if (drill.id) qp.push('drill_id=' + encodeURIComponent(drill.id));
    }
    let d = {};
    try {
      d = await api('GET', '/adv-reports/sales-purchase-dashboard' + (qp.length ? '?' + qp.join('&') : ''), null, false, true) || {};
    } catch (e) {
      box.innerHTML = `<div class="empty">${esc((e && e.message) || 'خواندن داشبورد ناموفق بود')}</div>`;
      return;
    }
    window._spDashLast = d;
    const k = d.kpis || {};
    const cmp = d.comparison || {};
    const dr = d.drill || null;
    const liveAt = new Date(d.generated_at || Date.now()).toLocaleString('fa-IR');
    const health = Number(d.health_score) || 0;
    const healthCls = health >= 85 ? 'trsy-ok' : (health >= 60 ? 'trsy-warn' : 'trsy-fail');
    const deltaTone = (pct) => {
      const v = Number(pct) || 0;
      if (v > 0) return 'var(--green)';
      if (v < 0) return 'var(--red)';
      return 'var(--text)';
    };
    const deltaLabel = (pct) => {
      const v = Number(pct) || 0;
      const sign = v > 0 ? '+' : '';
      return sign + fmt(v) + '٪ vs دوره قبل';
    };
    const partyRows = (rows, kind) => (rows || []).map((r) => {
      const dtype = r.drill_type || (kind === 'cust' ? 'customer' : 'supplier');
      const did = r.drill_id != null ? r.drill_id : r.id;
      return `
      <tr class="sp-dim-row" data-csp-click="${CSP.bind('click', function (ev) {
        if (ev && ev.target && ev.target.closest && ev.target.closest('button')) return;
        spDashDrill(dtype, did);
      })}">
        <td><b>${esc(r.name || '—')}</b></td>
        <td class="mono">${fmt(r.doc_count || 0)}</td>
        <td class="mono" data-csp-style="${CSP.style(`font-weight:700`)}">${fmt(r.amount_rial || 0)}</td>
        <td>
          <div class="trsy-share-cell">
            <span class="mono">${fmt(r.share_pct != null ? r.share_pct : 0)}٪</span>
            ${treasuryShareBar(r.share_pct)}
          </div>
        </td>
        <td>
          <button class="btn sm" data-csp-click="${CSP.bind('click', function () { spDashDrill(dtype, did); })}">اسناد</button>
        </td>
      </tr>`;
    }).join('') || emptyRow(5);

    box.innerHTML = `
      <div class="trsy-meta">
        <span class="inv-badge moadian-approved">🟢 فاکتور قطعی + خرید زنده</span>
        <span>بازه: <b>${esc(d.from || 'ابتدا')}</b> تا <b>${esc(d.to || 'اکنون')}</b></span>
        <span>بروزرسانی: ${esc(liveAt)}</span>
        <span class="trsy-chip ${healthCls}">سلامت ${fmt(health)}٪</span>
        <span class="muted" data-csp-style="${CSP.style(`font-size:11px`)}">کلیک روی KPI/ردیف → اسناد ← باز کردن فاکتور</span>
      </div>

      ${dr ? `
      <div class="panel sp-drill-panel" id="spDrillPanel">
        <div class="panel-head">
          <h4>🔎 ${esc(dr.title || 'جزئیات اسناد')}</h4>
          <div data-csp-style="${CSP.style(`display:flex;gap:8px;align-items:center;flex-wrap:wrap`)}">
            <span class="muted" data-csp-style="${CSP.style(`font-size:11px`)}">${fmt(dr.count || 0)} سند · ${fmt(dr.total_rial || 0)} ریال</span>
            <button class="btn sm ghost" data-csp-click="${CSP.bind('click', function () { spDashClearDrill(); })}">✕ بستن drill</button>
          </div>
        </div>
        <div class="panel-body">
          <div class="muted" data-csp-style="${CSP.style(`font-size:12px;margin-bottom:8px`)}">${esc(dr.open_hint || 'روی ردیف یا «باز کردن» بزنید تا سند اصلی باز شود.')}</div>
          <div class="tbl-wrap"><table class="tbl" data-csp-style="${CSP.style(`font-size:12px`)}"><thead><tr>
            <th>نوع</th><th>شماره</th><th>تاریخ</th><th>طرف</th><th data-col-kind="money">مبلغ</th><th class="no-sort">عملیات</th>
          </tr></thead><tbody>${spDashDocRows(dr.docs)}</tbody></table></div>
        </div>
      </div>` : ''}

      <div class="rep-kpi-grid trsy-kpi">
        <div class="rep-kpi-card" data-csp-click="${CSP.bind('click', function () { spDashDrill('sales'); })}" title="نمایش فاکتورهای فروش این بازه">
          <div class="kpi-icon">🧾</div>
          <div class="kpi-label">فروش خالص</div>
          <div class="kpi-val" data-csp-style="${CSP.style(`color:var(--green)`)}">${fmt(k.sales_net_rial || 0)}</div>
          <div class="kpi-sub">${fmt(k.sales_count || 0)} فاکتور · میانگین ${fmt(k.sales_avg_rial || 0)}
            <span data-csp-style="${CSP.style(`color:${deltaTone(cmp.sales_delta_pct)}`)}"> · ${esc(deltaLabel(cmp.sales_delta_pct))}</span>
          </div>
        </div>
        <div class="rep-kpi-card" data-csp-click="${CSP.bind('click', function () { spDashDrill('purchase'); })}" title="نمایش فاکتورهای خرید این بازه">
          <div class="kpi-icon">📦</div>
          <div class="kpi-label">خرید خالص</div>
          <div class="kpi-val" data-csp-style="${CSP.style(`color:var(--orange)`)}">${fmt(k.purchase_net_rial || 0)}</div>
          <div class="kpi-sub">${fmt(k.purchase_count || 0)} فاکتور · میانگین ${fmt(k.purchase_avg_rial || 0)}
            <span data-csp-style="${CSP.style(`color:${deltaTone(cmp.purchase_delta_pct)}`)}"> · ${esc(deltaLabel(cmp.purchase_delta_pct))}</span>
          </div>
        </div>
        <div class="rep-kpi-card" data-csp-click="${CSP.bind('click', function () { go('acc-pl-statement'); })}" title="صورت سود و زیان">
          <div class="kpi-icon">💎</div>
          <div class="kpi-label">سود خالص</div>
          <div class="kpi-val" data-csp-style="${CSP.style(`color:${treasuryMoneyTone(k.net_profit_rial)}`)}">${fmt(k.net_profit_rial || 0)}</div>
          <div class="kpi-sub">حاشیه ${fmt(k.net_margin_pct || 0)}٪
            <span data-csp-style="${CSP.style(`color:${deltaTone(cmp.net_profit_delta_pct)}`)}"> · ${esc(deltaLabel(cmp.net_profit_delta_pct))}</span>
          </div>
        </div>
        <div class="rep-kpi-card" data-csp-click="${CSP.bind('click', function () { go('acc-pl-statement'); })}">
          <div class="kpi-icon">📈</div>
          <div class="kpi-label">سود ناخالص</div>
          <div class="kpi-val" data-csp-style="${CSP.style(`color:${treasuryMoneyTone(k.gross_profit_rial)}`)}">${fmt(k.gross_profit_rial || 0)}</div>
          <div class="kpi-sub">حاشیه ${fmt(k.gross_margin_pct || 0)}٪ · COGS ${fmt(k.cogs_rial || 0)}</div>
        </div>
        <div class="rep-kpi-card">
          <div class="kpi-icon">⚖️</div>
          <div class="kpi-label">شکاف تجاری (فروش−خرید)</div>
          <div class="kpi-val" data-csp-style="${CSP.style(`color:${treasuryMoneyTone(k.trade_gap_rial)}`)}">${fmt(k.trade_gap_rial || 0)}</div>
          <div class="kpi-sub">ناخالص فروش ${fmt(k.sales_gross_rial || 0)} · خرید ${fmt(k.purchase_gross_rial || 0)}</div>
        </div>
        <div class="rep-kpi-card" data-csp-click="${CSP.bind('click', function () { go('acc-sales-returns'); })}">
          <div class="kpi-icon">↪️</div>
          <div class="kpi-label">برگشت فروش</div>
          <div class="kpi-val" data-csp-style="${CSP.style(`color:var(--red)`)}">${fmt(k.returns_sales_rial || 0)}</div>
          <div class="kpi-sub">${fmt(k.returns_sales_count || 0)} سند · برگشت خرید ${fmt(k.returns_purchase_rial || 0)}</div>
        </div>
        <div class="rep-kpi-card">
          <div class="kpi-icon">🧮</div>
          <div class="kpi-label">VAT خالص دوره</div>
          <div class="kpi-val">${fmt(k.vat_net_rial || 0)}</div>
          <div class="kpi-sub">خروجی ${fmt(k.vat_sales_rial || 0)} · ورودی ${fmt(k.vat_purchase_rial || 0)} · تخفیف ${fmt(k.discount_rial || 0)}</div>
        </div>
      </div>

      <div class="panel sp-profit-bridge" data-csp-style="${CSP.style(`margin-top:12px`)}">
        <div class="panel-head"><h4>💰 پل سود (هم‌تراز صورت سود و زیان)</h4>
          <button class="btn sm ghost" data-csp-click="${CSP.bind('click', function () { go('acc-pl-statement'); })}">صورت کامل</button>
        </div>
        <div class="panel-body">
          <div class="sp-profit-steps">
            <div class="sp-profit-step"><span class="muted">فروش خالص</span><b class="mono" data-csp-style="${CSP.style(`color:var(--green)`)}">${fmt(k.sales_net_rial || 0)}</b></div>
            <div class="sp-profit-op">−</div>
            <div class="sp-profit-step"><span class="muted">بهای تمام‌شده</span><b class="mono" data-csp-style="${CSP.style(`color:var(--red)`)}">${fmt(k.cogs_rial || 0)}</b>
              <small class="muted">ناخالص ${fmt(k.cogs_gross_rial || 0)} − برگشت بها ${fmt(k.cogs_returns_rial || 0)}</small>
            </div>
            <div class="sp-profit-op">=</div>
            <div class="sp-profit-step"><span class="muted">سود ناخالص</span><b class="mono" data-csp-style="${CSP.style(`color:${treasuryMoneyTone(k.gross_profit_rial)}`)}">${fmt(k.gross_profit_rial || 0)}</b>
              <small class="muted">${fmt(k.gross_margin_pct || 0)}٪ حاشیه</small>
            </div>
            <div class="sp-profit-op">−</div>
            <div class="sp-profit-step"><span class="muted">برآورد انگیزه</span><b class="mono">${fmt(k.commission_rial || 0)}</b></div>
            <div class="sp-profit-op">=</div>
            <div class="sp-profit-step sp-profit-net"><span class="muted">سود خالص</span><b class="mono" data-csp-style="${CSP.style(`color:${treasuryMoneyTone(k.net_profit_rial)}`)}">${fmt(k.net_profit_rial || 0)}</b>
              <small class="muted">${fmt(k.net_margin_pct || 0)}٪ · دوره قبل ${fmt(cmp.prior_net_profit_rial || 0)}</small>
            </div>
          </div>
          <div class="muted" data-csp-style="${CSP.style(`font-size:11px;margin-top:10px;line-height:1.7`)}">${esc((d.profit && d.profit.method_note) || 'خرید در این پل به‌عنوان موجودی است؛ مستقیم از سود کم نمی‌شود.')}</div>
        </div>
      </div>

      ${(d.alerts || []).length ? `
      <div class="panel trsy-alerts" data-csp-style="${CSP.style(`margin-top:12px`)}">
        <div class="panel-head"><h4>🔔 بینش و اقدام</h4>
          <span class="muted" data-csp-style="${CSP.style(`font-size:11px`)}">exception-first</span>
        </div>
        <div class="panel-body">
          <div class="trsy-alert-list">
            ${(d.alerts || []).map((a) => `
              <button type="button" class="trsy-alert-item" data-csp-click="${CSP.bind('click', function () { if (a.action_nav) go(a.action_nav); })}">
                ${treasuryStatusChip(a.severity)}
                <div><b>${esc(a.title)}</b><div class="muted" data-csp-style="${CSP.style(`font-size:12px;margin-top:2px`)}">${esc(a.detail)}</div></div>
              </button>`).join('')}
          </div>
        </div>
      </div>` : ''}

      <div class="trsy-grid-2" data-csp-style="${CSP.style(`margin-top:12px`)}">
        <div class="panel">
          <div class="panel-head"><h4>📈 روند ماهانه فروش در برابر خرید</h4></div>
          <div class="panel-body">
            <div class="crm-chart-box" data-csp-style="${CSP.style(`height:240px`)}"><canvas id="spMonthChart"></canvas></div>
            <div class="trsy-cheque-strip">
              <div><span class="muted">دوره قبل فروش</span><b class="mono">${fmt(cmp.prior_sales_rial || 0)}</b></div>
              <div><span class="muted">دوره قبل سود خالص</span><b class="mono">${fmt(cmp.prior_net_profit_rial || 0)}</b></div>
              <div><span class="muted">تمرکز Top-3</span><b class="mono">${fmt((d.concentration && d.concentration.top3_pct) || 0)}٪</b></div>
            </div>
          </div>
        </div>
        <div class="panel">
          <div class="panel-head"><h4>👥 کارشناسان فروش</h4>
            <span class="muted" data-csp-style="${CSP.style(`font-size:11px`)}">کلیک = اسناد</span>
          </div>
          <div class="panel-body tbl-wrap">
            <table class="tbl" data-csp-style="${CSP.style(`font-size:12px`)}"><thead><tr>
              <th>کارشناس</th><th>تعداد</th><th data-col-kind="money">فروش</th><th class="no-sort"></th>
            </tr></thead><tbody>
              ${(d.by_rep || []).map((r) => `<tr class="sp-dim-row" data-csp-click="${CSP.bind('click', function (ev) {
                if (ev && ev.target && ev.target.closest && ev.target.closest('button')) return;
                spDashDrill('rep', r.drill_id || r.id);
              })}">
                <td>${esc(r.name || '—')}</td>
                <td class="mono">${fmt(r.doc_count || 0)}</td>
                <td class="mono">${fmt(r.amount_rial || 0)}</td>
                <td><button class="btn sm" data-csp-click="${CSP.bind('click', function () { spDashDrill('rep', r.drill_id || r.id); })}">اسناد</button></td>
              </tr>`).join('') || emptyRow(4)}
            </tbody></table>
          </div>
        </div>
      </div>

      <div class="trsy-grid-2" data-csp-style="${CSP.style(`margin-top:12px`)}">
        <div class="panel">
          <div class="panel-head"><h4>🏆 مشتریان برتر</h4>
            <span class="muted" data-csp-style="${CSP.style(`font-size:11px`)}">سهم از فروش</span>
          </div>
          <div class="panel-body tbl-wrap">
            <table class="tbl" data-csp-style="${CSP.style(`font-size:12px`)}"><thead><tr>
              <th>مشتری</th><th>تعداد</th><th data-col-kind="money">مبلغ</th><th>سهم</th><th class="no-sort"></th>
            </tr></thead><tbody>${partyRows(d.by_customer, 'cust')}</tbody></table>
          </div>
        </div>
        <div class="panel">
          <div class="panel-head"><h4>🏭 تأمین‌کنندگان برتر</h4></div>
          <div class="panel-body tbl-wrap">
            <table class="tbl" data-csp-style="${CSP.style(`font-size:12px`)}"><thead><tr>
              <th>تأمین‌کننده</th><th>تعداد</th><th data-col-kind="money">مبلغ</th><th>سهم</th><th class="no-sort"></th>
            </tr></thead><tbody>${partyRows((d.by_supplier || []).map((r, _, arr) => {
              const tot = arr.reduce((a, x) => a + (x.amount_rial || 0), 0) || 1;
              return { ...r, share_pct: Math.round(((r.amount_rial || 0) / tot) * 1000) / 10 };
            }), 'sup')}</tbody></table>
          </div>
        </div>
      </div>

      <div class="trsy-grid-2" data-csp-style="${CSP.style(`margin-top:12px`)}">
        <div class="panel">
          <div class="panel-head"><h4>👗 پرفروش‌ترین کالاها</h4>
            <span class="muted" data-csp-style="${CSP.style(`font-size:11px`)}">کلیک = فاکتورهای شامل کالا</span>
          </div>
          <div class="panel-body tbl-wrap">
            <table class="tbl" data-csp-style="${CSP.style(`font-size:12px`)}"><thead><tr>
              <th>کالا</th><th>تعداد</th><th data-col-kind="money">مبلغ</th><th class="no-sort"></th>
            </tr></thead><tbody>
              ${(d.by_product || []).map((r) => `<tr class="sp-dim-row" data-csp-click="${CSP.bind('click', function (ev) {
                if (ev && ev.target && ev.target.closest && ev.target.closest('button')) return;
                if (r.drill_id || r.product_id) spDashDrill('product', r.drill_id || r.product_id);
              })}">
                <td>${esc(r.name || '—')}</td>
                <td class="mono">${fmt(r.qty || 0)}</td>
                <td class="mono">${fmt(r.amount_rial || 0)}</td>
                <td>${(r.drill_id || r.product_id)
                  ? `<button class="btn sm" data-csp-click="${CSP.bind('click', function () { spDashDrill('product', r.drill_id || r.product_id); })}">اسناد</button>`
                  : '—'}</td>
              </tr>`).join('') || emptyRow(4)}
            </tbody></table>
          </div>
        </div>
        <div class="panel">
          <div class="panel-head"><h4>📄 آخرین اسناد</h4>
            <span class="muted" data-csp-style="${CSP.style(`font-size:11px`)}">کلیک ردیف = باز کردن فاکتور</span>
          </div>
          <div class="panel-body tbl-wrap">
            <table class="tbl" data-csp-style="${CSP.style(`font-size:12px`)}"><thead><tr>
              <th>نوع</th><th>شماره</th><th>تاریخ</th><th>طرف</th><th data-col-kind="money">مبلغ</th><th class="no-sort">عملیات</th>
            </tr></thead><tbody>${spDashDocRows(d.recent_docs)}</tbody></table>
          </div>
        </div>
      </div>

      <div class="trsy-footnote muted">
        ${esc(d.unit_note || 'مبالغ به ریال است.')}
        مقایسه دوره قبل روی بازهٔ هم‌طول بلافاصله قبل از «از» نوار تاریخ حساب می‌شود
        ${cmp.prior_from ? ` (${esc(cmp.prior_from)} تا ${esc(cmp.prior_to)})` : ''}.
        فروش → فرم فاکتور؛ خرید → پیش‌نمایش چاپ (ویرایش خرید پس از ثبت نیست).
      </div>`;

    if (typeof enhanceAccTables === 'function') enhanceAccTables(box);
    if (dr) {
      const panel = document.getElementById('spDrillPanel');
      if (panel && typeof panel.scrollIntoView === 'function') {
        try { panel.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (_) { /* */ }
      }
    }
    try {
      if (typeof loadProdChartJs === 'function') await loadProdChartJs();
      const months = d.monthly || [];
      const canvas = document.getElementById('spMonthChart');
      if (canvas && typeof Chart !== 'undefined') {
        if (window._spDashChart) { try { window._spDashChart.destroy(); } catch (_) { /* */ } }
        window._spDashChart = new Chart(canvas.getContext('2d'), {
          data: {
            labels: months.map((m) => m.month),
            datasets: [
              { type: 'bar', label: 'فروش', data: months.map((m) => m.sales_rial || 0), backgroundColor: 'rgba(34,197,94,0.55)', borderRadius: 6 },
              { type: 'bar', label: 'خرید', data: months.map((m) => m.purchase_rial || 0), backgroundColor: 'rgba(249,115,22,0.45)', borderRadius: 6 },
              {
                type: 'line',
                label: 'سود تقریبی (فروش−COGS)',
                data: months.map((m) => m.net_profit_rial || 0),
                borderColor: 'rgba(37,99,235,0.9)',
                backgroundColor: 'rgba(37,99,235,0.12)',
                tension: 0.25,
                yAxisID: 'y',
              },
            ],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { position: 'bottom', labels: { font: { family: 'Vazirmatn, Tahoma' } } } },
            scales: {
              x: { ticks: { font: { family: 'Vazirmatn, Tahoma', size: 11 } } },
              y: { ticks: { font: { family: 'Vazirmatn, Tahoma', size: 10 }, callback: (v) => (Number(v) || 0).toLocaleString('fa-IR') } },
            },
          },
        });
      } else if (canvas && !months.length) {
        canvas.parentElement.innerHTML = '<div class="empty">در این بازه روند ماهانه‌ای نیست</div>';
      }
    } catch (_) { /* chart optional */ }
  }

  async function renderChequeDashboardTab(body) {
    body.innerHTML = `
      <div class="trsy-wrap">
        <div class="trsy-hero">
          <div>
            <div class="trsy-kicker">چک · گزارش مدیریتی</div>
            <h3 class="trsy-title">داشبورد چک و الزامات</h3>
            <p class="trsy-lead">سررسید ۷/۳۰/۹۰ (دریافتی و پرداختی)، معوق، صیاد، انقضای ۳ساله برگ، مهلت واخواست، تضمین، پیش‌بینی نقدینگی و پل دفتر کل (۱۱۰۹ / ۱۱۱۶ / ۲۱۰۹).</p>
          </div>
          <div class="trsy-hero-actions">
            <button class="btn sm ghost" data-csp-click="${CSP.bind('click', function () { loadAccTab('cheque-dashboard'); })}">↻ بروزرسانی</button>
            <button class="btn sm" data-csp-click="${CSP.bind('click', function () { go('acc-cheque-register'); })}">دفتر چک</button>
            <button class="btn sm ghost" data-csp-click="${CSP.bind('click', function () { go('acc-chequebook-report'); })}">دسته چک</button>
          </div>
        </div>
        <div id="chqDashBody"><div class="muted">در حال بارگذاری داشبورد چک…</div></div>
      </div>`;
    await loadChequeDashboard();
  }

  function chqOpsBucket(ops, key) {
    const o = (ops && ops[key]) || {};
    return {
      in: o.in || { count: 0, amount_rial: 0 },
      out: o.out || { count: 0, amount_rial: 0 },
      total: o.total || { count: 0, amount_rial: 0 },
    };
  }

  async function loadChequeDashboard() {
    const box = document.getElementById('chqDashBody');
    if (!box) return;
    box.innerHTML = '<div class="muted">در حال بارگذاری داشبورد چک…</div>';
    const qp = [];
    if (typeof accDateFrom !== 'undefined' && accDateFrom) qp.push('from=' + encodeURIComponent(accDateFrom));
    if (typeof accDateTo !== 'undefined' && accDateTo) qp.push('to=' + encodeURIComponent(accDateTo));
    let d = {};
    let opsPayload = null;
    let recon = null;
    try {
      d = await api('GET', '/adv-reports/cheque-dashboard' + (qp.length ? '?' + qp.join('&') : ''), null, false, true) || {};
    } catch (e) {
      box.innerHTML = `<div class="empty">${esc((e && e.message) || 'خواندن داشبورد ناموفق بود')}</div>`;
      return;
    }
    try {
      opsPayload = await api('GET', '/cheque-records/dashboard-kpis', null, false, true) || null;
    } catch (_) { opsPayload = null; }
    try {
      recon = await api('GET', '/cheque-records/reconciliation', null, false, true) || null;
    } catch (_) { recon = null; }
    const k = d.kpis || {};
    const gl = d.gl_bridge || {};
    const ops = (opsPayload && opsPayload.ops_kpis) || d.ops_kpis || {};
    const cashflow = (opsPayload && opsPayload.cashflow_forecast) || d.cashflow_forecast || [];
    const due7 = chqOpsBucket(ops, 'due_7d');
    const due30 = chqOpsBucket(ops, 'due_30d');
    const due90 = chqOpsBucket(ops, 'due_90d');
    const overdueOpen = chqOpsBucket(ops, 'overdue_open');
    const missSay = (ops.missing_sayadi) || { count: 0, amount_rial: 0 };
    const sayNotReg = (ops.sayad_not_registered) || { count: 0, amount_rial: 0 };
    const leafNear = (ops.leaves_near_3y_expiry) || { count: 0, book_count: 0, books: [] };
    const protestNear = (ops.protests_near_deadline) || { count: 0, amount_rial: 0 };
    const guarantee = (ops.guarantee) || { count: 0, amount_rial: 0 };
    const liveAt = new Date(d.generated_at || Date.now()).toLocaleString('fa-IR');
    const health = Number(d.health_score) || 0;
    const healthCls = health >= 85 ? 'trsy-ok' : (health >= 60 ? 'trsy-warn' : 'trsy-fail');
    const varTone = (n) => Math.abs(Number(n) || 0) > 500000 ? 'var(--red)' : 'var(--green)';
    const warnTone = (n) => (Number(n) || 0) > 0 ? 'var(--red)' : 'inherit';
    const reconHtml = recon && Array.isArray(recon.accounts) ? `
      <div class="panel" data-csp-style="${CSP.style(`margin-top:14px`)}">
        <div class="panel-head"><h4>⚖️ تطبیق دفتر کل ↔ دفتر چک (فقط posted)</h4></div>
        <div class="panel-body tbl-wrap">
          <table class="tbl" data-csp-style="${CSP.style(`font-size:12px`)}"><thead><tr>
            <th>حساب</th><th>مانده GL</th><th>جمع عملیاتی</th><th>اختلاف</th><th>تعداد</th>
          </tr></thead><tbody>
          ${recon.accounts.map((a) => `<tr>
            <td>${esc(a.code)} — ${esc(a.label||'')}</td>
            <td class="mono" dir="ltr">${fmt(a.gl_rial||0)}</td>
            <td class="mono" dir="ltr">${fmt(a.ops_absolute_rial!=null?a.ops_absolute_rial:a.ops_rial||0)}</td>
            <td class="mono" dir="ltr" data-csp-style="${CSP.style(`color:${varTone(a.variance_rial)}`)}">${fmt(a.variance_rial||0)}</td>
            <td class="mono">${fmt(a.ops_count||0)}</td>
          </tr>`).join('')}
          </tbody></table>
          <p class="muted" data-csp-style="${CSP.style(`font-size:11px;margin-top:8px`)}">
            بدون سند: ${fmt((recon.drilldown&&recon.drilldown.cheques_without_je||[]).length)} ·
            سند بدون چک: ${fmt((recon.drilldown&&recon.drilldown.jes_without_cheque||[]).length)} ·
            <button class="btn sm ghost" data-csp-click="${CSP.bind('click', function () { go('acc-cheque-register'); })}">باز کردن دفتر چک</button>
          </p>
        </div>
      </div>` : '';

    const horizonHtml = `
      <div class="chq-ops-kpi-head muted">افق سررسید و ریسک عملیاتی (Phase 4)</div>
      <div class="rep-kpi-grid trsy-kpi chq-ops-kpi">
        <div class="rep-kpi-card" data-csp-click="${CSP.bind('click', function () { go('acc-cheque-register'); })}">
          <div class="kpi-icon">📅</div>
          <div class="kpi-label">سررسید ۷ روز</div>
          <div class="kpi-val">${fmt(due7.total.count)}</div>
          <div class="kpi-sub">ورود ${fmt(due7.in.count)} · خروج ${fmt(due7.out.count)} · ${fmt(due7.total.amount_rial)} ریال</div>
        </div>
        <div class="rep-kpi-card">
          <div class="kpi-icon">📆</div>
          <div class="kpi-label">سررسید ۳۰ روز</div>
          <div class="kpi-val">${fmt(due30.total.count)}</div>
          <div class="kpi-sub">ورود ${fmt(due30.in.count)} · خروج ${fmt(due30.out.count)} · ${fmt(due30.total.amount_rial)} ریال</div>
        </div>
        <div class="rep-kpi-card">
          <div class="kpi-icon">🗓️</div>
          <div class="kpi-label">سررسید ۹۰ روز</div>
          <div class="kpi-val">${fmt(due90.total.count)}</div>
          <div class="kpi-sub">ورود ${fmt(due90.in.count)} · خروج ${fmt(due90.out.count)} · ${fmt(due90.total.amount_rial)} ریال</div>
        </div>
        <div class="rep-kpi-card">
          <div class="kpi-icon">⏰</div>
          <div class="kpi-label">سررسیدگذشتهٔ باز</div>
          <div class="kpi-val" data-csp-style="${CSP.style(`color:${warnTone(overdueOpen.total.count)}`)}">${fmt(overdueOpen.total.count)}</div>
          <div class="kpi-sub">ورود ${fmt(overdueOpen.in.count)} · خروج ${fmt(overdueOpen.out.count)} · ${fmt(overdueOpen.total.amount_rial)} ریال</div>
        </div>
        <div class="rep-kpi-card">
          <div class="kpi-icon">🆔</div>
          <div class="kpi-label">بی‌صیاد</div>
          <div class="kpi-val" data-csp-style="${CSP.style(`color:${warnTone(missSay.count)}`)}">${fmt(missSay.count)}</div>
          <div class="kpi-sub">${fmt(missSay.amount_rial)} ریال</div>
        </div>
        <div class="rep-kpi-card">
          <div class="kpi-icon">📡</div>
          <div class="kpi-label">صیاد ثبت‌نشده</div>
          <div class="kpi-val" data-csp-style="${CSP.style(`color:${warnTone(sayNotReg.count)}`)}">${fmt(sayNotReg.count)}</div>
          <div class="kpi-sub">${fmt(sayNotReg.amount_rial)} ریال · سامانه</div>
        </div>
        <div class="rep-kpi-card" data-csp-click="${CSP.bind('click', function () { go('acc-check-categories'); })}">
          <div class="kpi-icon">🍃</div>
          <div class="kpi-label">نزدیک انقضای ۳ساله</div>
          <div class="kpi-val" data-csp-style="${CSP.style(`color:${warnTone(leafNear.count)}`)}">${fmt(leafNear.count)}</div>
          <div class="kpi-sub">${fmt(leafNear.book_count || 0)} دسته · برگ سفید</div>
        </div>
        <div class="rep-kpi-card">
          <div class="kpi-icon">⚖️</div>
          <div class="kpi-label">مهلت واخواست ۶ماهه</div>
          <div class="kpi-val" data-csp-style="${CSP.style(`color:${warnTone(protestNear.count)}`)}">${fmt(protestNear.count)}</div>
          <div class="kpi-sub">${fmt(protestNear.amount_rial)} ریال · ≤۳۰ روز</div>
        </div>
        <div class="rep-kpi-card" data-csp-click="${CSP.bind('click', function () { go('acc-trust-checks'); })}">
          <div class="kpi-icon">🛡️</div>
          <div class="kpi-label">چک تضمینی</div>
          <div class="kpi-val">${fmt(guarantee.count)}</div>
          <div class="kpi-sub">${fmt(guarantee.amount_rial)} ریال · امانی ${fmt(k.trust_open_count || 0)}</div>
        </div>
      </div>`;

    const cfMax = Math.max(1, ...cashflow.map((c) => Math.max(Number(c.inflow_rial) || 0, Number(c.outflow_rial) || 0)));
    const cashflowHtml = `
      <div class="panel" data-csp-style="${CSP.style(`margin-top:12px`)}">
        <div class="panel-head"><h4>💧 پیش‌بینی نقدینگی از سررسیدها</h4></div>
        <div class="panel-body">
          <div class="trsy-cf-grid chq-cf-grid">
            ${cashflow.map((c) => {
              const net = Number(c.net_rial) || 0;
              const inW = Math.round(((Number(c.inflow_rial) || 0) / cfMax) * 100);
              const outW = Math.round(((Number(c.outflow_rial) || 0) / cfMax) * 100);
              return `<div class="trsy-cf-card chq-cf-card">
                <div class="trsy-cf-name">${esc(c.label || c.bucket)}</div>
                <div class="trsy-cf-net mono" data-csp-style="${CSP.style(`color:${treasuryMoneyTone(net)}`)}">${fmt(net)}</div>
                <div class="trsy-cf-io muted">ورود ${fmt(c.inflow_rial || 0)} (${fmt(c.in_count || 0)}) · خروج ${fmt(c.outflow_rial || 0)} (${fmt(c.out_count || 0)})</div>
                <div class="chq-cf-bars" aria-hidden="true">
                  <span class="chq-cf-bar in" data-csp-style="${CSP.style(`width:${inW}%`)}"></span>
                  <span class="chq-cf-bar out" data-csp-style="${CSP.style(`width:${outW}%`)}"></span>
                </div>
              </div>`;
            }).join('') || '<div class="empty">سررسید بازی برای پیش‌بینی نیست</div>'}
          </div>
          <p class="muted" data-csp-style="${CSP.style(`font-size:11px;margin-top:8px`)}">خالص = دریافتی باز − پرداختنی باز در هر بازه. تضمینی از افق نقدینگی کنار گذاشته شده است.</p>
        </div>
      </div>`;

    box.innerHTML = `
      <div class="trsy-meta">
        <span class="inv-badge moadian-approved">🟢 پرتفوی + مانده دفتر کل</span>
        <span>تاریخ گزارش: <b>${esc(d.as_of || (opsPayload && opsPayload.as_of) || '—')}</b></span>
        <span>بروزرسانی: ${esc(liveAt)}</span>
        <span class="trsy-chip ${healthCls}">سلامت الزامات ${fmt(health)}٪</span>
      </div>
      ${reconHtml}
      <div class="rep-kpi-grid trsy-kpi">
        <div class="rep-kpi-card">
          <div class="kpi-icon">📥</div>
          <div class="kpi-label">دریافتنی باز (۱۱۰۹)</div>
          <div class="kpi-val">${fmt(k.recv_open_rial || 0)}</div>
          <div class="kpi-sub">${fmt(k.recv_open_count || 0)} فقره · دفتر ${fmt(gl.gl_recv_1109_rial || 0)}</div>
        </div>
        <div class="rep-kpi-card">
          <div class="kpi-icon">🏦</div>
          <div class="kpi-label">در جریان وصول (۱۱۱۶)</div>
          <div class="kpi-val">${fmt(k.recv_collection_rial || 0)}</div>
          <div class="kpi-sub">دفتر ${fmt(gl.gl_collection_1116_rial || 0)}</div>
        </div>
        <div class="rep-kpi-card">
          <div class="kpi-icon">📤</div>
          <div class="kpi-label">پرداختنی باز (۲۱۰۹)</div>
          <div class="kpi-val">${fmt(k.pay_open_rial || 0)}</div>
          <div class="kpi-sub">${fmt(k.pay_open_count || 0)} فقره · دفتر ${fmt(gl.gl_pay_2109_rial || 0)}</div>
        </div>
        <div class="rep-kpi-card">
          <div class="kpi-icon">⏰</div>
          <div class="kpi-label">سررسید گذشته (دریافتنی)</div>
          <div class="kpi-val" data-csp-style="${CSP.style(`color:${(k.overdue_recv_count || 0) ? 'var(--red)' : 'inherit'}`)}">${fmt(k.overdue_recv_count || 0)}</div>
          <div class="kpi-sub">${fmt(k.overdue_recv_rial || 0)} ریال</div>
        </div>
        <div class="rep-kpi-card">
          <div class="kpi-icon">📅</div>
          <div class="kpi-label">۱۴ روز آینده</div>
          <div class="kpi-val">${fmt(k.due_14d_count || 0)}</div>
          <div class="kpi-sub">${fmt(k.due_14d_rial || 0)} ریال · امانی ${fmt(k.trust_open_count || 0)}</div>
        </div>
      </div>
      ${horizonHtml}
      ${cashflowHtml}
      <div class="trsy-grid-2">
        <div class="panel">
          <div class="panel-head"><h4>🔗 پل تطبیق دفتر کل</h4></div>
          <div class="panel-body">
            <div class="chq-gl-grid">
              <div class="chq-gl-card">
                <div class="muted">۱۱۰۹ اسناد دریافتنی</div>
                <div class="mono" data-csp-style="${CSP.style(`font-weight:700`)}">${fmt(gl.gl_recv_1109_rial || 0)}</div>
                <div class="muted" data-csp-style="${CSP.style(`font-size:11px`)}">عملیاتی ${fmt(gl.ops_recv_rial || 0)}</div>
                <div class="mono" data-csp-style="${CSP.style(`color:${varTone(gl.variance_recv_rial)};font-size:12px`)}">Δ ${fmt(gl.variance_recv_rial || 0)}</div>
              </div>
              <div class="chq-gl-card">
                <div class="muted">۱۱۱۶ در جریان وصول</div>
                <div class="mono" data-csp-style="${CSP.style(`font-weight:700`)}">${fmt(gl.gl_collection_1116_rial || 0)}</div>
                <div class="muted" data-csp-style="${CSP.style(`font-size:11px`)}">عملیاتی ${fmt(gl.ops_collection_rial || 0)}</div>
                <div class="mono" data-csp-style="${CSP.style(`color:${varTone(gl.variance_collection_rial)};font-size:12px`)}">Δ ${fmt(gl.variance_collection_rial || 0)}</div>
              </div>
              <div class="chq-gl-card">
                <div class="muted">۲۱۰۹ اسناد پرداختنی</div>
                <div class="mono" data-csp-style="${CSP.style(`font-weight:700`)}">${fmt(gl.gl_pay_2109_rial || 0)}</div>
                <div class="muted" data-csp-style="${CSP.style(`font-size:11px`)}">عملیاتی ${fmt(gl.ops_pay_rial || 0)}</div>
                <div class="mono" data-csp-style="${CSP.style(`color:${varTone(gl.variance_pay_rial)};font-size:12px`)}">Δ ${fmt(gl.variance_pay_rial || 0)}</div>
              </div>
            </div>
          </div>
        </div>
        <div class="panel">
          <div class="panel-head"><h4>✅ الزامات و صیاد</h4></div>
          <div class="panel-body">
            <div class="trsy-compliance">
              ${(d.compliance || []).map((c) => `
                <button type="button" class="trsy-comp-row" data-csp-click="${CSP.bind('click', function () { if (c.action_nav) go(c.action_nav); })}">
                  ${treasuryStatusChip(c.status)}
                  <div class="trsy-comp-text">
                    <div class="trsy-comp-label">${esc(c.label)}</div>
                    <div class="trsy-comp-detail">${esc(c.detail)}</div>
                  </div>
                  <span class="trsy-comp-go">‹</span>
                </button>`).join('') || '<div class="empty">موردی نیست</div>'}
            </div>
            <div class="trsy-conc" data-csp-style="${CSP.style(`margin-top:10px`)}">
              صیاد معتبر: <b>${fmt((d.sayadi && d.sayadi.rate_pct) || 0)}٪</b>
              · ${fmt((d.sayadi && d.sayadi.valid_count) || 0)} / ${fmt((d.sayadi && d.sayadi.total_open) || 0)} چک باز
            </div>
          </div>
        </div>
      </div>
      ${(d.alerts || []).length ? `
      <div class="panel trsy-alerts" data-csp-style="${CSP.style(`margin-top:12px`)}">
        <div class="panel-head"><h4>🔔 اقدام‌های پیشنهادی</h4></div>
        <div class="panel-body"><div class="trsy-alert-list">
          ${(d.alerts || []).map((a) => `
            <button type="button" class="trsy-alert-item" data-csp-click="${CSP.bind('click', function () { if (a.action_nav) go(a.action_nav); })}">
              ${treasuryStatusChip(a.severity)}
              <div><b>${esc(a.title)}</b><div class="muted" data-csp-style="${CSP.style(`font-size:12px;margin-top:2px`)}">${esc(a.detail)}</div></div>
            </button>`).join('')}
        </div></div>
      </div>` : ''}
      <div class="trsy-grid-2" data-csp-style="${CSP.style(`margin-top:12px`)}">
        <div class="panel">
          <div class="panel-head"><h4>📊 پیری سررسید (دریافتنی باز)</h4></div>
          <div class="panel-body tbl-wrap">
            <table class="tbl" data-csp-style="${CSP.style(`font-size:12px`)}"><thead><tr>
              <th>بازه</th><th>تعداد</th><th data-col-kind="money">مبلغ</th>
            </tr></thead><tbody>${(d.aging || []).map((a) => `<tr>
              <td>${esc(a.label || a.bucket)}</td><td class="mono">${fmt(a.count || 0)}</td><td class="mono">${fmt(a.amount_rial || 0)}</td>
            </tr>`).join('') || emptyRow(3)}</tbody></table>
          </div>
        </div>
        <div class="panel">
          <div class="panel-head"><h4>⚠️ سررسید گذشته / نزدیک</h4></div>
          <div class="panel-body tbl-wrap">
            <table class="tbl" data-csp-style="${CSP.style(`font-size:12px`)}"><thead><tr>
              <th>شماره</th><th>طرف</th><th>سررسید</th><th data-col-kind="money">مبلغ</th>
            </tr></thead><tbody>${[
              ...((d.highlights && d.highlights.overdue) || []).map((r) => `<tr>
                <td class="mono">${esc(r.cheque_number || '—')}</td><td>${esc(r.party_name || '—')}</td>
                <td class="mono" data-csp-style="${CSP.style(`color:var(--red)`)}">${esc(r.due_date || '—')}</td><td class="mono">${fmt(r.amount_rial || 0)}</td></tr>`),
              ...((d.highlights && d.highlights.due_soon) || []).slice(0, 4).map((r) => `<tr>
                <td class="mono">${esc(r.cheque_number || '—')}</td><td>${esc(r.party_name || '—')}</td>
                <td class="mono">${esc(r.due_date || '—')}</td><td class="mono">${fmt(r.amount_rial || 0)}</td></tr>`),
            ].join('') || emptyRow(4)}</tbody></table>
          </div>
        </div>
      </div>
      <div class="trsy-footnote muted">مبالغ به <b>ریال</b>. KPIهای افق از <code>/cheque-records/dashboard-kpis</code>؛ پرتفوی و پل دفتر از <code>/adv-reports/cheque-dashboard</code>.</div>`;
    if (typeof enhanceAccTables === 'function') enhanceAccTables(box);
  }

  async function renderChequebookReportTab(body) {
    body.innerHTML = `
      <div class="trsy-wrap">
        <div class="trsy-hero">
          <div>
            <div class="trsy-kicker">دفتر چک · موجودی برگه</div>
            <h3 class="trsy-title">گزارش دفتر چک و دسته</h3>
            <p class="trsy-lead">توالی برگ‌ها از دسته، باطل/مفقود، صادرشدهٔ پاس‌نشده، و گردش چک طرف‌حساب.</p>
          </div>
          <div class="trsy-hero-actions">
            <button class="btn sm ghost" data-csp-click="${CSP.bind('click', function () { loadAccTab('chequebook-report'); })}">↻ بروزرسانی</button>
            <button class="btn sm" data-csp-click="${CSP.bind('click', function () { go('acc-check-categories'); })}">دسته چک‌ها</button>
          </div>
        </div>
        <div id="chqBookBody"><div class="muted">در حال بارگذاری…</div></div>
      </div>`;
    await loadChequebookReport();
  }

  function leafStatusFa(st) {
    return ({ blank: 'سفید', issued: 'صادر', void: 'باطل', lost: 'مفقود', cancelled: 'لغو' })[st] || (st || '—');
  }

  async function loadChequebookReport() {
    const box = document.getElementById('chqBookBody');
    if (!box) return;
    box.innerHTML = '<div class="muted">در حال بارگذاری…</div>';
    let d = {};
    let party = {};
    try {
      d = await api('GET', '/adv-reports/chequebook-dashboard', null, false, true) || {};
    } catch (e) {
      box.innerHTML = `<div class="empty">${esc((e && e.message) || 'خواندن گزارش ناموفق بود')}</div>`;
      return;
    }
    try {
      party = await api('GET', '/adv-reports/party-cheque-turnover?limit=40', null, false, true) || {};
    } catch (_) {
      party = { parties: [], totals: {} };
    }
    const k = d.kpis || {};
    const pt = party.totals || {};
    const health = Number(d.health_score) || 0;
    const healthCls = health >= 85 ? 'trsy-ok' : (health >= 60 ? 'trsy-warn' : 'trsy-fail');
    box.innerHTML = `
      <div class="trsy-meta">
        <span>تاریخ: <b>${esc(d.as_of || '—')}</b></span>
        <span class="trsy-chip ${healthCls}">سلامت ${fmt(health)}٪</span>
      </div>
      <div class="rep-kpi-grid trsy-kpi">
        <div class="rep-kpi-card"><div class="kpi-icon">📒</div><div class="kpi-label">دسته چک</div><div class="kpi-val">${fmt(k.book_count || 0)}</div><div class="kpi-sub">${fmt(k.active_books || 0)} فعال</div></div>
        <div class="rep-kpi-card"><div class="kpi-icon">📄</div><div class="kpi-label">برگه کل</div><div class="kpi-val">${fmt(k.total_leaves || 0)}</div><div class="kpi-sub">مصرف ${fmt(k.used_leaves || 0)} · سفید ${fmt(k.blank_leaves || k.remaining_leaves || 0)}</div></div>
        <div class="rep-kpi-card"><div class="kpi-icon">🚫</div><div class="kpi-label">باطل/مفقود</div><div class="kpi-val">${fmt(k.void_lost_leaves || 0)}</div><div class="kpi-sub">گسست سریال ${fmt(k.serial_gaps || 0)}</div></div>
        <div class="rep-kpi-card"><div class="kpi-icon">⏳</div><div class="kpi-label">صادر پاس‌نشده</div><div class="kpi-val">${fmt(k.issued_uncleared_leaves || 0)}</div><div class="kpi-sub">کم‌موجود ${fmt(k.low_stock_books || 0)}</div></div>
      </div>
      <div class="trsy-grid-2">
        <div class="panel">
          <div class="panel-head"><h4>📑 موجودی دسته‌ها</h4></div>
          <div class="panel-body tbl-wrap">
            <table class="tbl" data-csp-style="${CSP.style(`font-size:12px`)}"><thead><tr>
              <th>دسته</th><th>بانک</th><th>برگه</th><th>مصرف</th><th>سفید</th><th>گسست</th><th>٪</th>
            </tr></thead><tbody>${(d.books || []).map((b) => `<tr>
              <td><b>${esc(b.name)}</b>${b.alerts && b.alerts.length ? ' ⚠️' : ''}${b.from_leaves_table ? '' : ' <span class="muted">(بدون برگ)</span>'}</td>
              <td>${esc(b.bank_name)}</td>
              <td class="mono">${fmt(b.leaf_count || 0)}</td>
              <td class="mono">${fmt(b.used_leaves || 0)}</td>
              <td class="mono">${b.remaining_leaves != null ? fmt(b.remaining_leaves) : '—'}</td>
              <td class="mono">${fmt(b.serial_gap_count || 0)}</td>
              <td><div class="trsy-share-cell"><span class="mono">${fmt(b.fill_pct || 0)}٪</span>${treasuryShareBar(b.fill_pct)}</div></td>
            </tr>`).join('') || emptyRow(7)}</tbody></table>
          </div>
        </div>
        <div class="panel">
          <div class="panel-head"><h4>✅ الزامات</h4></div>
          <div class="panel-body"><div class="trsy-compliance">
            ${(d.compliance || []).map((c) => `
              <button type="button" class="trsy-comp-row" data-csp-click="${CSP.bind('click', function () { if (c.action_nav) go(c.action_nav); })}">
                ${treasuryStatusChip(c.status)}
                <div class="trsy-comp-text"><div class="trsy-comp-label">${esc(c.label)}</div><div class="trsy-comp-detail">${esc(c.detail)}</div></div>
                <span class="trsy-comp-go">‹</span>
              </button>`).join('') || '<div class="empty">موردی نیست</div>'}
          </div>
          ${(d.banks_without || []).length ? `<div class="muted" data-csp-style="${CSP.style(`margin-top:8px;font-size:12px`)}">بانک بدون دسته: ${(d.banks_without || []).map((b) => esc(b.bank_name)).join('، ')}</div>` : ''}
          </div>
        </div>
      </div>
      <div class="trsy-grid-2" data-csp-style="${CSP.style(`margin-top:12px`)}">
        <div class="panel">
          <div class="panel-head"><h4>🚫 برگ باطل / مفقود / لغو</h4></div>
          <div class="panel-body tbl-wrap">
            <table class="tbl" data-csp-style="${CSP.style(`font-size:12px`)}"><thead><tr>
              <th>دسته</th><th>سریال</th><th>وضعیت</th><th>دلیل</th>
            </tr></thead><tbody>${(d.void_lost_leaves || []).map((r) => `<tr>
              <td>${esc(r.category_name || '—')}</td>
              <td class="mono">${esc(r.serial || '—')}</td>
              <td>${esc(leafStatusFa(r.status))}</td>
              <td class="muted">${esc(r.void_reason || '—')}</td>
            </tr>`).join('') || emptyRow(4)}</tbody></table>
          </div>
        </div>
        <div class="panel">
          <div class="panel-head"><h4>⏳ صادرشدهٔ پاس‌نشده</h4></div>
          <div class="panel-body tbl-wrap">
            <table class="tbl" data-csp-style="${CSP.style(`font-size:12px`)}"><thead><tr>
              <th>دسته</th><th>سریال</th><th>شماره چک</th><th>طرف</th><th>چرخه</th><th data-col-kind="money">مبلغ</th>
            </tr></thead><tbody>${(d.issued_uncleared || []).map((r) => `<tr>
              <td>${esc(r.category_name || '—')}</td>
              <td class="mono">${esc(r.serial || '—')}</td>
              <td class="mono">${esc(r.cheque_number || '—')}</td>
              <td>${esc(r.party_name || '—')}</td>
              <td class="mono muted">${esc(r.lifecycle_status || '—')}</td>
              <td class="mono">${fmt(r.amount_rial || 0)}</td>
            </tr>`).join('') || emptyRow(6)}</tbody></table>
          </div>
        </div>
      </div>
      ${(d.serial_gaps || []).length ? `
      <div class="panel" data-csp-style="${CSP.style(`margin-top:12px`)}">
        <div class="panel-head"><h4>🔢 گسست توالی سریال</h4></div>
        <div class="panel-body tbl-wrap">
          <table class="tbl" data-csp-style="${CSP.style(`font-size:12px`)}"><thead><tr>
            <th>دسته</th><th>پس از</th><th>قبل از</th><th>بازه مفقود</th><th>تعداد</th>
          </tr></thead><tbody>${(d.serial_gaps || []).map((g) => `<tr>
            <td>${esc(g.category_name || '—')}</td>
            <td class="mono">${esc(g.after_serial)}</td>
            <td class="mono">${esc(g.before_serial)}</td>
            <td class="mono">${esc(g.missing_from)} … ${esc(g.missing_to)}</td>
            <td class="mono">${fmt(g.missing_count || 0)}</td>
          </tr>`).join('')}</tbody></table>
        </div>
      </div>` : ''}
      <div class="panel" data-csp-style="${CSP.style(`margin-top:12px`)}">
        <div class="panel-head"><h4>🤝 گردش چک طرف‌حساب</h4></div>
        <div class="panel-body">
          <div class="cards" data-csp-style="${CSP.style(`margin-bottom:10px`)}">
            ${statCard('b', '📥', fmt(pt.received_count || 0), 'دریافتی · ' + fmt(pt.received_rial || 0) + ' ریال')}
            ${statCard('o', '✍️', fmt(pt.endorsed_count || 0), 'خرج‌شده · ' + fmt(pt.endorsed_rial || 0) + ' ریال')}
            ${statCard('r', '↩️', fmt(pt.bounced_count || 0), 'برگشتی · ' + fmt(pt.bounced_rial || 0) + ' ریال')}
          </div>
          <div class="tbl-wrap"><table class="tbl" data-csp-style="${CSP.style(`font-size:12px`)}"><thead><tr>
            <th>طرف</th><th>دریافتی</th><th>خرج‌شده</th><th>برگشتی</th><th data-col-kind="money">جمع ریال</th>
          </tr></thead><tbody>${(party.parties || []).map((p) => {
            const sum = (p.received_rial || 0) + (p.endorsed_rial || 0) + (p.bounced_rial || 0);
            return `<tr>
              <td>${esc(p.party_name || '—')}</td>
              <td class="mono">${fmt(p.received_count || 0)} · ${fmt(p.received_rial || 0)}</td>
              <td class="mono">${fmt(p.endorsed_count || 0)} · ${fmt(p.endorsed_rial || 0)}</td>
              <td class="mono">${fmt(p.bounced_count || 0)} · ${fmt(p.bounced_rial || 0)}</td>
              <td class="mono">${fmt(sum)}</td>
            </tr>`;
          }).join('') || emptyRow(5)}</tbody></table></div>
        </div>
      </div>
      <div class="panel" data-csp-style="${CSP.style(`margin-top:12px`)}">
        <div class="panel-head"><h4>📤 آخرین چک‌های پرداختنی (دفتر)</h4></div>
        <div class="panel-body tbl-wrap">
          <table class="tbl" data-csp-style="${CSP.style(`font-size:12px`)}"><thead><tr>
            <th>شماره</th><th>طرف</th><th>سررسید</th><th>چرخه</th><th data-col-kind="money">مبلغ</th>
          </tr></thead><tbody>${(d.recent_payable || []).map((r) => `<tr>
            <td class="mono">${esc(r.cheque_number || '—')}</td><td>${esc(r.party_name || '—')}</td>
            <td class="mono">${esc(r.due_date || '—')}</td><td class="mono muted">${esc(r.lifecycle_status || '—')}</td><td class="mono">${fmt(r.amount_rial || 0)}</td>
          </tr>`).join('') || emptyRow(5)}</tbody></table>
        </div>
      </div>`;
    if (typeof enhanceAccTables === 'function') enhanceAccTables(box);
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
          <div class="cards" data-csp-style="${CSP.style(`margin-bottom:12px`)}">
            ${statCard('r', '📤', fmt(d.output_vat_rial || 0), 'مالیات فروش (ریال)')}
            ${statCard('b', '📥', fmt(d.input_vat_rial || 0), 'مالیات خرید (ریال)')}
            ${statCard('o', '💰', fmt(d.net_payable_rial || 0), 'خالص قابل پرداخت (ریال)')}
          </div>
          <div class="muted" data-csp-style="${CSP.style(`font-size:12px`)}">بازه ${esc(d.from)} — ${esc(d.to)} ${d.quarter ? '(' + esc(d.quarter) + ')' : ''}</div>`;
      } else {
        const d = await api('GET', '/adv-reports/seasonal-169?quarter=' + encodeURIComponent(q)) || {};
        box.innerHTML = `
          <div class="cards" data-csp-style="${CSP.style(`margin-bottom:12px`)}">
            ${statCard('g', '🛒', fmt(d.totals?.sales_rial || 0), 'فروش فصلی (' + fmt(d.totals?.sales_count || 0) + ' فاکتور)')}
            ${statCard('b', '📦', fmt(d.totals?.purchase_rial || 0), 'خرید فصلی (' + fmt(d.totals?.purchase_count || 0) + ' فاکتور)')}
          </div>
          <div data-csp-style="${CSP.style(`display:grid;grid-template-columns:1fr 1fr;gap:12px`)}">
            <div class="panel"><div class="panel-head"><h4>فروش</h4></div><div class="panel-body tbl-wrap"><table class="tbl" data-csp-style="${CSP.style(`font-size:11px`)}"><thead><tr>
              <th>شماره</th><th>تاریخ</th><th>طرف</th><th>مبلغ</th>
            </tr></thead><tbody>${(d.sales || []).slice(0, 30).map(r => `<tr>
              <td class="mono">${esc(r.num)}</td><td>${escDate(r.date)}</td><td>${esc(r.party_name)}</td><td class="mono">${fmt(r.amount_rial)}</td>
            </tr>`).join('') || emptyRow(4)}</tbody></table></div></div>
            <div class="panel"><div class="panel-head"><h4>خرید</h4></div><div class="panel-body tbl-wrap"><table class="tbl" data-csp-style="${CSP.style(`font-size:11px`)}"><thead><tr>
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

  function inviteTokenFromLocation() {
    try {
      const u = new URL(location.href);
      if (u.pathname.replace(/\/+$/, '') === '/invite') return String(u.searchParams.get('token') || '').trim();
    } catch (_) { /* ignore */ }
    return '';
  }

  function setInviteMsg(text, isErr) {
    const box = typeof el === 'function' ? el('hr-invite-msg') : document.getElementById('hr-invite-msg');
    if (!box) return;
    box.textContent = text || '';
    box.style.color = isErr ? '#dc2626' : '';
  }

  async function copyInviteLink(url) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(url);
      else {
        const ta = document.createElement('textarea');
        ta.value = url;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      if (typeof showToast === 'function') showToast('لینک دعوت کپی شد');
    } catch (_) {
      if (typeof showToast === 'function') showToast('کپی نشد — لینک را دستی بردارید', 'error');
    }
  }

  function inviteRoleOptionsHtml() {
    const actor = (typeof ME !== 'undefined' && ME && ME.role) ? ME.role : '';
    const rows = [
      ['field_sales', 'کارشناس میدانی (حضوری)'],
      ['inside_sales', 'کارشناس داخلی (تلفنی)'],
      ['distribution_office', 'دفتر پخش'],
      ['sales_manager', 'مدیر فروش'],
      ['production_manager', 'مدیر تولید'],
      ['production_operator', 'اپراتور تولید'],
      ['unit_manager', 'مدیر واحد عملیاتی'],
      ['department_manager', 'مدیر بخش'],
    ];
    if (actor === 'admin') rows.splice(4, 0, ['accounting', 'حسابدار (بخش حسابداری)']);
    return rows.map(([value, label]) =>
      `<option value="${value}" ${value === 'field_sales' ? 'selected' : ''}>${label}</option>`
    ).join('');
  }

  function showInviteLinkModal(abs) {
    if (typeof openModal !== 'function') {
      if (typeof showToast === 'function') showToast('دعوت ساخته شد');
      return;
    }
    openModal(`
      <div class="modal-head"><h3>دعوت به ورود</h3><button class="x" data-csp-click="${CSP.bind('click', function () { closeModal(); })}">×</button></div>
      <div class="modal-body">
        <p class="muted" data-csp-style="${CSP.style('font-size:13px;line-height:1.9;margin-bottom:10px')}">لینک یک‌بارمصرف است و تا ۷۲ ساعت اعتبار دارد. رمز از پیش ساخته نمی‌شود؛ دعوت‌شونده خودش نام کاربری و رمز را انتخاب می‌کند. نقش را دعوت‌کننده انتخاب کرده و دعوت‌شونده نمی‌تواند آن را عوض کند.</p>
        <div class="fg full"><label>لینک دعوت</label>
          <input id="hr-invite-url" dir="ltr" readonly value="${esc(abs)}"></div>
      </div>
      <div class="modal-foot">
        <button class="btn" data-csp-click="${CSP.bind('click', function () { copyInviteLink(abs); })}">کپی لینک</button>
        <button class="btn ghost" data-csp-click="${CSP.bind('click', function () { closeModal(); })}">بستن</button>
      </div>`);
  }

  async function sendPersonInvite(personId) {
    const id = parseInt(personId, 10);
    const roleEl = typeof el === 'function' ? el('hr-invite-role') : document.getElementById('hr-invite-role');
    const role = roleEl ? String(roleEl.value || '').trim() : '';
    try {
      const r = await api('POST', '/users/invitations', { person_id: id, role: role || undefined });
      const path = r.invite_url || ('/invite?token=' + encodeURIComponent(r.token));
      showInviteLinkModal((location.origin || '') + path);
    } catch (e) {
      if (typeof showToast === 'function') showToast((e && e.message) || 'خطا در ساخت دعوت', 'error');
    }
  }

  async function invitePersonUser(personId) {
    const id = parseInt(personId, 10);
    if (!id) {
      if (typeof showToast === 'function') showToast('ابتدا شخص را ذخیره کنید', 'error');
      return;
    }
    if (typeof openModal !== 'function') {
      try {
        const r = await api('POST', '/users/invitations', { person_id: id });
        if (typeof showToast === 'function') showToast('دعوت ساخته شد');
        return r;
      } catch (e) {
        if (typeof showToast === 'function') showToast((e && e.message) || 'خطا در ساخت دعوت', 'error');
        return;
      }
    }
    openModal(`
      <div class="modal-head"><h3>دعوت به ورود</h3><button class="x" data-csp-click="${CSP.bind('click', function () { closeModal(); })}">×</button></div>
      <div class="modal-body">
        <p class="muted" data-csp-style="${CSP.style('font-size:13px;line-height:1.9;margin-bottom:10px')}">نقش ورود را انتخاب کنید. مدیر سیستم قابل دعوت نیست. حسابدار فقط توسط مدیر دعوت می‌شود.</p>
        <div class="fg full"><label>نقش</label>
          <select id="hr-invite-role">${inviteRoleOptionsHtml()}</select></div>
      </div>
      <div class="modal-foot">
        <button class="btn" data-csp-click="${CSP.bind('click', function () { sendPersonInvite(id); })}">ساخت لینک دعوت</button>
        <button class="btn ghost" data-csp-click="${CSP.bind('click', function () { closeModal(); })}">انصراف</button>
      </div>`);
  }

  async function submitInviteAccept(token) {
    const userEl = document.getElementById('hr-invite-user');
    const passEl = document.getElementById('hr-invite-pass');
    const pass2El = document.getElementById('hr-invite-pass2');
    const username = (userEl && userEl.value || '').trim();
    const password = passEl && passEl.value || '';
    const password2 = pass2El && pass2El.value || '';
    if (!username || username.length < 3) { setInviteMsg('نام کاربری باید حداقل ۳ کاراکتر باشد', true); return; }
    if (password !== password2) { setInviteMsg('تکرار رمز یکسان نیست', true); return; }
    setInviteMsg('در حال ثبت…');
    try {
      const res = await fetch('/api/auth/invite/' + encodeURIComponent(token) + '/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      let j = {};
      try { j = await res.json(); } catch (_) { j = {}; }
      if (!res.ok) { setInviteMsg(j.error || 'پذیرش دعوت ناموفق بود', true); return; }
      setInviteMsg('حساب ساخته شد. اکنون می‌توانید وارد شوید.');
      const form = document.getElementById('hr-invite-form');
      if (form) form.style.display = 'none';
      const loginForm = document.getElementById('loginForm');
      if (loginForm) loginForm.style.display = '';
      const loginUser = document.getElementById('loginUser');
      if (loginUser) loginUser.value = j.username || username;
    } catch (_) {
      setInviteMsg('خطای ارتباط با سرور', true);
    }
  }

  async function renderInviteAccept(token) {
    const card = document.querySelector('#login .login-card');
    const form = document.getElementById('loginForm');
    if (!card) return;
    if (form) form.style.display = 'none';
    let panel = document.getElementById('hr-invite-panel');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'hr-invite-panel';
      card.appendChild(panel);
    }
    panel.innerHTML = '<p class="muted">در حال بررسی لینک دعوت…</p>';
    try {
      const res = await fetch('/api/auth/invite/' + encodeURIComponent(token));
      let j = {};
      try { j = await res.json(); } catch (_) { j = {}; }
      const status = j.status || 'invalid';
      const name = j.person_name ? esc(j.person_name) : '';
      if (status === 'valid') {
        panel.innerHTML = `
          <p>دعوت برای ${name || 'همکار'}</p>
          <p class="muted" data-csp-style="${CSP.style('font-size:13px;line-height:1.8;margin:8px 0 12px')}">نام کاربری و رمز خود را انتخاب کنید. رمز حداقل ۸ کاراکتر و شامل حرف و عدد است.</p>
          <form id="hr-invite-form">
            <div class="field"><label>نام کاربری</label><input id="hr-invite-user" dir="ltr" autocomplete="username"></div>
            <div class="field"><label>رمز عبور</label><input id="hr-invite-pass" type="password" dir="ltr" autocomplete="new-password"></div>
            <div class="field"><label>تکرار رمز</label><input id="hr-invite-pass2" type="password" dir="ltr" autocomplete="new-password"></div>
            <button type="submit">ساخت حساب و ورود</button>
          </form>
          <div class="login-err" id="hr-invite-msg"></div>`;
        const inviteForm = document.getElementById('hr-invite-form');
        if (inviteForm) {
          inviteForm.addEventListener('submit', function (ev) {
            ev.preventDefault();
            submitInviteAccept(token);
          });
        }
      } else if (status === 'expired') {
        panel.innerHTML = `<p>لینک دعوت ${name ? 'برای ' + name + ' ' : ''}منقضی شده است. از مدیر بخواهید دعوت جدید بفرستد.</p>`;
      } else if (status === 'used') {
        panel.innerHTML = `<p>این دعوت قبلاً استفاده شده است. از صفحه ورود وارد شوید.</p>
          <p><a href="/">بازگشت به ورود</a></p>`;
      } else {
        panel.innerHTML = '<p>لینک دعوت نامعتبر است.</p><p><a href="/">بازگشت به ورود</a></p>';
      }
    } catch (_) {
      panel.innerHTML = '<p>خطای ارتباط با سرور.</p>';
    }
  }

  function maybeShowInviteAccept() {
    const token = inviteTokenFromLocation();
    if (!token) return false;
    global.__HR_INVITE_ACTIVE = true;
    renderInviteAccept(token);
    return true;
  }

  function pcMoneyTone(n) {
    const v = Number(n) || 0;
    if (v > 0) return 'var(--red)';
    if (v < 0) return 'var(--green)';
    return 'var(--text)';
  }

  /** نمایش فشردهٔ ارقام بزرگ برای KPI (ریال) */
  function pcFmtCompact(n) {
    const raw = Number(n) || 0;
    const sign = raw < 0 ? '−' : '';
    const v = Math.abs(raw);
    if (v >= 1e12) return sign + (Math.round(v / 1e10) / 100).toLocaleString('fa-IR') + ' هزارمیلیارد';
    if (v >= 1e9) return sign + (Math.round(v / 1e7) / 100).toLocaleString('fa-IR') + ' میلیارد';
    if (v >= 1e6) return sign + (Math.round(v / 1e4) / 100).toLocaleString('fa-IR') + ' میلیون';
    return sign + fmt(v);
  }

  function pcRiskChip(level) {
    const map = {
      high: { cls: 'trsy-fail', label: 'بحرانی' },
      medium: { cls: 'trsy-warn', label: 'توجه' },
      ok: { cls: 'trsy-ok', label: 'عادی' },
    };
    const m = map[level] || map.ok;
    return `<span class="trsy-chip ${m.cls}">${m.label}</span>`;
  }

  function pcSetFilter(map) {
    const g = (id) => document.getElementById(id);
    if (!map) return;
    if (map.risk != null && g('pcRisk')) g('pcRisk').value = map.risk;
    if (map.side != null && g('pcSide')) g('pcSide').value = map.side;
    if (map.balance != null && g('pcBalance')) g('pcBalance').value = map.balance;
    if (map.role != null && g('pcRole')) g('pcRole').value = map.role;
    if (Object.prototype.hasOwnProperty.call(map, 'aging_bucket') && g('pcAging')) {
      g('pcAging').value = map.aging_bucket || '';
    } else if (g('pcAging') && (map.risk != null || map.role != null)) {
      g('pcAging').value = '';
    }
    if (map.sort != null && g('pcSort')) g('pcSort').value = map.sort;
    if (map.expert_id != null && g('pcExpert')) g('pcExpert').value = String(map.expert_id);
    loadPartyControlDashboard();
  }

  function pcOpenCard(partyId) {
    const id = Number(partyId) || 0;
    if (!id) { go('acc-parties'); return; }
    if (typeof partyModal === 'function') partyModal(id);
    else go('acc-parties');
  }

  function pcOpenTurnover(partyId, name, roleHint) {
    const id = Number(partyId) || 0;
    if (!id || typeof showPartyTurnover !== 'function') return;
    const roleSel = (document.getElementById('pcRole') || {}).value || '';
    let role = roleHint || roleSel || undefined;
    if (role && !['customer', 'supplier', 'person'].includes(String(role))) {
      role = 'person'; // employee / shareholder / other → دفتر شخص
    }
    const ok = role && ['customer', 'supplier', 'person'].includes(String(role)) ? role : undefined;
    showPartyTurnover(id, name || ('#' + id), ok);
  }

  function pcOpenStatement(custId) {
    const cid = Number(custId) || 0;
    if (!cid) { go('acc-statement'); return; }
    try { if (typeof stmtCustId !== 'undefined') stmtCustId = cid; } catch (_) { /* */ }
    go('acc-statement');
  }

  function pcAgingBar(aging) {
    const a = aging || {};
    const total = Math.max(1, Number(a.total) || 0);
    const parts = [
      { key: 'b0_30', label: '۰–۳۰', color: 'var(--pc-age-0)', v: a.b0_30 || 0 },
      { key: 'b31_60', label: '۳۱–۶۰', color: 'var(--pc-age-1)', v: a.b31_60 || 0 },
      { key: 'b61_90', label: '۶۱–۹۰', color: 'var(--pc-age-2)', v: a.b61_90 || 0 },
      { key: 'b90plus', label: '۹۰+', color: 'var(--pc-age-3)', v: a.b90plus || 0 },
    ];
    return `
      <div class="pc-aging">
        <div class="pc-aging-track" role="img" aria-label="پیری مطالبات">${parts.map((p) => {
          const w = Math.max(0, Math.round((p.v / total) * 1000) / 10);
          if (!w && !p.v) return '';
          return `<button type="button" class="pc-aging-seg" title="${p.label}: ${fmt(p.v)}"
            data-csp-style="${CSP.style(`width:${Math.max(w, p.v ? 2 : 0)}%;background:${p.color}`)}"
            data-csp-click="${CSP.bind('click', function () { pcSetFilter({ aging_bucket: p.key, side: 'debit', balance: 'nonzero' }); })}"></button>`;
        }).join('')}</div>
        <div class="pc-aging-legend">${parts.map((p) => `
          <button type="button" class="pc-aging-leg" data-csp-click="${CSP.bind('click', function () { pcSetFilter({ aging_bucket: p.key, side: 'debit', balance: 'nonzero' }); })}">
            <i data-csp-style="${CSP.style(`background:${p.color}`)}"></i>
            <b>${p.label}</b>
            <span class="mono">${pcFmtCompact(p.v)}</span>
          </button>`).join('')}</div>
      </div>`;
  }

  async function renderPartyControlDashboardTab(body) {
    body.innerHTML = `
      <div class="trsy-wrap pc-dash">
        <div class="trsy-hero pc-hero">
          <div class="pc-hero-text">
            <div class="trsy-kicker">حسابداری · کنترل حساب</div>
            <h3 class="trsy-title">داشبورد کنترل حساب اشخاص</h3>
            <p class="trsy-lead">مانده زنده party-books · صف اقدام اولویت‌دار · پیری FIFO · سقف اعتبار</p>
          </div>
          <div class="trsy-hero-actions">
            <button type="button" class="btn sm ghost" data-csp-click="${CSP.bind('click', function () { loadPartyControlDashboard(); })}">↻ بروزرسانی</button>
            <button type="button" class="btn sm" data-csp-click="${CSP.bind('click', function () { go('acc-parties'); })}">اشخاص</button>
            <button type="button" class="btn sm ghost" data-csp-click="${CSP.bind('click', function () { go('acc-receivables'); })}">مطالبات</button>
            <button type="button" class="btn sm ghost" data-csp-click="${CSP.bind('click', function () { exportPartyControlCsv(); })}">CSV</button>
          </div>
        </div>
        <div class="pc-filter-bar" id="pcDashFilters">
          <input id="pcSearch" class="pc-filter-input" type="search" placeholder="جستجو نام / تلفن / کد / تفصیلی…" autocomplete="off" />
          <select id="pcExpert" class="pc-filter-select" title="کارشناس">
            <option value="">همه کارشناسان</option>
            <option value="none">بدون کارشناس</option>
          </select>
          <select id="pcRole" class="pc-filter-select" title="سمت">
            <option value="">همه سمت‌ها</option>
            <option value="customer">مشتری</option>
            <option value="supplier">تأمین‌کننده</option>
            <option value="employee">کارمند</option>
            <option value="shareholder">سهامدار</option>
            <option value="other">سایر</option>
          </select>
          <select id="pcSide" class="pc-filter-select" title="سمت مانده">
            <option value="all">بدهکار و بستانکار</option>
            <option value="debit">فقط بدهکار</option>
            <option value="credit">فقط بستانکار</option>
          </select>
          <select id="pcBalance" class="pc-filter-select" title="مانده">
            <option value="nonzero">فقط مانده‌دار</option>
            <option value="all">همه</option>
            <option value="zero">مانده صفر</option>
          </select>
          <select id="pcRisk" class="pc-filter-select" title="ریسک">
            <option value="all">همه ریسک‌ها</option>
            <option value="high">بحرانی</option>
            <option value="medium">توجه+</option>
            <option value="over_credit">عبور از سقف</option>
            <option value="mismatch">اختلاف دفتر</option>
          </select>
          <select id="pcAging" class="pc-filter-select" title="پیری">
            <option value="">همه سطل‌های پیری</option>
            <option value="b0_30">۰–۳۰ روز</option>
            <option value="b31_60">۳۱–۶۰ روز</option>
            <option value="b61_90">۶۱–۹۰ روز</option>
            <option value="b90plus">۹۰+ روز</option>
          </select>
          <select id="pcSort" class="pc-filter-select" title="مرتب‌سازی">
            <option value="balance_abs">مرتب: بزرگ‌ترین مانده</option>
            <option value="risk">مرتب: ریسک</option>
            <option value="aging">مرتب: پیری</option>
            <option value="credit_util">مرتب: مصرف اعتبار</option>
            <option value="name">مرتب: نام</option>
            <option value="balance">مرتب: مانده امضاشده</option>
          </select>
          <button type="button" class="btn sm" data-csp-click="${CSP.bind('click', function () { loadPartyControlDashboard(); })}">اعمال</button>
          <button type="button" class="btn sm ghost" data-csp-click="${CSP.bind('click', function () {
            ['pcSearch','pcExpert','pcRole','pcSide','pcBalance','pcRisk','pcAging','pcSort'].forEach(function (id) {
              const el = document.getElementById(id);
              if (!el) return;
              if (id === 'pcSide') el.value = 'all';
              else if (id === 'pcBalance') el.value = 'nonzero';
              else if (id === 'pcRisk') el.value = 'all';
              else if (id === 'pcSort') el.value = 'balance_abs';
              else el.value = '';
            });
            loadPartyControlDashboard();
          })}">پاک‌کردن</button>
        </div>
        <div class="pc-quick-chips" id="pcQuickChips"></div>
        <div id="pcDashBody"><div class="pc-loading">در حال بارگذاری داشبورد کنترل اشخاص…</div></div>
      </div>`;
    const searchEl = document.getElementById('pcSearch');
    if (searchEl) {
      let t = null;
      searchEl.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') { ev.preventDefault(); loadPartyControlDashboard(); }
      });
      searchEl.addEventListener('input', function () {
        clearTimeout(t);
        t = setTimeout(function () { loadPartyControlDashboard(); }, 420);
      });
    }
    ['pcExpert', 'pcRole', 'pcSide', 'pcBalance', 'pcRisk', 'pcAging', 'pcSort'].forEach(function (id) {
      const el = document.getElementById(id);
      if (el) el.addEventListener('change', function () { loadPartyControlDashboard(); });
    });
    await loadPartyControlDashboard();
  }

  function fillPcExpertOptions(experts, unassignedCount) {
    const sel = document.getElementById('pcExpert');
    if (!sel) return;
    const cur = sel.value;
    const opts = ['<option value="">همه کارشناسان</option>'];
    opts.push(`<option value="none">بدون کارشناس${unassignedCount ? ' (' + fmt(unassignedCount) + ')' : ''}</option>`);
    for (const e of experts || []) {
      const id = Number(e.id) || 0;
      if (!id) continue;
      opts.push(`<option value="${id}">${esc(e.name || ('#' + id))} (${fmt(e.count || 0)})</option>`);
    }
    sel.innerHTML = opts.join('');
    if ([...sel.options].some((o) => o.value === cur)) sel.value = cur;
  }

  async function loadPartyControlDashboard() {
    const box = document.getElementById('pcDashBody');
    if (!box) return;
    box.innerHTML = '<div class="pc-loading">در حال بارگذاری داشبورد کنترل اشخاص…</div>';
    const qp = [];
    const g = (id) => document.getElementById(id);
    const search = (g('pcSearch') && g('pcSearch').value) || '';
    const expert = (g('pcExpert') && g('pcExpert').value) || '';
    const role = (g('pcRole') && g('pcRole').value) || '';
    const side = (g('pcSide') && g('pcSide').value) || 'all';
    const balance = (g('pcBalance') && g('pcBalance').value) || 'nonzero';
    const risk = (g('pcRisk') && g('pcRisk').value) || 'all';
    const agingBucket = (g('pcAging') && g('pcAging').value) || '';
    const sort = (g('pcSort') && g('pcSort').value) || 'balance_abs';
    if (search) qp.push('search=' + encodeURIComponent(search));
    if (expert) qp.push('expert_id=' + encodeURIComponent(expert));
    if (role) qp.push('role=' + encodeURIComponent(role));
    if (side) qp.push('side=' + encodeURIComponent(side));
    if (balance) qp.push('balance=' + encodeURIComponent(balance));
    if (risk && risk !== 'all') qp.push('risk=' + encodeURIComponent(risk));
    if (agingBucket) qp.push('aging_bucket=' + encodeURIComponent(agingBucket));
    if (sort) qp.push('sort=' + encodeURIComponent(sort));
    qp.push('limit=300');
    let d = {};
    try {
      d = await api('GET', '/adv-reports/party-control-dashboard' + (qp.length ? '?' + qp.join('&') : ''), null, false, true) || {};
    } catch (e) {
      box.innerHTML = `<div class="pc-empty pc-empty-error"><b>خواندن داشبورد ناموفق بود</b><p>${esc((e && e.message) || 'خطای شبکه')}</p>
        <button type="button" class="btn sm" data-csp-click="${CSP.bind('click', function () { loadPartyControlDashboard(); })}">تلاش دوباره</button></div>`;
      return;
    }
    window._pcDashLast = d;
    fillPcExpertOptions(d.experts, d.unassigned_count);
    const k = d.kpis || {};
    const liveAt = new Date(d.generated_at || Date.now()).toLocaleString('fa-IR');
    const health = Number(d.health_score) || 0;
    const healthCls = health >= 85 ? 'trsy-ok' : (health >= 60 ? 'trsy-warn' : 'trsy-fail');

    const chips = document.getElementById('pcQuickChips');
    if (chips) {
      chips.innerHTML = [
        { label: 'بحرانی', filter: { risk: 'high', balance: 'nonzero' }, n: k.high_risk_count },
        { label: 'سقف اعتبار', filter: { risk: 'over_credit', balance: 'nonzero' }, n: k.over_credit_count },
        { label: 'اختلاف دفتر', filter: { risk: 'mismatch', balance: 'all' }, n: k.mismatch_count },
        { label: 'پیری ۹۰+', filter: { aging_bucket: 'b90plus', side: 'debit', balance: 'nonzero' }, n: null },
        { label: 'فقط بدهکار', filter: { side: 'debit', balance: 'nonzero' }, n: null },
      ].map((c) => `<button type="button" class="pc-chip-btn${(risk === 'high' && c.filter.risk === 'high') || (risk === c.filter.risk) || (agingBucket && c.filter.aging_bucket === agingBucket) ? ' active' : ''}"
        data-csp-click="${CSP.bind('click', function () { pcSetFilter(c.filter); })}">${esc(c.label)}${c.n != null ? ` <b>${fmt(c.n)}</b>` : ''}</button>`).join('');
    }

    const alertsHtml = (d.alerts || []).length
      ? `<div class="pc-alerts">${(d.alerts || []).map((a) => `
          <div class="pc-alert ${a.severity === 'fail' ? 'pc-alert-fail' : 'pc-alert-warn'}">
            <div class="pc-alert-body"><b>${esc(a.title || '')}</b><span>${esc(a.detail || '')}</span></div>
            <button type="button" class="btn sm ghost" data-csp-click="${CSP.bind('click', function () {
              if (a.action_filter) pcSetFilter(a.action_filter);
              else if (a.action_nav) go(a.action_nav);
            })}">نمایش موارد</button>
          </div>`).join('')}</div>`
      : '';

    const roleRows = (d.by_role || []).map((r) => `
      <tr class="pc-role-row" data-csp-click="${CSP.bind('click', function () {
        pcSetFilter({ role: r.role || '', balance: 'nonzero' });
      })}">
        <td><b>${esc(r.label || r.role || '')}</b></td>
        <td class="mono">${fmt(r.count || 0)}</td>
        <td class="mono">${fmt(r.with_balance || 0)}</td>
        <td class="mono pc-num-debit">${pcFmtCompact(r.debit_rial || 0)}</td>
        <td class="mono pc-num-credit">${pcFmtCompact(r.credit_rial || 0)}</td>
      </tr>`).join('') || emptyRow(5);

    const workRows = (d.worklist || []).map((w, idx) => `
      <tr class="pc-work-row pc-risk-${esc(w.risk_level || 'ok')}">
        <td class="pc-work-rank mono">${fmt(idx + 1)}</td>
        <td>
          <b>${esc(w.name)}</b>
          <div class="pc-row-meta">${esc((w.role_labels || w.party_roles || []).join(' · '))}${w.expert_name ? ' · ' + esc(w.expert_name) : ''}${w.coa_code ? ' · ' + esc(w.coa_code) : ''}</div>
        </td>
        <td class="mono pc-bal" data-csp-style="${CSP.style(`color:${pcMoneyTone(w.balance_rial)}`)}" title="${fmt(w.balance_rial || 0)}">${pcFmtCompact(w.balance_rial || 0)}</td>
        <td>${pcRiskChip(w.risk_level)}${w.aging_days != null ? ` <span class="muted mono">${fmt(w.aging_days)}د</span>` : ''}${w.books_mismatch ? ' <span class="pc-chip pc-chip-warn">اختلاف</span>' : ''}${w.over_credit ? ' <span class="pc-chip pc-chip-warn">سقف</span>' : ''}</td>
        <td class="pc-next">${esc(w.next_action || '')}</td>
        <td class="pc-actions">
          <button type="button" class="btn sm blue" data-csp-click="${CSP.bind('click', function () { pcOpenTurnover(w.id, w.name, w.primary_role); })}">گردش</button>
          <button type="button" class="btn sm ghost" data-csp-click="${CSP.bind('click', function () { pcOpenCard(w.id); })}">کارت</button>
          ${w.linked_customer_id
            ? `<button type="button" class="btn sm ghost" data-csp-click="${CSP.bind('click', function () { pcOpenStatement(w.linked_customer_id); })}">صورت‌حساب</button>`
            : ''}
        </td>
      </tr>`).join('') || `<tr><td colspan="6"><div class="pc-empty">موردی در صف اقدام با فیلتر فعلی نیست.</div></td></tr>`;

    const conc = d.concentration || {};
    const concRows = (conc.top_debtors || []).map((t, i) => `
      <tr class="pc-party-row" data-csp-click="${CSP.bind('click', function () { pcOpenTurnover(t.id, t.name); })}">
        <td class="mono">${fmt(i + 1)}</td>
        <td><b>${esc(t.name)}</b>${t.expert_name ? `<div class="pc-row-meta">${esc(t.expert_name)}</div>` : ''}</td>
        <td class="mono pc-num-debit">${pcFmtCompact(t.balance_rial || 0)}</td>
      </tr>`).join('') || emptyRow(3);

    const partyRows = (d.parties || []).map((p) => `
      <tr class="pc-party-row">
        <td>
          <b>${esc(p.name)}</b>
          <div class="pc-row-meta">${esc(p.person_code || '')}${p.city ? ' · ' + esc(p.city) : ''}${p.phone ? ' · ' + esc(p.phone) : ''}${p.expert_name ? ' · ' + esc(p.expert_name) : ''}</div>
          <div class="pc-role-chips">${(p.role_labels || []).map((x) => `<span class="pc-chip">${esc(x)}</span>`).join('')}${p.position_name ? `<span class="pc-chip pc-chip-pos">${esc(p.position_name)}</span>` : ''}</div>
        </td>
        <td class="mono muted">${esc(p.coa_code || '—')}</td>
        <td class="mono" data-csp-style="${CSP.style(`font-weight:700;color:${pcMoneyTone(p.balance_rial)}`)}" title="${fmt(p.balance_rial || 0)}">${pcFmtCompact(p.balance_rial || 0)}</td>
        <td class="mono pc-num-debit" title="${fmt(p.debit_rial || 0)}">${pcFmtCompact(p.debit_rial || 0)}</td>
        <td class="mono pc-num-credit" title="${fmt(p.credit_rial || 0)}">${pcFmtCompact(p.credit_rial || 0)}</td>
        <td>
          ${p.credit_limit_rial > 0
            ? `<div class="mono pc-credit-line">${pcFmtCompact(p.credit_used_rial || 0)} / ${pcFmtCompact(p.credit_limit_rial)}</div>
               <div class="pc-util"><i data-csp-style="${CSP.style(`width:${Math.min(100, p.credit_util_pct || 0)}%;background:${p.over_credit ? 'var(--red)' : 'var(--green)'}`)}"></i></div>
               <div class="pc-row-meta">${fmt(p.credit_util_pct || 0)}٪${p.over_credit ? ' · عبور' : ''}</div>`
            : '<span class="muted">نامحدود</span>'}
        </td>
        <td>${p.aging_days != null ? `<span class="mono">${fmt(p.aging_days)}</span> روز` : '—'}
          ${p.books_mismatch ? '<div class="pc-chip pc-chip-warn">اختلاف دفتر</div>' : ''}
        </td>
        <td>${pcRiskChip(p.risk_level)}</td>
        <td class="pc-actions">
          <button type="button" class="btn sm blue" data-csp-click="${CSP.bind('click', function () { pcOpenTurnover(p.id, p.name, p.primary_role); })}">گردش</button>
          <button type="button" class="btn sm ghost" data-csp-click="${CSP.bind('click', function () { pcOpenCard(p.id); })}">کارت</button>
          ${p.linked_customer_id
            ? `<button type="button" class="btn sm ghost" data-csp-click="${CSP.bind('click', function () { pcOpenStatement(p.linked_customer_id); })}">صورت‌حساب</button>`
            : ''}
        </td>
      </tr>`).join('') || `<tr><td colspan="9"><div class="pc-empty">ردیفی با فیلتر فعلی یافت نشد.</div></td></tr>`;

    const fDeb = Number(k.total_debit_rial) || 0;
    const fCred = Number(k.total_credit_rial) || 0;
    const footDeb = (d.parties || []).reduce((s, r) => s + (Number(r.debit_rial) || 0), 0);
    const footCred = (d.parties || []).reduce((s, r) => s + (Number(r.credit_rial) || 0), 0);
    const footBal = (d.parties || []).reduce((s, r) => s + (Number(r.balance_rial) || 0), 0);

    box.innerHTML = `
      <div class="trsy-meta pc-meta">
        <span class="trsy-chip trsy-ok">مانده زنده</span>
        <span>بروزرسانی: ${esc(liveAt)}</span>
        <span class="trsy-chip ${healthCls}">سلامت ${fmt(health)}٪</span>
        <span>نمایش ${fmt((d.parties || []).length)} از ${fmt(k.parties_filtered || 0)} · کل ${fmt(k.parties_total || 0)}${expert ? ' · کارشناس ' + fmt(k.parties_in_scope || 0) : ''}</span>
      </div>
      ${alertsHtml}

      <div class="pc-kpi-grid trsy-kpi">
        <div class="rep-kpi-card pc-kpi pc-kpi-debit" title="${fmt(fDeb)}">
          <div class="kpi-label">جمع بدهکار</div>
          <div class="kpi-val" data-csp-style="${CSP.style(`color:var(--red)`)}">${pcFmtCompact(fDeb)}</div>
          <div class="kpi-sub">ریال · مطالبات از اشخاص</div>
        </div>
        <div class="rep-kpi-card pc-kpi pc-kpi-credit" title="${fmt(fCred)}">
          <div class="kpi-label">جمع بستانکار</div>
          <div class="kpi-val" data-csp-style="${CSP.style(`color:var(--green)`)}">${pcFmtCompact(fCred)}</div>
          <div class="kpi-sub">ریال · بدهی ما</div>
        </div>
        <div class="rep-kpi-card pc-kpi" title="${fmt(k.net_signed_rial || 0)}">
          <div class="kpi-label">مانده خالص</div>
          <div class="kpi-val" data-csp-style="${CSP.style(`color:${pcMoneyTone(k.net_signed_rial)}`)}">${pcFmtCompact(k.net_signed_rial || 0)}</div>
          <div class="kpi-sub">${fmt(k.parties_with_balance || 0)} شخص مانده‌دار</div>
        </div>
        <div class="rep-kpi-card pc-kpi pc-kpi-click" data-csp-click="${CSP.bind('click', function () { pcSetFilter({ risk: 'over_credit', balance: 'nonzero' }); })}">
          <div class="kpi-label">عبور از سقف</div>
          <div class="kpi-val">${fmt(k.over_credit_count || 0)}</div>
          <div class="kpi-sub">مازاد ${pcFmtCompact(k.over_credit_rial || 0)}</div>
        </div>
        <div class="rep-kpi-card pc-kpi pc-kpi-click" data-csp-click="${CSP.bind('click', function () { pcSetFilter({ risk: 'mismatch', balance: 'all' }); })}">
          <div class="kpi-label">اختلاف دفتر</div>
          <div class="kpi-val">${fmt(k.mismatch_count || 0)}</div>
          <div class="kpi-sub">نیازمند تطبیق</div>
        </div>
        <div class="rep-kpi-card pc-kpi pc-kpi-click" title="سهم ۵ بدهکار بزرگ از کل بدهکار" data-csp-click="${CSP.bind('click', function () { pcSetFilter({ side: 'debit', balance: 'nonzero', sort: 'balance_abs' }); })}">
          <div class="kpi-label">تمرکز مطالبات</div>
          <div class="kpi-val">${fmt(k.top5_debtor_share_pct || 0)}٪</div>
          <div class="kpi-sub">۵ بدهکار بزرگ · ۹۰+ ${pcFmtCompact(k.aging_90_rial || 0)}</div>
        </div>
      </div>

      <div class="panel pc-panel-primary">
        <div class="panel-h pc-panel-h">
          <div><b>صف اقدام امروز</b><span class="muted pc-panel-hint">اولویت ریسک × مانده × پیری · ${fmt((d.worklist || []).length)} مورد</span></div>
        </div>
        <div class="panel-body pc-tbl-wrap">
          <table class="data pc-table pc-work-table"><thead><tr>
            <th>#</th><th>شخص</th><th>مانده</th><th>ریسک</th><th>اقدام پیشنهادی</th><th></th>
          </tr></thead><tbody>${workRows}</tbody></table>
        </div>
      </div>

      <div class="pc-grid-2">
        <div class="panel">
          <div class="panel-h"><b>پیری مطالبات (FIFO)</b><span class="muted pc-panel-hint">کلیک روی سطل = فیلتر</span></div>
          <div class="panel-body">
            ${pcAgingBar(d.aging)}
            <p class="muted pc-footnote">سطل‌ها برای ماندهٔ بدهکار مشتریان (فاکتور منهای تسویه) است.</p>
          </div>
        </div>
        <div class="panel">
          <div class="panel-h"><b>تفکیک سمت</b><span class="muted pc-panel-hint">مبلغ روی سمت اصلی · کلیک = فیلتر</span></div>
          <div class="panel-body pc-tbl-wrap">
            <table class="data pc-table"><thead><tr>
              <th>سمت</th><th>تعداد</th><th>مانده‌دار</th><th>بدهکار</th><th>بستانکار</th>
            </tr></thead><tbody>${roleRows}</tbody></table>
          </div>
        </div>
      </div>

      <div class="pc-grid-2">
        <div class="panel">
          <div class="panel-h"><b>۵ بدهکار بزرگ</b><span class="muted pc-panel-hint">${fmt(conc.top5_share_pct || 0)}٪ از مطالبات</span></div>
          <div class="panel-body pc-tbl-wrap">
            <table class="data pc-table"><thead><tr>
              <th>#</th><th>شخص</th><th>مانده</th>
            </tr></thead><tbody>${concRows}</tbody></table>
          </div>
        </div>
        <div class="panel pc-health-panel">
          <div class="panel-h"><b>وضعیت کنترل</b></div>
          <div class="panel-body">
            <div class="pc-health-meter"><i data-csp-style="${CSP.style(`width:${Math.min(100, health)}%;background:${health >= 85 ? 'var(--green)' : (health >= 60 ? '#f59e0b' : 'var(--red)')}`)}"></i></div>
            <div class="pc-health-stats">
              <div><span>بحرانی</span><b>${fmt(k.high_risk_count || 0)}</b></div>
              <div><span>توجه</span><b>${fmt(k.medium_risk_count || 0)}</b></div>
              <div><span>صف اقدام</span><b>${fmt(k.worklist_count || 0)}</b></div>
              <div><span>بدون کارشناس</span><b>${fmt(d.unassigned_count || 0)}</b></div>
            </div>
          </div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-h pc-panel-h">
          <div><b>جدول کنترل حساب</b><span class="muted pc-panel-hint">جمع صفحه روی فیلتر فعلی</span></div>
          <button type="button" class="btn sm ghost" data-csp-click="${CSP.bind('click', function () { exportPartyControlCsv(); })}">خروجی CSV</button>
        </div>
        <div class="panel-body pc-tbl-wrap">
          <table class="data pc-table" id="pcControlTable"><thead><tr>
            <th>شخص / سمت</th><th>تفصیلی</th><th>مانده</th><th>بدهکار</th><th>بستانکار</th><th>سقف اعتبار</th><th>پیری</th><th>ریسک</th><th>عملیات</th>
          </tr></thead>
          <tbody>${partyRows}</tbody>
          <tfoot><tr>
            <td colspan="2"><b>جمع صفحه</b></td>
            <td class="mono" data-csp-style="${CSP.style(`font-weight:800;color:${pcMoneyTone(footBal)}`)}"><b title="${fmt(footBal)}">${pcFmtCompact(footBal)}</b></td>
            <td class="mono"><b title="${fmt(footDeb)}">${pcFmtCompact(footDeb)}</b></td>
            <td class="mono"><b title="${fmt(footCred)}">${pcFmtCompact(footCred)}</b></td>
            <td colspan="4"></td>
          </tr></tfoot>
          </table>
        </div>
      </div>`;

    if (typeof enhanceAccTables === 'function') enhanceAccTables(box);
    if (typeof fitStatNums === 'function') fitStatNums();
  }

  function exportPartyControlCsv() {
    const d = window._pcDashLast;
    if (!d || !(d.parties || []).length) {
      if (typeof showToast === 'function') showToast('داده‌ای برای خروجی نیست', 'error');
      return;
    }
    const header = ['کد', 'نام', 'سمت‌ها', 'کارشناس', 'شهر', 'تلفن', 'تفصیلی', 'مانده', 'بدهکار', 'بستانکار', 'سقف', 'مصرف‌اعتبار', 'پیری_روز', 'ریسک'];
    const lines = [header.join(',')];
    for (const p of d.parties) {
      const cells = [
        p.person_code, p.name, (p.party_roles || []).join('|'), p.expert_name, p.city, p.phone, p.coa_code,
        p.balance_rial, p.debit_rial, p.credit_rial, p.credit_limit_rial, p.credit_used_rial,
        p.aging_days != null ? p.aging_days : '', p.risk_level,
      ].map((x) => '"' + String(x == null ? '' : x).replace(/"/g, '""') + '"');
      lines.push(cells.join(','));
    }
    const blob = new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'party-control-' + Date.now() + '.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    if (typeof showToast === 'function') showToast('خروجی CSV آماده شد');
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
    renderTreasuryDashboardTab,
    loadTreasuryDashboard,
    renderSalesPurchaseDashboardTab,
    loadSalesPurchaseDashboard,
    spDashDrill,
    spDashClearDrill,
    spDashOpenDoc,
    renderPartyControlDashboardTab,
    loadPartyControlDashboard,
    exportPartyControlCsv,
    renderChequeDashboardTab,
    loadChequeDashboard,
    renderChequebookReportTab,
    loadChequebookReport,
    selectUnit,
    openCreateUnitModal,
    openEditUnitModal,
    saveUnit,
    deleteUnit,
    openCreateDeptModal,
    openEditDeptModal,
    saveDept,
    moveDept,
    openCreateParamModal,
    addParamItemRow,
    renderParamItemRows,
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
    openDeptExtrasModal,
    openDelegateModal,
    saveDelegation,
    revokeDelegation,
    approvePortalProduct,
    showBankRecon,
    openBankReconModal,
    saveBankRecon,
    openBankReconItemModal,
    saveBankReconItem,
    matchBankReconItems,
    closeBankRecon, classifyBankItem, openBankReconImport, saveBankReconImport,
    autoMatchBankRecon, refreshBankReconBook, voidBankRecon, confirmBankChequeMatch,
    showBudgetVariance,
    openBudgetModal,
    saveBudget,
    openBudgetLinesModal,
    addBudgetLineRow,
    renderBudgetLineRows,
    saveBudgetLines,
    postLegalReserve,
    postDoubtful,
    postInventoryNrv,
    reloadReport,
    invitePersonUser,
    sendPersonInvite,
    maybeShowInviteAccept,
    copyInviteLink,
  };

  global.PortalUI = PortalUI;
  global.invitePersonUser = invitePersonUser;
  global.maybeShowInviteAccept = maybeShowInviteAccept;
  global.copyInviteLink = copyInviteLink;
  global.renderPortalUnitsTab = renderPortalUnitsTab;
  global.renderPortalMyDeptTab = renderPortalMyDeptTab;
  global.renderBankReconTab = renderBankReconTab;
  global.renderBudgetingTab = renderBudgetingTab;
  global.renderReservesTab = renderReservesTab;
  global.renderVatReturnTab = renderVatReturnTab;
  global.renderSeasonal169Tab = renderSeasonal169Tab;
  global.renderCashFlowStdTab = renderCashFlowStdTab;
  global.renderKpiDashboardTab = renderKpiDashboardTab;
  global.renderTreasuryDashboardTab = renderTreasuryDashboardTab;
  global.loadTreasuryDashboard = loadTreasuryDashboard;
  global.renderSalesPurchaseDashboardTab = renderSalesPurchaseDashboardTab;
  global.loadSalesPurchaseDashboard = loadSalesPurchaseDashboard;
  global.spDashDrill = spDashDrill;
  global.spDashClearDrill = spDashClearDrill;
  global.spDashOpenDoc = spDashOpenDoc;
  global.renderPartyControlDashboardTab = renderPartyControlDashboardTab;
  global.loadPartyControlDashboard = loadPartyControlDashboard;
  global.exportPartyControlCsv = exportPartyControlCsv;
  global.renderChequeDashboardTab = renderChequeDashboardTab;
  global.loadChequeDashboard = loadChequeDashboard;
  global.renderChequebookReportTab = renderChequebookReportTab;
  global.loadChequebookReport = loadChequebookReport;

}(typeof globalThis !== 'undefined' ? globalThis : window));
