const router = require('express').Router();
const { getDB, audit } = require('../db');
const { auth, adminOnly, adminOrAccounting } = require('../middleware/auth');
const { tomanToRial } = require('../lib/money');

// Unified parties — spec §2.1 (replaces customers + suppliers + old persons over time)

const PARTY_TYPES = ['customer', 'supplier', 'both', 'other'];

function nextPartyCode(db, partyType) {
  const prefix = { customer: 'CUST', supplier: 'SUPP', both: 'PART', other: 'PART' }[partyType] || 'PART';
  const row = db.prepare("SELECT person_code FROM parties WHERE person_code LIKE ? ORDER BY id DESC LIMIT 1").get(prefix + '-%');
  let n = 1;
  if (row?.person_code) {
    const m = row.person_code.match(/(\d+)$/);
    if (m) n = parseInt(m[1], 10) + 1;
  }
  return `${prefix}-${String(n).padStart(5, '0')}`;
}

function mapPartyRow(row) {
  if (!row) return row;
  return {
    ...row,
    credit_limit_toman: row.credit_limit ? row.credit_limit / 10 : 0,
    opening_balance_toman: row.opening_balance ? row.opening_balance / 10 : 0,
  };
}

router.get('/', auth, (req, res) => {
  const db = getDB();
  const { type, segment, city, search, page = 1, limit = 50 } = req.query;
  let sql = 'SELECT * FROM parties WHERE is_active=1';
  const params = [];
  if (type) { sql += ' AND party_type=?'; params.push(type); }
  if (segment) { sql += ' AND segment=?'; params.push(segment); }
  if (city) { sql += ' AND city=?'; params.push(city); }
  if (search) {
    sql += ' AND (full_name LIKE ? OR company_name LIKE ? OR phone LIKE ? OR person_code LIKE ?)';
    const q = '%' + search + '%';
    params.push(q, q, q, q);
  }
  const total = db.prepare(sql.replace('SELECT *', 'SELECT COUNT(*) AS c')).get(...params)?.c || 0;
  sql += ' ORDER BY id DESC LIMIT ? OFFSET ?';
  params.push(Math.min(200, parseInt(limit, 10) || 50), (Math.max(1, parseInt(page, 10)) - 1) * (parseInt(limit, 10) || 50));
  const rows = db.prepare(sql).all(...params).map(mapPartyRow);
  res.json({ success: true, data: rows, pagination: { page: parseInt(page, 10) || 1, limit: parseInt(limit, 10) || 50, total } });
});

router.get('/:id', auth, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM parties WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  res.json({ success: true, data: mapPartyRow(row) });
});

router.post('/', auth, adminOrAccounting, (req, res) => {
  const b = req.body;
  const partyType = PARTY_TYPES.includes(b.party_type) ? b.party_type : 'customer';
  if (!b.full_name && !b.company_name) return res.status(400).json({ error: 'نام الزامی است' });
  if (!b.phone) return res.status(400).json({ error: 'تلفن الزامی است' });

  const db = getDB();
  const personCode = b.person_code || nextPartyCode(db, partyType);
  const creditRial = b.credit_limit_rial != null ? parseInt(b.credit_limit_rial, 10) : tomanToRial(b.credit_limit || 0);
  const openRial = b.opening_balance_rial != null ? parseInt(b.opening_balance_rial, 10) : tomanToRial(b.opening_balance || 0);

  try {
    const r = db.prepare(`
      INSERT INTO parties (
        person_code, party_type, legal_type, full_name, company_name,
        national_id, economic_code, phone, secondary_phone, email,
        city, province, address, postal_code, segment, store_type, source,
        credit_limit, opening_balance, opening_balance_date, notes,
        user_id, biz, owner, insta, status, type
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      personCode, partyType, b.legal_type || 'real', b.full_name || b.company_name, b.company_name || null,
      b.national_id || null, b.economic_code || null, b.phone, b.secondary_phone || null, b.email || null,
      b.city || null, b.province || null, b.address || null, b.postal_code || null,
      b.segment || 'C', b.store_type || null, b.source || null,
      creditRial, openRial, b.opening_balance_date || null, b.notes || null,
      b.user_id || req.user.id, b.biz || b.company_name || b.full_name, b.owner || null,
      b.insta || null, b.status || 'new', b.type || 'بوتیک'
    );
    audit(req.user.id, 'create', 'party', r.lastInsertRowid, personCode);
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
  const creditRial = b.credit_limit_rial != null ? parseInt(b.credit_limit_rial, 10)
    : (b.credit_limit != null ? tomanToRial(b.credit_limit) : row.credit_limit);
  db.prepare(`
    UPDATE parties SET
      full_name=?, company_name=?, phone=?, secondary_phone=?, email=?,
      city=?, province=?, address=?, postal_code=?, segment=?,
      national_id=?, economic_code=?, credit_limit=?, notes=?,
      biz=?, owner=?, insta=?, status=?, type=?, party_type=?, updated_at=strftime('%s','now')
    WHERE id=?
  `).run(
    b.full_name || row.full_name, b.company_name ?? row.company_name,
    b.phone || row.phone, b.secondary_phone ?? row.secondary_phone, b.email ?? row.email,
    b.city ?? row.city, b.province ?? row.province, b.address ?? row.address, b.postal_code ?? row.postal_code,
    b.segment ?? row.segment, b.national_id ?? row.national_id, b.economic_code ?? row.economic_code,
    creditRial, b.notes ?? row.notes,
    b.biz ?? row.biz, b.owner ?? row.owner, b.insta ?? row.insta, b.status ?? row.status, b.type ?? row.type,
    b.party_type || row.party_type, req.params.id
  );
  audit(req.user.id, 'update', 'party', req.params.id, '');
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
