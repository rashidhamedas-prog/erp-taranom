'use strict';
/**
 * v523 — گزارش/ترمیم اثر دو باگ ابطال مرحله:
 *  A) ردیف cutting_lay سفارش «reversed» شده ولی خود لایه/برش مشترک هنوز posted است
 *     → بهای پارچه از ستون‌های سفارش افتاده ولی در WIP دفتر کل هست.
 *  B) سند PRD هم‌ref (ref_type+ref_id یکسان، حتی از بازهٔ id دیگر مثل لایه/بسته/رسید) هم‌زمان
 *     باطل شده ولی ردیف زیرسیستمش posted مانده.
 *
 * نشانهٔ باگ (شرط احیا): سند production* با پسوند [ابطال]، ردیف منبع هنوز posted، و یک سند هم‌ref دیگر
 * دقیقاً در همان لحظه (deleted_at یکسان) باطل شده. سال مالی بسته / دورهٔ تولید بسته → فقط گزارش.
 *
 * پیش‌فرض: فقط گزارش (dry-run).
 *   --apply-je   احیای اسناد B (دستمزد فقط گزارش).
 *   --apply-lay  ردیف cutting_lay لایهٔ زنده را posted می‌کند (مرحلهٔ برش done نیست و JE لایه زنده است)
 *                + همسان‌سازی بهای سفارش. اول --apply-je را اجرا کنید اگر JE لایه هم قربانی شده.
 *   --order=ID   محدود به یک سفارش.
 * Run: DB_PATH=... node server/scripts/heal-stage-reverse-v523.js [--apply-je] [--apply-lay] [--order=19]
 */
const { getDB } = require('../db');

const args = process.argv.slice(2);
const APPLY_JE = args.includes('--apply-je');
const APPLY_LAY = args.includes('--apply-lay');
const onlyOrder = Number((args.find(a => a.startsWith('--order=')) || '').split('=')[1]) || null;

const db = getDB();
const { applyDocumentCosts } = require('../lib/production/order-cost-reconcile');
const { closedFiscalYearForDate } = require('../lib/void-journal');

const dead = (je) => !!je && (Number(je.deleted_at) > 0 || ['reversed', 'void'].includes(String(je.status || '')));
const jeHead = (id) => (id ? db.prepare(`
  SELECT id, entry_date, ref_type, ref_id, status, deleted_at, description, total_debit_rial
  FROM journal_entries WHERE id=?
`).get(id) : null);
const orderOk = (oid) => {
  const po = db.prepare('SELECT id, order_no, status FROM production_orders WHERE id=?').get(oid);
  return po && !['closed', 'cancelled', 'voided'].includes(po.status) ? po : null;
};
const prodPeriodClosed = (date) => {
  try {
    return !!db.prepare(`
      SELECT 1 FROM production_period_close
      WHERE status='closed' AND start_date<=? AND end_date>=? LIMIT 1
    `).get(date, date);
  } catch (_) { return false; }
};
const collateralSibling = (je) => db.prepare(`
  SELECT id FROM journal_entries
  WHERE ref_type=? AND ref_id=? AND id<>? AND deleted_at=? LIMIT 1
`).get(je.ref_type, je.ref_id, je.id, je.deleted_at);
const layGlobs = (layNo, layId) => {
  const tag = layNo || ('#' + layId);
  return [`*${tag}[^0-9]*`, `*${tag}`];
};
const hasCol = (table, col) => {
  try { return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col); }
  catch (_) { return false; }
};

