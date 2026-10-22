const router = require('express').Router();
const { getDB, audit } = require('../db');
const { auth, adminOrAccounting, adminOnly } = require('../middleware/auth');
const { todayJalali } = require('../jalali');
const { acct } = require('../lib/coa-map');
const { postToLedger } = require('../lib/ledger');
const { rialToLedger } = require('../lib/money');
const { resolveCashAccount } = require('../db');
const { reverseJournalEntry, closedFiscalYearForDate } = require('../lib/void-journal');
const { ensureReconSchemaOnce } = require('../lib/subledger-recon');

router.get('/', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const includeInactive = req.query.all === '1';
  res.json(db.prepare(`
    SELECT *, (cost_rial - accumulated_depreciation_rial) AS book_value_rial
    FROM fixed_assets
    WHERE ${includeInactive ? "status IN ('active','inactive')" : "status='active'"}
    ORDER BY code
  `).all());
});

const FUNDING = new Set(['opening', 'cash', 'bank', 'ap', 'none']);

function supplierPayableAcct(db, supplierId) {
  const s = supplierId ? db.prepare('SELECT coa_code FROM suppliers WHERE id=?').get(supplierId) : null;
  if (s && s.coa_code) {
    const a = db.prepare('SELECT code,name FROM chart_of_accounts WHERE code=?').get(s.coa_code);
    if (a) return a;
  }
  return acct(db, 'coa_payable');
}

function assetAccount(db, asset) {
  const code = asset.coa_asset_code || acct(db, 'coa_fixed_assets').code;
  return db.prepare('SELECT code,name FROM chart_of_accounts WHERE code=?').get(code) || acct(db, 'coa_fixed_assets');
}

