/**
 * جدول‌ها: سورت، فیلتر، انتخاب چندتایی + نوار حذف گروهی
 * enhanceDataTable(table, { selectable: true, bulkDelete: { label, path, deleteOne, canDelete, refresh, confirm } })
 */
(function (global) {
  function cellText(td) {
    return (td?.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function toAsciiDigits(s) {
    return String(s == null ? '' : s)
      .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
      .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
  }

  /** Sort key: prefer data-sort, else visible text */
  function cellSortValue(td) {
    if (!td) return '';
    if (td.dataset && td.dataset.sort != null && td.dataset.sort !== '') return String(td.dataset.sort);
    return cellText(td);
  }

  /** Normalize fa/ar digits + strip thousand separators so numeric sort works with fmt()/fa-IR cells */
  function parseCellNumber(text) {
    const raw = String(text || '').trim();
    if (!raw) return NaN;
    const normalized = raw
      .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
      .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
      .replace(/٫/g, '.') // Arabic decimal separator (fa-IR floats)
      .replace(/[٬،,\s]/g, '')
      .replace(/[^\d.eE+-]/g, '');
    if (!normalized || normalized === '-' || normalized === '+' || normalized === '.') return NaN;
    const n = Number(normalized);
    return Number.isFinite(n) ? n : NaN;
  }

  function selectedIds(table) {
    return [...table.querySelectorAll('.tbl-sel-row:checked')]
      .map((cb) => cb.dataset.id || cb.closest('tr')?.dataset.id)
      .filter(Boolean);
  }

  function selectedRows(table) {
    return [...table.querySelectorAll('.tbl-sel-row:checked')].map((cb) => cb.closest('tr')).filter(Boolean);
  }

  function findDeleteBtn(root) {
    const btns = [...(root.querySelectorAll('button.btn.red, button.btn.sm.red') || [])];
    const byFn = btns.find((b) =>
      /^(delete|void|confirmDelete|discard|stkDelete|remDelete|prodBom|prodOrderCancel)/i.test(
        (b.getAttribute('onclick') || '').trim()
      )
    );
    if (byFn) return byFn;
    return btns.find((b) => /حذف|ابطال/.test(b.textContent || '') || b.getAttribute('title') === 'ابطال') || null;
  }

  function ensureRowIds(table) {
    const tbody = table.tBodies[0];
    if (!tbody) return;
    [...tbody.rows].forEach((tr) => {
      if (tr.dataset.id) return;
      const red = findDeleteBtn(tr);
      const src = red ? (red.getAttribute('onclick') || '') : tr.innerHTML;
      const m = src.match(/\((\d+)\b/) || src.match(/,\s*(\d+)\s*[,)]/);
      if (m) tr.dataset.id = m[1];
    });
  }

  /** نقشه توابع حذف ردیف → مسیر API (بدون confirm تکراری) */
  const DELETE_API = {
    deleteParty: (id) => ['DELETE', '/parties/' + id],
    voidInvoiceDoc: (id) => ['DELETE', '/invoices/' + id],
    deletePurchaseReturn: (id) => ['DELETE', '/purchases/returns/' + id],
    deleteSalesReturn: (id) => ['DELETE', '/accounting/sales-returns/' + id],
    deleteOrder: (id) => ['DELETE', '/orders/' + id],
    deletePurchaseInvoice: (id) => ['DELETE', '/purchases/' + id],
    deleteBank: (id) => ['DELETE', '/banks/' + id],
    deleteCashBox: (id) => ['DELETE', '/cash-boxes/' + id],
    deleteCashbox: (id) => ['DELETE', '/cash-boxes/' + id],
    deleteCheckCategory: (id) => ['DELETE', '/check-categories/' + id],
    deletePartyGroup: (id) => ['DELETE', '/party-groups/' + id],
    deleteProductGroup: (id) => ['DELETE', '/product-categories/' + id],
    deleteSupplier: (id) => ['DELETE', '/suppliers/' + id],
    deletePerson: (id) => ['DELETE', '/persons/' + id],
    deletePersonCategory: (id) => ['DELETE', '/person-categories/' + id],
    deleteWarehouse: (id) => ['DELETE', '/warehouses/' + id],
    deleteConsignment: (id) => ['DELETE', '/consignments/' + id],
    deleteVoucher: (id) => ['DELETE', '/accounting/vouchers/' + id],
    deleteVoucherDraft: (id) => ['DELETE', '/accounting/voucher-drafts/' + id],
    deleteVoucherTemplate: (id) => ['DELETE', '/accounting/voucher-templates/' + id],
    deleteCostCenter: (id) => ['DELETE', '/accounting/cost-centers/' + id],
    deleteCustomerGroup: (id) => ['DELETE', '/customer-groups/' + id],
    deleteOpeningCheque: (id) => ['DELETE', '/opening-cheques/' + id],
    deleteTrustCheck: (id) => ['DELETE', '/trust-checks/' + id],
    deleteTransfer: (id) => ['DELETE', '/transfers/' + id],
    deleteExpenseCategory: (id) => ['DELETE', '/expense-categories/' + id],
    deleteSettlement: (id) => ['DELETE', '/settlements/' + id],
    deleteProductionRun: (id) => ['DELETE', '/production/runs/' + id],
    deletePayrollRecord: (id) => ['DELETE', '/payroll/' + id],
    prodBomDelete: (id) => ['DELETE', '/production/boms/' + id],
    prodOrderCancel: (id) => ['POST', '/production/orders/' + id + '/cancel'],
    stkDelete: (id) => ['DELETE', '/stocktaking/' + id],
    remDelete: (id) => ['DELETE', '/reminders/' + id],
    discardSyncConflict: (id) => ['DELETE', '/sync/conflicts/' + id],
  };

  function updateBulkBar(table, opts) {
    const bar = table._bulkBar;
    if (!bar) return;
    const ids = selectedIds(table);
    const can = !opts.bulkDelete || (typeof opts.bulkDelete.canDelete === 'function'
      ? opts.bulkDelete.canDelete()
      : opts.bulkDelete.canDelete !== false);
    if (!ids.length || !opts.bulkDelete || !can) {
      bar.style.display = 'none';
      bar.innerHTML = '';
      return;
    }
    const label = opts.bulkDelete.label || 'حذف';
    bar.style.display = 'flex';
    bar.innerHTML = `
      <span class="tbl-bulk-count">${ids.length.toLocaleString('fa-IR')} مورد انتخاب شده</span>
      <button type="button" class="btn sm red tbl-bulk-del">${label === 'ابطال' ? '⛔' : '🗑️'} ${label} انتخاب‌شده‌ها</button>
      <button type="button" class="btn sm ghost tbl-bulk-clear">✕ لغو انتخاب</button>`;
    bar.querySelector('.tbl-bulk-del').onclick = () => runBulkDelete(table, opts);
    bar.querySelector('.tbl-bulk-clear').onclick = () => {
      table.querySelectorAll('.tbl-sel-row:checked').forEach((cb) => { cb.checked = false; });
      const all = table.querySelector('.tbl-sel-all');
      if (all) all.checked = false;
      updateBulkBar(table, opts);
    };
  }

  async function runBulkDelete(table, opts) {
    const ids = selectedIds(table);
    if (!ids.length || !opts.bulkDelete) return;
    const bd = opts.bulkDelete;
    const label = bd.label || 'حذف';
    const conf = bd.confirm || `${ids.length} مورد ${label} شود؟`;
    if (!confirm(conf.replace(/\{n\}/g, String(ids.length)))) return;
    let ok = 0;
    const failed = [];
    for (const id of ids) {
      try {
        if (typeof bd.deleteOne === 'function') await bd.deleteOne(id);
        else if (bd.path) {
          if (typeof global.api === 'function') await global.api('DELETE', bd.path.replace(/\/$/, '') + '/' + id);
          else throw new Error('api unavailable');
        } else throw new Error('حذف تعریف نشده');
        ok++;
      } catch (e) {
        failed.push({ id, error: e?.message || 'خطا' });
      }
    }
    if (typeof global.showToast === 'function') {
      if (failed.length) global.showToast(`${ok} مورد انجام شد؛ ${failed.length} ناموفق`, 'error');
      else global.showToast(`${ok} مورد با موفقیت ${label === 'ابطال' ? 'باطل' : 'حذف'} شد`);
    }
    if (typeof bd.refresh === 'function') await bd.refresh();
    else if (typeof opts.onSelectionChange === 'function') opts.onSelectionChange([]);
  }

  function enhanceDataTable(table, opts) {
    if (!table || table.dataset.enhanced === '1') return;
    opts = opts || {};
    table.dataset.enhanced = '1';
    const thead = table.tHead;
    const tbody = table.tBodies[0];
    if (!thead || !tbody) return;

    ensureRowIds(table);

    const headerRow = thead.rows[0];
    if (!headerRow) return;

    let sortCol = -1;
    let sortDir = 1;
    const filters = {};

    if (opts.selectable) {
      // نوار عملیات گروهی بالای جدول
      if (opts.bulkDelete) {
        const wrap = table.closest('.tbl-wrap') || table.parentElement;
        let bar = wrap?.previousElementSibling;
        if (!bar || !bar.classList.contains('tbl-bulk-bar')) {
          bar = document.createElement('div');
          bar.className = 'tbl-bulk-bar';
          bar.style.cssText = 'display:none;align-items:center;gap:10px;flex-wrap:wrap;padding:8px 12px;margin-bottom:8px;background:var(--purple-light);border:1px solid var(--border);border-radius:8px;font-size:13px';
          if (wrap && wrap.parentNode) wrap.parentNode.insertBefore(bar, wrap);
          else table.parentNode.insertBefore(bar, table);
        }
        table._bulkBar = bar;
      }

      const th = document.createElement('th');
      th.className = 'tbl-sel-th no-sort';
      th.innerHTML = `<input type="checkbox" title="انتخاب همه" class="tbl-sel-all">`;
      headerRow.insertBefore(th, headerRow.firstChild);
      [...tbody.rows].forEach((tr) => {
        // ردیف خالی بدون id
        if (!tr.dataset.id && tr.querySelector('.empty, td[colspan]')) return;
        const td = document.createElement('td');
        td.className = 'tbl-sel-td';
        const id = tr.dataset.id || '';
        td.innerHTML = `<input type="checkbox" class="tbl-sel-row" data-id="${id}" ${id ? '' : 'disabled'}>`;
        tr.insertBefore(td, tr.firstChild);
      });
      const refreshSel = () => {
        updateBulkBar(table, opts);
        if (opts.onSelectionChange) opts.onSelectionChange(selectedIds(table));
      };
      th.querySelector('.tbl-sel-all').addEventListener('change', (e) => {
        tbody.querySelectorAll('.tbl-sel-row:not([disabled])').forEach((cb) => {
          if (cb.closest('tr').style.display === 'none') return;
          cb.checked = e.target.checked;
        });
        refreshSel();
      });
      tbody.addEventListener('change', (e) => {
        if (e.target.classList.contains('tbl-sel-row')) refreshSel();
      });
      updateBulkBar(table, opts);
    }

    [...headerRow.cells].forEach((th, idx) => {
      if (th.classList.contains('tbl-sel-th') || th.classList.contains('no-sort')) return;
      th.classList.add('tbl-sortable');
      th.title = (th.title || '') + ' — کلیک: سورت | راست‌کلیک: فیلتر';
      const label = th.textContent.trim();
      th.innerHTML = `<span class="tbl-th-label">${label}</span><span class="tbl-sort-ind"></span>`;
      th.addEventListener('click', (e) => {
        if (e.target.closest('input')) return;
        if (sortCol === idx) sortDir *= -1;
        else { sortCol = idx; sortDir = 1; }
        [...headerRow.cells].forEach((h) => {
          const ind = h.querySelector('.tbl-sort-ind');
          if (ind) ind.textContent = '';
        });
        const ind = th.querySelector('.tbl-sort-ind');
        if (ind) ind.textContent = sortDir > 0 ? ' ▲' : ' ▼';
        const rows = [...tbody.rows];
        // #region agent log
        let _dbgNumPath = 0, _dbgStrPath = 0;
        const _dbgSamples = [];
        const _dbgLabel = (th.querySelector('.tbl-th-label') || th).textContent.trim();
        // #endregion
        rows.sort((a, b) => {
          const av = cellSortValue(a.cells[idx]);
          const bv = cellSortValue(b.cells[idx]);
          const aAscii = toAsciiDigits(av).trim();
          const bAscii = toAsciiDigits(bv).trim();
          const dateRe = /^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/;
          const aDate = aAscii.match(dateRe);
          const bDate = bAscii.match(dateRe);
          if (aDate && bDate) {
            const an = (+aDate[1]) * 10000 + (+aDate[2]) * 100 + (+aDate[3]);
            const bn = (+bDate[1]) * 10000 + (+bDate[2]) * 100 + (+bDate[3]);
            return (an - bn) * sortDir;
          }
          const an = parseCellNumber(av);
          const bn = parseCellNumber(bv);
          const useNum = Number.isFinite(an) && Number.isFinite(bn);
          // #region agent log
          if (_dbgSamples.length < 8) {
            _dbgSamples.push({
              av, bv, an, bn, useNum,
            });
          }
          if (useNum) _dbgNumPath++; else _dbgStrPath++;
          // #endregion
          if (useNum) {
            return (an - bn) * sortDir;
          }
          return aAscii.localeCompare(bAscii, 'fa', { numeric: true, sensitivity: 'base' }) * sortDir;
        });
        // #region agent log
        const _dbgOrder = rows.slice(0, 12).map((r) => cellText(r.cells[idx]));
        const _dbgPayload = {sessionId:'a1f008',runId:'post-fix',hypothesisId:'A',location:'tbl-enhance.js:sort',message:'table column sort',data:{label:_dbgLabel,idx,sortDir,numPath:_dbgNumPath,strPath:_dbgStrPath,samples:_dbgSamples,orderTop:_dbgOrder,tableId:table.id||'',hasSelectable:!!opts.selectable,hasParseCellNumber:typeof parseCellNumber==='function'},timestamp:Date.now()};
        try { global.__SORT_DEBUG_LAST__ = _dbgPayload; } catch(_){}
        fetch('http://127.0.0.1:7550/ingest/7c3b024e-51f2-48e0-b234-568dde667709',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'a1f008'},body:JSON.stringify(_dbgPayload)}).catch(()=>{});
        try {
          const _tok = (typeof localStorage!=='undefined' && localStorage.getItem('crm_token')) || '';
          fetch('/api/system/debug-ingest',{method:'POST',headers:{'Content-Type':'application/json',...(_tok?{'Authorization':'Bearer '+_tok}:{})},body:JSON.stringify(_dbgPayload),credentials:'same-origin'}).catch(()=>{});
        } catch(_){}
        // #endregion
        rows.forEach((r) => tbody.appendChild(r));
      });
      th.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const q = prompt('فیلتر ستون «' + label + '» (خالی = حذف فیلتر):', filters[idx] || '');
        if (q === null) return;
        if (!q.trim()) delete filters[idx];
        else filters[idx] = toAsciiDigits(q.trim()).toLowerCase();
        applyFilters();
      });
    });

    function applyFilters() {
      [...tbody.rows].forEach((tr) => {
        let ok = true;
        for (const [ci, q] of Object.entries(filters)) {
          const t = toAsciiDigits(cellText(tr.cells[+ci])).toLowerCase();
          if (!t.includes(q)) { ok = false; break; }
        }
        tr.style.display = ok ? '' : 'none';
      });
    }

    table._tblApplyFilters = applyFilters;
  }

  /** Infer bulk-delete from data-* attrs or first red action button */
  function inferBulkDelete(table) {
    if (table.dataset.bulkDelete === '0' || table.dataset.bulkDelete === 'false') return null;
    const path = table.dataset.bulkDelete;
    if (path && path.startsWith('/')) {
      return {
        path,
        label: table.dataset.bulkLabel || 'حذف',
        confirm: table.dataset.bulkConfirm || null,
        canDelete: () => {
          if (table.dataset.bulkPerm === 'admin') return typeof ME !== 'undefined' && (ME.role === 'admin' || ME.role === 'accounting');
          if (table.dataset.bulkPerm === 'invoices') {
            return (typeof canPerm === 'function' && canPerm('invoices', 'delete'))
              || (typeof ME !== 'undefined' && (ME.role === 'admin' || ME.role === 'accounting'));
          }
          return true;
        },
        refresh: () => {
          if (typeof IN_ACC_SHELL !== 'undefined' && IN_ACC_SHELL && typeof accTab !== 'undefined' && accTab && typeof loadAccTab === 'function') {
            return loadAccTab(accTab);
          }
          if (typeof CURRENT_PAGE !== 'undefined' && CURRENT_PAGE === 'invoices' && typeof renderInvTable === 'function') {
            return (async () => {
              if (typeof api === 'function') {
                global.CACHE = global.CACHE || {};
                CACHE.invoices = await api('GET', '/invoices') || [];
              }
              renderInvTable();
            })();
          }
          return null;
        },
      };
    }
    // از دکمه حذف ردیف استنباط کن
    const btn = findDeleteBtn(table.tBodies[0] || table);
    if (!btn) return null;
    const oc = btn.getAttribute('onclick') || '';
    const fnMatch = oc.match(/^([a-zA-Z_$][\w$]*)\s*\(/);
    if (!fnMatch) return null;
    const fnName = fnMatch[1];
    const fn = global[fnName];
    if (typeof fn !== 'function') return null;
    const isVoid = /void|ابطال|reverse|Cancel/i.test(fnName + (table.dataset.bulkLabel || '') + (btn.textContent || ''));
    return {
      label: table.dataset.bulkLabel || (isVoid ? 'ابطال' : 'حذف'),
      confirm: table.dataset.bulkConfirm || null,
      canDelete: () => true,
      deleteOne: async (id) => {
        const tr = [...(table.tBodies[0]?.rows || [])].find((r) => String(r.dataset.id) === String(id));
        const rowBtn = tr ? findDeleteBtn(tr) : null;
        const rowOc = rowBtn ? (rowBtn.getAttribute('onclick') || '') : oc;
        const rowFn = (rowOc.match(/^([a-zA-Z_$][\w$]*)\s*\(/) || [])[1] || fnName;

        if (rowFn === 'confirmDelete') {
          const ent = rowOc.match(/confirmDelete\s*\(\s*['"]([^'"]+)['"]/);
          if (ent) await global.api('DELETE', '/' + ent[1] + '/' + id);
          else throw new Error('entity نامشخص');
          return;
        }
        if (rowFn === 'deletePaymentOp') {
          const kind = rowOc.match(/deletePaymentOp\s*\(\s*['"]([^'"]+)['"]/);
          if (!kind) throw new Error('نوع پرداخت نامشخص');
          const endpoint = kind[1] === 'supplier'
            ? '/purchases/payments/' + id
            : kind[1] === 'incentive'
              ? '/accounting/incentive-payments/' + id
              : '/expenses/' + id;
          await global.api('DELETE', endpoint);
          return;
        }
        const mapped = DELETE_API[rowFn];
        if (mapped) {
          const [method, path] = mapped(id);
          await global.api(method, path);
          return;
        }
        await fn(id);
      },
      refresh: () => {
        if (typeof IN_ACC_SHELL !== 'undefined' && IN_ACC_SHELL && typeof accTab !== 'undefined' && accTab && typeof loadAccTab === 'function') {
          return loadAccTab(accTab);
        }
        return null;
      },
    };
  }

  global.enhanceDataTable = enhanceDataTable;
  global.tblSelectedIds = selectedIds;
  global.tblSelectedRows = selectedRows;
  global.tblInferBulkDelete = inferBulkDelete;
  global.tblEnsureRowIds = ensureRowIds;
})(window);
