'use strict';
/**
 * Shared multi-product cutting batch.
 * Single-product is the same engine with one output row.
 * Legacy cutting_lays without batch_id keep the old path.
 * Issue valuation is the product-header weighted average (ADR-001), not the lot rate.
 */

const { todayJalali } = require('../../jalali');
const { assertSafeRial } = require('../money');
const { assertJournalIdempotent } = require('../sales-document');
const { postInventoryMovement, reverseInventoryMovement } = require('../inventory/ledger');
const { adjustBatchQty } = require('../inventory/batch-serial');
const { availableBatchMeters, applyLiveRollQty } = require('../inventory/fabric-rolls');
const { dr, cr, postEvent } = require('./posting');
const { setting, avgUnitRial } = require('./costing');

function httpErr(status, message, code, extra) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  if (extra) Object.assign(e, extra);
  return e;
}

function roundM(n) {
  return Math.round((Number(n) || 0) * 1000) / 1000;
}

function remnantThreshold(policy, markerLengthM) {
  const mode = policy && policy.mode === 'fixed_m' ? 'fixed_m' : 'formula';
  const min = Math.max(0, Number(policy && policy.min_remnant_m) || 0);
  const ratio = Math.max(0, Number(policy && policy.remnant_ratio) || 0);
  const marker = Math.max(0, Number(markerLengthM) || 0);
  const threshold_m = mode === 'fixed_m' ? min : Math.max(min, roundM(ratio * marker));
  return { mode, min_remnant_m: min, remnant_ratio: ratio, threshold_m: roundM(threshold_m) };
}

function classifyUsableRemaining(remainingM, thresholdM, opts) {
  const remaining = roundM(remainingM);
  const T = roundM(thresholdM);
  if (opts && opts.defective) return { destination: 'scrap', remaining_m: remaining, threshold_m: T };
  if (!(remaining > 0)) return { destination: 'none', remaining_m: 0, threshold_m: T };
  if (remaining <= T + 1e-9) return { destination: 'remnant', remaining_m: remaining, threshold_m: T };
  return { destination: 'return_roll', remaining_m: remaining, threshold_m: T };
}

function rollEquation(row, toleranceM) {
  const opening = roundM(row.opening_m);
  const laid = roundM(row.laid_m);
  const returned = roundM(row.returned_m);
  const remnant = roundM(row.remnant_m);
  const loss = roundM(row.length_loss_m);
  const adj = roundM(row.adjustment_m);
  const sum = roundM(laid + returned + remnant + loss + adj);
  const diff = roundM(opening - sum);
  const tol = Math.max(0, Number(toleranceM) || 0);
  return { opening_m: opening, sum_m: sum, diff_m: diff, ok: Math.abs(diff) <= tol + 1e-9 };
}

function plannedPieces(acceptedPlies, piecesPerPly) {
  const plies = Math.round(Number(acceptedPlies) || 0);
  const per = Number(piecesPerPly) || 0;
  return Math.round(plies * per);
}

function allocateRial(commonRial, weights) {
  const common = Math.round(Number(commonRial) || 0);
  const rows = (weights || []).map((w) => ({
    product_id: Number(w.product_id),
    size_code: String(w.size_code || ''),
    weight: Number(w.weight) || 0,
  })).filter((w) => w.product_id && w.weight > 0);
  const sumW = rows.reduce((s, w) => s + w.weight, 0);
  if (!(sumW > 0)) throw httpErr(400, 'جمع سهم خروجی صفر است', 'E_SHARE_ZERO');
  if (Math.abs(sumW - 100) > 0.05 && Math.abs(sumW - 1) > 0.0001) {
    throw httpErr(400, 'جمع سهم فنی باید ۱۰۰٪ باشد', 'E_SHARE_SUM', { sum: sumW });
  }
  const scale = Math.abs(sumW - 1) <= 0.0001 ? 1 : sumW;
  const draft = rows.map((w) => {
    const exact = common * (w.weight / scale);
    return { ...w, amount_rial: Math.floor(exact), frac: exact - Math.floor(exact) };
  });
  let leftover = common - draft.reduce((s, r) => s + r.amount_rial, 0);
  const order = draft.slice().sort((a, b) => {
    if (b.weight !== a.weight) return b.weight - a.weight;
    return a.product_id - b.product_id;
  });
  for (const row of order) {
    if (leftover <= 0) break;
    row.amount_rial += 1;
    leftover -= 1;
  }
  return draft.map((r) => ({ product_id: r.product_id, size_code: r.size_code, weight: r.weight, amount_rial: r.amount_rial }));
}

