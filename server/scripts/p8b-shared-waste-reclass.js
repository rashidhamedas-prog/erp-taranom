#!/usr/bin/env node
'use strict';
/**
 * P8b-2 — اتلاف غیرعادی برش مشترک قدیمی (قبل از P6) که بستانکار مواد (1110) شده.
 *
 * شکل درست P6 برای هر لایه:
 *   PRD-01: Dr1111 / Cr1110 = ناخالص (خالص + اتلاف)
 *   PRD-09: Dr5221 / Cr1111 = اتلاف
 * اثر خالص روی 1110 / 1111 / 5221 صفر است؛ ولی ستون‌ها و طبقه‌بندی اتلاف در بهای سفارش
 * (order-cost-reconcile: اتلاف «داخل WIP») فقط وقتی درست است که سند اتلاف بستانکار WIP باشد.
 *
 * apply (یک تراکنش): برای هر لایهٔ قدیمی سند PRD-01 و PRD-09 قدیمی soft-void (reverseJournalEntry)
 * و با postEvent به شکل P6 دوباره ثبت (همان ref_type/ref_id و تاریخ لایه)؛ اشاره‌گرهای
 * cutting_lays / cutting_batches به سند جدید؛ ردیف production_material_issues (cutting_lay) خالص → ناخالص؛
 * مرحلهٔ برش material_added_rial و waste_abnormal_rial += اتلاف (cost_out بدون تغییر)؛
 * سپس applyDocumentCosts سفارش. reverse = همان مسیر برعکس (اسناد شکل قدیم دوباره ثبت، مقادیر قدیم برمی‌گردد).
 *
 * Usage:
 *   node server/scripts/p8b-shared-waste-reclass.js --db=<crm.db> [--order=19] [--out=dir]
 *   … --apply   --i-have-approval --reason="…" [--user=1]
 *   … --reverse --i-have-approval --reason="…" [--user=1]
 */
const fs = require('fs');
const path = require('path');
const C = require('./lib/p8b-common');

const ITEM = 'P8b-2';
const ENTITY = 'p8b_shared_waste_reclass';
const CSV_NAME = 'p8b-2-shared-waste.csv';

function codes(db) {
  const { acct } = C.srv('lib/coa-map');
  return {
    wip: String(acct(db, 'coa_wip').code),
    raw: String(acct(db, 'coa_raw_materials').code),
    waste: String(acct(db, 'coa_abnormal_waste').code),
  };
}

function sumSide(lines, code, side) {
  return lines.filter((l) => String(l.account_code) === code)
    .reduce((s, l) => s + Math.round(Number(l[side]) || 0), 0);
}

function layIssueRow(db, orderId, lay) {
  const tag = lay.lay_no || ('#' + lay.id);
  return db.prepare(`
    SELECT * FROM production_material_issues
    WHERE order_id=? AND issue_type='cutting_lay' AND status='posted'
      AND (note GLOB ? OR note GLOB ?)
    ORDER BY id DESC
  `).all(orderId, `*${tag}[^0-9]*`, `*${tag}`);
}

