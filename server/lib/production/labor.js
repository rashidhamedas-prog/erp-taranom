'use strict';
/**
 * Direct labor posting for production.
 * Amount math mirrors bom-advanced.stageLabor (§5.1).
 * PRD-03 JE helpers: Cr 5201 by default; when bom_operations.person_id is set,
 * Cr that person's payable leaf + person_ledger (piece-rate accrual, not payroll).
 */
const { allocateNumber } = require('../../db');
const { resolvePersonPayableAccount } = require('../payroll/person-account');

function laborErr(code, status = 422, extra = {}) {
  const e = new Error(code);
  e.code = code;
  e.status = status;
  e.extra = extra;
  return e;
}

const METHOD_FA = {
  piece: 'قطعه‌ای',
  hourly: 'ساعتی',
  hours: 'ساعتی',
  monthly: 'ماهانه',
  contract: 'پیمان',
};

/** Concise Persian JE / ledger narration for labor absorption. */
function formatLaborJeDescription({
  orderNo, productCode, productName, opName, stageSeq,
  qty, method, personName, amountRial,
} = {}) {
  const parts = [];
  if (opName) parts.push(`دستمزد ${String(opName).trim()}`);
  else if (stageSeq != null && stageSeq !== '') parts.push(`دستمزد مرحله ${stageSeq}`);
  else parts.push('دستمزد تولید');

  const prod = [productCode, productName].filter(Boolean).map((s) => String(s).trim()).filter(Boolean);
  if (prod.length) parts.push(prod.join(' '));

  const q = Number(qty);
  if (Number.isFinite(q) && q > 0) {
    const qLabel = Number.isInteger(q) ? String(q) : String(Math.round(q * 1000) / 1000);
    parts.push(`×${qLabel}`);
  }

  const mFa = METHOD_FA[String(method || '').toLowerCase()] || method;
  if (mFa) parts.push(mFa);

  if (personName) parts.push(String(personName).trim());
  if (orderNo) parts.push(String(orderNo).trim());

  const amt = Math.round(Number(amountRial) || 0);
  if (amt > 0) parts.push(`${amt.toLocaleString('fa-IR')} ریال`);

  let out = parts.filter(Boolean).join(' — ');
  if (out.length > 180) out = `${out.slice(0, 177)}…`;
  return out;
}

function loadPersonForLabor(db, personId) {
  const id = Number(personId);
  if (!id) return null;
  try {
    const row = db.prepare(`
      SELECT * FROM persons WHERE id=? AND COALESCE(active,1)=1
    `).get(id);
    return row || null;
  } catch (_) {
    return null;
  }
}

/**
 * Credit side for PRD-03.
 * @returns {{ mode:'person'|'control', person:object|null, line:{code,name,debit,credit,detail_account_id} }}
 */
function resolveLaborCreditSide(db, { personId, amountRial, crControl }) {
  const amt = Math.round(Number(amountRial) || 0);
  if (!(amt > 0)) throw laborErr('E_LABOR_AMOUNT_ZERO', 422);

  const person = loadPersonForLabor(db, personId);
  if (person) {
    const payable = resolvePersonPayableAccount(db, person);
    if (!payable || !payable.code) throw laborErr('E_PERSON_NO_COA', 422, { person_id: person.id });
    return {
      mode: 'person',
      person,
      line: {
        code: payable.code,
        name: payable.name,
        debit: 0,
        credit: amt / 10,
        detail_account_id: person.detail_account_id || null,
      },
    };
  }

  const control = typeof crControl === 'function'
    ? crControl(amt)
    : null;
  if (!control) throw laborErr('E_LABOR_CONTROL_MISSING', 500);
  return { mode: 'control', person: null, line: control };
}

function writePersonLaborLedger(db, {
  personId, laborEntryId, date, description, amountRial, userId,
}) {
  const amt = Math.round(Number(amountRial) || 0);
  const pid = Number(personId);
  const lid = Number(laborEntryId);
  if (!(amt > 0) || !pid || !lid) return 0;
  try {
    const alive = (() => {
      try {
        const cols = db.prepare('PRAGMA table_info(person_ledger)').all().map((c) => c.name);
        if (cols.includes('deleted_at')) return 'COALESCE(deleted_at,0)=0';
      } catch (_) { /* old schema */ }
      return '1=1';
    })();
    const exists = db.prepare(`
      SELECT id FROM person_ledger
      WHERE person_id=? AND ref_type='production_labor' AND ref_id=? AND ${alive}
      LIMIT 1
    `).get(pid, lid);
    if (exists) return 0;
    db.prepare(`
      INSERT INTO person_ledger
        (person_id, date, entry_type, ref_type, ref_id, description, debit, credit, user_id)
      VALUES (?,?,?,?,?,?,0,?,?)
    `).run(
      pid,
      date || '',
      'production_labor',
      'production_labor',
      lid,
      description || 'دستمزد تولید',
      amt,
      userId || null
    );
    return 1;
  } catch (e) {
    if (e && e.code && String(e.code).startsWith('E_')) throw e;
    return 0;
  }
}

