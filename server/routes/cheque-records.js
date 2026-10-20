const router = require('express').Router();
const { getDB, audit } = require('../db');
const { auth, adminOrAccounting } = require('../middleware/auth');
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

function resolveChequeParty(db, body) {
  const partyId = parseInt(body && body.party_id, 10);
  if (!Number.isFinite(partyId) || partyId <= 0) {
    const err = new Error('طرف حساب باید از فهرست اشخاص انتخاب شود');
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

router.post('/', auth, adminOrAccounting, (req, res) => {
  const {
    direction, cheque_number, issue_date, receive_date, due_date,
    bank_name, branch, sayadi, sheba, account_number,
    status, status_note, amount, note, opening
  } = req.body;
  if (!direction || !amount) return res.status(400).json({ error: 'جهت و مبلغ الزامی است' });
  const amountNum = Math.round(Number(String(amount).replace(/[,\s]/g, '')));
  if (!Number.isFinite(amountNum) || amountNum <= 0) {
    return res.status(400).json({ error: 'مبلغ چک باید عدد مثبت معتبر باشد (ریال)' });
  }
  const db = getDB();
  let party;
  try {
    party = resolveChequeParty(db, req.body);
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
  const finalNote = opening ? (note ? note + ' — ' + OPENING_NOTE : OPENING_NOTE) : (note || '');
  const recordId = db.transaction(() => {
    const defaultStatus = opening
      ? 'مانده اول دوره'
      : (direction === 'in' ? 'نزد صندوق' : 'ثبت‌شده');
    const result = db.prepare(`
      INSERT INTO cheque_records (
        direction, cheque_number, issue_date, receive_date, due_date,
        bank_name, branch, sayadi, sheba, account_number,
        party_name, party_id, customer_id, status, status_note, amount, note, created_by_name,
        lifecycle_status
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      direction, String(cheque_number || ''), issue_date || '', receive_date || '', due_date || '',
      bank_name || '', branch || '', sayadi || '', sheba || '', account_number || '',
      party.partyName, party.partyId, party.customerId,
      status || defaultStatus, status_note || '',
      amountNum, finalNote, req.user.name || '',
      'registered'
    );
    if (opening) {
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
        sourceType: 'opening_cheque', sourceId: result.lastInsertRowid,
        date: issue_date || todayJalali(), description: `چک ${direction === 'in' ? 'دریافتنی' : 'پرداختنی'} اول دوره ${cheque_number || ''}`,
        createdBy: req.user.id, voucherType: 'opening',
        srcSystem: req.body.from_excel || req.body.src_system === 'excel' ? 'excel' : null,
        lines,
      });
      db.prepare('UPDATE cheque_records SET journal_entry_id=? WHERE id=?').run(journalId, result.lastInsertRowid);
    }
    const saved = db.prepare('SELECT * FROM cheque_records WHERE id=?').get(result.lastInsertRowid);
    postChequeInReceipt(db, saved, req.user.id, receive_date || issue_date || todayJalali());
    return result.lastInsertRowid;
  })();
  audit(req.user.id, 'create', 'cheque_record', recordId, `ثبت چک ${cheque_number || recordId}`);
  res.json(db.prepare('SELECT * FROM cheque_records WHERE id=?').get(recordId));
});

router.patch('/:id/status', auth, adminOrAccounting, (req, res) => {
  const { status, status_note } = req.body;
  const db = getDB();
  const row = db.prepare('SELECT * FROM cheque_records WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  try {
    refuseFreeTextFinancial(row, status);
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
  db.prepare('UPDATE cheque_records SET status=?, status_note=? WHERE id=?')
    .run(status || row.status, status_note ?? row.status_note, req.params.id);
  audit(req.user.id, 'update', 'cheque_record', req.params.id, `تغییر وضعیت چک ${row.cheque_number}`);
  res.json({ ok: true });
});

function voidChequeHttp(req, res) {
  try {
    const db = getDB();
    res.json(voidChequeRecord(db, req.params.id, req.user));
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
}

router.delete('/:id', auth, adminOrAccounting, voidChequeHttp);
router.post('/:id/cancel', auth, adminOrAccounting, voidChequeHttp);
router.post('/:id/void', auth, adminOrAccounting, voidChequeHttp);

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

router.post('/:id/send-to-bank', auth, adminOrAccounting, (req, res) => {
  try {
    const db = getDB();
    const amountProbe = db.prepare("SELECT amount FROM cheque_records WHERE id=? AND direction='in'").get(req.params.id);
    if (!amountProbe) return res.status(404).json({ error: 'چک دریافتنی یافت نشد' });
    const amountRial = Math.round(Number(amountProbe.amount) || 0);
    if (amountRial <= 0) throw new Error('مبلغ چک نامعتبر است');

    const collection = acct(db, 'coa_cheques_in_collection');
    const receivable = acct(db, 'coa_cheques_receivable');
    const amt = amountRial / 10;
    const bankId = req.body.collection_bank_id || null;
    const entryDate = resolveChequeEntryDate(req.body.date);

    const jeId = db.transaction(() => {
      const row = db.prepare("SELECT * FROM cheque_records WHERE id=? AND direction='in'").get(req.params.id);
      if (!row) {
        throw Object.assign(new Error('چک دریافتنی یافت نشد'), { status: 404 });
      }
      assertPosted(row);
      postChequeInReceipt(db, row, req.user.id, entryDate);
      if (!isRegistered(row)) {
        throw Object.assign(new Error('وضعیت چرخه این چک اجازه واگذاری به بانک را نمی‌دهد'), { status: 400, code: 'E_CHEQUE_LIFECYCLE' });
      }
      const resolvedBankId = bankId;
      if (!resolvedBankId) {
        throw Object.assign(new Error('بانک وصول برای واگذاری الزامی است'), { status: 400, code: 'E_CHEQUE_BANK' });
      }
      const bank = db.prepare('SELECT id FROM banks WHERE id=?').get(resolvedBankId);
      if (!bank) {
        throw Object.assign(new Error('بانک وصول معتبر نیست'), { status: 400, code: 'E_CHEQUE_BANK' });
      }
      assertJournalIdempotent(db, 'cheque_send_to_bank', row.id);
      const id = postToLedger(db, {
        sourceType: 'cheque_send_to_bank', sourceId: row.id,
        date: entryDate,
        description: `واگذاری چک ${row.cheque_number || row.id} به بانک`,
        createdBy: req.user.id,
        lines: [
          { code: collection.code, name: collection.name, debit: amt, credit: 0, debit_rial: amountRial },
          { code: receivable.code, name: receivable.name, debit: 0, credit: amt, credit_rial: amountRial },
        ],
      });
      const updated = db.prepare(`
        UPDATE cheque_records
        SET lifecycle_status='in_collection', collection_bank_id=?, collection_je_id=?, status='واگذارشده'
        WHERE id=? AND ${sqlIsRegistered('lifecycle_status')}
          AND COALESCE(record_status,'posted')<>'reversed'
      `).run(resolvedBankId, id, row.id);
      if (!updated.changes) {
        throw Object.assign(new Error('وضعیت چرخه این چک اجازه ارسال به بانک را نمی‌دهد'), { status: 400, code: 'E_CHEQUE_LIFECYCLE' });
      }
      syncSettlementChequeStatus(db, row.id);
      return id;
    })();

    const row = db.prepare('SELECT cheque_number FROM cheque_records WHERE id=?').get(req.params.id);
    audit(req.user.id, 'cheque_send_bank', 'cheque_record', req.params.id, row?.cheque_number);
    res.json({ ok: true, journal_entry_id: jeId, lifecycle_status: 'in_collection' });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
});

router.post('/:id/clear', auth, adminOrAccounting, (req, res) => {
  try {
    const db = getDB();
    const amountProbe = db.prepare("SELECT amount, collection_bank_id FROM cheque_records WHERE id=? AND direction='in'").get(req.params.id);
    if (!amountProbe) return res.status(404).json({ error: 'چک دریافتنی یافت نشد' });

    const amountRial = Math.round(Number(amountProbe.amount) || 0);
    const bank = acct(db, 'coa_bank_default');
    const collection = acct(db, 'coa_cheques_in_collection');
    const amt = amountRial / 10;
    const bankId = req.body.bank_id || amountProbe.collection_bank_id;
    const entryDate = resolveChequeEntryDate(req.body.date);

    const jeId = db.transaction(() => {
      const row = db.prepare("SELECT * FROM cheque_records WHERE id=? AND direction='in'").get(req.params.id);
      if (!row) throw Object.assign(new Error('چک دریافتنی یافت نشد'), { status: 404 });
      if (row.lifecycle_status !== 'in_collection') {
        throw Object.assign(new Error('چک باید در وضعیت «در جریان وصول» باشد'), { status: 400, code: 'E_CHEQUE_LIFECYCLE' });
      }
      assertClearNotBeforeSend(db, row, entryDate);
      postChequeInReceipt(db, row, req.user.id, entryDate);
      assertJournalIdempotent(db, 'cheque_clear', row.id);

      let cashLine = bank;
      let resolvedBankId = bankId || null;
      if (resolvedBankId) {
        const b = db.prepare('SELECT id, coa_code, name FROM banks WHERE id=?').get(resolvedBankId);
        if (!b) {
          throw Object.assign(new Error('بانک واریز معتبر نیست'), { status: 400, code: 'E_CHEQUE_BANK' });
        }
        cashLine = { code: b.coa_code || ('1102-' + b.id), name: b.name || bank.name };
        resolvedBankId = b.id;
      }

      const id = postToLedger(db, {
        sourceType: 'cheque_clear', sourceId: row.id,
        date: entryDate,
        description: `وصول چک ${row.cheque_number || row.id}`,
        createdBy: req.user.id,
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
      `).run(id, resolvedBankId, row.id);
      if (!updated.changes) {
        throw Object.assign(new Error('چک باید در وضعیت «در جریان وصول» باشد'), { status: 400, code: 'E_CHEQUE_LIFECYCLE' });
      }
      syncSettlementChequeStatus(db, row.id);
      return id;
    })();

    const row = db.prepare('SELECT cheque_number FROM cheque_records WHERE id=?').get(req.params.id);
    audit(req.user.id, 'cheque_clear', 'cheque_record', req.params.id, row?.cheque_number);
    res.json({ ok: true, journal_entry_id: jeId, lifecycle_status: 'cleared', date: entryDate });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
});

router.post('/:id/bounce', auth, adminOrAccounting, (req, res) => {
  try {
    const db = getDB();
    const amountProbe = db.prepare("SELECT amount FROM cheque_records WHERE id=? AND direction='in'").get(req.params.id);
    if (!amountProbe) return res.status(404).json({ error: 'چک دریافتنی یافت نشد' });

    const entryDate = resolveChequeEntryDate(req.body.date);

    const jeId = db.transaction(() => {
      const row = db.prepare("SELECT * FROM cheque_records WHERE id=? AND direction='in'").get(req.params.id);
      if (!row) throw Object.assign(new Error('چک دریافتنی یافت نشد'), { status: 404 });
      if (!['in_collection', 'cleared'].includes(row.lifecycle_status)) {
        throw Object.assign(new Error('فقط چک‌های واگذارشده یا وصول‌شده قابل برگشت هستند'), { status: 400, code: 'E_CHEQUE_LIFECYCLE' });
      }
      assertJournalIdempotent(db, 'cheque_bounce', row.id);
      const id = postChequeBounce(db, row, req.user.id, entryDate);
      const updated = db.prepare(`
        UPDATE cheque_records SET lifecycle_status='bounced', bounced_je_id=?, status='برگشتی'
        WHERE id=? AND lifecycle_status IN ('in_collection','cleared')
      `).run(id, row.id);
      if (!updated.changes) {
        throw Object.assign(new Error('فقط چک‌های واگذارشده یا وصول‌شده قابل برگشت هستند'), { status: 400, code: 'E_CHEQUE_LIFECYCLE' });
      }
      syncSettlementChequeStatus(db, row.id);
      return id;
    })();

    const row = db.prepare('SELECT cheque_number FROM cheque_records WHERE id=?').get(req.params.id);
    audit(req.user.id, 'cheque_bounce', 'cheque_record', req.params.id, row?.cheque_number);
    res.json({ ok: true, journal_entry_id: jeId, lifecycle_status: 'bounced' });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
});

/**
 * bounce → resend: reverse bounce JE and restore prior lifecycle
 * (cleared if clear JE still present, else in_collection).
 */
router.post('/:id/resend', auth, adminOrAccounting, (req, res) => {
  try {
    const db = getDB();
    const entryDate = resolveChequeEntryDate(req.body.date);

    const result = db.transaction(() => {
      const row = db.prepare("SELECT * FROM cheque_records WHERE id=? AND direction='in'").get(req.params.id);
      if (!row) throw Object.assign(new Error('چک دریافتنی یافت نشد'), { status: 404 });
      if (row.lifecycle_status !== 'bounced') {
        throw Object.assign(new Error('فقط چک برگشتی قابل ارسال مجدد است'), { status: 400, code: 'E_CHEQUE_LIFECYCLE' });
      }
      if (!row.bounced_je_id) {
        throw Object.assign(new Error('سند برگشت یافت نشد — ابطال کامل یا اصلاح دستی لازم است'), { status: 400, code: 'E_CHEQUE_LIFECYCLE' });
      }

      const prior = row.cleared_je_id ? 'cleared' : (row.collection_je_id ? 'in_collection' : 'registered');
      const statusLabel = prior === 'cleared' ? 'وصول‌شده' : (prior === 'in_collection' ? 'در جریان وصول' : 'ثبت‌شده');

      const id = reverseJournalEntry(db, row.bounced_je_id, {
        userId: req.user.id,
        date: entryDate,
        reason: `ارسال مجدد چک ${row.cheque_number || row.id} پس از برگشت`,
        sourceType: 'cheque_resend',
      });
      if (!id) {
        throw Object.assign(new Error('معکوس سند برگشت ناموفق بود'), { status: 400, code: 'E_CHEQUE_LIFECYCLE' });
      }
      reverseChequeLedgerByRef(db, {
        chequeId: row.id,
        refTypes: ['cheque_bounce'],
        date: entryDate,
        userId: req.user.id,
        descriptionPrefix: 'ارسال مجدد پس از برگشت',
      });
      const updated = db.prepare(`
        UPDATE cheque_records
        SET lifecycle_status=?, bounced_je_id=NULL, status=?
        WHERE id=? AND lifecycle_status='bounced'
      `).run(prior, statusLabel, row.id);
      if (!updated.changes) {
        throw Object.assign(new Error('فقط چک برگشتی قابل ارسال مجدد است'), { status: 400, code: 'E_CHEQUE_LIFECYCLE' });
      }
      syncSettlementChequeStatus(db, row.id);
      return { id, prior, cheque_number: row.cheque_number };
    })();

    audit(req.user.id, 'cheque_resend', 'cheque_record', req.params.id, result.cheque_number);
    res.json({ ok: true, journal_entry_id: result.id, lifecycle_status: result.prior });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
});

module.exports = router;
module.exports.chequeExpensePosting = chequeExpensePosting;