function assertFlag(db) {
  if (String(setting(db, 'production_shared_cut', '0')) !== '1') {
    throw httpErr(403, 'برش مشترک خاموش است', 'E_SHARED_CUT_OFF');
  }
}

function globalPolicy(db) {
  return {
    mode: setting(db, 'production_remnant_mode', 'formula') === 'fixed_m' ? 'fixed_m' : 'formula',
    min_remnant_m: Number(setting(db, 'production_remnant_min_m', '1.20')) || 0,
    remnant_ratio: Number(setting(db, 'production_remnant_ratio', '0.20')) || 0,
    scope: 'global',
  };
}

function loadPolicy(db, ctx) {
  const marker = Number(ctx && ctx.marker_length_m) || 0;
  let best = null;
  let bestScore = -1;
  const rules = db.prepare(`SELECT * FROM cutting_remnant_rules WHERE COALESCE(active,1)=1`).all();
  const fabric = Number(ctx && ctx.fabric_product_id) || 0;
  const width = Math.round(Number(ctx && ctx.width_cm) || 0);
  const wh = Number(ctx && ctx.warehouse_id) || 0;
  for (const rule of rules) {
    const rf = Number(rule.fabric_product_id) || 0;
    const rw = Math.round(Number(rule.width_cm) || 0);
    const rwh = Number(rule.warehouse_id) || 0;
    if (rf && rf !== fabric) continue;
    if (rw && rw !== width) continue;
    if (rwh && rwh !== wh) continue;
    let score = 0;
    if (rf && rw && rwh) score = 4;
    else if (rf && rw) score = 3;
    else if (rf) score = 2;
    else if (rwh) score = 1;
    else continue;
    if (score > bestScore) {
      bestScore = score;
      best = rule;
    }
  }
  const base = best ? {
    mode: best.mode === 'fixed_m' ? 'fixed_m' : 'formula',
    min_remnant_m: Number(best.min_remnant_m) || 0,
    remnant_ratio: Number(best.remnant_ratio) || 0,
    scope: 'override',
    rule_id: best.id,
  } : globalPolicy(db);
  return { ...base, ...remnantThreshold(base, marker) };
}

function normalizeOutputs(outputs, acceptedPlies) {
  const rows = Array.isArray(outputs) ? outputs : [];
  if (!rows.length) throw httpErr(400, 'حداقل یک خروجی لازم است', 'E_OUTPUTS');
  return rows.map((o) => {
    const pieces = Number(o.pieces_per_ply);
    if (!(pieces > 0)) throw httpErr(400, 'قطعه در هر لایه باید بزرگ‌تر از صفر باشد', 'E_PIECES');
    return {
      product_id: Number(o.product_id),
      size_code: String(o.size_code || ''),
      pieces_per_ply: pieces,
      weight: Number(o.weight != null ? o.weight : o.weight_pct),
      planned_pieces: plannedPieces(acceptedPlies, pieces),
    };
  });
}