function planSharedWaste(db, { orderId = 19 } = {}) {
  const po = db.prepare('SELECT * FROM production_orders WHERE id=?').get(Number(orderId));
  if (!po) throw C.stop(`سفارش ${orderId} یافت نشد`);
  const k = codes(db);
  const OCR = C.srv('lib/production/order-cost-reconcile');
  const lays = db.prepare(`
    SELECT * FROM cutting_lays
    WHERE production_order_id=? AND COALESCE(status,'posted')='posted'
      AND COALESCE(batch_id,0)>0 AND COALESCE(waste_amount_rial,0)>0
    ORDER BY id
  `).all(po.id);
  const items = [];
  const skipped = [];
  for (const lay of lays) {
    const wje = C.liveJe(db, lay.waste_journal_id);
    const ije = C.liveJe(db, lay.journal_id);
    if (!wje || !ije) { skipped.push({ lay_id: lay.id, reason: 'سند زنده ندارد' }); continue; }
    const wl = C.jeLines(db, wje.id);
    const il = C.jeLines(db, ije.id);
    const legacy = sumSide(wl, k.raw, 'credit_rial') > 0 && sumSide(wl, k.wip, 'credit_rial') === 0;
    if (!legacy) { skipped.push({ lay_id: lay.id, reason: 'شکل P6 (بستانکار WIP)' }); continue; }
    const waste = Math.round(Number(lay.waste_amount_rial));
    const wasteJe = sumSide(wl, k.waste, 'debit_rial');
    const net = sumSide(il, k.wip, 'debit_rial');
    const netCr = sumSide(il, k.raw, 'credit_rial');
    const problems = [];
    if (wasteJe !== waste || sumSide(wl, k.raw, 'credit_rial') !== waste) problems.push(`اتلاف سند ${wasteJe} ≠ لایه ${waste}`);
    if (net !== netCr) problems.push(`PRD-01 تراز 1111/1110 نیست (${net}/${netCr})`);
    if (net + waste !== Math.round(Number(lay.amount_rial))) problems.push(`خالص+اتلاف ${net + waste} ≠ amount لایه ${lay.amount_rial}`);
    const mis = layIssueRow(db, po.id, lay);
    if (mis.length !== 1) problems.push(`ردیف حوالهٔ cutting_lay یکتا نیست (${mis.length})`);
    const mi = mis[0] || null;
    if (mi && Math.round(Number(mi.amount_rial)) !== net) problems.push(`حواله ${mi.id}: ${mi.amount_rial} ≠ خالص ${net}`);
    const batch = db.prepare('SELECT * FROM cutting_batches WHERE id=?').get(lay.batch_id);
    if (batch && Number(batch.journal_id) !== Number(ije.id)) problems.push(`cutting_batches.journal_id ${batch.journal_id} ≠ ${ije.id}`);
    items.push({
      lay_id: lay.id, lay_no: lay.lay_no, batch_id: lay.batch_id, batch_no: batch && batch.batch_no,
      stage_id: lay.stage_id, cost_center_id: lay.cost_center_id, date: lay.date,
      issue_je: { id: ije.id, voucher_number: ije.voucher_number, description: ije.description },
      waste_je: { id: wje.id, voucher_number: wje.voucher_number, description: wje.description },
      net_rial: net, waste_rial: waste, gross_rial: net + waste,
      mi: mi ? { id: mi.id, qty_actual: mi.qty_actual, amount_rial: mi.amount_rial, std_amount_rial: mi.std_amount_rial,
        unit_cost_rial: mi.unit_cost_rial, std_cost_rial: mi.std_cost_rial } : null,
      problems,
    });
  }
  const stageIds = [...new Set(items.map((i) => i.stage_id).filter(Boolean))];
  const stages = stageIds.map((id) => db.prepare('SELECT * FROM production_order_stages WHERE id=?').get(id));
  const totalWaste = items.reduce((s, i) => s + i.waste_rial, 0);
  return {
    order: { id: po.id, order_no: po.order_no, status: po.status, analysis_type: po.analysis_type,
      material_cost_rial: po.material_cost_rial, abnormal_waste_rial: po.abnormal_waste_rial },
    codes: k,
    items, skipped,
    total_waste_rial: totalWaste,
    total_net_rial: items.reduce((s, i) => s + i.net_rial, 0),
    stages: stages.map((s) => ({ id: s.id, seq: s.seq, status: s.status, operation_name: s.operation_name,
      material_added_rial: s.material_added_rial, waste_abnormal_rial: s.waste_abnormal_rial,
      cost_out_rial: s.cost_out_rial, overhead_rial: s.overhead_rial, driver: s.driver })),
    ocr: OCR.previewOrderCostReconcile(db, po.id),
    gl: { [k.raw]: C.glBalance(db, k.raw), [k.wip]: C.glBalance(db, k.wip), [k.waste]: C.glBalance(db, k.waste) },
  };
}

function assertMutable(po) {
  if (['closed', 'cancelled', 'voided'].includes(String(po.status))) {
    throw C.stop(`سفارش ${po.order_no} در وضعیت ${po.status} است — اول بازگشایی`);
  }
}

function postPair(db, item, { shape, userId, reasonTag }) {
  const P = C.srv('lib/production/posting');
  const issueRial = shape === 'p6' ? item.gross_rial : item.net_rial;
  const je1 = P.postEvent(db, {
    event: 'PRD-01', sourceId: item.lay_id, date: item.date, createdBy: userId,
    description: `مصرف پارچه برش مشترک ${item.batch_no || ''} — ${reasonTag}`.trim(),
    costCenterId: item.cost_center_id, lines: [P.dr(db, 'coa_wip', issueRial), P.cr(db, 'coa_raw_materials', issueRial)],
  });
  const je2 = P.postEvent(db, {
    event: 'PRD-09', sourceId: item.lay_id, date: item.date, createdBy: userId,
    description: `اتلاف طولی برش ${item.batch_no || ''} — ${reasonTag}`.trim(),
    costCenterId: item.cost_center_id,
    lines: [P.dr(db, 'coa_abnormal_waste', item.waste_rial),
      shape === 'p6' ? P.cr(db, 'coa_wip', item.waste_rial) : P.cr(db, 'coa_raw_materials', item.waste_rial)],
  });
  if (!je1 || !je2 || !je1.je_id || !je2.je_id) throw C.stop('STOP: ثبت سند PRD ناموفق');
  return { issue_je_id: je1.je_id, waste_je_id: je2.je_id };
}

