'use strict';
/**
 * Phase 4C — suggest matching cleared / cleared_out cheques to bank statement lines.
 * Suggestions only — never auto-apply. Manual confirm via confirmChequeMatch.
 */

const { addDaysToJalali } = require('../jalali');

function tableExists(db, name) {
  try {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  } catch (_) {
    return false;
  }
}

function tableHasColumn(db, table, col) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
  } catch (_) {
    return false;
  }
}

function dateWithinOneDay(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (addDaysToJalali(a, 1) === b) return true;
  if (addDaysToJalali(a, -1) === b) return true;
  return false;
}

function amountExpr(db) {
  if (tableHasColumn(db, 'cheque_records', 'amount_rial')) {
    return 'COALESCE(NULLIF(amount_rial,0), amount, 0)';
  }
  return 'COALESCE(amount, 0)';
}

function clearDateFor(db, chequeId, fallbackDue) {
  if (tableExists(db, 'cheque_events')) {
    const ev = db.prepare(`
      SELECT event_date FROM cheque_events
      WHERE cheque_id=? AND to_status IN ('cleared','cleared_out')
      ORDER BY id DESC LIMIT 1
    `).get(chequeId);
    if (ev && ev.event_date) return String(ev.event_date).trim();
  }
  return String(fallbackDue || '').trim() || null;
}

/**
 * List suggestion pairs for an open reconciliation.
 * @returns {{ suggestions: object[], unmatched_cheques: number, unmatched_lines: number }}
 */
