'use strict';
/**
 * v527 — گزارش/ترمیم اتصال مواد→عملیات یک فرمول (strict routing).
 *
 * چرا: تا v525 قلمِ بدون عملیات خودکار به مرحلهٔ اول (برش) می‌افتاد و گیت حوالهٔ v523 برش را
 * می‌بست (PO-0019: «بند کلاه و شلوار (168)» روی برش). از v527 چنین قلمی روی هیچ مرحله‌ای نمی‌آید و
 * فعال‌سازی/آزادسازی/حواله گیت می‌خورد؛ این اسکریپت برای فرمول‌های فعالِ در جریان، اتصال را
 * یک‌بار و صریح ثبت می‌کند (روی فرمول فعال مجاز است — فقط مرحلهٔ حواله عوض می‌شود، نه مقدار/بها).
 *
 * پیش‌فرض: فقط گزارش (dry-run).
 *   --bom=ID                فرمول (اجباری)
 *   --map=LINE:OP,LINE:OP   اتصال‌های جدید (شناسهٔ bom_lines → شناسهٔ bom_operations). اتصال قبلیِ همان قلم جایگزین می‌شود.
 *   --backfill              قبل از map، نگاشت خودکار از مرکز هزینهٔ قلم (پارچهٔ طاقه‌ای → برش) هم انجام شود
 *   --apply                 اعمال (بدون آن فقط پیش‌نمایش)
 *   --order=ID              بعد از کار، قالب حوالهٔ همهٔ مراحل این سفارش را چاپ کن (برای تأیید)
 *   --user=ID               کاربر ثبت‌کننده در تاریخچهٔ فرمول (پیش‌فرض 1)
 * Run: DB_PATH=... node server/scripts/heal-bom-assignments-v527.js --bom=32 --map=202:61 [--backfill] [--apply] [--order=19]
 */
const { getDB } = require('../db');
const asg = require('../lib/production/bom-assignments');

const args = process.argv.slice(2);
const flag = (k) => args.includes(k);
const opt = (k) => (args.find(a => a.startsWith(k + '=')) || '').split('=').slice(1).join('=') || '';
const bomId = Number(opt('--bom')) || null;
const APPLY = flag('--apply');
const BACKFILL = flag('--backfill');
const orderId = Number(opt('--order')) || null;
const userId = Number(opt('--user')) || 1;
if (!bomId) {
  console.error('usage: --bom=ID [--map=LINE:OP,...] [--backfill] [--apply] [--order=ID]');
  process.exit(2);
}
const map = opt('--map').split(',').map(s => s.trim()).filter(Boolean).map(pair => {
  const [l, o] = pair.split(':').map(Number);
  if (!(l > 0) || !(o > 0)) throw new Error('bad --map pair: ' + pair);
  return { bom_line_id: l, operation_id: o };
});

const db = getDB();
const out = { mode: { apply: APPLY, backfill: BACKFILL, bom_id: bomId, order_id: orderId }, before: {}, plan: {}, after: null, order_preview: null, errors: [] };

const bom = db.prepare('SELECT id, code, name, status, product_id, has_routing FROM bom_headers WHERE id=? AND deleted_at IS NULL').get(bomId);
if (!bom) { console.error('BOM not found: ' + bomId); process.exit(2); }
const lines = db.prepare(`
  SELECT bl.id, bl.line_no, bl.component_product_id, p.name AS component, bl.qty_per_base, bl.line_type,
         bl.product_scope, bl.scoped_product_id, bl.stage_cost_center_id, cc.code AS stage_cc_code
  FROM bom_lines bl
  LEFT JOIN products p ON p.id = bl.component_product_id
  LEFT JOIN cost_centers cc ON cc.id = bl.stage_cost_center_id
  WHERE bl.bom_id=? ORDER BY bl.line_no, bl.id
`).all(bomId);
const ops = db.prepare(`
  SELECT op.id, op.seq, op.operation_name, op.cost_center_id, cc.code AS cc_code, cc.name AS cc_name
  FROM bom_operations op LEFT JOIN cost_centers cc ON cc.id = op.cost_center_id
  WHERE op.bom_id=? ORDER BY op.seq, op.id
`).all(bomId);
const snapshot = () => ({
  assignments: asg.listAssignments(db, bomId).map(a => ({
    bom_line_id: a.bom_line_id, line_no: a.line_no, component_product_id: a.component_product_id,
    operation_id: a.operation_id, operation_seq: a.operation_seq, operation_name: a.operation_name,
    allocation_mode: a.allocation_mode, share_percent: a.share_percent,
  })),
  unassigned: asg.unassignedBomLines(db, bomId).map(u => ({ bom_line_id: u.bom_line_id, line_no: u.line_no, name: u.name })),
});
out.before = { bom, lines, operations: ops, ...snapshot() };

