// Dual-write shim: keep customers/suppliers tables in sync with unified parties table.

function syncCustomerToParty(db, customerId) {
  const c = db.prepare('SELECT * FROM customers WHERE id=?').get(customerId);
  if (!c) return null;
  if (c.party_id) {
    db.prepare(`
      UPDATE parties SET full_name=?, phone=?, city=?, notes=?, user_id=?, biz=?, owner=?, insta=?, status=?, type=?,
        national_id=?, economic_code=?, party_group_id=?, prefix=?, secondary_phone=?, fax=?, mobile=?, email=?,
        postal_code=?, birth_date=?, referrer=?, company_name=?, account_nature=?, coa_code=?, province=?, address=?,
        updated_at=strftime('%s','now')
      WHERE id=?
    `).run(c.owner || c.biz, c.phone || '-', c.city, c.note, c.user_id, c.biz, c.owner, c.insta, c.status, c.type,
      c.national_id, c.economic_code, c.party_group_id || null, c.prefix || null, c.phone2 || null, c.fax || null,
      c.mobile || null, c.email || null, c.postal_code || null, c.birth_date || null, c.referrer || null,
      c.company_name || null, c.account_nature || null, c.coa_code || null, c.province || null, c.address || null,
      c.party_id);
    return c.party_id;
  }
  const code = 'CUST-' + String(c.id).padStart(5, '0');
  const r = db.prepare(`
    INSERT INTO parties (person_code, party_type, party_roles, full_name, phone, city, notes, user_id, biz, owner, insta, status, type,
      national_id, economic_code, credit_limit, legacy_table, legacy_id, party_group_id, prefix, secondary_phone, fax, mobile, email,
      postal_code, birth_date, referrer, company_name, account_nature, coa_code, province, address)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(code, 'customer', '["customer"]', c.owner || c.biz, c.phone || '-', c.city, c.note, c.user_id, c.biz, c.owner, c.insta,
    c.status, c.type, c.national_id, c.economic_code, Math.round(Number(c.credit_limit) || 0), 'customers', c.id,
    c.party_group_id || null, c.prefix || null, c.phone2 || null, c.fax || null, c.mobile || null, c.email || null,
    c.postal_code || null, c.birth_date || null, c.referrer || null, c.company_name || null, c.account_nature || null, c.coa_code || null,
    c.province || null, c.address || null);
  db.prepare('UPDATE customers SET party_id=? WHERE id=?').run(r.lastInsertRowid, customerId);
  return r.lastInsertRowid;
}

function syncSupplierToParty(db, supplierId) {
  const s = db.prepare('SELECT * FROM suppliers WHERE id=?').get(supplierId);
  if (!s) return null;
  if (s.party_id) {
    db.prepare(`
      UPDATE parties SET full_name=?, phone=?, notes=?, biz=?, party_group_id=?, coa_code=?,
        updated_at=strftime('%s','now') WHERE id=?
    `).run(s.name, s.phone || '-', s.note, s.name, s.party_group_id || null, s.coa_code || null, s.party_id);
    return s.party_id;
  }
  const code = 'SUPP-' + String(s.id).padStart(5, '0');
  const r = db.prepare(`
    INSERT INTO parties (person_code, party_type, party_roles, full_name, phone, notes, biz, legacy_table, legacy_id, party_group_id, coa_code)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).run(code, 'supplier', '["supplier"]', s.name, s.phone || '-', s.note, s.name, 'suppliers', s.id, s.party_group_id || null, s.coa_code || null);
  db.prepare('UPDATE suppliers SET party_id=? WHERE id=?').run(r.lastInsertRowid, supplierId);
  return r.lastInsertRowid;
}

/**
 * Mirror only a receivable leaf onto customers.
 * Dual-role / supplier-first parties often keep an AP code on parties.coa_code —
 * copying that onto customers would make invoice AR post to a payable leaf.
 */
function safeCustomerCoaMirror(db, partyRow, roleSupplier) {
  const code = partyRow && partyRow.coa_code ? String(partyRow.coa_code).trim() : '';
  if (!code) return '';
  try {
    const { codeUnderKind } = require('./party-tafsili');
    if (!codeUnderKind(db, code, 'customer')) return '';
  } catch (_) {
    if (roleSupplier) return '';
  }
  return code;
}

