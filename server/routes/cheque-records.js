const router = require('express').Router();
const { getDB, audit } = require('../db');
const {
  auth, adminOrAccounting, requireChequeOperate, requireChequeHighValueApprove,
} = require('../middleware/auth');
const { postToLedger } = require('../lib/ledger');
const { acct } = require('../lib/coa-map');
const { todayJalali } = require('../jalali');
const { voidChequeRecord } = require('../lib/void-cheque');
const { reverseJournalEntry } = require('../lib/void-journal');
const { assertJournalIdempotent } = require('../lib/sales-document');
const { postChequeInReceipt, postChequeBounce, reverseChequeLedgerByRef } = require('../lib/cheque-party-books');
const {
  OPENING_NOTE,
  FINANCIAL_STATUS_RE,
  ACTIVE_LIFECYCLE_IN,
  ACTIVE_LIFECYCLE_OUT,
  lifecycleOf,
  isRegistered,
  isOpeningCheque,
  sqlIsRegistered,
} = require('../lib/cheque-lifecycle');
const { syncSettlementChequeStatus } = require('../lib/cheque-due');
const { enrichChequeRow, buildChequeHistory } = require('../lib/cheque-history');
const {
  validateSayadi, chequeQualityFlags, QUALITY_LABEL_FA,
  buildDupSayadSet, buildAdminNameSet, daysUntilDue,
} = require('../lib/cheque-quality');
const { runChequeRegister, runChequeSummary } = require('../lib/cheque-register-query');
const { buildChequeDashboardKpis } = require('../lib/cheque-dashboard');
const { buildChequeReconciliation, buildOpeningChequeReconciliation, tableHasColumn } = require('../lib/cheque-reconciliation');
const {
  returnToDrawer, endorseReturn, outClear, outBounce, outVoid, replaceCheque,
  reverseLastEvent, markGuarantee, protestCheque, transferProtestToCustomer,
} = require('../lib/cheque-lifecycle-actions');
const {
  runBatchChequeAction, sendChequeToBank, ensureDepositSlipColumn,
} = require('../lib/cheque-batch');
const { allowedTargets, STATUS_LABEL } = require('../lib/cheque-lifecycle');
const { ExcelJS } = require('../lib/excel-io');
const { insertChequeEvent } = require('../lib/cheque-events');
const {
  isTruthyOpening, assertBranchNotPlaceholder, previewOpeningImport,
} = require('../lib/cheque-opening-import');
const { createSecureUpload } = require('../lib/upload-policy');
const { readWorkbook, XLSX } = require('../lib/excel-safe');

const openingImportUpload = createSecureUpload('xlsx');

function optionalOpeningXlsx(req, res, next) {
  const ct = String((req.headers && req.headers['content-type']) || '');
  if (ct.includes('multipart/form-data')) {
    return openingImportUpload.single('file')(req, res, next);
  }
  return next();
}

/** Defensive ensure — schema agent / Phase 2A may already have these. */
function ensureChequeLegalColumns(db) {
  const cols = [
    ['sayad_tracking_code', "TEXT DEFAULT ''"],
    ['beneficiary_national_id', "TEXT DEFAULT ''"],
    ['is_guarantee', 'INTEGER DEFAULT 0'],
    ['leaf_id', 'INTEGER'],
    ['deposit_slip_no', "TEXT DEFAULT ''"],
  ];
  for (const [name, def] of cols) {
    if (!tableHasColumn(db, 'cheque_records', name)) {
      try { db.exec(`ALTER TABLE cheque_records ADD COLUMN ${name} ${def}`); } catch (_) { /* */ }
    }
  }
  ensureDepositSlipColumn(db);
}

function pickLegalFields(body) {
  const b = body || {};
  return {
    sayad_registered: b.sayad_registered ? 1 : 0,
    sayad_confirmed: b.sayad_confirmed ? 1 : 0,
    sayad_color: String(b.sayad_color == null ? '' : b.sayad_color).trim(),
    sayad_tracking_code: String(b.sayad_tracking_code == null ? '' : b.sayad_tracking_code).trim(),
    beneficiary_national_id: String(b.beneficiary_national_id == null ? '' : b.beneficiary_national_id).trim(),
    is_guarantee: b.is_guarantee ? 1 : 0,
  };
}

function openingVarianceWarning(db, direction) {
  try {
    const recon = buildOpeningChequeReconciliation(db, direction);
    if (!recon || !Number.isFinite(recon.variance_rial) || recon.variance_rial === 0) {
      return { warning: null, reconciliation: recon };
    }
    return {
      reconciliation: recon,
      warning: {
        code: 'W_OPENING_VARIANCE',
        message: `مغایرت مانده اول دوره با دفتر کل: ${recon.variance_rial.toLocaleString('fa-IR')} ریال`,
        variance_rial: recon.variance_rial,
        cheques_rial: recon.cheques_rial,
        gl_opening_rial: recon.gl_opening_rial,
        direction: recon.direction,
        account_code: recon.account_code,
      },
    };
  } catch (_) {
    return { warning: null, reconciliation: null };
  }
}

/**
 * Soft-link leaf for out cheques. Prefer cheque-book-leaves helper; never hard-fail create.
 */
function tryLinkLeafOnCreate(db, { direction, leafId, checkCategoryId, serial, chequeRecordId }) {
  if (String(direction) !== 'out') return null;
  try {
    const hasTable = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='cheque_book_leaves'"
    ).get();
    if (!hasTable) return null;

    let leaves;
    try {
      leaves = require('../lib/cheque-book-leaves');
    } catch (_) {
      leaves = null;
    }

    let resolvedLeafId = leafId != null && leafId !== '' ? parseInt(leafId, 10) : NaN;
    let catId = checkCategoryId != null && checkCategoryId !== '' ? parseInt(checkCategoryId, 10) : NaN;
    const serialStr = serial != null ? String(serial).trim() : '';

    if ((!Number.isFinite(resolvedLeafId) || resolvedLeafId <= 0) && Number.isFinite(catId) && catId > 0 && serialStr) {
      const bySerial = db.prepare(
        'SELECT id, check_category_id FROM cheque_book_leaves WHERE check_category_id=? AND serial=?'
      ).get(catId, serialStr);
      if (bySerial) {
        resolvedLeafId = bySerial.id;
        catId = bySerial.check_category_id;
      }
    }
    if (Number.isFinite(resolvedLeafId) && resolvedLeafId > 0 && (!Number.isFinite(catId) || catId <= 0)) {
      const row = db.prepare('SELECT check_category_id FROM cheque_book_leaves WHERE id=?').get(resolvedLeafId);
      if (row) catId = row.check_category_id;
    }
    if (!Number.isFinite(resolvedLeafId) || resolvedLeafId <= 0 || !Number.isFinite(catId) || catId <= 0) {
      return null;
    }

    if (leaves && typeof leaves.issueLeafForCheque === 'function') {
      leaves.issueLeafForCheque(db, catId, resolvedLeafId, chequeRecordId);
      return resolvedLeafId;
    }
    // Fallback without helper module
    db.prepare(`
      UPDATE cheque_book_leaves SET status='issued', cheque_record_id=?
      WHERE id=? AND check_category_id=? AND status='blank'
    `).run(chequeRecordId, resolvedLeafId, catId);
    if (tableHasColumn(db, 'cheque_records', 'leaf_id')) {
      db.prepare('UPDATE cheque_records SET leaf_id=? WHERE id=?').run(resolvedLeafId, chequeRecordId);
    }
    return resolvedLeafId;
  } catch (_) {
    return null;
  }
}

/** Jalali YYYY/MM/DD for lifecycle JE dates; empty → today (API compat). */
function resolveChequeEntryDate(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return todayJalali();
  if (!/^\d{4}\/\d{2}\/\d{2}$/.test(s)) {
    throw Object.assign(new Error('تاریخ باید به صورت YYYY/MM/DD باشد'), {
      status: 400,
      code: 'E_CHEQUE_DATE',
    });
  }
  return s;
}

function assertClearNotBeforeSend(db, row, entryDate) {
  if (!row || !row.collection_je_id) return;
  const sendJe = db.prepare(
    'SELECT entry_date FROM journal_entries WHERE id=? AND COALESCE(deleted_at,0)=0'
  ).get(row.collection_je_id);
  const sendDate = sendJe && String(sendJe.entry_date || '').trim();
  if (sendDate && entryDate < sendDate) {
    throw Object.assign(
      new Error(`تاریخ وصول نمی‌تواند قبل از تاریخ واگذاری (${sendDate}) باشد`),
      { status: 400, code: 'E_CHEQUE_CLEAR_BEFORE_SEND' }
    );
  }
}

