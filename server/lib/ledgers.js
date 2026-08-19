'use strict';
/**
 * LED-01 — read-only shared financial + stock ledgers.
 * Money source of truth: journal_lines INTEGER *_rial (same math as
 * accounting general-ledger / ACC-04 customer GL summary).
 * No writes. No new tables.
 */

const { DELETED_FILTER } = require('./ledger');
const { jlDebitRial, jlCreditRial, SQL_JL_DEBIT_RIAL, SQL_JL_CREDIT_RIAL } = require('./money');
const { stripCostFields } = require('./production/access');

const JE_ALIVE = `${DELETED_FILTER} AND COALESCE(je.status,'posted')<>'reversed'`;

const ENTITY_TYPES = ['person', 'bank', 'cash', 'petty', 'account'];

/** Caller already has GET for these ref_type values (admin/accounting). */
const SAFE_REF_TYPES = new Set([
  'invoice', 'purchase', 'stocktaking', 'product',
  'journal', 'manual_voucher', 'voucher', 'settlement',
  'warehouse_move', 'transfer', 'expense', 'opening',
  'opening_balance', 'person',
]);

function LedgerError(status, error, extra) {
  const e = new Error(error);
  e.status = status;
  e.error = error;
  if (extra) Object.assign(e, extra);
  return e;
}

function safeJalaliDate(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  return /^\d{4}\/\d{1,2}\/\d{1,2}$/.test(s) ? s : null;
}

function assertJalaliQuery(fromRaw, toRaw) {
  if (fromRaw != null && String(fromRaw).trim() !== '' && !safeJalaliDate(fromRaw)) {
    throw LedgerError(400, 'تاریخ از نامعتبر است');
  }
  if (toRaw != null && String(toRaw).trim() !== '' && !safeJalaliDate(toRaw)) {
    throw LedgerError(400, 'تاریخ تا نامعتبر است');
  }
  return { from: safeJalaliDate(fromRaw), to: safeJalaliDate(toRaw) };
}

function signMove(accountType, dr, cr) {
  const debitNormal = ['asset', 'expense', 'cogs'].includes(accountType);
  return debitNormal ? (dr - cr) : (cr - dr);
}

function safeSourceLink({ ref_type, ref_id, journal_id }) {
  const out = { ref_type: null, ref_id: null, journal_id: null };
  const jid = journal_id != null && journal_id !== '' ? Number(journal_id) : null;
  if (Number.isFinite(jid) && jid > 0) out.journal_id = jid;
  const rt = ref_type != null && String(ref_type).trim() !== '' ? String(ref_type).trim() : null;
  const rid = ref_id != null && ref_id !== '' ? Number(ref_id) : null;
  if (rt && SAFE_REF_TYPES.has(rt) && Number.isFinite(rid) && rid > 0) {
    out.ref_type = rt;
    out.ref_id = rid;
  } else if (rt && SAFE_REF_TYPES.has(rt)) {
    out.ref_type = rt;
  }
  return out;
}

function tableExists(db, name) {
  return !!db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?"
  ).get(name);
}

function loadAccount(db, code) {
  if (!code) return null;
  return db.prepare('SELECT * FROM chart_of_accounts WHERE code=?').get(code);
}

function resolveCoaFallback(db, explicit, fallbackCode) {
  if (explicit) {
    const acc = loadAccount(db, explicit);
    if (acc) return acc;
  }
  if (fallbackCode) {
    const acc = loadAccount(db, fallbackCode);
    if (acc) return acc;
  }
  return null;
}

/**
 * Opening / period / closing from journal_lines — same identity as
 * GET /api/accounting/general-ledger/:code
 */