// Acquisition voucher: Dr fixed asset / Cr funding (opening equity, cash, bank or supplier AP).
function postAcquisition(db, asset, { funding, supplierId, payType, bankId, cashBoxId, userId }) {
  const cost = Math.round(Number(asset.cost_rial) || 0);
  if (cost <= 0 || funding === 'none') return null;
  let credit;
  if (funding === 'ap') credit = supplierPayableAcct(db, supplierId);
  else if (funding === 'cash' || funding === 'bank') {
    credit = funding === 'bank'
      ? resolveCashAccount(db, payType || 'bank', bankId, null)
      : resolveCashAccount(db, 'cash', null, cashBoxId);
  } else credit = acct(db, 'coa_opening_balance');
  let date = asset.purchase_date || todayJalali();
  // Opening entries for assets bought in a closed year land on today (the old year is sealed).
  if (funding === 'opening' && closedFiscalYearForDate(db, date)) date = todayJalali();
  const debitAcct = assetAccount(db, asset);
  const jeId = postToLedger(db, {
    sourceType: 'fixed_asset_acquisition', sourceId: asset.id, date,
    description: `تحصیل دارایی ثابت ${asset.code} — ${asset.name}`,
    createdBy: userId,
    lines: [
      { code: debitAcct.code, name: debitAcct.name, debit: rialToLedger(cost), credit: 0, debit_rial: cost },
      { code: credit.code, name: credit.name, debit: 0, credit: rialToLedger(cost), credit_rial: cost },
    ],
  });
  if (funding === 'ap') {
    db.prepare('INSERT INTO supplier_ledger (supplier_id,date,entry_type,ref_type,ref_id,description,debit,credit,user_id) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(supplierId, date, 'purchase', 'fixed_asset_acquisition', asset.id, `خرید دارایی ثابت ${asset.code}`, 0, cost, userId || null);
    require('../lib/party-leaf-sync').afterPartyBookInsert(db, {
      kind: 'supplier', entityId: supplierId, date, entry_type: 'purchase', ref_type: 'fixed_asset_acquisition',
      ref_id: asset.id, description: `خرید دارایی ثابت ${asset.code}`, debit: 0, credit: cost, user_id: userId,
    });
  }
  return jeId;
}

router.post('/', auth, adminOrAccounting, (req, res) => {
  const b = req.body;
  if (!b.name || !b.cost_rial) return res.status(400).json({ error: 'نام و بهای دارایی الزامی است' });
  const funding = String(b.funding || 'opening').trim();
  if (!FUNDING.has(funding)) return res.status(400).json({ error: 'منبع تأمین نامعتبر است (opening|cash|bank|ap|none)', code: 'E_FA_FUNDING' });
  const supplierId = b.supplier_id ? +b.supplier_id : null;
  const db = getDB();
  if (funding === 'ap' && !(supplierId && db.prepare('SELECT id FROM suppliers WHERE id=?').get(supplierId))) {
    return res.status(400).json({ error: 'برای خرید نسیه دارایی، تأمین‌کننده الزامی است', code: 'E_FA_SUPPLIER_REQUIRED' });
  }
  ensureReconSchemaOnce(db);
  const code = b.code || ('FA-' + String(Date.now()).slice(-6));
  try {
    let id;
    let jeId = null;
    db.transaction(() => {
      id = Number(db.prepare(`
        INSERT INTO fixed_assets (code,name,category,purchase_date,cost_rial,salvage_rial,useful_life_months,location,notes,coa_asset_code)
        VALUES (?,?,?,?,?,?,?,?,?,?)
      `).run(code, b.name, b.category || '', b.purchase_date || todayJalali(),
        parseInt(b.cost_rial, 10), parseInt(b.salvage_rial || 0, 10),
        parseInt(b.useful_life_months || 60, 10), b.location || '', b.notes || '',
        b.coa_asset_code || '1201').lastInsertRowid);
      const asset = db.prepare('SELECT * FROM fixed_assets WHERE id=?').get(id);
      jeId = postAcquisition(db, asset, {
        funding, supplierId, payType: b.pay_type, bankId: b.bank_id, cashBoxId: b.cash_box_id, userId: req.user.id,
      });
      db.prepare('UPDATE fixed_assets SET acq_je_id=?, acq_funding=?, acq_supplier_id=? WHERE id=?')
        .run(jeId, funding, funding === 'ap' ? supplierId : null, id);
    })();
    audit(req.user.id, 'create', 'fixed_asset', id, code);
    res.json(db.prepare('SELECT * FROM fixed_assets WHERE id=?').get(id));
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
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
  const already = db.prepare(`
    SELECT COUNT(*) c FROM fixed_asset_depreciation
    WHERE period_label=? AND COALESCE(status,'posted')<>'reversed'
  `).get(period).c;
  if (already > 0) return res.status(400).json({ error: `استهلاک دوره ${period} قبلاً ثبت شده — ابتدا ابطال کنید` });

  const assets = db.prepare("SELECT * FROM fixed_assets WHERE status='active'").all();
  let totalDep = 0;
  let jeId = null;

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
      db.prepare('INSERT INTO fixed_asset_depreciation (asset_id, period_label, amount_rial, status) VALUES (?,?,?,?)')
        .run(a.id, period, amt, 'posted');
    }
    if (totalDep > 0) {
      const exp = acct(db, 'coa_depreciation_expense');
      const acc = acct(db, 'coa_accumulated_depreciation');
      jeId = postToLedger(db, {
        sourceType: 'depreciation', sourceId: period, date: todayJalali(),
        description: `استهلاک دارایی — ${period}`,
        createdBy: req.user.id,
        lines: [
          { code: exp.code, name: exp.name, debit: totalDep / 10, credit: 0, debit_rial: totalDep },
          { code: acc.code, name: acc.name, debit: 0, credit: totalDep / 10, credit_rial: totalDep },
        ],
      });
      db.prepare("UPDATE fixed_asset_depreciation SET je_id=? WHERE period_label=? AND COALESCE(status,'posted')='posted'")
        .run(jeId, period);
    }
  })();

  audit(req.user.id, 'depreciation_run', 'fixed_assets', null, `${period}: ${totalDep} ریال`);
  res.json({ success: true, data: { period, total_depreciation_rial: totalDep, asset_count: assets.length, je_id: jeId } });
});

