'use strict';
/**
 * حل گروه «ambiguous variant» و ردیف‌های بدون واریانت رسید تولید PO-0019.
 *
 * پیش‌فرض --dry-run (پایگاه فقط‌خواندنی باز می‌شود). اعمال فقط با --apply و --i-have-go، پس از پشتیبان.
 *
 *   node scripts/stock-variant-resolve.js --db <copy> --manual-csv <manual.csv> --out <dir>
 *   node scripts/stock-variant-resolve.js --db <db> --manual-csv <csv> --out <dir> --backup-dir <dir> --apply --i-have-go
 *
 * گروه A — ردیف‌های kind=ambiguous_variant در manual.csv (فروش، برگشت از فروش، افتتاحیه):
 *   ردیف کاردکس با خط سند خودش (فاکتور / برگشت / افتتاحیه) با سند + کالا + تعداد تطبیق می‌خورد؛
 *   فقط اگر دقیقاً یک خط با واریانت معتبر بماند variant_id پر می‌شود (همراه ردیف معکوس آن). بقیه → unresolved.
 * گروه B — رسیدهای تولید سفارش --order (پیش‌فرض PO-0019): ردیف زندهٔ production_receipt بدون واریانت که
 *   تعداد آن با variant_lines_json رسید برابر است → سند رسمی اصلاح تفکیک واریانت (VR) از lib/inventory/variant-reclass.
 *   هیچ نوشتن مستقیم موجودی نیست؛ کش‌ها فقط با rebuildStockCache.
 *
 * در اعمال، داخل یک تراکنش: تراز آزمایشی و تعداد اسناد حسابداری باید عیناً ثابت بماند، تطبیق زیرسیستم‌ها بدتر
 * نشود و کش کالاهای لمس‌شده با کاردکس برابر باشد؛ وگرنه تراکنش برمی‌گردد. فایل .env خوانده نمی‌شود.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const QTY_EPS = 1e-4;
const GROUP = 'ambiguous_variant';
const SOURCES = new Set(['invoice', 'sales_return', 'opening_inventory']);

function parseArgs(argv) {
  const out = { apply: false, go: false, db: null, out: null, backupDir: null, manualCsv: null, order: 'PO-0019',
    expectRows: null, expectProducts: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--dry-run') out.apply = false;
    else if (a === '--i-have-go') out.go = true;
    else if (a === '--db') out.db = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--backup-dir') out.backupDir = argv[++i];
    else if (a === '--manual-csv') out.manualCsv = argv[++i];
    else if (a === '--order') out.order = argv[++i];
    else if (a === '--expect-rows') out.expectRows = Number(argv[++i]);
    else if (a === '--expect-products') out.expectProducts = Number(argv[++i]);
    else if (a === '-h' || a === '--help') out.help = true;
    else throw new Error('پرچم ناشناخته: ' + a);
  }
  return out;
}

function csvEscape(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function writeCsv(file, headers, rows) {
  const lines = [headers.join(',')];
  for (const r of rows) lines.push(headers.map((h) => csvEscape(r[h])).join(','));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '\uFEFF' + lines.join('\n') + '\n', 'utf8');
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  const s = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"' && s[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((x) => x !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x !== '')) rows.push(row);
  const [head, ...body] = rows;
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), r[i] == null ? '' : r[i]])));
}

/** Ledger ids of the reviewed «ambiguous variant» group. */
function loadGroup(file) {
  const rows = parseCsv(fs.readFileSync(file, 'utf8')).filter((r) => r.kind === GROUP);
  const ids = rows.map((r) => Number(r.ledger_id)).filter((n) => n > 0);
  return { ids, products: new Set(rows.map((r) => Number(r.product_id))).size };
}

function parseRows(json) {
  try { const a = JSON.parse(json || '[]'); return Array.isArray(a) ? a : []; } catch (_) { return []; }
}

