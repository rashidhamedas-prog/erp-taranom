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
        <div class="panel" style="margin-top:12px">
          <div class="panel-head"><h4>🏢 ${esc(u.name)} — بخش‌ها و پارامترها</h4>
            <div style="display:flex;gap:6px;flex-wrap:wrap">
              <button class="btn sm ghost" onclick="PortalUI.openEditUnitModal(${u.id})">✏️ ویرایش واحد</button>
              <button class="btn sm" onclick="PortalUI.openCreateDeptModal(${u.id})">➕ دپارتمان</button>
              <button class="btn sm ghost" onclick="PortalUI.openCreateParamModal(${u.id})">➕ پارامتر جدید</button>
            </div>
          </div>
          <div class="panel-body">
            <div class="muted" style="font-size:12px;margin-bottom:10px;line-height:1.7">
              <b>مدیران:</b> ${esc(mgrNames || '—')}
              &nbsp;|&nbsp; <b>نوع خروجی:</b> ${esc(u.output_type || '—')}
              &nbsp;|&nbsp; <b>انبارها:</b> ${(u.warehouses || []).map(w => esc(w.name)).join('، ') || '—'}
              &nbsp;|&nbsp; <b>اشخاص در جریان:</b> ${(u.persons || []).map(p => esc(p.name)).join('، ') || '—'}
              &nbsp;|&nbsp; <b>اتصالات:</b> ${(u.module_links || []).map(m => esc(m.module_key)).join('، ') || '—'}
            </div>
            <h5 style="margin:0 0 8px;font-size:13px">بخش‌های عملیاتی (مرحله‌بندی مسیر)</h5>
            <div class="tbl-wrap" style="margin-bottom:14px"><table class="tbl" style="font-size:12px"><thead><tr>
              <th>ترتیب</th><th>نام</th><th>مدیر</th><th>انبار</th><th>عملیات</th>
            </tr></thead><tbody>${(u.departments || []).map((d, i, arr) => `<tr>
              <td class="mono">${fmt(d.sequence_order)}</td>
              <td>${esc(d.name)}</td>
              <td>${esc(d.manager_name || '-')}</td>
              <td>${esc(d.warehouse_name || '-')}</td>
              <td style="white-space:nowrap">
                <button class="btn sm ghost" ${i === 0 ? 'disabled' : ''} onclick="PortalUI.moveDept(${d.id},${d.sequence_order - 1},${u.id})" title="بالا">↑</button>
                <button class="btn sm ghost" ${i === arr.length - 1 ? 'disabled' : ''} onclick="PortalUI.moveDept(${d.id},${d.sequence_order + 1},${u.id})" title="پایین">↓</button>
                <button class="btn sm ghost" onclick="PortalUI.openEditDeptModal(${d.id},${u.id})">✏️</button>
                <button class="btn sm ghost" onclick="PortalUI.openDeptExtrasModal(${d.id})" title="امکان و وظیفه">📋 امکانات</button>
                <button class="btn sm ghost" onclick="PortalUI.openDelegateModal(${d.id})" title="واگذاری موقت">🔀 واگذاری</button>
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
      <p class="muted" style="font-size:12px;margin-bottom:10px">مسئول واحد از <b>اطلاعات اشخاص</b> انتخاب می‌شود؛ با ذخیره، حساب کاربری با نام کاربری=تلفن و رمز پیش‌فرض ۱۲۳۴۵ ساخته می‌شود.</p>
      <div class="tbl-wrap"><table class="tbl"><thead><tr>
        <th>نام واحد</th><th>نوع خروجی</th><th>وضعیت</th><th>عملیات</th>
      </tr></thead><tbody>${units.map(u => `<tr style="${_portalUnitId === u.id ? 'background:var(--purple-light)' : ''}">
        <td>${esc(u.name)}</td>
        <td class="muted">${esc(u.output_type || '-')}</td>
        <td>${esc(u.status || 'active')}</td>
        <td>
          <button class="btn sm ${ _portalUnitId === u.id ? '' : 'ghost'}" onclick="PortalUI.selectUnit(${u.id})">مدیریت</button>
          <button class="btn sm ghost" onclick="PortalUI.openEditUnitModal(${u.id})">✏️</button>
        </td>
      </tr>`).join('') || emptyRow(4)}</tbody></table></div>
      ${detailHtml}`;
  }

  function selectUnit(id) {
    _portalUnitId = id;
    _portalParamId = null;
    loadAccTab('portal-units');
  }

  function multiSelectHtml(id, options, selectedIds, size) {
    const sel = new Set((selectedIds || []).map(String));
    return `<select id="${id}" multiple size="${size || 5}" style="min-height:${(size || 5) * 22}px;width:100%">
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
      <p class="muted" style="font-size:11px;grid-column:1/-1">چندانتخابی: Ctrl+کلیک (ویندوز) یا Cmd+کلیک (مک).</p>`;
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
      <div class="modal-head"><h3>➕ واحد عملیاتی جدید</h3><button class="x" onclick="closeModal()">×</button></div>
      <div class="modal-body"><div class="form-grid">${unitFormFieldsHtml({})}</div></div>
      <div class="modal-foot"><button class="btn" onclick="PortalUI.saveUnit(0)">💾 ذخیره</button>
        <button class="btn ghost" onclick="closeModal()">انصراف</button></div>`);
  }

  async function openEditUnitModal(id) {
    await ensurePortalCaches();
    const u = await api('GET', '/portal/units/' + id);
    openModal(`
      <div class="modal-head"><h3>✏️ ویرایش واحد عملیاتی</h3><button class="x" onclick="closeModal()">×</button></div>
      <div class="modal-body"><div class="form-grid">${unitFormFieldsHtml(u)}</div></div>
      <div class="modal-foot"><button class="btn" onclick="PortalUI.saveUnit(${id})">💾 ذخیره</button>
        <button class="btn ghost" onclick="closeModal()">انصراف</button></div>`);
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

  async function openCreateDeptModal(unitId) {
    await ensurePortalCaches();
    const u = await api('GET', '/portal/units/' + unitId);
    const whs = u.warehouses || [];
    if (!whs.length) {
      showToast('اول انبارهای واحد را در ویرایش واحد تعریف کنید', 'error'); return;
    }
    openModal(`
      <div class="modal-head"><h3>➕ دپارتمان جدید</h3><button class="x" onclick="closeModal()">×</button></div>
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
      <div class="modal-foot"><button class="btn" onclick="PortalUI.saveDept(0,${unitId})">💾 ذخیره</button>
        <button class="btn ghost" onclick="closeModal()">انصراف</button></div>`);
  }

  async function openEditDeptModal(deptId, unitId) {
    await ensurePortalCaches();
    const u = await api('GET', '/portal/units/' + unitId);
    const d = (u.departments || []).find(x => x.id === deptId);
    if (!d) { showToast('دپارتمان یافت نشد', 'error'); return; }
    const whs = u.warehouses || [];
    openModal(`
      <div class="modal-head"><h3>✏️ ویرایش دپارتمان</h3><button class="x" onclick="closeModal()">×</button></div>
      <div class="modal-body"><div class="form-grid">
        <div class="fg full"><label>نام دپارتمان *</label><input id="pd-name" value="${esc(d.name || '')}"></div>
        <div class="fg full"><label>مسئول دپارتمان *</label>
          <select id="pd-mgr"><option value="">—</option>${personOptionsHtml(d.manager_person_id)}</select></div>
        <div class="fg full"><label>انبار دپارتمان *</label>
          <select id="pd-wh"><option value="">—</option>
            ${whs.map(w => `<option value="${w.id}" ${String(d.warehouse_id) === String(w.id) ? 'selected' : ''}>${esc(w.name)}</option>`).join('')}
          </select></div>
      </div></div>
      <div class="modal-foot"><button class="btn" onclick="PortalUI.saveDept(${deptId},${unitId})">💾 ذخیره</button>
        <button class="btn ghost" onclick="closeModal()">انصراف</button></div>`);
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
      <div class="modal-head"><h3>➕ پارامتر جدید</h3><button class="x" onclick="closeModal()">×</button></div>
      <div class="modal-body"><div class="form-grid">
        <div class="fg full"><label>نام پارامتر *</label><input id="pp-name"></div>
        <div class="fg full"><label>انبار مبدأ (مواد)</label>
          <select id="pp-src-wh"><option value="">— پیش‌فرض واحد —</option>
            ${whs.map(w => `<option value="${w.id}">${esc(w.name)}</option>`).join('')}
          </select></div>
        <div class="fg full"><label>اقلام پارامتر *</label>
          <div id="pp-items-box"></div>
          <button type="button" class="btn sm ghost" onclick="PortalUI.addParamItemRow()">➕ مقدار / کالای بعدی</button>
        </div>
        <div class="fg full"><label>توضیحات</label><textarea id="pp-desc"></textarea></div>
      </div></div>
      <div class="modal-foot"><button class="btn" onclick="PortalUI.saveParameter(${unitId})">💾 ایجاد و تحویل به اولین دپارتمان</button>
        <button class="btn ghost" onclick="closeModal()">انصراف</button></div>`);
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
      <div style="display:flex;gap:8px;margin-bottom:6px;align-items:center;flex-wrap:wrap">
        <select style="flex:1;min-width:180px" onchange="window._paramItems[${i}].product_id=this.value">
          <option value="">— انتخاب کالا —</option>
          ${prods.slice(0, 800).map(p => `<option value="${p.id}" ${String(it.product_id) === String(p.id) ? 'selected' : ''}>${esc(p.name)}${p.code ? ' (' + esc(p.code) + ')' : ''}</option>`).join('')}
        </select>
        <input type="number" step="0.001" min="0.001" placeholder="مقدار" value="${esc(String(it.quantity || '1'))}"
          oninput="window._paramItems[${i}].quantity=this.value" style="width:110px">
        ${_paramItems.length > 1 ? `<button type="button" class="btn sm red" onclick="window._paramItems.splice(${i},1);PortalUI.renderParamItemRows()">×</button>` : ''}
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
    const canApprovePay = (typeof canPerm === 'function' && canPerm('portal', 'approve'))
      || ['admin', 'accounting', 'unit_manager'].includes(ME?.role);
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
              ${canApprovePay ? `<button class="btn sm orange" onclick="PortalUI.deptApprovePayment(${p.id},${p.current_department_id || 0})">✔ تأیید پرداخت</button>` : ''}
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
      <div class="modal-head"><h3>💳 درخواست پرداخت</h3><button class="x" onclick="closeModal()">×</button></div>
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
    let whs = (CACHE.warehouses || []).filter(w => w.active !== 0);
    try {
      const param = await api('GET', '/portal/parameters/' + paramId);
      if (param?.unit_id) {
        const unit = await api('GET', '/portal/units/' + param.unit_id);
        if (unit?.warehouses?.length) whs = unit.warehouses;
      }
    } catch (_) {}
    openModal(`
      <div class="modal-head"><h3>🏁 ثبت خروجی نهایی</h3><button class="x" onclick="closeModal()">×</button></div>
      <div class="modal-body"><div class="form-grid">
        <div class="fg"><label>تعداد نهایی *</label><input id="fo-qty" type="number" step="0.001" min="0.001" value="1"></div>
        <div class="fg"><label>انبار مقصد *</label><select id="fo-wh"><option value="">— انتخاب —</option>
          ${whs.map(w => `<option value="${w.id}">${esc(w.name)}</option>`).join('')}
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
      openDeptExtrasModal(deptId);
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
      openDeptExtrasModal(deptId);
    } catch (e) {}
  }

  async function openDeptExtrasModal(deptId) {
    const [caps, tasks] = await Promise.all([
      api('GET', `/portal/departments/${deptId}/capabilities`).catch(() => []),
      api('GET', `/portal/departments/${deptId}/tasks`).catch(() => []),
    ]);
    openModal(`
      <div class="modal-head"><h3>📋 امکانات و وظایف دپارتمان</h3><button class="x" onclick="closeModal()">×</button></div>
      <div class="modal-body">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <h5 style="margin:0;font-size:13px">امکانات / خدمات</h5>
          <button class="btn sm" onclick="PortalUI.addDeptCapability(${deptId})">➕ امکان</button>
        </div>
        <div class="tbl-wrap" style="margin-bottom:16px"><table class="tbl" style="font-size:12px"><thead><tr>
          <th>نام</th><th>توضیح</th>
        </tr></thead><tbody>${(caps || []).map(c => `<tr>
          <td>${esc(c.name)}</td><td class="muted">${esc(c.description || '-')}</td>
        </tr>`).join('') || emptyRow(2)}</tbody></table></div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <h5 style="margin:0;font-size:13px">شرح وظایف</h5>
          <button class="btn sm" onclick="PortalUI.addDeptTask(${deptId})">➕ وظیفه</button>
        </div>
        <div class="tbl-wrap"><table class="tbl" style="font-size:12px"><thead><tr>
          <th>نام</th><th>توضیح</th>
        </tr></thead><tbody>${(tasks || []).map(t => `<tr>
          <td>${esc(t.name)}</td><td class="muted">${esc(t.description || '-')}</td>
        </tr>`).join('') || emptyRow(2)}</tbody></table></div>
      </div>
      <div class="modal-foot"><button class="btn ghost" onclick="closeModal()">بستن</button></div>`);
  }

  async function openDelegateModal(deptId) {
    await ensurePortalCaches();
    const list = await api('GET', `/portal/departments/${deptId}/delegations`).catch(() => []) || [];
    openModal(`
      <div class="modal-head"><h3>🔀 واگذاری موقت مدیریت بخش</h3><button class="x" onclick="closeModal()">×</button></div>
      <div class="modal-body"><div class="form-grid">
        <div class="fg full"><label>شخص جایگزین *</label>
          <select id="dlg-person"><option value="">— انتخاب —</option>${personOptionsHtml()}</select></div>
        <div class="fg"><label>مدت (ساعت)</label><input id="dlg-hours" type="number" min="1" max="720" value="72"></div>
        <div class="fg full"><label>یادداشت</label><input id="dlg-note" placeholder="دلیل واگذاری"></div>
      </div>
      <h5 style="margin:14px 0 8px;font-size:13px">واگذاری‌های اخیر</h5>
      <div class="tbl-wrap"><table class="tbl" style="font-size:11px"><thead><tr>
        <th>شخص</th><th>از</th><th>تا</th><th>فعال</th><th></th>
      </tr></thead><tbody>${list.map(d => `<tr>
        <td>${esc(d.delegate_name || '#' + d.delegate_person_id)}</td>
        <td class="mono">${fmt(d.starts_at)}</td>
        <td class="mono">${fmt(d.ends_at)}</td>
        <td>${d.active ? '✅' : '—'}</td>
        <td>${d.active ? `<button class="btn sm red" onclick="PortalUI.revokeDelegation(${deptId},${d.id})">ابطال</button>` : ''}</td>
      </tr>`).join('') || emptyRow(5)}</tbody></table></div>
      </div>
      <div class="modal-foot"><button class="btn" onclick="PortalUI.saveDelegation(${deptId})">💾 ثبت واگذاری</button>
        <button class="btn ghost" onclick="closeModal()">انصراف</button></div>`);
  }
  async function saveDelegation(deptId) {
    const delegate_person_id = +el('dlg-person')?.value;
    const hours = +el('dlg-hours')?.value || 72;
    if (!delegate_person_id) { showToast('شخص جایگزین الزامی است', 'error'); return; }
    try {
      await api('POST', `/portal/departments/${deptId}/delegate`, {
        delegate_person_id, hours, note: el('dlg-note')?.value || '',
      });
      showToast('واگذاری ثبت شد — کاربر با رمز ۱۲۳۴۵ در صورت نیاز ساخته شد');
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
      const open = r.status !== 'closed';
      detail = `
        <div class="panel" style="margin-top:12px">
          <div class="panel-head"><h4>تطبیق #${fmt(r.id)} — ${esc(r.bank_name)}</h4>
            <div style="display:flex;gap:6px;flex-wrap:wrap">
              ${open ? `<button class="btn sm" onclick="PortalUI.openBankReconItemModal(${r.id})">➕ ردیف</button>` : ''}
              ${open ? `<button class="btn sm ghost" onclick="PortalUI.matchBankReconItems(${r.id})">🔗 تطبیق انتخاب‌شده</button>` : ''}
              ${open ? `<button class="btn sm green" onclick="PortalUI.closeBankRecon(${r.id})">🔒 بستن تطبیق</button>` : ''}
            </div>
          </div>
          <div class="panel-body">
            <div class="cards" style="margin-bottom:12px">
              ${statCard('b', '📒', fmt(r.book_balance_rial || 0), 'مانده دفتر (ریال)')}
              ${statCard('o', '🏦', fmt(r.statement_balance_rial || 0), 'مانده صورت‌حساب (ریال)')}
              ${statCard('r', 'Δ', fmt(diff), 'اختلاف (ریال)')}
            </div>
            <div class="tbl-wrap"><table class="tbl" style="font-size:12px"><thead><tr>
              ${open ? '<th></th>' : ''}<th>طرف</th><th>شرح</th><th>مبلغ (ریال)</th><th>تطبیق</th>
            </tr></thead><tbody>${(r.items || []).map(it => `<tr>
              ${open ? `<td><input type="checkbox" class="br-match" value="${it.id}" ${it.matched ? 'disabled' : ''}></td>` : ''}
              <td>${it.side === 'bank' ? 'بانک' : 'دفتر'}</td>
              <td>${esc(it.description || '-')}</td>
              <td class="mono">${fmt(it.amount_rial || 0)}</td>
              <td>${it.matched ? '✅' : '—'}</td>
            </tr>`).join('') || emptyRow(open ? 5 : 4)}</tbody></table></div>
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

  async function openBankReconItemModal(reconId) {
    openModal(`
      <div class="modal-head"><h3>➕ ردیف تطبیق</h3><button class="x" onclick="closeModal()">×</button></div>
      <div class="modal-body"><div class="form-grid">
        <div class="fg"><label>طرف *</label><select id="bri-side">
          <option value="bank">بانک (صورت‌حساب)</option>
          <option value="book">دفتر</option>
        </select></div>
        <div class="fg"><label>مبلغ (ریال) *</label><input id="bri-amt" class="money" inputmode="numeric"></div>
        <div class="fg full"><label>شرح</label><input id="bri-desc"></div>
        <div class="fg"><label><input type="checkbox" id="bri-stmt" style="width:auto;margin-left:6px"> خط صورت‌حساب</label></div>
      </div></div>
      <div class="modal-foot"><button class="btn" onclick="PortalUI.saveBankReconItem(${reconId})">💾 افزودن</button>
        <button class="btn ghost" onclick="closeModal()">انصراف</button></div>`);
  }
  async function saveBankReconItem(reconId) {
    const amount_rial = Math.round(typeof moneyVal === 'function' ? moneyVal('bri-amt') : +el('bri-amt')?.value || 0);
    if (!amount_rial) { showToast('مبلغ الزامی است', 'error'); return; }
    try {
      await api('POST', `/bank-reconciliation/${reconId}/items`, {
        side: el('bri-side')?.value || 'bank',
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
          <div class="panel-head"><h4>📊 انحراف بودجه #${fmt(_budgetId)} (${esc(v.year_label || '')})</h4>
            <button class="btn sm ghost" onclick="PortalUI.openBudgetLinesModal(${_budgetId})">✏️ ردیف‌های بودجه</button>
          </div>
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
        <td>
          <button class="btn sm ghost" onclick="PortalUI.showBudgetVariance(${b.id})">انحراف</button>
          <button class="btn sm ghost" onclick="PortalUI.openBudgetLinesModal(${b.id})">ردیف‌ها</button>
        </td>
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
        <button class="x" onclick="closeModal()">×</button></div>
      <div class="modal-body">
        <div id="bg-lines"></div>
        <button type="button" class="btn sm ghost" style="margin-top:8px" onclick="PortalUI.addBudgetLineRow()">➕ ردیف</button>
      </div>
      <div class="modal-foot"><button class="btn" onclick="PortalUI.saveBudgetLines(${budgetId})">💾 ذخیره ردیف‌ها</button>
        <button class="btn ghost" onclick="closeModal()">انصراف</button></div>`);
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
      <div style="display:grid;grid-template-columns:1.2fr 70px 1fr 1fr 28px;gap:6px;margin-bottom:6px;align-items:center">
        <input placeholder="کد حساب" value="${esc(l.account_code || '')}" oninput="window._budgetLines[${i}].account_code=this.value" dir="ltr">
        <input type="number" min="1" max="12" title="ماه" value="${l.month || 1}" oninput="window._budgetLines[${i}].month=+this.value||1">
        <input placeholder="مبلغ ریال" class="money" inputmode="numeric" value="${esc(String(l.amount_rial || ''))}" oninput="window._budgetLines[${i}].amount_rial=this.value">
        <input placeholder="دسته / یادداشت" value="${esc(l.category || l.notes || '')}" oninput="window._budgetLines[${i}].category=this.value;window._budgetLines[${i}].notes=this.value">
        ${lines.length > 1 ? `<button type="button" class="btn sm red" onclick="window._budgetLines.splice(${i},1);PortalUI.renderBudgetLineRows()">×</button>` : '<span></span>'}
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
    openEditUnitModal,
    saveUnit,
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
    showBankRecon,
    openBankReconModal,
    saveBankRecon,
    openBankReconItemModal,
    saveBankReconItem,
    matchBankReconItems,
    closeBankRecon,
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
