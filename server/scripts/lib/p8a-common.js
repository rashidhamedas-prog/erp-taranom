'use strict';
/**
 * P8a — مشترکِ اسکریپت‌های اصلاح داده (چرخهٔ تولید).
 *
 * سه حالت:
 *  - پیش‌فرض (dry-run): از DB مبدأ با هندل readonly یک کپی موقت (db.backup) می‌سازد، اصلاح را با
 *    توابع واقعی برنامه داخل یک تراکنش روی «کپی» اجرا می‌کند، اثرها را ثبت و ROLLBACK می‌کند،
 *    کپی را پاک می‌کند و CSV/خلاصه می‌نویسد. DB مبدأ هرگز برای نوشتن باز نمی‌شود.
 *  - --apply --i-have-approval --reason="..." : همان اصلاح در یک db.transaction روی DB داده‌شده +
 *    ردیف audit_log حاوی manifest (برای بازگردانی).
 *  - --undo=<audit_id> --i-have-approval --reason="..." : بازگردانی R13 همان manifest
 *    (بدون حذف فیزیکی: ردیف‌های جدید معکوس، ردیف‌های ابطال‌شده بازنشر، اسناد جدید soft-void،
 *    اسناد ابطال‌شده بازنشر با شمارهٔ جدید allocateNumber).
 *
 * ریشهٔ کد سرور: P8A_SERVER_ROOT (پیش‌فرض: server/ همین مخزن).
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = process.env.P8A_SERVER_ROOT
  ? path.resolve(process.env.P8A_SERVER_ROOT)
  : path.join(__dirname, '..', '..');
const R = (p) => require(path.join(ROOT, p));

const LIVE_DB_SUFFIX = path.join('crm-taranom', 'server', 'crm.db');

const CSV_COLUMNS = [
  'item', 'mode', 'target_table', 'target_id', 'action', 'field', 'old_value', 'new_value',
  'account_code', 'debit_rial', 'credit_rial', 'warehouse_id', 'product_id', 'qty', 'amount_rial',
  'gl_effect_rial', 'note',
];

const SIDE_TABLES = ['inventory_valuation_queue', 'inventory_value_approvals', 'notifications', 'stock_logs'];

function parseArgs(argv = process.argv.slice(2)) {
  const a = { apply: false, approval: false, reason: '', db: '', out: '', undo: null, date: '', userId: null };
  for (const s of argv) {
    if (s === '--apply') a.apply = true;
    else if (s === '--i-have-approval') a.approval = true;
    else if (s.startsWith('--reason=')) a.reason = s.slice(9).trim();
    else if (s.startsWith('--db=')) a.db = s.slice(5);
    else if (s.startsWith('--out=')) a.out = s.slice(6);
    else if (s.startsWith('--undo=')) a.undo = parseInt(s.slice(7), 10);
    else if (s.startsWith('--date=')) a.date = s.slice(7).trim();
    else if (s.startsWith('--user=')) a.userId = parseInt(s.slice(7), 10);
  }
  return a;
}

function defaultOutDir() {
  return path.join(ROOT, '..', 'reports', 'prodcycle-p8');
}

function rial(v) { return Math.round(Number(v) || 0); }
function r6(v) { return Math.round((Number(v) || 0) * 1e6) / 1e6; }

function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function writeCsv(file, rows, columns = CSV_COLUMNS) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = [columns.join(',')];
  for (const r of rows) lines.push(columns.map((c) => csvCell(r[c])).join(','));
  fs.writeFileSync(file, '\ufeff' + lines.join('\n') + '\n', 'utf8');
  return file;
}

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

// ───────────────────────── measurements ─────────────────────────

function jeLiveSql() {
  return "COALESCE(je.deleted_at,0)=0 AND COALESCE(je.status,'') NOT IN ('reversed','void','draft')";
}

/** مانده‌ی هر حساب (ریال، بدهکار−بستانکار) فقط از اسناد زنده. */
function glBalances(db) {
  const { SQL_JL_DEBIT_RIAL, SQL_JL_CREDIT_RIAL } = R('lib/money');
  const m = new Map();
  for (const r of db.prepare(`
    SELECT jl.account_code AS code,
           SUM(${SQL_JL_DEBIT_RIAL}) AS d, SUM(${SQL_JL_CREDIT_RIAL}) AS c
    FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id
    WHERE ${jeLiveSql()}
    GROUP BY jl.account_code
  `).all()) {
    m.set(String(r.code), { d: rial(r.d), c: rial(r.c) });
  }
  return m;
}

