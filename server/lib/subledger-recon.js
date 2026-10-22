'use strict';
/**
 * Subledger ↔ GL reconciliation (v521).
 *
 * Every check compares an operational book (kardex, party books, bank/cash leaves,
 * GRNI receipts, asset register …) with the live journal and returns
 *   { code, name, status, gl_rial, sub_rial, diff_rial, rows_count, sample, fixable, note }.
 * status: ok | warn (finding) | rounding (v522: only toman↔rial rounding artefacts) |
 *         info (expected / by design) | error (check itself failed).
 * Money: INTEGER rial. Read-only except applyFix / reverseFix (atomic, audited).
 *
 * v522 zero tolerance: every non-zero difference is reported. A difference D is
 * classified `rounding` only when 0 < |D| ≤ B, where B (rounding_bound_rial) is the
 * sum of documented conversion residues of the rows behind the comparison:
 *   - journal line side: |debit_rial − round(debit_toman×10)| (and the credit twin) for
 *     lines carrying both columns that disagree by 1…9 rial (less than one toman);
 *   - subledger side: |amount − round(amount)| of fractional-rial rows (kardex, buckets,
 *     party books, asset register).
 * B = 0 ⇒ any non-zero D is a real difference (warn). See INV-VAL-ADR-008 §v522.
 */

const { acct } = require('./coa-map');
const { SQL_JL_DEBIT_RIAL, SQL_JL_CREDIT_RIAL, rialToLedger } = require('./money');

const SAMPLE_SIZE = 20;
const DEAD_STATUSES = ['reversed', 'void', 'voided', 'cancelled', 'canceled', 'deleted', 'rejected'];
const DEAD_SQL = `(${DEAD_STATUSES.map((s) => `'${s}'`).join(',')})`;
const JE_LIVE = "COALESCE(je.deleted_at,0)=0 AND COALESCE(je.status,'posted') NOT IN ('reversed','void')";

const CHECKS = [
  ['inventory_vs_gl', 'تطبیق ارزش موجودی انبار با دفتر کل'],
  ['movements_without_je', 'گردش‌های انبار بدون سند حسابداری'],
  ['documents_without_je', 'اسناد عملیاتی بدون سند حسابداری'],
  ['je_on_dead_document', 'سند حسابداری زنده روی سند باطل‌شده'],
  ['document_amount_vs_je', 'مغایرت مبلغ سند عملیاتی با سند حسابداری'],
  ['party_control', 'تطبیق دفاتر اشخاص با حساب‌های کنترل'],
  ['cash_bank', 'تطبیق صندوق و بانک با دفتر کل'],
  ['grni', 'کالای دریافتی فاکتورنشده (GRNI)'],
  ['fixed_assets', 'تطبیق ثبت دارایی‌های ثابت با دفتر کل'],
  ['suspense_accounts', 'مانده حساب‌های موقت/معلق'],
  ['closed_period_changes', 'تغییر اسناد پس از بستن سال مالی'],
];
const CHECK_NAMES = new Map(CHECKS);

// ─── schema ────────────────────────────────────────────────────────────────
function tableExists(db, name) {
  try {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  } catch (_) {
    return false;
  }
}

function columns(db, table) {
  try {
    return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  } catch (_) {
    return new Set();
  }
}

function addColumn(db, table, column, definition) {
  if (!tableExists(db, table)) return;
  if (!columns(db, table).has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

/** Central-only tables + link columns. Idempotent; parent calls it from db.js initDB. */
function ensureReconSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS subledger_recon_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      as_of TEXT,
      result_json TEXT,
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS subledger_recon_fixes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL,
      target TEXT,
      amount_rial INTEGER NOT NULL DEFAULT 0,
      je_id INTEGER,
      status TEXT NOT NULL DEFAULT 'posted',
      reason TEXT DEFAULT '',
      detail_json TEXT,
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      reversed_at INTEGER,
      reversed_by INTEGER
    );
    CREATE TABLE IF NOT EXISTS fixed_asset_revaluations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asset_id INTEGER NOT NULL,
      date TEXT,
      old_cost_rial INTEGER NOT NULL DEFAULT 0,
      new_cost_rial INTEGER NOT NULL DEFAULT 0,
      surplus_rial INTEGER NOT NULL DEFAULT 0,
      je_id INTEGER,
      status TEXT NOT NULL DEFAULT 'posted',
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      reversed_at INTEGER,
      reversed_by INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_fa_reval_asset ON fixed_asset_revaluations(asset_id, status);
  `);
  addColumn(db, 'journal_entries', 'reversed_by_je_id', 'INTEGER');
  addColumn(db, 'journal_entries', 'reverses_je_id', 'INTEGER');
  addColumn(db, 'fixed_assets', 'acq_je_id', 'INTEGER');
  addColumn(db, 'fixed_assets', 'acq_funding', 'TEXT');
  addColumn(db, 'fixed_assets', 'acq_supplier_id', 'INTEGER');
  addColumn(db, 'fixed_assets', 'acq_release_je_id', 'INTEGER');
  addColumn(db, 'rep_advances', 'status', "TEXT DEFAULT 'posted'");
  addColumn(db, 'rep_advances', 'reversed_at', 'INTEGER');
  addColumn(db, 'rep_advances', 'reversed_by', 'INTEGER');
  addColumn(db, 'rep_expenses', 'reversed_at', 'INTEGER');
  addColumn(db, 'rep_expenses', 'reversed_by', 'INTEGER');
}

const _ensured = new WeakSet();
function ensureReconSchemaOnce(db) {
  if (_ensured.has(db)) return;
  ensureReconSchema(db);
  _ensured.add(db);
}

// ─── helpers ───────────────────────────────────────────────────────────────
function setting(db, key, fallback = '') {
  try {
    const r = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
    return r && r.value != null ? String(r.value) : fallback;
  } catch (_) {
    return fallback;
  }
}

function writeAudit(db, userId, action, entity, entityId, detail) {
  try {
    db.prepare('INSERT INTO audit_log (user_id,action,entity,entity_id,detail) VALUES (?,?,?,?,?)')
      .run(userId || null, action, entity, entityId || null,
        typeof detail === 'string' ? detail : JSON.stringify(detail || {}));
  } catch (_) { /* audit must not break a fix */ }
}

function err(message, status, code, extra) {
  const e = new Error(message);
  e.status = status || 400;
  if (code) e.code = code;
  if (extra) Object.assign(e, extra);
  return e;
}

function dateFilter(col, dateTo) {
  return dateTo ? ` AND ${col} <= ?` : '';
}

/** debit−credit (rial) of live lines on `code` and all its hierarchical children. */
function glBalance(db, codes, dateTo) {
  const list = [...new Set((codes || []).map((c) => String(c || '').trim()).filter(Boolean))];
  if (!list.length) return 0;
  const conds = list.map(() => '(jl.account_code = ? OR jl.account_code LIKE ?)').join(' OR ');
  const params = [];
  for (const c of list) params.push(c, `${c}%`);
  if (dateTo) params.push(dateTo);
  const r = db.prepare(`
    SELECT COALESCE(SUM(${SQL_JL_DEBIT_RIAL} - ${SQL_JL_CREDIT_RIAL}), 0) AS bal
    FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
    WHERE ${JE_LIVE} AND (${conds})${dateFilter('je.entry_date', dateTo)}
  `).get(...params);
  return Math.round(Number(r && r.bal) || 0);
}

/** debit−credit of one posting leaf: exact code or legacy `code-…` sub-accounts (bank-recon rule). */
function glLeafBalance(db, code, dateTo) {
  const params = [code, `${code}-%`];
  if (dateTo) params.push(dateTo);
  const r = db.prepare(`
    SELECT COALESCE(SUM(${SQL_JL_DEBIT_RIAL} - ${SQL_JL_CREDIT_RIAL}), 0) AS bal
    FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
    WHERE ${JE_LIVE} AND (jl.account_code = ? OR jl.account_code LIKE ?)${dateFilter('je.entry_date', dateTo)}
  `).get(...params);
  return Math.round(Number(r && r.bal) || 0);
}

function codeOf(db, key) {
  try { return String(acct(db, key).code); } catch (_) { return ''; }
}

// ─── v522 rounding classification ──────────────────────────────────────────
const SQL_SIDE_RESIDUE = (r, t) => `(CASE WHEN COALESCE(jl.${r},0)<>0 AND COALESCE(jl.${t},0)<>0
    AND jl.${r} <> jl.${t} AND ABS(jl.${r} - ROUND(jl.${t}*10)) BETWEEN 1 AND 9
    THEN ABS(jl.${r} - ROUND(jl.${t}*10)) ELSE 0 END)`;
const SQL_JL_ROUND_RESIDUE = `(${SQL_SIDE_RESIDUE('debit_rial', 'debit')} + ${SQL_SIDE_RESIDUE('credit_rial', 'credit')})`;

/** Σ toman↔rial residues of live lines on `codes` (hierarchical) — or exact leaf with leaf:true. */
function glRoundingBound(db, codes, dateTo, { leaf = false } = {}) {
  const list = [...new Set((codes || []).map((c) => String(c || '').trim()).filter(Boolean))];
  if (!list.length) return 0;
  const conds = list.map(() => '(jl.account_code = ? OR jl.account_code LIKE ?)').join(' OR ');
  const params = [];
  for (const c of list) params.push(c, leaf ? `${c}-%` : `${c}%`);
  if (dateTo) params.push(dateTo);
  try {
    const r = db.prepare(`
      SELECT COALESCE(SUM(${SQL_JL_ROUND_RESIDUE}), 0) AS b
      FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
      WHERE ${JE_LIVE} AND (${conds})${dateFilter('je.entry_date', dateTo)}
    `).get(...params);
    return Number(r && r.b) || 0;
  } catch (_) {
    return 0;
  }
}

/** Residue of one journal line row carrying dr/cr (rial) and dt/ct (toman). */
function lineResidue(l) {
  let s = 0;
  for (const [r, t] of [[l.dr, l.dt], [l.cr, l.ct]]) {
    const R = Number(r) || 0;
    const T = Number(t) || 0;
    if (!R || !T || R === T) continue;
    const d = Math.abs(R - Math.round(T * 10));
    if (d >= 1 && d <= 9) s += d;
  }
  return s;
}

function frac(v) {
  const n = Number(v) || 0;
  return Math.abs(n - Math.round(n));
}

/** 'ok' (D=0) | 'rounding' (0<|D|≤B) | 'real'. Zero tolerance: B=0 ⇒ real. */
function classifyDiff(diff, bound) {
  const d = Math.round(Number(diff) || 0);
  if (!d) return 'ok';
  const b = Math.ceil(Number(bound) || 0);
  return b > 0 && Math.abs(d) <= b ? 'rounding' : 'real';
}

const STATUS_RANK = { ok: 0, info: 1, rounding: 2, warn: 3, error: 4 };
function worstStatus(...list) {
  let w = 'ok';
  for (const s of list) if ((STATUS_RANK[s] || 0) > (STATUS_RANK[w] || 0)) w = s;
  return w;
}

/** Map a classification to a row/check status. */
function statusOfClass(cls) {
  return cls === 'real' ? 'warn' : cls;
}

/** Live-JE index for fast "does source X have a live voucher" checks. */
function buildJeIndex(db) {
  const keys = new Set();
  const ids = new Set();
  const hasLink = columns(db, 'journal_entries').has('reversed_by_je_id');
  const rows = db.prepare(`
    SELECT je.id, je.ref_type, je.ref_id${hasLink ? ', je.reversed_by_je_id' : ''}
    FROM journal_entries je WHERE ${JE_LIVE}
  `).all();
  const neutralized = new Set();
  for (const r of rows) {
    if (hasLink && r.reversed_by_je_id) neutralized.add(Number(r.id));
  }
  for (const r of rows) {
    if (neutralized.has(Number(r.id))) continue;
    ids.add(Number(r.id));
    if (r.ref_type && r.ref_id != null) keys.add(`${r.ref_type}|${r.ref_id}`);
  }
  return { keys, ids, has: (t, id) => keys.has(`${t}|${id}`), live: (id) => ids.has(Number(id)) };
}

function ctxFor(db, opts = {}) {
  const ctx = { db, dateTo: opts.dateTo || opts.date_to || '' };
  let jeIndex = null;
  ctx.je = () => { if (!jeIndex) jeIndex = buildJeIndex(db); return jeIndex; };
  return ctx;
}

function result(code, fields) {
  const rows = fields.rows || [];
  return {
    code,
    name: CHECK_NAMES.get(code) || code,
    status: fields.status || 'ok',
    sub_status: fields.sub_status || null,
    gl_rial: fields.gl_rial != null ? Math.round(fields.gl_rial) : null,
    sub_rial: fields.sub_rial != null ? Math.round(fields.sub_rial) : null,
    diff_rial: fields.diff_rial != null ? Math.round(fields.diff_rial) : null,
    rounding_rial: Math.round(Number(fields.rounding_rial) || 0),
    rounding_bound_rial: Math.ceil(Number(fields.rounding_bound_rial) || 0),
    rows_count: rows.length,
    sample: rows.slice(0, SAMPLE_SIZE),
    fixable: !!fields.fixable,
    note: fields.note || '',
    rows,
  };
}

// ─── inventory valuation ───────────────────────────────────────────────────
const WIP_STAGING_EVENTS = new Set(['cutting_pack']);

function signedLedgerAmount(r) {
  const amt = Math.round(Number(r.amount_rial) || 0);
  if ((Number(r.qty_in) || 0) > 0) return amt;
  if ((Number(r.qty_out) || 0) > 0) return -amt;
  return amt;
}

/** Live kardex rows: posted, not the posted twin of a reversed original, not WIP staging. */
function liveLedgerRows(db, dateTo, extraWhere = '', extraParams = []) {
  if (!tableExists(db, 'inventory_ledger')) return [];
  const params = [...extraParams];
  if (dateTo) params.push(dateTo);
  return db.prepare(`
    SELECT l.* FROM inventory_ledger l
    LEFT JOIN inventory_ledger o ON o.id = l.reversed_of
    WHERE l.status='posted'
      AND NOT (l.reversed_of IS NOT NULL AND o.status='reversed')
      ${extraWhere}${dateFilter("COALESCE(l.date,'')", dateTo)}
  `).all(...params).filter((r) => {
    const et = String(r.event_type || '');
    if (WIP_STAGING_EVENTS.has(et)) return false;
    if (et === 'reversal' && WIP_STAGING_EVENTS.has(String(r.source_type || ''))) return false;
    return true;
  });
}

function inventoryAccountFor(db, warehouseId) {
  return require('./inventory/ledger').inventoryAccountForWarehouse(db, warehouseId || null);
}

function warehouseMeta(db) {
  const out = new Map();
  if (!tableExists(db, 'warehouses')) return out;
  const cols = columns(db, 'warehouses');
  const rows = db.prepare(`
    SELECT id, name${cols.has('warehouse_type') ? ', warehouse_type' : ''}${cols.has('inventory_system') ? ', inventory_system' : ''}${cols.has('kind') ? ', kind' : ''}
    FROM warehouses
  `).all();
  for (const w of rows) {
    out.set(Number(w.id), {
      id: Number(w.id),
      name: w.name || '',
      type: w.warehouse_type || '',
      periodic: String(w.inventory_system || '').toLowerCase() === 'periodic',
      wip: w.warehouse_type === 'wip' || w.kind === 'wip',
    });
  }
  return out;
}

function isPeriodicWh(meta, warehouseId) {
  const w = warehouseId ? meta.get(Number(warehouseId)) : null;
  return !!(w && w.periodic);
}

/** Per-warehouse subledger value (rial). Prefers inventory_valuation_buckets for "as of today". */
function warehouseValues(db, dateTo) {
  const today = require('../jalali').todayJalali();
  const useBuckets = tableExists(db, 'inventory_valuation_buckets') && (!dateTo || dateTo >= today);
  const values = new Map();
  let source = 'inventory_ledger';
  if (useBuckets) {
    source = 'inventory_valuation_buckets';
    for (const r of db.prepare(`
      SELECT warehouse_id, COALESCE(SUM(value_rial),0) AS v FROM inventory_valuation_buckets GROUP BY warehouse_id
    `).all()) {
      values.set(r.warehouse_id == null ? 0 : Number(r.warehouse_id), Math.round(Number(r.v) || 0));
    }
  } else {
    for (const r of liveLedgerRows(db, dateTo)) {
      const k = r.warehouse_id == null ? 0 : Number(r.warehouse_id);
      values.set(k, (values.get(k) || 0) + signedLedgerAmount(r));
    }
  }
  const qtyAvg = new Map();
  if (tableExists(db, 'warehouse_stock') && tableExists(db, 'products')) {
    for (const r of db.prepare(`
      SELECT ws.warehouse_id, COALESCE(SUM(ws.qty * COALESCE(p.average_cost_rial,0)),0) AS v
      FROM warehouse_stock ws JOIN products p ON p.id = ws.product_id
      GROUP BY ws.warehouse_id
    `).all()) {
      qtyAvg.set(Number(r.warehouse_id), Math.round(Number(r.v) || 0));
    }
  }
  const fracByWh = new Map();
  const addFrac = (sql) => {
    try {
      for (const r of db.prepare(sql).all()) {
        const k = r.warehouse_id == null ? 0 : Number(r.warehouse_id);
        fracByWh.set(k, (fracByWh.get(k) || 0) + (Number(r.f) || 0));
      }
    } catch (_) { /* optional columns */ }
  };
  if (useBuckets) {
    addFrac('SELECT warehouse_id, SUM(ABS(value_rial - ROUND(value_rial))) AS f FROM inventory_valuation_buckets GROUP BY warehouse_id');
  }
  if (tableExists(db, 'inventory_ledger')) {
    addFrac("SELECT warehouse_id, SUM(ABS(amount_rial - ROUND(amount_rial))) AS f FROM inventory_ledger WHERE status='posted' GROUP BY warehouse_id");
  }
  return { values, qtyAvg, source, fracByWh };
}

function inventoryAccountKeys() {
  return ['coa_finished_goods', 'coa_inventory', 'coa_raw_materials', 'coa_wip',
    'coa_packaging_materials', 'coa_scrap_inventory', 'coa_subcontract_inventory'];
}

function computeInventoryVsGl(ctx) {
  const { db, dateTo } = ctx;
  const meta = warehouseMeta(db);
  const { values, qtyAvg, source, fracByWh } = warehouseValues(db, dateTo);
  const wipCode = codeOf(db, 'coa_wip');
  const accounts = new Map();
  const ensureAcc = (code, name) => {
    if (!accounts.has(code)) {
      accounts.set(code, { code, name, sub: 0, periodicSub: 0, subFrac: 0, warehouses: [] });
    }
    return accounts.get(code);
  };
  for (const key of inventoryAccountKeys()) {
    try { const a = acct(db, key); ensureAcc(String(a.code), a.name); } catch (_) { /* unknown key */ }
  }
  const whIds = new Set([...meta.keys(), ...values.keys()]);
  const whRows = [];
  for (const wid of whIds) {
    const a = inventoryAccountFor(db, wid || null);
    const acc = ensureAcc(String(a.code), a.name);
    const m = meta.get(wid) || { id: wid || null, name: wid ? `#${wid}` : 'بدون انبار', periodic: false, wip: false };
    const val = values.get(wid) || 0;
    const row = {
      level: 'warehouse',
      id: `wh:${wid || 0}`,
      account_code: acc.code,
      warehouse_id: wid || null,
      warehouse_name: m.name,
      inventory_system: m.periodic ? 'periodic' : 'perpetual',
      sub_rial: val,
      stock_x_avg_rial: qtyAvg.get(wid) || 0,
    };
    if (m.periodic) acc.periodicSub += val; else { acc.sub += val; acc.subFrac += fracByWh.get(wid) || 0; }
    acc.warehouses.push(row);
    whRows.push(row);
  }
  const accRows = [];
  let glTotal = 0, subTotal = 0, worst = 'ok', roundingTotal = 0, boundTotal = 0;
  for (const acc of accounts.values()) {
    const gl = glBalance(db, [acc.code], dateTo);
    const sub = acc.sub;
    const diff = gl - sub;
    const isWip = acc.code === wipCode;
    const periodicOnly = acc.warehouses.length > 0 && acc.warehouses.every((w) => w.inventory_system === 'periodic');
    const bound = diff ? glRoundingBound(db, [acc.code], dateTo) + acc.subFrac : 0;
    const cls = classifyDiff(diff, bound);
    let status = statusOfClass(cls);
    let note = cls === 'rounding' ? 'اختلاف گرد کردن تومان↔ریال' : '';
    if (cls === 'real' && (isWip || periodicOnly)) {
      status = 'info';
      note = isWip ? 'کالای در جریان ساخت با سفارش تولید ارزش‌گذاری می‌شود' : 'انبار ادواری — ارزش در بستن دوره ثبت می‌شود';
    }
    if (!gl && !sub && !acc.periodicSub) continue;
    accRows.push({
      level: 'account', id: acc.code, account_code: acc.code, account_name: acc.name,
      gl_rial: gl, sub_rial: sub, periodic_sub_rial: acc.periodicSub, diff_rial: diff, status, diff_class: cls,
      rounding_bound_rial: Math.ceil(bound), note,
      warehouses: acc.warehouses.length,
    });
    worst = worstStatus(worst, status);
    if (status === 'rounding') roundingTotal += diff;
    if (status !== 'info') { glTotal += gl; subTotal += sub; boundTotal += bound; }
  }
  accRows.sort((a, b) => Math.abs(b.diff_rial) - Math.abs(a.diff_rial));
  return { accRows, whRows, glTotal, subTotal, worst, source, roundingTotal, boundTotal };
}

