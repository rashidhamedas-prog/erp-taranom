const router = require('express').Router();
const { getDB, audit } = require('../db');
const { auth, adminOnly, adminOrAccounting } = require('../middleware/auth');
const { tomanToRial } = require('../lib/money');
const { syncPartyToLegacy } = require('../lib/parties-sync');

const PARTY_TYPES = ['customer', 'supplier', 'both', 'other'];
const ROLE_KEYS = ['customer', 'supplier', 'employee', 'partner', 'marketer', 'other'];

function nextPartyCode(db) {
  const row = db.prepare("SELECT person_code FROM parties WHERE person_code GLOB 'P-[0-9]*' ORDER BY id DESC LIMIT 1").get();
  let n = 1;
  if (row?.person_code) {
    const m = row.person_code.match(/P-(\d+)/);
    if (m) n = parseInt(m[1], 10) + 1;
  }
  return `P-${String(n).padStart(5, '0')}`;
}

function parseRoles(raw, partyType) {
  if (Array.isArray(raw)) return raw.filter(r => ROLE_KEYS.includes(r));
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return arr.filter(r => ROLE_KEYS.includes(r));
    } catch (_) { /* fall through */ }
  }
  if (partyType === 'both') return ['customer', 'supplier'];
  if (partyType === 'supplier') return ['supplier'];
  if (partyType === 'other') return ['other'];
  return ['customer'];
}

function derivePartyType(roles) {
  const hasC = roles.includes('customer');
  const hasS = roles.includes('supplier');
  if (hasC && hasS) return 'both';
  if (hasS) return 'supplier';
  if (hasC) return 'customer';
  return 'other';
}

function mapPartyRow(row) {
  if (!row) return row;
  let party_roles = [];
  try { party_roles = row.party_roles ? JSON.parse(row.party_roles) : parseRoles(null, row.party_type); } catch (_) {
    party_roles = parseRoles(null, row.party_type);
  }
  return {
    ...row,
    party_roles,
    credit_limit_toman: row.credit_limit ? row.credit_limit / 10 : 0,
    opening_balance_toman: row.opening_balance ? row.opening_balance / 10 : 0,
  };
}

router.get('/', auth, (req, res) => {
  const db = getDB();
  const { type, segment, city, search, party_group_id, page = 1, limit = 50 } = req.query;
  let sql = `
    SELECT p.*, pg.name AS party_group_name
    FROM parties p
    LEFT JOIN party_groups pg ON p.party_group_id = pg.id
    WHERE p.is_active=1
  `;
  const params = [];
  if (type) { sql += ' AND p.party_type=?'; params.push(type); }
  if (party_group_id) { sql += ' AND p.party_group_id=?'; params.push(parseInt(party_group_id, 10)); }
  if (segment) { sql += ' AND p.segment=?'; params.push(segment); }
  if (city) { sql += ' AND p.city=?'; params.push(city); }
  if (search) {
    sql += ' AND (p.full_name LIKE ? OR p.company_name LIKE ? OR p.phone LIKE ? OR p.person_code LIKE ? OR p.mobile LIKE ? OR p.coa_code LIKE ?)';
    const q = '%' + search + '%';
    params.push(q, q, q, q, q, q);
  }
  const total = db.prepare(sql.replace('SELECT p.*, pg.name AS party_group_name', 'SELECT COUNT(*) AS c')).get(...params)?.c || 0;
  sql += ' ORDER BY p.id DESC LIMIT ? OFFSET ?';
  params.push(Math.min(200, parseInt(limit, 10) || 50), (Math.max(1, parseInt(page, 10)) - 1) * (parseInt(limit, 10) || 50));
  const rows = db.prepare(sql).all(...params).map(mapPartyRow);
  res.json({ success: true, data: rows, pagination: { page: parseInt(page, 10) || 1, limit: parseInt(limit, 10) || 50, total } });
});

router.get('/:id', auth, (req, res) => {
  const db = getDB();
  const row = db.prepare(`
    SELECT p.*, pg.name AS party_group_name
    FROM parties p LEFT JOIN party_groups pg ON p.party_group_id = pg.id
    WHERE p.id=?
  `).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  res.json({ success: true, data: mapPartyRow(row) });
});