function buildAccountLedger(db, account, { from, to } = {}) {
  if (!account) throw LedgerError(404, 'حساب یافت نشد');
  const move = (dr, cr) => signMove(account.type, dr, cr);

  let opening_rial = 0;
  if (from) {
    const openRow = db.prepare(`
      SELECT
        COALESCE(SUM(${SQL_JL_DEBIT_RIAL}),0) AS d,
        COALESCE(SUM(${SQL_JL_CREDIT_RIAL}),0) AS c
      FROM journal_lines jl
      JOIN journal_entries je ON jl.entry_id=je.id
      WHERE jl.account_code=? AND ${JE_ALIVE} AND je.entry_date < ?
    `).get(account.code, from);
    opening_rial = move(Number(openRow.d) || 0, Number(openRow.c) || 0);
  }

  const where = ['jl.account_code=?', JE_ALIVE];
  const params = [account.code];
  if (from) { where.push('je.entry_date >= ?'); params.push(from); }
  if (to) { where.push('je.entry_date <= ?'); params.push(to); }

  const periodLines = db.prepare(`
    SELECT jl.*, je.entry_date, je.description AS entry_description,
           je.ref_type, je.ref_id, je.id AS journal_id
    FROM journal_lines jl
    JOIN journal_entries je ON jl.entry_id=je.id
    WHERE ${where.join(' AND ')}
    ORDER BY je.entry_date ASC, je.id ASC, jl.id ASC
  `).all(...params);

  let period_debit_rial = 0;
  let period_credit_rial = 0;
  let running = opening_rial;
  const lines = periodLines.map((l) => {
    const dr = jlDebitRial(l);
    const cr = jlCreditRial(l);
    period_debit_rial += dr;
    period_credit_rial += cr;
    running += move(dr, cr);
    const link = safeSourceLink({
      ref_type: l.ref_type,
      ref_id: l.ref_id,
      journal_id: l.journal_id || l.entry_id,
    });
    return {
      id: l.id,
      date: l.entry_date,
      description: l.description || l.entry_description || '',
      debit_rial: dr,
      credit_rial: cr,
      running_balance: running,
      source: 'gl',
      ...link,
    };
  });

  const period_net_rial = move(period_debit_rial, period_credit_rial);
  const closing_rial = opening_rial + period_net_rial;
  return {
    account: { code: account.code, name: account.name, type: account.type },
    opening_rial,
    period_debit_rial,
    period_credit_rial,
    period_net_rial,
    closing_rial,
    lines,
    source: 'gl',
  };
}

function buildPersonSubLedger(db, personId, { from, to } = {}) {
  const all = db.prepare(`
    SELECT pl.*, u.name AS user_name
    FROM person_ledger pl
    LEFT JOIN users u ON pl.user_id=u.id
    WHERE pl.person_id=?
    ORDER BY pl.date ASC, pl.id ASC
  `).all(personId);

  let running = 0;
  const tagged = all.map((e) => {
    const dr = Math.round(Number(e.debit) || 0);
    const cr = Math.round(Number(e.credit) || 0);
    running += dr - cr;
    return {
      id: e.id,
      date: e.date,
      description: e.description || '',
      debit_rial: dr,
      credit_rial: cr,
      running_balance: running,
      source: 'person_ledger',
      user_name: e.user_name || '',
      ...safeSourceLink({ ref_type: e.ref_type, ref_id: e.ref_id, journal_id: null }),
    };
  });

  let opening_rial = 0;
  if (from) {
    for (const e of tagged) {
      if ((e.date || '') < from) opening_rial = e.running_balance;
      else break;
    }
  }

  const lines = [];
  let closing_rial = from ? opening_rial : (tagged.length ? tagged[tagged.length - 1].running_balance : 0);
  let period_debit_rial = 0;
  let period_credit_rial = 0;
  for (const e of tagged) {
    if (from && (e.date || '') < from) continue;
    if (to && (e.date || '') > to) continue;
    lines.push(e);
    period_debit_rial += e.debit_rial;
    period_credit_rial += e.credit_rial;
    closing_rial = e.running_balance;
  }
  if (!lines.length && (from || to)) closing_rial = opening_rial;
  const period_net_rial = period_debit_rial - period_credit_rial;
  return {
    opening_rial,
    period_debit_rial,
    period_credit_rial,
    period_net_rial,
    closing_rial,
    lines,
    source: 'person_ledger',
  };
}

function resolveFinancialEntity(db, entityType, entityId) {
  const type = String(entityType || '').trim();
  const rawId = entityId == null ? '' : String(entityId).trim();
  if (!ENTITY_TYPES.includes(type)) {
    throw LedgerError(400, 'نوع موجودیت نامعتبر است', { entity_type: type });
  }
  if (!rawId) throw LedgerError(400, 'شناسه موجودیت الزامی است');

  if (type === 'account') {
    const account = loadAccount(db, rawId);
    if (!account) throw LedgerError(404, 'حساب یافت نشد');
    return {
      entity_type: type,
      entity_id: account.code,
      entity: { code: account.code, name: account.name, type: account.type },
      account,
    };
  }

  const id = parseInt(rawId, 10);
  if (!Number.isFinite(id) || id <= 0) {
    throw LedgerError(400, 'شناسه موجودیت نامعتبر است');
  }

  if (type === 'person') {
    const person = db.prepare('SELECT * FROM persons WHERE id=?').get(id);
    if (!person) throw LedgerError(404, 'شخص یافت نشد');
    const account = resolveCoaFallback(db, person.coa_code, null);
    return {
      entity_type: type,
      entity_id: id,
      entity: { id: person.id, name: person.name, coa_code: person.coa_code || null },
      account,
    };
  }

  if (type === 'bank') {
    const bank = db.prepare('SELECT * FROM banks WHERE id=?').get(id);
    if (!bank) throw LedgerError(404, 'بانک یافت نشد');
    const account = resolveCoaFallback(db, bank.coa_code, '1102-' + id);
    if (!account) throw LedgerError(404, 'حساب دفتر کل بانک یافت نشد');
    return {
      entity_type: type,
      entity_id: id,
      entity: { id: bank.id, name: bank.name, coa_code: account.code },
      account,
    };
  }

  if (type === 'cash' || type === 'petty') {
    const box = db.prepare('SELECT * FROM cash_boxes WHERE id=?').get(id);
    if (!box) throw LedgerError(404, type === 'petty' ? 'تنخواه یافت نشد' : 'صندوق یافت نشد');
    if (type === 'petty' && !box.is_petty_cash) {
      throw LedgerError(404, 'این صندوق تنخواه‌گردان نیست');
    }
    if (type === 'cash' && box.is_petty_cash) {
      throw LedgerError(400, 'برای تنخواه از entity_type=petty استفاده کنید');
    }
    const account = resolveCoaFallback(db, box.coa_code, '1101-' + id);
    if (!account) throw LedgerError(404, 'حساب دفتر کل صندوق یافت نشد');
    return {
      entity_type: type,
      entity_id: id,
      entity: {
        id: box.id,
        name: box.name,
        is_petty_cash: box.is_petty_cash ? 1 : 0,
        coa_code: account.code,
      },
      account,
    };
  }

  throw LedgerError(400, 'نوع موجودیت نامعتبر است');
}