function glPrefix(bal, prefix) {
  let net = 0;
  for (const [code, v] of bal) if (code === prefix || code.startsWith(prefix)) net += v.d - v.c;
  return net;
}

/** کاردکس زنده (ردیف ابطال‌شده/معکوس حذف) به تفکیک انبار×کالا. */
function kardexMap(db) {
  const { isCancelledLedgerRow, ledgerValueDelta } = R('lib/inventory/ledger');
  const m = new Map();
  for (const r of db.prepare(`
    SELECT id, product_id, warehouse_id, qty_in, qty_out, amount_rial, status, reversed_of, event_type
    FROM inventory_ledger
  `).all()) {
    if (isCancelledLedgerRow(r)) continue;
    const k = `${r.warehouse_id || 0}|${r.product_id}`;
    const cur = m.get(k) || { qty: 0, val: 0 };
    cur.qty += (Number(r.qty_in) || 0) - (Number(r.qty_out) || 0);
    cur.val += ledgerValueDelta(r);
    m.set(k, cur);
  }
  return m;
}

function kardexWh(km, whId) {
  let qty = 0; let val = 0;
  for (const [k, v] of km) {
    if (Number(k.split('|')[0]) === Number(whId)) { qty += v.qty; val += v.val; }
  }
  return { qty: r6(qty), val: rial(val) };
}

function liveKardexOf(db, productId, warehouseId) {
  const v = kardexMap(db).get(`${warehouseId || 0}|${productId}`) || { qty: 0, val: 0 };
  return { qty: r6(v.qty), val: rial(v.val) };
}

function maxId(db, table) {
  if (!tableExists(db, table)) return null;
  return Number(db.prepare(`SELECT COALESCE(MAX(rowid),0) m FROM ${table}`).get().m) || 0;
}

function watchRows(db, watch) {
  const out = new Map();
  for (const w of watch || []) {
    if (!tableExists(db, w.table)) continue;
    const rows = db.prepare(`SELECT * FROM ${w.table} WHERE ${w.where}`).all(...(w.params || []));
    for (const r of rows) {
      const key = (w.key || ['id']).map((k) => r[k]).join(':');
      out.set(`${w.table}#${key}`, { table: w.table, key, explicit: !!w.explicit, keyCols: w.key || ['id'], row: r });
    }
  }
  return out;
}

function snapshot(db, watch) {
  return {
    ledger: new Map(db.prepare('SELECT id, status FROM inventory_ledger').all().map((r) => [r.id, r.status])),
    je: new Map(db.prepare('SELECT id, status, deleted_at FROM journal_entries').all()
      .map((r) => [r.id, { status: r.status, deleted_at: Number(r.deleted_at) || 0 }])),
    maxLedger: maxId(db, 'inventory_ledger'),
    maxJe: maxId(db, 'journal_entries'),
    side: Object.fromEntries(SIDE_TABLES.map((t) => [t, maxId(db, t)])),
    gl: glBalances(db),
    kardex: kardexMap(db),
    rows: watchRows(db, watch),
  };
}

// ───────────────────────── diff → CSV rows + manifest ─────────────────────────

function signedQty(r) { return r6((Number(r.qty_in) || 0) - (Number(r.qty_out) || 0)); }

