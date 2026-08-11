/**
 * prod-ui.js — کامپوننت‌های مشترک ماژول عملیات تولید
 * مرجع: docs/Production/ui.md §1.3, §7
 * بدون فریم‌ورک — توابع ساده که HTML رشته‌ای برمی‌گردانند.
 * همه از window.ProdUI در دسترس‌اند.
 */
(function (global) {
  'use strict';

  function escHtml(s) {
    return (s == null ? '' : String(s)).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  /** نمایش مبلغ — واحد برنامه فقط ریال */
  function toman(rial) {
    return rialFmt(rial);
  }

  /** ریال کامل */
  function rialFmt(v) {
    if (v == null || v === '') return '—';
    return Number(v).toLocaleString('fa-IR') + ' ریال';
  }

  /** alias */
  function rial(v) { return rialFmt(v); }

  /** مقدار با ۳ رقم اعشار (رقم سوم رند) */
  function qty(v, unit) {
    if (v == null || v === '') return '—';
    const n = Number(v);
    if (!Number.isFinite(n)) return '—';
    const rounded = Math.round(n * 1000) / 1000;
    const s = parseFloat(rounded.toFixed(3));
    return Number(s).toLocaleString('fa-IR', { maximumFractionDigits: 3 }) + (unit ? ' ' + unit : '');
  }

  /** درصد با علامت */
  function pct(v, signed) {
    if (v == null || v === '') return '—';
    const s = signed && v > 0 ? '+' : '';
    return s + Number(v).toLocaleString('fa-IR', { maximumFractionDigits: 1 }) + '٪';
  }

  /** انحراف با رنگ و آیکون */
  function variance(rialValue) {
    if (!rialValue) return '<span class="prod-var-neutral">۰</span>';
    const fav = rialValue < 0;
    const cls = fav ? 'prod-var-fav' : 'prod-var-unfav';
    const icon = fav ? '🟢' : '🔴';
    const sign = fav ? '−' : '+';
    return `<span class="${cls}">${icon} ${sign}${Math.abs(rialValue).toLocaleString('fa-IR')}</span>`;
  }

  /** مبلغ بزرگ خلاصه: ۶۹۸٬۳۲۴٬۵۰۰ → ۶۹.۸ م.ت */
  function short(rialValue) {
    if (rialValue == null || rialValue === '') return '—';
    const t = Number(rialValue) / 10;
    if (Math.abs(t) >= 1e9) return (t / 1e9).toFixed(1) + ' میلیارد ت';
    if (Math.abs(t) >= 1e6) return (t / 1e6).toFixed(1) + ' م.ت';
    if (Math.abs(t) >= 1e3) return (t / 1e3).toFixed(0) + ' هزار ت';
    return t.toLocaleString('fa-IR') + ' ت';
  }

  function canSeeCost() {
    return !!global.__canSeeCost;
  }

  const BADGE_LABELS = {
    draft: '📝 پیش‌نویس',
    released: '🟡 آزادشده',
    in_progress: '🟠 در جریان',
    progress: '🟠 در جریان',
    completed: '🔵 تکمیل',
    closed: '🟢 بسته',
    cancelled: '🔴 لغو',
  };

  /** Badge وضعیت سفارش/دوره */
  function badge(status) {
    const cls = 'prod-badge prod-badge-' + (status || 'draft');
    const label = BADGE_LABELS[status] || escHtml(status || '—');
    return `<span class="${cls}">${label}</span>`;
  }

  /** مبلغ + مخفی‌سازی خودکار برای کسانی که دسترسی بها ندارند */
  function moneyCell(rialValue, opts) {
    opts = opts || {};
    const allowed = opts.canSee !== undefined ? opts.canSee : canSeeCost();
    if (!allowed) return '<span class="text-mute">—</span>';
    if (rialValue == null || rialValue === '') return '—';
    const cls = opts.big ? 'money num text-lg' : 'money num';
    const title = Number(rialValue).toLocaleString('fa-IR') + ' ریال';
    return `<span class="${cls}" title="${title}">${toman(rialValue)}</span>`;
  }

  /** انحراف با رنگ — مخفی اگر بدون دسترسی بها */
  function varianceCell(rialValue, opts) {
    opts = opts || {};
    const allowed = opts.canSee !== undefined ? opts.canSee : canSeeCost();
    if (!allowed) return '<span class="text-mute">—</span>';
    return variance(rialValue);
  }

  /** نوار مراحل تولید */
  function stageFlow(stages) {
    if (!stages || !stages.length) return `<div class="text-mute" data-csp-style="${CSP.style(`font-size:12px`)}">مرحله‌ای ثبت نشده</div>`;
    const items = stages.map(s => {
      const status = s.status || 'pending';
      const cls = status === 'done' ? 'done' : (status === 'in_progress' ? 'active' : (status === 'blocked' ? 'blocked' : 'pending'));
      const dot = status === 'done' ? '✅' : status === 'in_progress' ? '🔵' : status === 'blocked' ? '⛔' : '⚪';
      const label = escHtml((s.seq != null ? s.seq + ' ' : '') + (s.cc_name || s.cc_code || s.name || ''));
      const qtyLabel = status === 'in_progress' ? 'در جریان' : status === 'done' ? qty(s.qty_out) : status === 'blocked' ? 'متوقف' : 'منتظر';
      return `<div class="prod-stage ${cls}">
        <span class="prod-stage-dot">${dot}</span>
        <span class="prod-stage-label">${label}</span>
        <span class="prod-stage-qty">${qtyLabel}</span>
      </div>`;
    }).join('');
    return `<div class="prod-stage-flow">${items}</div>`;
  }

  /** کارت KPI */
  function kpiCard(opts) {
    let label, value, delta, icon, deltaGood, sub;
    if (typeof opts === 'object' && opts !== null && !Array.isArray(opts)) {
      ({ label, value, delta, icon, deltaGood, sub } = opts);
    } else {
      // positional fallback: kpiCard(label, value, delta)
      label = arguments[0]; value = arguments[1]; delta = arguments[2];
    }
    const arrow = delta > 0 ? '▲' : delta < 0 ? '▼' : '';
    const good = deltaGood === undefined ? delta > 0 : (delta > 0) === deltaGood;
    const cls = !delta ? 'neutral' : (good ? 'good' : 'bad');
    return `
    <div class="prod-kpi">
      ${icon ? `<div class="prod-kpi-icon">${icon}</div>` : ''}
      <div class="prod-kpi-label">${escHtml(label || '')}</div>
      <div class="prod-kpi-value num">${value != null ? value : '—'}</div>
      ${delta ? `<div class="prod-kpi-delta ${cls}">${arrow} ${pct(Math.abs(delta))}</div>` : ''}
      ${sub ? `<div class="prod-kpi-sub">${escHtml(sub)}</div>` : ''}
    </div>`;
  }

  /** نوار بار مرکز هزینه */
  function loadBar(loadPct, label) {
    const p = Number(loadPct) || 0;
    const cls = p > 100 ? 'danger' : p > 85 ? 'warn' : 'ok';
    const w = Math.min(p, 100);
    return `
    <div class="prod-load-row">
      <span class="prod-load-label">${escHtml(label || '')}</span>
      <div class="prod-load-track"><div class="prod-load-fill ${cls}" data-csp-style="${CSP.style(`width:${w}%`)}"></div></div>
      <span class="prod-load-pct num">${pct(p)}</span>
      ${p > 85 ? '<span class="prod-load-flag">◄ گلوگاه</span>' : ''}
    </div>`;
  }

  /** بنر قفل */
  function lockedBanner(message, actionHtml) {
    return `<div class="prod-locked-banner">
      <span>🔒 ${escHtml(message || 'رکورد قفل — تغییر مستقیم ممکن نیست')}</span>
      ${actionHtml || ''}
    </div>`;
  }

  /** پیش‌نمایش سند حسابداری — لیست ورودی entries: [{title, lines:[{code,name,debit,credit}]}] */
  function jePreview(entries) {
    if (!entries || !entries.length) return `<div class="text-mute" data-csp-style="${CSP.style(`font-size:12px`)}">سندی برای پیش‌نمایش نیست</div>`;
    return entries.map((je, i) => {
      const lines = je.lines || [];
      const totalDebit = lines.reduce((s, l) => s + (Number(l.debit) || 0), 0);
      const totalCredit = lines.reduce((s, l) => s + (Number(l.credit) || 0), 0);
      const balanced = Math.abs(totalDebit - totalCredit) < 1;
      const rows = lines.map(l => `<tr>
        <td class="num">${escHtml(l.code || '')}</td>
        <td>${escHtml(l.name || '')}</td>
        <td class="num">${l.debit ? rial(l.debit) : ''}</td>
        <td class="num">${l.credit ? rial(l.credit) : ''}</td>
      </tr>`).join('');
      return `<div class="prod-je-preview">
        <div class="prod-je-head"><span>▸ سند ${i + 1} — ${escHtml(je.title || '')}</span></div>
        <table><thead><tr><th>کد</th><th>نام حساب</th><th>بدهکار</th><th>بستانکار</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr>
          <td colspan="2">جمع</td><td class="num">${rial(totalDebit)}</td><td class="num">${rial(totalCredit)}</td>
        </tr></tfoot></table>
        <div data-csp-style="${CSP.style(`padding:6px 10px;font-size:12px`)}" class="${balanced ? 'prod-je-balanced' : 'prod-je-unbalanced'}">
          ${balanced ? '✅ تراز' : '⚠️ نامتوازن'}
        </div>
      </div>`;
    }).join('');
  }

  /** بررسی الزام دلیل انحراف — برمی‌گرداند {blocked:boolean} و کلاس خطا را ست می‌کند */
  function checkReasonRequired(rows, thresholdPct) {
    let blocked = false;
    for (const row of rows || []) {
      const v = row.variancePct;
      const cell = row.reasonEl;
      if (!cell) continue;
      if (Math.abs(v) > thresholdPct && !cell.value.trim()) {
        cell.classList.add('prod-required-error');
        cell.placeholder = `دلیل انحراف ${Number(v).toFixed(1)}٪ الزامی`;
        blocked = true;
      } else {
        cell.classList.remove('prod-required-error');
      }
    }
    return { blocked };
  }

  /** محاسبه انحراف مواد سمت کلاینت (§6.1 استثنا) */
  function calcVariance(AQ, SQ, AP, SP) {
    AQ = Number(AQ) || 0; SQ = Number(SQ) || 0; AP = Number(AP) || 0; SP = Number(SP) || 0;
    const varQty = AQ - SQ;
    const varPrice = Math.round((AP - SP) * AQ);
    const varQtyR = Math.round(varQty * SP);
    const percent = SQ ? (varQty / SQ) * 100 : (AQ > 0 ? 100 : 0);
    return {
      varQty, varPrice, varQtyR, total: varPrice + varQtyR, pct: percent,
      favorable: (varPrice + varQtyR) < 0,
    };
  }

  let _chartJsPromise = null;
  function loadChartJs() {
    if (global.Chart) return Promise.resolve(global.Chart);
    if (_chartJsPromise) return _chartJsPromise;
    _chartJsPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = CSP.scriptUrl('/vendor/chart.umd.js');
      s.onload = () => resolve(global.Chart);
      s.onerror = () => reject(new Error('Chart.js load failed'));
      document.head.appendChild(s);
    });
    return _chartJsPromise;
  }

  /** debounce برای فرم‌ها — پیش‌فرض ۴۰۰ms */
  function debounce(fn, ms) {
    ms = ms == null ? 400 : ms;
    let timer;
    return function debounced(...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  /** Skeleton برای جدول در حال بارگذاری */
  function skeletonRows(cols, rows) {
    rows = rows || 3;
    let out = '';
    for (let i = 0; i < rows; i++) {
      out += '<tr>' + Array.from({ length: cols }).map(() =>
        '<td><div class="prod-skeleton"></div></td>').join('') + '</tr>';
    }
    return out;
  }

  const ProdUI = {
    esc: escHtml,
    toman, rial, qty, pct, variance, short,
    badge, moneyCell, varianceCell,
    stageFlow, kpiCard, loadBar, lockedBanner, jePreview,
    checkReasonRequired, calcVariance, debounce,
    loadChartJs, skeletonRows,
    canSeeCost,
  };

  global.ProdUI = ProdUI;
})(window);
