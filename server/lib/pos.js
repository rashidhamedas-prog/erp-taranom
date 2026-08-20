'use strict';
/**
 * POS-01 / POS-02 — card terminals, in-transit receipts, batch bank settle, R13 void.
 * Money INTEGER rial in DB. postToLedger takes toman (rial/10).
 */

const { todayJalali } = require('../jalali');
const { acct, clearCoaCache } = require('./coa-map');
const { rialToLedger, SQL_JL_DEBIT_RIAL, SQL_JL_CREDIT_RIAL } = require('./money');

function dbApi() { return require('../db'); }
function ledgerApi() { return require('./ledger'); }
function voidJournalApi() { return require('./void-journal'); }
function repLedgerApi() { return require('./rep-ledger'); }

function httpErr(status, message, code, extra) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  if (extra) Object.assign(e, extra);
  return e;
}

function asRial(v, label) {
  const n = Math.round(Number(v) || 0);
  if (!Number.isSafeInteger(n) || n < 0) {
    throw httpErr(400, `مبلغ نامعتبر${label ? ' (' + label + ')' : ''}`, 'E_POS_AMOUNT');
  }
  return n;
}

function idemKey(v) {
  const s = String(v == null ? '' : v).trim();
  return s || null;
}

function ensurePosCoaAccounts(db) {
  const has = (code) => db.prepare('SELECT code FROM chart_of_accounts WHERE code=?').get(code);
  if (!has('1118')) {
    try {
      db.prepare('INSERT INTO chart_of_accounts (code,name,type,parent_code,level) VALUES (?,?,?,?,?)')
        .run('1118', 'وجوه در راه کارتخوان', 'asset', '1100', 2);
    } catch (_) { /* race / already present */ }
  }
  if (!has('6114')) {
    try {
      db.prepare('INSERT INTO chart_of_accounts (code,name,type,parent_code,level) VALUES (?,?,?,?,?)')
        .run('6114', 'کارمزد کارتخوان', 'expense', '6000', 2);
    } catch (_) { /* ignore */ }
  }
  const set = db.prepare('INSERT OR IGNORE INTO settings (key,value) VALUES (?,?)');
  set.run('coa_card_in_transit', '1118');
  set.run('coa_card_fee', '6114');
  try { clearCoaCache(); } catch (_) {}
}