router.post('/', auth, adminOrAccounting, (req, res) => {
  const b = req.body;
  const roles = parseRoles(b.party_roles, b.party_type);
  const partyType = PARTY_TYPES.includes(b.party_type) ? b.party_type : derivePartyType(roles);
  if (!b.full_name && !b.company_name) return res.status(400).json({ error: 'نام الزامی است' });
  if (!b.phone) return res.status(400).json({ error: 'تلفن الزامی است' });

  const db = getDB();
  const personCode = b.person_code || nextPartyCode(db);
  const creditRial = b.credit_limit_rial != null ? parseInt(b.credit_limit_rial, 10) : tomanToRial(b.credit_limit || 0);
  const openRial = b.opening_balance_rial != null ? parseInt(b.opening_balance_rial, 10) : tomanToRial(b.opening_balance || 0);
  const pgid = b.party_group_id ? parseInt(b.party_group_id, 10) : null;

  try {
    const r = db.prepare(`
      INSERT INTO parties (
        person_code, party_type, party_roles, legal_type, full_name, company_name,
        national_id, economic_code, phone, secondary_phone, mobile, fax, email,
        city, province, address, postal_code, segment, store_type, source,
        credit_limit, opening_balance, opening_balance_date, notes,
        user_id, biz, owner, insta, status, type,
        party_group_id, prefix, birth_date, referrer, account_nature, coa_code
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      personCode, partyType, JSON.stringify(roles), b.legal_type || 'real', b.full_name || b.company_name, b.company_name || null,
      b.national_id || null, b.economic_code || null, b.phone, b.secondary_phone || b.phone2 || null, b.mobile || null, b.fax || null, b.email || null,
      b.city || null, b.province || null, b.address || null, b.postal_code || null,
      b.segment || 'C', b.store_type || null, b.source || null,
      creditRial, openRial, b.opening_balance_date || null, b.notes || null,
      b.user_id || req.user.id, b.biz || b.company_name || b.full_name, b.owner || null,
      b.insta || null, b.status || 'new', b.type || 'بوتیک',
      pgid, b.prefix || null, b.birth_date || null, b.referrer || null, b.account_nature || null, b.coa_code || null
    );
    audit(req.user.id, 'create', 'party', r.lastInsertRowid, personCode);
    try { syncPartyToLegacy(db, r.lastInsertRowid); } catch (_) {}
    const row = db.prepare('SELECT * FROM parties WHERE id=?').get(r.lastInsertRowid);
    res.status(201).json({ success: true, data: mapPartyRow(row) });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'کد یا تلفن تکراری است' });
    throw e;
  }
});

router.put('/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM parties WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  const b = req.body;
  const roles = b.party_roles ? parseRoles(b.party_roles, row.party_type) : parseRoles(row.party_roles, row.party_type);
  const partyType = b.party_type && PARTY_TYPES.includes(b.party_type) ? b.party_type : derivePartyType(roles);
  const creditRial = b.credit_limit_rial != null ? parseInt(b.credit_limit_rial, 10)
    : (b.credit_limit != null ? tomanToRial(b.credit_limit) : row.credit_limit);
  const pgid = b.party_group_id != null ? (b.party_group_id ? parseInt(b.party_group_id, 10) : null) : row.party_group_id;

  db.prepare(`
    UPDATE parties SET
      full_name=?, company_name=?, phone=?, secondary_phone=?, mobile=?, fax=?, email=?,
      city=?, province=?, address=?, postal_code=?, segment=?,
      national_id=?, economic_code=?, credit_limit=?, notes=?,
      biz=?, owner=?, insta=?, status=?, type=?, party_type=?, party_roles=?,
      party_group_id=?, prefix=?, birth_date=?, referrer=?, account_nature=?, coa_code=?,
      updated_at=strftime('%s','now')
    WHERE id=?
  `).run(
    b.full_name || row.full_name, b.company_name ?? row.company_name,
    b.phone || row.phone, b.secondary_phone ?? b.phone2 ?? row.secondary_phone,
    b.mobile ?? row.mobile, b.fax ?? row.fax, b.email ?? row.email,
    b.city ?? row.city, b.province ?? row.province, b.address ?? row.address, b.postal_code ?? row.postal_code,
    b.segment ?? row.segment, b.national_id ?? row.national_id, b.economic_code ?? row.economic_code,
    creditRial, b.notes ?? row.notes,
    b.biz ?? row.biz, b.owner ?? row.owner, b.insta ?? row.insta, b.status ?? row.status, b.type ?? row.type,
    partyType, JSON.stringify(roles), pgid,
    b.prefix ?? row.prefix, b.birth_date ?? row.birth_date, b.referrer ?? row.referrer,
    b.account_nature ?? row.account_nature, b.coa_code ?? row.coa_code,
    req.params.id
  );
  audit(req.user.id, 'update', 'party', req.params.id, '');
  try { syncPartyToLegacy(db, req.params.id); } catch (_) {}
  res.json({ success: true, data: mapPartyRow(db.prepare('SELECT * FROM parties WHERE id=?').get(req.params.id)) });
});

router.delete('/:id', auth, adminOnly, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM parties WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  db.prepare('UPDATE parties SET is_active=0 WHERE id=?').run(req.params.id);
  audit(req.user.id, 'delete', 'party', req.params.id, 'soft');
  res.json({ success: true, message: 'غیرفعال شد' });
});

module.exports = router;
