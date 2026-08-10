'use strict';
const router = require('express').Router();
const { getDB } = require('../db');
const { auth, requirePermission } = require('../middleware/auth');
const bom = require('../lib/production/bom');
const adv = require('../lib/production/bom-advanced');
const { applyCostPolicy } = require('../lib/production/access');

function handle(res, fn) {
  try {
    const data = fn();
    res.json(data);
  } catch (e) {
    const status = e.status || 500;
    res.status(status).json({ error: e.message || 'خطا', code: e.code || e.message, ...(e.extra || {}) });
  }
}

router.get('/', auth, requirePermission('production_bom', 'view'), (req, res) => {
  handle(res, () => bom.listBoms(getDB(), {
    product_id: req.query.product_id,
    status: req.query.status,
    bom_type: req.query.bom_type,
    search: req.query.q,
    page: req.query.page,
    limit: req.query.limit,
  }));
});

router.post('/', auth, requirePermission('production_bom', 'create'), (req, res) => {
  try {
    const data = bom.createBom(getDB(), req.body || {}, req.user.id);
    res.status(201).json(data);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, code: e.code || e.message });
  }
});

router.get('/resolve', auth, requirePermission('production_bom', 'view'), (req, res) => {
  handle(res, () => bom.resolveBom(getDB(), {
    productId: Number(req.query.product_id),
    date: req.query.date,
    preferredBomId: req.query.bom_id ? Number(req.query.bom_id) : null,
    allowAlternative: req.query.allow_alt === '1',
  }));
});

router.get('/compare', auth, requirePermission('production_bom', 'view'), (req, res) => {
  handle(res, () => bom.compareBoms(getDB(), Number(req.query.a), Number(req.query.b)));
});

// Must be registered before `/:id` — Express matches in order.
router.get('/compare-scenarios', auth, requirePermission('production_cost', 'view'), (req, res) => {
  handle(res, () => {
    const data = adv.compareScenarios(
      getDB(),
      Number(req.query.a),
      Number(req.query.b),
      Number(req.query.qty) || 1,
      req.query.period || ''
    );
    return applyCostPolicy(getDB(), req.user, data);
  });
});

router.get('/where-used/:productId', auth, requirePermission('production_bom', 'view'), (req, res) => {
  handle(res, () => ({ rows: bom.whereUsed(getDB(), Number(req.params.productId)) }));
});

router.get('/missing', auth, requirePermission('production_bom', 'view'), (req, res) => {
  handle(res, () => {
    const db = getDB();
    const rows = db.prepare(`
      SELECT p.id, p.name FROM products p
      WHERE p.is_manufactured=1
        AND NOT EXISTS (
          SELECT 1 FROM bom_headers b
          WHERE b.product_id=p.id AND b.status='active' AND b.deleted_at IS NULL
        )
    `).all();
    return { rows };
  });
});

router.get('/unused', auth, requirePermission('production_bom', 'view'), (req, res) => {
  handle(res, () => {
    const db = getDB();
    const rows = db.prepare(`
      SELECT b.* FROM bom_headers b
      WHERE b.status='active' AND b.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM production_orders o WHERE o.bom_id=b.id)
    `).all();
    return { rows };
  });
});

router.post('/validate', auth, requirePermission('production_bom', 'view'), (req, res) => {
  handle(res, () => {
    const db = getDB();
    if (req.body?.id) {
      bom.validateBom(db, Number(req.body.id));
      return { ok: true };
    }
    // ephemeral: create draft in transaction then rollback — use dry validate via temp insert
    const created = bom.createBom(db, req.body || {}, req.user.id);
    try {
      bom.validateBom(db, created.id);
      return { ok: true, id: created.id };
    } finally {
      // leave as draft for inspection or soft-delete
    }
  });
});

router.get('/:id', auth, requirePermission('production_bom', 'view'), (req, res) => {
  handle(res, () => bom.getBom(getDB(), Number(req.params.id)));
});