function previewRolls(rolls, policy, markerLengthM, tolerance) {
  const T = remnantThreshold(policy, markerLengthM);
  return (rolls || []).map((r, idx) => {
    const plies = Math.round(Number(r.ply_count) || 0);
    const laid = roundM(r.laid_m != null ? r.laid_m : plies * markerLengthM);
    const loss = roundM(r.length_loss_m || 0);
    const adj = roundM(r.adjustment_m || 0);
    const opening = roundM(r.opening_m);
    let returned = r.returned_m != null ? roundM(r.returned_m) : null;
    let remnant = r.remnant_m != null ? roundM(r.remnant_m) : null;
    let destination = r.destination || '';
    if (returned == null && remnant == null) {
      const usable = roundM(opening - laid - loss - adj);
      const cls = classifyUsableRemaining(Math.max(0, usable), T.threshold_m, { defective: !!r.defective });
      destination = cls.destination;
      if (cls.destination === 'remnant') { remnant = cls.remaining_m; returned = 0; }
      else if (cls.destination === 'return_roll') { returned = cls.remaining_m; remnant = 0; }
      else if (cls.destination === 'scrap') { remnant = 0; returned = 0; }
      else { remnant = 0; returned = 0; }
    }
    returned = roundM(returned || 0);
    remnant = roundM(remnant || 0);
    const eq = rollEquation({
      opening_m: opening, laid_m: laid, returned_m: returned, remnant_m: remnant,
      length_loss_m: loss, adjustment_m: adj,
    }, tolerance);
    return {
      index: idx,
      batch_id: Number(r.batch_id),
      color: String(r.color || ''),
      ply_count: plies,
      opening_m: opening,
      laid_m: laid,
      returned_m: returned,
      remnant_m: remnant,
      length_loss_m: loss,
      adjustment_m: adj,
      destination: destination || (remnant > 0 ? 'remnant' : (returned > 0 ? 'return_roll' : 'none')),
      defective: !!r.defective,
      equation: eq,
      preview: true,
    };
  });
}

function previewSharedCut(db, body) {
  const marker = Number(body.marker_length_m);
  if (!(marker > 0)) throw httpErr(400, 'قد الگو باید بزرگ‌تر از صفر باشد', 'E_MARKER');
  const policy = body.policy_snapshot
    ? { ...body.policy_snapshot, ...remnantThreshold(body.policy_snapshot, marker) }
    : loadPolicy(db, {
      marker_length_m: marker,
      fabric_product_id: body.fabric_product_id,
      width_cm: body.width_cm,
      warehouse_id: body.warehouse_id,
    });
  const tol = Number(setting(db, 'production_roll_balance_tolerance_m', '0.01'));
  const pliesHint = (body.rolls || []).reduce((s, r) => s + Math.round(Number(r.ply_count) || 0), 0);
  const outputs = normalizeOutputs(body.outputs, pliesHint);
  const rolls = previewRolls(body.rolls, policy, marker, tol);
  const bad = rolls.filter((r) => !r.equation.ok);
  return {
    preview: true,
    marker_length_m: marker,
    policy,
    outputs,
    rolls,
    balanced: bad.length === 0,
    errors: bad.map((r) => ({ index: r.index, code: 'E_ROLL_BALANCE', diff_m: r.equation.diff_m })),
    returned_m: roundM(rolls.reduce((s, r) => s + r.returned_m, 0)),
    remnant_m: roundM(rolls.reduce((s, r) => s + r.remnant_m, 0)),
    laid_m: roundM(rolls.reduce((s, r) => s + r.laid_m, 0)),
  };
}

function warehouseByCode(db, code, settingKey) {
  const id = Number(setting(db, settingKey, '')) || 0;
  if (id) {
    const row = db.prepare('SELECT * FROM warehouses WHERE id=?').get(id);
    if (row) return row;
  }
  return db.prepare('SELECT * FROM warehouses WHERE code=?').get(code);
}

