/**
 * جدول‌های حسابداری: سورت ستون، فیلتر سریع، انتخاب چندتایی
 * استفاده: enhanceDataTable(tableEl, { selectable: true, onSelectionChange })
 */
(function (global) {
  function cellText(td) {
    return (td?.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function enhanceDataTable(table, opts) {
    if (!table || table.dataset.enhanced === '1') return;
    opts = opts || {};
    table.dataset.enhanced = '1';
    const thead = table.tHead;
    const tbody = table.tBodies[0];
    if (!thead || !tbody) return;

    const headerRow = thead.rows[0];
    if (!headerRow) return;

    let sortCol = -1;
    let sortDir = 1;
    const filters = {};

    // Multi-select column
    if (opts.selectable) {
      const th = document.createElement('th');
      th.className = 'tbl-sel-th';
      th.innerHTML = `<input type="checkbox" title="انتخاب همه" class="tbl-sel-all">`;
      headerRow.insertBefore(th, headerRow.firstChild);
      [...tbody.rows].forEach((tr) => {
        const td = document.createElement('td');
        td.className = 'tbl-sel-td';
        const id = tr.dataset.id || tr.getAttribute('data-id') || '';
        td.innerHTML = `<input type="checkbox" class="tbl-sel-row" data-id="${id}">`;
        tr.insertBefore(td, tr.firstChild);
      });
      th.querySelector('.tbl-sel-all').addEventListener('change', (e) => {
        tbody.querySelectorAll('.tbl-sel-row').forEach((cb) => {
          if (cb.closest('tr').style.display === 'none') return;
          cb.checked = e.target.checked;
        });
        if (opts.onSelectionChange) opts.onSelectionChange(selectedIds(table));
      });
      tbody.addEventListener('change', (e) => {
        if (e.target.classList.contains('tbl-sel-row') && opts.onSelectionChange) {
          opts.onSelectionChange(selectedIds(table));
        }
      });
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
        rows.sort((a, b) => {
          const av = cellText(a.cells[idx]);
          const bv = cellText(b.cells[idx]);
          const an = Number(String(av).replace(/[^\d.-]/g, ''));
          const bn = Number(String(bv).replace(/[^\d.-]/g, ''));
          if (Number.isFinite(an) && Number.isFinite(bn) && String(av).match(/\d/) && String(bv).match(/\d/)) {
            return (an - bn) * sortDir;
          }
          return av.localeCompare(bv, 'fa') * sortDir;
        });
        rows.forEach((r) => tbody.appendChild(r));
      });
      th.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const q = prompt('فیلتر ستون «' + label + '» (خالی = حذف فیلتر):', filters[idx] || '');
        if (q === null) return;
        if (!q.trim()) delete filters[idx];
        else filters[idx] = q.trim().toLowerCase();
        applyFilters();
      });
    });

    function applyFilters() {
      [...tbody.rows].forEach((tr) => {
        let ok = true;
        for (const [ci, q] of Object.entries(filters)) {
          const t = cellText(tr.cells[+ci]).toLowerCase();
          if (!t.includes(q)) { ok = false; break; }
        }
        tr.style.display = ok ? '' : 'none';
      });
    }

    table._tblApplyFilters = applyFilters;
  }

  function selectedIds(table) {
    return [...table.querySelectorAll('.tbl-sel-row:checked')]
      .map((cb) => cb.dataset.id || cb.closest('tr')?.dataset.id)
      .filter(Boolean);
  }

  function selectedRows(table) {
    return [...table.querySelectorAll('.tbl-sel-row:checked')].map((cb) => cb.closest('tr')).filter(Boolean);
  }

  global.enhanceDataTable = enhanceDataTable;
  global.tblSelectedIds = selectedIds;
  global.tblSelectedRows = selectedRows;
})(window);
