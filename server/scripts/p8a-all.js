'use strict';
/**
 * P8a — اجرای تجمعی اقلام ۱، ۲، ۴، ۳ روی «یک» کپی موقت (dry-run، ROLLBACK) و خروجی:
 *   reports/prodcycle-p8/p8a-deltas.csv          همهٔ دلتاهای GL و کاردکس (ورودی ادغام P8b)
 *   reports/prodcycle-p8/p8a-before-after.csv    کاردکس WH33/WH37/WH34 در برابر GL 1110/1111/1104
 *   reports/prodcycle-p8/p8a-products.csv        خالص اثر روی کالاهای 332/333/334
 *   reports/prodcycle-p8/p8a-all-summary.md
 * فقط dry-run؛ هیچ مسیر apply ندارد (هر قلم اسکریپت apply خودش را دارد).
 *   node server/scripts/p8a-all.js [--db=PATH] [--out=DIR] [--date=YYYY/MM/DD]
 */
const path = require('path');
const fs = require('fs');
const C = require('./lib/p8a-common');
const items = require('./lib/p8a-items');

const ORDER = [items.item1, items.item2, items.item4, items.item3];
const PAIRS = [
  { label: 'WH33 مواد اولیه ↔ GL 1110', wh: [33], gl: '1110' },
  { label: 'WH37 کار در جریان ↔ GL 1111', wh: [37], gl: '1111' },
  { label: 'WH34 انبار محصول ↔ GL 1104', wh: [34], gl: '1104' },
  { label: 'WH34+WH35 محصول ↔ GL 1104 (اطلاعی)', wh: [34, 35], gl: '1104' },
];
const PRODUCTS = [332, 333, 334];

function measure(db) {
  const gl = C.glBalances(db);
  const km = C.kardexMap(db);
  const pairs = PAIRS.map((p) => {
    const k = p.wh.reduce((s, w) => s + C.kardexWh(km, w).val, 0);
    const g = C.glPrefix(gl, p.gl);
    return { label: p.label, kardex: k, gl: g, gap: k - g };
  });
  const products = PRODUCTS.map((pid) => {
    const pr = db.prepare('SELECT id, name, stock, average_cost_rial FROM products WHERE id=?').get(pid) || {};
    const byWh = {};
    for (const [k, v] of km) {
      const [wh, p] = k.split('|').map(Number);
      if (p === pid) byWh[wh] = { qty: C.r6(v.qty), val: C.rial(v.val) };
    }
    return { product_id: pid, name: pr.name, stock: pr.stock, avg: pr.average_cost_rial, by_wh: byWh };
  });
  return { pairs, products };
}