// ── validate the map against this BOM ──
const lineIds = new Set(lines.map(l => Number(l.id)));
const opIds = new Set(ops.map(o => Number(o.id)));
for (const m of map) {
  if (!lineIds.has(m.bom_line_id)) out.errors.push(`line ${m.bom_line_id} is not on BOM ${bomId}`);
  if (!opIds.has(m.operation_id)) out.errors.push(`operation ${m.operation_id} is not on BOM ${bomId}`);
}
if (!['draft', 'active'].includes(String(bom.status))) out.errors.push(`BOM status ${bom.status}: assignments are frozen (E_BOM_ASSIGN_LOCKED)`);

// ── plan: existing (minus remapped lines) + map (sole) ──
const remapped = new Set(map.map(m => m.bom_line_id));
const existing = asg.listAssignments(db, bomId)
  .filter(a => !remapped.has(Number(a.bom_line_id)))
  .map(a => ({
    bom_line_id: a.bom_line_id, operation_id: a.operation_id, allocation_mode: a.allocation_mode || 'sole',
    share_percent: a.share_percent, qty_override: a.qty_override, component_color_mode: a.component_color_mode,
    component_color_id: a.component_color_id, note: a.note,
  }));
const planned = [...existing, ...map.map(m => ({ ...m, allocation_mode: 'sole', note: 'heal-v527' }))];
const opName = (id) => { const o = ops.find(x => Number(x.id) === Number(id)); return o ? `${o.seq} ${o.operation_name} (${o.cc_code || ''})` : '#' + id; };
const lineName = (id) => { const l = lines.find(x => Number(x.id) === Number(id)); return l ? `${l.line_no} ${l.component}` : '#' + id; };
out.plan = {
  backfill_first: BACKFILL,
  assignments: planned.map(p => ({ ...p, line: lineName(p.bom_line_id), operation: opName(p.operation_id) })),
  would_remain_unassigned: lines
    .filter(l => !planned.some(p => Number(p.bom_line_id) === Number(l.id)))
    .filter(l => !(l.stage_cost_center_id && ops.some(o => Number(o.cost_center_id) === Number(l.stage_cost_center_id))))
    .map(l => ({ bom_line_id: l.id, line_no: l.line_no, component: l.component })),
};

if (APPLY && !out.errors.length) {
  db.transaction(() => {
    if (BACKFILL) out.backfill = asg.backfillAssignmentsFromStageCc(db, bomId, userId);
    if (map.length) {
      // after backfill the "existing" set may have grown — rebuild the plan from live rows
      const live = asg.listAssignments(db, bomId)
        .filter(a => !remapped.has(Number(a.bom_line_id)))
        .map(a => ({
          bom_line_id: a.bom_line_id, operation_id: a.operation_id, allocation_mode: a.allocation_mode || 'sole',
          share_percent: a.share_percent, qty_override: a.qty_override, component_color_mode: a.component_color_mode,
          component_color_id: a.component_color_id, note: a.note,
        }));
      asg.replaceAssignments(db, bomId, [...live, ...map.map(m => ({ ...m, allocation_mode: 'sole', note: 'heal-v527' }))], userId);
    }
  })();
  out.after = snapshot();
}

if (orderId) {
  try {
    const engine = require('../lib/production/engine');
    const adv = require('../lib/production/engine-advanced');
    const po = engine.getOrderDetail(db, orderId);
    const stages = adv.stageList(db, orderId);
    out.order_preview = {
      order_no: po.order_no, status: po.status,
      material_gaps: adv.orderMaterialGaps(db, po).map(g => ({ bom: g.bom_code, line_no: g.line_no, name: g.name })),
      stages: stages.map(s => {
        const tpl = adv.getStageIssueTemplate(db, orderId, s.id);
        return {
          id: s.id, seq: s.seq, name: s.operation_name, status: s.status, scope: s.product_scope || 'shared',
          scoped_product_id: s.scoped_product_id || null,
          lines: (tpl.lines || []).map(L => `${L.product_name || L.product_id} × ${L.qty_standard}${L.via_cutting_lay ? ' (لایه)' : ''}`),
          unissued: (tpl.unissued || []).map(u => `${u.product_name || u.product_id} × ${u.qty_standard ?? u.qty ?? ''}`),
          empty_hint: tpl.lines && tpl.lines.length ? '' : tpl.empty_hint,
        };
      }),
    };
  } catch (e) { out.order_preview = { error: e.code || e.message }; }
}

console.log(JSON.stringify(out, null, 1));
process.exit(out.errors.length ? 1 : 0);