function checkInventoryVsGl(ctx) {
  const r = computeInventoryVsGl(ctx);
  return result('inventory_vs_gl', {
    status: r.worst,
    gl_rial: r.glTotal,
    sub_rial: r.subTotal,
    diff_rial: r.glTotal - r.subTotal,
    rounding_rial: r.roundingTotal,
    rounding_bound_rial: r.boundTotal,
    rows: [...r.accRows, ...r.whRows],
    fixable: r.accRows.some((a) => a.status === 'warn'),
    note: `منبع ارزش زیرسیستم: ${r.source}`,
  });
}

// ─── R2 movements without JE ───────────────────────────────────────────────
const SOURCE_REF_TYPES = {
  invoice: ['invoice_cogs'],
  sales_return: ['sales_return', 'sales_return_cogs', 'sales_returns'],
  sales_returns: ['sales_return', 'sales_return_cogs', 'sales_returns'],
  purchase: ['purchase', 'goods_receipt'],
  purchase_return: ['purchase_return'],
  landed_cost: ['landed_cost'],
  stocktaking: ['stocktaking'],
  manual_adjustment: ['inventory_adjust', 'manual_adjustment'],
  inventory_adjust: ['inventory_adjust'],
  stock_adjust: ['stock_adjust'],
  consignment: ['consignment', 'consignment_ship', 'consignment_cogs', 'consignment_purchase', 'consignment_shortage'],
  fabric_roll: ['fabric_roll', 'fabric_roll_edit'],
  warehouse_grni_reval: ['warehouse_grni_reval', 'warehouse_receipt_grni', 'purchase'],
};
const ALIGNMENT_SOURCES = new Set(['stock_reconcile', 'opening_inventory', 'opening']);
const MANUAL_SOURCES = new Set(['', 'manual', 'manual_adjustment', 'inventory_adjust', 'stock_adjust']);
const PRODUCTION_PREFIXES = ['production', 'cutting', 'order_cost', 'portal_convert'];

function productionLike(st) {
  return PRODUCTION_PREFIXES.some((p) => st.startsWith(p));
}