function retirePersonLaborLedger(db, laborEntryId) {
  const lid = Number(laborEntryId);
  if (!lid) return 0;
  try {
    const { retirePersonLedgerByRef } = require('../party-ledger-retire');
    return retirePersonLedgerByRef(db, {
      refTypes: ['production_labor'],
      refId: lid,
    });
  } catch (_) {
    try {
      return Number(db.prepare(`
        DELETE FROM person_ledger WHERE ref_type='production_labor' AND ref_id=?
      `).run(lid).changes || 0);
    } catch (__) {
      return 0;
    }
  }
}

function retirePersonLaborForEntries(db, entries) {
  let n = 0;
  for (const e of entries || []) {
    if (e && e.id) n += retirePersonLaborLedger(db, e.id);
  }
  return n;
}

/**
 * Build product label for JE from production_orders row.
 */
function productLabelForOrder(db, po) {
  if (!po) return { productCode: '', productName: '' };
  try {
    const p = db.prepare('SELECT code, name FROM products WHERE id=?').get(po.product_id);
    return {
      productCode: p?.code || '',
      productName: p?.name || po.product_name || '',
    };
  } catch (_) {
    return { productCode: '', productName: po.product_name || '' };
  }
}

/**
 * Compute labor amount (INTEGER rial) from method + inputs.
 * @returns {{ amount: number, hours: number, rate: number }}
 */
function computeLaborAmount({
  method = 'piece',
  qty = 0,
  hours = 0,
  rateRial = 0,
  setupMinutes,
  runMinutesPerUnit,
  crewSize,
} = {}) {
  const m = String(method || 'piece').toLowerCase();
  const rate = Math.round(Number(rateRial) || 0);
  const q = Number(qty) || 0;

  if (m === 'contract') {
    return { amount: 0, hours: 0, rate };
  }

  if (m === 'hourly' || m === 'hours') {
    // Prefer setup/run formula when timing fields are present (bom_operations path).
    // If only hours are supplied (laborSpecs), use hours as-is.
    const hasTiming = setupMinutes != null || runMinutesPerUnit != null;
    let h = Number(hours) || 0;

    if (hasTiming) {
      const run = Number(runMinutesPerUnit) || 0;
      if (!(run > 0)) throw laborErr('E_NO_RUN_TIME', 422);
      const crew = (crewSize == null || crewSize === '') ? 1 : Number(crewSize);
      if (!Number.isFinite(crew) || crew <= 0) throw laborErr('E_CREW_ZERO', 422);
      const mins = (Number(setupMinutes) || 0) + run * q;
      h = (mins / 60) * crew;
    }

    return { amount: Math.round(rate * h), hours: h, rate };
  }

  if (m === 'piece') {
    if (!(rate > 0)) throw laborErr('E_LABOR_RATE_ZERO', 422);
    return { amount: Math.round(rate * q), hours: Number(hours) || 0, rate };
  }

  if (m === 'monthly') {
    // rate comes from caller (typically cost_center_rates.monthly_labor_rate_rial)
    return { amount: Math.round(rate * q), hours: Number(hours) || 0, rate };
  }

  // unknown method — best-effort qty×rate
  return {
    amount: Math.round((q || Number(hours) || 0) * rate),
    hours: Number(hours) || 0,
    rate,
  };
}

function lookupMonthlyLaborRate(db, costCenterId, period) {
  if (!costCenterId) return 0;
  try {
    const rate = db.prepare(`
      SELECT monthly_labor_rate_rial FROM cost_center_rates
      WHERE cost_center_id=? AND period_label=? AND status IN ('active','approved','draft','estimated')
      ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END
      LIMIT 1
    `).get(costCenterId, period)
      || db.prepare(`
        SELECT monthly_labor_rate_rial FROM cost_center_rates
        WHERE cost_center_id=? AND COALESCE(monthly_labor_rate_rial,0)>0
        ORDER BY period_label DESC LIMIT 1
      `).get(costCenterId);
    return Math.round(Number(rate?.monthly_labor_rate_rial) || 0);
  } catch {
    return 0;
  }
}

