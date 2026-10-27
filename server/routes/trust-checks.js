'use strict';
/**
 * Trust/guarantee checks (چک امانی) — custody + memorandum JE (انتظامی).
 * Soft-delete / reverse memo JE — never physical DELETE.
 * Status: held → returned | collected (ضبط) with JE reverse.
 */

const router = require('express').Router();
const { getDB, audit } = require('../db');
const { auth, adminOrAccounting, requireChequeOperate } = require('../middleware/auth');
const { reverseJournalEntry } = require('../lib/void-journal');
const { postGuaranteeMemoJe } = require('../lib/cheque-lifecycle-actions');
const { todayJalali } = require('../jalali');

const STATUSES = ['held', 'returned', 'collected', 'realized', 'bounced'];
const ACTIVE_FILTER = "COALESCE(deleted_at,0)=0";

function normalizeStatus(status) {
  if (status === 'realized') return 'collected';
  return status;
}

function resolveTrustParty(db, body) {
  const partyId = parseInt(body && body.party_id, 10);
  if (!Number.isFinite(partyId) || partyId <= 0) {
    const err = new Error('طرف حساب باید از فهرست اشخاص انتخاب شود');
    err.status = 400;
    err.code = 'E_TRUST_PARTY_REQUIRED';
    throw err;
  }
  const party = db.prepare(`
    SELECT id, full_name, company_name, biz, phone
    FROM parties WHERE id=? AND COALESCE(is_active,1)=1
  `).get(partyId);
  if (!party) {
    const err = new Error('طرف حساب یافت نشد');
    err.status = 400;
    err.code = 'E_TRUST_PARTY_INVALID';
    throw err;
  }
  return {
    partyId: party.id,
    partyName: party.full_name || party.company_name || party.biz || '',
    partyPhone: (body && body.party_phone) || party.phone || '',
  };
}

function assertHeld(row) {
  if (!row || Number(row.deleted_at || 0)) {
    const err = new Error('چک امانی یافت نشد');
    err.status = 404;
    throw err;
  }
  const st = normalizeStatus(row.status);
  if (st !== 'held') {
    const err = new Error('فقط چک امانی با وضعیت «نزد ما» قابل این عملیات است');
    err.status = 400;
    err.code = 'E_TRUST_STATUS';
    throw err;
  }
}

function reverseMemoIfAny(db, row, { userId, date, reason }) {
  if (!row.memo_je_id) return null;
  reverseJournalEntry(db, row.memo_je_id, {
    userId,
    date: date || todayJalali(),
    reason: reason || `معکوس سند انتظامی چک امانی #${row.id}`,
    sourceType: 'trust_check_memo_reversal',
  });
  return row.memo_je_id;
}

router.get('/', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const { direction, status, include_deleted } = req.query;
  const where = [];
  const params = [];
  if (!include_deleted || include_deleted === '0') {
    where.push(ACTIVE_FILTER);
  }
  if (direction) { where.push('direction=?'); params.push(direction); }
  if (status) {
    const st = normalizeStatus(status);
    if (st === 'collected') {
      where.push("status IN ('collected','realized')");
    } else {
      where.push('status=?');
      params.push(st);
    }
  }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const rows = db.prepare(
    `SELECT * FROM trust_checks ${whereSql} ORDER BY due_date ASC, created_at DESC`
  ).all(...params);
  res.json(rows);
});