function computeMovementsWithoutJe(ctx) {
  const { db, dateTo } = ctx;
  const je = ctx.je();
  const meta = warehouseMeta(db);
  const cogsOn = setting(db, 'feature_cogs_voucher', '0') === '1';
  const prodKeys = new Set();
  for (const k of je.keys) {
    const [t] = k.split('|');
    if (productionLike(t)) prodKeys.add(k.slice(t.length + 1));
  }
  const movesByLedger = new Map();
  const movesById = new Map();
  if (tableExists(db, 'warehouse_moves')) {
    const wmCols = columns(db, 'warehouse_moves');
    const sel = ['id', 'type', 'from_warehouse_id', 'to_warehouse_id']
      .concat(['ledger_id', 'je_id', 'doc_id'].filter((c) => wmCols.has(c)));
    for (const m of db.prepare(`SELECT ${sel.join(', ')} FROM warehouse_moves`).all()) {
      movesById.set(Number(m.id), m);
      if (m.ledger_id != null) movesByLedger.set(Number(m.ledger_id), m);
    }
  }
  const docJe = new Map();
  if (tableExists(db, 'warehouse_docs')) {
    for (const d of db.prepare('SELECT id, je_id FROM warehouse_docs').all()) docJe.set(Number(d.id), d.je_id);
  }
  const accCache = new Map();
  const accOf = (wid) => {
    const k = wid == null ? 0 : Number(wid);
    if (!accCache.has(k)) accCache.set(k, String(inventoryAccountFor(db, wid || null).code));
    return accCache.get(k);
  };
  const isTransferSt = (st) => st === 'warehouse_move' || st === 'warehouse_transfer' || st === 'transfer';
  const rows = [];
  const unmatched = [];
  const softMatched = [];
  const orphanTransfer = [];
  const intraTransfers = new Set();
  for (const r of liveLedgerRows(db, dateTo)) {
    const amt = signedLedgerAmount(r);
    if (!amt) continue;
    const st = String(r.source_type || '');
    if (ALIGNMENT_SOURCES.has(st) || String(r.event_type || '') === 'opening') continue;
    if (isPeriodicWh(meta, r.warehouse_id)) continue;
    if (r.je_id && je.live(r.je_id)) continue;
    let ok = false;
    let soft = false;
    let reason = 'no_live_je';
    if (isTransferSt(st)) {
      // Outbound leg is warehouse_moves.ledger_id; both legs carry source_id = move id.
      const m = movesByLedger.get(Number(r.id)) || (r.source_id != null ? movesById.get(Number(r.source_id)) : null);
      const jeId = m ? (m.je_id || docJe.get(Number(m.doc_id))) : null;
      if (jeId && je.live(jeId)) ok = true;
      else if (m && (m.type === 'transfer' || st === 'warehouse_transfer')) {
        if (accOf(m.from_warehouse_id) === accOf(m.to_warehouse_id)) { ok = true; intraTransfers.add(`m${m.id}`); }
      } else if (!m) {
        orphanTransfer.push({ r, amt, st });
        continue;
      }
    } else if (st === 'invoice' || st === 'sales_return' || st === 'sales_returns') {
      if (!cogsOn) ok = true;
      else ok = (SOURCE_REF_TYPES[st] || []).some((t) => je.has(t, r.source_id));
    } else if (productionLike(st)) {
      // Strong: a JE of the same source type. Soft: any production JE with that ref id
      // (ids collide across production tables — soft matches may still pair net-zero below).
      ok = r.source_id != null && prodKeys.has(String(r.source_id));
      soft = ok && !je.has(st, r.source_id);
      reason = 'no_live_production_je';
    } else if (MANUAL_SOURCES.has(st)) {
      ok = je.has('inventory_adjust', r.id) || je.has('stock_adjust', r.id);
    } else {
      const cands = SOURCE_REF_TYPES[st] || [st];
      ok = r.source_id != null && cands.some((t) => je.has(t, r.source_id));
    }
    if (r.je_id && !je.live(r.je_id)) { ok = false; soft = false; reason = 'je_dead'; }
    if (ok) {
      if (soft) softMatched.push({ r, amt, st });
      continue;
    }
    unmatched.push({ r, amt, st, reason });
  }

  // Transfer legs without a move row: same source + product, same inventory account, net zero → OK.
  const tGroups = new Map();
  for (const x of orphanTransfer) {
    const k = `${x.st}|${x.r.source_id == null ? `l${x.r.id}` : x.r.source_id}|${x.r.product_id}`;
    if (!tGroups.has(k)) tGroups.set(k, []);
    tGroups.get(k).push(x);
  }
  for (const [k, g] of tGroups.entries()) {
    const accs = new Set(g.map((x) => accOf(x.r.warehouse_id)));
    const net = g.reduce((s, x) => s + x.amt, 0);
    if (g.length >= 2 && accs.size === 1 && net === 0) { intraTransfers.add(k); continue; }
    for (const x of g) unmatched.push({ ...x, reason: 'transfer_without_move' });
  }

  // Net-zero pairs: an unmatched row cancelled by an opposite row of the same product, inventory
  // account and family (e.g. a production issue and its return, both without vouchers).
  const qtyOf = (r) => (Number(r.qty_in) || 0) - (Number(r.qty_out) || 0);
  const family = (st) => (productionLike(st) ? 'production' : st);
  const consumed = new Set();
  const netZero = [];
  const findPartner = (u, pool) => pool.find((c) => !consumed.has(c.r.id) && c.r.id !== u.r.id
    && Number(c.r.product_id) === Number(u.r.product_id)
    && accOf(c.r.warehouse_id) === accOf(u.r.warehouse_id)
    && family(c.st) === family(u.st)
    && c.amt === -u.amt
    && Math.abs(qtyOf(c.r) + qtyOf(u.r)) < 1e-9);
  const ordered = [...unmatched].sort((a, b) => a.r.id - b.r.id);
  for (const u of ordered) {
    if (consumed.has(u.r.id)) continue;
    const p = findPartner(u, ordered) || findPartner(u, softMatched);
    if (!p) continue;
    consumed.add(u.r.id);
    consumed.add(p.r.id);
    netZero.push([u, p]);
  }

  let total = 0;
  for (const u of unmatched) {
    if (consumed.has(u.r.id)) continue;
    const r = u.r;
    total += u.amt;
    rows.push({
      id: Number(r.id), tx_no: r.tx_no, date: r.date, event_type: r.event_type,
      source_type: u.st, source_id: r.source_id, product_id: r.product_id, warehouse_id: r.warehouse_id,
      amount_rial: u.amt, je_id: r.je_id || null, reason: u.reason, status: 'warn',
      fixable: MANUAL_SOURCES.has(u.st),
    });
  }
  for (const [a, b] of netZero) {
    for (const x of [a, b]) {
      if (!unmatched.includes(x)) continue;
      const r = x.r;
      rows.push({
        id: Number(r.id), tx_no: r.tx_no, date: r.date, event_type: r.event_type,
        source_type: x.st, source_id: r.source_id, product_id: r.product_id, warehouse_id: r.warehouse_id,
        amount_rial: x.amt, je_id: r.je_id || null, reason: 'net_zero_pair', status: 'info',
        pair_ledger_id: Number((x === a ? b : a).r.id), fixable: false,
      });
    }
  }
  return { rows, total, intraTransfers: intraTransfers.size, netZeroPairs: netZero.length };
}

function checkMovementsWithoutJe(ctx) {
  const r = computeMovementsWithoutJe(ctx);
  const cogsOn = setting(ctx.db, 'feature_cogs_voucher', '0') === '1';
  const real = r.rows.filter((x) => x.status !== 'info');
  return result('movements_without_je', {
    status: real.length ? 'warn' : (r.rows.length ? 'info' : 'ok'),
    sub_rial: r.total,
    gl_rial: 0,
    diff_rial: -r.total,
    rows: [...real, ...r.rows.filter((x) => x.status === 'info')],
    fixable: real.some((x) => x.fixable),
    note: [
      cogsOn ? '' : 'سند بهای تمام‌شده فاکتور غیرفعال است — گردش فروش/مرجوعی بررسی نشد',
      r.intraTransfers ? `${r.intraTransfers} انتقال بین انبارهای هم‌حساب — نیاز به سند ندارد` : '',
      r.netZeroPairs ? `${r.netZeroPairs} جفت گردش بی‌سند که یکدیگر را خنثی می‌کنند (خالص صفر) — اطلاع` : '',
    ].filter(Boolean).join(' | '),
  });
}

// ─── R3 documents without JE ───────────────────────────────────────────────
function liveDocs(db, table, { amountCols, dateCol = 'date', extraWhere = '' }) {
  if (!tableExists(db, table)) return [];
  const cols = columns(db, table);
  const where = [];
  if (cols.has('status')) where.push(`COALESCE(status,'posted') NOT IN ${DEAD_SQL}`);
  if (cols.has('deleted_at')) where.push('COALESCE(deleted_at,0)=0');
  if (extraWhere) where.push(extraWhere);
  const present = amountCols.filter((c) => cols.has(c));
  const amtExpr = present.length > 1
    ? `COALESCE(${present.map((c) => `NULLIF(${c},0)`).join(', ')}, 0)`
    : (present[0] || '0');
  const sel = ['id', `${amtExpr} AS amount`];
  if (cols.has(dateCol)) sel.push(`${dateCol} AS date`);
  for (const c of ['num', 'cust_id', 'supplier_id', 'type', 'invoice_id', 'rep_id', 'code', 'acq_je_id', 'status', 'journal_id', 'je_id', 'payroll_record_id']) {
    if (cols.has(c) && !sel.includes(c)) sel.push(c);
  }
  return db.prepare(`
    SELECT ${sel.join(', ')} FROM ${table}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
  `).all();
}

function computeDocumentsWithoutJe(ctx) {
  const { db, dateTo } = ctx;
  const je = ctx.je();
  const rows = [];
  const specs = [
    { doc: 'invoice', table: 'invoices', amountCols: ['final_rial', 'final'], refs: ['invoice'], extraWhere: "type IN ('normal','final')" },
    { doc: 'purchase', table: 'purchase_invoices', amountCols: ['final_rial', 'final'], refs: ['purchase'] },
    { doc: 'sales_return', table: 'sales_returns', amountCols: ['amount_rial', 'amount'], refs: ['sales_return', 'sales_returns'] },
    { doc: 'purchase_return', table: 'purchase_returns', amountCols: ['amount_rial', 'amount'], refs: ['purchase_return'] },
    { doc: 'settlement', table: 'settlements', amountCols: ['amount_rial', 'amount'], refs: ['settlement', 'settlements', 'cheque_in', 'opening_cheque', 'pos_receipt'] },
    { doc: 'supplier_payment', table: 'supplier_payments', amountCols: ['amount_rial', 'amount'], refs: ['supplier_payment'] },
    { doc: 'expense', table: 'expenses', amountCols: ['amount_rial', 'amount'], refs: ['expense', 'expenses'] },
    // payroll_payment JEs carry ref_id = payroll_record_id; the payment row stores journal_id.
    { doc: 'payroll_payment', table: 'payroll_payments', amountCols: ['amount_rial', 'net_rial', 'amount'], refs: ['payroll_payment'], altRef: (d) => [['payroll_payment', d.payroll_record_id]] },
    { doc: 'rep_expense', table: 'rep_expenses', amountCols: ['amount'], refs: ['rep_expense'], extraWhere: "status='approved'" },
    { doc: 'rep_advance', table: 'rep_advances', amountCols: ['amount'], refs: ['rep_advance'] },
  ];
  // POS (کارتخوان) settlements: the voucher is the pos_receipt JE (pos_receipts.settlement_id → journal_id).
  const posJeBySettlement = new Map();
  if (tableExists(db, 'pos_receipts')) {
    const pc = columns(db, 'pos_receipts');
    if (pc.has('settlement_id') && pc.has('journal_id')) {
      for (const p of db.prepare(`
        SELECT id, settlement_id, journal_id FROM pos_receipts
        WHERE settlement_id IS NOT NULL${pc.has('status') ? " AND COALESCE(status,'open') NOT IN ('reversed','void')" : ''}
      `).all()) {
        const k = Number(p.settlement_id);
        if (!posJeBySettlement.has(k)) posJeBySettlement.set(k, []);
        posJeBySettlement.get(k).push({ receipt_id: p.id, journal_id: p.journal_id });
      }
    }
  }
  const matchedBy = (s, d) => {
    if (s.refs.some((t) => je.has(t, d.id))) return 'ref';
    for (const col of ['journal_id', 'je_id']) {
      if (d[col]) return je.live(d[col]) ? col : null;
    }
    if (s.altRef && s.altRef(d).some(([t, id]) => id != null && je.has(t, id))) return 'alt_ref';
    if (s.doc === 'settlement') {
      const recs = posJeBySettlement.get(Number(d.id)) || [];
      if (recs.some((p) => (p.journal_id && je.live(p.journal_id)) || je.has('pos_receipt', p.receipt_id))) return 'pos_receipt';
    }
    return null;
  };
  for (const s of specs) {
    let docs;
    try { docs = liveDocs(db, s.table, s); } catch (_) { continue; }
    for (const d of docs) {
      if (!(Math.round(Number(d.amount) || 0) > 0)) continue;
      if (dateTo && d.date && d.date > dateTo) continue;
      if (matchedBy(s, d)) continue;
      rows.push({ id: `${s.doc}:${d.id}`, doc_type: s.doc, doc_id: d.id, num: d.num || null, date: d.date || null, amount_rial: Math.round(Number(d.amount) || 0), severity: 'warn' });
    }
  }
  if (tableExists(db, 'fixed_assets')) {
    const cols = columns(db, 'fixed_assets');
    if (cols.has('acq_je_id')) {
      for (const a of db.prepare("SELECT id, code, cost_rial, purchase_date, acq_je_id FROM fixed_assets WHERE status='active'").all()) {
        if (a.acq_je_id && je.live(a.acq_je_id)) continue;
        rows.push({
          id: `fixed_asset:${a.id}`, doc_type: 'fixed_asset', doc_id: a.id, num: a.code, date: a.purchase_date,
          amount_rial: Math.round(Number(a.cost_rial) || 0),
          severity: a.acq_je_id ? 'warn' : 'info',
        });
      }
    }
  }
  return rows;
}

function checkDocumentsWithoutJe(ctx) {
  const rows = computeDocumentsWithoutJe(ctx);
  const warn = rows.filter((r) => r.severity === 'warn');
  return result('documents_without_je', {
    status: warn.length ? 'warn' : (rows.length ? 'info' : 'ok'),
    sub_rial: rows.reduce((s, r) => s + r.amount_rial, 0),
    gl_rial: 0,
    diff_rial: -warn.reduce((s, r) => s + r.amount_rial, 0),
    rows,
    fixable: false,
    note: rows.length && !warn.length ? 'فقط دارایی‌های قدیمی بدون سند تحصیل (ثبت قبل از v521)' : '',
  });
}

