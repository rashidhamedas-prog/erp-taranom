'use strict';
/**
 * Production Module 4 — Advanced BOM (routing, co/by, roll-up)
 * NO ledger posting.
 */
const { explodeBom, resolveBom } = require('./bom');
const { getOverheadRate } = require('./overhead');
const { setting } = require('./costing');
const { todayJalali } = require('../../jalali');

function err(code, status = 422, extra = {}) {
  const e = new Error(code);
  e.code = code;
  e.status = status;
  e.extra = extra;
  return e;
}

function round6(n) {
  return Math.round(Number(n) * 1e6) / 1e6;
}

function pct(part, whole) {
  if (!whole) return 0;
  return Math.round((part / whole) * 1000) / 10;
}

function productName(db, id) {
  return db.prepare('SELECT name FROM products WHERE id=?').get(id)?.name || String(id);
}

function supplierName(db, id) {
  if (!id) return null;
  try {
    return db.prepare('SELECT name FROM suppliers WHERE id=?').get(id)?.name || null;
  } catch {
    return null;
  }
}

function outMeta(db, o) {
  return {
    type: o.output_type,
    product_id: o.product_id,
    name: productName(db, o.product_id),
    cost_method: o.cost_method,
    qty_per_base: o.qty_per_base,
  };
}

/** تعداد شروع لازم برای رسیدن به هدف */
function backwardQty(db, bomId, target) {
  const ops = db.prepare('SELECT * FROM bom_operations WHERE bom_id=? ORDER BY seq').all(bomId);
  if (!ops.length) {
    return { qty_start: Math.ceil(Number(target) || 0), total_yield_percent: 100 };
  }
  const factor = ops.reduce((f, op) =>
    f * ((Number(op.yield_percent) || 100) / 100) * (1 - (Number(op.normal_waste_percent) || 0) / 100), 1);
  if (factor <= 0) throw err('E_OP_YIELD_RANGE', 422);
  return {
    qty_start: Math.ceil(Number(target) / factor),
    total_yield_percent: round6(factor * 100),
  };
}

function stageLabor(db, op, qty, period) {
  switch (op.labor_method) {
    case 'piece':
      if (!op.labor_rate_rial) throw err('E_LABOR_RATE_ZERO', 422, { seq: op.seq });
      return Math.round(Number(op.labor_rate_rial) * qty);
    case 'hourly': {
      if (!op.run_minutes_per_unit) throw err('E_NO_RUN_TIME', 422, { seq: op.seq });
      const crew = Number(op.crew_size) || 1;
      if (crew <= 0) throw err('E_CREW_ZERO', 422);
      const mins = (Number(op.setup_minutes) || 0) + Number(op.run_minutes_per_unit) * qty;
      const hours = (mins / 60) * crew;
      return Math.round(Number(op.labor_rate_rial) * hours);
    }
    case 'monthly': {
      const r = db.prepare(`
        SELECT monthly_labor_rate_rial FROM cost_center_rates
        WHERE cost_center_id=? AND period_label=?
      `).get(op.cost_center_id, period);
      return Math.round((Number(r?.monthly_labor_rate_rial) || 0) * qty);
    }
    case 'contract':
      return 0;
    default:
      return 0;
  }
}

function stageDriverQty(db, op, cc, ctx) {
  const driver = op.overhead_driver || cc.driver || 'output_qty';
  switch (driver) {
    case 'output_qty':
      return ctx.qty;
    case 'direct_labor_rial':
      return ctx.labor / 1_000_000;
    case 'direct_labor_hours':
      return (((Number(op.setup_minutes) || 0) + Number(op.run_minutes_per_unit) * ctx.qty) / 60)
        * (Number(op.crew_size) || 1);
    case 'machine_hours': {
      if (!op.machine_minutes_per_unit && op.machine_minutes_per_unit !== 0) {
        throw err('E_NO_MACHINE_TIME', 422, { seq: op.seq });
      }
      return (Number(op.machine_minutes_per_unit) || 0) * ctx.qty / 60;
    }
    case 'material_rial':
      return ctx.material / 1_000_000;
    case 'manual':
      return ctx.manualDriver || 0;
    default:
      return 0;
  }
}

/**
 * Full stage roll-up. No ledger.
 */