router.post('/', auth, adminOrAccounting, requireChequeOperate, (req, res) => {
  try {
    const {
      direction, bank_name, sayadi, cheque_number, account_number, amount,
      owner_name, due_date, note, contract_id, contract_ref, guarantee_expiry,
      cheque_record_id,
    } = req.body || {};
    if (!direction || !['in', 'out'].includes(direction)) {
      return res.status(400).json({ error: 'جهت چک (دریافتی/پرداختی) الزامی است' });
    }
    const amt = parseFloat(amount) || 0;
    if (!amt) return res.status(400).json({ error: 'مبلغ چک الزامی است' });
    const db = getDB();
    const party = resolveTrustParty(db, req.body);
    const entryDate = String(due_date || '').trim() || todayJalali();
    const expiry = String(guarantee_expiry || due_date || '').trim();
    const contractId = parseInt(contract_id, 10);
    const chequeRecId = parseInt(cheque_record_id, 10);

    const row = db.transaction(() => {
      const result = db.prepare(`
        INSERT INTO trust_checks (
          direction, party_name, party_id, party_phone, bank_name, sayadi, cheque_number,
          account_number, amount, owner_name, due_date, note, created_by,
          contract_id, contract_ref, guarantee_expiry, cheque_record_id, status
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'held')
      `).run(
        direction,
        party.partyName,
        party.partyId,
        party.partyPhone,
        bank_name || '',
        sayadi || '',
        cheque_number || '',
        account_number || '',
        amt,
        owner_name || '',
        due_date || '',
        note || '',
        req.user.id,
        Number.isFinite(contractId) && contractId > 0 ? contractId : null,
        contract_ref || '',
        expiry,
        Number.isFinite(chequeRecId) && chequeRecId > 0 ? chequeRecId : null
      );
      const id = result.lastInsertRowid;
      // Memorandum JE on create (انتظامی) — throws E_COA_MEMO_MISSING if keys absent
      const memoJeId = postGuaranteeMemoJe(db, {
        direction,
        amountRial: Math.round(amt),
        sourceType: 'trust_check_memo',
        sourceId: id,
        date: entryDate,
        description: `سند انتظامی چک امانی #${id} — ${party.partyName}`,
        userId: req.user.id,
      });
      db.prepare('UPDATE trust_checks SET memo_je_id=? WHERE id=?').run(memoJeId, id);
      return db.prepare('SELECT * FROM trust_checks WHERE id=?').get(id);
    })();

    audit(
      req.user.id, 'create', 'trust_check', row.id,
      `ثبت چک امانی ${direction === 'in' ? 'دریافتی' : 'پرداختی'} از/به ${party.partyName} به مبلغ ${amt}`
    );
    res.json(row);
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
});

router.patch('/:id/status', auth, adminOrAccounting, requireChequeOperate, (req, res) => {
  try {
    const rawStatus = String((req.body && req.body.status) || '').trim();
    if (!STATUSES.includes(rawStatus)) {
      return res.status(400).json({ error: 'وضعیت نامعتبر' });
    }
    const status = normalizeStatus(rawStatus);
    const db = getDB();
    const entryDate = String((req.body && req.body.date) || '').trim() || todayJalali();

    const out = db.transaction(() => {
      const row = db.prepare(`SELECT * FROM trust_checks WHERE id=? AND ${ACTIVE_FILTER}`).get(req.params.id);
      if (!row) {
        const err = new Error('یافت نشد');
        err.status = 404;
        throw err;
      }
      const from = normalizeStatus(row.status);

      if (status === from) return { ok: true, status, noop: true };

      // held → returned | collected — reverse memo JE
      if (from === 'held' && (status === 'returned' || status === 'collected')) {
        assertHeld(row);
        reverseMemoIfAny(db, row, {
          userId: req.user.id,
          date: entryDate,
          reason: status === 'returned'
            ? `استرداد چک امانی #${row.id}`
            : `ضبط/وصول چک امانی #${row.id}`,
        });
        const extra = status === 'returned'
          ? ', returned_at=strftime(\'%s\',\'now\'), memo_je_id=NULL'
          : ', collected_at=strftime(\'%s\',\'now\'), memo_je_id=NULL';
        db.prepare(`UPDATE trust_checks SET status=? ${extra} WHERE id=?`).run(status, row.id);
        return { ok: true, status, memo_reversed: !!row.memo_je_id };
      }

      // held → bounced (status only; still reverse memo — no longer collateral)
      if (from === 'held' && status === 'bounced') {
        assertHeld(row);
        reverseMemoIfAny(db, row, {
          userId: req.user.id,
          date: entryDate,
          reason: `برگشت چک امانی #${row.id}`,
        });
        db.prepare(`
          UPDATE trust_checks SET status='bounced', memo_je_id=NULL WHERE id=?
        `).run(row.id);
        return { ok: true, status: 'bounced', memo_reversed: !!row.memo_je_id };
      }

      const err = new Error(`گذار از «${from}» به «${status}» مجاز نیست`);
      err.status = 400;
      err.code = 'E_TRUST_STATUS';
      throw err;
    })();

    audit(req.user.id, 'update', 'trust_check', req.params.id, `تغییر وضعیت چک امانی به ${status}`);
    res.json(out);
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
});

/** Soft-delete — reverse memo JE if any; never physical DELETE. */
router.delete('/:id', auth, adminOrAccounting, requireChequeOperate, (req, res) => {
  try {
    const db = getDB();
    const entryDate = String((req.body && req.body.date) || '').trim() || todayJalali();
    db.transaction(() => {
      const row = db.prepare(`SELECT * FROM trust_checks WHERE id=? AND ${ACTIVE_FILTER}`).get(req.params.id);
      if (!row) {
        const err = new Error('یافت نشد');
        err.status = 404;
        throw err;
      }
      if (normalizeStatus(row.status) === 'held' && row.memo_je_id) {
        reverseMemoIfAny(db, row, {
          userId: req.user.id,
          date: entryDate,
          reason: `ابطال/حذف نرم چک امانی #${row.id}`,
        });
      }
      db.prepare(`
        UPDATE trust_checks
        SET deleted_at=strftime('%s','now'), deleted_by=?, memo_je_id=NULL,
            status=CASE WHEN status='held' THEN 'returned' ELSE status END
        WHERE id=?
      `).run(req.user.id, req.params.id);
    })();
    audit(req.user.id, 'delete', 'trust_check', req.params.id, `حذف نرم چک امانی #${req.params.id}`);
    res.json({ ok: true, soft_deleted: true });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
});

module.exports = router;
