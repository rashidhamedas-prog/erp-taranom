'use strict';
/**
 * One COA leaf, one signed story — and the journal is the only author.
 *
 * When a party has several role books on the same leaf (person + supplier,
 * customer + supplier, …) every book must read like the GL leaf. v456 copied
 * each live GL line on the leaf into the sibling books that lacked it (insert-only).
 *
 * v519 — the sibling row is a *projection* of the journal, never a book of its own:
 *   - reconcileLeaf() matches live GL leaf lines ↔ book rows, inserts the missing
 *     mirror and retires the stale one (pre-amend amount, voided document,
 *     duplicate copy). Nothing is written to the journal.
 *   - A row is retired when it is foreign to its book (a purchase row inside a
 *     customer book, …), or a journal-anchored projection (manual_voucher) whose
 *     JE is dead **or alive only on another leaf** (v536: dual-role person
 *     payment must not inflate the customer AR book). Native rows belong to
 *     their own module and its R13 retire helpers; they are never deleted here.
 *   - Hooks: every post/rewrite (ledger.js), every role-book insert/update
 *     (afterPartyBookInsert), every void (void-journal.js), the books heal
 *     (ensureCustomerBooksRepaired) and boot run the same reconcile, so a
 *     one-sided mirror cannot survive to the dashboard.
 *
 * Payroll rows stored in toman stay put: a ref match covers the rial GL line,
 * so personLedgerLineRial keeps scaling them. Amounts on the journal are never rewritten.
 */

const { SQL_JL_DEBIT_RIAL, SQL_JL_CREDIT_RIAL } = require('./money');
const { personLedgerAliveSql } = require('./person-ledger-money');

const { JE_NOT_DRAFT } = require('./je-live');
const JE_ALIVE = `COALESCE(je.deleted_at,0)=0 AND COALESCE(je.status,'posted') NOT IN ('reversed','void') AND ${JE_NOT_DRAFT}`;

/** Document families and the role book that owns them. */
const SALES_REFS = [
  'invoice', 'invoice_payment', 'invoice_ar_reclass', 'ar_control_reclass',
  'settlement', 'pos_receipt', 'sales_return', 'sales_return_reversal',
  'store_sale', 'store_exchange', 'store_return',
];
const PURCHASE_REFS = [
  'purchase', 'purchase_invoice', 'purchase_return', 'purchase_return_reversal',
  'supplier_payment', 'fabric_roll',
];
const PERSON_REFS = [
  'payroll', 'payroll_payment', 'payroll_advance', 'payroll_loan', 'payroll_settlement',
  'production_labor', 'incentive_payment', 'rep_advance', 'rep_settlement',
];
/** ref_id is the journal entry id itself (self ref) — alive iff that JE is alive. */
const JOURNAL_ANCHORED_REFS = new Set(['manual_voucher']);

const FOREIGN_REFS = {
  customer: new Set([...PURCHASE_REFS, ...PERSON_REFS]),
  supplier: new Set([...SALES_REFS, ...PERSON_REFS]),
  person: new Set([...SALES_REFS, ...PURCHASE_REFS]),
};

const REF_FAMILY = {
  purchase_invoice: 'purchase',
  invoice_ar_reclass: 'invoice',
  invoice_payment: 'invoice',
};

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

function refFamily(refType) {
  const t = String(refType || '');
  if (isOpeningToken(t)) return 'opening';
  return REF_FAMILY[t] || t;
}

const SIDE_OF_REF = new Map([
  ...SALES_REFS.map((r) => [r, 'sales']),
  ...PURCHASE_REFS.map((r) => [r, 'purchase']),
  ...PERSON_REFS.map((r) => [r, 'person']),
]);

/** Business side of a document: a purchase line must never stand in for a sales receipt. */
function refSide(refType) {
  const t = String(refType || '');
  if (isOpeningToken(t)) return 'opening';
  return SIDE_OF_REF.get(t) || 'other';
}

