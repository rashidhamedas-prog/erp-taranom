/**
 * Opening / beginning-balance journal helpers.
 * Used by parties, products, warehouse receipts, cheques — including Excel import.
 */
const { postToLedger, rewriteJournalEntry } = require('./ledger');
const { acct } = require('./coa-map');
const { rialToLedger, SQL_JL_DEBIT_RIAL, SQL_JL_CREDIT_RIAL } = require('./money');
const { todayJalali } = require('../jalali');
const { getActiveFiscalYear } = require('./fiscal-period');

function parseRoles(partyRoles, partyType) {
  let roles = [];
  try {
    roles = typeof partyRoles === 'string' ? JSON.parse(partyRoles || '[]') : (partyRoles || []);
  } catch (_) { roles = []; }
  if (!roles.length && partyType) {
    if (partyType === 'both') roles = ['customer', 'supplier'];
    else if (partyType) roles = [partyType];
  }
  return Array.isArray(roles) ? roles : [];
}

function controlAccountForParty(db, party) {
  const roles = parseRoles(party.party_roles, party.party_type);
  const nature = String(party.account_nature || '').toLowerCase();
  if (roles.includes('supplier') && !roles.includes('customer')) return acct(db, 'coa_payable');
  if (nature === 'credit' || nature === 'بستانکار') return acct(db, 'coa_payable');
  if (roles.includes('customer') || nature === 'debit' || nature === 'بدهکار') return acct(db, 'coa_receivable');
  if (roles.includes('supplier')) return acct(db, 'coa_payable');
  return acct(db, 'coa_misc_persons');
}

function fiscalOpeningDate(db) {
  const fy = getActiveFiscalYear(db);
  return (fy && fy.start_date) || todayJalali();
}

function resolvePartyControlAccount(db, party) {
  let control = controlAccountForParty(db, party);
  if (party.legacy_table === 'customers' && party.legacy_id) {
    const c = db.prepare('SELECT coa_code FROM customers WHERE id=?').get(party.legacy_id);
    if (c?.coa_code) {
      const tafsili = db.prepare('SELECT code,name FROM chart_of_accounts WHERE code=?').get(c.coa_code);
      if (tafsili) control = tafsili;
    }
  } else if (party.coa_code) {
    const tafsili = db.prepare('SELECT code,name FROM chart_of_accounts WHERE code=?').get(party.coa_code);
    if (tafsili) control = tafsili;
  }
  return control;
}

function partyOpeningLines(db, party, amtRial) {
  const amt = Math.round(Number(amtRial) || 0);
  const control = resolvePartyControlAccount(db, party);
  const opening = acct(db, 'coa_opening_balance');
  const absToman = rialToLedger(Math.abs(amt));
  return amt > 0
    ? [
      { code: control.code, name: control.name, debit: absToman, credit: 0 },
      { code: opening.code, name: opening.name, debit: 0, credit: absToman },
    ]
    : [
      { code: opening.code, name: opening.name, debit: absToman, credit: 0 },
      { code: control.code, name: control.name, debit: 0, credit: absToman },
    ];
}

function livePartyOpeningJeId(db, partyId) {
  const existing = db.prepare(`
    SELECT id FROM journal_entries
    WHERE ref_type='opening_balance' AND ref_id=?
      AND COALESCE(deleted_at,0)=0
      AND COALESCE(status,'posted') NOT IN ('reversed','void')
    ORDER BY id ASC
    LIMIT 1
  `).get(partyId);
  return existing ? existing.id : null;
}

function partyOpeningSideMatches(db, jeId, amtRial) {
  const amt = Math.round(Number(amtRial) || 0);
  if (!amt) return false;
  const opening = acct(db, 'coa_opening_balance');
  const line = db.prepare(`
    SELECT COALESCE(SUM(${SQL_JL_DEBIT_RIAL}),0) AS d,
           COALESCE(SUM(${SQL_JL_CREDIT_RIAL}),0) AS c
    FROM journal_lines jl
    WHERE jl.entry_id=? AND jl.account_code=?
  `).get(jeId, opening.code);
  const openDebit = Math.round(Number(line && line.d) || 0);
  const openCredit = Math.round(Number(line && line.c) || 0);
  // amt>0 → party owes us → opening is credit; amt<0 → we owe → opening is debit
  if (amt > 0) return openCredit > 0 && openDebit === 0;
  return openDebit > 0 && openCredit === 0;
}

function partyCustomerIds(db, party) {
  const custIds = new Set();
  if (party && party.legacy_table === 'customers' && party.legacy_id) custIds.add(Number(party.legacy_id));
  if (party && party.id) {
    try {
      for (const r of db.prepare('SELECT id FROM customers WHERE party_id=?').all(party.id)) {
        custIds.add(Number(r.id));
      }
    } catch (_) { /* */ }
  }
  const phone = String(party && party.phone || '').trim();
  if (phone && party && party.id) {
    try {
      const loose = db.prepare(`
        SELECT id FROM customers
        WHERE phone=? AND (party_id IS NULL OR party_id=0 OR party_id=?)
      `).all(phone, party.id);
      for (const r of loose) {
        db.prepare(`
          UPDATE customers SET party_id=?
          WHERE id=? AND (party_id IS NULL OR party_id=0 OR party_id=?)
        `).run(party.id, r.id, party.id);
        custIds.add(Number(r.id));
      }
    } catch (_) { /* */ }
  }
  return [...custIds].filter((id) => Number.isFinite(id));
}

