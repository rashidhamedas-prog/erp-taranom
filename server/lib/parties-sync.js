// Dual-write shim: keep customers/suppliers tables in sync with unified parties table.

function syncCustomerToParty(db, customerId) {
  const c = db.prepare('SELECT * FROM customers WHERE id=?').get(customerId);
  if (!c) return null;
  if (c.party_id) {
    db.prepare(`
      UPDATE parties SET full_name=?, phone=?, city=?, notes=?, user_id=?, biz=?, owner=?, insta=?, status=?, type=?,
        national_id=?, economic_code=?, party_group_id=?, prefix=?, secondary_phone=?, fax=?, mobile=?, email=?,
        postal_code=?, birth_date=?, referrer=?, company_name=?, account_nature=?, coa_code=?,
        updated_at=strftime('%s','now')
      WHERE id=?
    `).run(c.owner || c.biz, c.phone || '-', c.city, c.note, c.user_id, c.biz, c.owner, c.insta, c.status, c.type,
      c.national_id, c.economic_code, c.party_group_id || null, c.prefix || null, c.phone2 || null, c.fax || null,
      c.mobile || null, c.email || null, c.postal_code || null, c.birth_date || null, c.referrer || null,
      c.company_name || null, c.account_nature || null, c.coa_code || null, c.party_id);
    return c.party_id;
  }
  const code = 'CUST-' + String(c.id).padStart(5, '0');
  const r = db.prepare(`
    INSERT INTO parties (person_code, party_type, party_roles, full_name, phone, city, notes, user_id, biz, owner, insta, status, type,
      national_id, economic_code, credit_limit, legacy_table, legacy_id, party_group_id, prefix, secondary_phone, fax, mobile, email,
      postal_code, birth_date, referrer, company_name, account_nature, coa_code)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(code, 'customer', '["customer"]', c.owner || c.biz, c.phone || '-', c.city, c.note, c.user_id, c.biz, c.owner, c.insta,
    c.status, c.type, c.national_id, c.economic_code, Math.round(Number(c.credit_limit) || 0), 'customers', c.id,
    c.party_group_id || null, c.prefix || null, c.phone2 || null, c.fax || null, c.mobile || null, c.email || null,
    c.postal_code || null, c.birth_date || null, c.referrer || null, c.company_name || null, c.account_nature || null, c.coa_code || null);
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

function syncPartyToLegacy(db, partyId) {
  const p = db.prepare('SELECT * FROM parties WHERE id=?').get(partyId);
  if (!p) return;
  const roles = (() => {
    try { return p.party_roles ? JSON.parse(p.party_roles) : []; } catch (_) { return []; }
  })();
  // Only sync to CRM customers panel when party group is customer-type (or no group + customer role).
  let groupEntity = null;
  if (p.party_group_id) {
    const g = db.prepare('SELECT entity_type FROM party_groups WHERE id=?').get(p.party_group_id);
    groupEntity = g?.entity_type || null;
  }
  const roleCustomer = roles.includes('customer') || p.party_type === 'customer' || p.party_type === 'both';
  const roleSupplier = roles.includes('supplier') || p.party_type === 'supplier' || p.party_type === 'both';
  const isCustomer = roleCustomer && (groupEntity == null || groupEntity === 'customer' || groupEntity === 'all');
  const isSupplier = roleSupplier;

  if (isCustomer) {
    let cust = p.legacy_table === 'customers' && p.legacy_id
      ? db.prepare('SELECT * FROM customers WHERE id=?').get(p.legacy_id)
      : db.prepare('SELECT * FROM customers WHERE party_id=?').get(partyId);
    if (!cust) {
      const r = db.prepare(`
        INSERT INTO customers (user_id,biz,owner,city,province,address,phone,insta,type,status,note,party_id,party_group_id,
          prefix,phone2,fax,mobile,email,economic_code,postal_code,national_id,referrer,birth_date,company_name,account_nature,coa_code,created_by,balance)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(p.user_id || 1, p.biz || p.full_name, p.owner || '', p.city || '', p.province || '', p.address || '',
        p.phone, p.insta || '', p.type || 'بوتیک', p.status || 'new', p.notes || '', partyId, p.party_group_id || null,
        p.prefix || '', p.secondary_phone || '', p.fax || '', p.mobile || '', p.email || '', p.economic_code || '',
        p.postal_code || '', p.national_id || '', p.referrer || '', p.birth_date || '', p.company_name || '',
        p.account_nature || '', p.coa_code || '', p.user_id || 1, p.opening_balance != null ? Number(p.opening_balance) : 0);
      db.prepare('UPDATE parties SET legacy_table=?, legacy_id=? WHERE id=?').run('customers', r.lastInsertRowid, partyId);
    } else {
      db.prepare(`
        UPDATE customers SET biz=?, owner=?, city=?, province=?, address=?, phone=?, insta=?, type=?, status=?, note=?,
          party_id=?, party_group_id=?, prefix=?, phone2=?, fax=?, mobile=?, email=?, economic_code=?, postal_code=?,
          national_id=?, referrer=?, birth_date=?, company_name=?, account_nature=?, coa_code=?
        WHERE id=?
      `).run(p.biz || p.full_name, p.owner || '', p.city || '', p.province || '', p.address || '', p.phone,
        p.insta || '', p.type || 'بوتیک', p.status || 'new', p.notes || '', partyId, p.party_group_id || null,
        p.prefix || '', p.secondary_phone || '', p.fax || '', p.mobile || '', p.email || '', p.economic_code || '',
        p.postal_code || '', p.national_id || '', p.referrer || '', p.birth_date || '', p.company_name || '',
        p.account_nature || '', p.coa_code || '', cust.id);
    }
  }

  if (isSupplier) {
    let sup = p.legacy_table === 'suppliers' && p.legacy_id
      ? db.prepare('SELECT * FROM suppliers WHERE id=?').get(p.legacy_id)
      : db.prepare('SELECT * FROM suppliers WHERE party_id=?').get(partyId);
    const name = p.company_name || p.full_name || p.biz;
    if (!sup) {
      const r = db.prepare(`
        INSERT INTO suppliers (name,phone,address,note,party_id,party_group_id,coa_code)
        VALUES (?,?,?,?,?,?,?)
      `).run(name, p.phone || '', p.address || '', p.notes || '', partyId, p.party_group_id || null, p.coa_code || '');
      if (!isCustomer) db.prepare('UPDATE parties SET legacy_table=?, legacy_id=? WHERE id=?').run('suppliers', r.lastInsertRowid, partyId);
    } else {
      db.prepare(`
        UPDATE suppliers SET name=?, phone=?, address=?, note=?, party_id=?, party_group_id=?, coa_code=? WHERE id=?
      `).run(name, p.phone || '', p.address || '', p.notes || '', partyId, p.party_group_id || null, p.coa_code || '', sup.id);
    }
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

function deactivatePartyCascade(db, partyId) {
  const row = db.prepare('SELECT * FROM parties WHERE id=?').get(partyId);
  if (!row) return { ok: false, reason: 'not_found' };
  db.prepare("UPDATE parties SET is_active=0, updated_at=strftime('%s','now') WHERE id=?").run(partyId);
  const custIds = linkedCustomerIds(db, partyId);
  const suppIds = linkedSupplierIds(db, partyId);
  for (const id of custIds) removeCrmCustomerSide(db, id);
  for (const id of suppIds) removeSupplierSide(db, id);
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

module.exports = {
  syncCustomerToParty,
  syncSupplierToParty,
  syncPartyToLegacy,
  deactivatePartyCascade,
  deactivatePartyFromCustomer,
  deactivatePartyFromSupplier,
  linkedCustomerIds,
  CRM_CUSTOMER_ACTIVE_SQL,
};