function rowSign(row) {
  const d = Math.round(Number(row.debit) || 0);
  const c = Math.round(Number(row.credit) || 0);
  if (d && !c) return 'dr';
  if (c && !d) return 'cr';
  return 'mixed';
}

function sameRef(a, b) {
  const ida = a.ref_id != null && a.ref_id !== '' ? Number(a.ref_id) : 0;
  const idb = b.ref_id != null && b.ref_id !== '' ? Number(b.ref_id) : 0;
  if (!ida || !idb || ida !== idb) return false;
  return refFamily(a.ref_type) === refFamily(b.ref_type);
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

/** Pass 1 — same document (family + id) with the same rial amount, or an opening token. */
function findStrongMatch(book, gl) {
  const rows = book.rows;
  const used = book.used;
  const rid = gl.ref_id != null && gl.ref_id !== '' ? Number(gl.ref_id) : 0;
  if (gl.ref_type && rid) {
    for (let i = 0; i < rows.length; i++) {
      if (used.has(i)) continue;
      // Same ref can cover several JEs (e.g. two PRD-03 on one order):
      // only an amount match counts as covered.
      if (sameRef(rows[i], gl) && moneyClose(rows[i], gl)) return i;
    }
  }
  if (isOpeningToken(gl.ref_type)) {
    let any = -1;
    for (let i = 0; i < rows.length; i++) {
      if (used.has(i)) continue;
      if (!isOpeningToken(rows[i].ref_type, rows[i].entry_type)) continue;
      if (moneyClose(rows[i], gl)) return i;
      if (any < 0) any = i;
    }
    return any;
  }
  return -1;
}

/**
 * Pass 2 — legacy rows whose ref naming differs from the journal (invoice_payment
 * row ↔ settlement voucher): same day, same amount, same business side. A purchase
 * line cannot swallow a customer's settlement of the same amount.
 */
function findWeakMatch(book, gl) {
  const rows = book.rows;
  const used = book.used;
  const glSide = refSide(gl.ref_type);
  for (let i = 0; i < rows.length; i++) {
    if (used.has(i)) continue;
    const r = rows[i];
    if (String(r.date || '') !== String(gl.date || '') || !moneyClose(r, gl)) continue;
    const side = refSide(r.ref_type);
    if (side !== 'other' && glSide !== 'other' && side !== glSide) continue;
    return i;
  }
  return -1;
}

/**
 * Match every GL line against every book: strong matches for all lines first,
 * then the date+amount fallback for what is left. Marks book.used; returns
 * matched[gi][bi] = row index or -1.
 */
function matchBooks(books, glLines) {
  const matched = glLines.map(() => books.map(() => -1));
  for (const pass of ['strong', 'weak']) {
    for (let gi = 0; gi < glLines.length; gi++) {
      const gl = glLines[gi];
      for (let bi = 0; bi < books.length; bi++) {
        if (matched[gi][bi] >= 0) continue;
        const book = books[bi];
        const idx = pass === 'strong' ? findStrongMatch(book, gl) : findWeakMatch(book, gl);
        if (idx >= 0) {
          book.used.add(idx);
          matched[gi][bi] = idx;
        }
      }
    }
  }
  return matched;
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
      SELECT id, date, entry_type, ref_type, ref_id, description, debit, credit
      FROM person_ledger pl WHERE person_id=? AND ${alive}
      ORDER BY id ASC
    `).all(entityId);
  }
  const table = kind === 'supplier' ? 'supplier_ledger' : 'customer_ledger';
  const col = kind === 'supplier' ? 'supplier_id' : 'customer_id';
  return db.prepare(`
    SELECT id, date, entry_type, ref_type, ref_id, description, debit, credit
    FROM ${table} WHERE ${col}=?
    ORDER BY id ASC
  `).all(entityId);
}

function booksForPartyCode(db, partyId, code) {
  const books = [];
  const consider = (kind, table) => {
    if (!tableExists(db, table)) return;
    let entities = [];
    try {
      entities = db.prepare(`SELECT id, coa_code FROM ${table} WHERE party_id=?`).all(partyId);
    } catch (_) {
      return;
    }
    for (const ent of entities) {
      // v536: never inherit party.coa_code for an entity without its own leaf —
      // dual-role parties keep separate AR/AP/person leaves; falling back to the
      // header coa pulled person payments onto the customer AR book.
      const leaf = ent.coa_code ? String(ent.coa_code).trim() : '';
      if (!leaf || leaf !== String(code)) continue;
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
  consider('person', 'persons');
  consider('supplier', 'suppliers');
  consider('customer', 'customers');
  return books;
}

function bookTable(kind) {
  return kind === 'person' ? 'person_ledger' : (kind === 'supplier' ? 'supplier_ledger' : 'customer_ledger');
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
  let info;
  if (book.kind === 'person') {
    info = db.prepare(`
      INSERT INTO person_ledger (person_id,date,entry_type,ref_type,ref_id,description,debit,credit,user_id)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(...args);
  } else if (book.kind === 'supplier') {
    info = db.prepare(`
      INSERT INTO supplier_ledger (supplier_id,date,entry_type,ref_type,ref_id,description,debit,credit,user_id)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(...args);
  } else {
    info = db.prepare(`
      INSERT INTO customer_ledger (customer_id,date,entry_type,ref_type,ref_id,description,debit,credit,user_id)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(...args);
  }
  book.rows.push({
    id: info && info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null,
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
    je_id: r.je_id,
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

function journalEntryAlive(db, jeId) {
  const id = Number(jeId);
  if (!id || !tableExists(db, 'journal_entries')) return false;
  try {
    return !!db.prepare(`SELECT 1 FROM journal_entries je WHERE je.id=? AND ${JE_ALIVE}`).get(id);
  } catch (_) {
    return false;
  }
}

/** Live JE that actually posts a line on this leaf (not merely alive elsewhere). */
function journalEntryAliveOnLeaf(db, jeId, leafCode) {
  const id = Number(jeId);
  const code = leafCode != null ? String(leafCode).trim() : '';
  if (!id || !code || !tableExists(db, 'journal_entries') || !tableExists(db, 'journal_lines')) {
    return false;
  }
  try {
    return !!db.prepare(`
      SELECT 1 FROM journal_entries je
      JOIN journal_lines jl ON jl.entry_id = je.id
      WHERE je.id=? AND jl.account_code=? AND ${JE_ALIVE}
      LIMIT 1
    `).get(id, code);
  } catch (_) {
    return false;
  }
}

/**
 * Is the document itself still alive in the journal — on any account?
 * A payment to a party that reached another leaf of the same party (supplier
 * leaf vs person leaf) is a GL reclass question, not a stale projection.
 */
function documentAliveAnywhere(db, row) {
  const rid = row.ref_id != null && row.ref_id !== '' ? Number(row.ref_id) : 0;
  if (!rid || !tableExists(db, 'journal_entries')) return false;
  const fam = refFamily(row.ref_type);
  const types = Object.keys(REF_FAMILY).filter((k) => REF_FAMILY[k] === fam);
  types.push(fam, String(row.ref_type || ''));
  const uniq = [...new Set(types.filter(Boolean))];
  try {
    return !!db.prepare(`
      SELECT 1 FROM journal_entries je
      WHERE je.ref_id=? AND je.ref_type IN (${uniq.map(() => '?').join(',')}) AND ${JE_ALIVE}
      LIMIT 1
    `).get(rid, ...uniq);
  } catch (_) {
    return false;
  }
}

/** A row the book does not own: a projection of another role's document or of a voucher. */
function isProjectionRow(kind, row) {
  const rt = String(row.ref_type || '');
  if (JOURNAL_ANCHORED_REFS.has(rt)) return true;
  const set = FOREIGN_REFS[kind];
  return !!(set && set.has(rt));
}

function logRetire(db, book, row, info) {
  if (!tableExists(db, 'audit_log')) return;
  try {
    const detail = JSON.stringify({
      reason: info.reason || 'stale_projection',
      leaf: info.code || null,
      book: book.kind,
      entity_id: book.id,
      date: row.date || '',
      entry_type: row.entry_type || '',
      ref_type: row.ref_type || '',
      ref_id: row.ref_id != null ? row.ref_id : null,
      debit: Math.round(Number(row.debit) || 0),
      credit: Math.round(Number(row.credit) || 0),
      via: info.via || 'reconcile',
    });
    db.prepare(`
      INSERT INTO audit_log (user_id, action, entity, entity_id, detail, ip_address, user_agent)
      VALUES (?,?,?,?,?,?,?)
    `).run(info.userId || null, 'party_books_retire', bookTable(book.kind), row.id || null, detail, '', 'party-leaf-sync');
  } catch (_) { /* audit must never break the posting */ }
}

/** Same policy as party-ledger-retire: no hollow reverse row, the projection simply goes. */
function deleteBookRow(db, book, row) {
  if (!row || row.id == null) return 0;
  return Number(db.prepare(`DELETE FROM ${bookTable(book.kind)} WHERE id=?`).run(row.id).changes || 0);
}

/**
 * Retire unmatched projection rows.
 *   document_dead     — the document has no live journal entry at all (voided)
 *   superseded_amount — the document is alive on this leaf with another amount and
 *                       this book already carries the current one (pre-amend leftover
 *                       or duplicate copy)
 * Kept on purpose: a projection whose document is alive but whose current amount has
 * not reached this book yet (amend in flight — the follow-up hook retires it), and a
 * non-voucher projection whose journal entry is alive on another leaf of the same
 * party (supplier_payment on person book — GL reclass, never a silent delete).
 * Journal-anchored rows (manual_voucher) MUST post on this leaf; otherwise they are
 * cross-leaf pollution (v536 dual-role person payment → customer AR).
 */
function retireUnmatched(db, books, glLines, info) {
  let retired = 0;
  const actions = [];
  const leaf = info && info.code != null ? String(info.code) : '';
  for (const book of books) {
    for (let i = 0; i < book.rows.length; i++) {
      if (book.used.has(i)) continue;
      const row = book.rows[i];
      if (!row || row.id == null) continue;
      if (!isProjectionRow(book.kind, row)) continue;
      let reason;
      if (JOURNAL_ANCHORED_REFS.has(String(row.ref_type || ''))) {
        if (leaf && journalEntryAliveOnLeaf(db, row.ref_id, leaf)) continue;
        if (!leaf && journalEntryAlive(db, row.ref_id)) continue;
        reason = journalEntryAlive(db, row.ref_id) ? 'wrong_leaf' : 'journal_dead';
      } else {
        const refLive = glLines.some((gl) => sameRef(gl, row));
        if (!refLive) {
          if (documentAliveAnywhere(db, row)) continue;
          reason = 'document_dead';
        } else {
          // Same document, same side, another amount already matched → pre-amend leftover.
          // (An invoice debit never supersedes its own payment credit.)
          const sign = rowSign(row);
          const current = book.rows.some((r, j) => j !== i && book.used.has(j) && sameRef(r, row) && rowSign(r) === sign);
          if (!current) continue;
          reason = 'superseded_amount';
        }
      }
      actions.push({
        book: book.kind, entity_id: book.id, row_id: row.id, reason,
        ref_type: row.ref_type, ref_id: row.ref_id, debit: row.debit, credit: row.credit, date: row.date,
      });
      if (info.dryRun) continue;
      logRetire(db, book, row, { ...info, reason });
      retired += deleteBookRow(db, book, row);
    }
  }
  return { retired, actions };
}

/**
 * Insert the GL lines a book lacks.
 *   'siblings' — only when some sibling book already carries the line (live posts,
 *                continuous heal: never invent a native-looking row from the journal alone)
 *   'all'      — every live GL leaf line (v456 one-shot backfill)
 *   'none'     — match only
 */
function applyGlLines(db, books, glLines, opts) {
  const mode = opts && opts.insert ? opts.insert : ((opts && opts.requireExisting) ? 'siblings' : 'all');
  const matched = matchBooks(books, glLines);
  let inserted = 0;
  const actions = [];
  if (mode === 'none') return { inserted, actions, matched };
  for (let gi = 0; gi < glLines.length; gi++) {
    const gl = glLines[gi];
    if (mode === 'siblings' && isOpeningToken(gl.ref_type)) continue;
    const any = matched[gi].some((idx) => idx >= 0);
    if (mode === 'siblings' && !any) continue;
    for (let bi = 0; bi < books.length; bi++) {
      if (matched[gi][bi] >= 0) continue;
      const book = books[bi];
      actions.push({
        book: book.kind, entity_id: book.id, je_id: gl.je_id || null,
        ref_type: gl.ref_type, ref_id: gl.ref_id, debit: gl.debit, credit: gl.credit, date: gl.date,
      });
      if (opts && opts.dryRun) continue;
      insertBookRow(db, book, gl);
      matched[gi][bi] = book.rows.length - 1;
      inserted += 1;
    }
  }
  return { inserted, actions, matched };
}

function scopeFilter(scope) {
  if (!scope || !scope.ref_type || !(Number(scope.ref_id) > 0)) return null;
  const probe = { ref_type: scope.ref_type, ref_id: Number(scope.ref_id) };
  return (row) => sameRef(row, probe);
}

/**
 * Reconcile every role book on one leaf against the live journal.
 * @param {object} opts
 *   insert: 'siblings' | 'all' | 'none'   (default 'siblings')
 *   scope:  {ref_type, ref_id}            only that document (hooks)
 *   dryRun: boolean                       plan only
 *   reason / via / userId                 audit detail
 */
function reconcileLeaf(db, code, opts) {
  const o = opts || {};
  const out = { code: String(code), inserted: 0, retired: 0, books: 0, actions: { inserted: [], retired: [] } };
  if (!code || !tableExists(db, 'parties')) return out;
  const partyId = o.partyId || uniquePartyForCode(db, code);
  if (!partyId) return out;
  let books = booksForPartyCode(db, partyId, code);
  if (!books.length) return out;
  const filter = scopeFilter(o.scope);
  if (filter) {
    books = books.map((b) => ({ ...b, rows: b.rows.filter(filter), used: new Set() }));
  }
  out.books = books.length;
  let glLines = glLinesFor(db, code, null);
  if (filter) glLines = glLines.filter(filter);
  const insertMode = o.insert || 'siblings';
  // A single book has no sibling to copy from or to; only dead/journal rows are judged.
  const effectiveInsert = books.length < 2 && insertMode === 'siblings' ? 'none' : insertMode;
  const applied = applyGlLines(db, books, glLines, { insert: effectiveInsert, dryRun: !!o.dryRun });
  out.inserted = applied.inserted;
  out.actions.inserted = applied.actions;
  const info = { code: String(code), reason: o.reason, via: o.via, userId: o.userId, dryRun: !!o.dryRun };
  const ret = retireUnmatched(db, books, glLines, info);
  out.retired = ret.retired;
  out.actions.retired = ret.actions;
  return out;
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

/**
 * Count role entities that explicitly own each leaf (no party.coa fallback — v536).
 * shared = 2+ roles on the same code (sibling mirrors). any = ≥1 (solo heal for wrong_leaf).
 */
function leafRoleCounts(db) {
  const kindsByCode = new Map();
  if (!tableExists(db, 'parties')) return kindsByCode;
  const scan = (table) => {
    if (!tableExists(db, table)) return;
    let rows = [];
    try {
      rows = db.prepare(`
        SELECT coa_code FROM ${table}
        WHERE party_id IS NOT NULL AND COALESCE(coa_code,'')<>''
      `).all();
    } catch (_) {
      return;
    }
    for (const r of rows) {
      const code = String(r.coa_code).trim();
      if (!code) continue;
      kindsByCode.set(code, (kindsByCode.get(code) || 0) + 1);
    }
  };
  scan('persons');
  scan('suppliers');
  scan('customers');
  return kindsByCode;
}

/** Leaves carrying more than one role book (sibling mirrors). */
function sharedLeafCodes(db) {
  return [...leafRoleCounts(db).entries()].filter(([, n]) => n > 1).map(([code]) => code);
}

/** Every leaf owned by at least one role book — continuous heal retires wrong_leaf here. */
function roleBookLeafCodes(db) {
  return [...leafRoleCounts(db).keys()];
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
    const n = applyGlLines(db, books, lines, { insert: 'all' }).inserted;
    if (n) {
      inserted += n;
      leaves += 1;
    }
  }
  return { inserted, leaves };
}

/**
 * Continuous reconcile of party role leaves (boot + books heal).
 * Default = every leaf with ≥1 role book (v536: solo AR must retire cross-leaf
 * manual_voucher pollution). Pass sharedOnly:true for the pre-v536 scope.
 * Central only — devices receive the result through sync tombstones.
 */
function reconcileAllPartyLeafBooks(db, opts) {
  const o = opts || {};
  if (process.env.SYNC_ROLE === 'device' && !o.force) return { skipped: true, reason: 'device' };
  if (!tableExists(db, 'parties')) return { skipped: true, reason: 'no-parties' };
  const codes = o.allLeaves
    ? leafCodes(db)
    : (o.sharedOnly ? sharedLeafCodes(db) : roleBookLeafCodes(db));
  const summary = { leaves: 0, inserted: 0, retired: 0, actions: [] };
  const run = () => {
    for (const code of codes) {
      const r = reconcileLeaf(db, code, {
        insert: o.insert || 'siblings',
        dryRun: !!o.dryRun,
        reason: o.reason || 'reconcile',
        via: o.via || 'reconcile_all',
      });
      if (r.inserted || r.retired || r.actions.inserted.length || r.actions.retired.length) {
        summary.leaves += 1;
        summary.inserted += r.inserted;
        summary.retired += r.retired;
        if (o.dryRun || o.collect) summary.actions.push(r);
      }
    }
  };
  if (o.dryRun) run();
  else db.transaction(run)();
  return summary;
}

/** Leaf codes touched by a journal entry that belong to a party. */
function partyCodesForEntry(db, entryId) {
  const id = Number(entryId);
  if (!id || !tableExists(db, 'journal_lines')) return [];
  try {
    return db.prepare(`
      SELECT DISTINCT account_code AS code FROM journal_lines WHERE entry_id=?
    `).all(id).map((r) => (r.code ? String(r.code) : '')).filter(Boolean);
  } catch (_) {
    return [];
  }
}

function entryHead(db, entryId) {
  try {
    return db.prepare('SELECT id, ref_type, ref_id FROM journal_entries WHERE id=?').get(Number(entryId)) || null;
  } catch (_) {
    return null;
  }
}

function scopeForHead(head) {
  if (!head) return null;
  const rt = String(head.ref_type || '');
  if (!rt) return null;
  const rid = JOURNAL_ANCHORED_REFS.has(rt) ? Number(head.ref_id || head.id) : Number(head.ref_id);
  if (!(rid > 0)) return null;
  return { ref_type: rt, ref_id: rid };
}

/**
 * After post / rewrite (ledger.js): copy the new line onto sibling books and
 * retire the projection the rewrite left behind.
 */
function syncJournalEntryToPartyBooks(db, entryId) {
  const id = Number(entryId);
  if (!id || !tableExists(db, 'journal_lines')) return { inserted: 0, retired: 0 };
  let inserted = 0;
  let retired = 0;
  const codes = partyCodesForEntry(db, id);
  const scope = scopeForHead(entryHead(db, id));
  for (const code of codes) {
    const partyId = uniquePartyForCode(db, code);
    if (!partyId) continue;
    if (scope) {
      // Every live JE of that document on this leaf, every book: copy + retire.
      const r = reconcileLeaf(db, code, { partyId, scope, insert: 'siblings', reason: 'journal_post', via: 'sync_journal' });
      inserted += r.inserted;
      retired += r.retired;
      continue;
    }
    const books = booksForPartyCode(db, partyId, code);
    if (books.length < 2) continue;
    const lines = glLinesFor(db, code, id);
    inserted += applyGlLines(db, books, lines, { insert: 'siblings' }).inserted;
  }
  return { inserted, retired };
}

/**
 * After a void / hard delete (void-journal.js): the document's projections on
 * every party leaf of that entry must go — unless another live JE still carries them.
 */
function retireProjectionsForJournalEntry(db, entryId, head, codes) {
  const id = Number(entryId);
  if (!id) return { retired: 0 };
  const h = head || entryHead(db, id);
  const scope = scopeForHead(h);
  if (!scope) return { retired: 0 };
  const leafList = Array.isArray(codes) && codes.length ? codes : partyCodesForEntry(db, id);
  let retired = 0;
  for (const code of leafList) {
    const partyId = uniquePartyForCode(db, code);
    if (!partyId) continue;
    const r = reconcileLeaf(db, code, { partyId, scope, insert: 'none', reason: 'journal_void', via: 'void_journal' });
    retired += r.retired;
  }
  return { retired };
}

/**
 * After a role book insert/update: copy that movement onto sibling books of the
 * same leaf and retire the sibling projection it supersedes.
 * Openings are skipped (opening-post writes every linked book; the heal fills gaps).
 */
function afterPartyBookInsert(db, spec) {
  if (!spec || !spec.kind || !spec.entityId) return { copied: 0, retired: 0 };
  if (isOpeningToken(spec.ref_type, spec.entry_type)) return { copied: 0, retired: 0 };
  if (!tableExists(db, 'parties')) return { copied: 0, retired: 0 };
  const debit = Math.round(Number(spec.debit) || 0);
  const credit = Math.round(Number(spec.credit) || 0);
  const table = spec.kind === 'person' ? 'persons' : (spec.kind === 'supplier' ? 'suppliers' : 'customers');
  if (!tableExists(db, table)) return { copied: 0, retired: 0 };
  const ent = db.prepare(`SELECT party_id, coa_code FROM ${table} WHERE id=?`).get(Number(spec.entityId));
  if (!ent || !ent.party_id) return { copied: 0, retired: 0 };
  // v536: require the entity's own leaf — do not fall back to parties.coa_code
  // (dual-role header often points at AR while person payments live on 1106…).
  const code = (ent.coa_code || '').trim();
  if (!code) return { copied: 0, retired: 0 };
  if (uniquePartyForCode(db, code) !== Number(ent.party_id)) return { copied: 0, retired: 0 };
  const books = booksForPartyCode(db, Number(ent.party_id), code);
  if (books.length < 2) return { copied: 0, retired: 0 };
  let copied = 0;
  if (debit || credit) {
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
    copied = applyGlLines(db, books, [gl], { insert: 'siblings' }).inserted;
  }
  let retired = 0;
  const scope = spec.ref_type && Number(spec.ref_id) > 0 ? { ref_type: spec.ref_type, ref_id: Number(spec.ref_id) } : null;
  if (scope) {
    retired = reconcileLeaf(db, code, {
      partyId: Number(ent.party_id), scope, insert: 'siblings', reason: 'book_write', via: 'after_book_write', userId: spec.user_id || null,
    }).retired;
  }
  return { copied, retired };
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
  reconcileLeaf,
  reconcileAllPartyLeafBooks,
  retireProjectionsForJournalEntry,
  sharedLeafCodes,
  roleBookLeafCodes,
  booksForPartyCode,
  journalEntryAliveOnLeaf,
  isProjectionRow,
  FOREIGN_REFS,
  JOURNAL_ANCHORED_REFS,
};