function softVoidChequeJe(db, jeId, { userId, date, reason, sourceType, failMsg }) {
  if (!jeId) return;
  const head = db.prepare('SELECT id FROM journal_entries WHERE id=?').get(jeId);
  if (!head) {
    throw Object.assign(new Error(failMsg || 'سند حسابداری یافت نشد'), {
      status: 400,
      code: 'E_CHEQUE_LIFECYCLE',
    });
  }
  // both OK for resend: live soft-void or already-voided bounce JE (idempotent).
  reverseJournalEntry(db, jeId, { userId, date, reason, sourceType });
  const after = db.prepare('SELECT status, deleted_at FROM journal_entries WHERE id=?').get(jeId);
  const voided = after
    && (Number(after.deleted_at || 0) > 0 || ['reversed', 'void'].includes(String(after.status || '')));
  if (!voided) {
    throw Object.assign(new Error(failMsg || 'ابطال نرم سند ناموفق بود'), {
      status: 400,
      code: 'E_CHEQUE_LIFECYCLE',
    });
  }
}

/** Post clear JE while row is in_collection; returns { jeId, resolvedBankId }. */
function postReceivableClear(db, row, { bankId, entryDate, userId }) {
  const amountRial = Math.round(Number(row.amount) || 0);
  if (amountRial <= 0) {
    throw Object.assign(new Error('مبلغ چک نامعتبر است'), { status: 400, code: 'E_CHEQUE_AMOUNT' });
  }
  if (row.lifecycle_status !== 'in_collection') {
    throw Object.assign(new Error('چک باید در وضعیت «در جریان وصول» باشد'), {
      status: 400,
      code: 'E_CHEQUE_LIFECYCLE',
    });
  }
  assertClearNotBeforeSend(db, row, entryDate);
  postChequeInReceipt(db, row, userId, entryDate);
  assertJournalIdempotent(db, 'cheque_clear', row.id);

  const bank = acct(db, 'coa_bank_default');
  const collection = acct(db, 'coa_cheques_in_collection');
  const amt = amountRial / 10;
  let cashLine = bank;
  let resolvedBankId = bankId || row.collection_bank_id || null;
  if (resolvedBankId) {
    const b = db.prepare('SELECT id, coa_code, name FROM banks WHERE id=?').get(resolvedBankId);
    if (!b) {
      throw Object.assign(new Error('بانک واریز معتبر نیست'), { status: 400, code: 'E_CHEQUE_BANK' });
    }
    cashLine = { code: b.coa_code || ('1102-' + b.id), name: b.name || bank.name };
    resolvedBankId = b.id;
  }

  const jeId = postToLedger(db, {
    sourceType: 'cheque_clear', sourceId: row.id,
    date: entryDate,
    description: `وصول چک ${row.cheque_number || row.id}`,
    createdBy: userId,
    lines: [
      { code: cashLine.code, name: cashLine.name, debit: amt, credit: 0, debit_rial: amountRial },
      { code: collection.code, name: collection.name, debit: 0, credit: amt, credit_rial: amountRial },
    ],
  });
  const updated = db.prepare(`
    UPDATE cheque_records
    SET lifecycle_status='cleared', cleared_je_id=?, status='وصول‌شده',
        collection_bank_id=COALESCE(?, collection_bank_id)
    WHERE id=? AND lifecycle_status='in_collection'
  `).run(jeId, resolvedBankId, row.id);
  if (!updated.changes) {
    throw Object.assign(new Error('چک باید در وضعیت «در جریان وصول» باشد'), {
      status: 400,
      code: 'E_CHEQUE_LIFECYCLE',
    });
  }
  syncSettlementChequeStatus(db, row.id);
  return { jeId, resolvedBankId };
}


function resolveChequeParty(db, body) {
  let partyId = parseInt(body && body.party_id, 10);
  if (!Number.isFinite(partyId) || partyId <= 0) {
    const customerId = parseInt(body && body.customer_id, 10);
    if (Number.isFinite(customerId) && customerId > 0) {
      const linked = db.prepare(`
        SELECT id FROM parties
        WHERE legacy_table='customers' AND legacy_id=? AND COALESCE(is_active,1)=1
      `).get(customerId);
      if (linked) partyId = linked.id;
      else {
        try {
          const cust = db.prepare('SELECT party_id FROM customers WHERE id=?').get(customerId);
          if (cust && cust.party_id) partyId = Number(cust.party_id);
        } catch (_) { /* */ }
      }
    }
  }
  if (!Number.isFinite(partyId) || partyId <= 0) {
    const err = new Error('طرف حساب باید از فهرست اشخاص انتخاب شود (party_id یا customer_id)');
    err.status = 400;
    err.code = 'E_CHEQUE_PARTY_REQUIRED';
    throw err;
  }
  const party = db.prepare(`
    SELECT id, full_name, company_name, biz, legacy_table, legacy_id
    FROM parties WHERE id=? AND COALESCE(is_active,1)=1
  `).get(partyId);
  if (!party) {
    const err = new Error('طرف حساب یافت نشد');
    err.status = 400;
    err.code = 'E_CHEQUE_PARTY_INVALID';
    throw err;
  }
  return {
    partyId: party.id,
    partyName: party.full_name || party.company_name || party.biz || '',
    customerId: party.legacy_table === 'customers' && party.legacy_id ? party.legacy_id : null,
  };
}

function refuseFreeTextFinancial(row, status) {
  const s = String(status || '');
  if (FINANCIAL_STATUS_RE.test(s)) {
    const err = new Error('این تغییر وضعیت سند حسابداری لازم دارد — از عملیات چرخه چک استفاده کنید');
    err.status = 400;
    err.code = 'E_CHEQUE_USE_LIFECYCLE';
    throw err;
  }
  const lc = lifecycleOf(row);
  if (row.direction === 'in' && ACTIVE_LIFECYCLE_IN.has(lc)) {
    const err = new Error('وضعیت چرخه فعال است — فقط از endpointهای چرخه یا ابطال کامل استفاده کنید');
    err.status = 400;
    err.code = 'E_CHEQUE_USE_LIFECYCLE';
    throw err;
  }
  if (row.direction === 'out' && ACTIVE_LIFECYCLE_OUT.has(lc)) {
    const err = new Error('وضعیت چرخه فعال است — فقط از endpointهای پرداخت/خرج یا ابطال کامل استفاده کنید');
    err.status = 400;
    err.code = 'E_CHEQUE_USE_LIFECYCLE';
    throw err;
  }
}

function chequeAmountRial(row) {
  const amountRial = Math.round(Number(row && row.amount) || 0);
  if (amountRial <= 0) {
    const err = new Error('مبلغ چک نامعتبر است');
    err.status = 400;
    throw err;
  }
  return amountRial;
}

function findCustomerIdForEndorse(db, { party, debitCode, partyId }) {
  if (party && party.legacy_table === 'customers' && party.legacy_id) {
    return Number(party.legacy_id);
  }
  const pid = partyId || (party && party.id);
  if (pid) {
    const byParty = db.prepare('SELECT id FROM customers WHERE party_id=?').get(pid);
    if (byParty) return Number(byParty.id);
  }
  if (debitCode) {
    const byCoa = db.prepare('SELECT id FROM customers WHERE coa_code=?').get(debitCode);
    if (byCoa) return Number(byCoa.id);
  }
  return null;
}

function resolveEndorseDebit(db, body) {
  // Explicit chart leaf (e.g. expense account when paying cost with a received cheque).
  const accountCode = String((body && body.account_code) || '').trim();
  if (accountCode && !parseInt(body && body.supplier_id, 10) && !parseInt(body && body.party_id, 10)) {
    const a = db.prepare('SELECT code,name FROM chart_of_accounts WHERE code=? AND COALESCE(is_active,1)=1').get(accountCode);
    if (!a) {
      const err = new Error('حساب مقصد ظهرنویسی یافت نشد');
      err.status = 400;
      err.code = 'E_CHEQUE_ENDORSE_ACCOUNT';
      throw err;
    }
    return { debitAcct: a, supplierId: null, partyId: null, customerId: null };
  }
  const supplierId = parseInt(body && body.supplier_id, 10);
  if (Number.isFinite(supplierId) && supplierId > 0) {
    const s = db.prepare('SELECT id, name, coa_code FROM suppliers WHERE id=?').get(supplierId);
    if (!s) {
      const err = new Error('تأمین‌کننده ذینفع یافت نشد');
      err.status = 400;
      err.code = 'E_CHEQUE_ENDORSE_PARTY';
      throw err;
    }
    if (s.coa_code) {
      const a = db.prepare('SELECT code,name FROM chart_of_accounts WHERE code=?').get(s.coa_code);
      if (a) return { debitAcct: a, supplierId: s.id, partyId: null, customerId: null };
    }
    return { debitAcct: acct(db, 'coa_payable'), supplierId: s.id, partyId: null, customerId: null };
  }
  const partyId = parseInt(body && body.party_id, 10);
  if (Number.isFinite(partyId) && partyId > 0) {
    const p = db.prepare('SELECT * FROM parties WHERE id=?').get(partyId);
    if (!p) {
      const err = new Error('شخص ذینفع یافت نشد');
      err.status = 400;
      err.code = 'E_CHEQUE_ENDORSE_PARTY';
      throw err;
    }
    if (p.legacy_table === 'suppliers' && p.legacy_id) {
      return resolveEndorseDebit(db, { supplier_id: p.legacy_id, account_key: body && body.account_key });
    }
    if (p.legacy_table === 'customers' && p.legacy_id) {
      const { receivableAcct } = require('../lib/customer-books');
      return {
        debitAcct: receivableAcct(db, p.legacy_id),
        supplierId: null,
        partyId: p.id,
        customerId: Number(p.legacy_id),
      };
    }
    if (p.coa_code) {
      const a = db.prepare('SELECT code,name FROM chart_of_accounts WHERE code=?').get(p.coa_code);
      if (a) {
        const customerId = findCustomerIdForEndorse(db, { party: p, debitCode: a.code, partyId: p.id });
        return { debitAcct: a, supplierId: null, partyId: p.id, customerId };
      }
    }
    const customerId = findCustomerIdForEndorse(db, { party: p, partyId: p.id });
    if (customerId) {
      const { receivableAcct } = require('../lib/customer-books');
      return {
        debitAcct: receivableAcct(db, customerId),
        supplierId: null,
        partyId: p.id,
        customerId,
      };
    }
    return { debitAcct: acct(db, 'coa_payable'), supplierId: null, partyId: p.id, customerId: null };
  }
  return {
    debitAcct: resolveNamedAcct(db, body && body.account_key, 'coa_payable'),
    supplierId: null,
    partyId: null,
    customerId: null,
  };
}