function voidPair(db, ids, { userId, reason }) {
  const { reverseJournalEntry } = C.srv('lib/void-journal');
  for (const id of ids) C.assertNoPurgeCollateral(db, id);
  for (const id of ids) {
    reverseJournalEntry(db, id, { userId, reason });
    if (C.liveJe(db, id)) throw C.stop(`STOP: سند #${id} ابطال نشد`);
  }
}

function repoint(db, item, pair, oldIssueJe) {
  db.prepare('UPDATE cutting_lays SET journal_id=?, waste_journal_id=? WHERE id=?')
    .run(pair.issue_je_id, pair.waste_je_id, item.lay_id);
  db.prepare('UPDATE cutting_batches SET journal_id=?, waste_journal_id=? WHERE id=? AND journal_id=?')
    .run(pair.issue_je_id, pair.waste_je_id, item.batch_id, oldIssueJe);
}

function setIssueAmount(db, mi, amount) {
  const q = Number(mi.qty_actual) || 0;
  const unit = q > 0 ? Math.round(amount / q) : 0;
  db.prepare(`
    UPDATE production_material_issues
    SET amount_rial=?, std_amount_rial=?, unit_cost_rial=?, std_cost_rial=?
    WHERE id=?
  `).run(amount, amount, unit, unit, mi.id);
}

function glNets(db, k) {
  return [k.raw, k.wip, k.waste].map((c) => C.glBalance(db, c).net_rial);
}

function openApplyAudit(db, orderId) {
  const ap = db.prepare(`SELECT * FROM audit_log WHERE entity=? AND action='p8b_apply' AND entity_id=? ORDER BY id DESC LIMIT 1`)
    .get(ENTITY, Number(orderId));
  if (!ap) return null;
  const rv = db.prepare(`SELECT 1 FROM audit_log WHERE entity=? AND action='p8b_reverse' AND entity_id=? AND id>? LIMIT 1`)
    .get(ENTITY, Number(orderId), ap.id);
  return rv ? null : ap;
}

function applySharedWaste(db, { orderId = 19, reason, userId = null } = {}) {
  if (openApplyAudit(db, orderId)) throw C.stop(`اصلاح ${ENTITY} برای سفارش ${orderId} قبلاً اعمال شده`);
  const plan = planSharedWaste(db, { orderId });
  if (!plan.items.length) throw C.stop('لایهٔ قدیمی (اتلاف بستانکار مواد) برای این سفارش نیست');
  const bad = plan.items.filter((i) => i.problems.length);
  if (bad.length) throw C.stop(`STOP: ناسازگاری داده: ${JSON.stringify(bad.map((b) => ({ lay: b.lay_id, p: b.problems })))}`);
  const po = db.prepare('SELECT * FROM production_orders WHERE id=?').get(Number(orderId));
  assertMutable(po);
  const k = plan.codes;
  const OCR = C.srv('lib/production/order-cost-reconcile');
  const gl0 = glNets(db, k);
  const ocr0 = plan.ocr;
  const stage0 = plan.stages.map((s) => ({ ...s }));
  const tag = `اصلاح P8b-2 (شکل P6: ناخالص + اتلاف از WIP)`;
  const done = [];
  for (const item of plan.items) {
    voidPair(db, [item.issue_je.id, item.waste_je.id], { userId, reason: `${tag} — ${reason}` });
    const pair = postPair(db, item, { shape: 'p6', userId, reasonTag: tag });
    repoint(db, item, pair, item.issue_je.id);
    setIssueAmount(db, item.mi, item.gross_rial);
    done.push({ ...item, new_issue_je_id: pair.issue_je_id, new_waste_je_id: pair.waste_je_id });
  }
  for (const s of plan.stages) {
    const w = done.filter((d) => d.stage_id === s.id).reduce((a, d) => a + d.waste_rial, 0);
    if (!w) continue;
    if (s.status === 'done') {
      db.prepare(`UPDATE production_order_stages SET material_added_rial=COALESCE(material_added_rial,0)+?,
        waste_abnormal_rial=COALESCE(waste_abnormal_rial,0)+? WHERE id=?`).run(w, w, s.id);
    } else {
      db.prepare('UPDATE production_order_stages SET material_added_rial=COALESCE(material_added_rial,0)+? WHERE id=?').run(w, s.id);
    }
  }
  OCR.applyDocumentCosts(db, po.id);
  const after = verifyAfter(db, { plan, gl0, ocr0, k, OCR, expectWipWasteDelta: plan.total_waste_rial });
  C.insertAudit(db, {
    userId, action: 'p8b_apply', entity: ENTITY, entityId: po.id,
    detail: {
      reason, order_id: po.id, total_waste_rial: plan.total_waste_rial,
      lays: done.map((d) => ({
        lay_id: d.lay_id, batch_id: d.batch_id, stage_id: d.stage_id, date: d.date, batch_no: d.batch_no,
        cost_center_id: d.cost_center_id, net_rial: d.net_rial, waste_rial: d.waste_rial, gross_rial: d.gross_rial,
        old_issue_je_id: d.issue_je.id, old_waste_je_id: d.waste_je.id,
        new_issue_je_id: d.new_issue_je_id, new_waste_je_id: d.new_waste_je_id, mi_old: d.mi,
      })),
      stages_old: stage0.map((s) => ({ id: s.id, material_added_rial: s.material_added_rial, waste_abnormal_rial: s.waste_abnormal_rial })),
      order_old: { material_cost_rial: plan.order.material_cost_rial, abnormal_waste_rial: plan.order.abnormal_waste_rial },
    },
  });
  return { plan, done, after };
}