function postSharedCut(db, body, user) {
  assertFlag(db);
  const key = String(body.idempotency_key || '').trim();
  if (!key) throw httpErr(400, 'کلید تکرارناپذیر الزامی است', 'E_CUT_IDEMPOTENCY');
  const prev = db.prepare('SELECT id FROM cutting_batches WHERE idempotency_key=?').get(key);
  if (prev) return getSharedCut(db, prev.id);

  const plan = previewSharedCut(db, body);
  if (!plan.balanced && !body.override_balance) {
    throw httpErr(400, 'تراز طاقه خارج از تلرانس است', 'E_ROLL_BALANCE', { errors: plan.errors });
  }
  const date = String(body.date || todayJalali()).trim();
  const anchor = plan.outputs.slice().sort((a, b) => a.product_id - b.product_id)[0];

  return db.transaction(() => {
    const { allocateNumber } = require('../../db');
    const batchNo = allocateNumber(db, 'cutting_batch', 'CB');
    const layNo = allocateNumber(db, 'cutting_lay', 'LAY');
    const head = db.prepare(`
      INSERT INTO cutting_batches
        (batch_no, marker_length_m, width_cm, bom_id, fabric_product_id, status, policy_json,
         idempotency_key, date, note, created_by)
      VALUES (?,?,?,?,?,'posted',?,?,?,?,?)
    `).run(
      batchNo, plan.marker_length_m, Math.round(Number(body.width_cm) || 0),
      body.bom_id || null, body.fabric_product_id || null,
      JSON.stringify(plan.policy), key, date, String(body.note || ''), user && user.id
    );
    const batchId = head.lastInsertRowid;
    const insOut = db.prepare(`
      INSERT INTO cutting_batch_outputs
        (batch_id, product_id, size_code, pieces_per_ply, weight_pct, planned_pieces, accepted_plies, good_pieces)
      VALUES (?,?,?,?,?,?,?,?)
    `);
    for (const o of plan.outputs) {
      insOut.run(batchId, o.product_id, o.size_code, o.pieces_per_ply, o.weight, o.planned_pieces, 0, o.planned_pieces);
    }
    const lay = db.prepare(`
      INSERT INTO cutting_lays
        (lay_no, product_id, bom_id, fabric_product_id, marker_length_m, ply_count,
         planned_meters, actual_meters, qty_pieces, status, idempotency_key, date, note, created_by, batch_id, color, width_cm)
      VALUES (?,?,?,?,?,?,?,?,?,'posted',?,?,?,?,?,?,?)
    `).run(
      layNo, anchor.product_id, body.bom_id || null, body.fabric_product_id || null,
      plan.marker_length_m,
      plan.rolls.reduce((s, r) => s + r.ply_count, 0),
      plan.laid_m, plan.laid_m,
      plan.outputs.reduce((s, o) => s + o.planned_pieces, 0),
      key + ':lay', date, String(body.note || ''), user && user.id, batchId,
      String(body.color || ''), Math.round(Number(body.width_cm) || 0)
    );
    const layId = lay.lastInsertRowid;
    let common = 0;
    let lossRial = 0;
    const whRaw = warehouseByCode(db, 'WH-RAW', 'production_wh_raw_id');
    const whRem = warehouseByCode(db, 'WH-SCRAP', 'production_wh_remnant_id');
    for (const roll of plan.rolls) {
      const batch = db.prepare("SELECT * FROM inventory_batches WHERE id=?").get(roll.batch_id);
      if (!batch) throw httpErr(400, 'طاقه یافت نشد', 'E_CUT_ROLL');
      const busy = db.prepare(`
        SELECT r.id FROM cutting_lay_rolls r
        JOIN cutting_lays l ON l.id=r.lay_id
        WHERE r.batch_id=? AND r.status='posted' AND l.status='posted'
      `).get(batch.id);
      if (busy) throw httpErr(409, 'این طاقه روی لایهٔ باز دیگری مصرف شده است', 'E_ROLL_BUSY');
      applyLiveRollQty(db, batch);
      const avail = availableBatchMeters(db, batch.id);
      const leave = roundM(roll.opening_m - roll.returned_m - roll.adjustment_m);
      if (avail + 1e-6 < leave) throw httpErr(409, 'متر طاقه کافی نیست', 'E_CUT_ROLL_QTY');
      const unit = avgUnitRial(db, batch.product_id);
      const issueM = roundM(roll.laid_m + roll.length_loss_m + roll.remnant_m);
      const laidRial = assertSafeRial(Math.round(unit * roll.laid_m), 'laid');
      const lossPart = assertSafeRial(Math.round(unit * roll.length_loss_m), 'loss');
      common += laidRial;
      lossRial += lossPart;
      let ledgerId = null;
      if (issueM > 0) {
        const led = postInventoryMovement(db, {
          eventType: 'production_issue',
          productId: batch.product_id,
          warehouseId: batch.warehouse_id || (whRaw && whRaw.id),
          qtyOut: issueM,
          unitCostRial: unit,
          amountRial: assertSafeRial(Math.round(unit * issueM), 'issue'),
          sourceType: 'cutting_lay',
          sourceId: layId,
          batchId: batch.id,
          date,
          note: `برش مشترک ${batchNo}`,
          createdBy: user && user.id,
        });
        ledgerId = led && led.id;
        adjustBatchQty(db, batch.id, -issueM);
      }
      let remnantBatchId = null;
      if (roll.remnant_m > 0) {
        if (!whRem) throw httpErr(400, 'انبار ته‌طاقه تنظیم نشده', 'E_REMNANT_WH');
        const ins = db.prepare(`
          INSERT INTO inventory_batches
            (batch_no, product_id, warehouse_id, qty_on_hand, qty_received, status, kind, color, width_cm, unit, unit_cost_rial, source_type, source_id, note)
          VALUES (?,?,?,?,?,'active','fabric',?,?, 'متر', ?, 'cutting_remnant', ?, ?)
        `).run(
          `${batch.batch_no}-R`, batch.product_id, whRem.id, roll.remnant_m, roll.remnant_m,
          batch.color || '', Math.round(Number(batch.width_cm) || 0), unit, batchId, 'ته‌طاقه'
        );
        remnantBatchId = ins.lastInsertRowid;
        postInventoryMovement(db, {
          eventType: 'production_receipt',
          productId: batch.product_id,
          warehouseId: whRem.id,
          qtyIn: roll.remnant_m,
          unitCostRial: unit,
          amountRial: assertSafeRial(Math.round(unit * roll.remnant_m), 'remnant'),
          sourceType: 'cutting_remnant',
          sourceId: batchId,
          batchId: remnantBatchId,
          date,
          note: `ته‌طاقه ${batchNo}`,
          createdBy: user && user.id,
        });
      }
      db.prepare(`
        INSERT INTO cutting_lay_rolls
          (lay_id, batch_id, meters, unit_cost_rial, amount_rial, ledger_id, status,
           opening_m, ply_count, laid_m, returned_m, remnant_m, length_loss_m, adjustment_m, destination, remnant_batch_id)
        VALUES (?,?,?,?,?,?,'posted',?,?,?,?,?,?,?,?,?)
      `).run(
        layId, batch.id, issueM, unit, laidRial + lossPart, ledgerId,
        roll.opening_m, roll.ply_count, roll.laid_m, roll.returned_m, roll.remnant_m,
        roll.length_loss_m, roll.adjustment_m, roll.destination, remnantBatchId
      );
    }
    common = assertSafeRial(common, 'common');
    assertJournalIdempotent(db, 'production_material_issue', layId);
    let journalId = null;
    if (common > 0) {
      const je = postEvent(db, {
        event: 'PRD-01',
        sourceId: layId,
        date,
        description: `مصرف خالص برش مشترک ${batchNo}`,
        createdBy: user && user.id,
        lines: [dr(db, 'coa_wip', common), cr(db, 'coa_raw_materials', common)],
      });
      journalId = je ? je.je_id : null;
    }
    let wasteJe = null;
    if (lossRial > 0) {
      assertJournalIdempotent(db, 'production_waste', layId);
      const wje = postEvent(db, {
        event: 'PRD-09',
        sourceId: layId,
        date,
        description: `اتلاف طولی برش ${batchNo}`,
        createdBy: user && user.id,
        lines: [dr(db, 'coa_abnormal_waste', lossRial), cr(db, 'coa_wip', lossRial)],
      });
      wasteJe = wje ? wje.je_id : null;
    }
    const shares = allocateRial(common, plan.outputs.map((o) => ({
      product_id: o.product_id, size_code: o.size_code, weight: o.weight,
    })));
    const byProduct = new Map();
    for (const s of shares) {
      const cur = byProduct.get(s.product_id) || 0;
      byProduct.set(s.product_id, cur + s.amount_rial);
      db.prepare(`
        INSERT INTO cutting_batch_allocations (batch_id, product_id, weight, amount_rial, basis)
        VALUES (?,?,?,?, 'marker_share')
      `).run(batchId, s.product_id, s.weight, s.amount_rial);
    }
    const wip = warehouseByCode(db, 'WH-WIP', 'production_wh_wip_id');
    if (!wip) throw httpErr(400, 'انبار WIP یافت نشد', 'E_WIP_WH');
    const pieceByProduct = new Map();
    for (const o of plan.outputs) {
      pieceByProduct.set(o.product_id, (pieceByProduct.get(o.product_id) || 0) + o.planned_pieces);
    }
    for (const [pid, qty] of pieceByProduct) {
      const amt = byProduct.get(pid) || 0;
      const { allocateNumber: alloc } = require('../../db');
      const packNo = alloc(db, 'cutting_pack', 'PK');
      db.prepare(`
        INSERT INTO cutting_packs
          (pack_no, lay_id, product_id, warehouse_id, qty, amount_rial, unit_cost_rial, status, idempotency_key, date, note, created_by)
        VALUES (?,?,?,?,?,?,?,'posted',?,?,?,?)
      `).run(
        packNo, layId, pid, wip.id, qty, amt, qty > 0 ? Math.round(amt / qty) : 0,
        key + ':pack:' + pid, date, 'WIP برش مشترک', user && user.id
      );
    }
    db.prepare(`
      UPDATE cutting_lays SET journal_id=?, waste_journal_id=?, amount_rial=?, waste_amount_rial=?, unit_cost_rial=?
      WHERE id=?
    `).run(journalId, wasteJe, common + lossRial, lossRial, plan.laid_m > 0 ? Math.round(common / plan.laid_m) : 0, layId);
    db.prepare('UPDATE cutting_batches SET journal_id=?, waste_journal_id=?, lay_id=?, common_rial=? WHERE id=?')
      .run(journalId, wasteJe, layId, common, batchId);
    return getSharedCut(db, batchId);
  })();
}