router.put('/:id', auth, requirePermission('production_bom', 'edit'), (req, res) => {
  handle(res, () => bom.updateBomHeader(getDB(), Number(req.params.id), req.body || {}, req.user.id));
});

router.delete('/:id', auth, requirePermission('production_bom', 'delete'), (req, res) => {
  handle(res, () => bom.softDeleteBom(getDB(), Number(req.params.id), req.user.id));
});

router.post('/:id/lines', auth, requirePermission('production_bom', 'edit'), (req, res) => {
  try {
    const data = bom.addLine(getDB(), Number(req.params.id), req.body || {}, req.user.id);
    res.status(201).json(data);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, code: e.code || e.message });
  }
});

router.put('/:id/lines/:lineId', auth, requirePermission('production_bom', 'edit'), (req, res) => {
  handle(res, () => bom.updateLine(getDB(), Number(req.params.id), Number(req.params.lineId), req.body || {}, req.user.id));
});

router.delete('/:id/lines/:lineId', auth, requirePermission('production_bom', 'edit'), (req, res) => {
  handle(res, () => bom.deleteLine(getDB(), Number(req.params.id), Number(req.params.lineId), req.user.id));
});

router.post('/:id/lines/bulk', auth, requirePermission('production_bom', 'edit'), (req, res) => {
  handle(res, () => {
    const db = getDB();
    const bomId = Number(req.params.id);
    const lines = req.body?.lines || [];
    return db.transaction(() => {
      const out = [];
      for (const L of lines) out.push(bom.addLine(db, bomId, L, req.user.id));
      return { ok: true, count: out.length, ids: out.map(x => x.id) };
    })();
  });
});

router.post('/:id/activate', auth, requirePermission('production_bom', 'approve'), (req, res) => {
  if (req.user.role === 'accounting') {
    return res.status(403).json({ error: 'حسابدار نمی‌تواند فرمول را فعال کند', code: 'E_FORBIDDEN' });
  }
  handle(res, () => bom.activateBom(getDB(), Number(req.params.id), req.body?.valid_from, req.user.id));
});

router.post('/:id/deactivate', auth, requirePermission('production_bom', 'approve'), (req, res) => {
  handle(res, () => bom.deactivateBom(getDB(), Number(req.params.id), req.user.id));
});

router.post('/:id/archive', auth, requirePermission('production_bom', 'edit'), (req, res) => {
  handle(res, () => bom.archiveBom(getDB(), Number(req.params.id), req.body?.reason || '', req.user.id));
});

router.post('/:id/version-up', auth, requirePermission('production_bom', 'create'), (req, res) => {
  handle(res, () => bom.versionUpBom(getDB(), Number(req.params.id), req.body?.reason || '', req.user.id));
});

router.post('/:id/clone', auth, requirePermission('production_bom', 'create'), (req, res) => {
  handle(res, () => bom.cloneBom(getDB(), Number(req.params.id), req.body || {}, req.user.id));
});

router.post('/:id/create-alternative', auth, requirePermission('production_bom', 'create'), (req, res) => {
  handle(res, () => bom.createAlternative(getDB(), Number(req.params.id), req.body?.reason || '', req.user.id));
});

router.get('/:id/explode', auth, requirePermission('production_bom', 'view'), (req, res) => {
  handle(res, () => {
    let sizeBreakdown = req.query.size_breakdown;
    if (typeof sizeBreakdown === 'string') {
      try { sizeBreakdown = JSON.parse(sizeBreakdown); } catch { sizeBreakdown = null; }
    }
    return bom.explodeBom(getDB(), {
      bomId: Number(req.params.id),
      qty: Number(req.query.qty) || 1,
      sizeBreakdown,
      priceBasis: req.query.price_basis || 'average',
    });
  });
});