function verifyAfter(db, { plan, gl0, ocr0, k, OCR, expectWipWasteDelta }) {
  const gl1 = glNets(db, k);
  if (gl1.join() !== gl0.join()) throw C.stop(`STOP: ماندهٔ ${k.raw}/${k.wip}/${k.waste} تغییر کرد (${gl0} → ${gl1})`);
  const ocr1 = OCR.previewOrderCostReconcile(db, plan.order.id);
  if (ocr1.wip_abnormal_waste_rial - ocr0.wip_abnormal_waste_rial !== expectWipWasteDelta) {
    throw C.stop(`STOP: اتلاف داخل WIP انتظار ${expectWipWasteDelta} · دریافت ${ocr1.wip_abnormal_waste_rial - ocr0.wip_abnormal_waste_rial}`);
  }
  if (ocr1.expected_receipts_rial !== ocr0.expected_receipts_rial) {
    throw C.stop(`STOP: رسید مورد انتظار تغییر کرد (${ocr0.expected_receipts_rial} → ${ocr1.expected_receipts_rial})`);
  }
  if (!ocr1.aligned) throw C.stop('STOP: ستون‌های سفارش با اسناد یکی نیست');
  const stages = plan.stages.map((s) => db.prepare('SELECT * FROM production_order_stages WHERE id=?').get(s.id));
  for (const s of stages) {
    const s0 = plan.stages.find((x) => x.id === s.id);
    if (Math.round(s.cost_out_rial) !== Math.round(s0.cost_out_rial)) throw C.stop(`STOP: cost_out مرحله ${s.id} تغییر کرد`);
  }
  const order = db.prepare('SELECT material_cost_rial, abnormal_waste_rial, status FROM production_orders WHERE id=?').get(plan.order.id);
  return { gl: gl1, ocr: ocr1, stages: stages.map((s) => ({ id: s.id, material_added_rial: s.material_added_rial,
    waste_abnormal_rial: s.waste_abnormal_rial, cost_out_rial: s.cost_out_rial })), order };
}