function rollUpBom(db, { bomId, qtyTarget, period, priceBasis = 'average', level = 0 }) {
  if (level > 10) throw err('E_BOM_TOO_DEEP', 422);

  const bom = db.prepare('SELECT * FROM bom_headers WHERE id=?').get(bomId);
  if (!bom) throw err('E_NOT_FOUND', 404);
  const ops = db.prepare('SELECT * FROM bom_operations WHERE bom_id=? ORDER BY seq').all(bomId);
  if (bom.has_routing && !ops.length) throw err('E_ROUTING_EMPTY', 422);

  // V4-21
  if (bom.has_routing && Math.abs((bom.yield_percent ?? 100) - 100) > 0.001) {
    throw err('E_YIELD_DOUBLE_COUNT', 422, { yield: bom.yield_percent });
  }

  const { qty_start, total_yield_percent } = ops.length
    ? backwardQty(db, bomId, qtyTarget)
    : { qty_start: Number(qtyTarget), total_yield_percent: 100 };

  // V4-21: force header yield 100 when routing present
  const ex = explodeBom(db, {
    bomId,
    qty: qty_start,
    priceBasis,
    level,
    yieldOverride: bom.has_routing ? 100 : null,
  });

  const matByStage = {};
  const warnings = [];
  const firstStage = ops[0]?.cost_center_id ?? null;
  for (const L of ex.lines) {
    let cc = L.stage_cost_center_id;
    if (!cc) {
      cc = firstStage;
      warnings.push(`قلم ${L.product_id} مرحله ندارد — به اولین مرحله نسبت داده شد`);
    }
    (matByStage[cc] ||= { rial: 0, kind: {} });
    matByStage[cc].rial += L.amount_rial;
    const kind = L.line_kind || 'material';
    matByStage[cc].kind[kind] = (matByStage[cc].kind[kind] || 0) + L.amount_rial;
  }

  const stages = [];
  let qtyIn = qty_start;
  let costIn = 0;
  let totMat = 0, totPkg = 0, totLab = 0, totSub = 0, totOh = 0;

  for (const op of ops) {
    const cc = db.prepare('SELECT * FROM cost_centers WHERE id=?').get(op.cost_center_id);
    if (!cc || !Number(cc.is_stage)) throw err('E_CC_NOT_STAGE', 422, { cc: cc?.name });

    const material = matByStage[op.cost_center_id]?.rial || 0;
    const pkg = matByStage[op.cost_center_id]?.kind?.packaging || 0;
    const labor = stageLabor(db, op, qtyIn, period);
    const subcon = op.is_subcontract
      ? Math.round((Number(op.subcontract_fee_rial) || 0) * qtyIn)
      : 0;

    const rate = getOverheadRate(db, op.cost_center_id, period) || { total_rate_rial: 0, is_estimated: 1 };
    if (rate.is_estimated) warnings.push(`نرخ سربار «${cc.name}» برآوردی است`);
    const driverQty = stageDriverQty(db, op, cc, { qty: qtyIn, labor, material });
    const overhead = Math.round(Number(rate.total_rate_rial || 0) * driverQty);

    const qtyOut = round6(
      qtyIn * ((Number(op.yield_percent) || 100) / 100)
        * (1 - (Number(op.normal_waste_percent) || 0) / 100)
    );
    const costOut = costIn + material + labor + subcon + overhead;

    stages.push({
      seq: op.seq,
      cost_center_id: op.cost_center_id,
      cost_center: `${cc.code} ${cc.name}`,
      qty_in: qtyIn,
      qty_out: qtyOut,
      cost_in_rial: costIn,
      material_rial: material,
      labor_rial: labor,
      subcontract_rial: subcon,
      overhead_rial: overhead,
      overhead_driver: op.overhead_driver || cc.driver,
      overhead_driver_qty: round6(driverQty),
      overhead_rate_rial: Math.round(Number(rate.total_rate_rial) || 0),
      cost_out_rial: costOut,
      unit_cost_out_rial: qtyOut ? Math.round(costOut / qtyOut) : 0,
      supplier: op.is_subcontract ? supplierName(db, op.subcontract_supplier_id) : null,
    });

    totMat += material - pkg;
    totPkg += pkg;
    totLab += labor;
    totSub += subcon;
    totOh += overhead;
    qtyIn = qtyOut;
    costIn = costOut;
  }

  const wipFinal = costIn;
  const outs = db.prepare('SELECT * FROM bom_outputs WHERE bom_id=?').all(bomId);
  const mains = outs.filter(o => o.output_type === 'main');
  if (bom.has_coproducts && mains.length !== 1) throw err('E_NO_MAIN_OUTPUT', 422);

  // If no outputs defined, synthesize main = product with 100% share
  let effectiveOuts = outs;
  if (!outs.length) {
    effectiveOuts = [{
      output_type: 'main',
      product_id: bom.product_id,
      qty_per_base: 1,
      cost_method: 'share',
      cost_share_percent: 100,
      nrv_rial: 0,
    }];
  }

  const result = [];
  let byCredit = 0;
  for (const o of effectiveOuts.filter(o => ['by', 'scrap'].includes(o.output_type))) {
    if (o.cost_method === 'zero') {
      result.push({ ...outMeta(db, o), amount_rial: 0 });
      continue;
    }
    if (o.cost_method === 'nrv' && !o.nrv_rial) {
      throw err('E_NRV_ZERO', 422, { name: productName(db, o.product_id) });
    }
    const q = round6(Number(o.qty_per_base) * qty_start / (bom.base_qty || 1));
    const amt = Math.round(q * Number(o.nrv_rial || 0));
    byCredit += amt;
    result.push({ ...outMeta(db, o), qty: q, unit_rial: o.nrv_rial, amount_rial: amt });
  }
  if (byCredit > wipFinal) throw err('E_NRV_EXCEEDS_WIP', 422);

  const wipAfterBy = wipFinal - byCredit;
  const shares = effectiveOuts.filter(o => ['main', 'co'].includes(o.output_type));
  const sumShare = shares.reduce((s, o) => s + (Number(o.cost_share_percent) || 0), 0);
  if (shares.length && Math.abs(sumShare - 100) > 0.01) {
    throw err('E_SHARE_NOT_100', 422, { sum: sumShare });
  }

  let assigned = 0;
  const shareRows = shares.map(o => {
    const q = o.output_type === 'main'
      ? qtyIn
      : round6(Number(o.qty_per_base) * qty_start / (bom.base_qty || 1));
    const amt = Math.round(wipAfterBy * (Number(o.cost_share_percent) || 0) / 100);
    assigned += amt;
    return {
      ...outMeta(db, o),
      qty: q,
      share_percent: o.cost_share_percent,
      amount_rial: amt,
      unit_cost_rial: q ? Math.round(amt / q) : 0,
    };
  });
  const mainRow = shareRows.find(r => r.type === 'main');
  if (mainRow && assigned !== wipAfterBy) {
    mainRow.amount_rial += wipAfterBy - assigned;
    mainRow.unit_cost_rial = mainRow.qty ? Math.round(mainRow.amount_rial / mainRow.qty) : 0;
  }
  result.push(...shareRows);

  const unitCost = mainRow?.unit_cost_rial || 0;
  const margin = parseFloat(setting(db, 'pricing_margin_percent', '35')) || 35;

  const prod = db.prepare('SELECT id, name, code, price, average_cost_rial FROM products WHERE id=?').get(bom.product_id);
  const estimatedRates = stages.some(s => warnings.some(w => w.includes(s.cost_center?.split?.(' ')?.[1] || '') || w.includes('برآوردی')));
  return {
    bom_id: bomId,
    bom_code: bom.code,
    version: bom.version,
    product: prod ? {
      id: prod.id,
      name: prod.name,
      code: prod.code || null,
      current_price_rial: Math.round(Number(prod.price) || 0) * 10,
    } : null,
    header_yield_ignored: !!bom.has_routing,
    qty_target: qtyTarget,
    qty_start,
    total_yield_percent,
    period,
    stages,
    outputs: result,
    breakdown: {
      material_rial: totMat,
      material_pct: pct(totMat, wipFinal),
      packaging_rial: totPkg,
      packaging_pct: pct(totPkg, wipFinal),
      labor_rial: totLab,
      labor_pct: pct(totLab, wipFinal),
      subcontract_rial: totSub,
      subcontract_pct: pct(totSub, wipFinal),
      overhead_rial: totOh,
      overhead_pct: pct(totOh, wipFinal),
      gross_rial: wipFinal,
      by_credit_rial: byCredit,
      net_rial: wipAfterBy,
      unit_cost_rial: unitCost,
      unit_cost_toman: unitCost / 10,
    },
    pricing: {
      margin_percent: margin,
      suggested_price_rial: Math.round(unitCost * (1 + margin / 100)),
      suggested_price_toman: Math.round(unitCost * (1 + margin / 100)) / 10,
    },
    estimated_rates: !!estimatedRates || warnings.some(w => w.includes('برآوردی')),
    warnings,
  };
}

