// Dual-write shim: keep customers/suppliers tables in sync with unified parties table.

const { tomanToRial } = require('./money');

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
    c.status, c.type, c.national_id, c.economic_code, tomanToRial(c.credit_limit || 0), 'customers', c.id,
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
  const isCustomer = roles.includes('customer') || p.party_type === 'customer' || p.party_type === 'both';
  const isSupplier = roles.includes('supplier') || p.party_type === 'supplier' || p.party_type === 'both';

  if (isCustomer) {
    let cust = p.legacy_table === 'customers' && p.legacy_id
      ? db.prepare('SELECT * FROM customers WHERE id=?').get(p.legacy_id)
      : db.prepare('SELECT * FROM customers WHERE party_id=?').get(partyId);
    if (!cust) {
      const r = db.prepare(`
        INSERT INTO customers (user_id,biz,owner,city,province,address,phone,insta,type,status,note,party_id,party_group_id,
          prefix,phone2,fax,mobile,email,economic_code,postal_code,national_id,referrer,birth_date,company_name,account_nature,coa_code)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(p.user_id || 1, p.biz || p.full_name, p.owner || '', p.city || '', p.province || '', p.address || '',
        p.phone, p.insta || '', p.type || 'بوتیک', p.status || 'new', p.notes || '', partyId, p.party_group_id || null,
        p.prefix || '', p.secondary_phone || '', p.fax || '', p.mobile || '', p.email || '', p.economic_code || '',
        p.postal_code || '', p.national_id || '', p.referrer || '', p.birth_date || '', p.company_name || '',
        p.account_nature || '', p.coa_code || '');
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

module.exports = { syncCustomerToParty, syncSupplierToParty, syncPartyToLegacy };