// ── B) posted subledger/document rows whose JE was voided as collateral ──
const jeFindings = [];
const SOURCES = [
  { table: 'production_overhead_applications', kind: 'overhead', col: 'je_id', orderCol: 'order_id', restore: true },
  { table: 'production_material_issues', kind: 'material_issue', col: 'je_id', orderCol: 'order_id', restore: true, extra: "AND COALESCE(issue_type,'')<>'cutting_lay'" },
  { table: 'production_waste', kind: 'abnormal_waste', col: 'je_id', orderCol: 'order_id', restore: true },
  { table: 'production_receipts', kind: 'receipt', col: 'je_id', orderCol: 'order_id', restore: true },
  { table: 'production_subcontract', kind: 'subcontract', col: 'je_id', orderCol: 'order_id', restore: true },
  { table: 'cutting_lays', kind: 'lay_fabric', col: 'journal_id', orderCol: 'production_order_id', restore: true },
  { table: 'cutting_lays', kind: 'lay_waste', col: 'waste_journal_id', orderCol: 'production_order_id', restore: true },
  { table: 'cutting_lays', kind: 'lay_extra', col: 'extra_journal_id', orderCol: 'production_order_id', restore: true },
  { table: 'cutting_batches', kind: 'batch_fabric', col: 'journal_id', orderCol: null, restore: true },
  { table: 'cutting_batches', kind: 'batch_waste', col: 'waste_journal_id', orderCol: null, restore: true },
  { table: 'cutting_packs', kind: 'pack', col: 'journal_id', orderCol: 'production_order_id', restore: true },
  { table: 'production_labor_entries', kind: 'labor', col: 'je_id', orderCol: 'order_id', restore: false },
];
for (const src of SOURCES) {
  if (!hasCol(src.table, src.col)) continue;
  const oc = src.orderCol ? src.orderCol : 'NULL';
  let rows = [];
  try {
    rows = db.prepare(`
      SELECT id, ${oc} AS order_id, ${src.col} AS je_id FROM ${src.table}
      WHERE COALESCE(status,'posted')='posted' AND ${src.col} IS NOT NULL ${src.extra || ''}
      ${onlyOrder ? (src.orderCol ? `AND ${src.orderCol}=${onlyOrder}` : 'AND 0') : ''}
    `).all();
  } catch (_) { rows = []; }
  for (const r of rows) {
    const je = jeHead(r.je_id);
    if (!dead(je)) continue;
    const prodRef = /^production/.test(String(je.ref_type || ''));
    const softVoided = Number(je.deleted_at) > 0 && /\[ابطال\]/.test(String(je.description || ''));
    const collateral = prodRef && softVoided && !!collateralSibling(je);
    const po = r.order_id ? db.prepare('SELECT order_no, status FROM production_orders WHERE id=?').get(r.order_id) : null;
    const blockers = [];
    if (!src.restore) blockers.push('report_only');
    if (!collateral) blockers.push('not_collateral_signature');
    if (r.order_id && !orderOk(r.order_id)) blockers.push('order_closed');
    if (closedFiscalYearForDate(db, je.entry_date)) blockers.push('fiscal_year_closed');
    if (prodPeriodClosed(je.entry_date)) blockers.push('production_period_closed');
    jeFindings.push({
      kind: src.kind, table: src.table, row_id: r.id,
      order: po && po.order_no, order_id: r.order_id || null, order_status: po && po.status,
      je_id: r.je_id, je_ref: `${je.ref_type}#${je.ref_id}`, je_amount_rial: je.total_debit_rial,
      je_desc: String(je.description || '').slice(0, 140),
      fixable: !blockers.length, blockers,
    });
  }
}