function diff(db, item, mode, before, after) {
  const { ledgerValueDelta, isCancelledLedgerRow } = R('lib/inventory/ledger');
  const rows = [];
  const manifest = { ledger_voided: [], ledger_inserted: [], je_voided: [], je_inserted: [], updates: [] };
  const base = { item, mode };

  // 1) ledger rows voided by this run
  for (const [id, st] of after.ledger) {
    if (id > before.maxLedger) continue;
    const old = before.ledger.get(id);
    if (old === st) continue;
    const r = db.prepare('SELECT * FROM inventory_ledger WHERE id=?').get(id);
    manifest.ledger_voided.push(id);
    rows.push(Object.assign({}, base, {
      target_table: 'inventory_ledger', target_id: id, action: 'void_ledger_row', field: 'status',
      old_value: old, new_value: st, warehouse_id: r.warehouse_id, product_id: r.product_id,
      qty: -signedQty(r), amount_rial: -ledgerValueDelta(r),
      note: `${r.event_type}/${r.source_type}:${r.source_id} ${r.date} — ${r.note || ''}`.slice(0, 200),
    }));
  }
  // 2) ledger rows inserted
  for (const r of db.prepare('SELECT * FROM inventory_ledger WHERE id>? ORDER BY id').all(before.maxLedger)) {
    const cancelled = isCancelledLedgerRow(r);
    manifest.ledger_inserted.push({ id: r.id, live: !cancelled });
    rows.push(Object.assign({}, base, {
      target_table: 'inventory_ledger', target_id: r.id,
      action: cancelled ? 'insert_ledger_reversal_row' : 'insert_ledger_row',
      field: cancelled ? `reversed_of=${r.reversed_of || ''}` : '',
      warehouse_id: r.warehouse_id, product_id: r.product_id,
      qty: cancelled ? 0 : signedQty(r), amount_rial: cancelled ? 0 : ledgerValueDelta(r),
      old_value: '', new_value: `${r.event_type} in=${r.qty_in} out=${r.qty_out} amt=${r.amount_rial} date=${r.date}`,
      note: (cancelled ? '(ردیف معکوس — از کاردکس زنده حذف) ' : '') + String(r.note || '').slice(0, 180),
    }));
  }
  // 3) journal entries voided (soft-void) — GL effect = minus their lines
  for (const [id, st] of after.je) {
    if (id > before.maxJe) continue;
    const old = before.je.get(id);
    if (!old || (old.status === st.status && old.deleted_at === st.deleted_at)) continue;
    const head = db.prepare('SELECT * FROM journal_entries WHERE id=?').get(id);
    manifest.je_voided.push(id);
    rows.push(Object.assign({}, base, {
      target_table: 'journal_entries', target_id: id, action: 'void_journal', field: 'status',
      old_value: old.status, new_value: st.status,
      note: `${head.voucher_number || ''} ${head.entry_date} ${head.ref_type}:${head.ref_id} — ${String(head.description || '').slice(0, 120)}`,
    }));
    for (const l of db.prepare('SELECT * FROM journal_lines WHERE entry_id=? ORDER BY id').all(id)) {
      const d = rial(l.debit_rial || l.debit * 10);
      const c = rial(l.credit_rial || l.credit * 10);
      rows.push(Object.assign({}, base, {
        target_table: 'journal_lines', target_id: l.id, action: 'void_journal_line',
        account_code: l.account_code, debit_rial: d, credit_rial: c, gl_effect_rial: c - d,
        note: `حذف اثر سطر سند ${id} (سند soft-void، بدون حذف فیزیکی)`,
      }));
    }
  }
  // 4) journal entries inserted
  for (const head of db.prepare('SELECT * FROM journal_entries WHERE id>? ORDER BY id').all(before.maxJe)) {
    manifest.je_inserted.push(head.id);
    for (const l of db.prepare('SELECT * FROM journal_lines WHERE entry_id=? ORDER BY id').all(head.id)) {
      const d = rial(l.debit_rial);
      const c = rial(l.credit_rial);
      rows.push(Object.assign({}, base, {
        target_table: 'journal_lines', target_id: `je${head.id}/${l.id}`, action: 'insert_journal_line',
        account_code: l.account_code, debit_rial: d, credit_rial: c, gl_effect_rial: d - c,
        note: `${head.voucher_number || ''} ${head.entry_date} ${head.ref_type}:${head.ref_id} — ${String(head.description || '').slice(0, 100)}`,
      }));
    }
  }
  // 5) watched rows: field changes
  for (const [k, b] of before.rows) {
    const a = after.rows.get(k);
    if (!a) continue;
    for (const f of Object.keys(b.row)) {
      if (['sync_seq', 'version', 'updated_at', 'updated_by', 'reviewed_at', 'last_ledger_id'].includes(f)) continue;
      const ov = b.row[f];
      const nv = a.row[f];
      if (ov === nv || (typeof ov === 'number' && typeof nv === 'number' && Math.abs(ov - nv) < 1e-9)) continue;
      if (b.explicit) manifest.updates.push({ table: b.table, keyCols: b.keyCols, key: b.key, field: f, old: ov, new: nv });
      rows.push(Object.assign({}, base, {
        target_table: b.table, target_id: b.key, action: b.explicit ? 'update_field' : 'derived_change',
        field: f, old_value: ov, new_value: nv,
        product_id: b.row.product_id != null ? b.row.product_id : (b.table === 'products' ? b.row.id : ''),
        warehouse_id: b.row.warehouse_id != null ? b.row.warehouse_id : '',
      }));
    }
  }
  for (const [k, a] of after.rows) {
    if (before.rows.has(k)) continue;
    if (a.explicit) manifest.updates.push({ table: a.table, keyCols: a.keyCols, key: a.key, field: '*insert*', old: null, new: a.row });
    rows.push(Object.assign({}, base, {
      target_table: a.table, target_id: a.key, action: 'derived_insert', new_value: JSON.stringify(a.row).slice(0, 200),
    }));
  }
  // 6) summaries
  const gl = [];
  const codes = new Set([...before.gl.keys(), ...after.gl.keys()]);
  for (const c of [...codes].sort()) {
    const b = before.gl.get(c) || { d: 0, c: 0 };
    const a = after.gl.get(c) || { d: 0, c: 0 };
    const delta = (a.d - a.c) - (b.d - b.c);
    if (!delta) continue;
    gl.push({ account_code: c, before: b.d - b.c, after: a.d - a.c, delta });
    rows.push(Object.assign({}, base, {
      target_table: 'GL', action: 'gl_delta', account_code: c,
      debit_rial: delta > 0 ? delta : 0, credit_rial: delta < 0 ? -delta : 0, gl_effect_rial: delta,
      old_value: b.d - b.c, new_value: a.d - a.c, note: 'خالص اثر روی مانده (بدهکار−بستانکار)',
    }));
  }
  const kd = [];
  const keys = new Set([...before.kardex.keys(), ...after.kardex.keys()]);
  for (const k of [...keys].sort()) {
    const b = before.kardex.get(k) || { qty: 0, val: 0 };
    const a = after.kardex.get(k) || { qty: 0, val: 0 };
    const dq = r6(a.qty - b.qty);
    const dv = rial(a.val - b.val);
    if (!dq && !dv) continue;
    const [wh, pid] = k.split('|').map(Number);
    kd.push({ warehouse_id: wh, product_id: pid, qty_before: r6(b.qty), qty_after: r6(a.qty), val_before: rial(b.val), val_after: rial(a.val), dq, dv });
    rows.push(Object.assign({}, base, {
      target_table: 'KARDEX', action: 'kardex_delta', warehouse_id: wh, product_id: pid, qty: dq, amount_rial: dv,
      old_value: `${r6(b.qty)} / ${rial(b.val)}`, new_value: `${r6(a.qty)} / ${rial(a.val)}`,
      note: 'کاردکس زنده (مقدار / ارزش ریال)',
    }));
  }
  const side = {};
  for (const t of SIDE_TABLES) {
    if (before.side[t] == null) continue;
    side[t] = (after.side[t] || 0) - (before.side[t] || 0);
  }
  return { rows, manifest, gl, kardex: kd, side };
}

