const router = require('express').Router();
const { getDB, audit } = require('../db');
const { auth, requirePermission } = require('../middleware/auth');
const { acct } = require('../lib/coa-map');
const { postToLedger } = require('../lib/ledger');
const { assertSafeRial, rialToLedger, SQL_JL_DEBIT_RIAL, SQL_JL_CREDIT_RIAL } = require('../lib/money');
const { todayJalali, addDaysToJalali } = require('../jalali');

function permit(action) {
  return (req, res, next) => {
    if (req.user?.role === 'admin' || req.user?.role === 'accounting') return next();
    return requirePermission('bank_reconciliation', action)(req, res, next);
  };
}

function bankAccountCode(db, bankId) {
  const bank = db.prepare('SELECT coa_code FROM banks WHERE id=?').get(bankId);
  if (bank?.coa_code) return bank.coa_code;
  return '1102-' + bankId;
}

function computeBookBalance(db, bankId, asOfDate) {
  const code = bankAccountCode(db, bankId);
  const row = db.prepare(`
    SELECT COALESCE(SUM(${SQL_JL_DEBIT_RIAL} - ${SQL_JL_CREDIT_RIAL}), 0) bal
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.entry_id
    WHERE (jl.account_code = ? OR jl.account_code LIKE ?)
      AND COALESCE(je.deleted_at, 0) = 0
      AND COALESCE(je.status, 'approved') <> 'reversed'
      AND (? = '' OR je.entry_date <= ?)
  `).get(code, code + '-%', asOfDate || '', asOfDate || '');
  return Math.round(row?.bal || 0);
}

/** Normalize imported amount to INTEGER rial (rejects non-finite / unsafe). */
function normalizeAmountRial(raw) {
  if (raw == null || raw === '') throw new Error('مبلغ ردیف صورت‌حساب الزامی است');
  const n = typeof raw === 'string'
    ? Number(String(raw).replace(/,/g, '').replace(/[^\d.-]/g, '').trim())
    : Number(raw);
  const rial = assertSafeRial(n, 'bank_statement_amount');
  if (!rial) throw new Error('مبلغ ردیف صورت‌حساب نامعتبر است');
  return rial;
}

function normalizeLineDate(raw) {
  const d = String(raw || '').trim();
  if (!/^\d{4}\/\d{2}\/\d{2}$/.test(d)) throw new Error('تاریخ ردیف باید به صورت YYYY/MM/DD باشد');
  return d;
}

/** Optional CSV helper: header date,amount_rial,description,ref (comma or semicolon). */
function parseBankStatementCsv(text) {
  const src = String(text || '').replace(/^\uFEFF/, '').trim();
  if (!src) return [];
  const lines = src.split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return [];
  const delim = lines[0].includes(';') && !lines[0].includes(',') ? ';' : ',';
  const split = (row) => {
    const out = [];
    let cur = '', inQ = false;
    for (let i = 0; i < row.length; i++) {
      const ch = row[i];
      if (ch === '"') { inQ = !inQ; continue; }
      if (!inQ && ch === delim) { out.push(cur.trim()); cur = ''; continue; }
      cur += ch;
    }
    out.push(cur.trim());
    return out;
  };
  let start = 0;
  const header = split(lines[0]).map(h => h.toLowerCase());
  const looksHeader = header.some(h => /date|amount|مبلغ|تاریخ/.test(h));
  if (looksHeader) start = 1;
  const idx = {
    date: Math.max(0, header.findIndex(h => /date|تاریخ/.test(h))),
    amount: Math.max(0, header.findIndex(h => /amount|مبلغ|rial/.test(h))),
    description: Math.max(0, header.findIndex(h => /desc|شرح|description/.test(h))),
    ref: Math.max(0, header.findIndex(h => /ref|reference|شناسه|پیگیری/.test(h))),
  };
  if (!looksHeader) {
    idx.date = 0; idx.amount = 1; idx.description = 2; idx.ref = 3;
  }
  const rows = [];
  for (let i = start; i < lines.length; i++) {
    const cols = split(lines[i]);
    if (!cols.length || cols.every(c => !c)) continue;
    rows.push({
      date: cols[idx.date] || '',
      amount_rial: cols[idx.amount] || '',
      description: cols[idx.description] || '',
      ref: cols[idx.ref] || '',
    });
  }
  return rows;
}

function dateWithinOneDay(a, b) {
  if (a === b) return true;
  if (addDaysToJalali(a, 1) === b) return true;
  if (addDaysToJalali(a, -1) === b) return true;
  return false;
}

function loadReconOr404(db, id) {
  return db.prepare('SELECT * FROM bank_reconciliations WHERE id=?').get(id);
}