router.get('/:id/std-cost', auth, requirePermission('production_cost', 'view'), (req, res) => {
  handle(res, () => bom.stdCost(getDB(), Number(req.params.id), {
    qty: Number(req.query.qty) || 1,
    priceBasis: req.query.price_basis || 'average',
  }));
});

router.get('/:id/tree', auth, requirePermission('production_bom', 'view'), (req, res) => {
  handle(res, () => bom.bomTree(getDB(), Number(req.params.id)));
});

router.get('/:id/history', auth, requirePermission('production_bom', 'view'), (req, res) => {
  handle(res, () => {
    const rows = getDB().prepare(
      'SELECT * FROM bom_change_log WHERE bom_id=? ORDER BY id DESC'
    ).all(Number(req.params.id));
    return { rows };
  });
});

// ─── P4/P5 advanced ───

router.post('/:id/apply-routing-template', auth, requirePermission('production_bom', 'edit'), (req, res) => {
  handle(res, () => adv.applyRoutingTemplate(getDB(), Number(req.params.id), req.user.id));
});

router.post('/:id/operations/from-template', auth, requirePermission('production_bom', 'edit'), (req, res) => {
  handle(res, () => adv.applyRoutingTemplate(getDB(), Number(req.params.id), req.user.id));
});

router.get('/:id/operations', auth, requirePermission('production_bom', 'view'), (req, res) => {
  handle(res, () => ({
    rows: getDB().prepare('SELECT * FROM bom_operations WHERE bom_id=? ORDER BY seq').all(Number(req.params.id)),
  }));
});

router.get('/:id/routing', auth, requirePermission('production_bom', 'view'), (req, res) => {
  handle(res, () => ({
    rows: getDB().prepare('SELECT * FROM bom_operations WHERE bom_id=? ORDER BY seq').all(Number(req.params.id)),
  }));
});

router.post('/:id/operations', auth, requirePermission('production_bom', 'edit'), (req, res) => {
  try {
    const row = adv.addOperation(getDB(), Number(req.params.id), req.body || {}, req.user.id);
    res.status(201).json(row);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, code: e.code || e.message });
  }
});

router.put('/:id/operations/:opId', auth, requirePermission('production_bom', 'edit'), (req, res) => {
  handle(res, () => adv.updateOperation(getDB(), Number(req.params.id), Number(req.params.opId), req.body || {}));
});

router.delete('/:id/operations/:opId', auth, requirePermission('production_bom', 'edit'), (req, res) => {
  handle(res, () => adv.deleteOperation(getDB(), Number(req.params.id), Number(req.params.opId)));
});

router.post('/:id/operations/resequence', auth, requirePermission('production_bom', 'edit'), (req, res) => {
  handle(res, () => ({ rows: adv.resequenceOperations(getDB(), Number(req.params.id)) }));
});

router.get('/:id/outputs', auth, requirePermission('production_bom', 'view'), (req, res) => {
  handle(res, () => ({
    rows: getDB().prepare('SELECT * FROM bom_outputs WHERE bom_id=?').all(Number(req.params.id)),
  }));
});

router.post('/:id/outputs', auth, requirePermission('production_bom', 'edit'), (req, res) => {
  try {
    const row = adv.addOutput(getDB(), Number(req.params.id), req.body || {});
    res.status(201).json(row);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, code: e.code || e.message });
  }
});

router.put('/:id/outputs/:outId', auth, requirePermission('production_bom', 'edit'), (req, res) => {
  handle(res, () => adv.updateOutput(getDB(), Number(req.params.id), Number(req.params.outId), req.body || {}));
});

router.delete('/:id/outputs/:outId', auth, requirePermission('production_bom', 'edit'), (req, res) => {
  handle(res, () => adv.deleteOutput(getDB(), Number(req.params.id), Number(req.params.outId)));
});