function buildFinancialLedger(db, { entity_type, entity_id, from, to } = {}) {
  const resolved = resolveFinancialEntity(db, entity_type, entity_id);
  const dates = { from, to };

  if (resolved.entity_type === 'person' && !resolved.account) {
    const hasPl = tableExists(db, 'person_ledger')
      && db.prepare('SELECT 1 FROM person_ledger WHERE person_id=? LIMIT 1').get(resolved.entity_id);
    if (!hasPl) throw LedgerError(404, 'برای این شخص حساب دفتر کل یا ردیف دفتر معین وجود ندارد');
    const sub = buildPersonSubLedger(db, resolved.entity_id, dates);
    return {
      entity_type: 'person',
      entity_id: resolved.entity_id,
      entity: resolved.entity,
      account: null,
      ...sub,
    };
  }

  const gl = buildAccountLedger(db, resolved.account, dates);
  return {
    entity_type: resolved.entity_type,
    entity_id: resolved.entity_id,
    entity: resolved.entity,
    ...gl,
  };
}

function buildStockLedger(db, { product_id, warehouse_id, from, to } = {}, { stripCost = false } = {}) {
  const pid = parseInt(product_id, 10);
  if (!Number.isFinite(pid) || pid <= 0) throw LedgerError(400, 'شناسه کالا الزامی است');
  const product = db.prepare('SELECT id, name, code, unit, stock FROM products WHERE id=?').get(pid);
  if (!product) throw LedgerError(404, 'محصول یافت نشد');

  const whId = warehouse_id != null && String(warehouse_id) !== ''
    ? parseInt(warehouse_id, 10) : null;
  if (warehouse_id != null && String(warehouse_id) !== '' && (!Number.isFinite(whId) || whId <= 0)) {
    throw LedgerError(400, 'شناسه انبار نامعتبر است');
  }

  if (!tableExists(db, 'inventory_ledger')) {
    throw LedgerError(404, 'دفتر موجودی یافت نشد');
  }

  const where = ["l.product_id=?", "l.status IN ('posted','reversed')"];
  const params = [pid];
  if (whId) { where.push('l.warehouse_id=?'); params.push(whId); }

  const rows = db.prepare(`
    SELECT l.*, w.name AS warehouse_name
    FROM inventory_ledger l
    LEFT JOIN warehouses w ON l.warehouse_id=w.id
    WHERE ${where.join(' AND ')}
    ORDER BY l.date ASC, l.id ASC
  `).all(...params);

  const posted = rows.filter((r) => r.status === 'posted');
  let opening_qty = 0;
  if (from) {
    for (const r of posted) {
      if ((r.date || '') < from) {
        opening_qty += (Number(r.qty_in) || 0) - (Number(r.qty_out) || 0);
      }
    }
  }

  let period_qty_in = 0;
  let period_qty_out = 0;
  let running = opening_qty;
  const lines = [];
  for (const r of posted) {
    if (from && (r.date || '') < from) continue;
    if (to && (r.date || '') > to) continue;
    const qIn = Number(r.qty_in) || 0;
    const qOut = Number(r.qty_out) || 0;
    period_qty_in += qIn;
    period_qty_out += qOut;
    running += qIn - qOut;
    const srcType = r.source_type || r.event_type || null;
    const link = safeSourceLink({
      ref_type: srcType,
      ref_id: r.source_id,
      journal_id: r.je_id,
    });
    lines.push({
      id: r.id,
      date: r.date,
      description: r.note || r.event_type || '',
      event_type: r.event_type,
      warehouse_id: r.warehouse_id,
      warehouse_name: r.warehouse_name || '',
      qty_in: qIn,
      qty_out: qOut,
      running_qty: running,
      unit_cost_rial: r.unit_cost_rial,
      amount_rial: r.amount_rial,
      source: 'inventory_ledger',
      ...link,
    });
  }

  const period_net_qty = period_qty_in - period_qty_out;
  const closing_qty = opening_qty + period_net_qty;

  let warehouse_qty = null;
  if (whId && tableExists(db, 'warehouse_stock')) {
    const ws = db.prepare(
      'SELECT qty FROM warehouse_stock WHERE product_id=? AND warehouse_id=?'
    ).get(pid, whId);
    warehouse_qty = ws ? Number(ws.qty) || 0 : 0;
  }

  let payload = {
    entity_type: 'product',
    entity_id: pid,
    product: {
      id: product.id,
      name: product.name,
      code: product.code,
      unit: product.unit,
      stock: Number(product.stock) || 0,
    },
    warehouse_id: whId,
    warehouse_qty,
    opening_qty,
    period_qty_in,
    period_qty_out,
    period_net_qty,
    closing_qty,
    lines,
    source: 'inventory_ledger',
  };
  if (stripCost) payload = stripCostFields(payload);
  return payload;
}