function ensureOpen(recon) {
  if (!recon) {
    const err = new Error('یافت نشد');
    err.status = 404;
    throw err;
  }
  if (recon.status === 'closed') throw new Error('تطبیق بسته شده و قابل ویرایش نیست');
}

router.post('/', auth, permit('create'), (req, res) => {
  try {
    const { bank_id, statement_date, statement_balance_rial, notes } = req.body;
    const bankId = parseInt(bank_id, 10);
    const stmtDate = String(statement_date || '').trim();
    const stmtBal = Math.round(Number(statement_balance_rial) || 0);
    if (!bankId || !stmtDate) throw new Error('بانک و تاریخ صورت‌حساب الزامی است');

    const db = getDB();
    const bank = db.prepare('SELECT id FROM banks WHERE id=?').get(bankId);
    if (!bank) throw new Error('بانک یافت نشد');

    const bookBal = computeBookBalance(db, bankId, stmtDate);
    const r = db.prepare(`
      INSERT INTO bank_reconciliations
        (bank_id, statement_date, statement_balance_rial, book_balance_rial, status, notes, created_by)
      VALUES (?,?,?,?, 'open', ?, ?)
    `).run(bankId, stmtDate, stmtBal, bookBal, notes || '', req.user.id);

    audit(req.user.id, 'create', 'bank_reconciliation', r.lastInsertRowid, `تطبیق بانک #${bankId}`);
    res.json(db.prepare('SELECT * FROM bank_reconciliations WHERE id=?').get(r.lastInsertRowid));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/', auth, permit('view'), (req, res) => {
  const db = getDB();
  const where = [], params = [];
  if (req.query.bank_id) { where.push('r.bank_id=?'); params.push(parseInt(req.query.bank_id, 10)); }
  if (req.query.status) { where.push('r.status=?'); params.push(req.query.status); }
  const sql = `
    SELECT r.*, b.name AS bank_name
    FROM bank_reconciliations r
    JOIN banks b ON b.id = r.bank_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY r.id DESC LIMIT 200
  `;
  res.json(db.prepare(sql).all(...params));
});

router.get('/:id', auth, permit('view'), (req, res) => {
  const db = getDB();
  const recon = db.prepare(`
    SELECT r.*, b.name AS bank_name
    FROM bank_reconciliations r
    JOIN banks b ON b.id = r.bank_id
    WHERE r.id=?
  `).get(req.params.id);
  if (!recon) return res.status(404).json({ error: 'یافت نشد' });
  const items = db.prepare(`
    SELECT * FROM bank_reconciliation_items WHERE reconciliation_id=? ORDER BY id
  `).all(recon.id);
  const statement_lines = db.prepare(`
    SELECT * FROM bank_statement_lines
    WHERE reconciliation_id=? AND COALESCE(deleted_at, 0) = 0 AND COALESCE(status, 'active') <> 'void'
    ORDER BY id
  `).all(recon.id);
  res.json({ ...recon, items, statement_lines });
});

router.post('/:id/items', auth, permit('edit'), (req, res) => {
  try {
    const db = getDB();
    const recon = loadReconOr404(db, req.params.id);
    ensureOpen(recon);

    const rows = Array.isArray(req.body.items) ? req.body.items : [req.body];
    const ins = db.prepare(`
      INSERT INTO bank_reconciliation_items
        (reconciliation_id, side, ref_type, ref_id, description, amount_rial, matched, statement_line, match_confidence)
      VALUES (?,?,?,?,?,?,?,?,?)
    `);
    const created = db.transaction(() => rows.map(row => {
      const side = row.side === 'bank' ? 'bank' : 'book';
      const amt = Math.round(Number(row.amount_rial) || 0);
      if (!amt) throw new Error('مبلغ آیتم نامعتبر است');
      const r = ins.run(
        recon.id, side, row.ref_type || null, row.ref_id || null,
        row.description || '', amt, row.matched ? 1 : 0, row.statement_line ? 1 : 0,
        row.match_confidence != null ? Math.round(Number(row.match_confidence) || 0) : 0
      );
      return db.prepare('SELECT * FROM bank_reconciliation_items WHERE id=?').get(r.lastInsertRowid);
    }))();

    res.json({ ok: true, items: created });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

/**
 * Import bank statement lines (JSON). Optional body.csv_text uses parseBankStatementCsv.
 * Body: { lines:[{date, amount_rial, description, ref}], csv_text? }
 * Soft-void only (R13) — never physical delete.
 */
router.post('/:id/import-lines', auth, permit('edit'), (req, res) => {
  try {
    const db = getDB();
    const recon = loadReconOr404(db, req.params.id);
    ensureOpen(recon);

    let rawLines = Array.isArray(req.body?.lines) ? req.body.lines : [];
    if ((!rawLines.length) && req.body?.csv_text) {
      rawLines = parseBankStatementCsv(req.body.csv_text);
    }
    if (!rawLines.length) throw new Error('لیست ردیف‌های صورت‌حساب خالی است');

    const insLine = db.prepare(`
      INSERT INTO bank_statement_lines
        (reconciliation_id, line_date, amount_rial, description, ref, matched, match_confidence, status, bank_item_id)
      VALUES (?,?,?,?,?, 0, 0, 'active', ?)
    `);
    const insItem = db.prepare(`
      INSERT INTO bank_reconciliation_items
        (reconciliation_id, side, ref_type, ref_id, description, amount_rial, matched, statement_line, match_confidence, statement_line_id)
      VALUES (?, 'bank', 'statement_line', NULL, ?, ?, 0, 1, 0, NULL)
    `);
    const linkItem = db.prepare(`
      UPDATE bank_statement_lines SET bank_item_id=? WHERE id=?
    `);
    const linkStmtOnItem = db.prepare(`
      UPDATE bank_reconciliation_items SET statement_line_id=?, ref_id=? WHERE id=?
    `);

    const created = db.transaction(() => {
      const out = [];
      for (const row of rawLines) {
        const lineDate = normalizeLineDate(row.date || row.line_date);
        const amountRial = normalizeAmountRial(row.amount_rial != null ? row.amount_rial : row.amount);
        const description = String(row.description || row.desc || '').trim();
        const ref = String(row.ref || row.reference || '').trim();

        const itemR = insItem.run(recon.id, description || ref || 'ردیف صورت‌حساب', amountRial);
        const bankItemId = itemR.lastInsertRowid;
        const lineR = insLine.run(recon.id, lineDate, amountRial, description, ref, bankItemId);
        const lineId = lineR.lastInsertRowid;
        linkItem.run(bankItemId, lineId);
        linkStmtOnItem.run(lineId, lineId, bankItemId);

        out.push(db.prepare('SELECT * FROM bank_statement_lines WHERE id=?').get(lineId));
      }
      return out;
    })();

    audit(req.user.id, 'import', 'bank_reconciliation', recon.id, `واردات ${created.length} ردیف صورت‌حساب`);
    res.json({
      ok: true,
      imported: created.length,
      lines: created,
      unmatched: created.filter(l => !l.matched).length,
      matched: created.filter(l => l.matched).length,
    });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

/**
 * Soft-void imported statement lines (R13 — no physical DELETE).
 * Body: { line_ids: number[] }
 */
router.post('/:id/void-lines', auth, permit('edit'), (req, res) => {
  try {
    const db = getDB();
    const recon = loadReconOr404(db, req.params.id);
    ensureOpen(recon);
    const ids = Array.isArray(req.body?.line_ids) ? req.body.line_ids.map(Number).filter(Boolean) : [];
    if (!ids.length) throw new Error('شناسه ردیف‌ها الزامی است');

    const result = db.transaction(() => {
      let voided = 0;
      for (const id of ids) {
        const line = db.prepare(`
          SELECT * FROM bank_statement_lines
          WHERE id=? AND reconciliation_id=? AND COALESCE(deleted_at,0)=0
        `).get(id, recon.id);
        if (!line) continue;
        if (line.matched) throw new Error(`ردیف #${id} تطبیق شده و قابل ابطال نیست — ابتدا تطبیق را لغو کنید`);
        db.prepare(`
          UPDATE bank_statement_lines
          SET status='void', deleted_at=strftime('%s','now'), matched=0, match_confidence=0
          WHERE id=?
        `).run(id);
        if (line.bank_item_id) {
          db.prepare(`
            UPDATE bank_reconciliation_items
            SET matched=0, match_confidence=0, description=COALESCE(description,'') || ' [ابطال صورت‌حساب]'
            WHERE id=? AND reconciliation_id=? AND matched=0
          `).run(line.bank_item_id, recon.id);
          // Keep the book-side item row (R13) but flag as voided via description; soft-hide via amount 0 not allowed.
          // Mark matched=1 with zero effect is wrong — leave unmatched bank item; close path treats unmatched bank.
        }
        voided++;
      }
      return voided;
    })();

    audit(req.user.id, 'void_lines', 'bank_reconciliation', recon.id, `ابطال ${result} ردیف صورت‌حساب`);
    res.json({ ok: true, voided: result });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

/**
 * 1:1 auto-match: unmatched statement lines ↔ unmatched book items / settlements
 * by exact amount_rial and date ±1 day. Unique candidate → confidence=100.
 * Does NOT post JE adjustments (those stay on close/approve).
 */
router.post('/:id/auto-match-1to1', auth, permit('edit'), (req, res) => {
  try {
    const db = getDB();
    const recon = loadReconOr404(db, req.params.id);
    ensureOpen(recon);

    const result = db.transaction(() => {
      const bankLines = db.prepare(`
        SELECT * FROM bank_statement_lines
        WHERE reconciliation_id=? AND COALESCE(matched,0)=0
          AND COALESCE(deleted_at,0)=0 AND COALESCE(status,'active')='active'
        ORDER BY id
      `).all(recon.id);

      const bookItems = db.prepare(`
        SELECT * FROM bank_reconciliation_items
        WHERE reconciliation_id=? AND side='book' AND COALESCE(matched,0)=0
        ORDER BY id
      `).all(recon.id);

      // Settlements for this bank not already linked in this recon
      const linkedSettlementIds = new Set(
        db.prepare(`
          SELECT ref_id AS id FROM bank_reconciliation_items
          WHERE reconciliation_id=? AND ref_type='settlement' AND ref_id IS NOT NULL
        `).all(recon.id).map(r => r.id)
      );
      const settlements = db.prepare(`
        SELECT id, date, amount_rial, note, pay_type
        FROM settlements
        WHERE bank_id=? AND COALESCE(amount_rial,0) != 0
        ORDER BY id
      `).all(recon.bank_id).filter(s => !linkedSettlementIds.has(s.id));

      const usedBookIds = new Set();
      const usedSettlementIds = new Set();
      let matchedCount = 0;
      const matches = [];

      const insBook = db.prepare(`
        INSERT INTO bank_reconciliation_items
          (reconciliation_id, side, ref_type, ref_id, description, amount_rial, matched, statement_line, match_confidence)
        VALUES (?, 'book', ?, ?, ?, ?, 1, 0, 100)
      `);
      const markBook = db.prepare(`
        UPDATE bank_reconciliation_items
        SET matched=1, match_confidence=100
        WHERE id=? AND reconciliation_id=?
      `);
      const markBankItem = db.prepare(`
        UPDATE bank_reconciliation_items
        SET matched=1, match_confidence=100
        WHERE id=? AND reconciliation_id=?
      `);
      const markLine = db.prepare(`
        UPDATE bank_statement_lines
        SET matched=1, match_confidence=100,
            matched_ref_type=?, matched_ref_id=?, matched_item_id=?
        WHERE id=?
      `);

      for (const line of bankLines) {
        const candidates = [];

        for (const bi of bookItems) {
          if (usedBookIds.has(bi.id)) continue;
          if (Number(bi.amount_rial) !== Number(line.amount_rial)) continue;
          // Manual book items often have no date; only enforce ±1 day when a date is present.
          const biDate = bi.line_date || bi.date || null;
          if (biDate && !dateWithinOneDay(line.line_date, biDate)) continue;
          candidates.push({ kind: 'book_item', id: bi.id, row: bi });
        }

        for (const s of settlements) {
          if (usedSettlementIds.has(s.id)) continue;
          if (Number(s.amount_rial) !== Number(line.amount_rial)) continue;
          if (!s.date || !dateWithinOneDay(line.line_date, s.date)) continue;
          candidates.push({ kind: 'settlement', id: s.id, row: s });
        }

        if (candidates.length !== 1) continue; // ambiguous or none → leave unmatched

        const c = candidates[0];
        let bookItemId;
        let refType;
        let refId;

        if (c.kind === 'book_item') {
          bookItemId = c.id;
          usedBookIds.add(c.id);
          refType = c.row.ref_type || 'book_item';
          refId = c.row.ref_id || c.id;
          markBook.run(bookItemId, recon.id);
        } else {
          usedSettlementIds.add(c.id);
          refType = 'settlement';
          refId = c.id;
          const r = insBook.run(
            recon.id, 'settlement', c.id,
            c.row.note || `تسویه #${c.id}`, c.row.amount_rial
          );
          bookItemId = r.lastInsertRowid;
        }

        if (line.bank_item_id) markBankItem.run(line.bank_item_id, recon.id);
        markLine.run(refType, refId, bookItemId, line.id);
        matchedCount++;
        matches.push({
          statement_line_id: line.id,
          book_item_id: bookItemId,
          ref_type: refType,
          ref_id: refId,
          amount_rial: line.amount_rial,
          confidence: 100,
        });
      }

      const remainingUnmatched = db.prepare(`
        SELECT COUNT(*) AS c FROM bank_statement_lines
        WHERE reconciliation_id=? AND COALESCE(matched,0)=0
          AND COALESCE(deleted_at,0)=0 AND COALESCE(status,'active')='active'
      `).get(recon.id).c;

      return {
        matched: matchedCount,
        unmatched: remainingUnmatched,
        matches,
      };
    })();

    audit(req.user.id, 'auto_match', 'bank_reconciliation', recon.id,
      `تطبیق خودکار ۱:۱ — ${result.matched} مورد`);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

router.post('/:id/match', auth, permit('edit'), (req, res) => {
  try {
    const db = getDB();
    const recon = loadReconOr404(db, req.params.id);
    ensureOpen(recon);

    const ids = Array.isArray(req.body.item_ids) ? req.body.item_ids.map(Number) : [];
    if (!ids.length) throw new Error('شناسه آیتم‌ها الزامی است');

    db.transaction(() => {
      const stmt = db.prepare(`
        UPDATE bank_reconciliation_items SET matched=1
        WHERE reconciliation_id=? AND id=?
      `);
      for (const id of ids) stmt.run(recon.id, id);
    })();

    res.json({ ok: true, matched: ids.length });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

router.post('/:id/close', auth, permit('approve'), (req, res) => {
  try {
    const db = getDB();
    const recon = loadReconOr404(db, req.params.id);
    if (!recon) return res.status(404).json({ error: 'یافت نشد' });
    if (recon.status === 'closed') throw new Error('تطبیق قبلاً بسته شده است');

    const items = db.prepare(`
      SELECT * FROM bank_reconciliation_items WHERE reconciliation_id=?
    `).all(recon.id);

    // Exclude soft-voided statement-linked bank items from difference calc
    const voidedBankItemIds = new Set(
      db.prepare(`
        SELECT bank_item_id AS id FROM bank_statement_lines
        WHERE reconciliation_id=? AND (COALESCE(deleted_at,0)!=0 OR status='void')
          AND bank_item_id IS NOT NULL
      `).all(recon.id).map(r => r.id)
    );

    const activeItems = items.filter(i => !(i.side === 'bank' && voidedBankItemIds.has(i.id)));

    const unmatchedBook = activeItems.filter(i => i.side === 'book' && !i.matched)
      .reduce((s, i) => s + (i.amount_rial || 0), 0);
    const unmatchedBank = activeItems.filter(i => i.side === 'bank' && !i.matched)
      .reduce((s, i) => s + (i.amount_rial || 0), 0);
    const reconciledBook = recon.book_balance_rial - unmatchedBook + unmatchedBank;
    const diff = recon.statement_balance_rial - reconciledBook;

    const result = db.transaction(() => {
      let adjustmentJeId = recon.adjustment_je_id || null;
      if (Math.abs(diff) > 0) {
        const bankAcct = acct(db, 'coa_bank_default');
        const adjAcct = acct(db, 'coa_adjustment');
        const absRial = Math.abs(diff);
        const amt = rialToLedger(absRial);
        const lines = diff > 0
          ? [
            { code: bankAcct.code, name: bankAcct.name, debit: amt, credit: 0, debit_rial: absRial },
            { code: adjAcct.code, name: adjAcct.name, debit: 0, credit: amt, credit_rial: absRial },
          ]
          : [
            { code: adjAcct.code, name: adjAcct.name, debit: amt, credit: 0, debit_rial: absRial },
            { code: bankAcct.code, name: bankAcct.name, debit: 0, credit: amt, credit_rial: absRial },
          ];
        adjustmentJeId = postToLedger(db, {
          sourceType: 'bank_recon_adjustment', sourceId: recon.id,
          date: recon.statement_date || todayJalali(),
          description: `تعدیل تطبیق بانک #${recon.id}`,
          createdBy: req.user.id, lines,
        });
      }
      db.prepare(`
        UPDATE bank_reconciliations
        SET status='closed', adjustment_je_id=?, closed_at=strftime('%s','now')
        WHERE id=?
      `).run(adjustmentJeId, recon.id);
      return { adjustment_je_id: adjustmentJeId, difference_rial: diff, reconciled_book_rial: reconciledBook };
    })();

    audit(req.user.id, 'close', 'bank_reconciliation', recon.id, `بستن تطبیق بانک`);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

module.exports = router;
module.exports.parseBankStatementCsv = parseBankStatementCsv;
module.exports.normalizeAmountRial = normalizeAmountRial;
module.exports.dateWithinOneDay = dateWithinOneDay;