const MEMO = new Map();

function clearRollUpMemo() { MEMO.clear(); }

function rollUpUnitCost(db, productId, date, period, level = 0) {
  if (MEMO.has(productId)) return MEMO.get(productId);
  if (level > 10) throw err('E_BOM_TOO_DEEP', 422);

  const p = db.prepare('SELECT * FROM products WHERE id=?').get(productId);
  if (!p) throw err('E_NOT_FOUND', 404);
  if (!p.is_manufactured) {
    const v = Math.round(Number(p.average_cost_rial) || 0);
    MEMO.set(productId, v);
    return v;
  }

  let bom;
  try {
    bom = resolveBom(db, { productId, date: date || todayJalali() });
  } catch {
    const v = Math.round(Number(p.average_cost_rial) || 0);
    MEMO.set(productId, v);
    return v;
  }

  const r = rollUpBom(db, {
    bomId: bom.id,
    qtyTarget: bom.base_qty || 1,
    period: period || todayJalali().slice(0, 7),
    level,
  });
  MEMO.set(productId, r.breakdown.unit_cost_rial);
  return r.breakdown.unit_cost_rial;
}

const TARANOM_ROUTING_TEMPLATE = [
  { seq: 10, cc: 'CC-10', name: 'برش', setup: 30, run: 1.2, machine: 0, labor: 'monthly', rate: 0, waste: 2, yield: 100, driver: 'material_rial' },
  { seq: 20, cc: 'CC-20', name: 'گلدوزی', setup: 15, run: 3.0, machine: 3.0, labor: 'piece', rate: 45000, waste: 0, yield: 100, driver: 'machine_hours' },
  { seq: 30, cc: 'CC-30', name: 'دوخت', setup: 20, run: 11.0, machine: 11.0, labor: 'piece', rate: 180000, waste: 1, yield: 100, driver: 'direct_labor_rial' },
  { seq: 40, cc: 'CC-40', name: 'دکمه و یراق', setup: 5, run: 2.5, machine: 0, labor: 'piece', rate: 25000, waste: 0, yield: 100, driver: 'output_qty' },
  { seq: 50, cc: 'CC-50', name: 'شستشو', setup: 0, run: 0.5, machine: 0, labor: 'contract', rate: 0, fee: 38000, waste: 1.5, yield: 100, driver: 'output_qty', sub: 1 },
  { seq: 60, cc: 'CC-60', name: 'اتو و بسته‌بندی', setup: 0, run: 2.0, machine: 0, labor: 'monthly', rate: 0, waste: 0, yield: 100, driver: 'output_qty', qc: 1 },
];