function getSharedCut(db, id) {
  const batch = db.prepare('SELECT * FROM cutting_batches WHERE id=?').get(Number(id));
  if (!batch) throw httpErr(404, 'برنامه برش یافت نشد', 'E_BATCH');
  batch.policy = JSON.parse(batch.policy_json || '{}');
  batch.outputs = db.prepare('SELECT * FROM cutting_batch_outputs WHERE batch_id=? ORDER BY id').all(batch.id);
  batch.allocations = db.prepare('SELECT * FROM cutting_batch_allocations WHERE batch_id=? ORDER BY id').all(batch.id);
  batch.rolls = batch.lay_id
    ? db.prepare('SELECT * FROM cutting_lay_rolls WHERE lay_id=? ORDER BY id').all(batch.lay_id)
    : [];
  batch.packs = batch.lay_id
    ? db.prepare("SELECT * FROM cutting_packs WHERE lay_id=? AND status='posted'").all(batch.lay_id)
    : [];
  return batch;
}

function voidSharedCut(db, id, user, reason) {
  const batch = getSharedCut(db, id);
  if (batch.status === 'reversed') throw httpErr(409, 'این برنامه قبلاً ابطال شده', 'E_CUT_REVERSED');
  db.transaction(() => {
    const lay = db.prepare('SELECT * FROM cutting_lays WHERE id=?').get(batch.lay_id);
    for (const pack of batch.packs) {
      db.prepare("UPDATE cutting_packs SET status='reversed', reversed_at=strftime('%s','now'), reversed_by=? WHERE id=?")
        .run(user && user.id, pack.id);
    }
    for (const roll of batch.rolls) {
      if (roll.ledger_id) {
        reverseInventoryMovement(db, roll.ledger_id, { createdBy: user && user.id, note: reason || 'ابطال برش مشترک' });
      }
      const issueM = Number(roll.meters) || 0;
      if (issueM) adjustBatchQty(db, roll.batch_id, issueM);
      if (roll.remnant_batch_id) {
        adjustBatchQty(db, roll.remnant_batch_id, -(Number(roll.remnant_m) || 0));
        db.prepare("UPDATE inventory_batches SET status='reversed' WHERE id=?").run(roll.remnant_batch_id);
      }
      db.prepare("UPDATE cutting_lay_rolls SET status='reversed' WHERE id=?").run(roll.id);
    }
    const { reverseJournalEntry } = require('../void-journal');
    let revJe = null;
    if (lay && lay.waste_journal_id) {
      reverseJournalEntry(db, lay.waste_journal_id, {
        userId: user && user.id, reason: reason || 'ابطال اتلاف', sourceType: 'production_waste_reversal',
      });
    }
    if (lay && lay.journal_id) {
      const rev = reverseJournalEntry(db, lay.journal_id, {
        userId: user && user.id, reason: reason || 'ابطال برش مشترک', sourceType: 'production_material_issue_reversal',
      });
      revJe = rev && (rev.id || rev.je_id || rev);
    }
    if (lay) {
      db.prepare(`UPDATE cutting_lays SET status='reversed', reversed_at=strftime('%s','now'), reversed_by=?, reversal_journal_id=? WHERE id=?`)
        .run(user && user.id, revJe || null, lay.id);
    }
    db.prepare(`UPDATE cutting_batches SET status='reversed', reversed_at=strftime('%s','now'), reversed_by=?, reversal_journal_id=? WHERE id=?`)
      .run(user && user.id, revJe || null, batch.id);
  })();
  return getSharedCut(db, id);
}