function initPosSchema(db, ensureColumn) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pos_terminals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      terminal_id TEXT NOT NULL,
      merchant_id TEXT,
      bank_id INTEGER NOT NULL,
      active INTEGER DEFAULT 1,
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      updated_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(bank_id) REFERENCES banks(id)
    );
    CREATE TABLE IF NOT EXISTS pos_receipts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      terminal_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      amount_rial INTEGER NOT NULL,
      settled_rial INTEGER DEFAULT 0,
      invoice_id INTEGER,
      cust_id INTEGER,
      settlement_id INTEGER,
      journal_id INTEGER,
      status TEXT DEFAULT 'open',
      idempotency_key TEXT,
      ref TEXT,
      note TEXT,
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      reversed_at INTEGER,
      reversed_by INTEGER,
      reversal_journal_id INTEGER,
      FOREIGN KEY(terminal_id) REFERENCES pos_terminals(id)
    );
    CREATE TABLE IF NOT EXISTS pos_settlement_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      terminal_id INTEGER,
      date TEXT NOT NULL,
      gross_rial INTEGER NOT NULL,
      fee_rial INTEGER DEFAULT 0,
      shortage_rial INTEGER DEFAULT 0,
      net_rial INTEGER NOT NULL,
      bank_id INTEGER NOT NULL,
      journal_id INTEGER,
      status TEXT DEFAULT 'posted',
      idempotency_key TEXT,
      ref TEXT,
      note TEXT,
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      reversed_at INTEGER,
      reversed_by INTEGER,
      reversal_journal_id INTEGER
    );
    CREATE TABLE IF NOT EXISTS pos_settlement_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER NOT NULL,
      receipt_id INTEGER NOT NULL,
      amount_rial INTEGER NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
  `);

  if (typeof ensureColumn === 'function') {
    ensureColumn(db, 'pos_terminals', 'merchant_id', 'TEXT');
    ensureColumn(db, 'pos_terminals', 'updated_at', "INTEGER DEFAULT (strftime('%s','now'))");
    ensureColumn(db, 'pos_receipts', 'settled_rial', 'INTEGER DEFAULT 0');
    ensureColumn(db, 'pos_receipts', 'idempotency_key', 'TEXT');
    ensureColumn(db, 'pos_receipts', 'reversal_journal_id', 'INTEGER');
    ensureColumn(db, 'pos_settlement_batches', 'idempotency_key', 'TEXT');
    ensureColumn(db, 'pos_settlement_batches', 'reversal_journal_id', 'INTEGER');
  }

  try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_pos_terminals_terminal_id ON pos_terminals(terminal_id)'); }
  catch (e) { console.warn('⚠️ pos_terminals unique:', e.message); }
  try {
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_pos_receipts_idem
      ON pos_receipts(idempotency_key) WHERE idempotency_key IS NOT NULL AND idempotency_key!=''`);
  } catch (e) { console.warn('⚠️ pos_receipts idem index:', e.message); }
  try {
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_pos_batches_idem
      ON pos_settlement_batches(idempotency_key) WHERE idempotency_key IS NOT NULL AND idempotency_key!=''`);
  } catch (e) { console.warn('⚠️ pos_batches idem index:', e.message); }
  try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_pos_batch_items ON pos_settlement_items(batch_id, receipt_id)'); }
  catch (e) { console.warn('⚠️ pos_settlement_items unique:', e.message); }

  ensurePosCoaAccounts(db);
}

function requireActiveBank(db, bankId) {
  if (bankId == null || bankId === '' || Number.isNaN(Number(bankId))) {
    throw httpErr(400, 'بانک فعال الزامی است — از فهرست بانک‌ها انتخاب کنید', 'E_POS_BANK_REQUIRED');
  }
  const bank = db.prepare('SELECT * FROM banks WHERE id=?').get(Number(bankId));
  if (!bank) throw httpErr(400, 'بانک انتخاب‌شده وجود ندارد', 'E_POS_BANK_MISSING');
  if (!Number(bank.active)) throw httpErr(400, 'بانک انتخاب‌شده غیرفعال است', 'E_POS_BANK_INACTIVE');
  return bank;
}

function terminalRow(db, id) {
  return db.prepare(`
    SELECT t.*, b.name AS bank_name, b.account_number AS bank_account, b.coa_code AS bank_coa_code, b.active AS bank_active
    FROM pos_terminals t
    LEFT JOIN banks b ON b.id = t.bank_id
    WHERE t.id=?
  `).get(id);
}

function listTerminals(db, { includeInactive } = {}) {
  const where = includeInactive ? '' : 'WHERE t.active=1';
  return db.prepare(`
    SELECT t.*, b.name AS bank_name, b.account_number AS bank_account, b.coa_code AS bank_coa_code
    FROM pos_terminals t
    LEFT JOIN banks b ON b.id = t.bank_id
    ${where}
    ORDER BY t.id DESC
  `).all();
}

function createTerminal(db, body, user) {
  const name = String(body.name || '').trim();
  const terminalId = String(body.terminal_id || '').trim();
  const merchantId = body.merchant_id != null ? String(body.merchant_id).trim() : null;
  if (!name || !terminalId) {
    throw httpErr(400, 'نام و شماره پایانه الزامی است', 'E_POS_TERMINAL_FIELDS');
  }
  const bank = requireActiveBank(db, body.bank_id);
  const dup = db.prepare('SELECT id FROM pos_terminals WHERE terminal_id=?').get(terminalId);
  if (dup) throw httpErr(409, 'شماره پایانه تکراری است', 'E_POS_TERMINAL_DUP');
  let id;
  try {
    id = db.prepare(`
      INSERT INTO pos_terminals (name, terminal_id, merchant_id, bank_id, active, created_by)
      VALUES (?,?,?,?,1,?)
    `).run(name, terminalId, merchantId, bank.id, user.id).lastInsertRowid;
  } catch (e) {
    if (/UNIQUE/i.test(e.message)) throw httpErr(409, 'شماره پایانه تکراری است', 'E_POS_TERMINAL_DUP');
    throw e;
  }
  dbApi().audit(user.id, 'create', 'pos_terminal', id, `تعریف کارتخوان ${name} / ${terminalId}`);
  return terminalRow(db, id);
}

function updateTerminal(db, id, body, user) {
  const row = db.prepare('SELECT * FROM pos_terminals WHERE id=?').get(id);
  if (!row) throw httpErr(404, 'کارتخوان یافت نشد', 'E_POS_TERMINAL');
  const name = body.name != null ? String(body.name).trim() : row.name;
  const terminalId = body.terminal_id != null ? String(body.terminal_id).trim() : row.terminal_id;
  const merchantId = body.merchant_id !== undefined ? (String(body.merchant_id || '').trim() || null) : row.merchant_id;
  if (!name || !terminalId) throw httpErr(400, 'نام و شماره پایانه الزامی است', 'E_POS_TERMINAL_FIELDS');
  if (terminalId !== row.terminal_id) {
    const dup = db.prepare('SELECT id FROM pos_terminals WHERE terminal_id=? AND id<>?').get(terminalId, id);
    if (dup) throw httpErr(409, 'شماره پایانه تکراری است', 'E_POS_TERMINAL_DUP');
  }
  let bankId = row.bank_id;
  if (body.bank_id != null) {
    bankId = requireActiveBank(db, body.bank_id).id;
  }
  const active = body.active != null ? (body.active ? 1 : 0) : row.active;
  try {
    db.prepare(`
      UPDATE pos_terminals
      SET name=?, terminal_id=?, merchant_id=?, bank_id=?, active=?, updated_at=strftime('%s','now')
      WHERE id=?
    `).run(name, terminalId, merchantId, bankId, active, id);
  } catch (e) {
    if (/UNIQUE/i.test(e.message)) throw httpErr(409, 'شماره پایانه تکراری است', 'E_POS_TERMINAL_DUP');
    throw e;
  }
  dbApi().audit(user.id, 'update', 'pos_terminal', id, `ویرایش کارتخوان ${name}`);
  return terminalRow(db, id);
}

function deactivateTerminal(db, id, user) {
  const row = db.prepare('SELECT * FROM pos_terminals WHERE id=?').get(id);
  if (!row) throw httpErr(404, 'کارتخوان یافت نشد', 'E_POS_TERMINAL');
  db.prepare("UPDATE pos_terminals SET active=0, updated_at=strftime('%s','now') WHERE id=?").run(id);
  dbApi().audit(user.id, 'update', 'pos_terminal', id, `غیرفعال‌سازی کارتخوان ${row.name}`);
  return terminalRow(db, id);
}

function recvAcct(db, custId) {
  const c = custId ? db.prepare('SELECT coa_code FROM customers WHERE id=?').get(custId) : null;
  if (c && c.coa_code) {
    const a = db.prepare('SELECT code,name FROM chart_of_accounts WHERE code=?').get(c.coa_code);
    if (a) return a;
  }
  return acct(db, 'coa_receivable');
}

function invoiceOpenRial(db, invoiceId) {
  const inv = db.prepare('SELECT * FROM invoices WHERE id=?').get(invoiceId);
  if (!inv) throw httpErr(404, 'فاکتور یافت نشد', 'E_POS_INVOICE');
  if (inv.deleted_at || inv.status === 'reversed') {
    throw httpErr(400, 'فاکتور ابطال شده است', 'E_POS_INVOICE');
  }
  const total = Number(inv.final_rial) || Number(inv.amount_rial) || Math.round(Number(inv.final) || 0);
  const paid = db.prepare(`
    SELECT COALESCE(SUM(COALESCE(NULLIF(amount_rial,0), amount)),0) s
    FROM settlements WHERE invoice_id=? AND COALESCE(status,'posted')<>'reversed'
  `).get(invoiceId).s;
  return { inv, total, paid: Number(paid) || 0, open: total - (Number(paid) || 0) };
}

function receiptRemaining(r) {
  if (!r || r.status === 'reversed') return 0;
  return Math.max(0, Number(r.amount_rial) - Number(r.settled_rial || 0));
}

function refreshReceiptStatus(db, id) {
  const r = db.prepare('SELECT * FROM pos_receipts WHERE id=?').get(id);
  if (!r || r.status === 'reversed') return r;
  const rem = receiptRemaining(r);
  const next = rem <= 0 ? 'settled' : (Number(r.settled_rial) > 0 ? 'partial' : 'open');
  if (next !== r.status) {
    db.prepare('UPDATE pos_receipts SET status=? WHERE id=?').run(next, id);
    r.status = next;
  }
  return r;
}

function listReceipts(db, query = {}) {
  const where = [];
  const params = [];
  if (query.status) { where.push('r.status=?'); params.push(query.status); }
  if (query.terminal_id) { where.push('r.terminal_id=?'); params.push(Number(query.terminal_id)); }
  if (query.open === '1' || query.open === 1) {
    where.push("r.status IN ('open','partial')");
    where.push('r.amount_rial > COALESCE(r.settled_rial,0)');
  }
  const sqlWhere = where.length ? 'WHERE ' + where.join(' AND ') : '';
  return db.prepare(`
    SELECT r.*, t.name AS terminal_name, t.terminal_id AS terminal_code,
           b.name AS bank_name, c.biz AS cust_biz, i.num AS invoice_num,
           (r.amount_rial - COALESCE(r.settled_rial,0)) AS open_rial
    FROM pos_receipts r
    LEFT JOIN pos_terminals t ON t.id = r.terminal_id
    LEFT JOIN banks b ON b.id = t.bank_id
    LEFT JOIN customers c ON c.id = r.cust_id
    LEFT JOIN invoices i ON i.id = r.invoice_id
    ${sqlWhere}
    ORDER BY r.id DESC
    LIMIT 400
  `).all(...params);
}

function findIdempotentReceipt(db, key) {
  if (!key) return null;
  return db.prepare('SELECT * FROM pos_receipts WHERE idempotency_key=?').get(key);
}

function postReceipt(db, body, user) {
  ensurePosCoaAccounts(db);
  const key = idemKey(body.idempotency_key);
  if (key) {
    const existing = findIdempotentReceipt(db, key);
    if (existing) throw httpErr(409, 'این دریافت قبلاً ثبت شده است', 'E_POS_IDEMPOTENT', { id: existing.id });
  }
  const terminal = db.prepare('SELECT * FROM pos_terminals WHERE id=?').get(Number(body.terminal_id));
  if (!terminal) throw httpErr(400, 'کارتخوان معتبر نیست', 'E_POS_TERMINAL');
  if (!Number(terminal.active)) throw httpErr(400, 'کارتخوان غیرفعال است', 'E_POS_TERMINAL_INACTIVE');
  requireActiveBank(db, terminal.bank_id);

  const amountRial = asRial(body.amount_rial != null ? body.amount_rial : body.amount, 'مبلغ دریافت');
  if (amountRial <= 0) throw httpErr(400, 'مبلغ دریافت باید بزرگ‌تر از صفر باشد', 'E_POS_AMOUNT');
  const date = String(body.date || todayJalali()).trim();
  let invoiceId = body.invoice_id ? Number(body.invoice_id) : null;
  let custId = body.cust_id ? Number(body.cust_id) : null;
  if (invoiceId) {
    const open = invoiceOpenRial(db, invoiceId);
    if (!custId) custId = open.inv.cust_id;
    if (custId && open.inv.cust_id && Number(custId) !== Number(open.inv.cust_id)) {
      throw httpErr(400, 'مشتری با فاکتور هم‌خوان نیست', 'E_POS_INVOICE_CUST');
    }
    if (amountRial > open.open + 0.5) {
      throw httpErr(400, 'مبلغ از مانده فاکتور بیشتر است', 'E_POS_INVOICE_OVER');
    }
    custId = open.inv.cust_id || custId;
  }
  if (custId) {
    const cust = db.prepare('SELECT id FROM customers WHERE id=?').get(custId);
    if (!cust) throw httpErr(400, 'مشتری یافت نشد', 'E_POS_CUSTOMER');
  }

  const inTransit = acct(db, 'coa_card_in_transit');
  const creditAcct = custId ? recvAcct(db, custId) : acct(db, 'coa_sales');
  const toman = rialToLedger(amountRial);

  const result = db.transaction(() => {
    let receiptId;
    try {
      receiptId = db.prepare(`
        INSERT INTO pos_receipts
          (terminal_id, date, amount_rial, settled_rial, invoice_id, cust_id,
           status, idempotency_key, ref, note, created_by)
        VALUES (?,?,?,0,?,?,'open',?,?,?,?)
      `).run(
        terminal.id, date, amountRial, invoiceId, custId,
        key, String(body.ref || '').trim(), String(body.note || '').trim(), user.id
      ).lastInsertRowid;
    } catch (e) {
      if (/UNIQUE/i.test(e.message)) throw httpErr(409, 'این دریافت قبلاً ثبت شده است', 'E_POS_IDEMPOTENT');
      throw e;
    }

    const { postToLedger } = ledgerApi();
    const journalId = postToLedger(db, {
      sourceType: 'pos_receipt',
      sourceId: receiptId,
      date,
      description: `دریافت کارتخوان ${terminal.terminal_id} — ${amountRial.toLocaleString('fa-IR')} ریال`,
      createdBy: user.id,
      lines: [
        { code: inTransit.code, name: inTransit.name, debit: toman, credit: 0 },
        { code: creditAcct.code, name: creditAcct.name, debit: 0, credit: toman },
      ],
    });

    let settlementId = null;
    if (custId) {
      dbApi().createLedgerEntry(db, {
        customer_id: custId, date, entry_type: 'settlement',
        ref_type: 'pos_receipt', ref_id: receiptId,
        description: `دریافت کارتخوان — ${amountRial.toLocaleString('fa-IR')} ریال`,
        debit: 0, credit: amountRial, user_id: user.id,
      });
    }
    if (invoiceId && custId) {
      const ins = db.prepare(`
        INSERT INTO settlements
          (user_id, cust_id, invoice_id, amount, amount_rial, pay_type, date, note, bank_id)
        VALUES (?,?,?,?,?,'pos_card',?,?,?)
      `);
      settlementId = ins.run(
        user.id, custId, invoiceId, amountRial, amountRial, date,
        'دریافت کارتخوان (در راه)', terminal.bank_id
      ).lastInsertRowid;
      try {
        const { recordSettlementCommissionAccrual } = repLedgerApi();
        const inv = db.prepare('SELECT * FROM invoices WHERE id=?').get(invoiceId);
        if (inv) {
          recordSettlementCommissionAccrual(db, { id: settlementId, amount: amountRial, date }, inv, user.id);
        }
      } catch (_) { /* commission optional */ }
    }

    db.prepare('UPDATE pos_receipts SET journal_id=?, settlement_id=? WHERE id=?')
      .run(journalId, settlementId, receiptId);
    return { receiptId, journalId, settlementId };
  })();

  dbApi().audit(user.id, 'create', 'pos_receipt', result.receiptId, `دریافت کارتخوان ${amountRial} ریال`);
  const row = db.prepare('SELECT * FROM pos_receipts WHERE id=?').get(result.receiptId);
  return Object.assign(row, { journal_id: result.journalId, settlement_id: result.settlementId });
}

function voidReceipt(db, id, user, { reason } = {}) {
  const row = db.prepare('SELECT * FROM pos_receipts WHERE id=?').get(id);
  if (!row) throw httpErr(404, 'دریافت کارتخوان یافت نشد', 'E_POS_RECEIPT');
  if (row.status === 'reversed') throw httpErr(409, 'این دریافت قبلاً ابطال شده است', 'E_POS_ALREADY_REVERSED');
  const inBatch = db.prepare(`
    SELECT i.id FROM pos_settlement_items i
    JOIN pos_settlement_batches b ON b.id = i.batch_id
    WHERE i.receipt_id=? AND COALESCE(b.status,'posted')<>'reversed'
    LIMIT 1
  `).get(id);
  if (inBatch) {
    throw httpErr(409, 'ابتدا دسته تسویه را ابطال کنید', 'E_POS_IN_BATCH');
  }

  const out = db.transaction(() => {
    const { reverseJournalEntry } = voidJournalApi();
    const revJe = reverseJournalEntry(db, row.journal_id, {
      userId: user.id,
      reason: reason || 'ابطال دریافت کارتخوان',
      sourceType: 'pos_receipt_reversal',
    });
    if (row.cust_id) {
      dbApi().createLedgerEntry(db, {
        customer_id: row.cust_id, date: todayJalali(), entry_type: 'reversal',
        ref_type: 'pos_receipt', ref_id: row.id,
        description: `ابطال دریافت کارتخوان شماره ${row.id}`,
        debit: row.amount_rial, credit: 0, user_id: user.id,
      });
    }
    if (row.settlement_id) {
      db.prepare(`
        UPDATE settlements SET status='reversed', reversed_at=strftime('%s','now'), reversed_by=?
        WHERE id=? AND COALESCE(status,'posted')<>'reversed'
      `).run(user.id, row.settlement_id);
      try { repLedgerApi().reverseCommissionAccrual(db, 'settlement', row.settlement_id, user.id, todayJalali()); }
      catch (_) {}
    }
    db.prepare(`
      UPDATE pos_receipts
      SET status='reversed', reversed_at=strftime('%s','now'), reversed_by=?, reversal_journal_id=?
      WHERE id=?
    `).run(user.id, revJe, row.id);
    return { id: row.id, status: 'reversed', reversal_journal_id: revJe };
  })();

  dbApi().audit(user.id, 'reverse', 'pos_receipt', row.id, `ابطال دریافت کارتخوان #${row.id}`);
  return Object.assign(db.prepare('SELECT * FROM pos_receipts WHERE id=?').get(id), out);
}