// ───────────────────────── DB open helpers ─────────────────────────

function isLivePath(p) {
  return path.resolve(p).endsWith(LIVE_DB_SUFFIX);
}

async function makeCopy(srcPath) {
  const Database = R('node_modules/better-sqlite3');
  const src = new Database(srcPath, { readonly: true, fileMustExist: true });
  const copy = path.join(os.tmpdir(), `p8a-copy-${process.pid}-${Date.now()}.db`);
  await src.backup(copy);
  src.close();
  return copy;
}

function removeCopy(p) {
  for (const s of ['', '-wal', '-shm', '-journal']) {
    try { fs.rmSync(p + s, { force: true }); } catch (_) { /* ignore */ }
  }
}

/** هندل برنامه روی همین مسیر (هندل کش‌شدهٔ قبلی بسته می‌شود تا هرگز روی DB دیگری اجرا نشود). */
function openAppDb(dbPath) {
  process.env.DB_PATH = dbPath;
  process.env.ERP_TEST_ISOLATION = '1';
  if (!process.env.SYNC_ROLE) process.env.SYNC_ROLE = 'central';
  const m = R('db');
  m.closeDB();
  const db = m.getDB();
  if (path.resolve(m.getDBPath()) !== path.resolve(dbPath)) throw new Error(`هندل DB روی مسیر اشتباه باز شد: ${m.getDBPath()}`);
  return db;
}