function reverseSharedWaste(db, { orderId = 19, reason, userId = null } = {}) {
  const ap = openApplyAudit(db, orderId);
  if (!ap) throw C.stop(`اصلاح باز ${ENTITY} برای سفارش ${orderId} نیست`);
  const d = JSON.parse(ap.detail);
  const po = db.prepare('SELECT * FROM production_orders WHERE id=?').get(Number(orderId));
  assertMutable(po);
  const k = codes(db);
  const OCR = C.srv('lib/production/order-cost-reconcile');
  const gl0 = glNets(db, k);
  const ocr0 = OCR.previewOrderCostReconcile(db, po.id);
  const tag = 'ابطال اصلاح P8b-2 (بازگشت به شکل قبلی)';
  for (const l of d.lays) {
    const lay = db.prepare('SELECT * FROM cutting_lays WHERE id=?').get(l.lay_id);
    if (!lay || Number(lay.journal_id) !== Number(l.new_issue_je_id) || Number(lay.waste_journal_id) !== Number(l.new_waste_je_id)) {
      throw C.stop(`STOP: لایه ${l.lay_id} بعد از اصلاح تغییر کرده — ابطال خودکار ممکن نیست`);
    }
    voidPair(db, [l.new_issue_je_id, l.new_waste_je_id], { userId, reason: `${tag} — ${reason}` });
    const pair = postPair(db, l, { shape: 'legacy', userId, reasonTag: tag });
    repoint(db, l, pair, l.new_issue_je_id);
    setIssueAmount(db, l.mi_old, Math.round(l.mi_old.amount_rial));
  }
  for (const s of d.stages_old) {
    db.prepare('UPDATE production_order_stages SET material_added_rial=?, waste_abnormal_rial=? WHERE id=?')
      .run(s.material_added_rial, s.waste_abnormal_rial, s.id);
  }
  OCR.applyDocumentCosts(db, po.id);
  const gl1 = glNets(db, k);
  if (gl1.join() !== gl0.join()) throw C.stop('STOP: ابطال ماندهٔ دفتر کل را تغییر داد');
  const ocr1 = OCR.previewOrderCostReconcile(db, po.id);
  if (ocr0.wip_abnormal_waste_rial - ocr1.wip_abnormal_waste_rial !== d.total_waste_rial) throw C.stop('STOP: اتلاف WIP برنگشت');
  const o1 = db.prepare('SELECT material_cost_rial, abnormal_waste_rial FROM production_orders WHERE id=?').get(po.id);
  if (Math.round(o1.material_cost_rial) !== Math.round(d.order_old.material_cost_rial)) throw C.stop('STOP: ستون مواد سفارش برنگشت');
  C.insertAudit(db, { userId, action: 'p8b_reverse', entity: ENTITY, entityId: po.id, detail: { reason, apply_audit_id: ap.id } });
  return { reversed_apply_audit_id: ap.id };
}

function csvRows(db, res) {
  const rows = [];
  const base = { item: ITEM, person_id: '', detail_account_id: '' };
  for (const d of res.done) {
    for (const [old, label] of [[d.issue_je.id, 'PRD-01'], [d.waste_je.id, 'PRD-09']]) {
      for (const l of C.jeLines(db, old)) {
        rows.push({ ...base, target_table: 'journal_lines', target_id: `JE ${old}`, action: 'gl_void',
          account_code: l.account_code, cost_center_id: l.cost_center_id, debit_rial: l.debit_rial, credit_rial: l.credit_rial,
          note: `soft-void ${label} قدیمی لایه ${d.lay_no}` });
      }
    }
    for (const [nu, label] of [[d.new_issue_je_id, 'PRD-01 ناخالص'], [d.new_waste_je_id, 'PRD-09 بستانکار WIP']]) {
      const head = db.prepare('SELECT voucher_number FROM journal_entries WHERE id=?').get(nu);
      for (const l of C.jeLines(db, nu)) {
        rows.push({ ...base, target_table: 'journal_lines', target_id: `new JE (${head && head.voucher_number})`, action: 'gl_new',
          account_code: l.account_code, cost_center_id: l.cost_center_id, debit_rial: l.debit_rial, credit_rial: l.credit_rial,
          note: `${label} لایه ${d.lay_no} (تاریخ ${d.date})` });
      }
    }
    const q = Number(d.mi.qty_actual) || 0;
    rows.push({ ...base, target_table: 'production_material_issues', target_id: d.mi.id, action: 'row_update',
      account_code: '', cost_center_id: d.cost_center_id, debit_rial: '', credit_rial: '',
      note: `amount_rial/std_amount_rial ${d.mi.amount_rial} → ${d.gross_rial}; unit_cost_rial ${d.mi.unit_cost_rial} → ${q > 0 ? Math.round(d.gross_rial / q) : 0}` });
    rows.push({ ...base, target_table: 'cutting_lays', target_id: d.lay_id, action: 'row_update', account_code: '',
      cost_center_id: d.cost_center_id, debit_rial: '', credit_rial: '',
      note: `journal_id ${d.issue_je.id} → سند جدید؛ waste_journal_id ${d.waste_je.id} → سند جدید (cutting_batches ${d.batch_id} هم)` });
  }
  for (const s of res.after.stages) {
    const s0 = res.plan.stages.find((x) => x.id === s.id);
    rows.push({ ...base, target_table: 'production_order_stages', target_id: s.id, action: 'row_update', account_code: '',
      cost_center_id: '', debit_rial: '', credit_rial: '',
      note: `material_added_rial ${s0.material_added_rial} → ${s.material_added_rial}; waste_abnormal_rial ${s0.waste_abnormal_rial} → ${s.waste_abnormal_rial}; cost_out_rial ${s0.cost_out_rial} (بدون تغییر)` });
  }
  const o0 = res.plan.order;
  const o1 = res.after.order;
  rows.push({ ...base, target_table: 'production_orders', target_id: o0.id, action: 'row_update', account_code: '',
    cost_center_id: '', debit_rial: '', credit_rial: '',
    note: `${o0.order_no} (${o1.status}) material_cost_rial ${o0.material_cost_rial} → ${o1.material_cost_rial}; abnormal_waste_rial ${o0.abnormal_waste_rial} → ${o1.abnormal_waste_rial}; اتلاف داخل WIP ${res.plan.ocr.wip_abnormal_waste_rial} → ${res.after.ocr.wip_abnormal_waste_rial}; رسید مورد انتظار ${res.after.ocr.expected_receipts_rial} (بدون تغییر)` });
  for (const [code, b] of Object.entries(res.plan.gl)) {
    rows.push({ ...base, target_table: 'journal_lines', target_id: code, action: 'info', account_code: code, cost_center_id: '',
      debit_rial: b.debit_rial, credit_rial: b.credit_rial, note: `ماندهٔ خالص ${b.net_rial} — بعد از اصلاح بدون تغییر` });
  }
  return rows;
}