function listBatches(db, query = {}) {
  const where = [];
  const params = [];
  if (query.status) { where.push('b.status=?'); params.push(query.status); }
  const sqlWhere = where.length ? 'WHERE ' + where.join(' AND ') : '';
  return db.prepare(`
    SELECT b.*, bk.name AS bank_name, t.name AS terminal_name, t.terminal_id AS terminal_code
    FROM pos_settlement_batches b
    LEFT JOIN banks bk ON bk.id = b.bank_id
    LEFT JOIN pos_terminals t ON t.id = b.terminal_id
    ${sqlWhere}
    ORDER BY b.id DESC
    LIMIT 300
  `).all(...params);
}

function allocateBatchItems(db, body, grossRial) {
  const items = [];
  if (Array.isArray(body.items) && body.items.length) {
    for (const it of body.items) {
      const rid = Number(it.receipt_id || it.id);
      const rec = db.prepare('SELECT * FROM pos_receipts WHERE id=?').get(rid);
      if (!rec) throw httpErr(400, 'دریافت #' + rid + ' یافت نشد', 'E_POS_RECEIPT');
      if (rec.status === 'reversed') throw httpErr(409, 'دریافت ابطال‌شده قابل تسویه نیست', 'E_POS_ALREADY_REVERSED');
      const rem = receiptRemaining(rec);
      if (rem <= 0) throw httpErr(409, 'دریافت قبلاً تسویه شده است', 'E_POS_ALREADY_SETTLED');
      const amt = it.amount_rial != null ? asRial(it.amount_rial, 'سهم دریافت') : rem;
      if (amt <= 0 || amt > rem) throw httpErr(400, 'مبلغ سهم دریافت نامعتبر است', 'E_POS_AMOUNT');
      items.push({ receipt: rec, amount_rial: amt });
    }
  } else {
    const ids = Array.isArray(body.receipt_ids) ? body.receipt_ids.map(Number).filter(Boolean) : [];
    let pool;
    if (ids.length) {
      pool = ids.map((rid) => {
        const rec = db.prepare('SELECT * FROM pos_receipts WHERE id=?').get(rid);
        if (!rec) throw httpErr(400, 'دریافت #' + rid + ' یافت نشد', 'E_POS_RECEIPT');
        return rec;
      });
    } else {
      const tid = body.terminal_id ? Number(body.terminal_id) : null;
      pool = db.prepare(`
        SELECT * FROM pos_receipts
        WHERE status IN ('open','partial') AND amount_rial > COALESCE(settled_rial,0)
          ${tid ? 'AND terminal_id=?' : ''}
        ORDER BY id ASC
      `).all(...(tid ? [tid] : []));
    }
    let left = grossRial;
    for (const rec of pool) {
      if (left <= 0) break;
      if (rec.status === 'reversed') continue;
      const rem = receiptRemaining(rec);
      if (rem <= 0) {
        if (ids.length) throw httpErr(409, 'دریافت قبلاً تسویه شده است', 'E_POS_ALREADY_SETTLED');
        continue;
      }
      const take = Math.min(rem, left);
      items.push({ receipt: rec, amount_rial: take });
      left -= take;
    }
    if (left > 0 && ids.length) {
      throw httpErr(400, 'جمع مانده دریافت‌ها کمتر از مبلغ ناخالص است', 'E_POS_GROSS_MISMATCH');
    }
  }
  const sum = items.reduce((s, it) => s + it.amount_rial, 0);
  if (sum !== grossRial) {
    throw httpErr(400, `جمع دریافت‌ها (${sum}) با مبلغ ناخالص (${grossRial}) برابر نیست`, 'E_POS_GROSS_MISMATCH');
  }
  if (!items.length) throw httpErr(400, 'هیچ دریافت بازی برای تسویه نیست', 'E_POS_NO_RECEIPTS');
  return items;
}