function pickUser(db, explicit) {
  if (explicit) return explicit;
  const u = db.prepare("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1").get();
  return u ? u.id : 1;
}

function writeAudit(db, { userId, action, detail }) {
  const r = db.prepare(`
    INSERT INTO audit_log (user_id, action, entity, entity_id, detail, ip_address, user_agent)
    VALUES (?,?,?,?,?,?,?)
  `).run(userId || null, action, 'p8a_data_correction', null, JSON.stringify(detail), '', 'p8a-script');
  return Number(r.lastInsertRowid);
}

// ───────────────────────── run (dry-run / apply / undo) ─────────────────────────

function summarize(item, title, res, extra) {
  const lines = [];
  lines.push(`# ${item} — ${title}`);
  lines.push('');
  lines.push('## اثر دفتر کل (ریال، بدهکار−بستانکار)');
  lines.push('| حساب | قبل | بعد | تغییر |');
  lines.push('|---|---:|---:|---:|');
  for (const g of res.gl) lines.push(`| ${g.account_code} | ${g.before.toLocaleString('en-US')} | ${g.after.toLocaleString('en-US')} | ${g.delta.toLocaleString('en-US')} |`);
  if (!res.gl.length) lines.push('| — | | | بدون اثر GL |');
  lines.push('');
  lines.push('## اثر کاردکس زنده به تفکیک انبار');
  const byWh = new Map();
  for (const k of res.kardex) {
    const cur = byWh.get(k.warehouse_id) || { dq: 0, dv: 0 };
    cur.dq += k.dq; cur.dv += k.dv;
    byWh.set(k.warehouse_id, cur);
  }
  lines.push('| انبار | تغییر مقدار | تغییر ارزش (ریال) |');
  lines.push('|---|---:|---:|');
  for (const [wh, v] of byWh) lines.push(`| ${wh} | ${r6(v.dq)} | ${rial(v.dv).toLocaleString('en-US')} |`);
  if (!byWh.size) lines.push('| — | | بدون اثر کاردکس |');
  lines.push('');
  lines.push('## به تفکیک انبار×کالا');
  lines.push('| انبار | کالا | مقدار قبل→بعد | ارزش قبل→بعد |');
  lines.push('|---|---|---|---|');
  for (const k of res.kardex) lines.push(`| ${k.warehouse_id} | ${k.product_id} | ${k.qty_before} → ${k.qty_after} | ${k.val_before.toLocaleString('en-US')} → ${k.val_after.toLocaleString('en-US')} |`);
  lines.push('');
  if (Object.keys(res.side || {}).length) {
    lines.push('## ردیف‌های جانبی جدید');
    for (const [t, n] of Object.entries(res.side)) lines.push(`- ${t}: ${n}`);
    lines.push('');
  }
  if (extra) {
    lines.push('## جزئیات اجرا');
    lines.push('```json');
    lines.push(JSON.stringify(extra, null, 2));
    lines.push('```');
  }
  return lines.join('\n') + '\n';
}

/**
 * spec: { key, file, title, defaults, watch(db,cfg) → [...], run(db, ctx) → result }
 */