router.post('/:id/outputs/auto-share', auth, requirePermission('production_bom', 'edit'), (req, res) => {
  handle(res, () => {
    const method = req.body?.method || 'sales_value';
    if (method !== 'sales_value' && method !== 'physical') {
      const e = new Error('E_BAD_SHARE_METHOD');
      e.status = 422;
      e.code = 'E_BAD_SHARE_METHOD';
      throw e;
    }
    return adv.autoShare(getDB(), Number(req.params.id), method);
  });
});

router.get('/:id/backward-qty', auth, requirePermission('production_bom', 'view'), (req, res) => {
  handle(res, () => adv.backwardQty(getDB(), Number(req.params.id), Number(req.query.target) || 1));
});

router.get('/:id/full-cost', auth, requirePermission('production_cost', 'view'), (req, res) => {
  handle(res, () => {
    adv.clearRollUpMemo();
    const data = adv.rollUpBom(getDB(), {
      bomId: Number(req.params.id),
      qtyTarget: Number(req.query.qty) || 1,
      period: req.query.period || '',
      priceBasis: req.query.price_basis || 'average',
    });
    return applyCostPolicy(getDB(), req.user, data);
  });
});

router.get('/:id/roll-up', auth, requirePermission('production_cost', 'view'), (req, res) => {
  handle(res, () => {
    adv.clearRollUpMemo();
    const data = adv.rollUpBom(getDB(), {
      bomId: Number(req.params.id),
      qtyTarget: Number(req.query.qty) || 1,
      period: req.query.period || '',
      priceBasis: req.query.price_basis || 'average',
    });
    return applyCostPolicy(getDB(), req.user, data);
  });
});

router.get('/:id/cost-tree', auth, requirePermission('production_cost', 'view'), (req, res) => {
  handle(res, () => {
    const data = adv.costTree(getDB(), {
      bomId: Number(req.params.id),
      qty: Number(req.query.qty) || 1,
      period: req.query.period || '',
      priceBasis: req.query.price_basis || 'average',
    });
    return applyCostPolicy(getDB(), req.user, data);
  });
});

router.get('/:id/yield-analysis', auth, requirePermission('production_bom', 'view'), (req, res) => {
  handle(res, () => adv.yieldAnalysis(getDB(), Number(req.params.id), Number(req.query.qty) || 1));
});

router.get('/:id/sensitivity', auth, requirePermission('production_cost', 'view'), (req, res) => {
  handle(res, () => {
    let deltaPercent = Number(req.query.delta) || Number(req.query.delta_percent);
    if (!Number.isFinite(deltaPercent) && typeof req.query.range === 'string') {
      const m = req.query.range.match(/(-?\d+(?:\.\d+)?)/);
      deltaPercent = m ? Number(m[1]) : 10;
    }
    if (!Number.isFinite(deltaPercent)) deltaPercent = 10;
    const data = adv.sensitivity(getDB(), {
      bomId: Number(req.params.id),
      qtyTarget: Number(req.query.qty) || 1,
      period: req.query.period || '',
      param: req.query.param || 'fabric_price',
      deltaPercent,
    });
    return applyCostPolicy(getDB(), req.user, data);
  });
});

router.get('/:id/breakeven', auth, requirePermission('production_cost', 'view'), (req, res) => {
  handle(res, () => {
    const data = adv.breakeven(getDB(), {
      bomId: Number(req.params.id),
      qtyTarget: Number(req.query.qty) || 1,
      period: req.query.period || '',
      priceRial: req.query.price != null ? Number(req.query.price) : undefined,
    });
    return applyCostPolicy(getDB(), req.user, data);
  });
});

router.post('/:id/validate-advanced', auth, requirePermission('production_bom', 'view'), (req, res) => {
  handle(res, () => adv.validateAdvancedBom(getDB(), Number(req.params.id)));
});

router.get('/:id/capacity-load', auth, requirePermission('production_bom', 'view'), (req, res) => {
  handle(res, () => adv.capacityLoad(getDB(), Number(req.params.id), Number(req.query.qty) || 1));
});

module.exports = router;