function refreshCustomerBalanceFromLedger(db, customerId) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(COALESCE(debit,0) - COALESCE(credit,0)),0) AS b
    FROM customer_ledger WHERE customer_id=?
  `).get(customerId);
  db.prepare('UPDATE customers SET balance=? WHERE id=?')
    .run(Math.round(Number(row && row.b) || 0), customerId);
}

/**
 * Live opening journals for one party.
 * CRITICAL: never mix party.id and customer.id in one IN() on ref_id —
 * those namespaces collide (e.g. party 26 تجری vs customer 26 افروز).
 * opening_balance / opening_reclass → party.id only;
 * opening / opening_ledger → customer ids only (legacy CRM path).
 */
function collectPartyOpeningJournalIds(db, party) {
  const ids = new Set();
  const pid = Number(party && party.id);
  if (Number.isFinite(pid) && pid > 0) {
    for (const r of db.prepare(`
      SELECT id FROM journal_entries
      WHERE ref_type IN ('opening_balance','opening_reclass')
        AND ref_id=?
        AND COALESCE(deleted_at,0)=0
        AND COALESCE(status,'posted') NOT IN ('reversed','void')
      ORDER BY id ASC
    `).all(pid)) {
      ids.add(Number(r.id));
    }
  }
  const custIds = partyCustomerIds(db, party)
    .filter((id) => Number.isFinite(id) && id > 0);
  if (custIds.length) {
    const marks = custIds.map(() => '?').join(',');
    for (const r of db.prepare(`
      SELECT id FROM journal_entries
      WHERE ref_type IN ('opening','opening_ledger')
        AND ref_id IN (${marks})
        AND COALESCE(deleted_at,0)=0
        AND COALESCE(status,'posted') NOT IN ('reversed','void')
      ORDER BY id ASC
    `).all(...custIds)) {
      ids.add(Number(r.id));
    }
  }
  return [...ids].sort((a, b) => a - b);
}

function retireOtherPartyOpenings(db, party, keepId, userId) {
  const { reverseJournalEntry } = require('./void-journal');
  const keep = Number(keepId) || 0;
  for (const id of collectPartyOpeningJournalIds(db, party)) {
    if (Number(id) === keep) continue;
    reverseJournalEntry(db, id, {
      userId: userId || 1,
      reason: `جمع شدن سند تکراری مانده اول دوره — ${party.full_name || party.biz || party.id}`,
      sourceType: 'opening_balance_reversal',
    });
  }
  if (!keep || !party.coa_code) return;
  const onTafsili = db.prepare(
    'SELECT 1 FROM journal_lines WHERE entry_id=? AND account_code=?'
  ).get(keep, party.coa_code);
  if (!onTafsili) return;
  const reclasses = db.prepare(`
    SELECT id FROM journal_entries
    WHERE ref_type='opening_reclass' AND ref_id=?
      AND COALESCE(deleted_at,0)=0
      AND COALESCE(status,'posted') NOT IN ('reversed','void')
  `).all(keep);
  for (const row of reclasses) {
    reverseJournalEntry(db, row.id, {
      userId: userId || 1,
      reason: 'انتقال افتتاحیه داخل همان سند مانده اول دوره نشست',
      sourceType: 'opening_balance_reversal',
    });
  }
}

/** Party opening mirror on the customer book. Both ref types: repair copies the JE as opening_balance. */
function deleteCustomerOpeningMirrors(db, customerId) {
  return db.prepare(`
    DELETE FROM customer_ledger
    WHERE customer_id=?
      AND LOWER(COALESCE(ref_type,'')) IN ('opening','opening_balance')
  `).run(customerId).changes;
}

function clearPartyOpeningSubledgers(db, partyId) {
  const party = db.prepare('SELECT * FROM parties WHERE id=?').get(partyId);
  if (!party) return;

  for (const cid of partyCustomerIds(db, party)) {
    try { deleteCustomerOpeningMirrors(db, cid); } catch (_) { /* */ }
    try { refreshCustomerBalanceFromLedger(db, cid); } catch (_) { /* */ }
  }

  const personIds = new Set();
  if (party.legacy_table === 'persons' && party.legacy_id) personIds.add(Number(party.legacy_id));
  try {
    for (const r of db.prepare('SELECT id FROM persons WHERE party_id=?').all(partyId)) {
      personIds.add(Number(r.id));
    }
  } catch (_) { /* */ }
  for (const peid of personIds) {
    if (!Number.isFinite(peid)) continue;
    try {
      db.prepare(`
        DELETE FROM person_ledger
        WHERE person_id=? AND (
          LOWER(COALESCE(ref_type,'')) IN ('opening','opening_balance')
          OR LOWER(COALESCE(entry_type,'')) IN ('opening','opening_balance')
        )
      `).run(peid);
    } catch (_) { /* */ }
  }

  try {
    for (const s of db.prepare('SELECT id FROM suppliers WHERE party_id=?').all(partyId)) {
      const sid = Number(s.id);
      if (!Number.isFinite(sid)) continue;
      db.prepare(`
        DELETE FROM supplier_ledger
        WHERE supplier_id=? AND (
          LOWER(COALESCE(ref_type,'')) IN ('opening','opening_balance')
          OR LOWER(COALESCE(entry_type,'')) IN ('opening','opening_balance')
        )
      `).run(sid);
      db.prepare('UPDATE suppliers SET balance=0 WHERE id=?').run(sid);
    }
  } catch (_) { /* */ }
}

/**
 * Which role books should carry the header opening mirror.
 * JE only hits resolvePartyControlAccount (usually party.coa_code) — mirroring
 * the same amount onto BOTH customer AR and supplier AP doubles net books and
 * makes گردش «تطبیق با دفتر زنده» show 2× opening (Ebrahimi / v507).
 */
function partyOpeningMirrorTargets(db, party) {
  const control = resolvePartyControlAccount(db, party);
  const controlCode = String((control && control.code) || party.coa_code || '').trim();
  const out = { customer: false, supplier: false, person: false, controlCode };
  if (!controlCode) {
    // No leaf: prefer customer if linked, else supplier, else person.
    out.customer = partyCustomerIds(db, party).length > 0;
    if (!out.customer) {
      try {
        out.supplier = !!(db.prepare('SELECT 1 FROM suppliers WHERE party_id=? LIMIT 1').get(party.id));
      } catch (_) { /* */ }
    }
    if (!out.customer && !out.supplier) out.person = true;
    return out;
  }
  const isAr = /^1103/.test(controlCode);
  const isAp = /^2101/.test(controlCode);
  const isPerson = /^1106/.test(controlCode);
  if (isAr) out.customer = true;
  else if (isAp) out.supplier = true;
  else if (isPerson) out.person = true;
  else {
    // Match linked entity whose coa equals control
    try {
      const c = db.prepare(
        'SELECT 1 AS ok FROM customers WHERE party_id=? AND coa_code=? LIMIT 1'
      ).get(party.id, controlCode);
      if (c) out.customer = true;
    } catch (_) { /* */ }
    try {
      const s = db.prepare(
        'SELECT 1 AS ok FROM suppliers WHERE party_id=? AND coa_code=? LIMIT 1'
      ).get(party.id, controlCode);
      if (s) out.supplier = true;
    } catch (_) { /* */ }
    try {
      const pe = db.prepare(
        'SELECT 1 AS ok FROM persons WHERE party_id=? AND coa_code=? LIMIT 1'
      ).get(party.id, controlCode);
      if (pe) out.person = true;
    } catch (_) { /* */ }
    if (!out.customer && !out.supplier && !out.person) {
      if (isAr || controlCode.startsWith('11')) out.customer = true;
      else if (isAp || controlCode.startsWith('21')) out.supplier = true;
      else out.person = true;
    }
  }
  // Person book only when that person shares the JE leaf (never every linked person).
  if (!out.person && (out.customer || out.supplier)) {
    try {
      const pe = db.prepare(
        'SELECT 1 AS ok FROM persons WHERE party_id=? AND coa_code=? LIMIT 1'
      ).get(party.id, controlCode);
      if (pe) out.person = true;
    } catch (_) { /* */ }
  }
  return out;
}

function mirrorPartyOpeningSubledgers(db, {
  partyId, entryId, amtRial, openDate, userId, description,
}) {
  const party = db.prepare('SELECT * FROM parties WHERE id=?').get(partyId);
  if (!party || !entryId) return;
  const amt = Math.round(Number(amtRial) || 0);
  if (!amt) {
    clearPartyOpeningSubledgers(db, partyId);
    return;
  }

  // Always clear every role mirror first, then rewrite only the JE leaf — stops
  // dual-role AR+AP double openings from a prior buggy mirror.
  clearPartyOpeningSubledgers(db, partyId);

  const targets = partyOpeningMirrorTargets(db, party);
  const { createLedgerEntry, createPersonLedgerEntry } = require('../db');
  const debit = amt > 0 ? Math.abs(amt) : 0;
  const credit = amt < 0 ? Math.abs(amt) : 0;
  const desc = description || 'مانده اول دوره';

  if (targets.customer) {
    for (const cid of partyCustomerIds(db, party)) {
      createLedgerEntry(db, {
        customer_id: cid, date: openDate, entry_type: 'opening',
        ref_type: 'opening', ref_id: entryId,
        description: 'مانده اولیه حساب', debit, credit, user_id: userId,
      });
      refreshCustomerBalanceFromLedger(db, cid);
    }
  }

  if (targets.person) {
    const personIds = new Set();
    if (party.legacy_table === 'persons' && party.legacy_id) personIds.add(Number(party.legacy_id));
    try {
      const q = targets.controlCode
        ? db.prepare('SELECT id FROM persons WHERE party_id=? AND coa_code=?')
        : db.prepare('SELECT id FROM persons WHERE party_id=?');
      const rows = targets.controlCode
        ? q.all(partyId, targets.controlCode)
        : q.all(partyId);
      for (const r of rows) personIds.add(Number(r.id));
    } catch (_) { /* */ }
    for (const peid of personIds) {
      if (!Number.isFinite(peid)) continue;
      createPersonLedgerEntry(db, {
        person_id: peid, date: openDate, entry_type: 'opening',
        ref_type: 'opening_balance', ref_id: entryId,
        description: desc, debit, credit, user_id: userId,
      });
    }
  }

  if (targets.supplier) {
    try {
      const supRows = db.prepare('SELECT id FROM suppliers WHERE party_id=?').all(partyId);
      for (const s of supRows) {
        const sid = Number(s.id);
        if (!Number.isFinite(sid)) continue;
        const sDebit = amt > 0 ? Math.abs(amt) : 0;
        const sCredit = amt < 0 ? Math.abs(amt) : 0;
        db.prepare(`
          INSERT INTO supplier_ledger
            (supplier_id,date,entry_type,ref_type,ref_id,description,debit,credit,user_id)
          VALUES (?,?,?,?,?,?,?,?,?)
        `).run(
          sid, openDate, 'opening', 'opening_balance', entryId,
          desc, sDebit, sCredit, userId || 1
        );
        db.prepare('UPDATE suppliers SET balance=? WHERE id=?').run(amt < 0 ? Math.abs(amt) : 0, sid);
      }
    } catch (_) { /* supplier_ledger optional */ }
  }
}

function _purgeRoleOpeningMirror(db, role, entityId) {
  if (role === 'supplier') {
    db.prepare(`
      DELETE FROM supplier_ledger
      WHERE supplier_id=? AND LOWER(IFNULL(ref_type,'')) IN ('opening','opening_balance')
    `).run(entityId);
    const bal = db.prepare(`
      SELECT COALESCE(SUM(debit-credit),0) b FROM supplier_ledger WHERE supplier_id=?
    `).get(entityId);
    // suppliers.balance > 0 ⇒ we owe them
    const signed = Math.round(Number(bal && bal.b) || 0);
    db.prepare('UPDATE suppliers SET balance=? WHERE id=?')
      .run(signed < 0 ? Math.abs(signed) : 0, entityId);
    return;
  }
  if (role === 'customer') {
    db.prepare(`
      DELETE FROM customer_ledger
      WHERE customer_id=? AND LOWER(IFNULL(ref_type,'')) IN ('opening','opening_balance')
    `).run(entityId);
    refreshCustomerBalanceFromLedger(db, entityId);
  }
}

/**
 * Retire same-amount opening mirrors on non-JE role leaves (dual-role double).
 * Keep only the leaf matching party.coa_code / control; when control is person
 * (1106), drop BOTH customer and supplier opening mirrors of the header amount.
 */
function retireDuplicateRoleOpeningMirrors(db, { apply = false, partyId = null } = {}) {
  if (process.env.SYNC_ROLE === 'device') {
    return { skipped: true, reason: 'device', candidates: 0, retired: 0, items: [] };
  }
  const pidFilter = partyId != null && Number(partyId) > 0
    ? ' AND p.id=' + parseInt(partyId, 10)
    : '';
  const rows = db.prepare(`
    SELECT p.id AS party_id, p.full_name, p.coa_code, p.opening_balance,
      c.id AS cust_id, s.id AS sup_id,
      (SELECT COALESCE(SUM(ABS(credit)+ABS(debit)),0) FROM customer_ledger
        WHERE customer_id=c.id
          AND LOWER(IFNULL(ref_type,'')) IN ('opening','opening_balance')) AS cust_open_abs,
      (SELECT COALESCE(SUM(ABS(credit)+ABS(debit)),0) FROM supplier_ledger
        WHERE supplier_id=s.id
          AND LOWER(IFNULL(ref_type,'')) IN ('opening','opening_balance')) AS sup_open_abs
    FROM parties p
    JOIN customers c ON c.party_id = p.id
    JOIN suppliers s ON s.party_id = p.id
    WHERE ABS(COALESCE(p.opening_balance,0)) > 0
      ${pidFilter}
  `).all();

  const items = [];
  let retired = 0;
  for (const r of rows) {
    const headerAbs = Math.abs(Math.round(Number(r.opening_balance) || 0));
    const custAbs = Math.abs(Math.round(Number(r.cust_open_abs) || 0));
    const supAbs = Math.abs(Math.round(Number(r.sup_open_abs) || 0));
    if (!custAbs && !supAbs) continue;
    // At least one role mirror matches header; classic bug has BOTH.
    const custMatches = custAbs > 0 && Math.abs(custAbs - headerAbs) <= 2;
    const supMatches = supAbs > 0 && Math.abs(supAbs - headerAbs) <= 2;
    if (!custMatches && !supMatches) continue;
    if (!(custMatches && supMatches) && !(custAbs && supAbs && Math.abs(custAbs - supAbs) <= 2)) {
      // Single-role mirror that matches header is healthy — leave it.
      // Only heal when both roles carry an opening (double) OR both match header.
      if (!(custAbs && supAbs)) continue;
      if (Math.abs(custAbs - supAbs) > 2) continue;
    }
    const targets = partyOpeningMirrorTargets(db, {
      id: r.party_id, coa_code: r.coa_code, full_name: r.full_name,
    });
    const drops = [];
    if (targets.person && !targets.customer && !targets.supplier) {
      if (custAbs) drops.push('customer');
      if (supAbs) drops.push('supplier');
    } else if (targets.customer && !targets.supplier) {
      if (supAbs) drops.push('supplier');
    } else if (targets.supplier && !targets.customer) {
      if (custAbs) drops.push('customer');
    } else if (targets.customer && targets.supplier) {
      // Ambiguous — keep the leaf whose abs matches header; drop the other.
      drops.push(custMatches ? 'supplier' : 'customer');
    } else {
      // Prefer keep customer if it matches header
      drops.push(custMatches ? 'supplier' : 'customer');
    }
    if (!drops.length) continue;
    const entry = {
      party_id: r.party_id,
      name: r.full_name,
      drop: drops.join('+'),
      amount: headerAbs,
      keep: targets.person ? 'person'
        : (targets.customer && !drops.includes('customer') ? 'customer'
          : (targets.supplier && !drops.includes('supplier') ? 'supplier' : 'control')),
      control: targets.controlCode || r.coa_code || '',
    };
    items.push(entry);
    if (!apply) continue;
    for (const drop of drops) {
      if (drop === 'supplier') _purgeRoleOpeningMirror(db, 'supplier', r.sup_id);
      else if (drop === 'customer') _purgeRoleOpeningMirror(db, 'customer', r.cust_id);
    }
    entry.applied = true;
    retired += 1;
  }
  if (apply && retired) {
    db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('party_dual_open_retire_v507',?)")
      .run(JSON.stringify({ ok: 1, retired, at: new Date().toISOString() }));
  }
  return { candidates: items.length, retired, items };
}

/**
 * Upsert party opening JE (mirror bank upsertBankOpening):
 * - date = active FY start_date (unless dateOverride)
 * - amount/sign change → rewriteJournalEntry (same id + voucher_number)
 * - amt=0 → soft-void + clear sub-ledgers
 * @returns {number|null} journal entry id
 */
function upsertPartyOpening(db, partyId, openingRial, userId, {
  dateOverride, description, srcSystem,
} = {}) {
  const pid = Number(partyId);
  if (!Number.isFinite(pid) || pid <= 0) throw new Error('شخص برای سند افتتاحیه یافت نشد');
  const party = db.prepare('SELECT * FROM parties WHERE id=?').get(pid);
  if (!party) throw new Error('شخص برای سند افتتاحیه یافت نشد');

  const amt = Math.round(Number(openingRial) || 0);
  const date = dateOverride || fiscalOpeningDate(db);
  const desc = description || `مانده اول دوره — ${party.full_name || party.biz || pid}`;
  let jeId = livePartyOpeningJeId(db, pid);
  if (!jeId) {
    const siblings = collectPartyOpeningJournalIds(db, party);
    if (siblings.length) {
      jeId = siblings[0];
      db.prepare(`
        UPDATE journal_entries SET ref_type='opening_balance', ref_id=?
        WHERE id=?
      `).run(pid, jeId);
    }
  }

  if (!amt) {
    if (jeId) {
      const { reverseJournalEntry } = require('./void-journal');
      reverseJournalEntry(db, jeId, {
        userId: userId || 1,
        reason: `ابطال مانده اول دوره — ${party.full_name || party.biz || pid}`,
        sourceType: 'opening_balance_reversal',
      });
    }
    clearPartyOpeningSubledgers(db, pid);
    retireOtherPartyOpenings(db, party, null, userId);
    db.prepare(`
      UPDATE parties SET opening_balance=0, opening_balance_date=?, updated_at=strftime('%s','now')
      WHERE id=?
    `).run(date, pid);
    return null;
  }

  const lines = partyOpeningLines(db, party, amt);

  if (jeId) {
    const je = db.prepare('SELECT entry_date, total_debit_rial, ref_type FROM journal_entries WHERE id=?').get(jeId);
    const isOpening = String(je && je.ref_type || '') === 'opening_balance';
    if (!isOpening) {
      jeId = null;
    } else {
      const currentAbs = Math.round(Number(je && je.total_debit_rial) || 0);
      const wantAbs = Math.abs(amt);
      const dateMismatch = String(je && je.entry_date || '') !== String(date);
      const sideMismatch = !partyOpeningSideMatches(db, jeId, amt);
      if (currentAbs !== wantAbs || dateMismatch || sideMismatch) {
        const rewritten = rewriteJournalEntry(db, {
          sourceType: 'opening_balance',
          sourceId: pid,
          date,
          description: desc,
          lines,
        });
        if (!rewritten) {
          jeId = null;
        } else {
          jeId = rewritten;
        }
      }
    }
  }

  if (!jeId) {
    jeId = postToLedger(db, {
      sourceType: 'opening_balance',
      sourceId: pid,
      date,
      description: desc,
      createdBy: userId,
      voucherType: 'opening',
      srcSystem: srcSystem || null,
      lines,
    });
  }

  try {
    mirrorPartyOpeningSubledgers(db, {
      partyId: pid, entryId: jeId, amtRial: amt, openDate: date, userId, description: desc,
    });
  } catch (e) {
    if (db.inTransaction) throw e;
  }

  retireOtherPartyOpenings(db, party, jeId, userId);

  db.prepare(`
    UPDATE parties SET opening_balance=?, opening_balance_date=?, updated_at=strftime('%s','now')
    WHERE id=?
  `).run(amt, date, pid);

  return jeId;
}

function openingMirrorSigned(row) {
  return Math.round(Number(row.debit) || 0) - Math.round(Number(row.credit) || 0);
}

/**
 * Drop / restore customer-book opening rows so books ↔ live party opening JE.
 * Cases:
 * 1) Live JE + stale GL→books copy (ref_type=opening_balance, wrong amt) — v424
 * 2) Party.opening_balance ≠ 0 but JE soft-voided by ID collision — restore JE (v436)
 * 3) Books opening rows with no live JE and party amt=0 — delete mirrors
 * Does not invent openings when party.opening_balance is already 0.
 */
function repairStaleCustomerOpeningMirrors(db) {
  let removed = 0;
  let restored = 0;
  const list = db.prepare(`
    SELECT id, debit, credit, ref_type, ref_id
    FROM customer_ledger
    WHERE customer_id=?
      AND LOWER(COALESCE(ref_type,'')) IN ('opening','opening_balance')
  `);
  const del = db.prepare('DELETE FROM customer_ledger WHERE id=?');

  const run = db.transaction(() => {
    // Pass A — party still claims an opening but the JE was wrongly voided
    const needRestore = db.prepare(`
      SELECT p.*
      FROM parties p
      WHERE ABS(COALESCE(p.opening_balance,0)) > 0
        AND NOT EXISTS (
          SELECT 1 FROM journal_entries je
          WHERE je.ref_type='opening_balance' AND je.ref_id=p.id
            AND COALESCE(je.deleted_at,0)=0
            AND COALESCE(je.status,'posted') NOT IN ('reversed','void')
        )
    `).all();
    for (const party of needRestore) {
      const amt = Math.round(Number(party.opening_balance) || 0);
      if (!amt) continue;
      upsertPartyOpening(db, party.id, amt, null, {
        dateOverride: party.opening_balance_date || fiscalOpeningDate(db),
        description: `مانده اول دوره — ${party.full_name || party.biz || party.id}`,
      });
      restored += 1;
    }

    // Pass B — parties with a live opening JE: keep one matching books row
    const parties = db.prepare(`
      SELECT p.*
      FROM parties p
      WHERE EXISTS (
        SELECT 1 FROM journal_entries je
        WHERE je.ref_type='opening_balance' AND je.ref_id=p.id
          AND COALESCE(je.deleted_at,0)=0
          AND COALESCE(je.status,'posted') NOT IN ('reversed','void')
      )
    `).all();
    for (const party of parties) {
      const amt = Math.round(Number(party.opening_balance) || 0);
      const jeId = livePartyOpeningJeId(db, party.id);
      if (!amt || !jeId) continue;
      const je = db.prepare('SELECT total_debit_rial FROM journal_entries WHERE id=?').get(jeId);
      const jeAbs = Math.round(Number(je && je.total_debit_rial) || 0);
      if (!jeAbs || Math.abs(amt) !== jeAbs) continue;
      for (const cid of partyCustomerIds(db, party)) {
        const rows = list.all(cid);
        if (!rows.length) continue;
        const matches = rows.filter((r) => openingMirrorSigned(r) === amt);
        if (!matches.length) {
          mirrorPartyOpeningSubledgers(db, {
            partyId: party.id,
            entryId: jeId,
            amtRial: amt,
            openDate: party.opening_balance_date || fiscalOpeningDate(db),
            userId: null,
          });
          removed += rows.length;
          continue;
        }
        const preferred = matches.find((r) => (
          String(r.ref_type) === 'opening' && Number(r.ref_id) === Number(jeId)
        )) || matches[0];
        for (const r of rows) {
          if (r.id === preferred.id) continue;
          del.run(r.id);
          removed += 1;
        }
      }
    }

    // Pass C — books opening with no live party JE and zero party opening
    const orphanBooks = db.prepare(`
      SELECT cl.id, cl.customer_id, c.party_id
      FROM customer_ledger cl
      JOIN customers c ON c.id=cl.customer_id
      WHERE LOWER(COALESCE(cl.ref_type,'')) IN ('opening','opening_balance')
        AND ABS(COALESCE((
          SELECT p.opening_balance FROM parties p WHERE p.id=c.party_id
        ),0)) = 0
        AND NOT EXISTS (
          SELECT 1 FROM journal_entries je
          WHERE je.ref_type='opening_balance'
            AND je.ref_id=c.party_id
            AND COALESCE(je.deleted_at,0)=0
            AND COALESCE(je.status,'posted') NOT IN ('reversed','void')
        )
        AND NOT EXISTS (
          SELECT 1 FROM journal_entries je
          WHERE je.id=cl.ref_id
            AND COALESCE(je.deleted_at,0)=0
            AND COALESCE(je.status,'posted') NOT IN ('reversed','void')
        )
    `).all();
    for (const row of orphanBooks) {
      del.run(row.id);
      removed += 1;
      try { refreshCustomerBalanceFromLedger(db, row.customer_id); } catch (_) { /* */ }
    }
  });
  run();
  if (removed || restored) {
    console.log(`✅ stale customer opening mirrors removed=${removed} restored=${restored}`);
  }
  return { removed, restored, continuous: true };
}

/**
 * Post opening-balance JE for a party (مانده اول دوره).
 * amountRial > 0 → party owes us (debit receivable / credit opening)
 * amountRial < 0 → we owe party (debit opening / credit payable)
 * Prefer upsertPartyOpening for create/update paths (FY start + rewrite).
 * @returns {number|null} journal entry id
 */
function postPartyOpeningBalance(db, {
  partyId, amountRial, date, userId, description, srcSystem,
}) {
  return upsertPartyOpening(db, partyId, amountRial, userId, {
    dateOverride: date || null,
    description,
    srcSystem,
  });
}

/**
 * Beginning inventory JE when a product is created with opening stock + cost.
 * Dr inventory / Cr opening_balance
 */
function postProductOpeningInventory(db, {
  productId, qty, unitCostRial, date, userId, description, srcSystem, skipLedger, variantId,
}) {
  const q = Math.max(0, Number(qty) || 0);
  const unit = Math.max(0, Math.round(Number(unitCostRial) || 0));
  if (!(q > 0) || !unit) return null;
  const product = db.prepare('SELECT * FROM products WHERE id=?').get(productId);
  if (!product) return null;

  // One live opening per (product, warehouse, variant) — 409 E_OPENING_EXISTS.
  if (product.warehouse_id) {
    require('./inventory/opening-guard').assertNoLiveOpening(db, {
      productId, warehouseId: product.warehouse_id, variantId: null,
    });
  }

  const totalRial = Math.round(q * unit);
  const { inventoryAccountForWarehouse } = require('./inventory/ledger');
  // v586: inventory JE line only via inventoryAccountForWarehouse (never products.coa_code)
  const inventory = inventoryAccountForWarehouse(db, product.warehouse_id || null);
  const opening = acct(db, 'coa_opening_balance');
  const amtToman = rialToLedger(totalRial);
  const openingDate = date || fiscalOpeningDate(db);
  // Audit 8C / #103 — refuse opening stock into a closed inventory month
  try {
    const { assertPeriodOpen } = require('./inventory/period-lock');
    assertPeriodOpen(db, openingDate, 'موجودی اول دوره محصول');
  } catch (e) {
    if (e && e.code === 'E_INV_PERIOD_LOCKED') throw e;
    throw e;
  }

  const entryId = postToLedger(db, {
    sourceType: 'opening_inventory',
    sourceId: productId,
    date: openingDate,
    description: description || `موجودی اول دوره — ${product.name || productId} × ${q}`,
    createdBy: userId,
    voucherType: 'opening',
    srcSystem: srcSystem || null,
    lines: [
      { code: inventory.code, name: inventory.name, debit: amtToman, credit: 0 },
      { code: opening.code, name: opening.name, debit: 0, credit: amtToman },
    ],
  });

  // skipLedger: accounting value only (seed-avg when kardex already has qty).
  // skipStock alone still wrote qty_in and inflated cardex until reconcile.
  if (product.warehouse_id && !skipLedger) {
    const { postInventoryMovement } = require('./inventory/ledger');
    const vid = variantId != null && Number(variantId) > 0 ? Math.trunc(Number(variantId)) : null;
    const writeOpening = () => {
      postInventoryMovement(db, {
        eventType: 'opening',
        productId,
        warehouseId: product.warehouse_id,
        variantId: vid,
        qty: q,
        unitCostRial: unit,
        sourceType: 'opening_inventory',
        sourceId: productId,
        jeId: entryId,
        date: openingDate,
        note: description || `موجودی اول دوره — ${product.name || productId}`,
        createdBy: userId,
        updateAvg: false,
        skipStock: true,
      });
      require('./inventory/transfer-in-revalue').revalueTransfersAfterBackdatedInbound(db, {
        productId,
        warehouseId: product.warehouse_id,
        date: openingDate,
        user: userId ? { id: userId } : null,
        reason: 'افتتاحیهٔ معوق — اصلاح ارزش انتقال صفر',
      });
    };
    if (db.inTransaction) writeOpening();
    else db.transaction(writeOpening)();
  }
  const { catalogCostFromAvgRial } = require('./inventory/product-unit-cost');
  db.prepare(`
    UPDATE products SET average_cost_rial=?, cost=?
    WHERE id=? AND COALESCE(average_cost_rial,0)=0
  `).run(unit, catalogCostFromAvgRial(unit), productId);
  return entryId;
}

/**
 * Legacy one-shot (flag settings.opening_inventory_ledger_backfill_v1).
 * REPORT-ONLY: it used to insert opening rows; it now only seals the flag.
 * Opening stock is written solely via «موجودی اول دوره» documents.
 */
function backfillOpeningInventoryLedger(db) {
  if (process.env.SYNC_ROLE === 'device') {
    return { skipped: true, reason: 'device' };
  }
  const flag = db.prepare("SELECT value FROM settings WHERE key='opening_inventory_ledger_backfill_v1'").get();
  if (flag && String(flag.value).length) {
    try {
      const parsed = JSON.parse(flag.value);
      if (parsed && parsed.ok) return { skipped: true, count: parsed.count || 0 };
    } catch (_) {
      if (flag.value === '1') return { skipped: true };
    }
  }
  const count = 0;
  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('opening_inventory_ledger_backfill_v1',?)")
    .run(JSON.stringify({ ok: 1, count, report_only: 1 }));
  return { count, seeded_wh: 0, report_only: true };
}

function _defaultWarehouseId(db) {
  return db.prepare(`
    SELECT id FROM warehouses
    WHERE COALESCE(active,1)=1
    ORDER BY CASE WHEN COALESCE(is_default,0)=1 THEN 0 ELSE 1 END, id
    LIMIT 1
  `).get()?.id || null;
}

function _ledgerNet(db, productId, warehouseId) {
  return Number(db.prepare(`
    SELECT COALESCE(SUM(qty_in - qty_out),0) q
    FROM inventory_ledger
    WHERE product_id=? AND warehouse_id=? AND COALESCE(status,'posted')='posted'
  `).get(productId, warehouseId)?.q) || 0;
}

const GAP_REPORT_KEY = 'inventory_ledger_gap_report_v2';
const GAP_REPORT_CAP = 500;

/**
 * Kardex-vs-warehouse gaps for one product (READ-ONLY).
 * Header stock with no warehouse_stock row is reported against the product /
 * default warehouse with ws_qty=0 and header_stock set.
 */
function _productLedgerGaps(db, pid, defaultWh) {
  const product = db.prepare('SELECT id, stock, warehouse_id FROM products WHERE id=?').get(pid);
  if (!product) return [];
  const gaps = [];
  const rows = db.prepare('SELECT warehouse_id, qty FROM warehouse_stock WHERE product_id=?').all(pid);
  for (const r of rows) {
    const net = _ledgerNet(db, pid, r.warehouse_id);
    const wsQty = Number(r.qty) || 0;
    if (Math.abs(wsQty - net) <= 1e-9) continue;
    gaps.push({ product_id: pid, warehouse_id: r.warehouse_id, variant_id: null, ws_qty: wsQty, kardex_qty: net });
  }
  const headerStock = Number(product.stock) || 0;
  const hasWs = rows.some((r) => Math.abs(Number(r.qty) || 0) > 1e-9);
  if (Math.abs(headerStock) > 1e-9 && !hasWs) {
    const whId = product.warehouse_id || defaultWh || null;
    gaps.push({
      product_id: pid, warehouse_id: whId, variant_id: null, ws_qty: 0,
      kardex_qty: whId ? _ledgerNet(db, pid, whId) : 0, header_stock: headerStock,
    });
  }
  return gaps;
}

/**
 * REPORT-ONLY (opening SSOT). Never inserts inventory_ledger rows (opening or
 * adjustment) nor warehouse_stock rows — the boot gap-filler created duplicate
 * openings. Gaps are returned for an explicit admin correction document.
 */
function reconcileProductStockLedger(db, productId) {
  const pid = parseInt(productId, 10);
  if (!Number.isFinite(pid) || pid <= 0) return { count: 0, seeded_wh: 0, gaps: [], report_only: true };
  const hasLedger = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='inventory_ledger'").get();
  if (!hasLedger) return { count: 0, seeded_wh: 0, skipped: true, gaps: [], report_only: true };
  const gaps = _productLedgerGaps(db, pid, _defaultWarehouseId(db));
  return { count: 0, seeded_wh: 0, skipped_live: 0, gaps, report_only: true };
}

/**
 * Boot-time scan (REPORT-ONLY): warehouse_stock / header stock vs kardex net.
 * Writes settings.inventory_ledger_gap_report_v2 = {at, gaps (cap 500), count}.
 * Returns count:0 (nothing posted) so callers never log a heal.
 */
function reconcileInventoryLedgerGaps(db, { recordSetting = true } = {}) {
  if (process.env.SYNC_ROLE === 'device') {
    return { skipped: true, reason: 'device', count: 0, seeded_wh: 0 };
  }
  const hasLedger = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='inventory_ledger'").get();
  if (!hasLedger) return { skipped: true, count: 0, seeded_wh: 0 };
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='warehouse_stock'").get()) {
    return { skipped: true, count: 0, seeded_wh: 0 };
  }
  const defaultWh = _defaultWarehouseId(db);
  const candidates = db.prepare(`
    SELECT DISTINCT product_id AS id FROM warehouse_stock
    WHERE ABS(COALESCE(qty,0)) > 1e-9
    UNION
    SELECT id FROM products WHERE ABS(COALESCE(stock,0)) > 1e-9
  `).all();
  const gaps = [];
  for (const c of candidates) gaps.push(..._productLedgerGaps(db, c.id, defaultWh));

  if (recordSetting) {
    db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)')
      .run(GAP_REPORT_KEY, JSON.stringify({
        at: new Date().toISOString(), gaps: gaps.slice(0, GAP_REPORT_CAP), count: gaps.length,
      }));
  }
  if (gaps.length) {
    console.log(`ℹ️ ${GAP_REPORT_KEY}: ${gaps.length} kardex/warehouse gap(s) reported — no rows written`);
  }
  return { count: 0, seeded_wh: 0, report_only: true, gap_count: gaps.length };
}

/**
 * Opening qty/value belongs on the first day of the active fiscal year.
 * Moves only dates that fall after that day (a mid-year «بهای اولیه» or
 * opening heal). Prior-year openings stay where they are.
 */
function redateOpeningDocsToFiscalStart(db) {
  if (process.env.SYNC_ROLE === 'device') return { skipped: true, reason: 'device' };
  const cols = db.prepare('PRAGMA table_info(inventory_ledger)').all().map((c) => c.name);
  if (!cols.includes('date')) return { skipped: true, reason: 'no_date' };
  const start = fiscalOpeningDate(db);
  // Continuous: mid-year «بهای اولیه» can appear after a one-shot flag was sealed.
  const ledger = db.prepare(`
    UPDATE inventory_ledger
    SET date=?
    WHERE COALESCE(status,'posted')='posted'
      AND IFNULL(date,'') > ?
      AND (
        event_type='opening'
        OR source_type='opening_inventory'
        OR replace(replace(IFNULL(note,''), char(8204), ''), 'ي', 'ی') LIKE 'بهای اولیه%'
        OR replace(replace(IFNULL(note,''), char(8204), ''), 'ي', 'ی') LIKE 'موجودی اول دوره%'
        OR replace(replace(IFNULL(note,''), char(8204), ''), 'ي', 'ی') LIKE '%بهای اولیه موجودی%'
      )
  `).run(start, start);
  const jeCols = db.prepare('PRAGMA table_info(journal_entries)').all().map((c) => c.name);
  const journals = jeCols.includes('date')
    ? db.prepare(`
        UPDATE journal_entries
        SET date=?
        WHERE COALESCE(deleted_at,0)=0
          AND COALESCE(status,'posted') NOT IN ('reversed','void')
          AND ref_type='opening_inventory'
          AND IFNULL(date,'') > ?
      `).run(start, start)
    : { changes: 0 };
  return { ledger: ledger.changes || 0, journals: journals.changes || 0, date: start };
}

/**
 * «بهای اولیه» posted to the goods account after a receipt already capitalized
 * the same product. Soft-void that journal only; quantity rows stay.
 */
function retireDuplicateOpeningValueJournals(db) {
  if (process.env.SYNC_ROLE === 'device') return { skipped: true, reason: 'device' };
  const flag = db.prepare("SELECT value FROM settings WHERE key='opening_dup_value_v490'").get();
  if (flag && flag.value === '1') return { skipped: true };
  const { reverseJournalEntry } = require('./void-journal');
  const rows = db.prepare(`
    SELECT id, ref_id AS product_id
    FROM journal_entries
    WHERE ref_type='opening_inventory'
      AND COALESCE(deleted_at,0)=0
      AND COALESCE(status,'posted') NOT IN ('reversed','void')
      AND IFNULL(description,'') LIKE 'بهای اولیه موجودی%'
  `).all();
  let count = 0;
  const run = db.transaction(() => {
    for (const je of rows) {
      const other = db.prepare(`
        SELECT id FROM inventory_ledger
        WHERE product_id=? AND je_id IS NOT NULL AND je_id != ?
          AND COALESCE(status,'posted')='posted'
          AND COALESCE(amount_rial,0) != 0
          AND COALESCE(source_type,'') IN (
            'fabric_roll','purchase','warehouse_receipt',
            'warehouse_receipt_grni','warehouse_receipt_batch'
          )
        LIMIT 1
      `).get(je.product_id, je.id);
      if (!other) continue;
      reverseJournalEntry(db, je.id, {
        reason: 'بهای اولیه تکراری — ارزش قبلاً با رسید مواد ثبت شده',
        sourceType: 'opening_inventory_reversal',
      });
      count += 1;
    }
  });
  run();
  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('opening_dup_value_v490','1')").run();
  return { count };
}

/**
 * Retire spurious «موجودی اول دوره (هم‌ترازی کاردکس)» rows when the product
 * already has real economic movements (transfer / sale / pack / purchase).
 * Seeds were skipStock — reverse is skipStock; then warehouse_stock is synced
 * to ledger net so invoice picker and kardex agree.
 *
 * @returns {{ candidates: number, reversed: number, synced_wh: number, items: any[] }}
 */
function retireSpuriousKardexAlign(db, { apply = false, productId = null } = {}) {
  if (process.env.SYNC_ROLE === 'device') {
    return { skipped: true, reason: 'device', candidates: 0, reversed: 0, synced_wh: 0, items: [] };
  }
  const hasLedger = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='inventory_ledger'"
  ).get();
  if (!hasLedger) return { candidates: 0, reversed: 0, synced_wh: 0, items: [] };

  const { reverseInventoryMovement } = require('./inventory/ledger');
  const adminId = db.prepare("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1").get()?.id || 1;
  const pidFilter = productId != null && Number(productId) > 0
    ? ' AND l.product_id=' + parseInt(productId, 10)
    : '';

  // Strip ZWNJ from note before LIKE — pattern must not keep «‌» or match fails.
  const seeds = db.prepare(`
    SELECT l.*, p.name AS product_name, p.code AS product_code
    FROM inventory_ledger l
    JOIN products p ON p.id = l.product_id
    WHERE COALESCE(l.status,'posted')='posted'
      AND (
        l.event_type='opening'
        OR IFNULL(l.source_type,'')='opening_inventory'
        OR IFNULL(l.source_type,'')='stock_reconcile'
      )
      AND (
        replace(replace(IFNULL(l.note,''), char(8204), ''), 'ي', 'ی') LIKE '%همترازی کاردکس%'
        OR replace(replace(IFNULL(l.note,''), char(8204), ''), 'ي', 'ی') LIKE 'موجودی اول دوره (همترازی%'
        OR replace(replace(IFNULL(l.note,''), char(8204), ''), 'ي', 'ی') LIKE 'همترازی کاردکس با موجودی انبار%'
      )
      ${pidFilter}
    ORDER BY l.product_id, l.warehouse_id, l.id
  `).all();

  const items = [];
  let reversed = 0;
  let syncedWh = 0;

  const hasRealEconomic = (pid, whId, excludeId) => !!db.prepare(`
    SELECT 1 AS ok FROM inventory_ledger
    WHERE product_id=? AND warehouse_id=?
      AND COALESCE(status,'posted')='posted'
      AND id<>?
      AND IFNULL(event_type,'') NOT IN ('opening','reversal')
      AND IFNULL(source_type,'') NOT IN ('opening_inventory','stock_reconcile')
      AND NOT (
        replace(replace(IFNULL(note,''), char(8204), ''), 'ي', 'ی') LIKE '%همترازی کاردکس%'
      )
    LIMIT 1
  `).get(pid, whId, excludeId);

  const syncWhToLedger = (productId, warehouseId, entry) => {
    const net = _ledgerNet(db, productId, warehouseId);
    if (entry) entry.ledger_net_after = net;
    try {
      const before = db.prepare(
        'SELECT qty FROM warehouse_stock WHERE product_id=? AND warehouse_id=?'
      ).get(productId, warehouseId);
      const beforeQty = before ? Number(before.qty) || 0 : null;
      require('./inventory/stock-cache').rebuildStockCache(db, productId);
      const after = db.prepare(
        'SELECT qty FROM warehouse_stock WHERE product_id=? AND warehouse_id=?'
      ).get(productId, warehouseId);
      const afterQty = after ? Number(after.qty) || 0 : 0;
      if (beforeQty == null ? Math.abs(afterQty) > 1e-9 : Math.abs(beforeQty - afterQty) > 1e-9) syncedWh += 1;
    } catch (e) {
      if (entry) entry.ws_sync_error = e.message || String(e);
    }
    return net;
  };

  const applyReverse = (row, gapQty, laterIn, reason) => {
    const entry = {
      ledger_id: row.id,
      tx_no: row.tx_no,
      product_id: row.product_id,
      product_name: row.product_name,
      warehouse_id: row.warehouse_id,
      qty: gapQty,
      note: row.note,
      date: row.date,
      later_in: laterIn,
      reason: reason || 'covered_by_later_in',
    };
    items.push(entry);
    if (!apply) return entry;
    reverseInventoryMovement(db, row.id, {
      createdBy: adminId,
      date: row.date,
      note: `ابطال هم‌ترازی نادرست کاردکس (${row.tx_no || row.id})`,
      skipStock: true,
    });
    reversed += 1;
    syncWhToLedger(row.product_id, row.warehouse_id, entry);
    entry.applied = true;
    return entry;
  };

  const nonSeedInbound = (pid, whId, excludeId, fromDate) => Number(db.prepare(`
    SELECT COALESCE(SUM(qty_in),0) q FROM inventory_ledger
    WHERE product_id=? AND warehouse_id=?
      AND COALESCE(status,'posted')='posted'
      AND id<>?
      AND COALESCE(qty_in,0) > 0
      AND IFNULL(event_type,'') NOT IN ('opening','reversal')
      AND IFNULL(source_type,'') NOT IN ('opening_inventory','stock_reconcile')
      AND NOT (
        replace(replace(IFNULL(note,''), char(8204), ''), 'ي', 'ی') LIKE '%همترازی کاردکس%'
      )
      AND IFNULL(date,'') >= IFNULL(?, '')
  `).get(pid, whId, excludeId, fromDate || '')?.q) || 0;

  // Pass 1: seed fully covered by later real inbound — reverse + sync WS.
  // Do NOT block when WS currently mirrors the seed (apply always resyncs WS);
  // that gate was why hundreds of double-count openings survived v504.
  for (const row of seeds) {
    if (!hasRealEconomic(row.product_id, row.warehouse_id, row.id)) continue;
    const gapQty = (Number(row.qty_in) || 0) - (Number(row.qty_out) || 0);
    if (gapQty <= 1e-9) continue;
    const laterIn = nonSeedInbound(row.product_id, row.warehouse_id, row.id, row.date);
    if (laterIn + 1e-9 < gapQty) continue;
    const netNow = _ledgerNet(db, row.product_id, row.warehouse_id);
    const netWithout = netNow - gapQty;
    if (netWithout < -1e-9) continue;
    applyReverse(row, gapQty, laterIn, 'covered_by_later_in');
  }

  // Pass 2: multiple هم‌ترازی openings on same SKU×WH — keep only the qty still
  // needed after non-seed net; reverse the rest (oldest first).
  const grouped = new Map();
  for (const row of seeds) {
    const gapQty = (Number(row.qty_in) || 0) - (Number(row.qty_out) || 0);
    if (gapQty <= 1e-9) continue;
    if (items.some((x) => x.ledger_id === row.id)) continue; // already queued/reversed
    if (String(row.status || 'posted') !== 'posted') continue;
    // Re-read status if apply already reversed in pass 1
    if (apply) {
      const live = db.prepare(
        "SELECT status FROM inventory_ledger WHERE id=?"
      ).get(row.id);
      if (!live || String(live.status) !== 'posted') continue;
    }
    const key = `${row.product_id}:${row.warehouse_id}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push({ row, gapQty });
  }
  for (const [, group] of grouped) {
    if (group.length < 2) continue;
    group.sort((a, b) => a.row.id - b.row.id);
    const pid = group[0].row.product_id;
    const whId = group[0].row.warehouse_id;
    const nonSeedNet = Number(db.prepare(`
      SELECT COALESCE(SUM(qty_in-qty_out),0) q FROM inventory_ledger
      WHERE product_id=? AND warehouse_id=?
        AND COALESCE(status,'posted')='posted'
        AND IFNULL(event_type,'') NOT IN ('opening','reversal')
        AND IFNULL(source_type,'') NOT IN ('opening_inventory','stock_reconcile')
        AND NOT (
          replace(replace(IFNULL(note,''), char(8204), ''), 'ي', 'ی') LIKE '%همترازی کاردکس%'
        )
    `).get(pid, whId)?.q) || 0;
    const wsQty = Number(db.prepare(
      'SELECT qty FROM warehouse_stock WHERE product_id=? AND warehouse_id=?'
    ).get(pid, whId)?.qty) || 0;
    // Opening still needed so ledger+kept-seeds can reach WS (never invent stock).
    let needOpen = Math.max(0, wsQty - nonSeedNet);
    let kept = 0;
    for (const { row, gapQty } of group) {
      if (kept + 1e-9 >= needOpen) {
        const netNow = _ledgerNet(db, pid, whId);
        if (netNow - gapQty < -1e-9) {
          kept += gapQty;
          continue;
        }
        applyReverse(row, gapQty, nonSeedInbound(pid, whId, row.id, row.date), 'surplus_multi_seed');
        continue;
      }
      kept += gapQty;
    }
  }

  // Kept openings that still carry the old «هم‌ترازی» suffix are real first-period
  // stock (no later inbound to cover them). Relabel so reports don't look haunted.
  let relabeled = 0;
  if (apply) {
    const ren = db.prepare(`
      UPDATE inventory_ledger
      SET note='موجودی اول دوره'
      WHERE COALESCE(status,'posted')='posted'
        AND (
          event_type='opening'
          OR IFNULL(source_type,'')='opening_inventory'
        )
        AND replace(replace(IFNULL(note,''), char(8204), ''), 'ي', 'ی')
            LIKE 'موجودی اول دوره (همترازی%'
        ${pidFilter.replace('l.product_id', 'product_id')}
    `).run();
    relabeled = ren.changes || 0;
  }

  if (apply && (reversed || relabeled)) {
    db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('kardex_align_retire_v506',?)")
      .run(JSON.stringify({
        ok: 1, reversed, synced_wh: syncedWh, relabeled, at: new Date().toISOString(),
      }));
  }

  return {
    candidates: items.length,
    reversed,
    synced_wh: syncedWh,
    relabeled,
    items,
  };
}

module.exports = {
  postPartyOpeningBalance,
  upsertPartyOpening,
  fiscalOpeningDate,
  livePartyOpeningJeId,
  collectPartyOpeningJournalIds,
  clearPartyOpeningSubledgers,
  deleteCustomerOpeningMirrors,
  refreshCustomerBalanceFromLedger,
  repairStaleCustomerOpeningMirrors,
  partyOpeningLines,
  partyOpeningMirrorTargets,
  mirrorPartyOpeningSubledgers,
  retireDuplicateRoleOpeningMirrors,
  postProductOpeningInventory,
  backfillOpeningInventoryLedger,
  reconcileInventoryLedgerGaps,
  reconcileProductStockLedger,
  redateOpeningDocsToFiscalStart,
  retireDuplicateOpeningValueJournals,
  retireSpuriousKardexAlign,
  controlAccountForParty,
  parseRoles,
};