/** Candidate document lines of one ledger row (same product). */
function docLines(db, row) {
  const pid = Number(row.product_id);
  const st = String(row.source_type || '');
  if (st === 'invoice' || st === 'sales_return') {
    const t = st === 'invoice' ? 'invoices' : 'sales_returns';
    const d = db.prepare(`SELECT rows FROM ${t} WHERE id=?`).get(row.source_id);
    return parseRows(d && d.rows).map((x, i) => ({
      line: i, product_id: Number(x.product_id), variant_id: Number(x.variant_id) || null, qty: Number(x.qty) || 0,
    })).filter((l) => l.product_id === pid);
  }
  if (st === 'opening_inventory') {
    const out = [];
    const has = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
    if (has('product_opening_stock')) {
      for (const r of db.prepare('SELECT id, product_id, variant_id, qty FROM product_opening_stock WHERE ledger_id=?').all(row.id)) {
        out.push({ line: 'pos:' + r.id, product_id: Number(r.product_id), variant_id: Number(r.variant_id) || null, qty: Number(r.qty) || 0 });
      }
    }
    if (has('opening_stock_lines')) {
      for (const r of db.prepare('SELECT id, product_id, variant_id, qty FROM opening_stock_lines WHERE ledger_id=?').all(row.id)) {
        out.push({ line: 'osl:' + r.id, product_id: Number(r.product_id), variant_id: Number(r.variant_id) || null, qty: Number(r.qty) || 0 });
      }
    }
    return out.filter((l) => l.product_id === pid);
  }
  return [];
}

/**
 * Group A plan. Strict: doc + product + qty must leave exactly one line, and that line must name
 * an active variant of the product. Reversal twins inherit the stamp.
 */
function planGroupA(db, ids) {
  const resolved = [];
  const unresolved = [];
  const L = db.prepare('SELECT * FROM inventory_ledger WHERE id=?');
  const variantOk = db.prepare('SELECT 1 FROM product_variants WHERE id=? AND product_id=? AND COALESCE(is_default,0)=0');
  const twins = db.prepare('SELECT id, variant_id FROM inventory_ledger WHERE reversed_of=?');
  for (const id of ids) {
    const row = L.get(id);
    const base = { ledger_id: id };
    if (!row) { unresolved.push({ ...base, reason: 'ledger_missing', detail: 'ردیف در پایگاه نیست' }); continue; }
    Object.assign(base, { product_id: row.product_id, warehouse_id: row.warehouse_id, event_type: row.event_type,
      source_type: row.source_type, source_id: row.source_id, status: row.status });
    if (Number(row.variant_id) > 0) { unresolved.push({ ...base, reason: 'already_stamped', detail: `واریانت ${row.variant_id}` }); continue; }
    if (!SOURCES.has(String(row.source_type || ''))) { unresolved.push({ ...base, reason: 'source_out_of_scope', detail: row.source_type }); continue; }
    const qty = (Number(row.qty_in) || 0) + (Number(row.qty_out) || 0);
    const lines = docLines(db, row);
    const hits = lines.filter((l) => Math.abs(l.qty - qty) < QTY_EPS);
    const detail = `خطوط هم‌کالا ${lines.length}، هم‌تعداد ${hits.length}، واریانت‌ها ${[...new Set(hits.map((h) => h.variant_id || '∅'))].join('|')}`;
    if (!lines.length) { unresolved.push({ ...base, qty, candidates: 0, reason: 'no_doc_line', detail }); continue; }
    if (hits.length !== 1) { unresolved.push({ ...base, qty, candidates: hits.length, reason: hits.length ? 'multiple_lines' : 'no_qty_match', detail }); continue; }
    const v = hits[0].variant_id;
    if (!v || !variantOk.get(v, row.product_id)) { unresolved.push({ ...base, qty, candidates: 1, reason: 'line_without_variant', detail }); continue; }
    resolved.push({ kind: 'stamp', ...base, qty, variant_id: v, via: `${row.source_type}#${row.source_id} line ${hits[0].line}` });
    for (const t of twins.all(id)) {
      if (Number(t.variant_id) > 0) continue;
      resolved.push({ kind: 'stamp_twin', ledger_id: Number(t.id), product_id: row.product_id, warehouse_id: row.warehouse_id,
        event_type: 'reversal', source_type: row.source_type, source_id: row.source_id, qty, variant_id: v, via: `reversal_of ${id}` });
    }
  }
  return { resolved, unresolved };
}

