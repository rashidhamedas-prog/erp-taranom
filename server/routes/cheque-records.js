const router = require('express').Router();
const { getDB, audit } = require('../db');
const { auth, adminOrAccounting } = require('../middleware/auth');
const { postToLedger } = require('../lib/ledger');
const { acct } = require('../lib/coa-map');
const { todayJalali } = require('../jalali');

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
      direction, cheque_number || '', issue_date || '', receive_date || '', due_date || '',
      bank_name || '', branch || '', sayadi || '', sheba || '', account_number || '',
      party_name || '', status || (opening ? 'مانده اول دوره' : ''), status_note || '',
      Math.round(Number(amount)), finalNote, req.user.name || ''
    );
    if (opening) {
      const chequeAccount = acct(db, direction === 'in' ? 'coa_cheques_receivable' : 'coa_cheques_payable');
      const openingAccount = acct(db, 'coa_opening_balance');
      const valueToman = Math.round(Number(amount)) / 10;
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
        createdBy: req.user.id, lines,
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
  const db = getDB();
  const row = db.prepare('SELECT * FROM cheque_records WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  if (row.record_status === 'reversed') return res.status(400).json({ error: 'این چک قبلاً ابطال شده است' });
  db.transaction(() => {
    let reversalId = null;
    if (row.journal_entry_id) {
      const chequeAccount = acct(db, row.direction === 'in' ? 'coa_cheques_receivable' : 'coa_cheques_payable');
      const openingAccount = acct(db, 'coa_opening_balance');
      const valueToman = Math.round(Number(row.amount)) / 10;
      const lines = row.direction === 'in'
        ? [
          { code: openingAccount.code, name: openingAccount.name, debit: valueToman, credit: 0 },
          { code: chequeAccount.code, name: chequeAccount.name, debit: 0, credit: valueToman },
        ]
        : [
          { code: chequeAccount.code, name: chequeAccount.name, debit: valueToman, credit: 0 },
          { code: openingAccount.code, name: openingAccount.name, debit: 0, credit: valueToman },
        ];
      reversalId = postToLedger(db, {
        sourceType: 'opening_cheque_reversal', sourceId: row.id, date: todayJalali(),
        description: `ابطال چک اول دوره ${row.cheque_number || row.id}`, createdBy: req.user.id, lines,
      });
    }
    db.prepare("UPDATE cheque_records SET record_status='reversed',reversal_journal_id=?,reversed_at=strftime('%s','now'),reversed_by=? WHERE id=?")
      .run(reversalId, req.user.id, row.id);
  })();
  audit(req.user.id, 'reverse', 'cheque_record', req.params.id, `ابطال چک ${row.cheque_number}`);
  res.json({ ok: true });
});

module.exports = router;