// ─── R4 JE on dead document ────────────────────────────────────────────────
/** ref_type → { table, dead(row, je) , missingIsDead } */
function deadDocRules(db) {
  const st = (r) => String((r && r.status) || 'posted').toLowerCase();
  const statusDead = (r) => DEAD_STATUSES.includes(st(r));
  const inv = (r) => !r || Number(r.deleted_at || 0) > 0 || statusDead(r) || !['normal', 'final'].includes(String(r.type || ''));
  return {
    invoice: { table: 'invoices', dead: inv, missingIsDead: true },
    invoice_cogs: { table: 'invoices', dead: inv, missingIsDead: true },
    invoice_ar_reclass: { table: 'invoices', dead: inv, missingIsDead: false },
    commission_accrual_invoice: { table: 'invoices', dead: inv, missingIsDead: false },
    purchase: { table: 'purchase_invoices', dead: statusDead, missingIsDead: true },
    sales_return: { table: 'sales_returns', dead: statusDead, missingIsDead: true },
    purchase_return: { table: 'purchase_returns', dead: statusDead, missingIsDead: true },
    settlement: { table: 'settlements', dead: statusDead, missingIsDead: true },
    supplier_payment: { table: 'supplier_payments', dead: statusDead, missingIsDead: true },
    rep_expense: { table: 'rep_expenses', dead: (r) => st(r) !== 'approved', missingIsDead: true },
    rep_advance: { table: 'rep_advances', dead: statusDead, missingIsDead: true },
    stocktaking: { table: 'stocktaking_sessions', dead: (r) => st(r) !== 'adjusted', missingIsDead: true },
    landed_cost: { table: 'landed_cost_docs', dead: statusDead, missingIsDead: false },
    cost_revaluation: { table: 'cost_revaluations', dead: statusDead, missingIsDead: false },
    production_receipt: { table: 'production_receipts', dead: statusDead, missingIsDead: false },
    warehouse_receipt_batch: { table: 'warehouse_moves', dead: statusDead, missingIsDead: false },
    warehouse_issue_batch: { table: 'warehouse_moves', dead: statusDead, missingIsDead: false },
    warehouse_transfer_batch: { table: 'warehouse_moves', dead: statusDead, missingIsDead: false },
    warehouse_receipt_grni: { table: 'warehouse_moves', dead: statusDead, missingIsDead: false },
    inventory_adjust: { table: 'inventory_ledger', dead: statusDead, missingIsDead: true },
    stock_adjust: { table: 'inventory_ledger', dead: statusDead, missingIsDead: true },
    inventory_recon_adjust: { table: 'subledger_recon_fixes', dead: statusDead, missingIsDead: true },
    fixed_asset_acquisition: { table: 'fixed_assets', dead: (r, je) => !r || r.status === 'inactive' || Number(r.acq_je_id || 0) !== Number(je.id), missingIsDead: true },
    fixed_asset_dispose: { table: 'fixed_assets', dead: (r, je) => !r || Number(r.dispose_je_id || 0) !== Number(je.id), missingIsDead: true },
    fixed_asset_opening_recon: { table: 'subledger_recon_fixes', dead: statusDead, missingIsDead: true },
    fixed_asset_opening_release: { table: 'fixed_assets', dead: (r, je) => !r || Number(r.acq_release_je_id || 0) !== Number(je.id), missingIsDead: true },
  };
}

function computeJeOnDeadDocument(ctx) {
  const { db, dateTo } = ctx;
  const rules = deadDocRules(db);
  const types = Object.keys(rules);
  const hasLink = columns(db, 'journal_entries').has('reversed_by_je_id');
  const ph = types.map(() => '?').join(',');
  const params = [...types];
  if (dateTo) params.push(dateTo);
  const jes = db.prepare(`
    SELECT je.id, je.entry_date, je.ref_type, je.ref_id, je.description, je.total_debit_rial
    FROM journal_entries je
    WHERE ${JE_LIVE} AND je.ref_type IN (${ph})${hasLink ? ' AND je.reversed_by_je_id IS NULL' : ''}
      ${dateFilter('je.entry_date', dateTo)}
    ORDER BY je.id
  `).all(...params);
  const cache = new Map();
  const getDoc = (table, id) => {
    const k = `${table}|${id}`;
    if (cache.has(k)) return cache.get(k);
    let row = null;
    if (tableExists(db, table)) {
      try { row = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id) || null; } catch (_) { row = null; }
    }
    cache.set(k, row);
    return row;
  };
  const rows = [];
  for (const j of jes) {
    const rule = rules[j.ref_type];
    if (!rule || !tableExists(db, rule.table) || j.ref_id == null) continue;
    const doc = getDoc(rule.table, j.ref_id);
    if (!doc && !rule.missingIsDead) continue;
    if (doc && !rule.dead(doc, j)) continue;
    if (!doc && !rule.missingIsDead) continue;
    let amount = Math.round(Number(j.total_debit_rial) || 0);
    if (!amount) {
      const s = db.prepare(`SELECT COALESCE(SUM(${SQL_JL_DEBIT_RIAL}),0) d FROM journal_lines jl WHERE jl.entry_id=?`).get(j.id);
      amount = Math.round(Number(s && s.d) || 0);
    }
    rows.push({
      id: Number(j.id), je_id: Number(j.id), entry_date: j.entry_date, ref_type: j.ref_type, ref_id: j.ref_id,
      description: j.description || '', amount_rial: amount,
      doc_state: doc ? String(doc.status || (Number(doc.deleted_at || 0) > 0 ? 'deleted' : 'posted')) : 'missing',
    });
  }
  return rows;
}

function checkJeOnDeadDocument(ctx) {
  const rows = computeJeOnDeadDocument(ctx);
  return result('je_on_dead_document', {
    status: rows.length ? 'warn' : 'ok',
    gl_rial: rows.reduce((s, r) => s + r.amount_rial, 0),
    sub_rial: 0,
    diff_rial: rows.reduce((s, r) => s + r.amount_rial, 0),
    rows,
    fixable: rows.length > 0,
  });
}

// ─── R5 document amount vs JE ──────────────────────────────────────────────
function jeLinesFor(db, refType, refId) {
  return db.prepare(`
    SELECT jl.id AS line_id, jl.account_code AS code, ${SQL_JL_DEBIT_RIAL} AS d, ${SQL_JL_CREDIT_RIAL} AS c, je.id AS je_id,
      jl.debit_rial AS dr, jl.credit_rial AS cr, jl.debit AS dt, jl.credit AS ct
    FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
    WHERE ${JE_LIVE} AND je.ref_type=? AND je.ref_id=?
  `).all(refType, refId);
}

const AR_RECLASS_REF_TYPES = ['ar_control_reclass'];
/** Live control→leaf reclass lines whose voucher points at journal line `lineId`. */
function reclassLinesFor(db, lineId) {
  const out = [];
  for (const t of AR_RECLASS_REF_TYPES) out.push(...jeLinesFor(db, t, lineId));
  return out;
}

/** Push a document-vs-JE row when the diff is non-zero, labelled rounding|real. */
function pushAmountRow(rows, fields, lines, docRaw) {
  const diff = Math.round(fields.je_rial - fields.doc_rial);
  if (!diff) return;
  const bound = (lines || []).reduce((s, l) => s + lineResidue(l), 0) + frac(docRaw);
  const cls = classifyDiff(diff, bound);
  rows.push({ ...fields, diff_rial: diff, diff_class: cls, status: statusOfClass(cls), rounding_bound_rial: Math.ceil(bound) });
}

function computeDocumentAmountVsJe(ctx) {
  const { db, dateTo } = ctx;
  const rows = [];
  const je = ctx.je();
  if (tableExists(db, 'invoices')) {
    const { receivableAcct } = require('./customer-books');
    const cols = columns(db, 'invoices');
    const amt = cols.has('final_rial') ? 'COALESCE(NULLIF(final_rial,0), final)' : 'final';
    const params = dateTo ? [dateTo] : [];
    const invs = db.prepare(`
      SELECT id, num, cust_id, date, ${amt} AS final FROM invoices
      WHERE type IN ('normal','final') AND COALESCE(deleted_at,0)=0
        ${cols.has('status') ? `AND COALESCE(status,'posted') NOT IN ${DEAD_SQL}` : ''}${dateFilter('date', dateTo)}
    `).all(...params);
    const control = codeOf(db, 'coa_receivable');
    for (const inv of invs) {
      if (!je.has('invoice', inv.id)) continue;
      let recv = '';
      try { recv = String(receivableAcct(db, inv.cust_id).code || ''); } catch (_) { recv = control; }
      const all = jeLinesFor(db, 'invoice', inv.id);
      const lines = all.filter((l) => String(l.code) === recv);
      let ar = lines.reduce((s, l) => s + Number(l.d || 0), 0);
      // v390/v424: a control-account (1103) invoice line later moved to the customer leaf by an
      // ar_control_reclass voucher (ref_id = that journal line id) counts toward the leaf.
      const reclassJes = [];
      if (recv && control && recv !== control) {
        for (const cl of all.filter((l) => String(l.code) === control && l.line_id)) {
          for (const rl of reclassLinesFor(db, cl.line_id).filter((l) => String(l.code) === recv)) {
            ar += Number(rl.d || 0) - Number(rl.c || 0);
            lines.push(rl);
            if (!reclassJes.includes(rl.je_id)) reclassJes.push(rl.je_id);
          }
        }
      }
      const docAmt = Math.round(Number(inv.final) || 0);
      pushAmountRow(rows, {
        id: `invoice:${inv.id}`, doc_type: 'invoice', doc_id: inv.id, num: inv.num, date: inv.date, metric: 'ar_debit',
        doc_rial: docAmt, je_rial: Math.round(ar), ...(reclassJes.length ? { reclass_je_ids: reclassJes } : {}),
      }, lines, inv.final);
    }
    if (setting(db, 'feature_cogs_voucher', '0') === '1' && tableExists(db, 'inventory_ledger')) {
      const mv = new Map();
      for (const r of liveLedgerRows(db, dateTo, "AND l.source_type='invoice'")) {
        const k = Number(r.source_id);
        mv.set(k, (mv.get(k) || 0) - signedLedgerAmount(r));
      }
      for (const inv of invs) {
        if (!je.has('invoice_cogs', inv.id)) continue;
        const lines = jeLinesFor(db, 'invoice_cogs', inv.id);
        const cogs = lines.reduce((s, l) => s + Number(l.d || 0), 0);
        const movRaw = mv.get(Number(inv.id)) || 0;
        const movement = Math.round(movRaw);
        pushAmountRow(rows, { id: `invoice_cogs:${inv.id}`, doc_type: 'invoice_cogs', doc_id: inv.id, num: inv.num, date: inv.date, metric: 'cogs_vs_movements', doc_rial: movement, je_rial: Math.round(cogs) }, lines, movRaw);
      }
    }
  }
  if (tableExists(db, 'purchase_invoices')) {
    const cols = columns(db, 'purchase_invoices');
    const params = dateTo ? [dateTo] : [];
    const purchases = db.prepare(`
      SELECT id, num, supplier_id, date, final FROM purchase_invoices
      WHERE 1=1 ${cols.has('status') ? `AND COALESCE(status,'posted') NOT IN ${DEAD_SQL}` : ''}${dateFilter('date', dateTo)}
    `).all(...params);
    const payControl = codeOf(db, 'coa_payable');
    for (const p of purchases) {
      if (!je.has('purchase', p.id)) continue;
      let pay = payControl;
      try {
        const s = db.prepare('SELECT coa_code FROM suppliers WHERE id=?').get(p.supplier_id);
        if (s && s.coa_code) pay = String(s.coa_code);
      } catch (_) { /* keep control */ }
      const lines = jeLinesFor(db, 'purchase', p.id).filter((l) => String(l.code) === pay);
      const ap = lines.reduce((s, l) => s + Number(l.c || 0), 0);
      const docAmt = Math.round(Number(p.final) || 0);
      pushAmountRow(rows, { id: `purchase:${p.id}`, doc_type: 'purchase', doc_id: p.id, num: p.num, date: p.date, metric: 'ap_credit', doc_rial: docAmt, je_rial: Math.round(ap) }, lines, p.final);
    }
  }
  return rows;
}

/** Check-level status + rounding totals from rows carrying `status` / `diff_rial`. */
function rowsRollup(rows) {
  let status = 'ok', rounding = 0, bound = 0;
  for (const r of rows) {
    status = worstStatus(status, r.status || 'warn');
    if (r.status === 'rounding') rounding += Math.round(Number(r.diff_rial != null ? r.diff_rial : r.balance_rial) || 0);
    bound += Number(r.rounding_bound_rial) || 0;
  }
  return { status, rounding, bound };
}

function checkDocumentAmountVsJe(ctx) {
  const rows = computeDocumentAmountVsJe(ctx);
  const roll = rowsRollup(rows);
  return result('document_amount_vs_je', {
    status: roll.status,
    rounding_rial: roll.rounding,
    rounding_bound_rial: roll.bound,
    gl_rial: rows.reduce((s, r) => s + r.je_rial, 0),
    sub_rial: rows.reduce((s, r) => s + r.doc_rial, 0),
    diff_rial: rows.reduce((s, r) => s + r.diff_rial, 0),
    rows,
    fixable: false,
  });
}

