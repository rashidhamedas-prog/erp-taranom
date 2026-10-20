'use strict';
/**
 * One COA leaf, one signed story.
 *
 * When a party has several role books on the same leaf (person + supplier, …)
 * a payment that landed in only one book must not be hidden by a staler sibling.
 * v456 copies each live GL line on that leaf into every linked book that lacks it,
 * and live posts mirror the same way. Opening rows are filled only by the boot
 * heal — opening-post already writes every linked book.
 *
 * Payroll rows stored in toman stay put: a ref match covers the rial GL line,
 * so personLedgerLineRial keeps scaling them. Amounts on the journal are never rewritten.
 */

const { SQL_JL_DEBIT_RIAL, SQL_JL_CREDIT_RIAL } = require('./money');
const { personLedgerAliveSql } = require('./person-ledger-money');

const JE_ALIVE = `COALESCE(je.deleted_at,0)=0 AND COALESCE(je.status,'posted') NOT IN ('reversed','void')`;

function tableExists(db, name) {
  try {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  } catch (_) {
    return false;
  }
}

function isOpeningToken(refType, entryType) {
  const s = `${refType || ''} ${entryType || ''}`.toLowerCase();
  return s.includes('opening') || s.includes('افتتاح');
}

function moneyClose(row, gl) {
  const gd = Math.round(Number(gl.debit) || 0);
  const gc = Math.round(Number(gl.credit) || 0);
  const pairs = [
    [Math.round(Number(row.debit) || 0), Math.round(Number(row.credit) || 0)],
    [Math.round((Number(row.debit) || 0) * 10), Math.round((Number(row.credit) || 0) * 10)],
  ];
  return pairs.some(([d, c]) => Math.abs(d - gd) <= 1 && Math.abs(c - gc) <= 1);
}

function findUnusedMatch(book, gl) {
  const rows = book.rows;
  const used = book.used;
  const rt = String(gl.ref_type || '');
  const rid = gl.ref_id != null && gl.ref_id !== '' ? Number(gl.ref_id) : 0;
  if (rt && rid) {
    for (let i = 0; i < rows.length; i++) {
      if (used.has(i)) continue;
      if (String(rows[i].ref_type || '') !== rt || Number(rows[i].ref_id) !== rid) continue;
      // Same ref_type+ref_id can cover several JEs (e.g. two PRD-03 on one order).
      // Only treat as covered when the rial amount also matches.
      if (moneyClose(rows[i], gl)) return i;
    }
  }
  if (isOpeningToken(rt)) {
    for (let i = 0; i < rows.length; i++) {
      if (used.has(i)) continue;
      if (isOpeningToken(rows[i].ref_type, rows[i].entry_type)) return i;
    }
  }
  for (let i = 0; i < rows.length; i++) {
    if (used.has(i)) continue;
    const r = rows[i];
    if (String(r.date || '') === String(gl.date || '') && moneyClose(r, gl)) return i;
  }
  return -1;
}

function entryTypeFor(gl) {
  if (isOpeningToken(gl.ref_type)) return 'opening';
  const rt = String(gl.ref_type || '');
  if (/payment|settlement|receipt/.test(rt)) return 'payment';
  if (rt === 'purchase' || rt === 'purchase_invoice') return 'purchase';
  return rt || 'journal';
}

function uniquePartyForCode(db, code) {
  const ids = new Set();
  const add = (sql) => {
    try {
      for (const r of db.prepare(sql).all(code)) {
        const pid = Number(r.party_id);
        if (pid) ids.add(pid);
      }
    } catch (_) { /* table optional */ }
  };
  add('SELECT id AS party_id FROM parties WHERE coa_code=?');
  if (tableExists(db, 'persons')) {
    add('SELECT party_id FROM persons WHERE coa_code=? AND party_id IS NOT NULL');
  }
  if (tableExists(db, 'suppliers')) {
    add('SELECT party_id FROM suppliers WHERE coa_code=? AND party_id IS NOT NULL');
  }
  if (tableExists(db, 'customers')) {
    add('SELECT party_id FROM customers WHERE coa_code=? AND party_id IS NOT NULL');
  }
  if (ids.size !== 1) return null;
  return [...ids][0];
}

function loadBookRows(db, kind, entityId) {
  if (kind === 'person') {
    const alive = personLedgerAliveSql(db);
    return db.prepare(`
      SELECT date, entry_type, ref_type, ref_id, description, debit, credit
      FROM person_ledger pl WHERE person_id=? AND ${alive}
    `).all(entityId);
  }
  const table = kind === 'supplier' ? 'supplier_ledger' : 'customer_ledger';
  const col = kind === 'supplier' ? 'supplier_id' : 'customer_id';
  return db.prepare(`
    SELECT date, entry_type, ref_type, ref_id, description, debit, credit
    FROM ${table} WHERE ${col}=?
  `).all(entityId);
}

