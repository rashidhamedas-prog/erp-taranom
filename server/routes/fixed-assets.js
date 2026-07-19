const router = require('express').Router();
const { getDB, audit } = require('../db');
const { auth, adminOrAccounting, adminOnly } = require('../middleware/auth');
const { todayJalali } = require('../jalali');
const { acct } = require('../lib/coa-map');
const { postToLedger } = require('../lib/ledger');

router.get('/', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  res.json(db.prepare(`
    SELECT *, (cost_rial - accumulated_depreciation_rial) AS book_value_rial
    FROM fixed_assets WHERE status='active' ORDER BY code
  `).all());
});

router.post('/', auth, adminOrAccounting, (req, res) => {
  const b = req.body;
  if (!b.name || !b.cost_rial) return res.status(400).json({ error: 'نام و بهای دارایی الزامی است' });
  const db = getDB();
  const code = b.code || ('FA-' + String(Date.now()).slice(-6));
  const r = db.prepare(`
    INSERT INTO fixed_assets (code,name,category,purchase_date,cost_rial,salvage_rial,useful_life_months,location,notes,coa_asset_code)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(code, b.name, b.category || '', b.purchase_date || todayJalali(),
    parseInt(b.cost_rial, 10), parseInt(b.salvage_rial || 0, 10),
    parseInt(b.useful_life_months || 60, 10), b.location || '', b.notes || '',
    b.coa_asset_code || '1201');
  audit(req.user.id, 'create', 'fixed_asset', r.lastInsertRowid, code);
  res.json(db.prepare('SELECT * FROM fixed_assets WHERE id=?').get(r.lastInsertRowid));
});

router.put('/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM fixed_assets WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  const b = req.body;
  db.prepare(`
    UPDATE fixed_assets SET name=?, category=?, location=?, notes=?, salvage_rial=?, useful_life_months=?
    WHERE id=?
  `).run(b.name || row.name, b.category ?? row.category, b.location ?? row.location,
    b.notes ?? row.notes, b.salvage_rial != null ? parseInt(b.salvage_rial, 10) : row.salvage_rial,
    b.useful_life_months != null ? parseInt(b.useful_life_months, 10) : row.useful_life_months, req.params.id);
  res.json({ ok: true });
});

router.post('/run-depreciation', auth, adminOnly, (req, res) => {
  const db = getDB();
  const period = req.body.period_label || todayJalali().slice(0, 7);
  const assets = db.prepare("SELECT * FROM fixed_assets WHERE status='active'").all();
  let totalDep = 0;
  const lines = [];

  db.transaction(() => {
    for (const a of assets) {
      const months = a.useful_life_months || 60;
      const depreciable = Math.max(0, a.cost_rial - (a.salvage_rial || 0));
      const monthly = Math.round(depreciable / months);
      if (monthly <= 0) continue;
      const remaining = depreciable - (a.accumulated_depreciation_rial || 0);
      const amt = Math.min(monthly, remaining);
      if (amt <= 0) continue;
      totalDep += amt;
      db.prepare('UPDATE fixed_assets SET accumulated_depreciation_rial=accumulated_depreciation_rial+? WHERE id=?').run(amt, a.id);
      db.prepare('INSERT INTO fixed_asset_depreciation (asset_id, period_label, amount_rial) VALUES (?,?,?)').run(a.id, period, amt);
    }
    if (totalDep > 0) {
      const exp = acct(db, 'coa_depreciation_expense');
      const acc = acct(db, 'coa_accumulated_depreciation');
      postToLedger(db, {
        sourceType: 'depreciation', sourceId: period, date: todayJalali(),
        description: `استهلاک دارایی — ${period}`,
        createdBy: req.user.id,
        lines: [
          { code: exp.code, name: exp.name, debit: totalDep / 10, credit: 0, debit_rial: totalDep },
          { code: acc.code, name: acc.name, debit: 0, credit: totalDep / 10, credit_rial: totalDep },
        ],
      });
    }
  })();

  audit(req.user.id, 'depreciation_run', 'fixed_assets', null, `${period}: ${totalDep} ریال`);
  res.json({ success: true, data: { period, total_depreciation_rial: totalDep, asset_count: assets.length } });
});

module.exports = router;