// ─── R6 party control ──────────────────────────────────────────────────────
function checkPartyControl(ctx) {
  const { db, dateTo } = ctx;
  const controls = ['coa_receivable', 'coa_payable', 'coa_misc_persons'].map((k) => codeOf(db, k)).filter(Boolean);
  const gl = glBalance(db, controls, dateTo);
  const rows = [];
  let sub = 0;
  let subFrac = 0;
  let notes = [];
  if (!dateTo) {
    try {
      const pb = require('./party-books');
      const map = pb.partySignedBalanceDetailMap(db);
      for (const [pid, info] of map.entries()) {
        const leaves = (info.leaves && info.leaves.length) ? info.leaves
          : (info.coa_code ? [{ coa_code: info.coa_code, balance: info.balance, source: info.source }] : []);
        for (const lf of leaves) {
          if (!lf.coa_code || !controls.some((c) => String(lf.coa_code).startsWith(c))) continue;
          sub += Math.round(Number(lf.balance) || 0);
          subFrac += frac(lf.balance);
        }
        for (const lf of leaves) {
          if (!lf.coa_code || !lf.source || lf.source === 'opening') continue;
          const g = pb.glSignedForCoa(db, lf.coa_code);
          if (g == null) continue;
          const d = Math.round(Number(lf.balance) || 0) - Math.round(g);
          if (!d) continue;
          const bound = glRoundingBound(db, [lf.coa_code], dateTo, { leaf: true }) + frac(lf.balance) + frac(g);
          const cls = classifyDiff(d, bound);
          rows.push({ id: `party:${pid}:${lf.coa_code}`, kind: 'party', party_id: pid, coa_code: lf.coa_code, book_rial: Math.round(Number(lf.balance) || 0), gl_rial: Math.round(g), diff_rial: d, diff_class: cls, status: statusOfClass(cls), rounding_bound_rial: Math.ceil(bound), source: lf.source || '' });
        }
      }
    } catch (e) {
      notes.push(`party-books: ${e.message}`);
    }
  } else {
    notes.push('مانده دفاتر اشخاص فقط در تاریخ روز محاسبه می‌شود');
  }
  try {
    const cb = require('./customer-books');
    const list = cb.customerBooksMismatchList(db, { asOf: dateTo || undefined, limit: 1000 });
    for (const r of list.rows || []) {
      if (rows.some((x) => x.coa_code === r.coa_code)) continue;
      const d = Math.round(Number(r.delta) || 0);
      if (!d) continue;
      const bound = r.coa_code ? glRoundingBound(db, [r.coa_code], dateTo, { leaf: true }) + frac(r.ledger) + frac(r.gl) : 0;
      const cls = classifyDiff(d, bound);
      rows.push({ id: `customer:${r.id}`, kind: 'customer', customer_id: r.id, name: r.biz, coa_code: r.coa_code, book_rial: r.ledger, gl_rial: r.gl, diff_rial: d, diff_class: cls, status: statusOfClass(cls), rounding_bound_rial: Math.ceil(bound) });
    }
  } catch (e) {
    notes.push(`customer-books: ${e.message}`);
  }
  const diff = dateTo ? null : gl - sub;
  const roll = rowsRollup(rows);
  let status = roll.status;
  let rounding = roll.rounding;
  let aggCls = 'ok';
  if (diff) {
    aggCls = classifyDiff(diff, glRoundingBound(db, controls, dateTo) + subFrac);
    status = worstStatus(status, statusOfClass(aggCls));
    if (aggCls === 'rounding' && !rows.length) rounding = diff;
  }
  return result('party_control', {
    status, gl_rial: gl, sub_rial: dateTo ? null : sub, diff_rial: diff, rows, fixable: false,
    rounding_rial: rounding, rounding_bound_rial: roll.bound,
    note: [
      aggCls === 'real' ? 'بخشی از مانده روی حساب کنترل (بدون تفصیلی) ثبت شده است' : '',
      aggCls === 'rounding' ? 'اختلاف کل فقط گرد کردن تومان↔ریال است' : '',
      ...notes,
    ].filter(Boolean).join(' | '),
  });
}

// ─── R7 cash / bank ────────────────────────────────────────────────────────
function checkCashBank(ctx) {
  const { db, dateTo } = ctx;
  const rows = [];
  const cashCode = codeOf(db, 'coa_cash_default') || '1101';
  const bankCode = codeOf(db, 'coa_bank_default') || '1102';
  let sub = 0;
  if (tableExists(db, 'banks')) {
    const { computeBookBalance } = require('./bank-recon');
    const cols = columns(db, 'banks');
    for (const b of db.prepare(`SELECT id, name${cols.has('coa_code') ? ', coa_code' : ''} FROM banks`).all()) {
      const bal = computeBookBalance(db, b.id, dateTo || '');
      sub += bal;
      rows.push({ id: `bank:${b.id}`, kind: 'bank', entity_id: b.id, name: b.name, coa_code: b.coa_code || `${bankCode}-${b.id}`, balance_rial: bal, flag: '' });
    }
  }
  if (tableExists(db, 'cash_boxes')) {
    const cols = columns(db, 'cash_boxes');
    for (const c of db.prepare(`SELECT id, name${cols.has('coa_code') ? ', coa_code' : ''} FROM cash_boxes`).all()) {
      const code = c.coa_code || `${cashCode}-${c.id}`;
      const bal = glLeafBalance(db, code, dateTo);
      sub += bal;
      rows.push({
        id: `cash:${c.id}`, kind: 'cash_box', entity_id: c.id, name: c.name, coa_code: code, balance_rial: bal,
        flag: bal < 0 ? 'negative_cash' : '',
        ...(bal < 0 ? { status: 'warn', sub_status: 'negative_cash', label: 'صندوق منفی', diff_rial: 0 } : {}),
      });
    }
  }
  const gl = glBalance(db, [cashCode, bankCode], dateTo);
  const diff = gl - sub;
  let rounding = 0;
  let bound = 0;
  if (diff) {
    bound = glRoundingBound(db, [cashCode, bankCode], dateTo);
    const cls = classifyDiff(diff, bound);
    if (cls === 'rounding') rounding = diff;
    rows.unshift({
      id: 'unallocated', kind: 'control', name: cls === 'rounding' ? 'اختلاف گرد کردن تومان↔ریال' : 'مانده روی حساب کنترل بدون صندوق/بانک',
      coa_code: `${cashCode},${bankCode}`, balance_rial: diff, flag: cls === 'rounding' ? 'rounding' : 'unallocated',
      diff_class: cls, rounding_bound_rial: Math.ceil(bound),
    });
  }
  const flagged = rows.filter((r) => r.flag);
  const negative = flagged.filter((r) => r.flag === 'negative_cash');
  const reconDiff = flagged.some((r) => r.flag === 'unallocated');
  const status = flagged.some((r) => r.flag !== 'rounding') ? 'warn' : (flagged.length ? 'rounding' : 'ok');
  // Negative cash is an operational signal, not a recon difference: diff stays as computed (0
  // when every box is on its own leaf) and the check carries sub_status «صندوق منفی».
  const subStatus = negative.length && !reconDiff ? 'negative_cash' : null;
  return result('cash_bank', {
    status, sub_status: subStatus, rounding_rial: rounding, rounding_bound_rial: bound,
    gl_rial: gl, sub_rial: sub, diff_rial: diff,
    rows: [...flagged, ...rows.filter((r) => !r.flag)],
    fixable: false,
    note: negative.length
      ? `صندوق منفی: ${negative.map((r) => `${r.name || r.coa_code} (${Math.round(r.balance_rial).toLocaleString('en-US')} ریال)`).join('، ')}${reconDiff ? '' : ' — اختلاف تطبیق صفر است'}`
      : '',
  });
}

// ─── R8 GRNI ───────────────────────────────────────────────────────────────
function checkGrni(ctx) {
  const { db, dateTo } = ctx;
  const je = ctx.je();
  const grniCode = codeOf(db, 'coa_grni') || '2112';
  const gl = -glBalance(db, [grniCode], dateTo);
  const rows = [];
  let sub = 0;
  if (tableExists(db, 'warehouse_docs')) {
    const cols = columns(db, 'warehouse_docs');
    if (cols.has('purchase_invoice_id')) {
      const params = dateTo ? [dateTo] : [];
      for (const d of db.prepare(`
        SELECT wd.id, wd.num, wd.date, wd.amount_rial_total, wd.je_id
        FROM warehouse_docs wd JOIN journal_entries je ON je.id = wd.je_id
        WHERE wd.type='receipt' AND COALESCE(wd.status,'posted')<>'reversed'
          AND wd.purchase_invoice_id IS NULL AND je.ref_type='warehouse_receipt_grni' AND ${JE_LIVE}
          ${dateFilter('wd.date', dateTo)}
      `).all(...params)) {
        const amt = Math.round(Number(d.amount_rial_total) || 0);
        sub += amt;
        rows.push({ id: `wh_doc:${d.id}`, kind: 'warehouse_receipt', doc_id: d.id, num: d.num, date: d.date, amount_rial: amt, je_id: d.je_id });
      }
    }
  }
  if (tableExists(db, 'goods_receipts')) {
    const piCols = columns(db, 'purchase_invoices');
    const params = dateTo ? [dateTo] : [];
    for (const g of db.prepare(`
      SELECT id, num, date, journal_id FROM goods_receipts
      WHERE COALESCE(status,'posted') NOT IN ${DEAD_SQL} AND journal_id IS NOT NULL${dateFilter('date', dateTo)}
    `).all(...params)) {
      if (!je.live(g.journal_id)) continue;
      if (piCols.has('goods_receipt_id')) {
        const inv = db.prepare(`
          SELECT 1 FROM purchase_invoices WHERE goods_receipt_id=? ${piCols.has('status') ? `AND COALESCE(status,'posted') NOT IN ${DEAD_SQL}` : ''} LIMIT 1
        `).get(g.id);
        if (inv) continue;
      }
      const c = db.prepare(`
        SELECT COALESCE(SUM(${SQL_JL_CREDIT_RIAL} - ${SQL_JL_DEBIT_RIAL}),0) v FROM journal_lines jl
        WHERE jl.entry_id=? AND (jl.account_code=? OR jl.account_code LIKE ?)
      `).get(g.journal_id, grniCode, `${grniCode}%`);
      const amt = Math.round(Number(c && c.v) || 0);
      if (!amt) continue;
      sub += amt;
      rows.push({ id: `gr:${g.id}`, kind: 'goods_receipt', doc_id: g.id, num: g.num, date: g.date, amount_rial: amt, je_id: g.journal_id });
    }
  }
  const diff = gl - sub;
  const bound = diff ? glRoundingBound(db, [grniCode], dateTo) : 0;
  const cls = classifyDiff(diff, bound);
  return result('grni', {
    status: statusOfClass(cls),
    rounding_rial: cls === 'rounding' ? diff : 0, rounding_bound_rial: bound,
    gl_rial: gl, sub_rial: sub, diff_rial: diff, rows, fixable: false,
    note: 'مانده بستانکار 2112 در برابر رسیدهای فاکتورنشده',
  });
}

// ─── R9 fixed assets ───────────────────────────────────────────────────────
function checkFixedAssets(ctx) {
  const { db, dateTo } = ctx;
  if (!tableExists(db, 'fixed_assets')) {
    return result('fixed_assets', { status: 'ok', gl_rial: 0, sub_rial: 0, diff_rial: 0, rows: [], note: 'جدول دارایی ثابت وجود ندارد' });
  }
  const cols = columns(db, 'fixed_assets');
  const assetControl = codeOf(db, 'coa_fixed_assets') || '1201';
  const accumControl = codeOf(db, 'coa_accumulated_depreciation') || '1202';
  const assets = db.prepare(`
    SELECT id, code, name, cost_rial, accumulated_depreciation_rial, coa_asset_code${cols.has('acq_je_id') ? ', acq_je_id' : ''}
    FROM fixed_assets WHERE status='active'
  `).all();
  const subCost = assets.reduce((s, a) => s + Math.round(Number(a.cost_rial) || 0), 0);
  const subAccum = assets.reduce((s, a) => s + Math.round(Number(a.accumulated_depreciation_rial) || 0), 0);
  const assetCodes = [...new Set([assetControl, ...assets.map((a) => String(a.coa_asset_code || '')).filter(Boolean)])];
  const glCost = glBalance(db, assetCodes, dateTo);
  const glAccum = -glBalance(db, [accumControl], dateTo);
  const legacy = cols.has('acq_je_id') ? assets.filter((a) => !a.acq_je_id) : assets;
  const legacyCost = legacy.reduce((s, a) => s + Math.round(Number(a.cost_rial) || 0), 0);
  const costDiff = glCost - subCost;
  const accumDiff = glAccum - subAccum;
  const costBound = costDiff ? glRoundingBound(db, assetCodes, dateTo) + assets.reduce((s, a) => s + frac(a.cost_rial), 0) : 0;
  const accumBound = accumDiff ? glRoundingBound(db, [accumControl], dateTo) + assets.reduce((s, a) => s + frac(a.accumulated_depreciation_rial), 0) : 0;
  const accumCls = classifyDiff(accumDiff, accumBound);
  // Legacy assets without acquisition voucher explain −legacyCost of the cost diff (info);
  // what is left over is classified on its own.
  const costRest = legacy.length ? costDiff + legacyCost : costDiff;
  const costCls = classifyDiff(costRest, costBound);
  const costStatus = costCls === 'ok' ? (costDiff ? 'info' : 'ok') : statusOfClass(costCls);
  const rows = [
    { id: 'cost', metric: 'cost', account_code: assetControl, gl_rial: glCost, sub_rial: subCost, diff_rial: costDiff, legacy_without_je_rial: legacyCost, status: costStatus, diff_class: costCls, rounding_bound_rial: Math.ceil(costBound) },
    { id: 'accumulated_depreciation', metric: 'accumulated_depreciation', account_code: accumControl, gl_rial: glAccum, sub_rial: subAccum, diff_rial: accumDiff, status: statusOfClass(accumCls), diff_class: accumCls, rounding_bound_rial: Math.ceil(accumBound) },
  ];
  const candidates = new Set(fixedAssetOpeningCandidates(db).map((a) => Number(a.id)));
  for (const a of legacy) {
    rows.push({ id: `asset:${a.id}`, metric: 'legacy_no_acq_je', asset_id: a.id, code: a.code, name: a.name, sub_rial: Math.round(Number(a.cost_rial) || 0), fixable: candidates.has(Number(a.id)) });
  }
  const status = worstStatus(costStatus, statusOfClass(accumCls));
  return result('fixed_assets', {
    status, gl_rial: glCost, sub_rial: subCost, diff_rial: costDiff, rows, fixable: candidates.size > 0,
    rounding_rial: (costCls === 'rounding' ? costRest : 0) + (accumCls === 'rounding' ? accumDiff : 0),
    rounding_bound_rial: costBound + accumBound,
    note: legacy.length ? `${legacy.length} دارایی قدیمی بدون سند تحصیل — اصلاح «سند افتتاحیه یکجا» در دسترس است` : '',
  });
}