function sumLabor(db, orderId) {
  const r = db.prepare(`
    SELECT COALESCE(SUM(amount_rial),0) s FROM production_labor_entries
    WHERE order_id=? AND status='posted'
  `).get(orderId);
  return Math.round(Number(r?.s) || 0);
}

function postLabor(db, {
  orderId, costCenterId, method = 'piece', qty = 0, hours = 0,
  rateRial = 0, personId = null, date, period, userId, note = '', stageId = null,
  stdRateRial = 0, stdHours = 0,
  setupMinutes, runMinutesPerUnit, crewSize,
}) {
  const computed = computeLaborAmount({
    method,
    qty,
    hours,
    rateRial,
    setupMinutes,
    runMinutesPerUnit,
    crewSize,
  });
  const rate = computed.rate;
  const amount = computed.amount;
  const hoursOut = computed.hours;

  let docNo = '';
  try {
    docNo = allocateNumber(db, 'labor_entry', 'LB');
  } catch {
    docNo = `LB-${Date.now()}`;
  }

  const stdAmt = Math.round((Number(stdHours) || Number(qty) || 0) * (Number(stdRateRial) || rate));
  const id = db.prepare(`
    INSERT INTO production_labor_entries
      (doc_no, order_id, stage_id, cost_center_id, person_id, method,
       qty, hours, std_hours, rate_rial, std_rate_rial, amount_rial, std_amount_rial,
       var_rate_rial, var_eff_rial, date, period_label, status, note, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'posted',?,?)
  `).run(
    docNo, orderId, stageId, costCenterId, personId, method,
    Number(qty) || 0, hoursOut, Number(stdHours) || 0,
    rate, Math.round(Number(stdRateRial) || 0), amount, stdAmt,
    amount - stdAmt, 0, date, period, note, userId
  ).lastInsertRowid;

  return { id, amount_rial: amount, method, qty, hours: hoursOut, rate_rial: rate };
}

/**
 * Auto-post labor from body.labor rates × qtyStarted, or bom_operations (§5.1).
 * body.labor = [{ method:'piece', rate_rial:250000 }, { method:'monthly', rate_rial:40000 }]
 */
function autoPostLabor(db, { po, qtyStarted, date, period, userId, laborSpecs = null }) {
  let total = 0;
  const specs = laborSpecs || [];

  if (specs.length) {
    for (const s of specs) {
      const method = s.method || 'piece';
      if (method === 'contract') continue;

      const r = postLabor(db, {
        orderId: po.id,
        costCenterId: s.cost_center_id || po.cost_center_id,
        method,
        qty: qtyStarted,
        hours: s.hours || 0,
        rateRial: s.rate_rial != null ? s.rate_rial : (s.rateRial || 0),
        personId: s.person_id || null,
        setupMinutes: s.setup_minutes != null ? s.setup_minutes : s.setupMinutes,
        runMinutesPerUnit: s.run_minutes_per_unit != null ? s.run_minutes_per_unit : s.runMinutesPerUnit,
        crewSize: s.crew_size != null ? s.crew_size : s.crewSize,
        date, period, userId,
        note: s.note || 'جذب خودکار دستمزد',
      });
      total += r.amount_rial;
    }
    return total;
  }

  // From bom_operations if present — piece/hourly/monthly/contract per §5.1
  let opsPosted = false;
  try {
    if (po.bom_id) {
      const ops = db.prepare(`
        SELECT * FROM bom_operations WHERE bom_id=? ORDER BY seq
      `).all(po.bom_id);

      if (ops.length) {
        opsPosted = true;
        for (const op of ops) {
          const method = op.labor_method || 'piece';
          if (method === 'contract') continue; // subcontract handled elsewhere

          let rateRial = Math.round(Number(op.labor_rate_rial) || 0);
          if (method === 'monthly') {
            rateRial = lookupMonthlyLaborRate(db, op.cost_center_id || po.cost_center_id, period);
            if (!(rateRial > 0)) continue;
          }

          const person = loadPersonForLabor(db, op.person_id);
          const { productCode, productName } = productLabelForOrder(db, po);
          const r = postLabor(db, {
            orderId: po.id,
            costCenterId: op.cost_center_id || po.cost_center_id,
            personId: op.person_id || null,
            method,
            qty: qtyStarted,
            rateRial,
            setupMinutes: op.setup_minutes,
            runMinutesPerUnit: op.run_minutes_per_unit,
            crewSize: op.crew_size,
            date, period, userId,
            note: formatLaborJeDescription({
              orderNo: po.order_no,
              productCode,
              productName,
              opName: op.operation_name || op.name || `عملیات ${op.seq}`,
              qty: qtyStarted,
              method,
              personName: person?.name,
            }),
          });
          try {
            db.prepare('UPDATE production_labor_entries SET note=? WHERE id=?').run(
              formatLaborJeDescription({
                orderNo: po.order_no,
                productCode,
                productName,
                opName: op.operation_name || op.name || `عملیات ${op.seq}`,
                qty: qtyStarted,
                method,
                personName: person?.name,
                amountRial: r.amount_rial,
              }),
              r.id
            );
          } catch (_) { /* note column optional */ }
          total += r.amount_rial;
        }
      }
    }
  } catch (e) {
    // Re-throw validation errors from computeLaborAmount; swallow missing-table / empty
    if (e && e.code && String(e.code).startsWith('E_')) throw e;
    /* bom_operations may be empty / missing */
  }

  // Fallback: monthly_labor_rate_rial from cost_center_rates for the period
  if (!opsPosted && !total && po.cost_center_id) {
    const ml = lookupMonthlyLaborRate(db, po.cost_center_id, period);
    if (ml > 0) {
      const r = postLabor(db, {
        orderId: po.id,
        costCenterId: po.cost_center_id,
        method: 'monthly',
        qty: qtyStarted,
        rateRial: ml,
        date, period, userId,
        note: 'دستمزد از نرخ مرکز هزینه',
      });
      total += r.amount_rial;
    }
  }

  return total;
}