function listPersonLaborConflicts(db) {
  return db.prepare(`
    SELECT id, person_id, ref_id, credit, date
    FROM person_ledger
    WHERE ref_type='production_labor' AND COALESCE(credit,0) > 0
    ORDER BY id
  `).all();
}

function periodChecks(db, period) {
  const checks = [];
  let unbalanced = 0;
  try {
    const tol = Number(setting(db, 'production_roll_balance_tolerance_m', '0.01'));
    const rows = db.prepare(`
      SELECT r.* FROM cutting_lay_rolls r
      JOIN cutting_lays l ON l.id=r.lay_id
      WHERE r.status='posted' AND l.status='posted' AND l.batch_id IS NOT NULL
    `).all();
    unbalanced = rows.filter((r) => !rollEquation(r, tol).ok).length;
  } catch (_) { unbalanced = 0; }
  checks.push({
    code: 'ROLL_BALANCE',
    status: unbalanced ? 'fail' : 'pass',
    severity: 'error',
    message: unbalanced ? `${unbalanced} طاقهٔ نامتوازن` : 'تراز طاقه‌های برش مشترک برقرار است',
  });

  let missingRates = [];
  try {
    const used = db.prepare(`
      SELECT DISTINCT cost_center_id AS id FROM production_overhead_applications
      WHERE period_label=? AND COALESCE(status,'posted')<>'reversed' AND cost_center_id IS NOT NULL
      UNION
      SELECT DISTINCT cost_center_id AS id FROM production_labor_entries
      WHERE period_label=? AND COALESCE(status,'posted')<>'reversed' AND cost_center_id IS NOT NULL
    `).all(period);
    for (const u of used) {
      const hit = db.prepare('SELECT id FROM cost_center_rates WHERE cost_center_id=? AND period_label=?').get(u.id, period);
      if (!hit) missingRates.push(u.id);
    }
  } catch (_) { missingRates = []; }
  checks.push({
    code: 'RATES_FOR_USED_CENTERS',
    status: missingRates.length ? 'fail' : 'pass',
    severity: 'error',
    message: missingRates.length ? `نرخ دوره برای مراکز ${missingRates.join(',')} نیست` : 'نرخ مراکز استفاده‌شده موجود است',
  });

  let dupFail = false;
  try {
    const dups = db.prepare(`
      SELECT account_code, SUM(absorb_pct) pct, COUNT(*) c
      FROM cost_center_account_maps
      WHERE COALESCE(active,1)=1
      GROUP BY account_code
      HAVING c > 1 AND SUM(absorb_pct) > 100.001
    `).all();
    dupFail = dups.length > 0;
  } catch (_) { dupFail = false; }
  checks.push({
    code: 'SHARED_MOEIN',
    status: dupFail ? 'fail' : 'pass',
    severity: 'error',
    message: dupFail ? 'همان معین در چند مرکز بیش از ۱۰۰٪ جذب می‌شود' : 'جذب معین مشترک از ۱۰۰٪ بیشتر نیست',
  });
  return checks;
}

module.exports = {
  roundM,
  remnantThreshold,
  classifyUsableRemaining,
  rollEquation,
  plannedPieces,
  allocateRial,
  loadPolicy,
  previewSharedCut,
  postSharedCut,
  getSharedCut,
  voidSharedCut,
  listPersonLaborConflicts,
  periodChecks,
};