// ─── v522 fixed-asset opening voucher (one-off) ────────────────────────────
/** Active assets with cost and no live acquisition voucher (acq_je_id dead/null, no live fixed_asset_acquisition JE). */
function fixedAssetOpeningCandidates(db) {
  if (!tableExists(db, 'fixed_assets') || !columns(db, 'fixed_assets').has('acq_je_id')) return [];
  const je = buildJeIndex(db);
  return db.prepare("SELECT * FROM fixed_assets WHERE status='active' ORDER BY id").all().filter((a) => (
    Math.round(Number(a.cost_rial) || 0) > 0
    && !(a.acq_je_id && je.live(a.acq_je_id))
    && !je.has('fixed_asset_acquisition', a.id)
  ));
}

function fixedAssetAccount(db, asset) {
  const code = asset.coa_asset_code || codeOf(db, 'coa_fixed_assets') || '1201';
  return db.prepare('SELECT code, name FROM chart_of_accounts WHERE code=?').get(code) || acct(db, 'coa_fixed_assets');
}

/** First day of the active fiscal year; today when that date is in a closed year. */
function fiscalYearStartDate(db) {
  const today = require('../jalali').todayJalali();
  let start = '';
  try {
    const activeId = setting(db, 'active_fiscal_year_id', '');
    const fy = (activeId && db.prepare('SELECT start_date FROM fiscal_years WHERE id=?').get(Number(activeId)))
      || db.prepare("SELECT start_date FROM fiscal_years WHERE status='open' ORDER BY id DESC LIMIT 1").get();
    start = (fy && fy.start_date) || '';
  } catch (_) { start = ''; }
  if (!/^\d{4}\/\d{2}\/\d{2}$/.test(start) || start > today) start = `${today.slice(0, 4)}/01/01`;
  try {
    if (require('./void-journal').closedFiscalYearForDate(db, start)) start = today;
  } catch (_) { /* helper optional */ }
  return start;
}

function fixFixedAssets(db, opts) {
  ensureReconSchemaOnce(db);
  const wanted = idSet(opts.ids);
  const assets = fixedAssetOpeningCandidates(db).filter((a) => !wanted.size || wanted.has(String(a.id)) || wanted.has(`asset:${a.id}`));
  const date = fiscalYearStartDate(db);
  const opening = acct(db, 'coa_opening_balance');
  const plan = assets.map((a) => {
    const acc = fixedAssetAccount(db, a);
    return { asset_id: a.id, code: a.code, name: a.name, cost_rial: Math.round(Number(a.cost_rial) || 0), account_code: acc.code, action: 'opening_voucher' };
  });
  const total = plan.reduce((s, p) => s + p.cost_rial, 0);
  const fa = computeFixedAssetGap(db);
  const summary = { date, assets: plan.length, total_rial: total, credit_account: opening.code, gl_shortfall_rial: fa.shortfall };
  if (opts.dryRun) return { code: 'fixed_assets', dry_run: true, plan, applied: [], summary };
  const reason = requireConfirm(opts);
  if (!plan.length) return { code: 'fixed_assets', dry_run: false, plan, applied: [], summary };
  const force = opts.force === true || opts.force === 1 || opts.force === '1' || opts.force === 'true';
  if (!force && fa.shortfall < total) {
    throw err('دفتر کل حساب دارایی ثابت از قبل بخشی از این بها را دارد — ثبت افتتاحیه دوباره‌شماری می‌کند (برای ثبت اجباری force)', 409,
      'E_RECON_FA_GL_COVERED', { gl_shortfall_rial: fa.shortfall, total_rial: total });
  }
  const userId = opts.user && opts.user.id;
  const applied = [];
  db.transaction(() => {
    const fixId = Number(db.prepare(`
      INSERT INTO subledger_recon_fixes (code, target, amount_rial, reason, detail_json, created_by)
      VALUES ('fixed_assets', ?, ?, ?, ?, ?)
    `).run(`${plan.length} دارایی`, total, reason, JSON.stringify({
      date, credit_account: opening.code,
      assets: assets.map((a, i) => ({ ...plan[i], prev_acq_je_id: a.acq_je_id || null, prev_acq_funding: a.acq_funding || null })),
    }), userId || null).lastInsertRowid);
    const lines = plan.map((p) => ({
      code: p.account_code, name: fixedAssetAccount(db, { coa_asset_code: p.account_code }).name,
      debit: rialToLedger(p.cost_rial), credit: 0, description: `افتتاحیه دارایی ${p.code} — ${p.name}`,
    }));
    lines.push({ code: opening.code, name: opening.name, debit: 0, credit: rialToLedger(total), description: 'سرمایه افتتاحیه دارایی‌های ثابت' });
    const { postToLedger } = require('./ledger');
    const jeId = postToLedger(db, {
      sourceType: 'fixed_asset_opening_recon', sourceId: fixId, date,
      description: `سند افتتاحیه یکجای دارایی‌های ثابت بدون سند تحصیل (${plan.length} مورد) — ${reason.slice(0, 120)}`,
      createdBy: userId || null, lines, skipCcPolicy: true,
    });
    db.prepare('UPDATE subledger_recon_fixes SET je_id=? WHERE id=?').run(jeId, fixId);
    const upd = db.prepare("UPDATE fixed_assets SET acq_je_id=?, acq_funding='opening', acq_supplier_id=NULL, acq_release_je_id=NULL WHERE id=?");
    for (const p of plan) upd.run(jeId, p.asset_id);
    applied.push({ fix_id: fixId, je_id: jeId, assets: plan.length, total_rial: total, date });
    writeAudit(db, userId, 'recon_fix', 'subledger_recon_fix', fixId,
      { check: 'fixed_assets', je_id: jeId, assets: plan.map((p) => p.asset_id), total_rial: total, reason });
  })();
  return { code: 'fixed_assets', dry_run: false, plan, applied, summary };
}

/** GL cost shortfall vs register (active assets) — the most an opening voucher may add. */
function computeFixedAssetGap(db) {
  const assets = db.prepare("SELECT cost_rial, coa_asset_code FROM fixed_assets WHERE status='active'").all();
  const control = codeOf(db, 'coa_fixed_assets') || '1201';
  const codes = [...new Set([control, ...assets.map((a) => String(a.coa_asset_code || '')).filter(Boolean)])];
  const sub = assets.reduce((s, a) => s + Math.round(Number(a.cost_rial) || 0), 0);
  const gl = glBalance(db, codes, '');
  return { gl, sub, shortfall: Math.max(0, sub - gl) };
}

/** Per-asset counter-voucher when one asset of a combined opening voucher is deactivated. */
function releaseFixedAssetOpening(db, asset, { userId } = {}) {
  ensureReconSchemaOnce(db);
  if (!asset || !asset.acq_je_id) return null;
  const je = db.prepare('SELECT id, ref_type FROM journal_entries WHERE id=?').get(asset.acq_je_id);
  if (!je || je.ref_type !== 'fixed_asset_opening_recon') return null;
  const cost = Math.round(Number(asset.cost_rial) || 0);
  if (cost <= 0) return null;
  const opening = acct(db, 'coa_opening_balance');
  const acc = fixedAssetAccount(db, asset);
  const { postToLedger } = require('./ledger');
  const jeId = postToLedger(db, {
    sourceType: 'fixed_asset_opening_release', sourceId: asset.id, date: require('../jalali').todayJalali(),
    description: `برگشت افتتاحیه دارایی ${asset.code} (غیرفعال‌سازی)`, createdBy: userId || null, skipCcPolicy: true,
    lines: [
      { code: opening.code, name: opening.name, debit: rialToLedger(cost), credit: 0 },
      { code: acc.code, name: acc.name, debit: 0, credit: rialToLedger(cost) },
    ],
  });
  db.prepare('UPDATE fixed_assets SET acq_release_je_id=? WHERE id=?').run(jeId, asset.id);
  return jeId;
}

// ─── R10 suspense accounts ─────────────────────────────────────────────────
function checkSuspenseAccounts(ctx) {
  const { db, dateTo } = ctx;
  const keys = ['coa_adjustment', 'coa_labor_control', 'coa_overhead_control'];
  const rows = [];
  let total = 0;
  for (const k of keys) {
    const code = codeOf(db, k);
    if (!code) continue;
    const bal = glBalance(db, [code], dateTo);
    if (!bal) continue;
    const bound = glRoundingBound(db, [code], dateTo);
    const cls = classifyDiff(bal, bound);
    total += bal;
    const params = [code, `${code}%`];
    if (dateTo) params.push(dateTo);
    const by = db.prepare(`
      SELECT je.ref_type AS ref_type, COUNT(DISTINCT je.id) AS n,
        COALESCE(SUM(${SQL_JL_DEBIT_RIAL} - ${SQL_JL_CREDIT_RIAL}),0) AS bal
      FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
      WHERE ${JE_LIVE} AND (jl.account_code=? OR jl.account_code LIKE ?)${dateFilter('je.entry_date', dateTo)}
      GROUP BY je.ref_type ORDER BY ABS(bal) DESC LIMIT 10
    `).all(...params);
    rows.push({
      id: code, key: k, account_code: code, balance_rial: bal, diff_class: cls, status: statusOfClass(cls), rounding_bound_rial: Math.ceil(bound),
      by_ref_type: by.map((b) => ({ ref_type: b.ref_type || '', entries: b.n, balance_rial: Math.round(Number(b.bal) || 0) })),
    });
  }
  const roll = rowsRollup(rows);
  return result('suspense_accounts', {
    status: roll.status, gl_rial: total, sub_rial: 0, diff_rial: total, rows, fixable: false,
    rounding_rial: roll.rounding, rounding_bound_rial: roll.bound,
  });
}

// ─── R11 closed period changes ─────────────────────────────────────────────
function checkClosedPeriodChanges(ctx) {
  const { db } = ctx;
  const rows = [];
  if (!tableExists(db, 'fiscal_years')) return result('closed_period_changes', { status: 'ok', rows });
  const fys = db.prepare(`
    SELECT id, label, start_date, end_date, status, closed_at FROM fiscal_years
    WHERE status IN ('closed','locked') AND COALESCE(closed_at,0) > 0
  `).all();
  const jeCols = columns(db, 'journal_entries');
  for (const fy of fys) {
    const params = [fy.start_date || '0000/00/00'];
    let range = 'je.entry_date >= ?';
    if (fy.end_date) { range += ' AND je.entry_date <= ?'; params.push(fy.end_date); } else {
      const next = db.prepare('SELECT MIN(start_date) s FROM fiscal_years WHERE start_date > ?').get(fy.start_date || '');
      if (next && next.s) { range += ' AND je.entry_date < ?'; params.push(next.s); }
    }
    params.push(fy.closed_at, fy.closed_at);
    const sel = ['je.id', 'je.entry_date', 'je.ref_type', 'je.ref_id', 'je.status', 'je.deleted_at', 'je.created_at', 'je.description'];
    if (jeCols.has('reversed_by_je_id')) sel.push('je.reversed_by_je_id');
    for (const j of db.prepare(`
      SELECT ${sel.join(', ')} FROM journal_entries je
      WHERE ${range} AND (COALESCE(je.created_at,0) > ? OR COALESCE(je.deleted_at,0) > ?)
      ORDER BY je.id
    `).all(...params)) {
      rows.push({
        id: Number(j.id), je_id: Number(j.id), fiscal_year_id: fy.id, fiscal_year: fy.label,
        closed_at: fy.closed_at, entry_date: j.entry_date, ref_type: j.ref_type, ref_id: j.ref_id,
        change: Number(j.deleted_at || 0) > Number(fy.closed_at) ? 'voided_after_close' : 'created_after_close',
        status: j.status || '', description: j.description || '',
      });
    }
  }
  return result('closed_period_changes', { status: rows.length ? 'warn' : 'ok', rows, fixable: false });
}