function settleBatch(db, body, user) {
  ensurePosCoaAccounts(db);
  const key = idemKey(body.idempotency_key);
  if (key) {
    const existing = db.prepare('SELECT * FROM pos_settlement_batches WHERE idempotency_key=?').get(key);
    if (existing) throw httpErr(409, 'این تسویه قبلاً ثبت شده است', 'E_POS_IDEMPOTENT', { id: existing.id });
  }
  const gross = asRial(body.gross_rial, 'ناخالص');
  const fee = asRial(body.fee_rial || 0, 'کارمزد');
  const shortage = asRial(body.shortage_rial || 0, 'کسری');
  if (gross <= 0) throw httpErr(400, 'مبلغ ناخالص باید بزرگ‌تر از صفر باشد', 'E_POS_AMOUNT');
  const net = gross - fee - shortage;
  if (net < 0) throw httpErr(400, 'کارمزد و کسری از مبلغ ناخالص بیشتر است', 'E_POS_NET');
  const date = String(body.date || todayJalali()).trim();

  const items = allocateBatchItems(db, body, gross);
  const terminalIds = [...new Set(items.map((it) => it.receipt.terminal_id))];
  const terminals = terminalIds.map((tid) => {
    const t = db.prepare('SELECT * FROM pos_terminals WHERE id=?').get(tid);
    if (!t) throw httpErr(400, 'کارتخوان دریافت نامعتبر است', 'E_POS_TERMINAL');
    return t;
  });
  const bankIds = [...new Set(terminals.map((t) => t.bank_id))];
  if (bankIds.length !== 1) {
    throw httpErr(400, 'همه دریافت‌های یک دسته باید به یک بانک واریز شوند', 'E_POS_BANK_MIXED');
  }
  const bank = requireActiveBank(db, bankIds[0]);
  const bankAcct = bank.coa_code
    ? db.prepare('SELECT code,name FROM chart_of_accounts WHERE code=?').get(bank.coa_code)
    : null;
  if (!bankAcct) throw httpErr(400, 'حساب معین بانک کارتخوان تعریف نشده است', 'E_POS_BANK_COA');

  const inTransit = acct(db, 'coa_card_in_transit');
  const feeAcct = acct(db, 'coa_card_fee');
  const shortageAcct = acct(db, 'coa_admin_expense');
  const headerTerminalId = body.terminal_id
    ? Number(body.terminal_id)
    : (terminalIds.length === 1 ? terminalIds[0] : null);

  const out = db.transaction(() => {
    let batchId;
    try {
      batchId = db.prepare(`
        INSERT INTO pos_settlement_batches
          (terminal_id, date, gross_rial, fee_rial, shortage_rial, net_rial, bank_id,
           status, idempotency_key, ref, note, created_by)
        VALUES (?,?,?,?,?,?,?,'posted',?,?,?,?)
      `).run(
        headerTerminalId, date, gross, fee, shortage, net, bank.id,
        key, String(body.ref || '').trim(), String(body.note || '').trim(), user.id
      ).lastInsertRowid;
    } catch (e) {
      if (/UNIQUE/i.test(e.message)) throw httpErr(409, 'این تسویه قبلاً ثبت شده است', 'E_POS_IDEMPOTENT');
      throw e;
    }

    const insItem = db.prepare('INSERT INTO pos_settlement_items (batch_id, receipt_id, amount_rial) VALUES (?,?,?)');
    const updRec = db.prepare('UPDATE pos_receipts SET settled_rial = COALESCE(settled_rial,0) + ? WHERE id=?');
    for (const it of items) {
      const rem = receiptRemaining(db.prepare('SELECT * FROM pos_receipts WHERE id=?').get(it.receipt.id));
      if (it.amount_rial > rem) throw httpErr(409, 'دریافت قبلاً تسویه شده است', 'E_POS_ALREADY_SETTLED');
      insItem.run(batchId, it.receipt.id, it.amount_rial);
      updRec.run(it.amount_rial, it.receipt.id);
      refreshReceiptStatus(db, it.receipt.id);
    }

    const lines = [];
    if (net > 0) lines.push({ code: bankAcct.code, name: bankAcct.name, debit: rialToLedger(net), credit: 0 });
    if (fee > 0) lines.push({ code: feeAcct.code, name: feeAcct.name, debit: rialToLedger(fee), credit: 0 });
    if (shortage > 0) lines.push({ code: shortageAcct.code, name: shortageAcct.name, debit: rialToLedger(shortage), credit: 0 });
    lines.push({ code: inTransit.code, name: inTransit.name, debit: 0, credit: rialToLedger(gross) });

    const { postToLedger } = ledgerApi();
    const journalId = postToLedger(db, {
      sourceType: 'pos_batch',
      sourceId: batchId,
      date,
      description: `تسویه کارتخوان — ناخالص ${gross.toLocaleString('fa-IR')} ریال`,
      createdBy: user.id,
      lines,
    });
    db.prepare('UPDATE pos_settlement_batches SET journal_id=? WHERE id=?').run(journalId, batchId);
    return { batchId, journalId };
  })();

  dbApi().audit(user.id, 'create', 'pos_batch', out.batchId, `تسویه کارتخوان ناخالص ${gross} ریال (تأیید حسابدار)`);
  const batch = db.prepare('SELECT * FROM pos_settlement_batches WHERE id=?').get(out.batchId);
  const batchItems = db.prepare('SELECT * FROM pos_settlement_items WHERE batch_id=?').all(out.batchId);
  return Object.assign(batch, { items: batchItems });
}

