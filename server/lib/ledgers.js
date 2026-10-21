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
const { personLedgerLineRial } = require('./person-ledger-money');
const { sortReportRows } = require('./report-order');

const JE_ALIVE = `${DELETED_FILTER} AND COALESCE(je.status,'posted')<>'reversed'`;

const ENTITY_TYPES = ['person', 'bank', 'cash', 'petty', 'account'];

/** Caller already has GET for these ref_type values (admin/accounting). */
const SAFE_REF_TYPES = new Set([
  'invoice', 'purchase', 'stocktaking', 'product',
  'journal', 'manual_voucher', 'voucher', 'settlement',
  'warehouse_move', 'transfer', 'expense', 'opening',
  'opening_balance', 'person',
  'warehouse_doc', 'warehouse_transfer',
]);

/** Source types that may collapse multi-SKU lines into one parent row. */
const STOCK_AGGREGATE_SOURCES = new Set([
  'invoice', 'purchase', 'warehouse_transfer', 'warehouse_move',
  'sales_return', 'purchase_return', 'sales_return_invoice',
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
  sortReportRows(periodLines, { date: 'entry_date', dir: 'asc', ties: ['journal_id', 'id'] });

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
  sortReportRows(all, { date: 'date', dir: 'asc' });

  let running = 0;
  const tagged = all.map((e) => {
    const amt = personLedgerLineRial(db, e);
    const dr = amt.debit;
    const cr = amt.credit;
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

function isStockLedgerGhost(r) {
  const qIn = Number(r.qty_in) || 0;
  const qOut = Number(r.qty_out) || 0;
  const amt = Math.round(Number(r.amount_rial) || 0);
  return qIn === 0 && qOut === 0 && amt === 0;
}

/** Strip ZWNJ/spaces + Arabic Yeh/Kaf so «هم‌ترازی» / «همترازي» match the same. */
function normalizeAuditText(s) {
  return String(s || '')
    .replace(/\u200c/g, '')
    .replace(/ي/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/\s+/g, '');
}

/** Normalize Persian letters without collapsing spaces (for opening note prefixes). */
function normalizeFaLetters(s) {
  return String(s || '')
    .replace(/\u200c/g, '')
    .replace(/ي/g, 'ی')
    .replace(/ك/g, 'ک');
}

/** Journal/doc description that is void or technical alignment (operational hide). */
function isAuditOnlyJournalDescription(desc) {
  const raw = normalizeFaLetters(String(desc || '').trim());
  if (!raw) return false;
  if (/^\[?ابطال/.test(raw)) return true;
  return normalizeAuditText(raw).includes('همترازی');
}

/**
 * Inventory ledger rows that stay in the economic stream (balances) but are
 * hidden from the operational kardex table unless audit toggle is on.
 * — event_type=reversal / *_reversal (posted reverse of a void)
 * — status=reversed (original that was voided)
 * — source_type=stock_reconcile or note containing هم‌ترازی / ابطال…
 * — legacy void pairs: original production_receipt still posted while twin
 *   «ابطال رسید PO-…» outbound exists (pre-v402 reverseOrder bug)
 */
/**
 * Both sides of a void: the original (status reversed) and the posted opposite
 * row. Live reports drop the pair so qty and value are not counted twice and
 * a cancelled receipt does not stay in the running balance.
 */
function isVoidPairStockRow(r, extraHideIds) {
  if (!r) return false;
  if (extraHideIds && extraHideIds.has(r.id)) return true;
  if (String(r.status || '') === 'reversed') return true;
  const et = String(r.event_type || '');
  if (et === 'reversal' || et.endsWith('_reversal')) return true;
  if (String(r.source_type || '').endsWith('_reversal')) return true;
  if (r.reversed_of) return true;
  const note = String(r.note || r.description || '').trim();
  if (/^\[?ابطال/.test(note)) return true;
  return false;
}

/** Beginning stock document — belongs in اول دوره, not in period turnover. */
function isOpeningStockRow(r) {
  if (!r || isVoidPairStockRow(r)) return false;
  const et = String(r.event_type || '');
  if (et === 'opening') return true;
  if (String(r.source_type || '') === 'opening_inventory') return true;
  const note = normalizeFaLetters(String(r.note || r.description || '').trim());
  if (/^بهای اولیه موجودی/.test(note)) return true;
  if (/^موجودی اول دوره/.test(note)) return true;
  // Excel absolute-stock seed uses the same opening movement with a different note.
  if (/^موجودی اکسل/.test(note)) return true;
  return false;
}

/**
 * Audit-only = void twin OR mid-period stock_reconcile / هم‌ترازی noise.
 * Opening seeds that happen to say «هم‌ترازی» in the note stay economic openings
 * (they must not fall into the alignOnly dead-zone that freezes running_qty).
 */
function isAuditOnlyStockRow(r, extraHideIds) {
  if (!r) return false;
  if (isVoidPairStockRow(r, extraHideIds)) return true;
  if (isOpeningStockRow(r)) return false;
  if (String(r.source_type || '') === 'stock_reconcile') return true;
  const note = String(r.note || r.description || '');
  if (isAuditOnlyJournalDescription(note)) return true;
  return false;
}

/**
 * Hide both sides of legacy production void pairs that lack reversed_of.
 * reverseStage used to leave the original production_issue posted and only
 * post a twin «ابطال مرحله N — PO-…» return. Manual حواله often has no PO in
 * the note — match by stage number + product (and PO token when present).
 */
function collectLegacyVoidedReceiptIds(rows, db) {
  const hide = new Set();
  const posted = (rows || []).filter((r) => String(r.status || '') === 'posted');
  const isStageIssueRow = (o) => {
    const oEt = String(o.event_type || '');
    const oNote = String(o.note || '').trim();
    return oEt === 'production_issue'
      || /^مرحله\s*\d+/.test(oNote)
      || /^حواله\s*مرحله\s*\d+/.test(oNote)
      || /^حواله\s*MI-/i.test(oNote)
      || /^مصرف\s/.test(oNote);
  };
  const orderIdByToken = new Map();
  const resolveOrderId = (token) => {
    if (!token || !db) return null;
    if (orderIdByToken.has(token)) return orderIdByToken.get(token);
    let id = null;
    try {
      id = db.prepare(
        'SELECT id FROM production_orders WHERE order_no=? COLLATE NOCASE LIMIT 1'
      ).get(token)?.id || null;
    } catch (_) { id = null; }
    orderIdByToken.set(token, id);
    return id;
  };
  for (const rev of posted) {
    const et = String(rev.event_type || '');
    const note = String(rev.note || '').trim();
    const isVoidNote = /^\[?ابطال/.test(note);
    const isProdVoid = et === 'production_receipt_reversal'
      || et === 'production_return'
      || (et.endsWith('_reversal') && /ابطال/.test(note))
      || isVoidNote;
    if (!isProdVoid) continue;
    hide.add(rev.id);
    if (rev.reversed_of) hide.add(rev.reversed_of);
    const token = (note.match(/PO-\d+/i) || note.match(/PR-\d+/i) || [])[0];
    const stageSeq = (note.match(/مرحله\s*(\d+)/) || [])[1] || null;
    const orderId = resolveOrderId(token);
    const qTwin = (Number(rev.qty_in) || 0) || (Number(rev.qty_out) || 0);
    for (const o of posted) {
      if (o.id === rev.id) continue;
      if (Number(o.product_id) && Number(rev.product_id)
        && Number(o.product_id) !== Number(rev.product_id)) continue;
      const oNote = String(o.note || '');
      const oEt = String(o.event_type || '');
      const isReceipt = oEt === 'production_receipt';
      if (isReceipt) {
        if (token && oNote.includes(token)) hide.add(o.id);
        continue;
      }
      if (!isStageIssueRow(o)) continue;
      const qOrig = (Number(o.qty_out) || 0) || (Number(o.qty_in) || 0);
      const sameOrder = orderId != null && Number(o.source_id) === Number(orderId);
      const sameToken = !!(token && oNote.includes(token));
      if (sameToken || sameOrder) {
        if (stageSeq) {
          const oStage = (oNote.match(/مرحله\s*(\d+)/) || [])[1];
          if (oStage && oStage !== stageSeq) continue;
        }
        if (qTwin > 0 && qOrig > 0 && Math.abs(qTwin - qOrig) > 1e-3 && !sameToken) continue;
        hide.add(o.id);
        continue;
      }
      // حواله مرحله N without PO — pair by stage + qty on the same product.
      if (stageSeq) {
        const oStage = (oNote.match(/مرحله\s*(\d+)/) || [])[1];
        if (oStage !== stageSeq) continue;
        if (qTwin > 0 && qOrig > 0 && Math.abs(qTwin - qOrig) > 1e-3) continue;
        hide.add(o.id);
      }
    }
  }
  return hide;
}

/**
 * Collapse multi-SKU movements of the same business document into one parent
 * row with details[] for drill-down (transfer WH-####, invoice T-####, …).
 * Running balances stay on the parent (last child in the group).
 */
function stockLineGroupKey(line) {
  const dir = (Number(line.qty_in) || 0) > 0 ? 'in'
    : ((Number(line.qty_out) || 0) > 0 ? 'out' : 'zero');
  const wh = line.warehouse_id != null ? String(line.warehouse_id) : '';
  if (line.wh_doc_id) {
    return `wd:${line.wh_doc_id}:${wh}:${dir}`;
  }
  const st = String(line.source_type || '');
  if (STOCK_AGGREGATE_SOURCES.has(st) && line.source_id != null && line.source_id !== '') {
    return `src:${st}:${line.source_id}:${wh}:${dir}`;
  }
  return `id:${line.id}`;
}

/** Kardex wording: document type + number only; colour/size live in details[]. */
function shortStockDescription(r) {
  const st = String(r.source_type || '');
  const et = String(r.event_type || '');
  if (st === 'stock_reconcile') return 'تعدیل موجودی';
  if (isOpeningStockRow(r)) return 'موجودی اول دوره';
  let note = normalizeFaLetters(String(r.note || r.description || et || '').trim());
  if (normalizeAuditText(note).includes('همترازی')) return 'تعدیل موجودی';
  note = note.replace(/\s*—\s*اصلاح فاکتور\s*$/, '');
  note = note.replace(/فاکتور (معمولی|رسمی|فروش)\s+/, '');
  note = note.replace(/\s*\([^)]*\)\s*$/, '');
  return note.trim() || et;
}

function enrichInvoiceGroupDetails(db, productId, parent) {
  if (String(parent.source_type || '') !== 'invoice' || !parent.source_id) return;
  try {
    const inv = db.prepare('SELECT id, num, rows FROM invoices WHERE id=?').get(parent.source_id);
    if (!inv) return;
    if (inv.num) {
      parent.doc_num = inv.num;
      parent.tx_no = inv.num;
      parent.description = (Number(parent.qty_in) || 0) > 0 && !(Number(parent.qty_out) || 0)
        ? `برگشت فروش ${inv.num}`
        : `فروش ${inv.num}`;
    }
    // Ledger-aggregated children already carry true qty_out/in — never replace
    // them with invoice JSON (pack matrix often repeats line qty per color).
    if (Array.isArray(parent.child_ids) && parent.child_ids.length > 1
      && Array.isArray(parent.details) && parent.details.length > 1) {
      return;
    }
    let rows = [];
    try { rows = JSON.parse(inv.rows || '[]'); } catch (_) { rows = []; }
    const parts = (rows || []).filter((r) => Number(r.product_id) === Number(productId));
    if (parts.length <= 1) return;
    const parentOut = Number(parent.qty_out) || 0;
    const parentIn = Number(parent.qty_in) || 0;
    const invSumOut = parts.reduce((s, r) => s + (Number(r.qty) || 0), 0);
    const parentQty = parentOut > 0 ? parentOut : parentIn;
    // Only explode when invoice line qtys sum to the ledger parent — otherwise
    // details would show 2+2+2+2 while parent shows 2.
    if (Math.abs(invSumOut - parentQty) > 1e-6) return;
    parent.details = parts.map((r, i) => ({
      id: `${parent.id}-inv-${i}`,
      tx_no: inv.num || parent.tx_no,
      qty_in: parentIn > 0 ? (Number(r.qty) || 0) : 0,
      qty_out: parentOut > 0 ? (Number(r.qty) || 0) : 0,
      color_name: r.color_name || r.color || null,
      size_name: r.size_name || null,
      description: [r.color_name || r.color, r.size_name].filter(Boolean).join(' / ') || parent.description,
    }));
    parent.is_group = true;
    parent.detail_count = parent.details.length;
  } catch (_) { /* optional */ }
}

function aggregateStockLedgerLines(db, lines, productId) {
  if (!Array.isArray(lines) || lines.length < 2) return lines || [];
  const buckets = new Map();
  const order = [];
  for (const line of lines) {
    const key = stockLineGroupKey(line);
    if (!buckets.has(key)) {
      buckets.set(key, []);
      order.push(key);
    }
    buckets.get(key).push(line);
  }
  const out = [];
  for (const key of order) {
    const group = buckets.get(key);
    if (!group || group.length === 1) {
      const one = group[0];
      if (one && String(one.source_type || '') === 'invoice') {
        enrichInvoiceGroupDetails(db, productId, one);
      }
      out.push(one);
      continue;
    }
    if (key.startsWith('id:')) {
      for (const g of group) out.push(g);
      continue;
    }
    const first = group[0];
    const last = group[group.length - 1];
    let qtyIn = 0;
    let qtyOut = 0;
    let amount = 0;
    const details = group.map((g) => {
      qtyIn += Number(g.qty_in) || 0;
      qtyOut += Number(g.qty_out) || 0;
      amount += Number(g.amount_rial) || 0;
      return {
        id: g.id,
        tx_no: g.tx_no,
        qty_in: g.qty_in,
        qty_out: g.qty_out,
        color_name: g.color_name || null,
        size_name: g.size_name || null,
        variant_sku: g.variant_sku || null,
        description: g.description,
        unit_cost_rial: g.unit_cost_rial,
        amount_rial: g.amount_rial,
      };
    });
    const docNum = first.wh_doc_num || null;
    const parent = {
      ...first,
      qty_in: qtyIn,
      qty_out: qtyOut,
      amount_rial: amount,
      unit_cost_rial: (qtyIn || qtyOut)
        ? Math.round(amount / (qtyIn || qtyOut))
        : first.unit_cost_rial,
      running_qty: last.running_qty,
      warehouse_running_qty: last.warehouse_running_qty,
      tx_no: docNum || first.tx_no,
      doc_num: docNum,
      is_group: true,
      detail_count: details.length,
      details,
      child_ids: group.map((g) => g.id),
    };
    if (String(parent.source_type || '') === 'invoice') {
      enrichInvoiceGroupDetails(db, productId, parent);
    }
    out.push(parent);
  }
  return out;
}

function buildStockLedger(db, {
  product_id, warehouse_id, from, to, event_type,
} = {}, { stripCost = false } = {}) {
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

  const eventFilter = event_type != null && String(event_type).trim() !== ''
    ? String(event_type).trim()
    : null;

  const where = ["l.product_id=?", "l.status IN ('posted','reversed')"];
  const params = [pid];
  if (whId) { where.push('l.warehouse_id=?'); params.push(whId); }

  const hasWhMoves = tableExists(db, 'warehouse_moves');
  const hasWhDocs = tableExists(db, 'warehouse_docs');
  const hasVariants = tableExists(db, 'product_variants');
  // source_id on WH docs = warehouse_moves.id (both in/out of a transfer share it).
  const moveJoin = hasWhMoves
    ? `LEFT JOIN warehouse_moves wm ON (
         l.source_type IN ('warehouse_transfer','warehouse_move','warehouse_receipt','warehouse_issue')
         AND wm.id = l.source_id
       )`
    : '';
  const docJoin = hasWhMoves && hasWhDocs
    ? 'LEFT JOIN warehouse_docs wd ON wd.id = wm.doc_id'
    : '';
  const variantJoin = hasWhMoves && hasVariants
    ? `LEFT JOIN product_variants pv ON pv.id = wm.variant_id
       LEFT JOIN product_colors pcol ON pcol.id = pv.color_id
       LEFT JOIN product_sizes psz ON psz.id = pv.size_id`
    : '';
  const rows = db.prepare(`
    SELECT l.*, w.name AS warehouse_name, u.name AS user_name
      ${hasWhMoves ? ', wm.doc_id AS wh_doc_id, wm.variant_id AS move_variant_id, wm.line_no AS move_line_no' : ''}
      ${hasWhDocs ? ', wd.num AS wh_doc_num, wd.type AS wh_doc_type' : ''}
      ${hasVariants ? ', pcol.name AS color_name, psz.name AS size_name, pv.sku AS variant_sku' : ''}
    FROM inventory_ledger l
    LEFT JOIN warehouses w ON l.warehouse_id=w.id
    LEFT JOIN users u ON l.created_by=u.id
    ${moveJoin}
    ${docJoin}
    ${variantJoin}
    WHERE ${where.join(' AND ')}
    ORDER BY l.date ASC, l.id ASC
  `).all(...params);
  sortReportRows(rows, { date: 'date', dir: 'asc' });

  let isWarehouseOnlyRow = () => false;
  let isZeroQtyValueGhost = isStockLedgerGhost;
  try {
    const invLed = require('./inventory/ledger');
    isWarehouseOnlyRow = invLed.isWarehouseOnlyRow || isWarehouseOnlyRow;
    if (typeof invLed.isZeroQtyValueGhost === 'function') {
      isZeroQtyValueGhost = invLed.isZeroQtyValueGhost;
    }
  } catch (_) { /* optional */ }

  const legacyVoidHideIds = collectLegacyVoidedReceiptIds(rows, db);

  // WIP (کار در جریان) is a production stage, not goods on hand: its rows
  // belong to production reports. Only an explicit WIP-warehouse filter shows them.
  let wipWarehouseIds = new Set();
  try {
    wipWarehouseIds = new Set(db.prepare(
      "SELECT id FROM warehouses WHERE kind='wip' OR warehouse_type='wip'"
    ).all().map((w) => Number(w.id)));
  } catch (_) { wipWarehouseIds = new Set(); }
  const wipView = whId != null && wipWarehouseIds.has(whId);
  const isProductionStageRow = (r) => !wipView && (
    isWarehouseOnlyRow(r) || wipWarehouseIds.has(Number(r.warehouse_id))
  );
  // Kardex is quantity-based: value-only revaluations (qty 0) live in costing reports.
  const isValueOnlyRow = (r) => !(Number(r.qty_in) || 0) && !(Number(r.qty_out) || 0);

  // One live stream: every posted movement except void pairs, production-stage
  // rows and value-only revaluations. No hidden rows feed the balance.
  const economic = rows.filter((r) => (
    r.status === 'posted'
    && !isZeroQtyValueGhost(r)
    && !isValueOnlyRow(r)
    && !isProductionStageRow(r)
    && !isVoidPairStockRow(r, legacyVoidHideIds)
    && (!eventFilter || r.event_type === eventFilter)
  ));

  let fyStart = null;
  try {
    fyStart = require('./opening-post').fiscalOpeningDate(db);
  } catch (_) { fyStart = null; }

  const countsAsOpening = (r) => {
    if (!from || !isOpeningStockRow(r)) return false;
    const d = r.date || '';
    if (d < from) return false; // already in opening via «before» loop
    if (to && d > to) return false;
    if (d <= from) return true;
    if (fyStart && d === fyStart && from <= fyStart) return true;
    return true;
  };

  let opening_qty = 0;
  if (from) {
    for (const r of economic) {
      const before = (r.date || '') < from;
      if (!before && !countsAsOpening(r)) continue;
      opening_qty += (Number(r.qty_in) || 0) - (Number(r.qty_out) || 0);
    }
  }

  let period_qty_in = 0;
  let period_qty_out = 0;
  let running = opening_qty;
  const lines = [];

  for (const r of economic) {
    if (from && (r.date || '') < from) continue;
    if (to && (r.date || '') > to) continue;
    if (countsAsOpening(r)) continue; // already in «اول دوره»
    const qIn = Number(r.qty_in) || 0;
    const qOut = Number(r.qty_out) || 0;
    period_qty_in += qIn;
    period_qty_out += qOut;
    running += qIn - qOut;
    const srcType = r.source_type || r.event_type || null;
    const whDocId = r.wh_doc_id != null ? Number(r.wh_doc_id) : null;
    const hasWhDoc = Number.isFinite(whDocId) && whDocId > 0;
    const link = safeSourceLink({
      ref_type: hasWhDoc ? 'warehouse_doc' : srcType,
      ref_id: hasWhDoc ? whDocId : r.source_id,
      journal_id: r.je_id,
    });
    lines.push({
      id: r.id,
      tx_no: r.tx_no || null,
      date: r.date,
      description: shortStockDescription(r),
      event_type: r.event_type,
      warehouse_id: r.warehouse_id,
      warehouse_name: r.warehouse_name || '',
      qty_in: qIn,
      qty_out: qOut,
      running_qty: running,
      unit_cost_rial: r.unit_cost_rial,
      amount_rial: r.amount_rial,
      status: 'posted',
      is_opening: isOpeningStockRow(r),
      user_name: r.user_name || '',
      source_type: r.source_type || null,
      source_id: r.source_id || null,
      wh_doc_id: hasWhDoc ? whDocId : null,
      wh_doc_num: r.wh_doc_num || null,
      color_name: r.color_name || null,
      size_name: r.size_name || null,
      variant_sku: r.variant_sku || null,
      source: 'inventory_ledger',
      ...link,
    });
  }

  const aggregated = aggregateStockLedgerLines(db, lines, pid).slice();
  lines.length = 0;
  for (const row of aggregated) lines.push(row);

  const period_net_qty = period_qty_in - period_qty_out;
  const closing_qty = opening_qty + period_net_qty;

  // Physical stock card (warehouse_stock) must equal the ledger. Any gap is
  // reported, never silently aligned — it is settled by a stock count document.
  let warehouse_qty = null;
  if (tableExists(db, 'warehouse_stock')) {
    if (whId) {
      const ws = db.prepare(
        'SELECT qty FROM warehouse_stock WHERE product_id=? AND warehouse_id=?'
      ).get(pid, whId);
      warehouse_qty = ws ? Number(ws.qty) || 0 : 0;
    } else {
      const ids = [...wipWarehouseIds];
      const ws = db.prepare(`
        SELECT COALESCE(SUM(qty),0) AS q FROM warehouse_stock
        WHERE product_id=? ${ids.length ? `AND warehouse_id NOT IN (${ids.map(() => '?').join(',')})` : ''}
      `).get(pid, ...ids);
      warehouse_qty = Number(ws?.q) || 0;
    }
  }
  const book_gap_qty = (!to && !eventFilter && warehouse_qty != null)
    ? Math.round((closing_qty - warehouse_qty) * 1000) / 1000
    : 0;

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
    book_gap_qty,
    opening_qty,
    period_qty_in,
    period_qty_out,
    period_net_qty,
    control_gap_qty: 0,
    live_period: true,
    closing_qty,
    closing_warehouse_qty: closing_qty,
    event_type: eventFilter,
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
  isAuditOnlyStockRow,
  isVoidPairStockRow,
  isOpeningStockRow,
  isAuditOnlyJournalDescription,
  buildAccountLedger,
  buildFinancialLedger,
  buildStockLedger,
  aggregateStockLedgerLines,
  stockLineGroupKey,
  financialToCsv,
  stockToCsv,
  parseCsvTotals,
};