async function main(args) {
  const mode = C.modeOf(args);
  const orderId = parseInt(args.order, 10) || 19;
  const userId = C.userIdArg(args);
  await C.withWorkingDb(args, mode, async (db) => {
    if (mode === 'reverse') {
      const r = C.runTxn(db, mode, () => reverseSharedWaste(db, { orderId, reason: args.reason, userId }));
      console.log(`✅ ابطال شد (apply audit #${r.reversed_apply_audit_id})`);
      return;
    }
    let rows = null;
    const res = C.runTxn(db, mode, () => {
      const r = applySharedWaste(db, { orderId, reason: mode === 'apply' ? args.reason : 'dry-run', userId });
      rows = csvRows(db, r);
      if (mode === 'dry-run') {
        // اثبات برگشت‌پذیری روی همان کپی، داخل همان تراکنش rollback‌شونده
        r.reverse_check = reverseSharedWaste(db, { orderId, reason: 'dry-run reverse check', userId });
        r.reverse_order = db.prepare('SELECT material_cost_rial, abnormal_waste_rial FROM production_orders WHERE id=?').get(orderId);
      }
      return r;
    });
    const name = mode === 'apply' ? `p8b-2-shared-waste-applied-order${orderId}.csv` : CSV_NAME;
    const file = C.writeCsv(path.join(C.outDir(args), name), rows);
    const summary = {
      item: ITEM, mode, order: res.plan.order, total_waste_rial: res.plan.total_waste_rial, total_net_rial: res.plan.total_net_rial,
      lays: res.done.map((d) => ({ lay_id: d.lay_id, lay_no: d.lay_no, net: d.net_rial, waste: d.waste_rial, gross: d.gross_rial,
        old: [d.issue_je.id, d.waste_je.id], mi: d.mi.id })),
      skipped: res.plan.skipped, stages_before: res.plan.stages, after: res.after,
      ocr_before: { wip_abnormal_waste_rial: res.plan.ocr.wip_abnormal_waste_rial, shared_lay_waste_rial: res.plan.ocr.shared_lay_waste_rial,
        expected_receipts_rial: res.plan.ocr.expected_receipts_rial, aligned: res.plan.ocr.aligned, documents: res.plan.ocr.documents },
      gl_before: res.plan.gl, reverse_check: res.reverse_check || null, reverse_order: res.reverse_order || null, csv: file,
    };
    if (mode === 'dry-run') fs.writeFileSync(path.join(C.outDir(args), 'p8b-2-shared-waste.json'), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary, null, 2));
  });
}

module.exports = { planSharedWaste, applySharedWaste, reverseSharedWaste, ENTITY };

if (require.main === module) C.cli(main);
