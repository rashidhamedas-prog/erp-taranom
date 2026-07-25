const router = require('express').Router();
const { getDB, audit } = require('../db');
const { auth, adminOrAccounting } = require('../middleware/auth');
const { postToLedger } = require('../lib/ledger');
const { acct } = require('../lib/coa-map');
const { todayJalali } = require('../jalali');
const { voidChequeRecord } = require('../lib/void-cheque');

const OPENING_NOTE = 'مانده اول دوره';

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

router.post('/', auth, adminOrAccounting, (req, res) => {
  const {
    direction, cheque_number, issue_date, receive_date, due_date,
    bank_name, branch, sayadi, sheba, account_number,
    party_name, status, status_note, amount, note, opening
  } = req.body;
  if (!direction || !amount) return res.status(400).json({ error: 'جهت و مبلغ الزامی است' });
  const amountNum = Math.round(Number(String(amount).replace(/[,\s]/g, '')));
  if (!Number.isFinite(amountNum) || amountNum <= 0) {
    return res.status(400).json({ error: 'مبلغ چک باید عدد مثبت معتبر باشد (ریال)' });
  }
  const db = getDB();
  const finalNote = opening ? (note ? note + ' — ' + OPENING_NOTE : OPENING_NOTE) : (note || '');
  const recordId = db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO cheque_records (
        direction, cheque_number, issue_date, receive_date, due_date,
        bank_name, branch, sayadi, sheba, account_number,
        party_name, status, status_note, amount, note, created_by_name
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      direction, String(cheque_number || ''), issue_date || '', receive_date || '', due_date || '',
      bank_name || '', branch || '', sayadi || '', sheba || '', account_number || '',
      party_name || '', status || (opening ? 'مانده اول دوره' : ''), status_note || '',
      amountNum, finalNote, req.user.name || ''
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
  db.prepare('UPDATE cheque_records SET status=?, status_note=? WHERE id=?')
    .run(status || row.status, status_note ?? row.status_note, req.params.id);
  audit(req.user.id, 'update', 'cheque_record', req.params.id, `تغییر وضعیت چک ${row.cheque_number}`);
  res.json({ ok: true });
});

router.delete('/:id', auth, adminOrAccounting, (req, res) => {
  try {
    const db = getDB();
    res.json(voidChequeRecord(db, req.params.id, req.user));
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

router.post('/:id/send-to-bank', auth, adminOrAccounting, (req, res) => {
  try {
    const db = getDB();
    const row = db.prepare("SELECT * FROM cheque_records WHERE id=? AND direction='in'").get(req.params.id);
    if (!row) return res.status(404).json({ error: 'چک دریافتنی یافت نشد' });
    if (row.lifecycle_status && row.lifecycle_status !== 'registered') {
      throw new Error('وضعیت چرخه این چک اجازه ارسال به بانک را نمی‌دهد');
    }
    const amountRial = Math.round(Number(row.amount) || 0);
    if (amountRial <= 0) throw new Error('مبلغ چک نامعتبر است');

    const collection = acct(db, 'coa_cheques_in_collection');
    const receivable = acct(db, 'coa_cheques_receivable');
    const amt = amountRial / 10;
    const bankId = req.body.collection_bank_id || null;

    const jeId = db.transaction(() => {
      const id = postToLedger(db, {
        sourceType: 'cheque_send_to_bank', sourceId: row.id,
        date: req.body.date || todayJalali(),
        description: `واگذاری چک ${row.cheque_number || row.id} به بانک`,
        createdBy: req.user.id,
        lines: [
          { code: collection.code, name: collection.name, debit: amt, credit: 0, debit_rial: amountRial },
          { code: receivable.code, name: receivable.name, debit: 0, credit: amt, credit_rial: amountRial },
        ],
      });
      db.prepare(`
        UPDATE cheque_records SET lifecycle_status='in_collection', collection_bank_id=?, collection_je_id=?
        WHERE id=?
      `).run(bankId, id, row.id);
      return id;
    })();

    audit(req.user.id, 'cheque_send_bank', 'cheque_record', row.id, row.cheque_number);
    res.json({ ok: true, journal_entry_id: jeId, lifecycle_status: 'in_collection' });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/:id/clear', auth, adminOrAccounting, (req, res) => {
  try {
    const db = getDB();
    const row = db.prepare("SELECT * FROM cheque_records WHERE id=? AND direction='in'").get(req.params.id);
    if (!row) return res.status(404).json({ error: 'چک دریافتنی یافت نشد' });
    if (row.lifecycle_status !== 'in_collection') throw new Error('چک باید در وضعیت «در جریان وصول» باشد');

    const amountRial = Math.round(Number(row.amount) || 0);
    const bank = acct(db, 'coa_bank_default');
    const collection = acct(db, 'coa_cheques_in_collection');
    const amt = amountRial / 10;
    const bankId = req.body.bank_id || row.collection_bank_id;

    const jeId = db.transaction(() => {
      const cashLine = bankId
        ? (() => {
          const b = db.prepare('SELECT coa_code, name FROM banks WHERE id=?').get(bankId);
          return { code: b?.coa_code || ('1102-' + bankId), name: b?.name || bank.name };
        })()
        : bank;

      const id = postToLedger(db, {
        sourceType: 'cheque_clear', sourceId: row.id,
        date: req.body.date || todayJalali(),
        description: `وصول چک ${row.cheque_number || row.id}`,
        createdBy: req.user.id,
        lines: [
          { code: cashLine.code, name: cashLine.name, debit: amt, credit: 0, debit_rial: amountRial },
          { code: collection.code, name: collection.name, debit: 0, credit: amt, credit_rial: amountRial },
        ],
      });
      db.prepare(`
        UPDATE cheque_records SET lifecycle_status='cleared', cleared_je_id=?, status='وصول‌شده'
        WHERE id=?
      `).run(id, row.id);
      return id;
    })();

    audit(req.user.id, 'cheque_clear', 'cheque_record', row.id, row.cheque_number);
    res.json({ ok: true, journal_entry_id: jeId, lifecycle_status: 'cleared' });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/:id/bounce', auth, adminOrAccounting, (req, res) => {
  try {
    const db = getDB();
    const row = db.prepare("SELECT * FROM cheque_records WHERE id=? AND direction='in'").get(req.params.id);
    if (!row) return res.status(404).json({ error: 'چک دریافتنی یافت نشد' });
    if (!['in_collection', 'cleared'].includes(row.lifecycle_status)) {
      throw new Error('فقط چک‌های واگذارشده یا وصول‌شده قابل برگشت هستند');
    }

    const amountRial = Math.round(Number(row.amount) || 0);
    const collection = acct(db, 'coa_cheques_in_collection');
    const receivable = acct(db, 'coa_cheques_receivable');
    const amt = amountRial / 10;

    const jeId = db.transaction(() => {
      const lines = row.lifecycle_status === 'in_collection'
        ? [
          { code: receivable.code, name: receivable.name, debit: amt, credit: 0, debit_rial: amountRial },
          { code: collection.code, name: collection.name, debit: 0, credit: amt, credit_rial: amountRial },
        ]
        : [
          { code: receivable.code, name: receivable.name, debit: amt, credit: 0, debit_rial: amountRial },
          { code: acct(db, 'coa_bank_default').code, name: acct(db, 'coa_bank_default').name, debit: 0, credit: amt, credit_rial: amountRial },
        ];
      const id = postToLedger(db, {
        sourceType: 'cheque_bounce', sourceId: row.id,
        date: req.body.date || todayJalali(),
        description: `برگشت چک ${row.cheque_number || row.id}`,
        createdBy: req.user.id, lines,
      });
      db.prepare(`
        UPDATE cheque_records SET lifecycle_status='bounced', bounced_je_id=?, status='برگشتی'
        WHERE id=?
      `).run(id, row.id);
      return id;
    })();

    audit(req.user.id, 'cheque_bounce', 'cheque_record', row.id, row.cheque_number);
    res.json({ ok: true, journal_entry_id: jeId, lifecycle_status: 'bounced' });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