function suggestChequeMatches(db, recon) {
  if (!recon || !recon.id) {
    return { suggestions: [], unmatched_cheques: 0, unmatched_lines: 0 };
  }
  if (!tableExists(db, 'cheque_records') || !tableExists(db, 'bank_statement_lines')) {
    return { suggestions: [], unmatched_cheques: 0, unmatched_lines: 0, warning: 'جداول لازم موجود نیست' };
  }

  const bankId = Number(recon.bank_id);
  const amt = amountExpr(db);
  const lcCol = tableHasColumn(db, 'cheque_records', 'lifecycle_status')
    ? 'lifecycle_status'
    : 'status';
  const alive = ["COALESCE(record_status,'posted')<>'reversed'"];
  if (tableHasColumn(db, 'cheque_records', 'reversed_at')) {
    alive.push('COALESCE(reversed_at,0)=0');
  }

  // Cheques already linked in this recon
  const linkedChequeIds = new Set(
    db.prepare(`
      SELECT ref_id AS id FROM bank_reconciliation_items
      WHERE reconciliation_id=? AND ref_type='cheque_record' AND ref_id IS NOT NULL
        AND COALESCE(voided,0)=0
    `).all(recon.id).map((r) => Number(r.id)).filter(Boolean)
  );

  const cheques = db.prepare(`
    SELECT id, direction, cheque_number, party_name, due_date, bank_name,
           collection_bank_id, ${amt} AS amount_rial, ${lcCol} AS lc
    FROM cheque_records
    WHERE ${alive.join(' AND ')}
      AND COALESCE(${lcCol},'') IN ('cleared','cleared_out')
      AND (collection_bank_id=? OR collection_bank_id IS NULL)
    ORDER BY id DESC
    LIMIT 2000
  `).all(bankId).filter((c) => {
    if (linkedChequeIds.has(Number(c.id))) return false;
    // Prefer same bank; allow NULL collection_bank_id as soft candidate
    if (c.collection_bank_id != null && Number(c.collection_bank_id) !== bankId) return false;
    return true;
  });

  const lines = db.prepare(`
    SELECT * FROM bank_statement_lines
    WHERE reconciliation_id=? AND COALESCE(matched,0)=0
      AND COALESCE(deleted_at,0)=0 AND COALESCE(status,'active')='active'
    ORDER BY id
  `).all(recon.id);

  const usedLineIds = new Set();
  const suggestions = [];

  for (const ch of cheques) {
    const amtR = Math.round(Number(ch.amount_rial) || 0);
    if (!amtR) continue;
    const lc = String(ch.lc || '');
    const clearDate = clearDateFor(db, ch.id, ch.due_date);
    // Expected statement sign: deposit (+) for cleared in; withdrawal (−) for cleared_out
    const expectSign = lc === 'cleared_out' ? -1 : 1;
    const candidates = [];

    for (const line of lines) {
      if (usedLineIds.has(line.id)) continue;
      const lineAmt = Math.round(Number(line.amount_rial) || 0);
      if (Math.abs(lineAmt) !== amtR) continue;
      const dateOk = !clearDate || !line.line_date || dateWithinOneDay(clearDate, line.line_date);
      if (!dateOk) continue;

      let confidence = 70;
      if (lineAmt === expectSign * amtR) confidence += 20;
      else if (Math.sign(lineAmt) === expectSign) confidence += 10;
      if (clearDate && line.line_date && clearDate === line.line_date) confidence += 5;
      // Soft boost if cheque text appears in description/ref
      const hay = `${line.description || ''} ${line.ref || ''}`.toLowerCase();
      const num = String(ch.cheque_number || '').trim().toLowerCase();
      if (num && hay.includes(num)) confidence += 5;
      if (ch.collection_bank_id != null && Number(ch.collection_bank_id) === bankId) {
        confidence += 5;
      }
      confidence = Math.min(100, confidence);
      candidates.push({ line, confidence });
    }

    if (!candidates.length) continue;
    candidates.sort((a, b) => b.confidence - a.confidence);
    // Unique best only when clearly ahead or sole candidate
    const best = candidates[0];
    const ambiguous = candidates.length > 1 && candidates[1].confidence >= best.confidence - 5;
    if (ambiguous) {
      suggestions.push({
        cheque_id: ch.id,
        cheque_number: ch.cheque_number || '',
        party_name: ch.party_name || '',
        direction: ch.direction,
        lifecycle_status: lc,
        amount_rial: amtR,
        clear_date: clearDate,
        statement_line_id: null,
        line_date: null,
        line_amount_rial: null,
        line_description: null,
        confidence: best.confidence,
        status: 'ambiguous',
        candidate_count: candidates.length,
        note: `${candidates.length} ردیف هم‌مبلغ — تأیید دستی لازم است`,
        candidates: candidates.slice(0, 5).map((c) => ({
          statement_line_id: c.line.id,
          line_date: c.line.line_date,
          amount_rial: Math.round(Number(c.line.amount_rial) || 0),
          description: c.line.description || '',
          ref: c.line.ref || '',
          confidence: c.confidence,
        })),
      });
      continue;
    }

    usedLineIds.add(best.line.id);
    suggestions.push({
      cheque_id: ch.id,
      cheque_number: ch.cheque_number || '',
      party_name: ch.party_name || '',
      direction: ch.direction,
      lifecycle_status: lc,
      amount_rial: amtR,
      clear_date: clearDate,
      statement_line_id: best.line.id,
      line_date: best.line.line_date,
      line_amount_rial: Math.round(Number(best.line.amount_rial) || 0),
      line_description: best.line.description || '',
      line_ref: best.line.ref || '',
      bank_item_id: best.line.bank_item_id || null,
      confidence: best.confidence,
      status: 'suggested',
      candidate_count: 1,
      note: lc === 'cleared_out' ? 'پاس پرداختی ↔ برداشت صورت‌حساب' : 'وصول دریافتی ↔ واریز صورت‌حساب',
    });
  }

  suggestions.sort((a, b) => (b.confidence || 0) - (a.confidence || 0));

  return {
    suggestions,
    unmatched_cheques: cheques.length,
    unmatched_lines: lines.filter((l) => !usedLineIds.has(l.id)).length,
  };
}

/**
 * Manually confirm one suggestion: create book item + mark matched.
 * Does not post JE (clear already posted on cheque lifecycle).
 */