function voidBatch(db, id, user, { reason } = {}) {
  const row = db.prepare('SELECT * FROM pos_settlement_batches WHERE id=?').get(id);
  if (!row) throw httpErr(404, 'دسته تسویه یافت نشد', 'E_POS_BATCH');
  if (row.status === 'reversed') throw httpErr(409, 'این تسویه قبلاً ابطال شده است', 'E_POS_ALREADY_REVERSED');

  const out = db.transaction(() => {
    const { reverseJournalEntry } = voidJournalApi();
    const revJe = reverseJournalEntry(db, row.journal_id, {
      userId: user.id,
      reason: reason || 'ابطال تسویه کارتخوان',
      sourceType: 'pos_batch_reversal',
    });
    const items = db.prepare('SELECT * FROM pos_settlement_items WHERE batch_id=?').all(id);
    const dec = db.prepare(`
      UPDATE pos_receipts SET settled_rial = MAX(0, COALESCE(settled_rial,0) - ?)
      WHERE id=?
    `);
    for (const it of items) {
      dec.run(it.amount_rial, it.receipt_id);
      refreshReceiptStatus(db, it.receipt_id);
    }
    db.prepare(`
      UPDATE pos_settlement_batches
      SET status='reversed', reversed_at=strftime('%s','now'), reversed_by=?, reversal_journal_id=?
      WHERE id=?
    `).run(user.id, revJe, id);
    return { id, status: 'reversed', reversal_journal_id: revJe };
  })();

  dbApi().audit(user.id, 'reverse', 'pos_batch', id, `ابطال تسویه کارتخوان #${id}`);
  return Object.assign(db.prepare('SELECT * FROM pos_settlement_batches WHERE id=?').get(id), out);
}

