const router = require('express').Router();
const { getDB, audit, createPersonLedgerEntry } = require('../db');
const { auth, adminOrAccounting } = require('../middleware/auth');
const { todayJalali } = require('../jalali');

// General "Persons" module — for anyone who isn't already a customer or
// supplier (employees, partners, investors, contractors, service providers, ...).
// Customers and suppliers keep their own dedicated tables/ledgers (already
// deeply wired into invoicing/purchasing); this covers everyone else with
// user-defined categories, following the same debit/credit ledger convention.

const LIVE_BAL = "(SELECT COALESCE(SUM(pl.debit)-SUM(pl.credit),0) FROM person_ledger pl WHERE pl.person_id=p.id)";

// ---- Categories ----
router.get('/categories', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  res.json(db.prepare('SELECT * FROM person_categories ORDER BY name').all());
});

router.post('/categories', auth, adminOrAccounting, (req, res) => {
  const { name, nature } = req.body;
  if (!name) return res.status(400).json({ error: 'نام دسته الزامی است' });
  const db = getDB();
  const result = db.prepare('INSERT INTO person_categories (name,nature) VALUES (?,?)').run(name, nature === 'credit' ? 'credit' : 'debit');
  audit(req.user.id, 'create', 'person_category', result.lastInsertRowid, `ساخت دسته شخص ${name}`);
  res.json(db.prepare('SELECT * FROM person_categories WHERE id=?').get(result.lastInsertRowid));
});

router.put('/categories/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM person_categories WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  const { name, nature } = req.body;
  db.prepare('UPDATE person_categories SET name=?,nature=? WHERE id=?')
    .run(name || row.name, nature === 'credit' ? 'credit' : (nature === 'debit' ? 'debit' : row.nature), req.params.id);
  res.json({ ok: true });
});

router.delete('/categories/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const inUse = db.prepare('SELECT COUNT(*) c FROM persons WHERE category_id=?').get(req.params.id).c;
  if (inUse > 0) return res.status(400).json({ error: 'این دسته برای اشخاصی استفاده شده و قابل حذف نیست' });
  db.prepare('DELETE FROM person_categories WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ---- Persons ----
router.get('/', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const rows = db.prepare(`
    SELECT p.*, ${LIVE_BAL} AS balance, c.name as category_name, c.nature as category_nature
    FROM persons p LEFT JOIN person_categories c ON p.category_id=c.id
    ORDER BY p.name
  `).all();
  res.json(rows);
});

router.post('/', auth, adminOrAccounting, (req, res) => {
  const { category_id, name, phone, address, note, credit_limit, debit_limit, opening_balance } = req.body;
  if (!name) return res.status(400).json({ error: 'نام شخص الزامی است' });
  const db = getDB();
  const result = db.prepare(
    'INSERT INTO persons (category_id,name,phone,address,note,credit_limit,debit_limit) VALUES (?,?,?,?,?,?,?)'
  ).run(category_id || null, name, phone || '', address || '', note || '', parseFloat(credit_limit) || 0, parseFloat(debit_limit) || 0);
  const personId = result.lastInsertRowid;
  const ob = parseFloat(opening_balance) || 0;
  if (ob !== 0) {
    createPersonLedgerEntry(db, {
      person_id: personId, date: todayJalali(), entry_type: 'opening', ref_type: 'opening', ref_id: personId,
      description: 'مانده اولیه حساب', debit: ob > 0 ? ob : 0, credit: ob < 0 ? -ob : 0, user_id: req.user.id
    });
  }
  audit(req.user.id, 'create', 'person', personId, `ساخت شخص ${name}`);
  res.json(db.prepare('SELECT * FROM persons WHERE id=?').get(personId));
});

router.put('/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM persons WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  const { category_id, name, phone, address, note, credit_limit, debit_limit, active } = req.body;
  db.prepare('UPDATE persons SET category_id=?,name=?,phone=?,address=?,note=?,credit_limit=?,debit_limit=?,active=? WHERE id=?')
    .run(category_id || row.category_id, name || row.name, phone ?? row.phone, address ?? row.address, note ?? row.note,
         credit_limit !== undefined ? (parseFloat(credit_limit) || 0) : row.credit_limit,
         debit_limit !== undefined ? (parseFloat(debit_limit) || 0) : row.debit_limit,
         active != null ? (active ? 1 : 0) : row.active, req.params.id);
  audit(req.user.id, 'update', 'person', req.params.id, `ویرایش شخص ${name || row.name}`);
  res.json({ ok: true });
});

router.delete('/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM persons WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  const hasLedger = db.prepare('SELECT COUNT(*) c FROM person_ledger WHERE person_id=?').get(req.params.id).c;
  if (hasLedger > 0) return res.status(400).json({ error: 'این شخص دارای تراکنش در دفتر معین است و قابل حذف نیست — می‌توانید آن را غیرفعال کنید' });
  db.prepare('DELETE FROM persons WHERE id=?').run(req.params.id);
  audit(req.user.id, 'delete', 'person', req.params.id, `حذف شخص ${row.name}`);
  res.json({ ok: true });
});

// Ledger/statement — mirrors /suppliers ledger and /accounting/statement
router.get('/:id/ledger', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const person = db.prepare(`
    SELECT p.*, c.name as category_name, c.nature as category_nature
    FROM persons p LEFT JOIN person_categories c ON p.category_id=c.id WHERE p.id=?
  `).get(req.params.id);
  if (!person) return res.status(404).json({ error: 'شخص یافت نشد' });
  const entries = db.prepare(`
    SELECT pl.*, u.name as user_name FROM person_ledger pl LEFT JOIN users u ON pl.user_id=u.id
    WHERE pl.person_id=? ORDER BY pl.created_at ASC, pl.id ASC
  `).all(req.params.id);
  let balance = 0;
  entries.forEach(e => { balance += (e.debit || 0) - (e.credit || 0); e.running_balance = balance; });
  res.json({ person, entries, balance });
});

module.exports = router;