/** Group B plan: production receipts of one order → VR documents. */
function planGroupB(db, orderNo) {
  const VR = require('../lib/inventory/variant-reclass');
  const docs = [];
  const unresolved = [];
  const order = db.prepare('SELECT id, order_no FROM production_orders WHERE order_no=?').get(orderNo);
  if (!order) return { docs, unresolved: [{ reason: 'order_missing', detail: orderNo }] };
  const receipts = db.prepare(`
    SELECT id, doc_no, product_id, qty, warehouse_id, variant_lines_json
    FROM production_receipts WHERE order_id=? AND status='posted' ORDER BY id
  `).all(order.id);
  for (const r of receipts) {
    const lines = parseRows(r.variant_lines_json).map((l) => ({ variant_id: Number(l.variant_id), qty: Number(l.qty) }));
    const sum = lines.reduce((a, l) => a + l.qty, 0);
    const base = { product_id: r.product_id, warehouse_id: r.warehouse_id, source_type: 'production_receipt', source_id: order.id, receipt: r.doc_no };
    if (!lines.length || Math.abs(sum - Number(r.qty)) > QTY_EPS) {
      unresolved.push({ ...base, reason: 'receipt_lines_mismatch', detail: `Σ خطوط ${sum} ≠ رسید ${r.qty}` });
      continue;
    }
    const rows = db.prepare(`
      SELECT * FROM inventory_ledger
      WHERE source_type='production_receipt' AND source_id=? AND product_id=? AND warehouse_id=?
        AND variant_id IS NULL AND status='posted' AND reversed_of IS NULL
        AND COALESCE(event_type,'')='production_receipt'
    `).all(order.id, r.product_id, r.warehouse_id);
    if (rows.length !== 1 || Math.abs(Number(rows[0].qty_in) - Number(r.qty)) > QTY_EPS) {
      unresolved.push({ ...base, reason: 'ledger_not_unique', detail: `ردیف‌های بدون واریانت ${rows.length}` });
      continue;
    }
    try {
      const { plan } = VR.planReclass(db, { ledgerId: rows[0].id, lines, basis: `${order.order_no} ${r.doc_no}` });
      docs.push(plan);
    } catch (e) {
      unresolved.push({ ...base, ledger_id: rows[0].id, reason: e.code || 'plan_error', detail: e.message });
    }
  }
  return { docs, unresolved };
}

function trialBalance(db) {
  const GM = require('../lib/gl-metrics');
  const { SQL_JL_DEBIT_RIAL, SQL_JL_CREDIT_RIAL } = require('../lib/money');
  const tot = db.prepare(`
    SELECT COALESCE(SUM(${SQL_JL_DEBIT_RIAL}),0) AS d, COALESCE(SUM(${SQL_JL_CREDIT_RIAL}),0) AS c
    FROM journal_lines jl JOIN journal_entries je ON jl.entry_id = je.id
    WHERE ${GM.JE_ALIVE} AND ${GM.JE_APPROVED}
  `).get();
  return {
    unbalanced: GM.unbalancedEntryCount(db),
    debit: Math.round(Number(tot.d) || 0),
    credit: Math.round(Number(tot.c) || 0),
    entries: db.prepare('SELECT COUNT(*) c FROM journal_entries').get().c,
    lines: db.prepare('SELECT COUNT(*) c FROM journal_lines').get().c,
  };
}

function packRecon(r) {
  const s = (r && r.summary) || {};
  const abs = ((r && r.checks) || []).reduce((n, c) => n + Math.abs(Math.round(Number(c.diff_rial) || 0)), 0);
  return { ok: s.ok || 0, warn: s.warn || 0, error: s.error || 0, info: s.info || 0,
    score: (s.error || 0) * 100 + (s.warn || 0) * 10 + (s.rounding || 0), abs_diff_rial: abs };
}

function sameTrial(a, b) {
  return a.unbalanced === b.unbalanced && a.debit === b.debit && a.credit === b.credit
    && a.entries === b.entries && a.lines === b.lines;
}

function figures(db, pids) {
  const SC = require('../lib/inventory/stock-cache');
  const out = [];
  for (const pid of pids) {
    const d = SC.deriveProductStock(db, pid);
    const code = (db.prepare('SELECT code FROM products WHERE id=?').get(pid) || {}).code || '';
    out.push({ product_id: pid, code, header: d.header,
      unattributed: JSON.stringify([...d.unattributed]), variant_warehouse: JSON.stringify([...d.variantWarehouses]) });
  }
  return out;
}