function glBalanceRial(db, accountCode) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(
      COALESCE(NULLIF(jl.debit_rial,0), ROUND(jl.debit), 0)
      - COALESCE(NULLIF(jl.credit_rial,0), ROUND(jl.credit), 0)
    ), 0) AS b
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.entry_id
    WHERE jl.account_code = ? AND COALESCE(je.deleted_at,0)=0
  `).get(accountCode);
  return Number(row && row.b) || 0;
}

function glBalanceAsOf(db, accountCode, asOfDate) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(${SQL_JL_DEBIT_RIAL} - ${SQL_JL_CREDIT_RIAL}), 0) AS b
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.entry_id
    WHERE jl.account_code = ?
      AND COALESCE(je.deleted_at,0)=0
      AND COALESCE(je.status,'posted') <> 'reversed'
      AND (? = '' OR je.entry_date <= ?)
  `).get(accountCode, asOfDate || '', asOfDate || '');
  return Math.round(Number(row && row.b) || 0);
}

/** Mixed-terminal batches store header terminal_id=NULL. Allocate JE by item share of gross (REAL, not integer /). */
const SQL_POS_BATCH_ITEM_SHARE = `(${SQL_JL_DEBIT_RIAL} - ${SQL_JL_CREDIT_RIAL}) * 1.0 * i.amount_rial / NULLIF(b.gross_rial, 0)`;

function glPosBatchNetToBank(db, bankCoa, from, to, terminalId) {
  const where = [
    'jl.account_code = ?',
    "je.ref_type = 'pos_batch'",
    'COALESCE(je.deleted_at,0)=0',
    "COALESCE(je.status,'posted') <> 'reversed'",
    "COALESCE(b.status,'posted') <> 'reversed'",
  ];
  const params = [bankCoa];
  if (from) { where.push('je.entry_date >= ?'); params.push(from); }
  if (to) { where.push('je.entry_date <= ?'); params.push(to); }
  if (terminalId) {
    where.push('r.terminal_id = ?');
    params.push(terminalId);
    const row = db.prepare(`
      SELECT COALESCE(SUM(${SQL_POS_BATCH_ITEM_SHARE}), 0) AS b
      FROM journal_lines jl
      JOIN journal_entries je ON je.id = jl.entry_id
      JOIN pos_settlement_batches b ON b.id = je.ref_id
      JOIN pos_settlement_items i ON i.batch_id = b.id
      JOIN pos_receipts r ON r.id = i.receipt_id
      WHERE ${where.join(' AND ')}
    `).get(...params);
    return Math.round(Number(row && row.b) || 0);
  }
  const row = db.prepare(`
    SELECT COALESCE(SUM(${SQL_JL_DEBIT_RIAL} - ${SQL_JL_CREDIT_RIAL}), 0) AS b
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.entry_id
    JOIN pos_settlement_batches b ON b.id = je.ref_id
    WHERE ${where.join(' AND ')}
  `).get(...params);
  return Math.round(Number(row && row.b) || 0);
}

