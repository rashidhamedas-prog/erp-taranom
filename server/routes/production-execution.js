'use strict';
const router = require('express').Router();
const { getDB } = require('../db');
const { auth, requirePermission } = require('../middleware/auth');
const engine = require('../lib/production/engine');
const adv = require('../lib/production/engine-advanced');
const sub = require('../lib/production/subcontract');
const { assertUserCostCenter, canSeeCost, stripCostFields } = require('../lib/production/access');

function handle(res, fn, req) {
  try {
    let data = fn();
    if (req && !canSeeCost(getDB(), req.user)) data = stripCostFields(data);
    res.json(data);
  } catch (e) {
    res.status(e.status || 500).json({
      error: e.message,
      code: e.code || e.message,
      ...(e.extra || {}),
    });
  }
}

function stageCc(db, orderId, stageId) {
  return db.prepare(`
    SELECT cost_center_id FROM production_order_stages
    WHERE id=? AND order_id=?
  `).get(stageId, orderId);
}

function orderId(req) { return Number(req.params.id); }
function stageId(req) { return Number(req.params.stageId); }

router.post('/orders/:id/release-advanced', auth, requirePermission('production', 'edit'), (req, res) => {
  handle(res, () => adv.releaseAdvancedOrder(getDB(), orderId(req), req.user.id));
});

router.post('/orders/:id/stages/:stageId/start', auth, requirePermission('production', 'edit'), (req, res) => {
  handle(res, () => adv.startStage(getDB(), orderId(req), stageId(req), req.user.id));
});

router.post('/orders/:id/stages/:stageId/output', auth, requirePermission('production', 'create'), (req, res) => {
  handle(res, () => {
    const db = getDB();
    const st = stageCc(db, orderId(req), stageId(req));
    if (!st) throw Object.assign(new Error('E_NOT_FOUND'), { code: 'E_NOT_FOUND', status: 404 });
    assertUserCostCenter(db, req.user.id, st.cost_center_id);
    const po = engine.getOrderDetail(db, orderId(req));
    const fn = po.analysis_type === 'variable_adv'
      ? adv.postStageOutputVariable
      : adv.postStageOutputFixed;
    return fn(db, {
      orderId: orderId(req),
      stageId: stageId(req),
      body: req.body || {},
      userId: req.user.id,
    });
  }, req);
});

router.post('/orders/:id/stages/:stageId/issue', auth, requirePermission('production', 'create'), (req, res) => {
  handle(res, () => {
    const db = getDB();
    const st = stageCc(db, orderId(req), stageId(req));
    if (!st) throw Object.assign(new Error('E_NOT_FOUND'), { code: 'E_NOT_FOUND', status: 404 });
    assertUserCostCenter(db, req.user.id, st.cost_center_id);
    return adv.issueStageMaterials(db, {
      orderId: orderId(req),
      stageId: stageId(req),
      body: req.body || {},
      userId: req.user.id,
    });
  }, req);
});

router.get('/orders/:id/stages/:stageId/extra-issues', auth, requirePermission('production', 'view'), (req, res) => {
  handle(res, () => adv.listStageExtraIssues(getDB(), orderId(req), stageId(req)), req);
});

router.post('/orders/:id/stages/:stageId/extra-issues', auth, requirePermission('production', 'create'), (req, res) => {
  handle(res, () => {
    const db = getDB();
    const st = stageCc(db, orderId(req), stageId(req));
    if (!st) throw Object.assign(new Error('E_NOT_FOUND'), { code: 'E_NOT_FOUND', status: 404 });
    assertUserCostCenter(db, req.user.id, st.cost_center_id);
    return adv.issueStageExtraMaterials(db, {
      orderId: orderId(req),
      stageId: stageId(req),
      body: req.body || {},
      userId: req.user.id,
    });
  }, req);
});