// Soft-deactivate master asset + void its acquisition voucher (R13).
router.delete('/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  ensureReconSchemaOnce(db);
  const row = db.prepare('SELECT * FROM fixed_assets WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  if (row.status === 'disposed') return res.status(400).json({ error: 'دارایی واگذارشده را ابطال واگذاری کنید' });
  if (row.status === 'inactive') return res.status(400).json({ error: 'قبلاً غیرفعال شده' });
  const postedDep = db.prepare(
    "SELECT COUNT(*) c FROM fixed_asset_depreciation WHERE asset_id=? AND COALESCE(status,'posted')<>'reversed'"
  ).get(row.id).c;
  if (postedDep > 0) {
    return res.status(400).json({ error: 'این دارایی استهلاک فعال دارد — ابتدا استهلاک دوره را ابطال کنید' });
  }
  const activeReval = db.prepare(
    "SELECT COUNT(*) c FROM fixed_asset_revaluations WHERE asset_id=? AND COALESCE(status,'posted')<>'reversed'"
  ).get(row.id).c;
  if (activeReval > 0) {
    return res.status(400).json({ error: 'این دارایی تجدید ارزیابی فعال دارد — ابتدا تجدید ارزیابی را ابطال کنید', code: 'E_FA_ACTIVE_REVALUATION' });
  }
  try {
    db.transaction(() => {
      if (row.acq_je_id) {
        reverseJournalEntry(db, row.acq_je_id, {
          userId: req.user.id,
          reason: `ابطال تحصیل دارایی ${row.code}`,
        });
        if (row.acq_funding === 'ap') {
          require('../lib/party-ledger-retire').retireSupplierLedgerByRef(db, {
            refTypes: ['fixed_asset_acquisition'], refId: row.id, supplierId: row.acq_supplier_id,
          });
        }
      }
      db.prepare("UPDATE fixed_assets SET status='inactive' WHERE id=?").run(row.id);
    })();
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
  audit(req.user.id, 'deactivate', 'fixed_asset', row.id, `غیرفعال‌سازی ${row.code}`);
  res.json({ ok: true, acq_je_reversed: row.acq_je_id || null });
});

// Void dispose — restore active + reverse dispose JE
router.post('/:id/void-dispose', auth, adminOrAccounting, (req, res) => {
  try {
    const db = getDB();
    const asset = db.prepare("SELECT * FROM fixed_assets WHERE id=? AND status='disposed'").get(req.params.id);
    if (!asset) return res.status(404).json({ error: 'دارایی واگذارشده یافت نشد' });
    db.transaction(() => {
      if (asset.dispose_je_id) {
        reverseJournalEntry(db, asset.dispose_je_id, {
          userId: req.user.id,
          reason: `ابطال واگذاری ${asset.code}`,
          sourceType: 'fixed_asset_dispose_reversal',
        });
      }
      db.prepare(`
        UPDATE fixed_assets SET status='active', disposed_at=NULL, dispose_je_id=NULL, dispose_proceeds_rial=0
        WHERE id=?
      `).run(asset.id);
    })();
    audit(req.user.id, 'void_dispose', 'fixed_asset', asset.id, `ابطال واگذاری ${asset.code}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Void depreciation for a period
router.post('/depreciation/void', auth, adminOrAccounting, (req, res) => {
  try {
    const db = getDB();
    const period = String(req.body.period_label || req.query.period || '').trim();
    if (!period) return res.status(400).json({ error: 'دوره الزامی است' });
    const rows = db.prepare(`
      SELECT * FROM fixed_asset_depreciation
      WHERE period_label=? AND COALESCE(status,'posted')<>'reversed'
    `).all(period);
    if (!rows.length) return res.status(404).json({ error: 'استهلاک این دوره یافت نشد' });
    const jeId = rows.find(r => r.je_id)?.je_id
      || db.prepare(`
          SELECT id FROM journal_entries
          WHERE ref_type='depreciation' AND CAST(ref_id AS TEXT)=? AND COALESCE(deleted_at,0)=0
          ORDER BY id DESC LIMIT 1
        `).get(period)?.id;

    db.transaction(() => {
      for (const r of rows) {
        db.prepare('UPDATE fixed_assets SET accumulated_depreciation_rial=max(0, accumulated_depreciation_rial-?) WHERE id=?')
          .run(r.amount_rial, r.asset_id);
        db.prepare(`
          UPDATE fixed_asset_depreciation SET status='reversed', reversed_at=strftime('%s','now'), reversed_by=?
          WHERE id=?
        `).run(req.user.id, r.id);
      }
      if (jeId) {
        reverseJournalEntry(db, jeId, {
          userId: req.user.id,
          reason: `ابطال استهلاک ${period}`,
          sourceType: 'depreciation_reversal',
        });
      }
    })();
    audit(req.user.id, 'void_depreciation', 'fixed_assets', null, period);
    res.json({ ok: true, period, rows: rows.length });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
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

    ensureReconSchemaOnce(db);
    let revId;
    db.transaction(() => {
      let jeId = null;
      if (surplus > 0) {
        const assetAcct = acct(db, 'coa_fixed_assets');
        const surplusAcct = acct(db, 'coa_revaluation_surplus');
        jeId = postToLedger(db, {
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
      revId = Number(db.prepare(`
        INSERT INTO fixed_asset_revaluations (asset_id, date, old_cost_rial, new_cost_rial, surplus_rial, je_id, created_by)
        VALUES (?,?,?,?,?,?,?)
      `).run(asset.id, revalueDate, asset.cost_rial, newCost, surplus, jeId, req.user.id).lastInsertRowid);
    })();

    audit(req.user.id, 'revalue', 'fixed_asset', asset.id, `تجدید ارزیابی ${asset.code}`);
    res.json({ ok: true, new_cost_rial: newCost, surplus_rial: surplus, revaluation_id: revId });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/:id/revaluations', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  ensureReconSchemaOnce(db);
  res.json(db.prepare('SELECT * FROM fixed_asset_revaluations WHERE asset_id=? ORDER BY id DESC').all(req.params.id));
});

// R13: cancel the latest active revaluation — void its JE, restore cost and surplus.
function reverseRevaluation(req, res, revId) {
  try {
    const db = getDB();
    ensureReconSchemaOnce(db);
    const asset = db.prepare('SELECT * FROM fixed_assets WHERE id=?').get(req.params.id);
    if (!asset) return res.status(404).json({ error: 'دارایی یافت نشد' });
    if (asset.status !== 'active') return res.status(400).json({ error: 'فقط تجدید ارزیابی دارایی فعال قابل ابطال است' });
    const latest = db.prepare(`
      SELECT * FROM fixed_asset_revaluations
      WHERE asset_id=? AND COALESCE(status,'posted')<>'reversed' ORDER BY id DESC LIMIT 1
    `).get(asset.id);
    if (!latest) return res.status(404).json({ error: 'تجدید ارزیابی فعالی یافت نشد', code: 'E_FA_REVAL_NOT_FOUND' });
    if (revId && Number(revId) !== Number(latest.id)) {
      return res.status(409).json({ error: 'فقط آخرین تجدید ارزیابی قابل ابطال است', code: 'E_FA_REVAL_NOT_LATEST', latest_id: latest.id });
    }
    db.transaction(() => {
      if (latest.je_id) {
        reverseJournalEntry(db, latest.je_id, { userId: req.user.id, reason: `ابطال تجدید ارزیابی ${asset.code}` });
      }
      db.prepare(`
        UPDATE fixed_assets SET cost_rial=?, revaluation_surplus_rial=max(0, COALESCE(revaluation_surplus_rial,0)-?) WHERE id=?
      `).run(latest.old_cost_rial, latest.surplus_rial || 0, asset.id);
      db.prepare(`
        UPDATE fixed_asset_revaluations SET status='reversed', reversed_at=strftime('%s','now'), reversed_by=? WHERE id=?
      `).run(req.user.id, latest.id);
    })();
    audit(req.user.id, 'revalue_reverse', 'fixed_asset', asset.id, `ابطال تجدید ارزیابی #${latest.id} ${asset.code}`);
    res.json({ ok: true, revaluation_id: latest.id, cost_rial: latest.old_cost_rial });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
}

router.post('/:id/revalue/reverse', auth, adminOrAccounting, (req, res) => reverseRevaluation(req, res, null));
router.post('/:id/revalue/:revId/reverse', auth, adminOrAccounting, (req, res) => reverseRevaluation(req, res, req.params.revId));

module.exports = router;