function glInTransitPosAsOf(db, { to, terminalId, bankId } = {}) {
  const code = acct(db, 'coa_card_in_transit').code;
  if (!terminalId && !bankId) return glBalanceAsOf(db, code, to);

  const recWhere = [
    "je.ref_type='pos_receipt'",
    'jl.account_code=?',
    'COALESCE(je.deleted_at,0)=0',
    "COALESCE(je.status,'posted') <> 'reversed'",
    "COALESCE(r.status,'open') <> 'reversed'",
  ];
  const recParams = [code];
  if (to) { recWhere.push('je.entry_date <= ?'); recParams.push(to); }
  if (terminalId) { recWhere.push('r.terminal_id = ?'); recParams.push(terminalId); }
  if (bankId) { recWhere.push('t.bank_id = ?'); recParams.push(bankId); }
  const recNet = db.prepare(`
    SELECT COALESCE(SUM(${SQL_JL_DEBIT_RIAL} - ${SQL_JL_CREDIT_RIAL}), 0) AS b
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.entry_id
    JOIN pos_receipts r ON r.id = je.ref_id
    JOIN pos_terminals t ON t.id = r.terminal_id
    WHERE ${recWhere.join(' AND ')}
  `).get(...recParams).b;

  const bWhere = [
    "je.ref_type='pos_batch'",
    'jl.account_code=?',
    'COALESCE(je.deleted_at,0)=0',
    "COALESCE(je.status,'posted') <> 'reversed'",
    "COALESCE(b.status,'posted') <> 'reversed'",
  ];
  const bParams = [code];
  if (to) { bWhere.push('je.entry_date <= ?'); bParams.push(to); }
  if (bankId) { bWhere.push('b.bank_id = ?'); bParams.push(bankId); }
  let batchSql;
  if (terminalId) {
    bWhere.push('r.terminal_id = ?');
    bParams.push(terminalId);
    batchSql = `
      SELECT COALESCE(SUM(${SQL_POS_BATCH_ITEM_SHARE}), 0) AS b
      FROM journal_lines jl
      JOIN journal_entries je ON je.id = jl.entry_id
      JOIN pos_settlement_batches b ON b.id = je.ref_id
      JOIN pos_settlement_items i ON i.batch_id = b.id
      JOIN pos_receipts r ON r.id = i.receipt_id
      WHERE ${bWhere.join(' AND ')}
    `;
  } else {
    batchSql = `
      SELECT COALESCE(SUM(${SQL_JL_DEBIT_RIAL} - ${SQL_JL_CREDIT_RIAL}), 0) AS b
      FROM journal_lines jl
      JOIN journal_entries je ON je.id = jl.entry_id
      JOIN pos_settlement_batches b ON b.id = je.ref_id
      WHERE ${bWhere.join(' AND ')}
    `;
  }
  const batchNet = db.prepare(batchSql).get(...bParams).b;

  return Math.round(Number(recNet) || 0) + Math.round(Number(batchNet) || 0);
}

function inTransitOpenAsOf(db, { to, terminalId, bankId } = {}) {
  const rWhere = ["COALESCE(r.status,'open') <> 'reversed'"];
  const rParams = [];
  if (to) { rWhere.push('r.date <= ?'); rParams.push(to); }
  if (terminalId) { rWhere.push('r.terminal_id = ?'); rParams.push(terminalId); }
  if (bankId) { rWhere.push('t.bank_id = ?'); rParams.push(bankId); }
  const gross = db.prepare(`
    SELECT COALESCE(SUM(r.amount_rial),0) s
    FROM pos_receipts r
    JOIN pos_terminals t ON t.id = r.terminal_id
    WHERE ${rWhere.join(' AND ')}
  `).get(...rParams).s;

  const sWhere = ["COALESCE(b.status,'posted') <> 'reversed'", "COALESCE(r.status,'open') <> 'reversed'"];
  const sParams = [];
  if (to) { sWhere.push('b.date <= ?'); sParams.push(to); sWhere.push('r.date <= ?'); sParams.push(to); }
  if (terminalId) { sWhere.push('r.terminal_id = ?'); sParams.push(terminalId); }
  if (bankId) { sWhere.push('t.bank_id = ?'); sParams.push(bankId); }
  const settled = db.prepare(`
    SELECT COALESCE(SUM(i.amount_rial),0) s
    FROM pos_settlement_items i
    JOIN pos_settlement_batches b ON b.id = i.batch_id
    JOIN pos_receipts r ON r.id = i.receipt_id
    JOIN pos_terminals t ON t.id = r.terminal_id
    WHERE ${sWhere.join(' AND ')}
  `).get(...sParams).s;
  return Math.max(0, Math.round(Number(gross) || 0) - Math.round(Number(settled) || 0));
}