function postSupplierEndorseLedger(db, { supplierId, date, chequeId, description, amountRial, userId, refType }) {
  if (!supplierId || !(amountRial > 0)) return;
  const rt = String(refType || 'cheque_endorse');
  try {
    const exists = db.prepare(`
      SELECT 1 FROM supplier_ledger
      WHERE ref_type=? AND ref_id=? AND supplier_id=? LIMIT 1
    `).get(rt, chequeId, supplierId);
    if (exists) return;
    db.prepare(`
      INSERT INTO supplier_ledger
        (supplier_id, date, entry_type, ref_type, ref_id, description, debit, credit, user_id)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(supplierId, date || '', 'payment', rt, chequeId, description || '', amountRial, 0, userId || null);
  } catch (e) {
    if (db.inTransaction) throw e;
  }
}

function postCustomerEndorseLedger(db, { customerId, date, chequeId, description, amountRial, userId, refType }) {
  if (!customerId || !(amountRial > 0)) return;
  const rt = String(refType || 'cheque_endorse');
  const { createLedgerEntry } = require('../db');
  const exists = db.prepare(`
    SELECT 1 FROM customer_ledger
    WHERE ref_type=? AND ref_id=? AND customer_id=? AND entry_type<>'reversal'
    LIMIT 1
  `).get(rt, chequeId, customerId);
  if (exists) return;
  createLedgerEntry(db, {
    customer_id: customerId,
    date: date || '',
    entry_type: 'cheque',
    ref_type: rt,
    ref_id: chequeId,
    description: description || '',
    debit: amountRial,
    credit: 0,
    user_id: userId || null,
  });
}

/** Person sub-ledger mirror for outgoing cheque pay (XOR with customer). */
function postPersonChequePayLedger(db, { partyId, customerId, date, chequeId, description, amountRial, userId }) {
  if (customerId || !(amountRial > 0) || !chequeId) return;
  const pid = parseInt(partyId, 10);
  if (!Number.isFinite(pid) || pid <= 0) return;
  const person = db.prepare('SELECT id FROM persons WHERE party_id=? LIMIT 1').get(pid);
  if (!person) return;
  try {
    const exists = db.prepare(`
      SELECT 1 FROM person_ledger
      WHERE ref_type='cheque_pay' AND ref_id=? AND person_id=? AND COALESCE(entry_type,'')<>'reversal'
      LIMIT 1
    `).get(chequeId, person.id);
    if (exists) return;
    const { createPersonLedgerEntry } = require('../db');
    createPersonLedgerEntry(db, {
      person_id: person.id,
      date: date || '',
      entry_type: 'cheque',
      ref_type: 'cheque_pay',
      ref_id: chequeId,
      description: description || '',
      debit: amountRial,
      credit: 0,
      user_id: userId || null,
    });
  } catch (e) {
    if (db.inTransaction) throw e;
  }
}

function resolveNamedAcct(db, key, fallbackKey) {
  const k = String(key || fallbackKey || '').trim();
  try {
    return acct(db, k);
  } catch (_) {
    const err = new Error('کلید حساب نامعتبر است');
    err.status = 400;
    err.code = 'E_CHEQUE_ACCOUNT';
    throw err;
  }
}

function assertPosted(row) {
  if (row && row.record_status === 'reversed') {
    const err = new Error('این چک ابطال شده است');
    err.status = 400;
    err.code = 'E_CHEQUE_LIFECYCLE';
    throw err;
  }
}

function assertOutPayableAction(row) {
  if (!row || row.direction !== 'out') {
    const err = new Error('چک پرداختنی یافت نشد');
    err.status = 404;
    throw err;
  }
  assertPosted(row);
  if (isOpeningCheque(row)) {
    const err = new Error('چک اول دوره قبلاً در سند افتتاحیه ثبت شده و قابل پرداخت/خرج جداگانه نیست');
    err.status = 400;
    err.code = 'E_CHEQUE_LIFECYCLE';
    throw err;
  }
  if (!isRegistered(row)) {
    const err = new Error('وضعیت چرخه این چک اجازه این عملیات را نمی‌دهد');
    err.status = 400;
    err.code = 'E_CHEQUE_LIFECYCLE';
    throw err;
  }
}

function postChequeAction(db, {
  row, user, date, sourceType, lifecycle, statusLabel, debitAcct, creditAcct, costCenterId,
}) {
  const amountRial = chequeAmountRial(row);
  const amt = amountRial / 10;
  assertJournalIdempotent(db, sourceType, row.id);
  const id = postToLedger(db, {
    sourceType,
    sourceId: row.id,
    date,
    description: `${statusLabel} چک ${row.cheque_number || row.id}`,
    createdBy: user.id,
    costCenterId: costCenterId || null,
    lines: [
      { code: debitAcct.code, name: debitAcct.name, debit: amt, credit: 0, debit_rial: amountRial, cost_center_id: costCenterId || null },
      { code: creditAcct.code, name: creditAcct.name, debit: 0, credit: amt, credit_rial: amountRial, cost_center_id: costCenterId || null },
    ],
  });
  const updated = db.prepare(`
    UPDATE cheque_records
    SET lifecycle_status=?, collection_je_id=?, status=?
    WHERE id=? AND ${sqlIsRegistered('lifecycle_status')}
      AND COALESCE(record_status,'posted')<>'reversed'
  `).run(lifecycle, id, statusLabel, row.id);
  if (!updated.changes) {
    const err = new Error('وضعیت چرخه این چک اجازه این عملیات را نمی‌دهد');
    err.status = 400;
    err.code = 'E_CHEQUE_LIFECYCLE';
    throw err;
  }
  syncSettlementChequeStatus(db, row.id);
  return id;
}

function chequeExpensePosting(db, body, amount) {
  const { resolveExpensePosting } = require('./expenses');
  const b = body || {};
  const section = String(b.cost_section || '');
  return resolveExpensePosting(db, {
    category: b.category || (section === 'selling' ? 'sales' : 'admin'),
    account_code: b.account_code,
    is_overhead: !!(b.is_overhead || section === 'production_overhead'),
    cost_center_id: b.cost_center_id,
    amount: amount != null ? amount : b.amount,
  });
}

function bodyChoosesExpenseSection(body) {
  const b = body || {};
  return !!(b.cost_section || b.category || b.is_overhead || b.cost_center_id || b.account_code);
}

function runOutAction(req, { sourceType, lifecycle, statusLabel, debitKey, useExpensePosting }) {
  const db = getDB();
  const body = req.body || {};
  const entryDate = body.date || todayJalali();
  const jeId = db.transaction(() => {
    const row = db.prepare("SELECT * FROM cheque_records WHERE id=? AND direction='out'").get(req.params.id);
    assertOutPayableAction(row);
    let debitAcct;
    let costCenterId = null;
    let expenseCode = null;
    let payBooks = null;
    if (useExpensePosting && (bodyChoosesExpenseSection(body) || !body.account_key)) {
      const posting = chequeExpensePosting(db, body, row.amount);
      debitAcct = posting.account;
      costCenterId = posting.costCenterId;
      expenseCode = posting.account.code;
    } else if (sourceType === 'cheque_pay' && !body.account_key && row.party_id) {
      // Party-aware debit (supplier/person/customer COA); credit stays notes payable (v428).
      payBooks = resolveEndorseDebit(db, { party_id: row.party_id });
      debitAcct = payBooks.debitAcct;
    } else {
      debitAcct = resolveNamedAcct(db, req.body.account_key, debitKey);
    }
    const id = postChequeAction(db, {
      row,
      user: req.user,
      date: entryDate,
      sourceType,
      lifecycle,
      statusLabel,
      debitAcct,
      creditAcct: acct(db, 'coa_cheques_payable'),
      costCenterId,
    });
    if (expenseCode) {
      db.prepare(`
        UPDATE cheque_records
        SET cost_center_id=?, expense_account_code=?
        WHERE id=?
      `).run(costCenterId, expenseCode, row.id);
    }
    if (sourceType === 'cheque_pay') {
      const amountRial = chequeAmountRial(row);
      const desc = `پرداخت چک ${row.cheque_number || row.id}${row.party_name ? ' — ' + row.party_name : ''}`;
      const books = payBooks || (row.party_id ? resolveEndorseDebit(db, { party_id: row.party_id }) : null);
      if (books) {
        postSupplierEndorseLedger(db, {
          supplierId: books.supplierId, date: entryDate, chequeId: row.id,
          description: desc, amountRial, userId: req.user.id, refType: 'cheque_pay',
        });
        postCustomerEndorseLedger(db, {
          customerId: books.customerId, date: entryDate, chequeId: row.id,
          description: desc, amountRial, userId: req.user.id, refType: 'cheque_pay',
        });
        postPersonChequePayLedger(db, {
          partyId: books.partyId || row.party_id,
          customerId: books.customerId,
          date: entryDate, chequeId: row.id, description: desc,
          amountRial, userId: req.user.id,
        });
      }
    }
    return id;
  })();
  const row = db.prepare('SELECT cheque_number FROM cheque_records WHERE id=?').get(req.params.id);
  audit(req.user.id, sourceType, 'cheque_record', req.params.id, row?.cheque_number);
  return { ok: true, journal_entry_id: jeId, lifecycle_status: lifecycle };
}

router.get('/', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const { direction, status, opening } = req.query;
  const where = ["COALESCE(record_status,'posted')<>'reversed'"], params = [];
  if (direction) { where.push('direction=?'); params.push(direction); }
  if (status) { where.push('status LIKE ?'); params.push('%' + status + '%'); }
  if (opening === '1') { where.push("(note LIKE ? OR status LIKE ?)"); params.push('%' + OPENING_NOTE + '%', '%اول دوره%'); }
  else if (opening === '0') { where.push("(note NOT LIKE ? AND status NOT LIKE ?)"); params.push('%' + OPENING_NOTE + '%', '%اول دوره%'); }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const rows = db.prepare(`SELECT * FROM cheque_records ${whereSql} ORDER BY due_date ASC, id DESC LIMIT 1000`).all(...params);
  res.json(rows);
});

function enrichRegisterRow(db, row, ctx) {
  const flags = chequeQualityFlags(row, ctx);
  const today = ctx.today || todayJalali();
  const days = daysUntilDue(row.due_date, today);
  let collection_bank_name = '';
  if (row.collection_bank_id) {
    try {
      const b = db.prepare('SELECT name FROM banks WHERE id=?').get(row.collection_bank_id);
      collection_bank_name = (b && b.name) || '';
    } catch (_) { /* */ }
  }
  const branchDisp = (!row.branch || String(row.branch).trim() === '0') ? 'نامشخص' : row.branch;
  return {
    ...enrichChequeRow(db, row),
    branch_display: branchDisp,
    collection_bank_name,
    quality_flags: flags,
    quality_labels: flags.map((f) => QUALITY_LABEL_FA[f] || f),
    days_to_due: days,
    allowed_actions: allowedTargets(row),
  };
}

/** Paginated register with filters + totals (must be before /:id). */
router.get('/register', auth, adminOrAccounting, (req, res) => {
  try {
    const db = getDB();
    const today = String(req.query.today || todayJalali());
    const ctx = {
      today,
      dupSayads: buildDupSayadSet(db),
      adminNames: buildAdminNameSet(db),
    };
    const payload = runChequeRegister(db, { ...req.query, today }, (r) => enrichRegisterRow(db, r, ctx));
    res.json(payload);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, code: e.code });
  }
});

router.get('/summary', auth, adminOrAccounting, (req, res) => {
  try {
    const db = getDB();
    res.json(runChequeSummary(db, req.query.today || todayJalali()));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, code: e.code });
  }
});

/** Phase 4B — KPI داشبورد (سررسید ۷/۳۰/۹۰، معوق، صیاد، انقضا، واخواست، تضمین، پیش‌بینی نقدینگی) */
router.get('/dashboard-kpis', auth, adminOrAccounting, (req, res) => {
  try {
    res.json(buildChequeDashboardKpis(getDB(), req.query.today || todayJalali()));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, code: e.code });
  }
});

router.get('/reconciliation', auth, adminOrAccounting, (req, res) => {
  try {
    res.json(buildChequeReconciliation(getDB()));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, code: e.code });
  }
});

router.get('/opening-reconciliation', auth, adminOrAccounting, (req, res) => {
  try {
    res.json(buildOpeningChequeReconciliation(getDB(), req.query.direction));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, code: e.code });
  }
});

router.get('/lifecycle-labels', auth, adminOrAccounting, (_req, res) => {
  res.json({ labels: STATUS_LABEL });
});

router.get('/export.xlsx', auth, adminOrAccounting, async (req, res) => {
  try {
    const db = getDB();
    const today = String(req.query.today || todayJalali());
    const ctx = {
      today,
      dupSayads: buildDupSayadSet(db),
      adminNames: buildAdminNameSet(db),
    };
    const payload = runChequeRegister(db, {
      ...req.query,
      today,
      page: 1,
      page_size: 500,
    }, (r) => enrichRegisterRow(db, r, ctx));

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('دفتر چک');
    ws.views = [{ rightToLeft: true }];
    const headers = [
      'id', 'جهت', 'شماره', 'مبلغ ریال', 'بانک', 'شعبه', 'طرف حساب',
      'سررسید', 'صدور/دریافت', 'صیاد', 'وضعیت چرخه', 'برچسب', 'پرچم‌ها', 'سند',
    ];
    ws.addRow(headers);
    for (const r of payload.rows) {
      ws.addRow([
        r.id,
        r.direction === 'out' ? 'پرداختی' : 'دریافتی',
        r.cheque_number || '',
        Number(r.amount) || 0,
        r.bank_name || '',
        r.branch_display || r.branch || '',
        r.party_name || '',
        r.due_date || '',
        r.issue_date || r.receive_date || '',
        r.sayadi || '',
        r.lifecycle_label || r.lifecycle_status || '',
        r.status || '',
        (r.quality_labels || []).join('، '),
        r.journal_entry_id || '',
      ]);
    }
    const tin = payload.totals.by_direction.in;
    const tout = payload.totals.by_direction.out;
    ws.addRow([]);
    ws.addRow(['جمع دریافتی', tin.count, tin.amount]);
    ws.addRow(['جمع پرداختی', tout.count, tout.amount]);
    ws.getColumn(4).numFmt = '#,##0';

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="cheque-register.xlsx"');
    await wb.xlsx.write(res);
    res.end();
  } catch (e) {
    if (!res.headersSent) res.status(e.status || 500).json({ error: e.message, code: e.code });
  }
});

router.get('/bank-branches', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const q = String(req.query.q || '').trim();
  try {
    const rows = q
      ? db.prepare(`
          SELECT * FROM bank_branches
          WHERE bank_name LIKE ? OR branch_name LIKE ? OR branch_code LIKE ?
          ORDER BY bank_name, branch_name LIMIT 50
        `).all('%' + q + '%', '%' + q + '%', '%' + q + '%')
      : db.prepare('SELECT * FROM bank_branches ORDER BY bank_name, branch_name LIMIT 100').all();
    res.json(rows);
  } catch (e) {
    res.json([]);
  }
});

async function parseOpeningImportRows(req) {
  if (req.file && req.file.buffer) {
    const wb = await readWorkbook(req.file.buffer, { cellDates: true });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: true });
    return rawRows;
  }
  let rows = req.body && req.body.rows;
  if (typeof rows === 'string') {
    try { rows = JSON.parse(rows); } catch (_) { rows = null; }
  }
  if (Array.isArray(rows)) return rows;
  if (Array.isArray(req.body)) return req.body;
  return null;
}

/** Preview opening Excel/JSON — no DB write. */
router.post('/opening-import/preview', auth, adminOrAccounting, optionalOpeningXlsx, async (req, res) => {
  try {
    const db = getDB();
    const rows = await parseOpeningImportRows(req);
    if (!rows || !rows.length) {
      return res.status(400).json({ error: 'هیچ ردیفی برای پیش‌نمایش ارسال نشده است', code: 'E_IMPORT_EMPTY' });
    }
    if (rows.length > 5000) {
      return res.status(400).json({ error: 'حداکثر ۵۰۰۰ ردیف در هر فایل مجاز است', code: 'E_IMPORT_TOO_LARGE' });
    }
    const direction = (req.body && req.body.direction) || req.query.direction || 'in';
    const preview = previewOpeningImport(db, { direction, rows });
    res.json({
      ok: preview.ok,
      direction: preview.direction,
      row_count: preview.row_count,
      skipped_blank: preview.skipped_blank,
      valid_count: preview.valid_count,
      error_count: preview.error_count,
      summary: preview.summary,
      rows: preview.rows,
      errors: preview.errors,
    });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message, code: e.code || 'E_IMPORT_PREVIEW' });
  }
});

/**
 * Commit opening import — all-or-nothing transaction when every row is valid.
 * Body: { direction, rows } or multipart file (re-validated server-side).
 */
router.post('/opening-import/commit', auth, adminOrAccounting, optionalOpeningXlsx, async (req, res) => {
  try {
    const db = getDB();
    ensureChequeLegalColumns(db);
    const rows = await parseOpeningImportRows(req);
    if (!rows || !rows.length) {
      return res.status(400).json({ error: 'هیچ ردیفی برای ثبت ارسال نشده است', code: 'E_IMPORT_EMPTY' });
    }
    if (rows.length > 5000) {
      return res.status(400).json({ error: 'حداکثر ۵۰۰۰ ردیف در هر فایل مجاز است', code: 'E_IMPORT_TOO_LARGE' });
    }
    const direction = (req.body && req.body.direction) || req.query.direction || 'in';
    const preview = previewOpeningImport(db, { direction, rows });
    if (!preview.valid_count) {
      return res.status(400).json({
        error: 'هیچ ردیف معتبری برای ثبت وجود ندارد',
        code: 'E_IMPORT_INVALID',
        errors: preview.errors,
        summary: preview.summary,
        rows: preview.rows,
      });
    }
    if (preview.error_count > 0) {
      return res.status(400).json({
        error: 'ثبت فقط وقتی همه ردیف‌ها معتبر باشند انجام می‌شود (all-or-nothing)',
        code: 'E_IMPORT_HAS_ERRORS',
        errors: preview.errors,
        summary: preview.summary,
        rows: preview.rows,
      });
    }

    const createdIds = db.transaction(() => {
      const ids = [];
      for (const body of preview.valid_bodies) {
        const id = insertChequeRecord(db, body, req.user);
        ids.push(id);
      }
      return ids;
    })();

    for (const id of createdIds) {
      audit(req.user.id, 'create', 'cheque_record', id, 'ورود اکسل چک اول دوره');
    }
    const { warning, reconciliation } = openingVarianceWarning(db, preview.direction);
    res.json({
      ok: true,
      created_count: createdIds.length,
      ids: createdIds,
      warning,
      reconciliation,
    });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message, code: e.code || 'E_IMPORT_COMMIT' });
  }
});

/** ADR-CHEQUE-LEAF-001 — leaf detail (read-only). */
router.get('/:id/history', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const events = buildChequeHistory(db, req.params.id);
  if (events === null) return res.status(404).json({ error: 'چک یافت نشد' });
  res.json({ cheque_id: Number(req.params.id), events });
});

router.get('/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM cheque_records WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'چک یافت نشد' });
  res.json(enrichChequeRow(db, row));
});

/**
 * Shared create path for POST / and opening-import/commit.
 * Throws with .status/.code on validation failure. Caller wraps transaction if needed.
 */
function insertChequeRecord(db, body, user) {
  ensureChequeLegalColumns(db);
  const {
    direction, cheque_number, issue_date, receive_date, due_date,
    bank_name, branch, sayadi, sheba, account_number,
    status, status_note, amount, note, opening,
  } = body || {};
  if (!direction || amount == null || amount === '') {
    const err = new Error('جهت و مبلغ الزامی است');
    err.status = 400;
    throw err;
  }
  const amountNum = Math.round(Number(String(amount).replace(/[,\s]/g, '')));
  if (!Number.isFinite(amountNum) || amountNum <= 0) {
    const err = new Error('مبلغ چک باید عدد مثبت معتبر باشد (ریال)');
    err.status = 400;
    err.code = 'E_CHEQUE_AMOUNT';
    throw err;
  }
  const isOpening = isTruthyOpening(opening);
  try {
    assertBranchNotPlaceholder(branch);
  } catch (e) {
    throw e;
  }

  let sayDigits = '';
  const rawSay = String(sayadi == null ? '' : sayadi).trim();
  if (isOpening && !rawSay) {
    const err = new Error('شناسه صیاد برای چک اول دوره الزامی است (۱۶ رقم)');
    err.status = 400;
    err.code = 'E_SAYAD_REQUIRED';
    throw err;
  }
  if (rawSay) {
    const sayV = validateSayadi(rawSay);
    if (!sayV.ok) {
      const err = new Error(sayV.message);
      err.status = 400;
      err.code = sayV.code;
      throw err;
    }
    sayDigits = sayV.digits;
  }
  if (sayDigits) {
    const dup = db.prepare(`
      SELECT id FROM cheque_records
      WHERE COALESCE(record_status,'posted')='posted'
        AND direction=?
        AND TRIM(sayadi)=?
      LIMIT 1
    `).get(direction, sayDigits);
    if (dup) {
      const err = new Error('شناسه صیاد تکراری است');
      err.status = 400;
      err.code = 'E_SAYAD_DUP';
      err.existing_id = dup.id;
      throw err;
    }
  }

  // Opening: party_id یا customer_id اجباری — resolveChequeParty
  const party = resolveChequeParty(db, body);
  const legal = pickLegalFields(body);
  const finalNote = isOpening ? (note ? note + ' — ' + OPENING_NOTE : OPENING_NOTE) : (note || '');
  const defaultStatus = isOpening
    ? 'مانده اول دوره'
    : (direction === 'in' ? 'نزد صندوق' : 'ثبت‌شده');
  const checkCategoryId = body.check_category_id || null;
  const leafIdBody = body.leaf_id != null && body.leaf_id !== '' ? parseInt(body.leaf_id, 10) : null;

  const hasLegalCols = tableHasColumn(db, 'cheque_records', 'sayad_tracking_code');
  const hasLeafCol = tableHasColumn(db, 'cheque_records', 'leaf_id');

  let insertSql;
  let insertArgs;
  if (hasLegalCols) {
    insertSql = `
      INSERT INTO cheque_records (
        direction, cheque_number, issue_date, receive_date, due_date,
        bank_name, branch, sayadi, sheba, account_number,
        party_name, party_id, customer_id, status, status_note, amount, note, created_by_name,
        lifecycle_status, check_category_id, sayad_registered, sayad_confirmed, sayad_color,
        sayad_tracking_code, beneficiary_national_id, is_guarantee
        ${hasLeafCol ? ', leaf_id' : ''}
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?${hasLeafCol ? ',?' : ''})
    `;
    insertArgs = [
      direction, String(cheque_number || '').trim(), issue_date || '', receive_date || '', due_date || '',
      bank_name || '', branch || '', sayDigits, String(sheba || '').trim(), String(account_number || '').trim(),
      party.partyName, party.partyId, party.customerId,
      status || defaultStatus, status_note || '',
      amountNum, finalNote, (user && user.name) || '',
      'registered',
      checkCategoryId,
      legal.sayad_registered,
      legal.sayad_confirmed,
      legal.sayad_color,
      legal.sayad_tracking_code,
      legal.beneficiary_national_id,
      legal.is_guarantee,
    ];
    if (hasLeafCol) insertArgs.push(Number.isFinite(leafIdBody) && leafIdBody > 0 ? leafIdBody : null);
  } else {
    insertSql = `
      INSERT INTO cheque_records (
        direction, cheque_number, issue_date, receive_date, due_date,
        bank_name, branch, sayadi, sheba, account_number,
        party_name, party_id, customer_id, status, status_note, amount, note, created_by_name,
        lifecycle_status, check_category_id, sayad_registered, sayad_confirmed, sayad_color
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `;
    insertArgs = [
      direction, String(cheque_number || '').trim(), issue_date || '', receive_date || '', due_date || '',
      bank_name || '', branch || '', sayDigits, String(sheba || '').trim(), String(account_number || '').trim(),
      party.partyName, party.partyId, party.customerId,
      status || defaultStatus, status_note || '',
      amountNum, finalNote, (user && user.name) || '',
      'registered',
      checkCategoryId,
      legal.sayad_registered,
      legal.sayad_confirmed,
      legal.sayad_color,
    ];
  }

  const result = db.prepare(insertSql).run(...insertArgs);
  const newId = result.lastInsertRowid;

  if (isOpening) {
    const chequeAccount = acct(db, direction === 'in' ? 'coa_cheques_receivable' : 'coa_cheques_payable');
    const openingAccount = acct(db, 'coa_opening_balance');
    const valueToman = amountNum / 10;
    const lines = direction === 'in'
      ? [
        { code: chequeAccount.code, name: chequeAccount.name, debit: valueToman, credit: 0 },
        { code: openingAccount.code, name: openingAccount.name, debit: 0, credit: valueToman },
      ]
      : [
        { code: openingAccount.code, name: openingAccount.name, debit: valueToman, credit: 0 },
        { code: chequeAccount.code, name: chequeAccount.name, debit: 0, credit: valueToman },
      ];
    const journalId = postToLedger(db, {
      sourceType: 'opening_cheque', sourceId: newId,
      date: issue_date || todayJalali(),
      description: `چک ${direction === 'in' ? 'دریافتنی' : 'پرداختنی'} اول دوره ${cheque_number || ''}`,
      createdBy: user && user.id, voucherType: 'opening',
      srcSystem: body.from_excel || body.src_system === 'excel' ? 'excel' : null,
      lines,
    });
    db.prepare('UPDATE cheque_records SET journal_entry_id=? WHERE id=?').run(journalId, newId);
  }

  tryLinkLeafOnCreate(db, {
    direction,
    leafId: leafIdBody,
    checkCategoryId,
    serial: body.serial != null ? body.serial : cheque_number,
    chequeRecordId: newId,
  });

  const saved = db.prepare('SELECT * FROM cheque_records WHERE id=?').get(newId);
  postChequeInReceipt(db, saved, user && user.id, receive_date || issue_date || todayJalali());
  return newId;
}

router.post('/', auth, adminOrAccounting, (req, res) => {
  try {
    const db = getDB();
    const recordId = db.transaction(() => insertChequeRecord(db, req.body || {}, req.user))();
    audit(req.user.id, 'create', 'cheque_record', recordId, `ثبت چک ${(req.body && req.body.cheque_number) || recordId}`);
    const row = enrichChequeRow(db, db.prepare('SELECT * FROM cheque_records WHERE id=?').get(recordId));
    const payload = { ...row };
    if (isTruthyOpening(req.body && req.body.opening)) {
      const { warning, reconciliation } = openingVarianceWarning(db, req.body.direction);
      payload.warning = warning;
      payload.reconciliation = reconciliation;
    }
    res.json(payload);
  } catch (e) {
    const extra = {};
    if (e.existing_id) extra.existing_id = e.existing_id;
    res.status(e.status || 400).json({ error: e.message, code: e.code, ...extra });
  }
});

/** Update legal / descriptive fields (not financial reverse). */
router.put('/:id', auth, adminOrAccounting, (req, res) => {
  try {
    const db = getDB();
    ensureChequeLegalColumns(db);
    const row = db.prepare('SELECT * FROM cheque_records WHERE id=?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'یافت نشد' });
    if (String(row.record_status || 'posted') !== 'posted') {
      return res.status(409).json({ error: 'فقط چک ثبت‌شده قابل ویرایش است', code: 'E_CHEQUE_LOCKED' });
    }
    const body = req.body || {};
    try {
      assertBranchNotPlaceholder(body.branch != null ? body.branch : row.branch);
    } catch (e) {
      return res.status(e.status || 400).json({ error: e.message, code: e.code });
    }

    let sayDigits = row.sayadi || '';
    if (body.sayadi !== undefined) {
      const rawSay = String(body.sayadi == null ? '' : body.sayadi).trim();
      const openingRow = isOpeningCheque(row) || isTruthyOpening(body.opening);
      if (openingRow && !rawSay) {
        return res.status(400).json({
          error: 'شناسه صیاد برای چک اول دوره الزامی است (۱۶ رقم)',
          code: 'E_SAYAD_REQUIRED',
        });
      }
      if (rawSay) {
        const sayV = validateSayadi(rawSay);
        if (!sayV.ok) return res.status(400).json({ error: sayV.message, code: sayV.code });
        sayDigits = sayV.digits;
        if (sayDigits !== String(row.sayadi || '').trim()) {
          const dup = db.prepare(`
            SELECT id FROM cheque_records
            WHERE COALESCE(record_status,'posted')='posted'
              AND direction=? AND TRIM(sayadi)=? AND id<>?
            LIMIT 1
          `).get(row.direction, sayDigits, row.id);
          if (dup) {
            return res.status(400).json({ error: 'شناسه صیاد تکراری است', code: 'E_SAYAD_DUP', existing_id: dup.id });
          }
        }
      } else {
        sayDigits = '';
      }
    }

    let partyId = row.party_id;
    let partyName = row.party_name;
    let customerId = row.customer_id;
    if (body.party_id != null || body.customer_id != null) {
      const party = resolveChequeParty(db, body);
      partyId = party.partyId;
      partyName = party.partyName;
      customerId = party.customerId;
    }

    const legal = pickLegalFields({
      sayad_registered: body.sayad_registered !== undefined ? body.sayad_registered : row.sayad_registered,
      sayad_confirmed: body.sayad_confirmed !== undefined ? body.sayad_confirmed : row.sayad_confirmed,
      sayad_color: body.sayad_color !== undefined ? body.sayad_color : row.sayad_color,
      sayad_tracking_code: body.sayad_tracking_code !== undefined ? body.sayad_tracking_code : row.sayad_tracking_code,
      beneficiary_national_id: body.beneficiary_national_id !== undefined
        ? body.beneficiary_national_id : row.beneficiary_national_id,
      is_guarantee: body.is_guarantee !== undefined ? body.is_guarantee : row.is_guarantee,
    });

    const sets = [
      'bank_name=?', 'branch=?', 'sayadi=?', 'sheba=?', 'account_number=?',
      'cheque_number=?', 'issue_date=?', 'receive_date=?', 'due_date=?',
      'party_name=?', 'party_id=?', 'customer_id=?',
      'status_note=?', 'note=?',
      'sayad_registered=?', 'sayad_confirmed=?', 'sayad_color=?',
    ];
    const args = [
      body.bank_name !== undefined ? body.bank_name : row.bank_name,
      body.branch !== undefined ? body.branch : row.branch,
      sayDigits,
      body.sheba !== undefined ? String(body.sheba).trim() : row.sheba,
      body.account_number !== undefined ? String(body.account_number).trim() : row.account_number,
      body.cheque_number !== undefined ? String(body.cheque_number).trim() : row.cheque_number,
      body.issue_date !== undefined ? body.issue_date : row.issue_date,
      body.receive_date !== undefined ? body.receive_date : row.receive_date,
      body.due_date !== undefined ? body.due_date : row.due_date,
      partyName, partyId, customerId,
      body.status_note !== undefined ? body.status_note : row.status_note,
      body.note !== undefined ? body.note : row.note,
      legal.sayad_registered, legal.sayad_confirmed, legal.sayad_color,
    ];
    if (tableHasColumn(db, 'cheque_records', 'sayad_tracking_code')) {
      sets.push('sayad_tracking_code=?', 'beneficiary_national_id=?', 'is_guarantee=?');
      args.push(legal.sayad_tracking_code, legal.beneficiary_national_id, legal.is_guarantee);
    }
    if (body.check_category_id !== undefined) {
      sets.push('check_category_id=?');
      args.push(body.check_category_id || null);
    }
    args.push(row.id);
    db.prepare(`UPDATE cheque_records SET ${sets.join(', ')} WHERE id=?`).run(...args);

    if (body.leaf_id != null || (body.check_category_id && (body.serial || body.cheque_number))) {
      tryLinkLeafOnCreate(db, {
        direction: row.direction,
        leafId: body.leaf_id,
        checkCategoryId: body.check_category_id != null ? body.check_category_id : row.check_category_id,
        serial: body.serial != null ? body.serial : (body.cheque_number || row.cheque_number),
        chequeRecordId: row.id,
      });
    }

    audit(req.user.id, 'update', 'cheque_record', row.id, `ویرایش چک ${row.cheque_number || row.id}`);
    const updated = db.prepare('SELECT * FROM cheque_records WHERE id=?').get(row.id);
    res.json(enrichChequeRow(db, updated));
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
});

router.patch('/:id/status', auth, adminOrAccounting, (req, res) => {
  const { status, status_note } = req.body;
  const db = getDB();
  const row = db.prepare('SELECT * FROM cheque_records WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  // Posted rows: only status_note may change freely; free-text status change → 409
  if (String(row.record_status || 'posted') === 'posted'
      && status != null && String(status) !== String(row.status || '')) {
    return res.status(409).json({
      error: 'تغییر برچسب وضعیت آزاد برای چک ثبت‌شده ممنوع است — از عملیات چرخه استفاده کنید',
      code: 'E_CHEQUE_STATUS_LOCKED',
    });
  }
  try {
    refuseFreeTextFinancial(row, status);
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
  db.prepare('UPDATE cheque_records SET status_note=? WHERE id=?')
    .run(status_note ?? row.status_note, req.params.id);
  audit(req.user.id, 'update', 'cheque_record', req.params.id, `یادداشت وضعیت چک ${row.cheque_number}`);
  res.json({ ok: true });
});

/** Secure due-date correction — no GL change; updates settlement.cheque_due + event. */
router.patch('/:id/due', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM cheque_records WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  if (String(row.record_status || 'posted') !== 'posted') {
    return res.status(409).json({ error: 'فقط چک ثبت‌شده قابل اصلاح سررسید است', code: 'E_CHEQUE_DUE_LOCKED' });
  }
  const lc = String(row.lifecycle_status || '').trim();
  const allowedLc = new Set(['', 'registered', 'in_hand', 'pending']);
  if (!allowedLc.has(lc)) {
    return res.status(409).json({
      error: 'اصلاح سررسید فقط در وضعیت نزد صندوق / registered مجاز است',
      code: 'E_CHEQUE_DUE_LOCKED',
      lifecycle_status: lc,
    });
  }
  const { assertChequeDueVsReceive, isValidJalaliDate } = require('../lib/cheque-due-validate');
  const dueRaw = String((req.body && req.body.due_date) || '').trim();
  const reason = String((req.body && req.body.reason) || '').trim();
  if (!reason) return res.status(400).json({ error: 'دلیل اصلاح سررسید الزامی است', code: 'E_CHEQUE_DUE_REASON' });
  let dueS;
  try {
    dueS = assertChequeDueVsReceive({
      due: dueRaw,
      receiveDate: row.receive_date || row.issue_date || '',
      allowSameDayDue: !!(req.body && req.body.allow_same_day_due),
    });
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
  if (!isValidJalaliDate(dueS)) {
    return res.status(400).json({ error: 'سررسید معتبر نیست', code: 'E_CHEQUE_DUE_INVALID' });
  }
  const oldDue = String(row.due_date || '');
  if (oldDue === dueS) return res.json({ ok: true, due_date: dueS, unchanged: true });
  db.transaction(() => {
    db.prepare('UPDATE cheque_records SET due_date=? WHERE id=?').run(dueS, row.id);
    if (row.settlement_id) {
      db.prepare('UPDATE settlements SET cheque_due=? WHERE id=?').run(dueS, row.settlement_id);
    }
    insertChequeEvent(db, {
      chequeId: row.id,
      fromStatus: lc || row.status || 'registered',
      toStatus: lc || 'registered',
      eventDate: todayJalali(),
      note: `تغییر سررسید از ${oldDue || '—'} به ${dueS} — ${reason}`,
      createdBy: req.user.id,
      clientRequestId: req.body && req.body.client_request_id,
    });
  })();
  audit(req.user.id, 'cheque_due_fix', 'cheque_record', req.params.id, `سررسید ${oldDue}→${dueS}`);
  res.json({ ok: true, due_date: dueS, previous_due: oldDue });
});

function voidChequeHttp(req, res) {
  try {
    const db = getDB();
    res.json(voidChequeRecord(db, req.params.id, req.user));
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
}

router.delete('/:id', auth, adminOrAccounting, requireChequeOperate, requireChequeHighValueApprove, voidChequeHttp);
router.post('/:id/cancel', auth, adminOrAccounting, requireChequeOperate, requireChequeHighValueApprove, voidChequeHttp);
router.post('/:id/void', auth, adminOrAccounting, requireChequeOperate, requireChequeHighValueApprove, voidChequeHttp);

/** Handover our cheque to the payee — Dr payable, Cr notes payable. */
router.post('/:id/pay', auth, adminOrAccounting, (req, res) => {
  try {
    res.json(runOutAction(req, {
      sourceType: 'cheque_pay',
      lifecycle: 'issued',
      statusLabel: 'پرداخت‌شده',
      debitKey: 'coa_payable',
    }));
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
});

/** خرج چک پرداختنی — بخش مالک مثل پرداخت هزینه؛ بدون بخش = اداری ۶۱۰۲. */
router.post('/:id/expense', auth, adminOrAccounting, (req, res) => {
  try {
    res.json(runOutAction(req, {
      sourceType: 'cheque_expense',
      lifecycle: 'expensed',
      statusLabel: 'خرج‌شده',
      debitKey: 'coa_admin_expense',
      useExpensePosting: true,
    }));
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
});

/**
 * خرج چک: پرداختنی → همان expense؛ دریافتنی → ظهرنویسی به ذینفع
 * (بدهکار پرداختنی، بستانکار اسناد دریافتنی) به‌جای واگذاری به بانک.
 */
router.post('/:id/endorse', auth, adminOrAccounting, (req, res) => {
  try {
    const db = getDB();
    const probe = db.prepare('SELECT direction FROM cheque_records WHERE id=?').get(req.params.id);
    if (!probe) return res.status(404).json({ error: 'یافت نشد' });
    if (probe.direction === 'out') {
      return res.json(runOutAction(req, {
        sourceType: 'cheque_endorse',
        lifecycle: 'endorsed',
        statusLabel: 'خرج‌شده',
        debitKey: 'coa_admin_expense',
        useExpensePosting: true,
      }));
    }

    const entryDate = resolveChequeEntryDate(req.body.date);
    const jeId = db.transaction(() => {
      const row = db.prepare("SELECT * FROM cheque_records WHERE id=? AND direction='in'").get(req.params.id);
      if (!row) {
        throw Object.assign(new Error('چک دریافتنی یافت نشد'), { status: 404 });
      }
      assertPosted(row);
      if (!isRegistered(row)) {
        throw Object.assign(new Error('وضعیت چرخه این چک اجازه خرج/ظهرنویسی را نمی‌دهد'), { status: 400, code: 'E_CHEQUE_LIFECYCLE' });
      }
      const resolved = resolveEndorseDebit(db, req.body || {});
      const creditAcct = acct(db, 'coa_cheques_receivable');
      const je = postChequeAction(db, {
        row,
        user: req.user,
        date: entryDate,
        sourceType: 'cheque_endorse',
        lifecycle: 'endorsed',
        statusLabel: 'خرج‌شده',
        debitAcct: resolved.debitAcct,
        creditAcct,
      });
      db.prepare(`
        UPDATE cheque_records SET endorse_party_id=?, endorse_supplier_id=? WHERE id=?
      `).run(resolved.partyId, resolved.supplierId, row.id);
      postSupplierEndorseLedger(db, {
        supplierId: resolved.supplierId,
        date: entryDate,
        chequeId: row.id,
        description: `خرج/ظهرنویسی چک ${row.cheque_number || row.id}`,
        amountRial: chequeAmountRial(row),
        userId: req.user.id,
      });
      postCustomerEndorseLedger(db, {
        customerId: resolved.customerId,
        date: entryDate,
        chequeId: row.id,
        description: `خرج/ظهرنویسی چک ${row.cheque_number || row.id}`,
        amountRial: chequeAmountRial(row),
        userId: req.user.id,
      });
      return je;
    })();
    const row = db.prepare('SELECT cheque_number FROM cheque_records WHERE id=?').get(req.params.id);
    audit(req.user.id, 'cheque_endorse', 'cheque_record', req.params.id, row?.cheque_number);
    res.json({ ok: true, journal_entry_id: jeId, lifecycle_status: 'endorsed' });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
});

router.post('/:id/send-to-bank', auth, adminOrAccounting, requireChequeOperate, (req, res) => {
  try {
    const db = getDB();
    const body = req.body || {};
    const bankId = body.collection_bank_id || body.bank_id || null;
    const entryDate = resolveChequeEntryDate(body.date);
    const result = db.transaction(() => {
      const row = db.prepare("SELECT * FROM cheque_records WHERE id=? AND direction='in'").get(req.params.id);
      if (!row) {
        throw Object.assign(new Error('چک دریافتنی یافت نشد'), { status: 404 });
      }
      return sendChequeToBank(db, row, {
        user: req.user,
        entryDate,
        bankId,
        depositSlipNo: body.deposit_slip_no,
        clientRequestId: body.client_request_id || req.get('Idempotency-Key') || null,
      });
    })();

    const row = db.prepare('SELECT cheque_number FROM cheque_records WHERE id=?').get(req.params.id);
    audit(req.user.id, 'cheque_send_bank', 'cheque_record', req.params.id, row?.cheque_number);
    res.json({
      ok: true,
      journal_entry_id: result.journal_entry_id,
      lifecycle_status: 'in_collection',
      deposit_slip_no: result.deposit_slip_no || null,
      idempotent: !!result.idempotent,
    });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
});

router.post('/:id/clear', auth, adminOrAccounting, requireChequeOperate, requireChequeHighValueApprove, (req, res) => {
  try {
    const db = getDB();
    const amountProbe = db.prepare("SELECT amount, collection_bank_id FROM cheque_records WHERE id=? AND direction='in'").get(req.params.id);
    if (!amountProbe) return res.status(404).json({ error: 'چک دریافتنی یافت نشد' });

    const bankId = req.body.bank_id || amountProbe.collection_bank_id;
    const entryDate = resolveChequeEntryDate(req.body.date);

    const jeId = db.transaction(() => {
      const row = db.prepare("SELECT * FROM cheque_records WHERE id=? AND direction='in'").get(req.params.id);
      if (!row) throw Object.assign(new Error('چک دریافتنی یافت نشد'), { status: 404 });
      return postReceivableClear(db, row, {
        bankId,
        entryDate,
        userId: req.user.id,
      }).jeId;
    })();

    const row = db.prepare('SELECT cheque_number FROM cheque_records WHERE id=?').get(req.params.id);
    audit(req.user.id, 'cheque_clear', 'cheque_record', req.params.id, row?.cheque_number);
    res.json({ ok: true, journal_entry_id: jeId, lifecycle_status: 'cleared', date: entryDate });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
});

router.post('/:id/bounce', auth, adminOrAccounting, requireChequeOperate, requireChequeHighValueApprove, (req, res) => {
  // Phase 3A: واخواست = Dr اسناد واخواستی / Cr 1116|بانک (نه Dr 1103)
  runLifecycleAction(req, res, protestCheque);
});

/** صریح واخواست با شماره/تاریخ گواهی + هشدار مهلت ۶ماهه */
router.post('/:id/protest', auth, adminOrAccounting, requireChequeOperate, requireChequeHighValueApprove, (req, res) => {
  runLifecycleAction(req, res, protestCheque);
});

/** انتقال اسناد واخواستی به حساب مشتری: Dr 1103 / Cr واخواستی */
router.post('/:id/transfer-to-customer', auth, adminOrAccounting, requireChequeOperate, (req, res) => {
  runLifecycleAction(req, res, transferProtestToCustomer);
});

/**
 * bounce → resend: soft-void bounce (+ prior clear if any), restore in_collection,
 * then post a NEW clear JE on the user-chosen date/bank (redeposit = وصول).
 */
router.post('/:id/resend', auth, adminOrAccounting, (req, res) => {
  try {
    const db = getDB();
    const entryDate = resolveChequeEntryDate(req.body.date);
    const bankId = req.body.bank_id || null;

    const result = db.transaction(() => {
      const row = db.prepare("SELECT * FROM cheque_records WHERE id=? AND direction='in'").get(req.params.id);
      if (!row) throw Object.assign(new Error('چک دریافتنی یافت نشد'), { status: 404 });
      if (row.lifecycle_status !== 'bounced') {
        throw Object.assign(new Error('فقط چک برگشتی قابل ارسال مجدد است'), { status: 400, code: 'E_CHEQUE_LIFECYCLE' });
      }
      if (!row.bounced_je_id) {
        throw Object.assign(new Error('سند برگشت یافت نشد — ابطال کامل یا اصلاح دستی لازم است'), { status: 400, code: 'E_CHEQUE_LIFECYCLE' });
      }
      if (!row.collection_je_id) {
        throw Object.assign(new Error('واگذاری به بانک برای ارسال مجدد لازم است'), {
          status: 400,
          code: 'E_CHEQUE_LIFECYCLE',
        });
      }
      const resolvedBankId = bankId || row.collection_bank_id;
      if (!resolvedBankId) {
        throw Object.assign(new Error('بانک واریز برای وصول پس از ارسال مجدد الزامی است'), {
          status: 400,
          code: 'E_CHEQUE_BANK',
        });
      }

      softVoidChequeJe(db, row.bounced_je_id, {
        userId: req.user.id,
        date: entryDate,
        reason: `ارسال مجدد چک ${row.cheque_number || row.id} پس از برگشت`,
        sourceType: 'cheque_resend',
        failMsg: 'ابطال نرم سند برگشت ناموفق بود',
      });
      reverseChequeLedgerByRef(db, {
        chequeId: row.id,
        refTypes: ['cheque_bounce'],
        date: entryDate,
        userId: req.user.id,
        descriptionPrefix: 'ارسال مجدد پس از برگشت',
      });

      // If previously cleared, soft-void that clear so bank is not left on the old date;
      // then post a fresh clear on the selected settlement date.
      if (row.cleared_je_id) {
        softVoidChequeJe(db, row.cleared_je_id, {
          userId: req.user.id,
          date: entryDate,
          reason: `ارسال مجدد چک ${row.cheque_number || row.id} — ابطال وصول قبلی برای ثبت مجدد`,
          sourceType: 'cheque_clear_resend_void',
          failMsg: 'ابطال نرم سند وصول قبلی ناموفق بود',
        });
      }

      const prepared = db.prepare(`
        UPDATE cheque_records
        SET lifecycle_status='in_collection', bounced_je_id=NULL, cleared_je_id=NULL,
            status='واگذارشده', collection_bank_id=?
        WHERE id=? AND lifecycle_status='bounced'
      `).run(resolvedBankId, row.id);
      if (!prepared.changes) {
        throw Object.assign(new Error('فقط چک برگشتی قابل ارسال مجدد است'), { status: 400, code: 'E_CHEQUE_LIFECYCLE' });
      }

      const fresh = db.prepare("SELECT * FROM cheque_records WHERE id=? AND direction='in'").get(row.id);
      const { jeId } = postReceivableClear(db, fresh, {
        bankId: resolvedBankId,
        entryDate,
        userId: req.user.id,
      });
      return { id: jeId, cheque_number: row.cheque_number, date: entryDate };
    })();

    audit(req.user.id, 'cheque_resend', 'cheque_record', req.params.id, result.cheque_number);
    res.json({
      ok: true,
      journal_entry_id: result.id,
      lifecycle_status: 'cleared',
      date: result.date,
    });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
});

function runLifecycleAction(req, res, fn, extraOpts) {
  try {
    const db = getDB();
    const result = db.transaction(() => {
      const row = db.prepare('SELECT * FROM cheque_records WHERE id=?').get(req.params.id);
      if (!row) throw Object.assign(new Error('یافت نشد'), { status: 404 });
      return fn(db, row, {
        user: req.user,
        date: req.body.date,
        clientRequestId: req.body.client_request_id || req.get('Idempotency-Key') || null,
        todayFn: todayJalali,
        body: req.body || {},
        ...(typeof extraOpts === 'function' ? extraOpts(req) : (extraOpts || {})),
      });
    })();
    audit(req.user.id, 'cheque_lifecycle', 'cheque_record', req.params.id, result.lifecycle_status);
    res.json(result);
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
}

/** وصول/واخواست/پاس گروهی — یک تراکنش برای همهٔ ids */
router.post('/batch-action', auth, adminOrAccounting, requireChequeOperate, requireChequeHighValueApprove, (req, res) => {
  try {
    const db = getDB();
    const body = req.body || {};
    const result = db.transaction(() => runBatchChequeAction(db, {
      action: body.action,
      ids: body.ids,
      date: body.date,
      bankId: body.bank_id || body.collection_bank_id || null,
      depositSlipNo: body.deposit_slip_no,
      user: req.user,
      todayFn: todayJalali,
      clientRequestId: body.client_request_id || req.get('Idempotency-Key') || null,
    }))();
    audit(req.user.id, 'cheque_batch', 'cheque_record', null, `${result.action}×${(result.results || []).length}`);
    res.json(result);
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
});

router.post('/:id/return-to-drawer', auth, adminOrAccounting, requireChequeOperate, (req, res) => {
  runLifecycleAction(req, res, returnToDrawer);
});
router.post('/:id/endorse-return', auth, adminOrAccounting, requireChequeOperate, (req, res) => {
  runLifecycleAction(req, res, endorseReturn);
});
/** پاس چک پرداختنی — Dr 2109 / Cr بانک */
router.post('/:id/out-clear', auth, adminOrAccounting, requireChequeOperate, requireChequeHighValueApprove, (req, res) => {
  runLifecycleAction(req, res, outClear, (r) => ({
    bankId: (r.body && (r.body.bank_id || r.body.collection_bank_id)) || null,
  }));
});
router.post('/:id/out-bounce', auth, adminOrAccounting, requireChequeOperate, requireChequeHighValueApprove, (req, res) => {
  runLifecycleAction(req, res, outBounce);
});
router.post('/:id/out-void', auth, adminOrAccounting, requireChequeOperate, requireChequeHighValueApprove, (req, res) => {
  runLifecycleAction(req, res, outVoid);
});
router.post('/:id/replace', auth, adminOrAccounting, requireChequeOperate, (req, res) => {
  runLifecycleAction(req, res, replaceCheque);
});
router.post('/:id/reverse-last-event', auth, adminOrAccounting, requireChequeOperate, (req, res) => {
  runLifecycleAction(req, res, reverseLastEvent);
});
router.post('/:id/guarantee', auth, adminOrAccounting, requireChequeOperate, (req, res) => {
  runLifecycleAction(req, res, markGuarantee);
});

/** Record event after legacy lifecycle endpoints when client_request_id present. */
function maybeLogLegacyEvent(db, row, from, to, jeId, user, date, note) {
  try {
    insertChequeEvent(db, {
      chequeId: row.id,
      fromStatus: from,
      toStatus: to,
      eventDate: date || todayJalali(),
      journalEntryId: jeId,
      createdBy: user && user.id,
      note: note || '',
    });
  } catch (_) { /* */ }
}
void maybeLogLegacyEvent;

module.exports = router;
module.exports.chequeExpensePosting = chequeExpensePosting;