async function runItem(spec, opts = {}) {
  const args = Object.assign(parseArgs(), opts.args || {});
  const outDir = args.out || defaultOutDir();
  const srcPath = path.resolve(args.db || process.env.DB_PATH || path.join(ROOT, 'crm.db'));
  const mode = args.undo ? 'undo' : (args.apply ? 'apply' : 'dry-run');

  if (mode !== 'dry-run') {
    if (!args.approval || !args.reason) {
      throw new Error('apply/undo نیازمند --i-have-approval و --reason="..." است');
    }
    if (isLivePath(srcPath) && process.env.P8A_ALLOW_LIVE !== '1') {
      throw new Error('apply/undo روی DB تولید فقط با P8A_ALLOW_LIVE=1 (بعد از تأیید مالک و بکاپ) مجاز است');
    }
  }

  const prevDbPath = process.env.DB_PATH;
  let workPath = srcPath;
  let copy = null;
  if (mode === 'dry-run') {
    copy = await makeCopy(srcPath);
    workPath = copy;
  }
  const db = openAppDb(workPath);
  const userId = pickUser(db, args.userId);
  const { todayJalali } = R('jalali');
  const cfg = Object.assign({}, spec.defaults || {}, opts.cfg || {});
  const ctx = {
    cfg, userId, mode, reason: args.reason || 'P8a dry-run', date: args.date || todayJalali(), R,
  };

  let result;
  let res;
  let auditId = null;
  try {
    if (mode === 'undo') {
      const watch = [];
      const before = snapshot(db, watch);
      db.transaction(() => {
        result = undoManifest(db, args.undo, ctx);
        res = diff(db, spec.key, mode, before, snapshot(db, watch));
        auditId = writeAudit(db, { userId, action: `p8a_undo_${spec.key}`, detail: { reason: ctx.reason, undo_of: args.undo, manifest: res.manifest } });
      })();
    } else {
      const watch = spec.watch ? spec.watch(db, cfg) : [];
      const before = snapshot(db, watch);
      if (mode === 'apply') {
        db.transaction(() => {
          result = spec.run(db, ctx);
          res = diff(db, spec.key, mode, before, snapshot(db, watch));
          auditId = writeAudit(db, {
            userId, action: `p8a_apply_${spec.key}`,
            detail: { reason: ctx.reason, item: spec.key, result, manifest: res.manifest },
          });
        })();
      } else {
        db.exec('BEGIN');
        try {
          result = spec.run(db, ctx);
          res = diff(db, spec.key, mode, before, snapshot(db, watch));
        } finally {
          db.exec('ROLLBACK');
        }
      }
    }
  } finally {
    try { R('db').closeDB(); } catch (_) { /* ignore */ }
    if (copy) removeCopy(copy);
    if (prevDbPath == null) delete process.env.DB_PATH; else process.env.DB_PATH = prevDbPath;
  }

  const tag = mode === 'dry-run' ? '' : `-${mode}`;
  const csvFile = path.join(outDir, `${spec.file}${tag}.csv`);
  if (!opts.noWrite) {
    writeCsv(csvFile, res.rows);
    fs.writeFileSync(path.join(outDir, `${spec.file}${tag}-summary.md`),
      summarize(spec.key, spec.title, res, Object.assign({ mode, audit_id: auditId, source_db: path.basename(srcPath) }, result || {})), 'utf8');
  }
  return { mode, result, res, csvFile, auditId };
}

// ───────────────────────── generic R13 undo ─────────────────────────