function help() {
  console.log(`حل واریانت مبهم کاردکس + تفکیک رسید تولید
  --manual-csv <path>   الزامی؛ manual.csv خروجی repair-stock-single-source (kind=${GROUP})
  --db <path>           پیش‌فرض DB_PATH یا server/crm.db
  --out <dir>           پوشهٔ resolved.csv / unresolved.csv
  --order <no>          سفارش تولید گروه B (پیش‌فرض PO-0019)
  --expect-rows <n>     دروازهٔ فاز ۰: تعداد ردیف گروه (توقف اگر برابر نباشد)
  --expect-products <n> دروازهٔ فاز ۰: تعداد کالای گروه
  --dry-run             پیش‌فرض
  --apply --i-have-go   اعمال (پس از پشتیبان در --backup-dir)`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { help(); return 0; }
  if (args.apply && !args.go) {
    console.error('اعمال نیاز به هر دو پرچم --apply و --i-have-go دارد.');
    return 2;
  }
  if (!args.manualCsv || !fs.existsSync(args.manualCsv)) {
    console.error('--manual-csv لازم است و باید وجود داشته باشد');
    return 2;
  }
  const dbPath = path.resolve(args.db || process.env.DB_PATH || path.join(__dirname, '..', 'crm.db'));
  if (!fs.existsSync(dbPath)) { console.error('پایگاه پیدا نشد: ' + dbPath); return 1; }
  if (args.apply && /prod-copy\.db$/i.test(path.basename(dbPath))) {
    console.error('اعمال روی prod-copy.db ممنوع است. ابتدا یک کپی بگیرید.');
    return 1;
  }
  process.env.DB_PATH = dbPath;
  const outDir = path.resolve(args.out || path.join(os.tmpdir(), 'stock-variant-resolve-' + Date.now()));
  fs.mkdirSync(outDir, { recursive: true });

  const group = loadGroup(args.manualCsv);
  const gate = { rows: group.ids.length, products: group.products };
  if ((args.expectRows != null && gate.rows !== args.expectRows)
    || (args.expectProducts != null && gate.products !== args.expectProducts)) {
    console.error('STOP: شمارش گروه با انتظار نمی‌خواند ' + JSON.stringify({ gate, expect: { rows: args.expectRows, products: args.expectProducts } }));
    return 3;
  }

  const Database = require('better-sqlite3');
  const db = new Database(dbPath, { readonly: !args.apply, fileMustExist: true });
  if (args.apply) db.pragma('foreign_keys = ON');

  const A = planGroupA(db, group.ids);
  const B = planGroupB(db, args.order);
  const resolvedRows = [
    ...A.resolved.map((r) => ({ ...r, group: 'A' })),
    ...B.docs.flatMap((p) => p.lines.map((l) => ({
      group: 'B', kind: 'reclass', ledger_id: p.ledger_id, product_id: p.product_id, warehouse_id: p.warehouse_id,
      event_type: p.event_type, source_type: p.source_type, source_id: p.source_id, qty: l.qty,
      variant_id: l.variant_id, amount_rial: l.amount_rial, via: p.basis,
    }))),
  ];
  const unresolvedRows = [
    ...A.unresolved.map((r) => ({ ...r, group: 'A' })),
    ...B.unresolved.map((r) => ({ ...r, group: 'B' })),
  ];
  const touched = [...new Set([...A.resolved.map((r) => Number(r.product_id)), ...B.docs.map((p) => p.product_id)])];
  const summary = {
    mode: args.apply ? 'apply' : 'dry-run',
    db: dbPath,
    out: outDir,
    phase0: gate,
    group_a: { stamps: A.resolved.filter((r) => r.kind === 'stamp').length, twin_stamps: A.resolved.filter((r) => r.kind === 'stamp_twin').length,
      unresolved: A.unresolved.length,
      unresolved_by_reason: A.unresolved.reduce((m, r) => { m[r.reason] = (m[r.reason] || 0) + 1; return m; }, {}) },
    group_b: { order: args.order, docs: B.docs.map((p) => ({ ledger_id: p.ledger_id, product_id: p.product_id, qty: p.qty,
      amount_rial: p.amount_rial, lines: p.lines.map((l) => `${l.variant_id}:${l.qty}`).join(' ') })), unresolved: B.unresolved.length },
    touched_products: touched,
  };
  const HR = ['group', 'kind', 'ledger_id', 'product_id', 'warehouse_id', 'event_type', 'source_type', 'source_id', 'qty', 'variant_id', 'amount_rial', 'via'];
  const HU = ['group', 'ledger_id', 'product_id', 'warehouse_id', 'event_type', 'source_type', 'source_id', 'status', 'qty', 'candidates', 'reason', 'detail'];
  writeCsv(path.join(outDir, 'resolved.csv'), HR, resolvedRows);
  writeCsv(path.join(outDir, 'unresolved.csv'), HU, unresolvedRows);

  const { runRecon } = require('../lib/subledger-recon');
  if (!args.apply) {
    summary.trial = trialBalance(db);
    summary.figures_before = figures(db, touched);
    db.close();
    console.log('حالت پیش‌نمایش. هیچ ردیفی نوشته نشد.');
    console.log('SUMMARY ' + JSON.stringify(summary));
    return 0;
  }

  const trialBefore = trialBalance(db);
  const reconBefore = packRecon(runRecon(db, { persist: false }));
  summary.trial_before = trialBefore;
  summary.recon_before = reconBefore;
  summary.figures_before = figures(db, touched);
  const backupDir = path.resolve(args.backupDir || process.env.STOCK_REPAIR_BACKUP_DIR || path.join(os.homedir(), 'backups'));
  fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, 'crm.db.pre-variant-resolve-' + new Date().toISOString().replace(/[:.]/g, '-'));
  await db.backup(backupPath);
  summary.backup = backupPath;

  const uid = (db.prepare("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1").get() || {}).id || null;
  const VR = require('../lib/inventory/variant-reclass');
  const SC = require('../lib/inventory/stock-cache');
  const tx = db.transaction(() => {
    VR.ensureVariantReclassSchema(db);
    const upd = db.prepare('UPDATE inventory_ledger SET variant_id=? WHERE id=? AND variant_id IS NULL');
    const audit = db.prepare('INSERT INTO audit_log (user_id, action, entity, entity_id, detail) VALUES (?,?,?,?,?)');
    let stamped = 0;
    for (const s of A.resolved) {
      if (!upd.run(s.variant_id, s.ledger_id).changes) continue;
      stamped += 1;
      audit.run(uid, 'ledger_variant_resolve', 'inventory_ledger', s.ledger_id, JSON.stringify({ variant_id: s.variant_id, via: s.via }));
    }
    const docs = B.docs.map((p) => VR.postReclass(db, {
      ledger_id: p.ledger_id,
      lines: p.lines.map((l) => ({ variant_id: l.variant_id, qty: l.qty })),
      basis: p.basis,
      reason: `تفکیک واریانت رسید تولید ${p.basis} (stock-variant-resolve)`,
      confirm: true,
    }, { id: uid }));
    for (const pid of touched) SC.rebuildStockCache(db, pid);
    const trialAfter = trialBalance(db);
    const reconAfter = packRecon(runRecon(db, { persist: false }));
    const cache = touched.map((pid) => SC.stockCacheVsLedger(db, { productId: pid }));
    const mismatch = cache.reduce((n, c) => n + c.mismatch_count, 0);
    const fail = (msg) => { const e = new Error(msg); e.trialAfter = trialAfter; e.reconAfter = reconAfter; throw e; };
    if (!sameTrial(trialBefore, trialAfter)) fail('تراز آزمایشی یا تعداد اسناد حسابداری تغییر کرد؛ تراکنش برگشت');
    if (reconAfter.score > reconBefore.score || reconAfter.error > reconBefore.error
      || reconAfter.abs_diff_rial > reconBefore.abs_diff_rial + 1) fail('تطبیق زیرسیستم‌ها بدتر شد؛ تراکنش برگشت');
    if (mismatch) fail(`کش موجودی کالاهای لمس‌شده با کاردکس نمی‌خواند (${mismatch})؛ تراکنش برگشت`);
    return { stamped, docs: docs.map((d) => ({ id: d.id, doc_no: d.doc_no, source_ledger_id: d.source_ledger_id })), trialAfter, reconAfter,
      unattributed: cache.reduce((n, c) => n + c.unattributed_count, 0) };
  });
  try {
    const r = tx();
    Object.assign(summary, { stamped: r.stamped, reclass_docs: r.docs, trial_after: r.trialAfter, recon_after: r.reconAfter,
      touched_unattributed_after: r.unattributed, figures_after: figures(db, touched) });
  } catch (e) {
    summary.rolled_back = true;
    summary.error = e.message;
    summary.trial_after = e.trialAfter || null;
    summary.recon_after = e.reconAfter || null;
    db.close();
    console.error(e.message);
    console.log('SUMMARY ' + JSON.stringify(summary));
    return 1;
  }
  db.close();
  console.log('اعمال شد. پشتیبان: ' + backupPath);
  console.log('SUMMARY ' + JSON.stringify(summary));
  return 0;
}

module.exports = { planGroupA, planGroupB, loadGroup, parseCsv, docLines };

if (require.main === module) {
  main().then((code) => process.exit(code || 0)).catch((e) => {
    console.error(e && e.stack ? e.stack : e);
    process.exit(1);
  });
}