function syncPartyToLegacy(db, partyId) {
  const p = db.prepare('SELECT * FROM parties WHERE id=?').get(partyId);
  if (!p) return;
  const roles = (() => {
    try { return p.party_roles ? JSON.parse(p.party_roles) : []; } catch (_) { return []; }
  })();
  // ADR-PARTY-001 / MDM: commercial roles drive projections. Party group
  // (e.g. پرسنل / entity_type=person) is classification only — it must NOT
  // suppress the customers row when the party has an explicit customer role,
  // or invoice pickers (CACHE.customers) silently omit sellable parties.
  const roleCustomer = roles.includes('customer') || p.party_type === 'customer' || p.party_type === 'both';
  const roleSupplier = roles.includes('supplier') || p.party_type === 'supplier' || p.party_type === 'both';
  const isCustomer = roleCustomer;
  const isSupplier = roleSupplier;
  const customerCoa = safeCustomerCoaMirror(db, p, isSupplier);

  if (isCustomer) {
    let cust = p.legacy_table === 'customers' && p.legacy_id
      ? db.prepare('SELECT * FROM customers WHERE id=?').get(p.legacy_id)
      : db.prepare('SELECT * FROM customers WHERE party_id=?').get(partyId);
    if (!cust) {
      const ownerId = p.user_id || 1;
      const r = db.prepare(`
        INSERT INTO customers (user_id,biz,owner,city,province,address,phone,insta,type,status,note,party_id,party_group_id,
          prefix,phone2,fax,mobile,email,economic_code,postal_code,national_id,referrer,birth_date,company_name,account_nature,coa_code,created_by,assigned_to,balance)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(ownerId, p.biz || p.full_name, p.owner || '', p.city || '', p.province || '', p.address || '',
        p.phone, p.insta || '', p.type || 'بوتیک', p.status || 'new', p.notes || '', partyId, p.party_group_id || null,
        p.prefix || '', p.secondary_phone || '', p.fax || '', p.mobile || '', p.email || '', p.economic_code || '',
        p.postal_code || '', p.national_id || '', p.referrer || '', p.birth_date || '', p.company_name || '',
        p.account_nature || '', customerCoa, ownerId, ownerId, p.opening_balance != null ? Number(p.opening_balance) : 0);
      // Prefer customers as legacy pointer for invoice/CRM; suppliers stay linked via party_id.
      db.prepare('UPDATE parties SET legacy_table=?, legacy_id=? WHERE id=?').run('customers', r.lastInsertRowid, partyId);
    } else {
      if (p.user_id) {
        db.prepare(`
          UPDATE customers SET biz=?, owner=?, city=?, province=?, address=?, phone=?, insta=?, type=?, status=?, note=?,
            party_id=?, party_group_id=?, prefix=?, phone2=?, fax=?, mobile=?, email=?, economic_code=?, postal_code=?,
            national_id=?, referrer=?, birth_date=?, company_name=?, account_nature=?,
            coa_code=CASE WHEN ?<>'' THEN ? ELSE coa_code END,
            user_id=?, assigned_to=?
          WHERE id=?
        `).run(p.biz || p.full_name, p.owner || '', p.city || '', p.province || '', p.address || '', p.phone,
          p.insta || '', p.type || 'بوتیک', p.status || 'new', p.notes || '', partyId, p.party_group_id || null,
          p.prefix || '', p.secondary_phone || '', p.fax || '', p.mobile || '', p.email || '', p.economic_code || '',
          p.postal_code || '', p.national_id || '', p.referrer || '', p.birth_date || '', p.company_name || '',
          p.account_nature || '', customerCoa, customerCoa, p.user_id, p.user_id, cust.id);
      } else {
        db.prepare(`
          UPDATE customers SET biz=?, owner=?, city=?, province=?, address=?, phone=?, insta=?, type=?, status=?, note=?,
            party_id=?, party_group_id=?, prefix=?, phone2=?, fax=?, mobile=?, email=?, economic_code=?, postal_code=?,
            national_id=?, referrer=?, birth_date=?, company_name=?, account_nature=?,
            coa_code=CASE WHEN ?<>'' THEN ? ELSE coa_code END
          WHERE id=?
        `).run(p.biz || p.full_name, p.owner || '', p.city || '', p.province || '', p.address || '', p.phone,
          p.insta || '', p.type || 'بوتیک', p.status || 'new', p.notes || '', partyId, p.party_group_id || null,
          p.prefix || '', p.secondary_phone || '', p.fax || '', p.mobile || '', p.email || '', p.economic_code || '',
          p.postal_code || '', p.national_id || '', p.referrer || '', p.birth_date || '', p.company_name || '',
          p.account_nature || '', customerCoa, customerCoa, cust.id);
      }
    }
  }

  if (isSupplier) {
    let sup = p.legacy_table === 'suppliers' && p.legacy_id
      ? db.prepare('SELECT * FROM suppliers WHERE id=?').get(p.legacy_id)
      : db.prepare('SELECT * FROM suppliers WHERE party_id=?').get(partyId);
    const name = p.company_name || p.full_name || p.biz;
    // ADR-PARTY-001: dual-role must not copy AR leaf onto supplier AP.
    const supplierCoaOnCreate = isCustomer ? '' : (p.coa_code || '');
    if (!sup) {
      const r = db.prepare(`
        INSERT INTO suppliers (name,phone,address,note,party_id,party_group_id,coa_code)
        VALUES (?,?,?,?,?,?,?)
      `).run(name, p.phone || '', p.address || '', p.notes || '', partyId, p.party_group_id || null, supplierCoaOnCreate);
      if (!isCustomer) db.prepare('UPDATE parties SET legacy_table=?, legacy_id=? WHERE id=?').run('suppliers', r.lastInsertRowid, partyId);
    } else if (isCustomer) {
      db.prepare(`
        UPDATE suppliers SET name=?, phone=?, address=?, note=?, party_id=?, party_group_id=? WHERE id=?
      `).run(name, p.phone || '', p.address || '', p.notes || '', partyId, p.party_group_id || null, sup.id);
    } else {
      db.prepare(`
        UPDATE suppliers SET name=?, phone=?, address=?, note=?, party_id=?, party_group_id=?, coa_code=? WHERE id=?
      `).run(name, p.phone || '', p.address || '', p.notes || '', partyId, p.party_group_id || null, p.coa_code || '', sup.id);
    }
  }

  try { require('./party-employee-sync').syncPartyToPerson(db, partyId); } catch (_) { /* persons projection is best-effort */ }
  if (isCustomer && isSupplier) {
    try { require('./party-tafsili').ensureDualRoleSeparateLeaves(db, partyId); } catch (_) { /* optional */ }
  }
}

/** Resolve CRM customer ids linked to a party (party_id and/or legacy pointer). */
function linkedCustomerIds(db, partyId) {
  const ids = new Set();
  db.prepare('SELECT id FROM customers WHERE party_id=?').all(partyId).forEach((r) => ids.add(r.id));
  const p = db.prepare('SELECT legacy_table, legacy_id FROM parties WHERE id=?').get(partyId);
  if (p && p.legacy_table === 'customers' && p.legacy_id) ids.add(p.legacy_id);
  return [...ids];
}

function linkedSupplierIds(db, partyId) {
  const ids = new Set();
  db.prepare('SELECT id FROM suppliers WHERE party_id=?').all(partyId).forEach((r) => ids.add(r.id));
  const p = db.prepare('SELECT legacy_table, legacy_id FROM parties WHERE id=?').get(partyId);
  if (p && p.legacy_table === 'suppliers' && p.legacy_id) ids.add(p.legacy_id);
  return [...ids];
}

/**
 * Remove CRM-side customer + followups. Financial docs (invoices/ledger/orders)
 * may keep the customers row if FK blocks — list APIs still hide inactive-party links.
 */
function removeCrmCustomerSide(db, customerId) {
  if (!customerId) return;
  try { db.prepare('DELETE FROM followups WHERE cust_id=?').run(customerId); } catch (_) {}
  try { db.prepare('DELETE FROM customers WHERE id=?').run(customerId); } catch (_) {}
}

function removeSupplierSide(db, supplierId) {
  if (!supplierId) return;
  try { db.prepare('DELETE FROM suppliers WHERE id=?').run(supplierId); } catch (_) {}
}

/**
 * Accounting soft-delete → cascade to CRM customers/suppliers + followups.
 * Must run inside (or as) a transaction.
 */
function releasePartyCoaIfIdle(db, partyRow) {
  if (!partyRow?.coa_code) return;
  try {
    const { releaseTafsili } = require('./coa-map');
    // detach code from soft-deleted party so releaseTafsili sees no live link
    db.prepare('UPDATE parties SET coa_code=NULL WHERE id=?').run(partyRow.id);
    releaseTafsili(db, partyRow.coa_code);
  } catch (_) { /* ignore */ }
}

function deactivatePartyCascade(db, partyId, opts = {}) {
  const row = db.prepare('SELECT * FROM parties WHERE id=?').get(partyId);
  if (!row) return { ok: false, reason: 'not_found' };
  // Reverse opening-balance JE(s) + clear opening sub-ledgers (R13)
  try {
    const { upsertPartyOpening } = require('./opening-post');
    upsertPartyOpening(db, partyId, 0, opts.userId || null);
  } catch (_) {
    try {
      const { reverseJournalEntry } = require('./void-journal');
      const { clearPartyOpeningSubledgers } = require('./opening-post');
      const jes = db.prepare(`
        SELECT id FROM journal_entries
        WHERE ref_type IN ('opening_balance','party_opening') AND ref_id=?
          AND COALESCE(deleted_at,0)=0 AND COALESCE(status,'posted')<>'reversed'
      `).all(partyId);
      for (const je of jes) {
        reverseJournalEntry(db, je.id, {
          userId: opts.userId || null,
          reason: `غیرفعال‌سازی شخص #${partyId}`,
          sourceType: 'opening_balance_reversal',
        });
      }
      clearPartyOpeningSubledgers(db, partyId);
    } catch (__) { /* */ }
  }
  db.prepare("UPDATE parties SET is_active=0, opening_balance=0, updated_at=strftime('%s','now') WHERE id=?").run(partyId);
  const custIds = linkedCustomerIds(db, partyId);
  const suppIds = linkedSupplierIds(db, partyId);
  for (const id of custIds) removeCrmCustomerSide(db, id);
  for (const id of suppIds) removeSupplierSide(db, id);
  try { require('./party-employee-sync').deactivateLinkedPerson(db, partyId); } catch (_) {}
  releasePartyCoaIfIdle(db, row);
  return { ok: true, customers: custIds, suppliers: suppIds };
}

