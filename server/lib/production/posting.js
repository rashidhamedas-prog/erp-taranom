'use strict';
/**
 * Production journal helpers — PRD-01…PRD-99
 * Lines use TOMAN (rial/10) for postToLedger.
 */
const { postToLedger } = require('../ledger');
const { acct } = require('../coa-map');
const { todayJalali } = require('../../jalali');

function err(code, status = 422, extra = {}) {
  const e = new Error(code);
  e.code = code;
  e.status = status;
  e.extra = extra;
  return e;
}

function dr(db, key, rial, tafsili = null) {
  const a = acct(db, key);
  return {
    code: a.code,
    name: a.name,
    debit: Number(rial) / 10,
    credit: 0,
    detail_account_id: tafsili || null,
  };
}

function cr(db, key, rial, tafsili = null) {
  const a = acct(db, key);
  return {
    code: a.code,
    name: a.name,
    debit: 0,
    credit: Number(rial) / 10,
    detail_account_id: tafsili || null,
  };
}

/** Drop zero lines; absorb ≤0.5 toman rounding into last credit/debit line. */
function plug(lines) {
  const kept = (lines || []).filter(l => (Number(l.debit) || 0) + (Number(l.credit) || 0) > 0);
  if (!kept.length) return kept;
  const d = kept.reduce((s, l) => s + (Number(l.debit) || 0), 0);
  const c = kept.reduce((s, l) => s + (Number(l.credit) || 0), 0);
  const diff = Math.round((d - c) * 10) / 10;
  if (diff !== 0 && Math.abs(diff) <= 0.5) {
    const last = kept[kept.length - 1];
    if (last.credit) last.credit += diff;
    else last.debit -= diff;
  }
  return kept;
}

const PRD = {
  'PRD-01': { name: 'مصرف مواد', sourceType: 'production_material_issue' },
  'PRD-02': { name: 'برگشت مواد', sourceType: 'production_material_return' },
  'PRD-03': { name: 'جذب دستمزد', sourceType: 'production_labor' },
  'PRD-04': { name: 'دستمزد واقعی', sourceType: 'production_labor_actual' },
  'PRD-05': { name: 'جذب سربار', sourceType: 'production_overhead' },
  'PRD-06': { name: 'سربار واقعی', sourceType: 'production_overhead_actual' },
  'PRD-07': { name: 'رسید تولید', sourceType: 'production_receipt' },
  'PRD-09': { name: 'ضایعات غیرعادی', sourceType: 'production_waste' },
  'PRD-10': { name: 'ضایعات قابل فروش', sourceType: 'production_scrap' },
  'PRD-11': { name: 'دوباره‌کاری عادی', sourceType: 'production_rework' },
  'PRD-12': { name: 'دوباره‌کاری غیرعادی', sourceType: 'production_rework' },
  'PRD-13': { name: 'ارسال به پیمانکار', sourceType: 'production_subcontract_out' },
  'PRD-14': { name: 'دریافت از پیمانکار', sourceType: 'production_subcontract_in' },
  'PRD-16': { name: 'محصول فرعی', sourceType: 'production_byproduct' },
  'PRD-17': { name: 'تعدیل انبارگردانی', sourceType: 'production_stock_adjust' },
  'PRD-21': { name: 'بستن انحراف دستمزد', sourceType: 'production_close_labor' },
  'PRD-22': { name: 'بستن انحراف سربار', sourceType: 'production_close_overhead' },
  'PRD-23': { name: 'تسهیم انحراف', sourceType: 'production_close_allocate' },
  'PRD-99': { name: 'ابطال سند تولید', sourceType: 'production_reversal' },
};

const ORDER_CC_EVENTS = new Set(['PRD-01', 'PRD-02', 'PRD-03', 'PRD-05', 'PRD-07', 'PRD-11', 'PRD-12', 'PRD-16']);

function inferCostCenterId(db, event, sourceId) {
  const id = parseInt(sourceId, 10);
  if (!id) return null;
  try {
    if (event === 'PRD-09') {
      return db.prepare('SELECT cost_center_id FROM production_waste WHERE id=?').get(id)?.cost_center_id || null;
    }
    if (ORDER_CC_EVENTS.has(event) || event === 'PRD-10') {
      return db.prepare('SELECT cost_center_id FROM production_orders WHERE id=?').get(id)?.cost_center_id || null;
    }
  } catch (_) { /* table may be absent in a partial boot */ }
  return null;
}

function postEvent(db, { event, sourceId, date, description, createdBy, lines, costCenterId }) {
  const spec = PRD[event];
  if (!spec) throw err('E_UNKNOWN_PRD', 500, { event });
  const clean = plug(lines);
  if (!clean.length) return null;
  const cc = costCenterId || inferCostCenterId(db, event, sourceId);
  const jeId = postToLedger(db, {
    sourceType: spec.sourceType,
    sourceId,
    date,
    description: description || spec.name,
    createdBy,
    costCenterId: cc || null,
    lines: clean,
    voucherType: 'auto',
    status: 'approved',
  });
  const amountRial = Math.round(clean.reduce((s, l) => s + (Number(l.debit) || 0), 0) * 10);
  return { event, je_id: jeId, amount_rial: amountRial };
}