function buildPosReport(db, query = {}) {
  ensurePosCoaAccounts(db);
  const from = String(query.from || '').trim();
  const to = String(query.to || '').trim();
  const terminalId = query.terminal_id ? Number(query.terminal_id) : 0;
  const bankId = query.bank_id ? Number(query.bank_id) : 0;
  const status = String(query.status || '').trim();
  const varianceOnly = query.variance === '1' || query.variance === 1 || query.variance === true;

  const rWhere = [];
  const rParams = [];
  if (from) { rWhere.push('r.date >= ?'); rParams.push(from); }
  if (to) { rWhere.push('r.date <= ?'); rParams.push(to); }
  if (terminalId) { rWhere.push('r.terminal_id = ?'); rParams.push(terminalId); }
  if (bankId) { rWhere.push('t.bank_id = ?'); rParams.push(bankId); }
  if (status) { rWhere.push('r.status = ?'); rParams.push(status); }
  const rSql = rWhere.length ? 'WHERE ' + rWhere.join(' AND ') : '';
  const receipts = db.prepare(`
    SELECT r.*, t.name AS terminal_name, t.terminal_id AS terminal_code,
           t.bank_id, b.name AS bank_name, b.coa_code AS bank_coa_code,
           (r.amount_rial - COALESCE(r.settled_rial,0)) AS open_rial
    FROM pos_receipts r
    LEFT JOIN pos_terminals t ON t.id = r.terminal_id
    LEFT JOIN banks b ON b.id = t.bank_id
    ${rSql}
    ORDER BY r.date DESC, r.id DESC
    LIMIT 800
  `).all(...rParams);

  const bWhere = [];
  const bParams = [];
  if (from) { bWhere.push('b.date >= ?'); bParams.push(from); }
  if (to) { bWhere.push('b.date <= ?'); bParams.push(to); }
  if (terminalId) {
    bWhere.push(`EXISTS (
      SELECT 1 FROM pos_settlement_items i
      JOIN pos_receipts r ON r.id = i.receipt_id
      WHERE i.batch_id = b.id AND r.terminal_id = ?
    )`);
    bParams.push(terminalId);
  }
  if (bankId) { bWhere.push('b.bank_id = ?'); bParams.push(bankId); }
  if (status) { bWhere.push('b.status = ?'); bParams.push(status); }
  if (varianceOnly) { bWhere.push('COALESCE(b.shortage_rial,0) > 0'); }
  const bSql = bWhere.length ? 'WHERE ' + bWhere.join(' AND ') : '';
  const batches = db.prepare(`
    SELECT b.*, bk.name AS bank_name, bk.coa_code AS bank_coa_code,
           t.name AS terminal_name, t.terminal_id AS terminal_code,
           CASE WHEN COALESCE(b.shortage_rial,0) > 0 THEN 1 ELSE 0 END AS has_variance
    FROM pos_settlement_batches b
    LEFT JOIN banks bk ON bk.id = b.bank_id
    LEFT JOIN pos_terminals t ON t.id = b.terminal_id
    ${bSql}
    ORDER BY b.date DESC, b.id DESC
    LIMIT 500
  `).all(...bParams);

  if (terminalId) {
    const shareStmt = db.prepare(`
      SELECT COALESCE(SUM(i.amount_rial),0) AS s
      FROM pos_settlement_items i
      JOIN pos_receipts r ON r.id = i.receipt_id
      WHERE i.batch_id=? AND r.terminal_id=?
    `);
    for (const b of batches) {
      const shareGross = Number(shareStmt.get(b.id, terminalId).s) || 0;
      const g = Number(b.gross_rial) || 0;
      if (!g) continue;
      const ratio = shareGross / g;
      b.gross_rial = shareGross;
      b.fee_rial = Math.round(Number(b.fee_rial || 0) * ratio);
      b.shortage_rial = Math.round(Number(b.shortage_rial || 0) * ratio);
      b.net_rial = Math.round(Number(b.net_rial || 0) * ratio);
    }
  }

  const liveReceipts = receipts.filter((r) => r.status !== 'reversed');
  const liveBatches = batches.filter((b) => b.status !== 'reversed');
  const totals = {
    receipt_count: liveReceipts.length,
    receipt_gross_rial: liveReceipts.reduce((s, r) => s + Number(r.amount_rial || 0), 0),
    receipt_open_rial: liveReceipts.reduce((s, r) => s + Math.max(0, Number(r.open_rial || 0)), 0),
    receipt_settled_rial: liveReceipts.reduce((s, r) => s + Number(r.settled_rial || 0), 0),
    batch_count: liveBatches.length,
    batch_gross_rial: liveBatches.reduce((s, b) => s + Number(b.gross_rial || 0), 0),
    batch_fee_rial: liveBatches.reduce((s, b) => s + Number(b.fee_rial || 0), 0),
    batch_shortage_rial: liveBatches.reduce((s, b) => s + Number(b.shortage_rial || 0), 0),
    batch_net_rial: liveBatches.reduce((s, b) => s + Number(b.net_rial || 0), 0),
  };

  const transit = acct(db, 'coa_card_in_transit');
  const openAsOf = inTransitOpenAsOf(db, { to, terminalId: terminalId || null, bankId: bankId || null });
  const inTransitGl = glInTransitPosAsOf(db, { to, terminalId: terminalId || null, bankId: bankId || null });
  const banks = [];
  const seenBank = new Set();
  for (const row of liveBatches) {
    const id = Number(row.bank_id);
    if (!id || seenBank.has(id)) continue;
    seenBank.add(id);
    const net = liveBatches.filter((b) => Number(b.bank_id) === id)
      .reduce((s, b) => s + Number(b.net_rial || 0), 0);
    const glNet = row.bank_coa_code
      ? glPosBatchNetToBank(db, row.bank_coa_code, from, to, terminalId || null)
      : 0;
    banks.push({
      bank_id: id,
      bank_name: row.bank_name,
      coa_code: row.bank_coa_code,
      batch_net_rial: net,
      pos_gl_net_rial: glNet,
      delta_rial: glNet - net,
    });
  }

  return {
    filters: {
      from: from || null,
      to: to || null,
      terminal_id: terminalId || null,
      bank_id: bankId || null,
      status: status || null,
      variance: varianceOnly,
    },
    receipts,
    batches,
    totals,
    reconcile: {
      in_transit_account: transit.code,
      in_transit_open_rial: openAsOf,
      in_transit_gl_rial: inTransitGl,
      in_transit_delta_rial: inTransitGl - openAsOf,
      banks,
      ok: (inTransitGl - openAsOf) === 0 && banks.every((b) => b.delta_rial === 0),
    },
  };
}

function csvEsc(v) {
  let s = String(v == null ? '' : v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
}

function posReportCsv(report) {
  const header = ['section', 'id', 'date', 'terminal', 'bank', 'status', 'gross_rial', 'fee_rial', 'shortage_rial', 'net_or_open_rial'];
  const lines = [header.map(csvEsc).join(',')];
  for (const r of report.receipts || []) {
    lines.push([
      'receipt', r.id, r.date, r.terminal_code || '', r.bank_name || '', r.status,
      r.amount_rial || 0, '', '', r.open_rial || 0,
    ].map(csvEsc).join(','));
  }
  for (const b of report.batches || []) {
    lines.push([
      'batch', b.id, b.date, b.terminal_code || '', b.bank_name || '', b.status,
      b.gross_rial || 0, b.fee_rial || 0, b.shortage_rial || 0, b.net_rial || 0,
    ].map(csvEsc).join(','));
  }
  const t = report.totals || {};
  const rec = report.reconcile || {};
  lines.push(['totals', '', 'receipt_gross', t.receipt_gross_rial || 0, 'batch_gross', t.batch_gross_rial || 0, t.batch_fee_rial || 0, t.batch_shortage_rial || 0, '', t.batch_net_rial || 0].map(csvEsc).join(','));
  lines.push(['reconcile', '', 'in_transit_open', rec.in_transit_open_rial || 0, 'in_transit_gl', rec.in_transit_gl_rial || 0, rec.in_transit_delta_rial || 0, rec.ok ? 1 : 0, '', ''].map(csvEsc).join(','));
  return lines.join('\n');
}

module.exports = {
  initPosSchema,
  ensurePosCoaAccounts,
  listTerminals,
  createTerminal,
  updateTerminal,
  deactivateTerminal,
  listReceipts,
  postReceipt,
  voidReceipt,
  listBatches,
  settleBatch,
  voidBatch,
  glBalanceRial,
  glBalanceAsOf,
  receiptRemaining,
  buildPosReport,
  posReportCsv,
};