/**
 * Post PRD-03 for one or more labor entries already inserted.
 * When person_id is set on an entry, credits that person's payable leaf and
 * writes person_ledger; otherwise credits coa_labor_control (5201).
 * If entries have mixed persons, posts one JE per credit bucket.
 */
function absorbLaborJournal(db, {
  orderId, date, userId, costCenterId, wipTafsili,
  entries, descriptionFallback, postEvent, dr, cr,
}) {
  if (!postEvent || !dr || !cr) throw laborErr('E_LABOR_POST_HELPERS', 500);
  const list = (entries || []).filter((e) => e && Math.round(Number(e.amount_rial) || 0) > 0);
  if (!list.length) return [];

  const buckets = new Map();
  for (const e of list) {
    const key = e.person_id ? `p:${e.person_id}` : 'control';
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(e);
  }

  const jes = [];
  for (const group of buckets.values()) {
    const amountRial = group.reduce((s, e) => s + Math.round(Number(e.amount_rial) || 0), 0);
    if (!(amountRial > 0)) continue;
    const personId = group[0].person_id || null;
    const credit = resolveLaborCreditSide(db, {
      personId,
      amountRial,
      crControl: (amt) => cr(db, 'coa_labor_control', amt),
    });
    const desc = group[0].note
      || descriptionFallback
      || formatLaborJeDescription({ amountRial, personName: credit.person?.name });

    const je = postEvent(db, {
      event: 'PRD-03',
      sourceId: orderId,
      date,
      description: desc,
      createdBy: userId,
      costCenterId: costCenterId || null,
      lines: [
        dr(db, 'coa_wip', amountRial, wipTafsili || null),
        credit.line,
      ],
    });
    if (!je) continue;
    jes.push(je);
    const ids = group.map((e) => e.id).filter(Boolean);
    if (ids.length) {
      db.prepare(`
        UPDATE production_labor_entries SET je_id=?
        WHERE id IN (${ids.map(() => '?').join(',')}) AND je_id IS NULL
      `).run(je.je_id, ...ids);
    }
    if (credit.mode === 'person' && credit.person) {
      for (const e of group) {
        writePersonLaborLedger(db, {
          personId: credit.person.id,
          laborEntryId: e.id,
          date,
          description: e.note || desc,
          amountRial: Math.round(Number(e.amount_rial) || 0),
          userId,
        });
      }
    }
  }
  return jes;
}

module.exports = {
  sumLabor,
  postLabor,
  autoPostLabor,
  computeLaborAmount,
  formatLaborJeDescription,
  resolveLaborCreditSide,
  writePersonLaborLedger,
  retirePersonLaborLedger,
  retirePersonLaborForEntries,
  productLabelForOrder,
  loadPersonForLabor,
  absorbLaborJournal,
};
