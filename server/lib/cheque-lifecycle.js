'use strict';
/**
 * Canonical cheque lifecycle (Iranian notes receivable / payable).
 *
 * Received (direction=in):
 *   registered → in_collection (واگذاری به بانک) → cleared (وصول)
 *              ↘ endorsed (خرج/ظهرنویسی)
 *   in_collection|cleared → bounced (برگشت) → (resend) prior state
 *
 * Issued (direction=out):
 *   registered → issued (پرداخت/تحویل) | expensed (خرج چک)
 *
 * Alias: legacy invoice path wrote lifecycle_status='in_hand' (= نزد صندوق).
 * That is NOT deposited; it must behave as registered until send-to-bank.
 */

const OPENING_NOTE = 'مانده اول دوره';

/** States that mean «نزد صندوق / ثبت‌شده» — eligible for واگذاری/خرج/پرداخت. */
const REGISTERED_ALIASES = new Set(['', 'registered', 'in_hand', 'pending']);

const ACTIVE_LIFECYCLE_IN = new Set(['in_collection', 'cleared', 'bounced', 'endorsed']);
const ACTIVE_LIFECYCLE_OUT = new Set(['issued', 'expensed', 'endorsed']);

const CLOSED_IN = new Set(['cleared', 'bounced', 'cancelled', 'void', 'paid', 'reversed', 'endorsed']);
const CLOSED_OUT = new Set(['cleared', 'cancelled', 'void', 'paid', 'issued', 'expensed', 'reversed', 'endorsed']);

/** Free-text status that implies a financial transition (must use lifecycle endpoints). */
const FINANCIAL_STATUS_RE = /وصول|برگشت|واگذار|خواباندن|در\s*جریان\s*وصول|نزد\s*بانک|cleared|bounced|received|in[_ ]?collection|send[_ -]?to[_ -]?bank|resend|واگذارى|پرداخت|خرج|صدور|issued|expensed|endorsed|endorse|expense/i;

const STATUS_LABEL = {
  registered: 'نزد صندوق',
  in_hand: 'نزد صندوق',
  pending: 'نزد صندوق',
  in_collection: 'واگذارشده',
  cleared: 'وصول‌شده',
  bounced: 'برگشتی',
  endorsed: 'خرج‌شده',
  issued: 'پرداخت‌شده',
  expensed: 'خرج‌شده',
  reversed: 'ابطال‌شده',
};

function lifecycleOf(rowOrLc) {
  if (rowOrLc == null) return '';
  if (typeof rowOrLc === 'string') return String(rowOrLc).trim();
  return String(rowOrLc.lifecycle_status || '').trim();
}

function isRegistered(rowOrLc) {
  return REGISTERED_ALIASES.has(lifecycleOf(rowOrLc));
}

/** Map aliases → canonical machine state. */
function normalizeLifecycle(rowOrLc) {
  const lc = lifecycleOf(rowOrLc);
  if (REGISTERED_ALIASES.has(lc)) return 'registered';
  return lc || 'registered';
}

function statusLabelFor(lc) {
  const n = normalizeLifecycle(lc);
  return STATUS_LABEL[n] || STATUS_LABEL[lc] || lc || 'نزد صندوق';
}

function isOpeningCheque(row) {
  const note = String(row && row.note || '');
  const status = String(row && row.status || '');
  return !!(row && row.journal_entry_id && (note.includes(OPENING_NOTE) || status.includes('اول دوره')));
}

/**
 * SQL fragment: lifecycle column is registered (incl. legacy in_hand).
 * @param {string} col  column expression, e.g. 'lifecycle_status' or 'COALESCE(lifecycle_status,\"\")'
 */
function sqlIsRegistered(col = 'lifecycle_status') {
  return `(${col} IS NULL OR TRIM(COALESCE(${col},'')) IN ('','registered','in_hand','pending'))`;
}

function tableHasColumn(db, table, col) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
  } catch (_) {
    return false;
  }
}

/**
 * Boot repair: normalize orphan invoice aliases + misleading free-text deposit labels
 * that were typed without a collection JE.
 * Must run AFTER cheque collection_* columns exist (gap-accounting-schema / ensureColumn).
 */
function repairChequeLifecycleAliases(db) {
  if (!db) return { skipped: true };
  if (!tableHasColumn(db, 'cheque_records', 'lifecycle_status')) {
    return { skipped: true, reason: 'no_lifecycle' };
  }
  const FLAG = 'cheque_lifecycle_alias_v303b';
  const flag = db.prepare('SELECT value FROM settings WHERE key=?').get(FLAG);
  if (flag && flag.value === '1') return { skipped: true };

  let aliasFixed = 0;
  let statusFixed = 0;

  const a = db.prepare(`
    UPDATE cheque_records
    SET lifecycle_status='registered'
    WHERE COALESCE(record_status,'posted')<>'reversed'
      AND TRIM(COALESCE(lifecycle_status,'')) IN ('in_hand','pending')
  `).run();
  aliasFixed = a.changes || 0;

  // Free-text «خواباندن…» without real send-to-bank is not deposit — restore نزد صندوق.
  const hasCollectionJe = tableHasColumn(db, 'cheque_records', 'collection_je_id');
  const noCollection = hasCollectionJe
    ? 'AND COALESCE(collection_je_id,0)=0'
    : "AND TRIM(COALESCE(lifecycle_status,'')) NOT IN ('in_collection','cleared','bounced','endorsed')";
  const s = db.prepare(`
    UPDATE cheque_records
    SET status='نزد صندوق'
    WHERE COALESCE(record_status,'posted')<>'reversed'
      AND ${sqlIsRegistered('lifecycle_status')}
      ${noCollection}
      AND (
        status LIKE '%خواباندن%'
        OR status LIKE '%در جریان وصول%'
        OR LOWER(COALESCE(status,'')) LIKE '%in_collection%'
      )
  `).run();
  statusFixed = s.changes || 0;

  db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run(FLAG, '1');
  return { skipped: false, aliasFixed, statusFixed };
}

module.exports = {
  OPENING_NOTE,
  REGISTERED_ALIASES,
  ACTIVE_LIFECYCLE_IN,
  ACTIVE_LIFECYCLE_OUT,
  CLOSED_IN,
  CLOSED_OUT,
  FINANCIAL_STATUS_RE,
  STATUS_LABEL,
  lifecycleOf,
  isRegistered,
  normalizeLifecycle,
  statusLabelFor,
  isOpeningCheque,
  sqlIsRegistered,
  repairChequeLifecycleAliases,
};