function csvEsc(v) {
  return `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
}

function financialToCsv(data) {
  const headers = ['تاریخ', 'شرح', 'منبع', 'مرجع', 'سند', 'بدهکار', 'بستانکار', 'مانده'];
  const lines = [headers.map(csvEsc).join(',')];
  for (const l of data.lines || []) {
    lines.push([
      l.date, l.description, l.source,
      l.ref_type ? `${l.ref_type}${l.ref_id != null ? '#' + l.ref_id : ''}` : '',
      l.journal_id || '',
      l.debit_rial, l.credit_rial, l.running_balance,
    ].map(csvEsc).join(','));
  }
  lines.push('');
  lines.push(['مانده اول دوره', '', '', '', '', '', '', data.opening_rial].map(csvEsc).join(','));
  lines.push([
    'جمع دوره', '', '', '', '',
    data.period_debit_rial, data.period_credit_rial, data.closing_rial,
  ].map(csvEsc).join(','));
  lines.push(['گردش خالص دوره', '', '', '', '', '', '', data.period_net_rial].map(csvEsc).join(','));
  lines.push(['مانده پایان دوره', '', '', '', '', '', '', data.closing_rial].map(csvEsc).join(','));
  return lines.join('\n');
}

function stockToCsv(data) {
  const headers = ['تاریخ', 'شرح', 'نوع', 'ورود', 'خروج', 'مانده'];
  const lines = [headers.map(csvEsc).join(',')];
  for (const l of data.lines || []) {
    lines.push([
      l.date, l.description, l.event_type, l.qty_in, l.qty_out, l.running_qty,
    ].map(csvEsc).join(','));
  }
  lines.push('');
  lines.push(['مانده اول دوره', '', '', '', '', data.opening_qty].map(csvEsc).join(','));
  lines.push([
    'جمع دوره', '', '',
    data.period_qty_in, data.period_qty_out, data.closing_qty,
  ].map(csvEsc).join(','));
  lines.push(['گردش خالص دوره', '', '', '', '', data.period_net_qty].map(csvEsc).join(','));
  lines.push(['مانده پایان دوره', '', '', '', '', data.closing_qty].map(csvEsc).join(','));
  return lines.join('\n');
}

function parseCsvTotals(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const cells = [];
    const re = /"((?:[^"]|"")*)"/g;
    let m;
    while ((m = re.exec(line))) cells.push(m[1].replace(/""/g, '"'));
    if (cells[0] === 'مانده اول دوره') out.opening = Number(cells[cells.length - 1]);
    if (cells[0] === 'جمع دوره') {
      out.period_debit = Number(cells[5]);
      out.period_credit = Number(cells[6]);
      out.period_in = Number(cells[3]);
      out.period_out = Number(cells[4]);
      out.closing = Number(cells[cells.length - 1]);
    }
    if (cells[0] === 'گردش خالص دوره') out.period_net = Number(cells[cells.length - 1]);
    if (cells[0] === 'مانده پایان دوره') out.closing = Number(cells[cells.length - 1]);
  }
  return out;
}

module.exports = {
  ENTITY_TYPES,
  LedgerError,
  safeJalaliDate,
  assertJalaliQuery,
  signMove,
  safeSourceLink,
  buildAccountLedger,
  buildFinancialLedger,
  buildStockLedger,
  financialToCsv,
  stockToCsv,
  parseCsvTotals,
};
