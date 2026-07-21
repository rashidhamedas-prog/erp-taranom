'use strict';
/**
 * Pricing rules — auto wholesale/retail from cost (Update 11 / PR1).
 */
const router = require('express').Router();
const { getDB, audit } = require('../db');
const { auth, adminOrAccounting } = require('../middleware/auth');

function resolveMarkup(db, product) {
  const byProduct = product?.id
    ? db.prepare(
      "SELECT * FROM pricing_rules WHERE active=1 AND scope='product' AND scope_id=? ORDER BY id DESC LIMIT 1"
    ).get(product.id)
    : null;
  if (byProduct) return byProduct;
  const catId = product?.category_id;
  if (catId) {
    const byCat = db.prepare(
      "SELECT * FROM pricing_rules WHERE active=1 AND scope='category' AND scope_id=? ORDER BY id DESC LIMIT 1"
    ).get(catId);
    if (byCat) return byCat;
  }
  return db.prepare(
    "SELECT * FROM pricing_rules WHERE active=1 AND scope='global' ORDER BY id DESC LIMIT 1"
  ).get() || { wholesale_markup_pct: 20, retail_markup_pct: 35 };
}

/** Apply markup to product from unit cost (rial). */
function applyPricingFromCost(db, productId, costRial) {
  const product = db.prepare('SELECT * FROM products WHERE id=?').get(productId);
  if (!product) return null;
  const cost = Math.round(Number(costRial) || 0);
  if (cost <= 0) return null;
  const rule = resolveMarkup(db, product);
  const wPct = Number(rule.wholesale_markup_pct) || 0;
  const rPct = Number(rule.retail_markup_pct) || 0;
  const wholesale = Math.round(cost * (1 + wPct / 100));
  const retail = Math.round(cost * (1 + rPct / 100));
  db.prepare('UPDATE products SET price=?, price_rial=?, retail_price=?, retail_price_rial=?, cost=? WHERE id=?')
    .run(wholesale, wholesale, retail, retail, cost, productId);
  return { wholesale, retail, cost, rule };
}

router.get('/', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  res.json(db.prepare('SELECT * FROM pricing_rules ORDER BY scope, id').all());
});

router.post('/', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const scope = ['global', 'category', 'product'].includes(req.body.scope) ? req.body.scope : 'global';
  const scope_id = scope === 'global' ? null : (parseInt(req.body.scope_id, 10) || null);
  const wholesale_markup_pct = parseFloat(req.body.wholesale_markup_pct);
  const retail_markup_pct = parseFloat(req.body.retail_markup_pct);
  if (!Number.isFinite(wholesale_markup_pct) || !Number.isFinite(retail_markup_pct)) {
    return res.status(400).json({ error: 'درصد سود عمده/تک الزامی است' });
  }
  const r = db.prepare(
    'INSERT INTO pricing_rules (scope,scope_id,wholesale_markup_pct,retail_markup_pct) VALUES (?,?,?,?)'
  ).run(scope, scope_id, wholesale_markup_pct, retail_markup_pct);
  audit(req.user.id, 'create', 'pricing_rule', r.lastInsertRowid, `${scope} W${wholesale_markup_pct}% R${retail_markup_pct}%`);
  res.json(db.prepare('SELECT * FROM pricing_rules WHERE id=?').get(r.lastInsertRowid));
});

router.put('/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM pricing_rules WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  db.prepare(`
    UPDATE pricing_rules SET
      wholesale_markup_pct=?, retail_markup_pct=?, active=?,
      scope=COALESCE(?,scope), scope_id=?
    WHERE id=?
  `).run(
    req.body.wholesale_markup_pct != null ? parseFloat(req.body.wholesale_markup_pct) : row.wholesale_markup_pct,
    req.body.retail_markup_pct != null ? parseFloat(req.body.retail_markup_pct) : row.retail_markup_pct,
    req.body.active != null ? (req.body.active ? 1 : 0) : row.active,
    req.body.scope || null,
    req.body.scope_id !== undefined ? (req.body.scope_id ? parseInt(req.body.scope_id, 10) : null) : row.scope_id,
    req.params.id
  );
  res.json({ ok: true });
});

router.delete('/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM pricing_rules WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  if (row.scope === 'global') {
    const others = db.prepare("SELECT COUNT(*) c FROM pricing_rules WHERE scope='global' AND id<>?").get(req.params.id).c;
    if (!others) return res.status(400).json({ error: 'حداقل یک قانون سراسری لازم است' });
  }
  db.prepare('DELETE FROM pricing_rules WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

/** Preview prices from a cost. */
router.post('/preview', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const cost = Math.round(Number(req.body.cost_rial) || 0);
  const product = req.body.product_id
    ? db.prepare('SELECT * FROM products WHERE id=?').get(req.body.product_id)
    : { category_id: req.body.category_id || null };
  const rule = resolveMarkup(db, product || {});
  const wholesale = Math.round(cost * (1 + (Number(rule.wholesale_markup_pct) || 0) / 100));
  const retail = Math.round(cost * (1 + (Number(rule.retail_markup_pct) || 0) / 100));
  res.json({ cost_rial: cost, wholesale, retail, rule });
});

module.exports = router;
module.exports.applyPricingFromCost = applyPricingFromCost;
module.exports.resolveMarkup = resolveMarkup;