function confirmChequeMatch(db, recon, { chequeId, statementLineId, userId }) {
  if (!recon || recon.status !== 'open') {
    const err = new Error('تطبیق باز نیست');
    err.status = 400;
    throw err;
  }
  const cid = Number(chequeId);
  const lid = Number(statementLineId);
  if (!cid || !lid) {
    const err = new Error('شناسه چک و ردیف صورت‌حساب الزامی است');
    err.status = 400;
    throw err;
  }

  const cheque = db.prepare(`
    SELECT * FROM cheque_records WHERE id=? AND COALESCE(record_status,'posted')<>'reversed'
  `).get(cid);
  if (!cheque) {
    const err = new Error('چک یافت نشد');
    err.status = 404;
    throw err;
  }
  const lc = String(cheque.lifecycle_status || cheque.status || '');
  if (!['cleared', 'cleared_out'].includes(lc)) {
    const err = new Error('فقط چک وصول‌شده یا پاس‌شده قابل تطبیق است');
    err.status = 400;
    throw err;
  }

  const line = db.prepare(`
    SELECT * FROM bank_statement_lines
    WHERE id=? AND reconciliation_id=? AND COALESCE(matched,0)=0
      AND COALESCE(deleted_at,0)=0 AND COALESCE(status,'active')='active'
  `).get(lid, recon.id);
  if (!line) {
    const err = new Error('ردیف صورت‌حساب یافت نشد یا قبلاً تطبیق شده');
    err.status = 404;
    throw err;
  }

  const amtCol = tableHasColumn(db, 'cheque_records', 'amount_rial')
    ? (Number(cheque.amount_rial) || Number(cheque.amount) || 0)
    : (Number(cheque.amount) || 0);
  const amtR = Math.round(amtCol);
  const lineAmt = Math.round(Number(line.amount_rial) || 0);
  if (Math.abs(lineAmt) !== Math.abs(amtR)) {
    const err = new Error('مبلغ چک با ردیف صورت‌حساب برابر نیست');
    err.status = 400;
    throw err;
  }

  const already = db.prepare(`
    SELECT id FROM bank_reconciliation_items
    WHERE reconciliation_id=? AND ref_type='cheque_record' AND ref_id=?
      AND COALESCE(voided,0)=0
    LIMIT 1
  `).get(recon.id, cid);
  if (already) {
    const err = new Error('این چک قبلاً در این تطبیق لینک شده است');
    err.status = 409;
    throw err;
  }

  const clearDate = clearDateFor(db, cid, cheque.due_date);
  const desc = `چک ${cheque.cheque_number || ('#' + cid)} — ${cheque.party_name || ''} (${lc === 'cleared_out' ? 'پاس' : 'وصول'})`;

  const result = db.transaction(() => {
    const bookAmt = lineAmt; // keep statement sign so 1:1 sums match
    const ins = db.prepare(`
      INSERT INTO bank_reconciliation_items
        (reconciliation_id, side, ref_type, ref_id, description, amount_rial,
         matched, statement_line, match_confidence, item_kind, line_date)
      VALUES (?, 'book', 'cheque_record', ?, ?, ?, 1, 0, 100, 'unclassified', ?)
    `).run(recon.id, cid, desc.trim(), bookAmt, clearDate || line.line_date || null);
    const bookItemId = ins.lastInsertRowid;

    if (line.bank_item_id) {
      db.prepare(`
        UPDATE bank_reconciliation_items
        SET matched=1, match_confidence=100
        WHERE id=? AND reconciliation_id=?
      `).run(line.bank_item_id, recon.id);
    }
    db.prepare(`
      UPDATE bank_statement_lines
      SET matched=1, match_confidence=100,
          matched_ref_type='cheque_record', matched_ref_id=?, matched_item_id=?
      WHERE id=? AND reconciliation_id=?
    `).run(cid, bookItemId, lid, recon.id);

    return {
      ok: true,
      book_item_id: bookItemId,
      statement_line_id: lid,
      cheque_id: cid,
      amount_rial: bookAmt,
      confirmed_by: userId || null,
    };
  })();

  return result;
}

module.exports = {
  suggestChequeMatches,
  confirmChequeMatch,
  dateWithinOneDay,
  clearDateFor,
};
