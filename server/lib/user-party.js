const { allocTafsili } = require('./coa-map');

const SALES_ROLES = new Set(['salesperson', 'field_sales', 'inside_sales', 'distribution_office', 'sales_manager']);

function parseRoles(raw) {
  try {
    const roles = JSON.parse(raw || '[]');
    return Array.isArray(roles) ? roles : [];
  } catch (_) {
    return [];
  }
}

function partyRolesForUser(role, current = []) {
  const roles = new Set(current);
  roles.add('employee');
  if (SALES_ROLES.has(role)) roles.add('marketer');
  else roles.delete('marketer');
  return [...roles];
}

function nextUserPartyCode(db, userId) {
  const preferred = `USER-${String(userId).padStart(5, '0')}`;
  if (!db.prepare('SELECT 1 FROM parties WHERE person_code=?').get(preferred)) return preferred;
  let suffix = 1;
  while (db.prepare('SELECT 1 FROM parties WHERE person_code=?').get(`${preferred}-${suffix}`)) suffix++;
  return `${preferred}-${suffix}`;
}

function choose(value, fallback) {
  return value === undefined ? fallback : value;
}

function ensureUserParty(db, userId, details = {}) {
  details = { ...details, ...(details.person || {}) };
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(userId);
  if (!user) throw new Error('کاربر یافت نشد');

  let party = null;
  const requestedPartyId = details.party_id ? Number(details.party_id) : null;
  if (requestedPartyId) party = db.prepare('SELECT * FROM parties WHERE id=?').get(requestedPartyId);
  if (requestedPartyId && !party) throw new Error('شخص انتخاب‌شده یافت نشد');
  if (!party && user.party_id) party = db.prepare('SELECT * FROM parties WHERE id=?').get(user.party_id);

  const source = party || {};
  const fullName = String(choose(details.full_name, choose(details.person_full_name, user.name)) || user.name).trim();
  const phone = String(choose(details.person_phone, choose(details.phone, user.phone || source.phone || '')) || '').trim();
  const roles = partyRolesForUser(user.role, parseRoles(source.party_roles));
  const values = {
    legal_type: choose(details.legal_type, source.legal_type || 'real'),
    company_name: choose(details.company_name, source.company_name || null),
    national_id: choose(details.national_id, source.national_id || null),
    economic_code: choose(details.economic_code, source.economic_code || null),
    secondary_phone: choose(details.secondary_phone, source.secondary_phone || null),
    mobile: choose(details.mobile, source.mobile || phone || null),
    fax: choose(details.fax, source.fax || null),
    email: choose(details.email, source.email || null),
    city: choose(details.city, source.city || null),
    province: choose(details.province, source.province || null),
    address: choose(details.address, source.address || null),
    postal_code: choose(details.postal_code, source.postal_code || null),
    birth_date: choose(details.birth_date, source.birth_date || null),
    notes: choose(details.person_notes, choose(details.notes, source.notes || null)),
    party_group_id: details.party_group_id === '' ? null : choose(details.party_group_id, source.party_group_id || null),
    account_nature: choose(details.account_nature, source.account_nature || null),
  };

  let partyId;
  if (party) {
    db.prepare(`
      UPDATE parties SET full_name=?,phone=?,party_roles=?,legal_type=?,company_name=?,
        national_id=?,economic_code=?,secondary_phone=?,mobile=?,fax=?,email=?,city=?,province=?,address=?,
        postal_code=?,birth_date=?,notes=?,party_group_id=?,account_nature=?,is_active=1,
        biz=?,updated_at=strftime('%s','now') WHERE id=?
    `).run(
      fullName, phone, JSON.stringify(roles), values.legal_type, values.company_name,
      values.national_id, values.economic_code, values.secondary_phone, values.mobile, values.fax,
      values.email, values.city, values.province, values.address, values.postal_code, values.birth_date,
      values.notes, values.party_group_id, values.account_nature, fullName, party.id
    );
    partyId = party.id;
  } else {
    let coaCode = null;
    try { coaCode = allocTafsili(db, 'person', fullName); } catch (_) { /* optional in legacy bootstrap */ }
    const result = db.prepare(`
      INSERT INTO parties (
        person_code,party_type,party_roles,legal_type,full_name,company_name,national_id,economic_code,
        phone,secondary_phone,mobile,fax,email,city,province,address,postal_code,birth_date,notes,
        party_group_id,account_nature,coa_code,biz,is_active
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)
    `).run(
      nextUserPartyCode(db, user.id), 'other', JSON.stringify(roles), values.legal_type, fullName,
      values.company_name, values.national_id, values.economic_code, phone, values.secondary_phone,
      values.mobile, values.fax, values.email, values.city, values.province, values.address,
      values.postal_code, values.birth_date, values.notes, values.party_group_id, values.account_nature,
      coaCode, fullName
    );
    partyId = result.lastInsertRowid;
  }

  db.prepare('UPDATE users SET party_id=? WHERE id=?').run(partyId, user.id);
  return db.prepare('SELECT * FROM parties WHERE id=?').get(partyId);
}

function ensureAllUserParties(db) {
  const users = db.prepare('SELECT id FROM users WHERE party_id IS NULL OR party_id NOT IN (SELECT id FROM parties)').all();
  const tx = db.transaction(() => {
    for (const user of users) ensureUserParty(db, user.id);
  });
  tx();
  return users.length;
}

module.exports = { ensureUserParty, ensureAllUserParties, partyRolesForUser };