/** PRD-21 — close labor control into rate variance (5212). */
function postCloseLabor(db, { closeId, date, userId, controlBalance }) {
  const bal = Math.round(Number(controlBalance) || 0);
  if (!bal) return null;
  const amt = Math.abs(bal);
  const lines = bal > 0
    ? [dr(db, 'coa_var_labor_rate', amt), cr(db, 'coa_labor_control', amt)]
    : [dr(db, 'coa_labor_control', amt), cr(db, 'coa_var_labor_rate', amt)];
  return postEvent(db, {
    event: 'PRD-21',
    sourceId: closeId,
    date,
    description: 'بستن انحراف دستمزد',
    createdBy: userId,
    lines,
  });
}

/** PRD-22 — transfer applied OH to control, then close control to volume variance. */
function postCloseOverhead(db, { closeId, date, userId, appliedRial, varianceRial }) {
  const out = [];
  const applied = Math.round(Number(appliedRial) || 0);
  if (applied > 0) {
    out.push(postEvent(db, {
      event: 'PRD-22',
      sourceId: closeId,
      date,
      description: 'انتقال سربار جذب‌شده',
      createdBy: userId,
      lines: [
        dr(db, 'coa_overhead_applied', applied),
        cr(db, 'coa_overhead_control', applied),
      ],
    }));
  }
  const variance = Math.round(Number(varianceRial) || 0);
  if (variance) {
    const amt = Math.abs(variance);
    const lines = variance > 0
      ? [dr(db, 'coa_var_oh_volume', amt), cr(db, 'coa_overhead_control', amt)]
      : [dr(db, 'coa_overhead_control', amt), cr(db, 'coa_var_oh_volume', amt)];
    out.push(postEvent(db, {
      event: 'PRD-22',
      sourceId: closeId,
      date,
      description: 'بستن انحراف سربار',
      createdBy: userId,
      lines,
    }));
  }
  return out.filter(Boolean);
}

/**
 * Build PRD-23 lines with independent signs per component (F03).
 * Positive destination = Dr WIP/FG/COGS; positive variance = Cr variance account.
 * Net-zero total with non-zero components still posts a balanced entry.
 */
function buildAllocationLines(db, allocation) {
  const tot = allocation?.total || {};
  const labor = allocation?.labor || {};
  const oh = allocation?.overhead || {};
  const wip = Math.round(Number(tot.wip_rial) || 0);
  const fg = Math.round(Number(tot.fg_rial) || 0);
  const cogs = Math.round(Number(tot.cogs_rial) || 0);
  const laborV = Math.round(Number(labor.total_rial) || 0);
  const ohV = Math.round(Number(oh.total_rial) || 0);

  if (![wip, fg, cogs, laborV, ohV].some((v) => v !== 0)) return [];

  const lines = [];
  const pushDest = (key, amt) => {
    if (!amt) return;
    if (amt > 0) lines.push(dr(db, key, amt));
    else lines.push(cr(db, key, Math.abs(amt)));
  };
  const pushVar = (key, amt) => {
    if (!amt) return;
    // Positive variance cleared into destinations → credit variance account
    if (amt > 0) lines.push(cr(db, key, amt));
    else lines.push(dr(db, key, Math.abs(amt)));
  };

  pushDest('coa_wip', wip);
  pushDest('coa_finished_goods', fg);
  pushDest('coa_cogs', cogs);
  pushVar('coa_var_labor_rate', laborV);
  pushVar('coa_var_oh_volume', ohV);
  return lines;
}

/** PRD-23 — allocate labor + OH variances to WIP / FG / COGS. */
function postAllocation(db, { closeId, date, userId, allocation }) {
  const lines = buildAllocationLines(db, allocation);
  if (!lines.length) return null;

  return postEvent(db, {
    event: 'PRD-23',
    sourceId: closeId,
    date,
    description: 'تسهیم انحراف',
    createdBy: userId,
    lines,
  });
}

function reverseEvent(db, { jeId, reason, userId, date }) {
  const orig = db.prepare(`
    SELECT jl.*, je.ref_type, je.ref_id, je.description
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.entry_id
    WHERE jl.entry_id = ?
    ORDER BY jl.line_no, jl.id
  `).all(jeId);
  if (!orig.length) throw err('E_NOT_FOUND', 404);

  const revDate = date || todayJalali();
  return postToLedger(db, {
    sourceType: (orig[0].ref_type || 'production') + '_reversal',
    sourceId: orig[0].ref_id,
    date: revDate,
    description: `ابطال — ${orig[0].description || ''} — ${reason || ''}`,
    createdBy: userId,
    lines: orig.map(l => ({
      code: l.account_code,
      name: l.account_name,
      debit: (Number(l.credit_rial) || Math.round((Number(l.credit) || 0) * 10)) / 10,
      credit: (Number(l.debit_rial) || Math.round((Number(l.debit) || 0) * 10)) / 10,
      description: `ابطال — ${l.description || ''}`,
      detail_account_id: l.detail_account_id || null,
      cost_center_id: l.cost_center_id || null,
      project_id: l.project_id || null,
      tax_type: l.tax_type || null,
      tafsili2_code: l.tafsili2_code || null,
    })),
  });
}

module.exports = {
  dr, cr, plug, postEvent, reverseEvent, postCloseLabor, postCloseOverhead, postAllocation,
  buildAllocationLines, PRD, err,
};