function undoManifest(db, auditId, ctx) {
  const a = db.prepare('SELECT * FROM audit_log WHERE id=?').get(auditId);
  if (!a || !String(a.action || '').startsWith('p8a_apply_')) throw new Error(`audit ${auditId} یک اجرای P8a نیست`);
  const done = db.prepare("SELECT id FROM audit_log WHERE action LIKE 'p8a_undo_%' AND detail LIKE ?").get(`%"undo_of":${auditId},%`);
  if (done) throw new Error(`audit ${auditId} قبلاً بازگردانی شده (audit ${done.id})`);
  const m = JSON.parse(a.detail).manifest;
  const { reverseInventoryMovement, postInventoryMovement, isWarehouseOnlyRow } = R('lib/inventory/ledger');
  const { reverseJournalEntry } = R('lib/void-journal');
  const { postToLedger } = R('lib/ledger');
  const tag = ` [بازگردانی P8a audit#${auditId}]`;
  const out = { ledger_reversed: 0, ledger_reposted: 0, je_voided: 0, je_reposted: 0, fields_restored: 0 };

  // new live journals → soft-void
  for (const id of [...m.je_inserted].reverse()) {
    if (reverseJournalEntry(db, id, { userId: ctx.userId, reason: ctx.reason + tag })) out.je_voided += 1;
  }
  // new live ledger rows → reverse (newest first)
  for (const it of [...m.ledger_inserted].reverse()) {
    if (!it.live) continue;
    const row = db.prepare('SELECT * FROM inventory_ledger WHERE id=?').get(it.id);
    if (!row || row.status === 'reversed') continue;
    reverseInventoryMovement(db, it.id, { createdBy: ctx.userId, date: row.date, keepDate: true, note: `معکوس ${row.tx_no || row.id}${tag}` });
    out.ledger_reversed += 1;
  }
  // voided ledger rows → re-post an identical live row
  for (const id of m.ledger_voided) {
    const o = db.prepare('SELECT * FROM inventory_ledger WHERE id=?').get(id);
    if (!o) continue;
    const valueOnly = !(Number(o.qty_in) > 0) && !(Number(o.qty_out) > 0);
    const st = String(o.source_type || '');
    const alignSeed = st === 'opening_inventory' || st === 'stock_reconcile' || o.event_type === 'opening';
    postInventoryMovement(db, {
      eventType: o.event_type, productId: o.product_id, warehouseId: o.warehouse_id,
      qtyIn: Number(o.qty_in) || 0, qtyOut: Number(o.qty_out) || 0,
      unitCostRial: o.unit_cost_rial, amountRial: o.amount_rial,
      sourceType: o.source_type, sourceId: o.source_id, batchId: o.batch_id, variantId: o.variant_id || null,
      date: o.date, note: String(o.note || '') + tag, createdBy: ctx.userId,
      skipStock: alignSeed || valueOnly, valueOnly, warehouseOnly: isWarehouseOnlyRow(o),
      updateAvg: false, allowZeroCost: true, allowNegative: true,
    });
    out.ledger_reposted += 1;
  }
  // voided journals → re-post same lines with a new voucher number
  for (const id of m.je_voided) {
    const head = db.prepare('SELECT * FROM journal_entries WHERE id=?').get(id);
    const lines = db.prepare('SELECT * FROM journal_lines WHERE entry_id=? ORDER BY id').all(id).map((l) => ({
      code: l.account_code, name: l.account_name,
      debit: rial(l.debit_rial) / 10, credit: rial(l.credit_rial) / 10,
      description: l.description, detail_account_id: l.detail_account_id, cost_center_id: l.cost_center_id,
    }));
    postToLedger(db, {
      sourceType: head.ref_type, sourceId: head.ref_id, date: head.entry_date,
      description: String(head.description || '').replace(/ \[ابطال\].*$/, '') + tag,
      createdBy: ctx.userId, lines, costCenterId: head.cost_center_id || null, skipCcPolicy: true,
    });
    out.je_reposted += 1;
  }
  // explicit field updates → restore
  for (const u of [...m.updates].reverse()) {
    if (u.field === '*insert*') continue;
    const where = u.keyCols.map((k) => `${k}=?`).join(' AND ');
    const keyVals = String(u.key).split(':');
    db.prepare(`UPDATE ${u.table} SET ${u.field}=? WHERE ${where}`).run(u.old, ...keyVals);
    out.fields_restored += 1;
  }
  return out;
}

module.exports = {
  ROOT, R, CSV_COLUMNS, parseArgs, writeCsv, runItem, snapshot, diff, glBalances, glPrefix,
  kardexMap, kardexWh, liveKardexOf, makeCopy, removeCopy, openAppDb, pickUser, writeAudit,
  undoManifest, defaultOutDir, rial, r6, isLivePath, summarize,
};
