// Dual-write shim: keep customers/suppliers tables in sync with unified parties table.

const { tomanToRial } = require('./money');

function syncCustomerToParty(db, customerId) {
  const c = db.prepare('SELECT * FROM customers WHERE id=?').get(customerId);
  if (!c) return null;
  if (c.party_id) {
    db.prepare(`
      UPDATE parties SET full_name=?, phone=?, city=?, notes=?, user_id=?, biz=?, owner=?, insta=?, status=?, type=?,
        national_id=?, economic_code=?, updated_at=strftime('%s','now')
      WHERE id=?
    `).run(c.owner || c.biz, c.phone || '-', c.city, c.note, c.user_id, c.biz, c.owner, c.insta, c.status, c.type,
      c.national_id, c.economic_code, c.party_id);
    return c.party_id;
  }
  const code = 'CUST-' + String(c.id).padStart(5, '0');
  const r = db.prepare(`
    INSERT INTO parties (person_code, party_type, full_name, phone, city, notes, user_id, biz, owner, insta, status, type,
      national_id, economic_code, credit_limit, legacy_table, legacy_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(code, 'customer', c.owner || c.biz, c.phone || '-', c.city, c.note, c.user_id, c.biz, c.owner, c.insta,
    c.status, c.type, c.national_id, c.economic_code, tomanToRial(c.credit_limit || 0), 'customers', c.id);
  db.prepare('UPDATE customers SET party_id=? WHERE id=?').run(r.lastInsertRowid, customerId);
  return r.lastInsertRowid;
}

function syncSupplierToParty(db, supplierId) {
  const s = db.prepare('SELECT * FROM suppliers WHERE id=?').get(supplierId);
  if (!s) return null;
  if (s.party_id) {
    db.prepare(`UPDATE parties SET full_name=?, phone=?, notes=?, biz=?, updated_at=strftime('%s','now') WHERE id=?`)
      .run(s.name, s.phone || '-', s.note, s.name, s.party_id);
    return s.party_id;
  }
  const code = 'SUPP-' + String(s.id).padStart(5, '0');
  const r = db.prepare(`
    INSERT INTO parties (person_code, party_type, full_name, phone, notes, biz, legacy_table, legacy_id)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(code, 'supplier', s.name, s.phone || '-', s.note, s.name, 'suppliers', s.id);
  db.prepare('UPDATE suppliers SET party_id=? WHERE id=?').run(r.lastInsertRowid, supplierId);
  return r.lastInsertRowid;
}

module.exports = { syncCustomerToParty, syncSupplierToParty };
