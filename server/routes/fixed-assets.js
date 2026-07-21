const router = require('express').Router();
const { getDB, audit } = require('../db');
const { auth, adminOrAccounting, adminOnly } = require('../middleware/auth');
const { todayJalali } = require('../jalali');
const { acct } = require('../lib/coa-map');
const { postToLedger } = require('../lib/ledger');
const { rialToLedger } = require('../lib/money');
const { resolveCashAccount } = require('../db');

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
      let monthly;
      if (a.depreciation_method === 'declining') {
        const bookVal = Math.max(0, a.cost_rial - (a.accumulated_depreciation_rial || 0));
        const rate = (Number(a.declining_rate_pct) || 25) / 100;
        monthly = Math.round(bookVal * rate / 12);
      } else {
        monthly = Math.round(depreciable / months);
      }
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

router.post('/:id/dispose', auth, adminOrAccounting, (req, res) => {
  try {
    const db = getDB();
    const asset = db.prepare("SELECT * FROM fixed_assets WHERE id=? AND status='active'").get(req.params.id);
    if (!asset) return res.status(404).json({ error: 'دارایی فعال یافت نشد' });

    const proceedsRial = Math.round(Number(req.body.proceeds_rial) || 0);
    const disposeDate = req.body.date || todayJalali();
    const bookValue = Math.max(0, asset.cost_rial - (asset.accumulated_depreciation_rial || 0));
    const gainLoss = proceedsRial - bookValue;

    const assetAcct = acct(db, 'coa_fixed_assets');
    const accumAcct = acct(db, 'coa_accumulated_depreciation');
    const cashAcct = resolveCashAccount(db, req.body.pay_type || 'cash', req.body.bank_id, req.body.cash_box_id);
    const gainAcct = acct(db, 'coa_asset_disposal_gain');
    const lossAcct = acct(db, 'coa_asset_disposal_loss');

    const jeId = db.transaction(() => {
      const lines = [];
      if (asset.accumulated_depreciation_rial > 0) {
        lines.push({
          code: accumAcct.code, name: accumAcct.name,
          debit: rialToLedger(asset.accumulated_depreciation_rial), credit: 0,
          debit_rial: asset.accumulated_depreciation_rial,
        });
      }
      if (proceedsRial > 0) {
        lines.push({
          code: cashAcct.code, name: cashAcct.name,
          debit: rialToLedger(proceedsRial), credit: 0, debit_rial: proceedsRial,
        });
      }
      if (gainLoss > 0) {
        lines.push({
          code: gainAcct.code, name: gainAcct.name,
          debit: 0, credit: rialToLedger(gainLoss), credit_rial: gainLoss,
        });
      } else if (gainLoss < 0) {
        lines.push({
          code: lossAcct.code, name: lossAcct.name,
          debit: rialToLedger(Math.abs(gainLoss)), credit: 0, debit_rial: Math.abs(gainLoss),
        });
      }
      lines.push({
        code: asset.coa_asset_code || assetAcct.code, name: assetAcct.name,
        debit: 0, credit: rialToLedger(asset.cost_rial), credit_rial: asset.cost_rial,
      });

      const id = postToLedger(db, {
        sourceType: 'fixed_asset_dispose', sourceId: asset.id, date: disposeDate,
        description: `واگذاری دارایی ${asset.code} — ${asset.name}`,
        createdBy: req.user.id, lines,
      });
      db.prepare(`
        UPDATE fixed_assets SET status='disposed', disposed_at=strftime('%s','now'),
          dispose_je_id=?, dispose_proceeds_rial=? WHERE id=?
      `).run(id, proceedsRial, asset.id);
      return id;
    })();

    audit(req.user.id, 'dispose', 'fixed_asset', asset.id, `واگذاری ${asset.code}`);
    res.json({ ok: true, journal_entry_id: jeId, gain_loss_rial: gainLoss, book_value_rial: bookValue });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/:id/revalue', auth, adminOrAccounting, (req, res) => {
  try {
    const db = getDB();
    const asset = db.prepare("SELECT * FROM fixed_assets WHERE id=? AND status='active'").get(req.params.id);
    if (!asset) return res.status(404).json({ error: 'دارایی فعال یافت نشد' });

    const newCost = Math.round(Number(req.body.new_cost_rial) || 0);
    if (newCost <= 0) throw new Error('بهای جدید نامعتبر است');

    const bookValue = Math.max(0, asset.cost_rial - (asset.accumulated_depreciation_rial || 0));
    const surplus = Math.max(0, newCost - bookValue);
    const revalueDate = req.body.date || todayJalali();

    db.transaction(() => {
      if (surplus > 0) {
        const assetAcct = acct(db, 'coa_fixed_assets');
        const surplusAcct = acct(db, 'coa_revaluation_surplus');
        postToLedger(db, {
          sourceType: 'fixed_asset_revalue', sourceId: asset.id, date: revalueDate,
          description: `تجدید ارزیابی ${asset.code}`,
          createdBy: req.user.id,
          lines: [
            { code: assetAcct.code, name: assetAcct.name, debit: rialToLedger(surplus), credit: 0, debit_rial: surplus },
            { code: surplusAcct.code, name: surplusAcct.name, debit: 0, credit: rialToLedger(surplus), credit_rial: surplus },
          ],
        });
      }
      db.prepare(`
        UPDATE fixed_assets SET cost_rial=?, revaluation_surplus_rial=revaluation_surplus_rial+? WHERE id=?
      `).run(newCost, surplus, asset.id);
    })();

    audit(req.user.id, 'revalue', 'fixed_asset', asset.id, `تجدید ارزیابی ${asset.code}`);
    res.json({ ok: true, new_cost_rial: newCost, surplus_rial: surplus });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