(async () => {
  const args = C.parseArgs();
  const outDir = args.out || C.defaultOutDir();
  const src = path.resolve(args.db || process.env.DB_PATH || path.join(C.ROOT, 'crm.db'));
  const copy = await C.makeCopy(src);
  const db = C.openAppDb(copy);
  const { todayJalali } = C.R('jalali');
  const userId = C.pickUser(db, args.userId);
  const date = args.date || todayJalali();
  const stages = [];
  const deltas = [];
  const results = {};
  try {
    stages.push({ stage: 'before', m: measure(db) });
    db.exec('BEGIN');
    try {
      for (const spec of ORDER) {
        const cfg = Object.assign({}, spec.defaults);
        const watch = spec.watch(db, cfg);
        const before = C.snapshot(db, watch);
        const ctx = { cfg, userId, mode: 'dry-run', reason: 'P8a dry-run (تجمعی)', date, R: C.R };
        db.exec('SAVEPOINT p8a_item');
        let result;
        try {
          result = spec.run(db, ctx);
          db.exec('RELEASE p8a_item');
        } catch (e) {
          db.exec('ROLLBACK TO p8a_item');
          db.exec('RELEASE p8a_item');
          result = { error: e.message, code: e.code };
        }
        const res = C.diff(db, spec.key, 'dry-run', before, C.snapshot(db, watch));
        results[spec.key] = { result, gl: res.gl, kardex: res.kardex, side: res.side };
        for (const r of res.rows) if (r.action === 'gl_delta' || r.action === 'kardex_delta') deltas.push(r);
        stages.push({ stage: `after_${spec.key}`, m: measure(db) });
      }
    } finally {
      db.exec('ROLLBACK');
    }
  } finally {
    try { C.R('db').closeDB(); } catch (_) { /* ignore */ }
    C.removeCopy(copy);
  }

  fs.mkdirSync(outDir, { recursive: true });
  C.writeCsv(path.join(outDir, 'p8a-deltas.csv'), deltas);

  const baRows = [];
  for (const p of PAIRS) {
    const row = { metric: p.label };
    for (const s of stages) {
      const x = s.m.pairs.find((y) => y.label === p.label);
      row[`${s.stage}_kardex`] = x.kardex;
      row[`${s.stage}_gl`] = x.gl;
      row[`${s.stage}_gap`] = x.gap;
    }
    baRows.push(row);
  }
  const baCols = ['metric', ...stages.flatMap((s) => [`${s.stage}_kardex`, `${s.stage}_gl`, `${s.stage}_gap`])];
  C.writeCsv(path.join(outDir, 'p8a-before-after.csv'), baRows, baCols);

  const prodRows = [];
  const first = stages[0].m.products;
  const last = stages[stages.length - 1].m.products;
  for (const pid of PRODUCTS) {
    const b = first.find((x) => x.product_id === pid);
    const a = last.find((x) => x.product_id === pid);
    const whs = new Set([...Object.keys(b.by_wh), ...Object.keys(a.by_wh)]);
    for (const wh of whs) {
      const bv = b.by_wh[wh] || { qty: 0, val: 0 };
      const av = a.by_wh[wh] || { qty: 0, val: 0 };
      prodRows.push({
        product_id: pid, name: b.name, warehouse_id: wh, qty_before: bv.qty, qty_after: av.qty,
        value_before: bv.val, value_after: av.val, value_delta: av.val - bv.val,
        header_avg_before: b.avg, header_avg_after: a.avg, header_stock: a.stock,
      });
    }
  }
  C.writeCsv(path.join(outDir, 'p8a-products.csv'), prodRows,
    ['product_id', 'name', 'warehouse_id', 'qty_before', 'qty_after', 'value_before', 'value_after', 'value_delta', 'header_avg_before', 'header_avg_after', 'header_stock']);

  const md = [];
  md.push('# P8a — اجرای تجمعی (dry-run روی کپی، ROLLBACK)');
  md.push('');
  md.push(`منبع: ${path.basename(src)} — تاریخ اصلاح‌ها: ${date} — ترتیب: item1 → item2 → item4 → item3`);
  md.push('');
  md.push('## کاردکس در برابر دفتر کل (ریال)');
  md.push('| شاخص | ' + stages.map((s) => s.stage).join(' | ') + ' |');
  md.push('|---|' + stages.map(() => '---:').join('|') + '|');
  for (const p of PAIRS) {
    const cells = stages.map((s) => {
      const x = s.m.pairs.find((y) => y.label === p.label);
      return `K ${x.kardex.toLocaleString('en-US')}<br>GL ${x.gl.toLocaleString('en-US')}<br>Δ ${x.gap.toLocaleString('en-US')}`;
    });
    md.push(`| ${p.label} | ${cells.join(' | ')} |`);
  }
  md.push('');
  md.push('## نتیجهٔ اقلام');
  md.push('```json');
  md.push(JSON.stringify(results, null, 2));
  md.push('```');
  fs.writeFileSync(path.join(outDir, 'p8a-all-summary.md'), md.join('\n') + '\n', 'utf8');
  console.log(JSON.stringify({ stages: stages.map((s) => ({ stage: s.stage, pairs: s.m.pairs })), errors: Object.fromEntries(Object.entries(results).filter(([, v]) => v.result && v.result.error).map(([k, v]) => [k, v.result.error])) }, null, 2));
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