router.post('/orders/:id/stages/:stageId/extra-issues/:issueId/void', auth, requirePermission('production', 'edit'), (req, res) => {
  handle(res, () => {
    const db = getDB();
    const st = stageCc(db, orderId(req), stageId(req));
    if (!st) throw Object.assign(new Error('E_NOT_FOUND'), { code: 'E_NOT_FOUND', status: 404 });
    assertUserCostCenter(db, req.user.id, st.cost_center_id);
    return adv.voidStageExtraIssue(db, {
      orderId: orderId(req),
      stageId: stageId(req),
      issueId: Number(req.params.issueId),
      reason: req.body?.reason || '',
      userId: req.user.id,
      date: req.body?.date,
    });
  }, req);
});

router.post('/orders/:id/finalize', auth, requirePermission('production', 'create'), (req, res) => {
  handle(res, () => adv.finalizeAdvancedOrder(getDB(), {
    orderId: orderId(req),
    body: req.body || {},
    userId: req.user.id,
  }));
});

router.post('/orders/:id/stages/:stageId/skip', auth, requirePermission('production', 'edit'), (req, res) => {
  handle(res, () => adv.skipStage(
    getDB(), orderId(req), stageId(req), req.user.id, req.body?.reason
  ));
});

router.post('/orders/:id/stages/:stageId/block', auth, requirePermission('production', 'edit'), (req, res) => {
  handle(res, () => adv.blockStage(
    getDB(), orderId(req), stageId(req), req.user.id, req.body?.reason
  ));
});

router.post('/orders/:id/stages/:stageId/unblock', auth, requirePermission('production', 'edit'), (req, res) => {
  handle(res, () => adv.unblockStage(getDB(), orderId(req), stageId(req), req.user.id));
});

router.post('/orders/:id/stages/:stageId/reverse', auth, requirePermission('production', 'edit'), (req, res) => {
  handle(res, () => {
    const db = getDB();
    const st = stageCc(db, orderId(req), stageId(req));
    if (!st) throw Object.assign(new Error('E_NOT_FOUND'), { code: 'E_NOT_FOUND', status: 404 });
    assertUserCostCenter(db, req.user.id, st.cost_center_id);
    return adv.reverseStage(db, {
      orderId: orderId(req),
      stageId: stageId(req),
      reason: req.body?.reason || '',
      userId: req.user.id,
      date: req.body?.date,
    });
  }, req);
});

router.post('/orders/:id/stages/:stageId/subcontract/send', auth, requirePermission('production', 'create'), (req, res) => {
  handle(res, () => sub.sendToSubcontractor(getDB(), {
    orderId: orderId(req),
    stageId: stageId(req),
    body: req.body || {},
    userId: req.user.id,
  }));
});

router.post('/orders/:id/stages/:stageId/subcontract/receive', auth, requirePermission('production', 'create'), (req, res) => {
  handle(res, () => sub.receiveFromSubcontractor(getDB(), {
    orderId: orderId(req),
    stageId: stageId(req),
    body: req.body || {},
    userId: req.user.id,
  }));
});

router.get('/orders/:id/stages', auth, requirePermission('production', 'view'), (req, res) => {
  handle(res, () => {
    const db = getDB();
    const id = orderId(req);
    const stages = adv.stageList(db, id);
    let po = null;
    try { po = engine.getOrderDetail(db, id); } catch (_) { po = null; }
    const cut = adv.resolveCuttingStage(db, id);
    let coverage = null;
    if (po && cut) {
      try { coverage = adv.cuttingStageCoverage(db, po, cut); } catch (_) { coverage = null; }
    }
    return {
      order_id: id,
      stages: stages.map((s) => (
        coverage && cut && Number(s.id) === Number(cut.id)
          ? { ...s, cut_coverage: coverage }
          : s
      )),
    };
  });
});

router.get('/orders/:id/stages/:stageId/issue-template', auth, requirePermission('production', 'view'), (req, res) => {
  handle(res, () => adv.getStageIssueTemplate(getDB(), orderId(req), stageId(req)), req);
});

module.exports = router;
