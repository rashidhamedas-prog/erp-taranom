const router = require('express').Router();
const { getDB, audit } = require('../db');
const { auth, requirePermission } = require('../middleware/auth');
const { postToLedger } = require('../lib/ledger');
const { reverseJournalEntry } = require('../lib/void-journal');
const { assertSafeRial } = require('../lib/money');
const { todayJalali, addDaysToJalali } = require('../jalali');
const {
  normalizeKind, assertJalaliDate, assertRialBank, computeBookBalance,
  resolveBankPostingAccount, computeBridge, adjustmentLines, POSTING_KINDS,
} = require('../lib/bank-recon');

function permit(action) {
  return (req, res, next) => {
    if (req.user?.role === 'admin' || req.user?.role === 'accounting') return next();
    return requirePermission('bank_reconciliation', action)(req, res, next);
  };
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
  const findCol = (re) => header.findIndex(h => re.test(h));
  const idx = {
    date: findCol(/date|تاریخ/),
    amount: findCol(/amount|مبلغ|rial/),
    withdraw: findCol(/برداشت|withdraw/),
    deposit: findCol(/واریز|deposit/),
    description: findCol(/desc|شرح|description/),
    ref: findCol(/ref|reference|شناسه|پیگیری/),
  };
  if (!looksHeader) {
    idx.date = 0; idx.amount = 1; idx.description = 2; idx.ref = 3;
    idx.withdraw = -1; idx.deposit = -1;
  }
  const cell = (cols, i) => (i >= 0 ? (cols[i] || '') : '');
  const rows = [];
  for (let i = start; i < lines.length; i++) {
    const cols = split(lines[i]);
    if (!cols.length || cols.every(c => !c)) continue;
    let amount = cell(cols, idx.amount);
    if ((amount === '' || idx.amount < 0) && (idx.withdraw >= 0 || idx.deposit >= 0)) {
      const w = Number(String(cell(cols, idx.withdraw)).replace(/,/g, '')) || 0;
      const d = Number(String(cell(cols, idx.deposit)).replace(/,/g, '')) || 0;
      amount = d - w;
    }
    rows.push({
      date: cell(cols, idx.date),
      amount_rial: amount,
      description: cell(cols, idx.description),
      ref: cell(cols, idx.ref),
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
  if (recon.status === 'void') throw new Error('تطبیق باطل شده است');
}

function activeItems(db, reconId) {
  const items = db.prepare(`
    SELECT * FROM bank_reconciliation_items WHERE reconciliation_id=? ORDER BY id
  `).all(reconId);
  const voidedBankItemIds = new Set(
    db.prepare(`
      SELECT bank_item_id AS id FROM bank_statement_lines
      WHERE reconciliation_id=? AND (COALESCE(deleted_at,0)!=0 OR status='void')
        AND bank_item_id IS NOT NULL
    `).all(reconId).map(r => r.id)
  );
  return items.filter(i => !Number(i.voided) && !(i.side === 'bank' && voidedBankItemIds.has(i.id)));
}

function bridgeFor(db, recon) {
  const liveBook = computeBookBalance(db, recon.bank_id, recon.statement_date);
  return {
    live_book_balance_rial: liveBook,
    bridge: computeBridge(recon.statement_balance_rial, liveBook, activeItems(db, recon.id)),
  };
}

router.post('/', auth, permit('create'), (req, res) => {
  try {
    const { bank_id, statement_date, statement_balance_rial, notes } = req.body;
    const bankId = parseInt(bank_id, 10);
    const stmtDate = assertJalaliDate(statement_date);
    const stmtBal = Math.round(Number(statement_balance_rial) || 0);
    if (!bankId) throw new Error('بانک و تاریخ صورت‌حساب الزامی است');

    const db = getDB();
    const bank = db.prepare('SELECT id, is_foreign, currency, coa_code FROM banks WHERE id=?').get(bankId);
    assertRialBank(bank);
    const open = db.prepare(`
      SELECT id FROM bank_reconciliations
      WHERE bank_id=? AND status='open' LIMIT 1
    `).get(bankId);
    if (open) throw new Error('برای این بانک یک تطبیق باز وجود دارد؛ ابتدا همان را ببندید یا باطل کنید');

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
  const live = bridgeFor(db, recon);
  res.json({ ...recon, items, statement_lines, ...live });
});

router.post('/:id/items', auth, permit('edit'), (req, res) => {
  try {
    const db = getDB();
    const recon = loadReconOr404(db, req.params.id);
    ensureOpen(recon);

    const rows = Array.isArray(req.body.items) ? req.body.items : [req.body];
    const ins = db.prepare(`
      INSERT INTO bank_reconciliation_items
        (reconciliation_id, side, ref_type, ref_id, description, amount_rial, matched, statement_line, match_confidence, item_kind, line_date)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `);
    const created = db.transaction(() => rows.map(row => {
      const side = row.side === 'bank' ? 'bank' : 'book';
      const amt = Math.round(Number(row.amount_rial) || 0);
      if (!amt) throw new Error('مبلغ آیتم نامعتبر است');
      const kind = normalizeKind(row.item_kind);
      const lineDate = row.line_date ? assertJalaliDate(row.line_date) : null;
      const r = ins.run(
        recon.id, side, row.ref_type || null, row.ref_id || null,
        row.description || '', amt, row.matched ? 1 : 0, row.statement_line ? 1 : 0,
        row.match_confidence != null ? Math.round(Number(row.match_confidence) || 0) : 0,
        kind, lineDate
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
        const dup = db.prepare(`
          SELECT id FROM bank_statement_lines
          WHERE reconciliation_id=? AND line_date=? AND amount_rial=? AND COALESCE(ref,'')=?
            AND COALESCE(deleted_at,0)=0 AND COALESCE(status,'active')<>'void'
          LIMIT 1
        `).get(recon.id, lineDate, amountRial, ref);
        if (dup) continue;

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
            SET matched=0, match_confidence=0, voided=1,
                description=COALESCE(description,'') || ' [ابطال صورت‌حساب]'
            WHERE id=? AND reconciliation_id=?
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

    const ids = Array.isArray(req.body.item_ids) ? req.body.item_ids.map(Number).filter(Boolean) : [];
    if (ids.length < 2) throw new Error('حداقل یک ردیف بانک و یک ردیف دفتر لازم است');

    db.transaction(() => {
      const rows = ids.map(id => db.prepare(`
        SELECT * FROM bank_reconciliation_items
        WHERE reconciliation_id=? AND id=? AND COALESCE(voided,0)=0
      `).get(recon.id, id)).filter(Boolean);
      if (rows.length !== ids.length) throw new Error('برخی ردیف‌ها برای این تطبیق پیدا نشد');
      const bankSum = rows.filter(r => r.side === 'bank').reduce((s, r) => s + Math.abs(Number(r.amount_rial) || 0), 0);
      const bookSum = rows.filter(r => r.side === 'book').reduce((s, r) => s + Math.abs(Number(r.amount_rial) || 0), 0);
      if (!bankSum || !bookSum || bankSum !== bookSum) {
        throw new Error('جمع مبلغ طرف بانک و دفتر باید برابر و غیرصفر باشد');
      }
      const stmt = db.prepare(`
        UPDATE bank_reconciliation_items SET matched=1, match_confidence=100
        WHERE reconciliation_id=? AND id=?
      `);
      for (const id of ids) stmt.run(recon.id, id);
      const bankItems = rows.filter(r => r.side === 'bank' && r.statement_line_id);
      for (const b of bankItems) {
        db.prepare(`
          UPDATE bank_statement_lines
          SET matched=1, match_confidence=100, matched_item_id=?
          WHERE id=? AND reconciliation_id=? AND COALESCE(status,'active')<>'void'
        `).run(b.id, b.statement_line_id, recon.id);
      }
    })();

    audit(req.user.id, 'match', 'bank_reconciliation', recon.id, `تطبیق دستی ${ids.length} ردیف`);
    res.json({ ok: true, matched: ids.length });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

router.post('/:id/classify', auth, permit('edit'), (req, res) => {
  try {
    const db = getDB();
    const recon = loadReconOr404(db, req.params.id);
    ensureOpen(recon);
    const itemId = parseInt(req.body?.item_id, 10);
    const kind = normalizeKind(req.body?.item_kind);
    if (!itemId) throw new Error('ردیف الزامی است');
    const item = db.prepare(`
      SELECT id, matched FROM bank_reconciliation_items
      WHERE id=? AND reconciliation_id=? AND COALESCE(voided,0)=0
    `).get(itemId, recon.id);
    if (!item) throw new Error('ردیف یافت نشد');
    if (item.matched) throw new Error('ردیف تطبیق‌شده را نمی‌توان طبقه‌بندی کرد');
    db.prepare('UPDATE bank_reconciliation_items SET item_kind=? WHERE id=?').run(kind, itemId);
    audit(req.user.id, 'classify', 'bank_reconciliation', recon.id, `طبقه ${kind} برای ردیف ${itemId}`);
    res.json({ ok: true, item_kind: kind, ...bridgeFor(db, recon) });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

router.post('/:id/unmatch', auth, permit('edit'), (req, res) => {
  try {
    const db = getDB();
    const recon = loadReconOr404(db, req.params.id);
    ensureOpen(recon);
    const ids = Array.isArray(req.body.item_ids) ? req.body.item_ids.map(Number).filter(Boolean) : [];
    if (!ids.length) throw new Error('شناسه آیتم‌ها الزامی است');
    db.transaction(() => {
      for (const id of ids) {
        const item = db.prepare(`
          SELECT * FROM bank_reconciliation_items WHERE id=? AND reconciliation_id=?
        `).get(id, recon.id);
        if (!item) continue;
        db.prepare(`
          UPDATE bank_reconciliation_items SET matched=0, match_confidence=0 WHERE id=?
        `).run(id);
        if (item.statement_line_id) {
          db.prepare(`
            UPDATE bank_statement_lines
            SET matched=0, match_confidence=0, matched_ref_type=NULL, matched_ref_id=NULL, matched_item_id=NULL
            WHERE id=? AND reconciliation_id=?
          `).run(item.statement_line_id, recon.id);
        }
      }
    })();
    audit(req.user.id, 'unmatch', 'bank_reconciliation', recon.id, `لغو تطبیق ${ids.length} ردیف`);
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

router.post('/:id/refresh-book', auth, permit('edit'), (req, res) => {
  try {
    const db = getDB();
    const recon = loadReconOr404(db, req.params.id);
    ensureOpen(recon);
    const bookBal = computeBookBalance(db, recon.bank_id, recon.statement_date);
    db.prepare('UPDATE bank_reconciliations SET book_balance_rial=? WHERE id=?').run(bookBal, recon.id);
    const fresh = loadReconOr404(db, recon.id);
    res.json({ ok: true, ...bridgeFor(db, fresh), book_balance_rial: bookBal });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

router.post('/:id/close', auth, permit('approve'), (req, res) => {
  try {
    const db = getDB();
    const recon = loadReconOr404(db, req.params.id);
    if (!recon) return res.status(404).json({ error: 'یافت نشد' });
    if (recon.status === 'void') throw new Error('تطبیق باطل شده است');
    if (recon.status === 'closed') {
      return res.json({ ok: true, already: true, adjustment_je_id: recon.adjustment_je_id, ...bridgeFor(db, recon) });
    }

    const result = db.transaction(() => {
      const current = loadReconOr404(db, recon.id);
      if (current.status === 'closed') {
        return { already: true, adjustment_je_id: current.adjustment_je_id, bridge: bridgeFor(db, current).bridge };
      }
      const liveBook = computeBookBalance(db, current.bank_id, current.statement_date);
      const items = activeItems(db, current.id);
      const bridge = computeBridge(current.statement_balance_rial, liveBook, items);
      if (!bridge.can_close) {
        const err = new Error(
          bridge.unclassified_rial
            ? 'ردیف‌های بدون طبقه‌بندی مانده است؛ چک معوق، واریز در راه، کارمزد یا سود را مشخص کنید'
            : `اختلاف توجیه‌نشده ${bridge.unexplained_rial} ریال است و تا صفر نشود تطبیق بسته نمی‌شود`
        );
        err.status = 400;
        throw err;
      }
      let adjustmentJeId = current.adjustment_je_id || null;
      const needsPost = items.some(i => !Number(i.matched) && !Number(i.voided) && POSTING_KINDS.has(normalizeKind(i.item_kind)));
      const lines = needsPost
        ? adjustmentLines(db, resolveBankPostingAccount(db, current.bank_id).account, items)
        : [];
      if (lines.length) {
        const existing = db.prepare(`
          SELECT id FROM journal_entries
          WHERE ref_type='bank_recon_adjustment' AND ref_id=?
            AND COALESCE(deleted_at,0)=0 AND COALESCE(status,'posted') NOT IN ('reversed','void')
          LIMIT 1
        `).get(current.id);
        adjustmentJeId = existing ? existing.id : postToLedger(db, {
          sourceType: 'bank_recon_adjustment', sourceId: current.id,
          date: current.statement_date || todayJalali(),
          description: `تعدیل تطبیق بانک #${current.id}`,
          createdBy: req.user.id, lines,
        });
      }
      db.prepare(`
        UPDATE bank_reconciliations
        SET status='closed', book_balance_rial=?, adjustment_je_id=?, closed_at=strftime('%s','now')
        WHERE id=? AND status='open'
      `).run(liveBook, adjustmentJeId, current.id);
      return { adjustment_je_id: adjustmentJeId, bridge, difference_rial: 0 };
    })();

    audit(req.user.id, 'close', 'bank_reconciliation', recon.id, `بستن تطبیق بانک`);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

router.post('/:id/void', auth, permit('approve'), (req, res) => {
  try {
    const db = getDB();
    const recon = loadReconOr404(db, req.params.id);
    if (!recon) return res.status(404).json({ error: 'یافت نشد' });
    if (recon.status === 'void') throw new Error('تطبیق قبلاً باطل شده است');
    const result = db.transaction(() => {
      let reversalId = null;
      if (recon.adjustment_je_id) {
        reversalId = reverseJournalEntry(db, recon.adjustment_je_id, {
          userId: req.user.id,
          date: todayJalali(),
          reason: req.body?.reason || 'ابطال تطبیق بانک',
          sourceType: 'bank_recon_adjustment_reversal',
        });
      }
      db.prepare(`
        UPDATE bank_reconciliations
        SET status='void', reversal_je_id=?, voided_at=strftime('%s','now')
        WHERE id=?
      `).run(reversalId, recon.id);
      return { reversal_je_id: reversalId };
    })();
    audit(req.user.id, 'void', 'bank_reconciliation', recon.id, 'ابطال تطبیق بانک');
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

module.exports = router;
module.exports.parseBankStatementCsv = parseBankStatementCsv;
module.exports.normalizeAmountRial = normalizeAmountRial;
module.exports.dateWithinOneDay = dateWithinOneDay;