function booksForPartyCode(db, partyId, code) {
  const party = db.prepare('SELECT coa_code FROM parties WHERE id=?').get(partyId);
  const partyCoa = party && party.coa_code ? String(party.coa_code) : '';
  const books = [];
  const consider = (kind, table, idCol) => {
    if (!tableExists(db, table)) return;
    let entities = [];
    try {
      entities = db.prepare(`SELECT id, coa_code FROM ${table} WHERE party_id=?`).all(partyId);
    } catch (_) {
      return;
    }
    for (const ent of entities) {
      const leaf = ent.coa_code ? String(ent.coa_code) : partyCoa;
      if (leaf !== String(code)) continue;
      const ledger = kind === 'person' ? 'person_ledger' : (kind === 'supplier' ? 'supplier_ledger' : 'customer_ledger');
      if (!tableExists(db, ledger)) continue;
      books.push({
        kind,
        id: Number(ent.id),
        rows: loadBookRows(db, kind, ent.id),
        used: new Set(),
      });
    }
  };
  consider('person', 'persons', 'id');
  consider('supplier', 'suppliers', 'id');
  consider('customer', 'customers', 'id');
  return books;
}

function insertBookRow(db, book, gl) {
  const debit = Math.round(Number(gl.debit) || 0);
  const credit = Math.round(Number(gl.credit) || 0);
  const desc = gl.line_desc || gl.je_desc || 'سند دفتر کل';
  const args = [
    book.id,
    gl.date || '',
    entryTypeFor(gl),
    gl.ref_type || '',
    gl.ref_id != null ? gl.ref_id : null,
    desc,
    debit,
    credit,
    gl.created_by || null,
  ];
  if (book.kind === 'person') {
    db.prepare(`
      INSERT INTO person_ledger (person_id,date,entry_type,ref_type,ref_id,description,debit,credit,user_id)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(...args);
  } else if (book.kind === 'supplier') {
    db.prepare(`
      INSERT INTO supplier_ledger (supplier_id,date,entry_type,ref_type,ref_id,description,debit,credit,user_id)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(...args);
  } else {
    db.prepare(`
      INSERT INTO customer_ledger (customer_id,date,entry_type,ref_type,ref_id,description,debit,credit,user_id)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(...args);
  }
  book.rows.push({
    date: gl.date || '',
    entry_type: entryTypeFor(gl),
    ref_type: gl.ref_type || '',
    ref_id: gl.ref_id != null ? gl.ref_id : null,
    debit,
    credit,
  });
  book.used.add(book.rows.length - 1);
}

function glLinesFor(db, code, entryId) {
  if (!tableExists(db, 'journal_lines') || !tableExists(db, 'journal_entries')) return [];
  const params = [String(code)];
  let entrySql = '';
  if (entryId != null) {
    entrySql = ' AND je.id=?';
    params.push(Number(entryId));
  }
  return db.prepare(`
    SELECT je.id AS je_id, je.entry_date AS date, je.ref_type, je.ref_id,
           je.description AS je_desc, je.created_by AS created_by,
           jl.description AS line_desc,
           COALESCE(${SQL_JL_DEBIT_RIAL}, 0) AS debit,
           COALESCE(${SQL_JL_CREDIT_RIAL}, 0) AS credit
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.entry_id
    WHERE jl.account_code=? AND ${JE_ALIVE}${entrySql}
    ORDER BY je.id ASC, jl.id ASC
  `).all(...params).map((r) => ({
    date: r.date || '',
    ref_type: r.ref_type || '',
    ref_id: r.ref_id,
    je_desc: r.je_desc || '',
    line_desc: r.line_desc || '',
    created_by: r.created_by || null,
    debit: Math.round(Number(r.debit) || 0),
    credit: Math.round(Number(r.credit) || 0),
  })).filter((r) => r.debit || r.credit);
}

/**
 * @param {{requireExisting?: boolean}} opts
 * requireExisting: live post — copy only when some sibling already has the line.
 * Boot heal leaves it false so a GL line missing from every book is inserted too.
 */
function applyGlLines(db, books, glLines, opts) {
  const requireExisting = !!(opts && opts.requireExisting);
  let inserted = 0;
  for (const gl of glLines) {
    if (requireExisting && isOpeningToken(gl.ref_type)) continue;
    const missing = [];
    let any = false;
    for (const book of books) {
      const idx = findUnusedMatch(book, gl);
      if (idx >= 0) {
        book.used.add(idx);
        any = true;
      } else {
        missing.push(book);
      }
    }
    if (requireExisting && !any) continue;
    for (const book of missing) {
      insertBookRow(db, book, gl);
      inserted += 1;
    }
  }
  return inserted;
}

function leafCodes(db) {
  const codes = new Set();
  const pull = (sql) => {
    try {
      for (const r of db.prepare(sql).all()) {
        const c = r.coa_code ? String(r.coa_code).trim() : '';
        if (c) codes.add(c);
      }
    } catch (_) { /* optional */ }
  };
  pull("SELECT coa_code FROM parties WHERE COALESCE(coa_code,'')<>''");
  pull("SELECT coa_code FROM persons WHERE COALESCE(coa_code,'')<>''");
  pull("SELECT coa_code FROM suppliers WHERE COALESCE(coa_code,'')<>''");
  pull("SELECT coa_code FROM customers WHERE COALESCE(coa_code,'')<>''");
  return [...codes];
}

function backfillPartyLeafBooks(db) {
  let inserted = 0;
  let leaves = 0;
  if (!tableExists(db, 'parties')) return { inserted, leaves };
  for (const code of leafCodes(db)) {
    const partyId = uniquePartyForCode(db, code);
    if (!partyId) continue;
    const books = booksForPartyCode(db, partyId, code);
    if (books.length < 1) continue;
    const lines = glLinesFor(db, code, null);
    if (!lines.length) continue;
    const n = applyGlLines(db, books, lines, { requireExisting: false });
    if (n) {
      inserted += n;
      leaves += 1;
    }
  }
  return { inserted, leaves };
}

function syncJournalEntryToPartyBooks(db, entryId) {
  const id = Number(entryId);
  if (!id || !tableExists(db, 'journal_lines')) return { inserted: 0 };
  let inserted = 0;
  let codes = [];
  try {
    codes = db.prepare(`
      SELECT DISTINCT account_code AS code FROM journal_lines WHERE entry_id=?
    `).all(id).map((r) => (r.code ? String(r.code) : '')).filter(Boolean);
  } catch (_) {
    return { inserted: 0 };
  }
  for (const code of codes) {
    const partyId = uniquePartyForCode(db, code);
    if (!partyId) continue;
    const books = booksForPartyCode(db, partyId, code);
    if (books.length < 2) continue;
    const lines = glLinesFor(db, code, id);
    inserted += applyGlLines(db, books, lines, { requireExisting: true });
  }
  return { inserted };
}

/**
 * After a role book insert: copy that movement onto sibling books of the same leaf.
 * Openings are skipped (opening-post writes every linked book; the heal fills gaps).
 */
function afterPartyBookInsert(db, spec) {
  if (!spec || !spec.kind || !spec.entityId) return { copied: 0 };
  if (isOpeningToken(spec.ref_type, spec.entry_type)) return { copied: 0 };
  if (!tableExists(db, 'parties')) return { copied: 0 };
  const debit = Math.round(Number(spec.debit) || 0);
  const credit = Math.round(Number(spec.credit) || 0);
  if (!debit && !credit) return { copied: 0 };
  const table = spec.kind === 'person' ? 'persons' : (spec.kind === 'supplier' ? 'suppliers' : 'customers');
  if (!tableExists(db, table)) return { copied: 0 };
  const ent = db.prepare(`SELECT party_id, coa_code FROM ${table} WHERE id=?`).get(Number(spec.entityId));
  if (!ent || !ent.party_id) return { copied: 0 };
  const party = db.prepare('SELECT coa_code FROM parties WHERE id=?').get(Number(ent.party_id));
  const code = (ent.coa_code || (party && party.coa_code) || '').trim();
  if (!code) return { copied: 0 };
  if (uniquePartyForCode(db, code) !== Number(ent.party_id)) return { copied: 0 };
  const books = booksForPartyCode(db, Number(ent.party_id), code);
  if (books.length < 2) return { copied: 0 };
  const gl = {
    date: spec.date || '',
    ref_type: spec.ref_type || '',
    ref_id: spec.ref_id != null ? spec.ref_id : null,
    je_desc: spec.description || '',
    line_desc: spec.description || '',
    created_by: spec.user_id || null,
    debit,
    credit,
  };
  if (spec.kind === 'person') {
    try {
      const { personLedgerLineRial } = require('./person-ledger-money');
      const scaled = personLedgerLineRial(db, {
        debit, credit, ref_type: spec.ref_type, ref_id: spec.ref_id, entry_type: spec.entry_type,
      });
      gl.debit = scaled.debit;
      gl.credit = scaled.credit;
    } catch (_) { /* keep stored amount */ }
  }
  return { copied: applyGlLines(db, books, [gl], { requireExisting: true }) };
}

function alignPartyLeafBooksV456(db) {
  if (process.env.SYNC_ROLE === 'device') return { skipped: true, reason: 'device' };
  let flag = null;
  try {
    flag = db.prepare("SELECT value FROM settings WHERE key='party_leaf_books_align_v456'").get();
  } catch (_) {
    return { skipped: true, reason: 'no-settings' };
  }
  if (flag && String(flag.value) === '1') return { skipped: true };
  const result = db.transaction(() => backfillPartyLeafBooks(db))();
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('party_leaf_books_align_v456','1')").run();
  return result;
}

module.exports = {
  backfillPartyLeafBooks,
  syncJournalEntryToPartyBooks,
  afterPartyBookInsert,
  alignPartyLeafBooksV456,
};