/**
 * CRM customer hard-delete → soft-delete linked accounting party.
 * If party is also a supplier, keep party active but drop customer role / legacy customer pointer.
 */
function deactivatePartyFromCustomer(db, customerId) {
  const c = db.prepare('SELECT id, party_id, coa_code FROM customers WHERE id=?').get(customerId);
  if (!c) return { ok: false, reason: 'not_found' };
  const customerCoa = c.coa_code;
  try { db.prepare('DELETE FROM followups WHERE cust_id=?').run(customerId); } catch (_) {}
  try { db.prepare('DELETE FROM customers WHERE id=?').run(customerId); } catch (e) {
    return { ok: false, reason: e.message || 'fk' };
  }
  if (customerCoa) {
    try { require('./coa-map').releaseTafsili(db, customerCoa); } catch (_) {}
  }
  let partyId = c.party_id;
  if (!partyId) {
    const p = db.prepare("SELECT id FROM parties WHERE legacy_table='customers' AND legacy_id=?").get(customerId);
    partyId = p?.id || null;
  }
  if (partyId) {
    const p = db.prepare('SELECT * FROM parties WHERE id=?').get(partyId);
    const roles = (() => {
      try { return p.party_roles ? JSON.parse(p.party_roles) : []; } catch (_) { return []; }
    })();
    const stillSupplier = roles.includes('supplier') || p.party_type === 'supplier' || p.party_type === 'both'
      || !!db.prepare('SELECT id FROM suppliers WHERE party_id=?').get(partyId);
    if (stillSupplier) {
      const nextRoles = roles.filter((r) => r !== 'customer');
      if (!nextRoles.includes('supplier')) nextRoles.push('supplier');
      db.prepare(`UPDATE parties SET party_type='supplier', party_roles=?,
        legacy_table=CASE WHEN legacy_table='customers' THEN 'suppliers' ELSE legacy_table END,
        updated_at=strftime('%s','now') WHERE id=?`
      ).run(JSON.stringify(nextRoles), partyId);
    } else {
      db.prepare("UPDATE parties SET is_active=0, updated_at=strftime('%s','now') WHERE id=?").run(partyId);
      releasePartyCoaIfIdle(db, p);
    }
  }
  return { ok: true, partyId };
}

