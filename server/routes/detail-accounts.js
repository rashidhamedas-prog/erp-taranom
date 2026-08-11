const router = require('express').Router();
const { getDB, audit } = require('../db');
const { auth, adminOrAccounting } = require('../middleware/auth');

// Level-4 detail accounts — spec §2.15–2.17

router.get('/categories', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  res.json(db.prepare('SELECT * FROM detail_categories WHERE is_active=1 ORDER BY code').all());
});

router.post('/categories', auth, adminOrAccounting, (req, res) => {
  const { code, name } = req.body;
  if (!code || !name) return res.status(400).json({ error: 'کد و نام الزامی است' });
  const db = getDB();
  try {
    const r = db.prepare('INSERT INTO detail_categories (code,name) VALUES (?,?)').run(code, name);
    audit(req.user.id, 'create', 'detail_category', r.lastInsertRowid, name);
    res.json(db.prepare('SELECT * FROM detail_categories WHERE id=?').get(r.lastInsertRowid));
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'کد تکراری است' });
    throw e;
  }
});

router.get('/', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const { category, search } = req.query;
  let sql = `
    SELECT d.*, dc.name AS category_name
    FROM detail_accounts d
    LEFT JOIN detail_categories dc ON dc.id=d.detail_category_id
    WHERE d.is_active=1
  `;
  const params = [];
  if (category) { sql += ' AND dc.code=?'; params.push(category); }
  if (search) { sql += ' AND (d.code LIKE ? OR d.name LIKE ?)'; params.push('%' + search + '%', '%' + search + '%'); }
  sql += ' ORDER BY d.code';
  res.json(db.prepare(sql).all(...params));
});

router.post('/', auth, adminOrAccounting, (req, res) => {
  const { code, name, detail_category_id, linked_table, linked_id, is_active } = req.body;
  if (!code || !name) return res.status(400).json({ error: 'کد و نام الزامی است' });
  const db = getDB();
  try {
    const r = db.prepare(`
      INSERT INTO detail_accounts (code,name,detail_category_id,linked_table,linked_id,is_active)
      VALUES (?,?,?,?,?,?)
    `).run(code, name, detail_category_id || null, linked_table || null, linked_id || null,
      is_active === false || is_active === 0 ? 0 : 1);
    audit(req.user.id, 'create', 'detail_account', r.lastInsertRowid, code);
    res.json(db.prepare('SELECT * FROM detail_accounts WHERE id=?').get(r.lastInsertRowid));
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'کد تفضیلی تکراری است' });
    throw e;
  }
});

router.post('/auto-for-party', auth, adminOrAccounting, (req, res) => {
  const { party_id, party_type, name } = req.body;
  if (!party_id || !party_type || !name) return res.status(400).json({ error: 'party_id, party_type, name الزامی است' });
  const db = getDB();
  const prefix = { customer: 'CUST', supplier: 'SUPP', both: 'PART', other: 'PART' }[party_type] || 'PART';
  const cat = db.prepare("SELECT id FROM detail_categories WHERE code='person'").get();
  const existing = db.prepare("SELECT * FROM detail_accounts WHERE linked_table='parties' AND linked_id=?").get(party_id);
  if (existing) return res.json(existing);
  const num = String(party_id).padStart(5, '0');
  const code = `${prefix}-${num}`;
  const r = db.prepare(`
    INSERT INTO detail_accounts (code,name,detail_category_id,linked_table,linked_id)
    VALUES (?,?,?,?,?)
  `).run(code, name, cat?.id || null, 'parties', party_id);
  const row = db.prepare('SELECT * FROM detail_accounts WHERE id=?').get(r.lastInsertRowid);
  db.prepare('UPDATE parties SET detail_account_id=? WHERE id=?').run(r.lastInsertRowid, party_id);
  res.json(row);
});

module.exports = router;