function applyRoutingTemplate(db, bomId, userId, template = TARANOM_ROUTING_TEMPLATE) {
  const bom = db.prepare('SELECT * FROM bom_headers WHERE id=?').get(bomId);
  if (!bom) throw err('E_NOT_FOUND', 404);
  if (bom.status === 'active') throw err('E_BOM_LOCKED', 409);

  return db.transaction(() => {
    db.prepare('DELETE FROM bom_operations WHERE bom_id=?').run(bomId);
    const ins = db.prepare(`
      INSERT INTO bom_operations
        (bom_id, seq, cost_center_id, operation_name, setup_minutes, run_minutes_per_unit,
         machine_minutes_per_unit, labor_method, labor_rate_rial, crew_size,
         overhead_driver, yield_percent, normal_waste_percent, is_subcontract,
         subcontract_fee_rial, is_qc_gate)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    const rows = [];
    for (const t of template) {
      const cc = db.prepare('SELECT id FROM cost_centers WHERE code=?').get(t.cc);
      if (!cc) throw err('E_CC_NOT_FOUND', 404, { code: t.cc });
      const info = ins.run(
        bomId, t.seq, cc.id, t.name, t.setup || 0, t.run || 0,
        t.machine || 0, t.labor || 'piece', t.rate || 0, t.crew || 1,
        t.driver || '', t.yield ?? 100, t.waste || 0, t.sub ? 1 : 0,
        t.fee || 0, t.qc ? 1 : 0
      );
      rows.push(info.lastInsertRowid);
    }
    db.prepare(`
      UPDATE bom_headers SET has_routing=1, yield_percent=100, updated_at=strftime('%s','now') WHERE id=?
    `).run(bomId);
    return { ok: true, count: rows.length, ids: rows };
  })();
}

function addOperation(db, bomId, body, userId) {
  const bom = db.prepare('SELECT * FROM bom_headers WHERE id=?').get(bomId);
  if (!bom) throw err('E_NOT_FOUND', 404);
  if (bom.status === 'active') throw err('E_BOM_LOCKED', 409);

  const seq = Number(body.seq);
  if (!seq) throw err('E_SEQ_REQUIRED', 422);
  const dup = db.prepare('SELECT 1 FROM bom_operations WHERE bom_id=? AND seq=?').get(bomId, seq);
  if (dup) throw err('E_SEQ_DUPLICATE', 422);

  const cc = db.prepare('SELECT * FROM cost_centers WHERE id=?').get(body.cost_center_id);
  if (!cc) throw err('E_CC_NOT_FOUND', 404);
  if (!Number(cc.is_stage)) throw err('E_CC_NOT_STAGE', 422);

  const id = db.prepare(`
    INSERT INTO bom_operations
      (bom_id, seq, cost_center_id, operation_name, setup_minutes, run_minutes_per_unit,
       machine_minutes_per_unit, labor_method, labor_rate_rial, crew_size,
       overhead_driver, yield_percent, normal_waste_percent, is_subcontract,
       subcontract_supplier_id, subcontract_fee_rial, is_qc_gate, note)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    bomId, seq, body.cost_center_id, body.operation_name || body.name || '',
    Number(body.setup_minutes) || 0, Number(body.run_minutes_per_unit) || 0,
    Number(body.machine_minutes_per_unit) || 0,
    body.labor_method || 'piece', Math.round(Number(body.labor_rate_rial) || 0),
    Number(body.crew_size) || 1, body.overhead_driver || '',
    body.yield_percent != null ? Number(body.yield_percent) : 100,
    Number(body.normal_waste_percent) || 0,
    body.is_subcontract ? 1 : 0, body.subcontract_supplier_id || null,
    Math.round(Number(body.subcontract_fee_rial) || 0),
    body.is_qc_gate ? 1 : 0, body.note || ''
  ).lastInsertRowid;

  db.prepare('UPDATE bom_headers SET has_routing=1 WHERE id=?').run(bomId);
  return db.prepare('SELECT * FROM bom_operations WHERE id=?').get(id);
}

function resequenceOperations(db, bomId) {
  assertDraftBom(db, bomId);
  const ops = db.prepare('SELECT id FROM bom_operations WHERE bom_id=? ORDER BY seq, id').all(bomId);
  let seq = 10;
  const upd = db.prepare('UPDATE bom_operations SET seq=? WHERE id=?');
  db.transaction(() => {
    for (const o of ops) {
      upd.run(seq, o.id);
      seq += 10;
    }
  })();
  return db.prepare('SELECT * FROM bom_operations WHERE bom_id=? ORDER BY seq').all(bomId);
}

function addOutput(db, bomId, body) {
  const bom = db.prepare('SELECT * FROM bom_headers WHERE id=?').get(bomId);
  if (!bom) throw err('E_NOT_FOUND', 404);
  if (bom.status === 'active') throw err('E_BOM_LOCKED', 409);

  const id = db.prepare(`
    INSERT INTO bom_outputs
      (bom_id, product_id, output_type, qty_per_base, cost_method, cost_share_percent, nrv_rial, stage_cost_center_id)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(
    bomId, body.product_id, body.output_type || 'main',
    Number(body.qty_per_base) || 1, body.cost_method || 'share',
    Number(body.cost_share_percent) || 0, Math.round(Number(body.nrv_rial) || 0),
    body.stage_cost_center_id || null
  ).lastInsertRowid;

  if (['co', 'by', 'scrap'].includes(body.output_type)) {
    db.prepare('UPDATE bom_headers SET has_coproducts=1 WHERE id=?').run(bomId);
  }
  return db.prepare('SELECT * FROM bom_outputs WHERE id=?').get(id);
}

function assertDraftBom(db, bomId) {
  const bom = db.prepare('SELECT * FROM bom_headers WHERE id=?').get(bomId);
  if (!bom) throw err('E_NOT_FOUND', 404);
  if (bom.status === 'active') throw err('E_BOM_LOCKED', 409);
  return bom;
}

function validateAdvancedBom(db, bomId) {
  const bom = db.prepare('SELECT * FROM bom_headers WHERE id=?').get(bomId);
  if (!bom) throw err('E_NOT_FOUND', 404);
  const ops = db.prepare('SELECT * FROM bom_operations WHERE bom_id=? ORDER BY seq').all(bomId);
  const lines = db.prepare('SELECT * FROM bom_lines WHERE bom_id=?').all(bomId);
  const outs = db.prepare('SELECT * FROM bom_outputs WHERE bom_id=?').all(bomId);
  const warnings = [];

  if (bom.has_routing) {
    if (!ops.length) throw err('E_ROUTING_EMPTY', 422);
    if (Math.abs((bom.yield_percent ?? 100) - 100) > 0.001) throw err('E_YIELD_DOUBLE_COUNT', 422);
    const seqs = new Set();
    let first = true;
    for (const op of ops) {
      if (seqs.has(op.seq)) throw err('E_SEQ_DUPLICATE', 422);
      seqs.add(op.seq);
      const y = Number(op.yield_percent);
      if (!(y > 0.1 && y <= 100)) throw err('E_OP_YIELD_RANGE', 422, { seq: op.seq });
      const w = Number(op.normal_waste_percent) || 0;
      if (w < 0 || w >= 99.9) throw err('E_OP_WASTE_RANGE', 422, { seq: op.seq });
      if (op.is_subcontract && (!op.subcontract_supplier_id || !Number(op.subcontract_fee_rial))) {
        throw err('E_SUBCON_INCOMPLETE', 422, { seq: op.seq });
      }
      if (op.is_qc_gate && first) throw err('E_QC_FIRST', 422);
      first = false;
      const cc = db.prepare('SELECT is_stage, driver FROM cost_centers WHERE id=?').get(op.cost_center_id);
      if (!cc || !cc.is_stage) throw err('E_CC_NOT_STAGE', 422);
      const driver = op.overhead_driver || cc.driver;
      if (driver === 'machine_hours' && !(Number(op.machine_minutes_per_unit) > 0)) {
        throw err('E_NO_MACHINE_TIME', 422, { seq: op.seq });
      }
    }
    const factor = ops.reduce((f, op) =>
      f * ((Number(op.yield_percent) || 100) / 100) * (1 - (Number(op.normal_waste_percent) || 0) / 100), 1);
    if (factor < 0.5) warnings.push({ code: 'W_LOW_TOTAL_YIELD', pct: round6(factor * 100) });
    const opCCs = new Set(ops.map(o => o.cost_center_id));
    for (const L of lines) {
      if (L.stage_cost_center_id && !opCCs.has(L.stage_cost_center_id)) {
        throw err('E_STAGE_NOT_IN_ROUTING', 422, { line: L.line_no });
      }
    }
  }

  if (bom.has_coproducts || outs.length) {
    const mains = outs.filter(o => o.output_type === 'main');
    if (mains.length !== 1) throw err('E_NO_MAIN_OUTPUT', 422);
    if (mains[0].product_id !== bom.product_id) throw err('E_MAIN_MISMATCH', 422);
    const seen = new Set();
    for (const o of outs) {
      if (seen.has(o.product_id)) throw err('E_OUTPUT_DUPLICATE', 422, { name: productName(db, o.product_id) });
      seen.add(o.product_id);
      if (o.cost_method === 'nrv' && !(Number(o.nrv_rial) > 0)) {
        throw err('E_NRV_ZERO', 422, { name: productName(db, o.product_id) });
      }
    }
    const shares = outs.filter(o => ['main', 'co'].includes(o.output_type));
    const sum = shares.reduce((s, o) => s + (Number(o.cost_share_percent) || 0), 0);
    if (Math.abs(sum - 100) > 0.01) throw err('E_SHARE_NOT_100', 422, { sum });
  }

  return { ok: true, warnings };
}

function autoShare(db, bomId, method = 'sales_value') {
  assertDraftBom(db, bomId);
  const outs = db.prepare(`SELECT * FROM bom_outputs WHERE bom_id=? AND output_type IN ('main','co')`).all(bomId);
  if (!outs.length) throw err('E_NO_MAIN_OUTPUT', 422);
  let weights;
  if (method === 'physical') {
    weights = outs.map(o => Math.max(Number(o.qty_per_base) || 0, 0));
  } else {
    weights = outs.map(o => {
      const p = db.prepare('SELECT price FROM products WHERE id=?').get(o.product_id);
      const priceRial = Math.round((Number(p?.price) || 0) * 10);
      return Math.max(priceRial * (Number(o.qty_per_base) || 1), 0);
    });
  }
  const total = weights.reduce((s, w) => s + w, 0);
  if (!(total > 0)) throw err('E_SHARE_NOT_100', 422, { sum: 0 });
  let assigned = 0;
  const upd = db.prepare('UPDATE bom_outputs SET cost_share_percent=?, cost_method=? WHERE id=?');
  const rows = outs.map((o, i) => {
    const isLast = i === outs.length - 1;
    const share = isLast ? round6(100 - assigned) : round6((weights[i] / total) * 100);
    if (!isLast) assigned += share;
    upd.run(share, 'share', o.id);
    return { id: o.id, product_id: o.product_id, cost_share_percent: share };
  });
  return { method, rows };
}

function yieldAnalysis(db, bomId, qtyTarget = 1) {
  const ops = db.prepare('SELECT * FROM bom_operations WHERE bom_id=? ORDER BY seq').all(bomId);
  const bw = backwardQty(db, bomId, qtyTarget);
  let qty = bw.qty_start;
  const stages = ops.map(op => {
    const y = (Number(op.yield_percent) || 100) / 100;
    const w = (Number(op.normal_waste_percent) || 0) / 100;
    const qtyOut = round6(qty * y * (1 - w));
    const row = {
      seq: op.seq,
      yield_percent: Number(op.yield_percent) || 100,
      waste_percent: Number(op.normal_waste_percent) || 0,
      qty_in: qty,
      qty_out: qtyOut,
    };
    qty = qtyOut;
    return row;
  });
  return { qty_target: qtyTarget, qty_start: bw.qty_start, total_yield_percent: bw.total_yield_percent, stages };
}

function costTree(db, { bomId, productId, qty = 1, period, priceBasis = 'average', deadlineMs = 5000 } = {}) {
  const started = Date.now();
  clearRollUpMemo();
  function walk(id, q, level) {
    if (Date.now() - started > deadlineMs) throw err('E_COST_TREE_TIMEOUT', 422);
    if (level > 10) throw err('E_BOM_TOO_DEEP', 422);
    let headerId = id;
    if (!headerId && productId) {
      const bom = resolveBom(db, { productId, date: todayJalali() });
      headerId = bom.id;
    }
    const roll = rollUpBom(db, { bomId: headerId, qtyTarget: q, period: period || todayJalali().slice(0, 7), priceBasis, level });
    const lines = db.prepare('SELECT * FROM bom_lines WHERE bom_id=?').all(headerId);
    const children = [];
    for (const L of lines) {
      const p = db.prepare('SELECT id, name, is_manufactured FROM products WHERE id=?').get(L.component_product_id);
      if (p?.is_manufactured) {
        try {
          const childBom = resolveBom(db, { productId: p.id, date: todayJalali() });
          children.push(walk(childBom.id, Number(L.qty_per_base) * q, level + 1));
        } catch {
          children.push({ product_id: p.id, name: p.name, unit_cost_rial: rollUpUnitCost(db, p.id, todayJalali(), period, level + 1) });
        }
      }
    }
    return {
      bom_id: headerId,
      bom_code: roll.bom_code,
      unit_cost_rial: roll.breakdown.unit_cost_rial,
      qty: q,
      children,
      elapsed_ms: Date.now() - started,
    };
  }
  const rootId = bomId || null;
  if (!rootId && !productId) throw err('E_NOT_FOUND', 404);
  if (!rootId) {
    const bom = resolveBom(db, { productId, date: todayJalali() });
    return walk(bom.id, qty, 0);
  }
  return walk(rootId, qty, 0);
}

function sensitivity(db, { bomId, qtyTarget = 1, period, param = 'fabric_price', deltaPercent = 10 } = {}) {
  clearRollUpMemo();
  const base = rollUpBom(db, { bomId, qtyTarget, period, priceBasis: 'average' });
  const bom = db.prepare('SELECT * FROM bom_headers WHERE id=?').get(bomId);
  const lines = db.prepare('SELECT * FROM bom_lines WHERE bom_id=?').all(bomId);
  const factor = 1 + (Number(deltaPercent) || 0) / 100;
  const touched = [];
  if (param === 'fabric_price' || param === 'material_avg') {
    for (const L of lines) {
      const p = db.prepare('SELECT id, average_cost_rial, item_type FROM products WHERE id=?').get(L.component_product_id);
      if (!p) continue;
      if (param === 'fabric_price' && p.item_type && p.item_type !== 'raw') continue;
      touched.push({ id: p.id, prev: p.average_cost_rial });
      db.prepare('UPDATE products SET average_cost_rial=? WHERE id=?')
        .run(Math.round(Number(p.average_cost_rial) * factor), p.id);
    }
  }
  let perturbed;
  try {
    clearRollUpMemo();
    perturbed = rollUpBom(db, { bomId, qtyTarget, period, priceBasis: 'average' });
  } finally {
    for (const t of touched) {
      db.prepare('UPDATE products SET average_cost_rial=? WHERE id=?').run(t.prev, t.id);
    }
  }
  return {
    param,
    delta_percent: deltaPercent,
    base_unit_cost_rial: base.breakdown.unit_cost_rial,
    new_unit_cost_rial: perturbed.breakdown.unit_cost_rial,
    delta_rial: perturbed.breakdown.unit_cost_rial - base.breakdown.unit_cost_rial,
    bom_code: bom?.code,
  };
}

function breakeven(db, { bomId, qtyTarget = 1, period, priceRial } = {}) {
  clearRollUpMemo();
  const roll = rollUpBom(db, { bomId, qtyTarget, period, priceBasis: 'average' });
  const unit = roll.breakdown.unit_cost_rial;
  const price = Math.round(Number(priceRial) || roll.pricing.suggested_price_rial || 0);
  const marginRial = price - unit;
  const marginPct = price ? round6((marginRial / price) * 100) : 0;
  return {
    unit_cost_rial: unit,
    price_rial: price,
    margin_rial: marginRial,
    margin_percent: marginPct,
    profitable: marginRial > 0,
    qty_target: qtyTarget,
  };
}

function compareScenarios(db, bomIdA, bomIdB, qtyTarget = 1, period) {
  clearRollUpMemo();
  const a = rollUpBom(db, { bomId: bomIdA, qtyTarget, period, priceBasis: 'average' });
  clearRollUpMemo();
  const b = rollUpBom(db, { bomId: bomIdB, qtyTarget, period, priceBasis: 'average' });
  return {
    qty_target: qtyTarget,
    a: { bom_id: bomIdA, unit_cost_rial: a.breakdown.unit_cost_rial, breakdown: a.breakdown, stages: a.stages },
    b: { bom_id: bomIdB, unit_cost_rial: b.breakdown.unit_cost_rial, breakdown: b.breakdown, stages: b.stages },
    delta_unit_cost_rial: b.breakdown.unit_cost_rial - a.breakdown.unit_cost_rial,
  };
}

function updateOperation(db, bomId, opId, body = {}) {
  assertDraftBom(db, bomId);
  const op = db.prepare('SELECT * FROM bom_operations WHERE id=? AND bom_id=?').get(opId, bomId);
  if (!op) throw err('E_NOT_FOUND', 404);
  const fields = {
    seq: body.seq != null ? Number(body.seq) : op.seq,
    cost_center_id: body.cost_center_id != null ? body.cost_center_id : op.cost_center_id,
    operation_name: body.operation_name != null ? body.operation_name : op.operation_name,
    setup_minutes: body.setup_minutes != null ? Number(body.setup_minutes) : op.setup_minutes,
    run_minutes_per_unit: body.run_minutes_per_unit != null ? Number(body.run_minutes_per_unit) : op.run_minutes_per_unit,
    machine_minutes_per_unit: body.machine_minutes_per_unit != null ? Number(body.machine_minutes_per_unit) : op.machine_minutes_per_unit,
    labor_method: body.labor_method != null ? body.labor_method : op.labor_method,
    labor_rate_rial: body.labor_rate_rial != null ? Math.round(Number(body.labor_rate_rial)) : op.labor_rate_rial,
    crew_size: body.crew_size != null ? Number(body.crew_size) : op.crew_size,
    overhead_driver: body.overhead_driver != null ? body.overhead_driver : op.overhead_driver,
    yield_percent: body.yield_percent != null ? Number(body.yield_percent) : op.yield_percent,
    normal_waste_percent: body.normal_waste_percent != null ? Number(body.normal_waste_percent) : op.normal_waste_percent,
    is_subcontract: body.is_subcontract != null ? (body.is_subcontract ? 1 : 0) : op.is_subcontract,
    subcontract_supplier_id: body.subcontract_supplier_id !== undefined ? body.subcontract_supplier_id : op.subcontract_supplier_id,
    subcontract_fee_rial: body.subcontract_fee_rial != null ? Math.round(Number(body.subcontract_fee_rial)) : op.subcontract_fee_rial,
    is_qc_gate: body.is_qc_gate != null ? (body.is_qc_gate ? 1 : 0) : op.is_qc_gate,
  };
  if (fields.seq !== op.seq) {
    const dup = db.prepare('SELECT id FROM bom_operations WHERE bom_id=? AND seq=? AND id<>?').get(bomId, fields.seq, opId);
    if (dup) throw err('E_SEQ_DUPLICATE', 422);
  }
  db.prepare(`
    UPDATE bom_operations SET
      seq=?, cost_center_id=?, operation_name=?, setup_minutes=?, run_minutes_per_unit=?,
      machine_minutes_per_unit=?, labor_method=?, labor_rate_rial=?, crew_size=?,
      overhead_driver=?, yield_percent=?, normal_waste_percent=?, is_subcontract=?,
      subcontract_supplier_id=?, subcontract_fee_rial=?, is_qc_gate=?
    WHERE id=?
  `).run(
    fields.seq, fields.cost_center_id, fields.operation_name, fields.setup_minutes, fields.run_minutes_per_unit,
    fields.machine_minutes_per_unit, fields.labor_method, fields.labor_rate_rial, fields.crew_size,
    fields.overhead_driver, fields.yield_percent, fields.normal_waste_percent, fields.is_subcontract,
    fields.subcontract_supplier_id, fields.subcontract_fee_rial, fields.is_qc_gate, opId
  );
  return db.prepare('SELECT * FROM bom_operations WHERE id=?').get(opId);
}

function deleteOperation(db, bomId, opId) {
  assertDraftBom(db, bomId);
  const info = db.prepare('DELETE FROM bom_operations WHERE id=? AND bom_id=?').run(opId, bomId);
  if (!info.changes) throw err('E_NOT_FOUND', 404);
  return { deleted: true, id: opId };
}

function updateOutput(db, bomId, outId, body = {}) {
  assertDraftBom(db, bomId);
  const row = db.prepare('SELECT * FROM bom_outputs WHERE id=? AND bom_id=?').get(outId, bomId);
  if (!row) throw err('E_NOT_FOUND', 404);
  db.prepare(`
    UPDATE bom_outputs SET
      product_id=?, output_type=?, qty_per_base=?, cost_method=?,
      cost_share_percent=?, nrv_rial=?, stage_cost_center_id=?
    WHERE id=?
  `).run(
    body.product_id != null ? body.product_id : row.product_id,
    body.output_type != null ? body.output_type : row.output_type,
    body.qty_per_base != null ? Number(body.qty_per_base) : row.qty_per_base,
    body.cost_method != null ? body.cost_method : row.cost_method,
    body.cost_share_percent != null ? Number(body.cost_share_percent) : row.cost_share_percent,
    body.nrv_rial != null ? Math.round(Number(body.nrv_rial)) : row.nrv_rial,
    body.stage_cost_center_id !== undefined ? body.stage_cost_center_id : row.stage_cost_center_id,
    outId
  );
  return db.prepare('SELECT * FROM bom_outputs WHERE id=?').get(outId);
}

function deleteOutput(db, bomId, outId) {
  assertDraftBom(db, bomId);
  const info = db.prepare('DELETE FROM bom_outputs WHERE id=? AND bom_id=?').run(outId, bomId);
  if (!info.changes) throw err('E_NOT_FOUND', 404);
  return { deleted: true, id: outId };
}

function capacityLoad(db, bomId, qty) {
  const ops = db.prepare('SELECT * FROM bom_operations WHERE bom_id=? ORDER BY seq').all(bomId);
  const bw = backwardQty(db, bomId, qty);
  return {
    qty_target: qty,
    qty_start: bw.qty_start,
    rows: ops.map(op => {
      const cc = db.prepare('SELECT * FROM cost_centers WHERE id=?').get(op.cost_center_id);
      const mins = (Number(op.setup_minutes) || 0)
        + (Number(op.run_minutes_per_unit) || 0) * bw.qty_start;
      const hours = mins / 60;
      const cap = Number(cc?.capacity_per_day) || 0;
      const days = cap > 0 ? round6(hours / cap) : null;
      return {
        seq: op.seq,
        cost_center: cc ? `${cc.code} ${cc.name}` : String(op.cost_center_id),
        minutes: round6(mins),
        hours: round6(hours),
        capacity_per_day: cap,
        days_needed: days,
      };
    }),
  };
}

module.exports = {
  backwardQty,
  stageLabor,
  stageDriverQty,
  rollUpBom,
  rollUpUnitCost,
  clearRollUpMemo,
  applyRoutingTemplate,
  addOperation,
  resequenceOperations,
  addOutput,
  updateOperation,
  deleteOperation,
  updateOutput,
  deleteOutput,
  validateAdvancedBom,
  capacityLoad,
  autoShare,
  yieldAnalysis,
  costTree,
  sensitivity,
  breakeven,
  compareScenarios,
  TARANOM_ROUTING_TEMPLATE,
  err,
};