/**
 * CRM/purchasing supplier hard-delete → soft-delete linked party.
 */
function deactivatePartyFromSupplier(db, supplierId) {
  const s = db.prepare('SELECT id, party_id, coa_code FROM suppliers WHERE id=?').get(supplierId);
  if (!s) return { ok: false, reason: 'not_found' };
  const supplierCoa = s.coa_code;
  try { db.prepare('DELETE FROM suppliers WHERE id=?').run(supplierId); } catch (e) {
    return { ok: false, reason: e.message || 'fk' };
  }
  if (supplierCoa) {
    try { require('./coa-map').releaseTafsili(db, supplierCoa); } catch (_) {}
  }
  let partyId = s.party_id;
  if (!partyId) {
    const p = db.prepare("SELECT id FROM parties WHERE legacy_table='suppliers' AND legacy_id=?").get(supplierId);
    partyId = p?.id || null;
  }
  if (partyId) {
    const p = db.prepare('SELECT * FROM parties WHERE id=?').get(partyId);
    db.prepare("UPDATE parties SET is_active=0, updated_at=strftime('%s','now') WHERE id=?").run(partyId);
    releasePartyCoaIfIdle(db, p);
  }
  return { ok: true, partyId };
}

/** SQL fragment: customer is visible in CRM (no party, or active party). */
const CRM_CUSTOMER_ACTIVE_SQL = `(c.party_id IS NULL OR EXISTS (SELECT 1 FROM parties p WHERE p.id=c.party_id AND p.is_active=1))`;