// ── A) lay memos ──
const layFindings = [];
const lays = db.prepare(`
  SELECT * FROM cutting_lays
  WHERE COALESCE(status,'posted')='posted' AND production_order_id IS NOT NULL AND stage_id IS NOT NULL
  ${onlyOrder ? 'AND production_order_id=' + onlyOrder : ''}
`).all();
for (const lay of lays) {
  const [gMid, gEnd] = layGlobs(lay.lay_no, lay.id);
  const memos = db.prepare(`
    SELECT id, status, amount_rial FROM production_material_issues
    WHERE order_id=? AND stage_id=? AND issue_type='cutting_lay' AND (note GLOB ? OR note GLOB ?)
    ORDER BY id DESC
  `).all(lay.production_order_id, lay.stage_id, gMid, gEnd);
  if (!memos.length || memos.some(m => m.status === 'posted')) continue;
  const stage = db.prepare('SELECT id, seq, status FROM production_order_stages WHERE id=?').get(lay.stage_id);
  const po = db.prepare('SELECT id, order_no, status FROM production_orders WHERE id=?').get(lay.production_order_id);
  const layJes = [lay.journal_id, lay.waste_journal_id, lay.extra_journal_id].filter(Boolean);
  if (lay.batch_id) {
    const b = db.prepare('SELECT journal_id, waste_journal_id FROM cutting_batches WHERE id=?').get(lay.batch_id);
    if (b) layJes.push(...[b.journal_id, b.waste_journal_id].filter(Boolean));
  }
  const deadLayJes = layJes.filter(id => dead(jeHead(id)));
  const blockers = [];
  if (!orderOk(lay.production_order_id)) blockers.push('order_closed');
  if (!stage || stage.status === 'done') blockers.push('stage_done');
  if (deadLayJes.length) blockers.push('lay_je_dead:' + deadLayJes.join(','));
  layFindings.push({
    order: po && po.order_no, order_id: lay.production_order_id, order_status: po && po.status,
    stage_seq: stage && stage.seq, stage_status: stage && stage.status,
    lay_no: lay.lay_no, lay_amount_rial: Math.round(Number(lay.amount_rial) || 0),
    memo_id: memos[0].id, memo_amount_rial: Math.round(Number(memos[0].amount_rial) || 0),
    fixable: !blockers.length, blockers,
  });
}

console.log(JSON.stringify({
  mode: { apply_je: APPLY_JE, apply_lay: APPLY_LAY, order: onlyOrder },
  lay_findings: layFindings, je_findings: jeFindings,
}, null, 1));

const touched = new Set();
if (APPLY_JE || APPLY_LAY) {
  db.transaction(() => {
    if (APPLY_JE) {
      const seen = new Set();
      for (const f of jeFindings.filter(x => x.fixable)) {
        if (seen.has(f.je_id)) continue;
        seen.add(f.je_id);
        const je = jeHead(f.je_id);
        const desc = String(je.description || '').replace(/\s*\[ابطال\][\s\S]*$/, '');
        db.prepare(`UPDATE journal_entries SET status='approved', deleted_at=NULL, deleted_by=NULL, description=? WHERE id=?`)
          .run(desc, f.je_id);
        db.prepare(`
          INSERT INTO audit_log (user_id, action, entity, entity_id, detail)
          VALUES (1, 'update', 'journal_entry', ?, ?)
        `).run(f.je_id, `v523 احیای سند ${f.kind} ${f.order || f.je_ref} — ابطال اشتباه هم‌ref هنگام ابطال مرحلهٔ دیگر`);
        if (f.order_id) touched.add(f.order_id);
      }
    }
    if (APPLY_LAY) {
      for (const f of layFindings.filter(x => x.fixable)) {
        db.prepare(`UPDATE production_material_issues SET status='posted' WHERE id=?`).run(f.memo_id);
        db.prepare(`
          INSERT INTO audit_log (user_id, action, entity, entity_id, detail)
          VALUES (1, 'update', 'production_material_issue', ?, ?)
        `).run(f.memo_id, `v523 بازگرداندن مصرف پارچهٔ ${f.lay_no} به ${f.order} (لایه زنده است)`);
        const st = db.prepare('SELECT id FROM production_order_stages WHERE order_id=? AND seq=?').get(f.order_id, f.stage_seq);
        if (st) {
          const s = db.prepare(`
            SELECT COALESCE(SUM(amount_rial),0) s FROM production_material_issues
            WHERE stage_id=? AND status='posted' AND COALESCE(extra_class,'')<>'abnormal'
          `).get(st.id).s;
          db.prepare('UPDATE production_order_stages SET material_added_rial=? WHERE id=?').run(Math.round(s), st.id);
        }
        touched.add(f.order_id);
      }
    }
    for (const oid of touched) applyDocumentCosts(db, oid);
  })();
  const after = [...touched].map(oid => db.prepare(`
    SELECT id, order_no, material_cost_rial, labor_cost_rial, overhead_cost_rial, abnormal_waste_rial FROM production_orders WHERE id=?
  `).get(oid));
  console.log(JSON.stringify({ applied: true, orders: after }, null, 1));
}