const RUNNERS = {
  inventory_vs_gl: checkInventoryVsGl,
  movements_without_je: checkMovementsWithoutJe,
  documents_without_je: checkDocumentsWithoutJe,
  je_on_dead_document: checkJeOnDeadDocument,
  document_amount_vs_je: checkDocumentAmountVsJe,
  party_control: checkPartyControl,
  cash_bank: checkCashBank,
  grni: checkGrni,
  fixed_assets: checkFixedAssets,
  suspense_accounts: checkSuspenseAccounts,
  closed_period_changes: checkClosedPeriodChanges,
};

function runOne(ctx, code) {
  const fn = RUNNERS[code];
  if (!fn) throw err(`کنترل ناشناخته: ${code}`, 404, 'E_RECON_UNKNOWN_CHECK');
  const t0 = Date.now();
  try {
    const r = fn(ctx);
    r.ms = Date.now() - t0;
    return r;
  } catch (e) {
    const r = result(code, { status: 'error', rows: [], note: `خطا در اجرای کنترل: ${e.message}` });
    r.ms = Date.now() - t0;
    return r;
  }
}

function parseChecks(checks) {
  if (!checks) return CHECKS.map(([c]) => c);
  const list = Array.isArray(checks) ? checks : String(checks).split(',');
  return list.map((s) => String(s).trim()).filter((c) => RUNNERS[c]);
}

/**
 * Run the reconciliation report.
 * @returns {{ as_of, ran_at, summary:{ok,warn,error,info}, checks:Array, run_id }}
 */
function runRecon(db, opts = {}) {
  const ctx = ctxFor(db, opts);
  const codes = parseChecks(opts.checks);
  const checks = codes.map((c) => {
    const r = runOne(ctx, c);
    delete r.rows;
    return r;
  });
  const summary = { ok: 0, warn: 0, error: 0, info: 0, rounding: 0 };
  for (const c of checks) summary[c.status] = (summary[c.status] || 0) + 1;
  const asOf = ctx.dateTo || require('../jalali').todayJalali();
  const out = { as_of: asOf, ran_at: Math.floor(Date.now() / 1000), summary, checks };
  if (opts.persist !== false) {
    try {
      ensureReconSchemaOnce(db);
      out.run_id = Number(db.prepare(
        'INSERT INTO subledger_recon_runs (as_of, result_json, created_by) VALUES (?,?,?)'
      ).run(asOf, JSON.stringify(out), opts.userId || null).lastInsertRowid);
    } catch (_) { /* report still returned */ }
  }
  return out;
}

function lastRun(db) {
  ensureReconSchemaOnce(db);
  const r = db.prepare('SELECT id, as_of, result_json, created_by, created_at FROM subledger_recon_runs ORDER BY id DESC LIMIT 1').get();
  if (!r) return null;
  let parsed = {};
  try { parsed = JSON.parse(r.result_json || '{}'); } catch (_) { parsed = {}; }
  return { ...parsed, run_id: r.id, created_by: r.created_by, created_at: r.created_at };
}

/** Full rows of one check (paged). */
function checkRows(db, code, opts = {}) {
  const ctx = ctxFor(db, opts);
  const fn = RUNNERS[code];
  if (!fn) throw err(`کنترل ناشناخته: ${code}`, 404, 'E_RECON_UNKNOWN_CHECK');
  const r = fn(ctx);
  const limit = Math.min(2000, Math.max(1, parseInt(opts.limit, 10) || 200));
  const offset = Math.max(0, parseInt(opts.offset, 10) || 0);
  return { code, status: r.status, total: r.rows.length, rows: r.rows.slice(offset, offset + limit) };
}

// ─── fixes ─────────────────────────────────────────────────────────────────
/**
 * Inventory value JE: amountRial > 0 = increase (Dr inventory / Cr adjustment), < 0 = decrease.
 * Returns JE id or null (zero amount / periodic warehouse).
 */
function postInventoryValueAdjustmentJe(db, {
  warehouseId = null, inventoryCode = null, amountRial, date, userId, sourceType, sourceId, description,
  counterCode = null, counterName = null,
}) {
  const amt = Math.round(Number(amountRial) || 0);
  if (!amt) return null;
  if (warehouseId) {
    try {
      if (require('./inventory/periodic-close').isPeriodicWarehouse(db, warehouseId)) return null;
    } catch (_) { /* column missing → perpetual */ }
  }
  let inv;
  if (inventoryCode) {
    const row = db.prepare('SELECT code, name FROM chart_of_accounts WHERE code=?').get(inventoryCode);
    inv = row || { code: inventoryCode, name: inventoryCode };
  } else {
    inv = inventoryAccountFor(db, warehouseId);
  }
  // v522: manual adjustments pass a stage/reason counter account; default stays coa_adjustment.
  const adj = counterCode
    ? (db.prepare('SELECT code, name FROM chart_of_accounts WHERE code=?').get(counterCode) || { code: counterCode, name: counterName || counterCode })
    : acct(db, 'coa_adjustment');
  let cc = null;
  if (warehouseId) {
    try { cc = db.prepare('SELECT cost_center_id FROM warehouses WHERE id=?').get(warehouseId)?.cost_center_id || null; } catch (_) { cc = null; }
  }
  const v = rialToLedger(Math.abs(amt));
  const lines = amt > 0
    ? [
      { code: inv.code, name: inv.name, debit: v, credit: 0, cost_center_id: cc },
      { code: adj.code, name: adj.name, debit: 0, credit: v, cost_center_id: cc },
    ]
    : [
      { code: adj.code, name: adj.name, debit: v, credit: 0, cost_center_id: cc },
      { code: inv.code, name: inv.name, debit: 0, credit: v, cost_center_id: cc },
    ];
  const { postToLedger } = require('./ledger');
  return postToLedger(db, {
    sourceType, sourceId, date: date || require('../jalali').todayJalali(),
    description: description || 'تعدیل ارزش موجودی',
    createdBy: userId || null, lines, costCenterId: cc, warehouseId, skipCcPolicy: true,
  });
}

function requireConfirm(opts) {
  const confirm = opts.confirm === true || opts.confirm === 1 || opts.confirm === '1' || opts.confirm === 'true';
  const reason = String(opts.reason || '').trim();
  if (!confirm || reason.length < 3) {
    throw err('برای ثبت سند اصلاحی تأیید صریح (confirm) و دلیل الزامی است', 400, 'E_RECON_CONFIRM_REQUIRED');
  }
  return reason;
}

function idSet(ids) {
  return new Set((Array.isArray(ids) ? ids : String(ids || '').split(',')).map((x) => String(x).trim()).filter(Boolean));
}

function fixJeOnDeadDocument(db, opts) {
  const ctx = ctxFor(db, opts);
  const wanted = idSet(opts.ids);
  const rows = computeJeOnDeadDocument(ctx).filter((r) => !wanted.size || wanted.has(String(r.je_id)));
  const plan = rows.map((r) => ({ je_id: r.je_id, ref_type: r.ref_type, ref_id: r.ref_id, amount_rial: r.amount_rial, action: 'reverse_je' }));
  if (opts.dryRun) return { code: 'je_on_dead_document', dry_run: true, plan, applied: [] };
  const { reverseJournalEntry } = require('./void-journal');
  const reason = String(opts.reason || 'ابطال سند حسابداری روی سند باطل‌شده (تطبیق زیرسیستم)');
  const applied = [];
  db.transaction(() => {
    for (const p of plan) {
      const r = reverseJournalEntry(db, p.je_id, { userId: opts.user && opts.user.id, reason });
      const link = columns(db, 'journal_entries').has('reversed_by_je_id')
        ? db.prepare('SELECT reversed_by_je_id FROM journal_entries WHERE id=?').get(p.je_id)
        : null;
      applied.push({ ...p, result: r ? 'reversed' : 'already_dead', counter_voucher_id: (link && link.reversed_by_je_id) || null });
      writeAudit(db, opts.user && opts.user.id, 'recon_fix', 'journal_entry', p.je_id,
        { check: 'je_on_dead_document', ref_type: p.ref_type, ref_id: p.ref_id, reason });
    }
  })();
  return { code: 'je_on_dead_document', dry_run: false, plan, applied };
}

// v525: the inventory fix never defaults to 9999 — the user picks a counter account per fix.
const COUNTER_SUGGESTIONS = [
  ['coa_opening_balance', '3102', 'اصلاح موجودی افتتاحیه'],
  [null, '6118', 'کسری و اضافات انبار'],
  [null, '6108', 'کسری و ضایعات انبار'],
  ['coa_cogs', '5101', 'بهای تمام‌شدهٔ فروش'],
  ['coa_raw_materials', '1110', 'جابه‌جایی بین حساب‌های موجودی'],
  ['coa_wip', '1111', 'مصرف بی‌حواله در تولید'],
];

/** Codes a recon fix may never use as its counter side (suspense / control accounts). */
function forbiddenCounterCodes(db) {
  const out = new Set(['9999']);
  for (const k of ['coa_adjustment', 'coa_labor_control', 'coa_overhead_control']) {
    const c = codeOf(db, k);
    if (c) out.add(String(c));
  }
  return out;
}

function counterSuggestions(db, exclude = []) {
  const { isPostableCode } = require('./coa-map');
  const seen = new Set();
  const out = [];
  for (const [key, fallback, hint] of COUNTER_SUGGESTIONS) {
    const code = String((key && codeOf(db, key)) || fallback);
    if (seen.has(code) || exclude.includes(code)) continue;
    seen.add(code);
    const row = db.prepare('SELECT code, name FROM chart_of_accounts WHERE code=?').get(code);
    if (!row || !isPostableCode(db, code)) continue;
    out.push({ code: row.code, name: row.name, hint });
  }
  return out;
}

/** Validate a user-chosen counter account; throws 400 with a Persian message. */
function resolveCounterAccount(db, code, targetCode) {
  const c = String(code || '').trim();
  if (!c) throw err('حساب طرف مقابل سند اصلاحی را انتخاب کنید (۹۹۹۹ پیش‌فرض نیست)', 400, 'E_RECON_COUNTER_REQUIRED');
  if (forbiddenCounterCodes(db).has(c) || c.startsWith('9999')) {
    throw err(`حساب ${c} حساب معلق/کنترل است و نمی‌تواند طرف سند اصلاح موجودی باشد`, 400, 'E_RECON_COUNTER_FORBIDDEN');
  }
  if (targetCode && c === String(targetCode)) {
    throw err(`حساب طرف مقابل نمی‌تواند همان حساب موجودی ${c} باشد`, 400, 'E_RECON_COUNTER_FORBIDDEN');
  }
  const row = db.prepare('SELECT code, name, is_active FROM chart_of_accounts WHERE code=?').get(c);
  if (!row || row.is_active === 0) throw err(`حساب ${c} در سرفصل‌ها نیست یا غیرفعال است`, 400, 'E_RECON_COUNTER_INVALID');
  if (!require('./coa-map').isPostableCode(db, c)) {
    throw err(`حساب ${c} زیرحساب دارد و قابل ثبت نیست — یک حساب معین/تفصیلی انتخاب کنید`, 400, 'E_RECON_COUNTER_INVALID');
  }
  return { code: row.code, name: row.name };
}