/**
 * Boot heal: parties with customer role but no CRM customers row
 * (historical bug: پرسنل group gated isCustomer). Idempotent via settings flag.
 */
function healCustomerRoleProjectionsV455(db) {
  const flagKey = 'customer_role_projection_v455';
  try {
    const done = db.prepare('SELECT value FROM settings WHERE key=?').get(flagKey);
    if (done && String(done.value) === '1') return { skipped: true };
  } catch (_) { /* settings may be mid-boot */ }

  const rows = db.prepare(`
    SELECT id, party_roles, party_type, legacy_table, legacy_id
    FROM parties
    WHERE COALESCE(is_active, 1) = 1
  `).all();
  let synced = 0;
  let dualFixed = 0;
  for (const row of rows) {
    let roles = [];
    try { roles = row.party_roles ? JSON.parse(row.party_roles) : []; } catch (_) { roles = []; }
    const roleCustomer = roles.includes('customer') || row.party_type === 'customer' || row.party_type === 'both';
    if (!roleCustomer) continue;
    const linked = linkedCustomerIds(db, row.id);
    if (linked.length) {
      // Still ensure dual-role AR≠AP for supplier-first parties that already have a customer.
      if (roles.includes('supplier') || row.party_type === 'both' || row.party_type === 'supplier') {
        try {
          require('./party-tafsili').ensureDualRoleSeparateLeaves(db, row.id);
          dualFixed++;
        } catch (_) { /* optional */ }
      }
      continue;
    }
    try {
      syncPartyToLegacy(db, row.id);
      synced++;
    } catch (e) {
      console.warn('healCustomerRoleProjectionsV455 sync failed party', row.id, e.message);
    }
  }
  try {
    db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES (?, '1')").run(flagKey);
  } catch (_) { /* ignore */ }
  return { skipped: false, synced, dualFixed, scanned: rows.length };
}

module.exports = {
  syncCustomerToParty,
  syncSupplierToParty,
  syncPartyToLegacy,
  healCustomerRoleProjectionsV455,
  safeCustomerCoaMirror,
  deactivatePartyCascade,
  deactivatePartyFromCustomer,
  deactivatePartyFromSupplier,
  linkedCustomerIds,
  linkedSupplierIds,
  CRM_CUSTOMER_ACTIVE_SQL,
};