function fixInventoryVsGl(db, opts) {
  ensureReconSchemaOnce(db);
  const ctx = ctxFor(db, opts);
  const wanted = idSet(opts.ids);
  const r = computeInventoryVsGl(ctx);
  const targets = r.accRows.filter((a) => a.status === 'warn' && (!wanted.size || wanted.has(String(a.account_code))));
  const perAccount = opts.counterAccounts && typeof opts.counterAccounts === 'object' ? opts.counterAccounts : {};
  const counterFor = (code) => String(perAccount[code] || opts.counterAccount || '').trim();
  const plan = targets.map((a) => {
    const adjust = a.sub_rial - a.gl_rial;
    let counter = null;
    let counterError = null;
    const chosen = counterFor(a.account_code);
    if (chosen) {
      try { counter = resolveCounterAccount(db, chosen, a.account_code); } catch (e) { counterError = { code: e.code, error: e.message }; }
    }
    const cc = counter ? counter.code : null;
    return {
      account_code: a.account_code, account_name: a.account_name, gl_rial: a.gl_rial, sub_rial: a.sub_rial,
      adjust_rial: adjust,
      counter_account: cc, counter_name: counter ? counter.name : null, counter_error: counterError,
      lines: adjust > 0
        ? [{ code: a.account_code, side: 'debit', amount_rial: adjust }, { code: cc, side: 'credit', amount_rial: adjust }]
        : [{ code: cc, side: 'debit', amount_rial: -adjust }, { code: a.account_code, side: 'credit', amount_rial: -adjust }],
    };
  });
  const counter_suggestions = counterSuggestions(db, targets.map((a) => String(a.account_code)));
  const counter_required = plan.some((p) => !p.counter_account);
  if (opts.dryRun) return { code: 'inventory_vs_gl', dry_run: true, plan, applied: [], counter_required, counter_suggestions };
  const reason = requireConfirm(opts);
  for (const p of plan) {
    if (p.counter_error) throw err(p.counter_error.error, 400, p.counter_error.code);
    if (!p.counter_account) resolveCounterAccount(db, '', p.account_code);
  }
  const date = opts.date || require('../jalali').todayJalali();
  const userId = opts.user && opts.user.id;
  const applied = [];
  db.transaction(() => {
    for (const p of plan) {
      const fixId = Number(db.prepare(`
        INSERT INTO subledger_recon_fixes (code, target, amount_rial, reason, detail_json, created_by)
        VALUES ('inventory_vs_gl', ?, ?, ?, ?, ?)
      `).run(p.account_code, p.adjust_rial, reason, JSON.stringify({ gl_rial: p.gl_rial, sub_rial: p.sub_rial, date, counter_account: p.counter_account }), userId || null).lastInsertRowid);
      const jeId = postInventoryValueAdjustmentJe(db, {
        inventoryCode: p.account_code, amountRial: p.adjust_rial, date, userId,
        sourceType: 'inventory_recon_adjust', sourceId: fixId,
        counterCode: p.counter_account, counterName: p.counter_name,
        description: `تعدیل تطبیق موجودی با دفتر کل (${p.account_code} ↔ ${p.counter_account}) — ${reason.slice(0, 120)}`,
      });
      db.prepare('UPDATE subledger_recon_fixes SET je_id=? WHERE id=?').run(jeId, fixId);
      applied.push({ ...p, fix_id: fixId, je_id: jeId });
      writeAudit(db, userId, 'recon_fix', 'subledger_recon_fix', fixId,
        { check: 'inventory_vs_gl', account_code: p.account_code, adjust_rial: p.adjust_rial, je_id: jeId, reason });
    }
  })();
  return { code: 'inventory_vs_gl', dry_run: false, plan, applied };
}

function fixMovementsWithoutJe(db, opts) {
  ensureReconSchemaOnce(db);
  const ctx = ctxFor(db, opts);
  const wanted = idSet(opts.ids);
  const rows = computeMovementsWithoutJe(ctx).rows.filter((r) => r.fixable && (!wanted.size || wanted.has(String(r.id))));
  const plan = rows.map((r) => ({ ledger_id: r.id, source_type: r.source_type, warehouse_id: r.warehouse_id, amount_rial: r.amount_rial, action: 'post_adjustment_je' }));
  if (opts.dryRun) return { code: 'movements_without_je', dry_run: true, plan, applied: [] };
  const reason = requireConfirm(opts);
  const userId = opts.user && opts.user.id;
  const applied = [];
  db.transaction(() => {
    for (const p of plan) {
      const led = db.prepare('SELECT * FROM inventory_ledger WHERE id=?').get(p.ledger_id);
      const refType = p.source_type === 'stock_adjust' ? 'stock_adjust' : 'inventory_adjust';
      const jeId = postInventoryValueAdjustmentJe(db, {
        warehouseId: led.warehouse_id, amountRial: p.amount_rial, date: led.date || undefined, userId,
        sourceType: refType, sourceId: led.id,
        description: `سند تعدیل موجودی برای گردش ${led.tx_no || led.id} — ${reason.slice(0, 120)}`,
      });
      if (jeId) db.prepare('UPDATE inventory_ledger SET je_id=? WHERE id=?').run(jeId, led.id);
      applied.push({ ...p, je_id: jeId });
      writeAudit(db, userId, 'recon_fix', 'inventory_ledger', led.id, { check: 'movements_without_je', je_id: jeId, reason });
    }
  })();
  return { code: 'movements_without_je', dry_run: false, plan, applied };
}

const FIXERS = {
  je_on_dead_document: fixJeOnDeadDocument,
  inventory_vs_gl: fixInventoryVsGl,
  movements_without_je: fixMovementsWithoutJe,
  fixed_assets: fixFixedAssets,
};

/**
 * Apply a fix for one check. dryRun defaults to true.
 * @param {{ ids?:Array, dryRun?:boolean, confirm?:boolean, reason?:string, user?:{id:number}, dateTo?:string }} opts
 */
function applyFix(db, code, opts = {}) {
  if (!RUNNERS[code]) throw err(`کنترل ناشناخته: ${code}`, 404, 'E_RECON_UNKNOWN_CHECK');
  const fixer = FIXERS[code];
  if (!fixer) throw err('این کنترل اصلاح خودکار ندارد — سند مبدأ را بررسی کنید', 400, 'E_RECON_NOT_FIXABLE');
  const dryRun = !(opts.dryRun === false || opts.dryRun === 0 || opts.dryRun === '0' || opts.dryRun === 'false');
  return fixer(db, { ...opts, dryRun });
}

function listFixes(db, { limit } = {}) {
  ensureReconSchemaOnce(db);
  const lim = Math.min(500, Math.max(1, parseInt(limit, 10) || 100));
  return db.prepare('SELECT * FROM subledger_recon_fixes ORDER BY id DESC LIMIT ?').all(lim);
}

/** R13: cancel a recon adjustment = void its JE + mark fix reversed (atomic). */
function reverseFix(db, fixId, { user, reason } = {}) {
  ensureReconSchemaOnce(db);
  const fix = db.prepare('SELECT * FROM subledger_recon_fixes WHERE id=?').get(fixId);
  if (!fix) throw err('اصلاحیه یافت نشد', 404, 'E_RECON_FIX_NOT_FOUND');
  if (fix.status === 'reversed') throw err('این اصلاحیه قبلاً ابطال شده است', 409, 'E_RECON_FIX_REVERSED');
  const { reverseJournalEntry } = require('./void-journal');
  const userId = user && user.id;
  db.transaction(() => {
    if (fix.code === 'fixed_assets') unlinkFixedAssetOpening(db, fix, { userId, reason });
    if (fix.je_id) reverseJournalEntry(db, fix.je_id, { userId, reason: reason || `ابطال اصلاحیه تطبیق #${fix.id}` });
    db.prepare("UPDATE subledger_recon_fixes SET status='reversed', reversed_at=strftime('%s','now'), reversed_by=? WHERE id=?")
      .run(userId || null, fix.id);
    writeAudit(db, userId, 'recon_fix_reverse', 'subledger_recon_fix', fix.id, { je_id: fix.je_id, reason: reason || '' });
  })();
  return db.prepare('SELECT * FROM subledger_recon_fixes WHERE id=?').get(fix.id);
}

/** R13 for the opening fix: void per-asset release vouchers, restore previous acquisition links. */
function unlinkFixedAssetOpening(db, fix, { userId, reason } = {}) {
  let detail = {};
  try { detail = JSON.parse(fix.detail_json || '{}'); } catch (_) { detail = {}; }
  const { reverseJournalEntry } = require('./void-journal');
  for (const a of detail.assets || []) {
    const row = db.prepare('SELECT id, acq_je_id, acq_release_je_id FROM fixed_assets WHERE id=?').get(a.asset_id);
    if (!row || Number(row.acq_je_id || 0) !== Number(fix.je_id || -1)) continue;
    if (row.acq_release_je_id) {
      reverseJournalEntry(db, row.acq_release_je_id, { userId, reason: reason || `ابطال اصلاحیه تطبیق #${fix.id}` });
    }
    db.prepare('UPDATE fixed_assets SET acq_je_id=?, acq_funding=?, acq_release_je_id=NULL WHERE id=?')
      .run(a.prev_acq_je_id || null, a.prev_acq_funding || null, row.id);
  }
}

// ─── v522 nightly reconciliation ───────────────────────────────────────────
const NIGHTLY_KEYS = {
  enabled: 'subledger_recon_nightly_enabled',
  time: 'subledger_recon_nightly_time',
  lastDate: 'subledger_recon_nightly_last_date',
  lastRunId: 'subledger_recon_nightly_last_run_id',
};
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function putSetting(db, key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key, value == null ? '' : String(value));
}

function nightlySettings(db) {
  const time = setting(db, NIGHTLY_KEYS.time, '02:00');
  return {
    enabled: setting(db, NIGHTLY_KEYS.enabled, '1') !== '0',
    time: TIME_RE.test(time) ? time : '02:00',
    last_date: setting(db, NIGHTLY_KEYS.lastDate, '') || null,
    last_run_id: Number(setting(db, NIGHTLY_KEYS.lastRunId, '')) || null,
  };
}

function saveNightlySettings(db, { enabled, time } = {}, { userId } = {}) {
  if (time != null && !TIME_RE.test(String(time))) {
    throw err('ساعت اجرای شبانه نامعتبر است (HH:MM)', 400, 'E_RECON_NIGHTLY_TIME');
  }
  db.transaction(() => {
    if (enabled != null) putSetting(db, NIGHTLY_KEYS.enabled, enabled === false || enabled === 0 || enabled === '0' ? '0' : '1');
    if (time != null) putSetting(db, NIGHTLY_KEYS.time, String(time));
  })();
  const s = nightlySettings(db);
  writeAudit(db, userId, 'update', 'subledger_recon_nightly', null, { enabled: s.enabled, time: s.time });
  return s;
}

function failingCheckNames(run) {
  return (run.checks || []).filter((c) => c.status === 'warn' || c.status === 'error')
    .map((c) => `${c.name || c.code}${c.sub_status === 'negative_cash' ? ' (صندوق منفی)' : ''}`);
}

/** Run + persist + always notify admin/accounting (bell). */
function runNightlyRecon(db, { date } = {}) {
  ensureReconSchemaOnce(db);
  const day = date || require('../jalali').todayJalali();
  const run = runRecon(db, { persist: true });
  const s = run.summary || {};
  const failing = failingCheckNames(run);
  const parts = [`سالم ${s.ok || 0}`, `هشدار ${s.warn || 0}`, `خطا ${s.error || 0}`, `گرد کردن ${s.rounding || 0}`, `اطلاع ${s.info || 0}`];
  const body = `${parts.join(' · ')}${failing.length ? ` — کنترل‌های ناموفق: ${failing.join('، ')}` : ' — همهٔ کنترل‌ها بدون مغایرت واقعی'}`;
  let notificationId = null;
  try {
    const before = db.prepare('SELECT COALESCE(MAX(id),0) m FROM app_notifications').get().m;
    require('./notifications').notifyRoles(db, {
      kind: 'subledger_recon_nightly', entity_type: 'subledger_recon_run', entity_id: run.run_id || null,
      title: `تطبیق شبانهٔ زیرسیستم‌ها با دفتر کل — ${day}`, body, target_roles: ['admin', 'accounting'],
    });
    const row = db.prepare('SELECT MAX(id) m FROM app_notifications').get();
    notificationId = row && row.m > before ? row.m : null;
  } catch (_) { /* bell is best effort; run is persisted */ }
  if (run.run_id) putSetting(db, NIGHTLY_KEYS.lastRunId, run.run_id);
  return { run_id: run.run_id || null, summary: run.summary, failing, notification_id: notificationId, date: day };
}

/**
 * Cron tick: runs once per Jalali day at/after the configured time (catches up later the
 * same day if the server was down). The day is claimed before running so a crash cannot loop.
 */
function maybeRunNightlyRecon(db, { now, force = false } = {}) {
  const s = nightlySettings(db);
  if (!force && !s.enabled) return { ran: false, reason: 'disabled' };
  const d = now instanceof Date ? now : new Date();
  const { g2j } = require('../jalali');
  const [jy, jm, jd] = g2j(d.getFullYear(), d.getMonth() + 1, d.getDate());
  const day = `${jy}/${String(jm).padStart(2, '0')}/${String(jd).padStart(2, '0')}`;
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (!force && hhmm < s.time) return { ran: false, reason: 'not_yet', time: s.time };
  if (!force && s.last_date === day) return { ran: false, reason: 'already_ran', date: day };
  putSetting(db, NIGHTLY_KEYS.lastDate, day);
  return { ran: true, ...runNightlyRecon(db, { date: day }) };
}

module.exports = {
  CHECKS,
  ensureReconSchema,
  ensureReconSchemaOnce,
  runRecon,
  lastRun,
  checkRows,
  applyFix,
  listFixes,
  reverseFix,
  postInventoryValueAdjustmentJe,
  glBalance,
  MANUAL_SOURCES,
  // v522
  classifyDiff,
  glRoundingBound,
  fixedAssetOpeningCandidates,
  releaseFixedAssetOpening,
  NIGHTLY_KEYS,
  nightlySettings,
  saveNightlySettings,
  runNightlyRecon,
  maybeRunNightlyRecon,
};
