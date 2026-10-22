'use strict';
const router = require('express').Router();
const { getDB } = require('../db');
const { auth, requirePermission } = require('../middleware/auth');
const bom = require('../lib/production/bom');
const adv = require('../lib/production/bom-advanced');
const completeness = require('../lib/production/product-completeness');
const { applyCostPolicy } = require('../lib/production/access');

function handle(res, fn) {
  try {
    const data = fn();
    res.json(data);
  } catch (e) {
    const status = e.status || 500;
    const code = e.code || e.message;
    res.status(status).json({
      error: bomFaError(e),
      code,
      ...(e.extra || {}),
    });
  }
}

function bomFaError(e) {
  const code = String(e && (e.code || e.message) || '');
  const name = e && e.extra && e.extra.name;
  const map = {
    E_BOM_LOCKED: 'فرمول فعال قفل است. برای تغییر از «نسخه جدید» استفاده کنید.',
    E_BOM_ASSIGN_LOCKED: 'اتصال مواد به عملیات فقط روی فرمول پیش‌نویس یا فعال قابل تغییر است (فرمول بایگانی‌شده قفل است).',
    E_BOM_LINES_UNASSIGNED: (e && e.extra && e.extra.detail)
      || 'بعضی اقلام فرمول به هیچ عملیاتی وصل نیستند — در تب «مسیر عملیات» هر قلم را به عملیات مصرف‌کننده وصل کنید.',
    E_BOM_SINGLE_PRODUCT: (e && e.extra && e.extra.detail)
      || 'فرمول فقط یک محصول اصلی دارد. چند محصول را در سفارش تولید و لایه‌چینی مشترک تعریف کنید.',
    E_BOM_COMP_TYPE: name
      ? `«${name}» کالای نهایی است و نمی‌تواند مادهٔ فرمول باشد — در کارت کالا نوع را «مواد اولیه / بسته‌بندی / نیمه‌ساخته» بگذارید یا تیک ساختنی را بزنید.`
      : 'یکی از اجزاء کالای نهایی است و برای BOM مجاز نیست — نوع کالا را در کارت کالا اصلاح کنید (مواد اولیه/بسته‌بندی/نیمه‌ساخته).',
    E_BOM_COMP_COLOR: 'برای رنگ جزء «ثابت»، رنگ کاتالوگ را از فهرست انتخاب کنید.',
    E_SEQ_DUPLICATE: 'این ترتیب (seq) قبلاً ثبت شده — همان ردیف به‌روز می‌شود یا ترتیب دیگری بگذارید.',
    E_SEQ_REQUIRED: 'ترتیب عملیات (seq) الزامی است.',
    E_CC_NOT_FOUND: 'مرکز هزینه یافت نشد.',
    E_CC_NOT_STAGE: 'مرکز هزینه باید از نوع مرحله تولید باشد.',
    E_STAGE_NOT_IN_ROUTING: 'مرکز مرحلهٔ قلم در مسیر عملیات نیست.',
    E_NOT_FOUND: 'عملیات یا فرمول یافت نشد.',
    E_BOM_NOT_DRAFT: 'فقط پیش‌نویس قابل ویرایش مستقیم است — برای فرمول فعال از «نسخه جدید» استفاده کنید.',
    E_BOM_NOT_ACTIVE: 'فرمول انتخاب‌شده فعال نیست.',
    E_BOM_IN_USE: (e && e.extra && e.extra.n)
      ? (`این فرمول در ${e.extra.n} سفارش تولید باز استفاده شده و قابل بایگانی/حذف نیست.`)
      : 'فرمول در سفارش تولید باز استفاده شده و قابل بایگانی/حذف نیست.',
    E_BOM_VERSION_CLASH: 'نسخه/بازبینی این فرمول با رکورد قبلی (حتی حذف‌شده) تداخل دارد — سرور کلید یکتا را آزاد کرد؛ دوباره ذخیره/فعال‌سازی را بزنید.',
    E_BOM_CODE_CLASH: 'کد فرمول تکراری است — صفحه را تازه کنید و دوباره بسازید.',
    E_SHARE_NOT_100: 'جمع سهم هزینه همهٔ محصولات اصلی باید دقیقاً ۱۰۰٪ باشد — از «تسهیم خودکار» استفاده کنید.',
    E_NO_MAIN_OUTPUT: 'حداقل یک محصول اصلی در خروجی‌های فرمول لازم است.',
    E_MAIN_MISMATCH: 'محصول لنگر فرمول باید در لیست محصولات اصلی خروجی باشد.',
    E_OUTPUT_DUPLICATE: 'این کالا قبلاً در خروجی‌های فرمول ثبت شده است.',
    E_PRODUCT_SCOPE: 'حالت تخصیص محصول باید «مشترک» یا «اختصاصی» باشد.',
    E_SCOPED_PRODUCT_REQUIRED: 'برای تخصیص اختصاصی، محصول هدف را انتخاب کنید.',
    E_SCOPED_PRODUCT_NOT_IN_BOM: 'محصول تخصیص‌یافته در لیست محصولات اصلی این فرمول نیست.',
    E_PRODUCT_INCOMPLETE: (e && e.extra && e.extra.detail)
      || 'مشخصات ضروری کالا ناقص است — کارت کالا را تکمیل کنید.',
    E_BOM_INCOMPLETE: (e && e.extra && e.extra.detail)
      || 'فرمول یا مشخصات محصولات آن ناقص است — چک‌لیست آمادگی را ببینید.',
    E_SPEC_NAME: 'نام کالا الزامی است.',
    E_SPEC_UNIT: 'واحد کالا الزامی است.',
    E_SPEC_ITEM_TYPE: 'طبقه‌بندی تولید (نوع کالا) الزامی است.',
    E_SPEC_MANUFACTURED: 'هر محصول اصلی باید تیک ساختنی داشته باشد.',
    E_SPEC_TRADE_FG: 'کالای فروش‌محض در تولید/BOM مجاز نیست.',
    E_SPEC_FG_COLOR: 'برای رنگ inherit، رنگ محصول نهایی را در کارت کالا ثبت کنید.',
    E_SPEC_FG_SIZE: 'برای ماتریس سایز، سایز را در سیستم تعریف کنید.',
    E_ROUTING_EMPTY: 'مسیر عملیات خالی است.',
    E_YIELD_DOUBLE_COUNT: 'با مسیر عملیات، بازده فرمول باید ۱۰۰٪ باشد.',
    E_NO_COPRODUCT: 'حالت چندمحصولی نیاز به حداقل دو محصول اصلی دارد.',
    E_SPEC_CODE: 'کد کالا برای محصول ساختنی الزامی است.',
    E_SPEC_COST: 'بهای مواد صفر است — حواله/نهایی‌سازی بدون بها مجاز نیست.',
    E_BOM_NOT_ACTIVE: 'فرمول سفارش باید فعال باشد.',
  };
  if (map[code]) return map[code];
  if (/UNIQUE constraint failed: bom_headers\.product_id/i.test(String(e && e.message || ''))) {
    return map.E_BOM_VERSION_CLASH;
  }
  if (/updateOperation is not a function/i.test(code)) {
    return 'ذخیره مسیر عملیات در این نسخه درست نشد؛ صفحه را یک‌بار رفرش کنید.';
  }
  return e.message || 'خطا';
}

router.get('/', auth, requirePermission('production_bom', 'view'), (req, res) => {
  handle(res, () => bom.listBoms(getDB(), {
    product_id: req.query.product_id,
    for_product_id: req.query.for_product_id,
    include_co: req.query.include_co,
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
  handle(res, () => applyCostPolicy(getDB(), req.user,
    bom.compareBoms(getDB(), Number(req.query.a), Number(req.query.b))));
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
      const readiness = completeness.assessBom(db, Number(req.body.id), 'activate');
      return { ok: readiness.ok, readiness };
    }
    // ephemeral: create draft in transaction then rollback — use dry validate via temp insert
    const created = bom.createBom(db, req.body || {}, req.user.id);
    try {
      bom.validateBom(db, created.id);
      const readiness = completeness.assessBom(db, created.id, 'activate');
      return { ok: readiness.ok, id: created.id, readiness };
    } finally {
      // leave as draft for inspection or soft-delete
    }
  });
});

router.get('/:id/completeness', auth, requirePermission('production_bom', 'view'), (req, res) => {
  handle(res, () => completeness.assessBom(
    getDB(),
    Number(req.params.id),
    String(req.query.mode || 'activate')
  ));
});

router.get('/:id/dependencies', auth, requirePermission('production_bom', 'view'), (req, res) => {
  handle(res, () => bom.getBomDependencies(getDB(), Number(req.params.id)));
});

router.get('/:id', auth, requirePermission('production_bom', 'view'), (req, res) => {
  handle(res, () => applyCostPolicy(getDB(), req.user, bom.getBom(getDB(), Number(req.params.id))));
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
    if (req.body?.replace) {
      return bom.replaceLines(db, bomId, lines, req.user.id);
    }
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
    const data = bom.explodeBom(getDB(), {
      bomId: Number(req.params.id),
      qty: Number(req.query.qty) || 1,
      sizeBreakdown,
      color: req.query.color || null,
      priceBasis: req.query.price_basis || 'average',
    });
    return applyCostPolicy(getDB(), req.user, data);
  });
});

router.get('/:id/std-cost', auth, requirePermission('production_cost', 'view'), (req, res) => {
  handle(res, () => {
    const data = bom.stdCost(getDB(), Number(req.params.id), {
      qty: Number(req.query.qty) || 1,
      priceBasis: req.query.price_basis || 'average',
    });
    return applyCostPolicy(getDB(), req.user, data);
  });
});

router.get('/:id/tree', auth, requirePermission('production_bom', 'view'), (req, res) => {
  handle(res, () => applyCostPolicy(getDB(), req.user, bom.bomTree(getDB(), Number(req.params.id))));
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
  handle(res, () => applyCostPolicy(getDB(), req.user, {
    rows: getDB().prepare('SELECT * FROM bom_operations WHERE bom_id=? ORDER BY seq').all(Number(req.params.id)),
  }));
});

router.get('/:id/routing', auth, requirePermission('production_bom', 'view'), (req, res) => {
  handle(res, () => applyCostPolicy(getDB(), req.user, {
    rows: getDB().prepare('SELECT * FROM bom_operations WHERE bom_id=? ORDER BY seq').all(Number(req.params.id)),
  }));
});

router.post('/:id/operations', auth, requirePermission('production_bom', 'edit'), (req, res) => {
  try {
    const row = adv.addOperation(getDB(), Number(req.params.id), req.body || {}, req.user.id);
    res.status(201).json(applyCostPolicy(getDB(), req.user, row));
  } catch (e) {
    res.status(e.status || 500).json({ error: bomFaError(e), code: e.code || e.message });
  }
});

router.put('/:id/operations/:opId', auth, requirePermission('production_bom', 'edit'), (req, res) => {
  handle(res, () => {
    const fn = adv && typeof adv.updateOperation === 'function'
      ? adv.updateOperation
      : require('../lib/production/bom-advanced').updateOperation;
    if (typeof fn !== 'function') {
      const e = new Error('ذخیره عملیات در این نسخه در دسترس نیست');
      e.status = 500;
      e.code = 'E_OP_SAVE';
      throw e;
    }
    return applyCostPolicy(getDB(), req.user,
      fn(getDB(), Number(req.params.id), Number(req.params.opId), req.body || {}));
  });
});

router.delete('/:id/operations/:opId', auth, requirePermission('production_bom', 'edit'), (req, res) => {
  handle(res, () => adv.deleteOperation(getDB(), Number(req.params.id), Number(req.params.opId)));
});

router.post('/:id/operations/resequence', auth, requirePermission('production_bom', 'edit'), (req, res) => {
  handle(res, () => applyCostPolicy(getDB(), req.user, {
    rows: adv.resequenceOperations(getDB(), Number(req.params.id)),
  }));
});

router.get('/:id/assignments', auth, requirePermission('production_bom', 'view'), (req, res) => {
  const asg = require('../lib/production/bom-assignments');
  handle(res, () => applyCostPolicy(getDB(), req.user, {
    rows: asg.listAssignments(getDB(), Number(req.params.id)),
    // v527: اقلام بدون عملیات (فقط وقتی فرمول مسیر عملیات دارد)
    unassigned: asg.unassignedBomLines(getDB(), Number(req.params.id)),
  }));
});

router.put('/:id/assignments', auth, requirePermission('production_bom', 'edit'), (req, res) => {
  const asg = require('../lib/production/bom-assignments');
  handle(res, () => {
    const db = getDB();
    const bomId = Number(req.params.id);
    const rows = asg.replaceAssignments(db, bomId, req.body?.assignments || req.body || [], req.user.id);
    return applyCostPolicy(db, req.user, { rows, unassigned: asg.unassignedBomLines(db, bomId) });
  });
});

router.get('/:id/allowed-variants', auth, requirePermission('production_bom', 'view'), (req, res) => {
  const asg = require('../lib/production/bom-assignments');
  handle(res, () => ({
    rows: asg.listAllowedVariants(getDB(), Number(req.params.id)),
  }));
});

router.put('/:id/allowed-variants', auth, requirePermission('production_bom', 'edit'), (req, res) => {
  const asg = require('../lib/production/bom-assignments');
  handle(res, () => ({
    rows: asg.replaceAllowedVariants(getDB(), Number(req.params.id), req.body?.variants || req.body || []),
  }));
});

router.post('/:id/assignments/backfill', auth, requirePermission('production_bom', 'edit'), (req, res) => {
  const asg = require('../lib/production/bom-assignments');
  handle(res, () => asg.backfillAssignmentsFromStageCc(getDB(), Number(req.params.id), req.user.id));
});

router.get('/:id/outputs', auth, requirePermission('production_bom', 'view'), (req, res) => {
  handle(res, () => applyCostPolicy(getDB(), req.user, {
    rows: getDB().prepare('SELECT * FROM bom_outputs WHERE bom_id=?').all(Number(req.params.id)),
  }));
});

router.post('/:id/outputs', auth, requirePermission('production_bom', 'edit'), (req, res) => {
  try {
    const row = adv.addOutput(getDB(), Number(req.params.id), req.body || {});
    res.status(201).json(applyCostPolicy(getDB(), req.user, row));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, code: e.code || e.message });
  }
});

router.put('/:id/outputs/:outId', auth, requirePermission('production_bom', 'edit'), (req, res) => {
  handle(res, () => applyCostPolicy(getDB(), req.user,
    adv.updateOutput(getDB(), Number(req.params.id), Number(req.params.outId), req.body || {})));
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
    return applyCostPolicy(getDB(), req.user, adv.autoShare(getDB(), Number(req.params.id), method));
  });
});

/** Multi-product share: ensure peer main products, optional auto-share */
router.post('/:id/outputs/ensure-share', auth, requirePermission('production_bom', 'edit'), (req, res) => {
  handle(res, () => {
    const db = getDB();
    const bomId = Number(req.params.id);
    const method = req.body?.auto_share_method || req.body?.method || 'sales_value';
    const peers = req.body?.main_product_ids || req.body?.peer_product_ids
      || req.body?.co_product_ids || req.body?.product_ids || [];
    const rows = adv.ensureShareOutputs(db, bomId, {
      mainProductId: req.body?.main_product_id,
      peerProductIds: peers,
      autoShare: method === 'none' ? null : method,
    });
    return applyCostPolicy(db, req.user, { rows });
  });
});

router.get('/:id/backward-qty', auth, requirePermission('production_bom', 'view'), (req, res) => {
  handle(res, () => adv.backwardQty(getDB(), Number(req.params.id), Number(req.query.target) || 1));
});

function readOutputQtys(query) {
  const q = query || {};
  if (q.output_qtys) return q.output_qtys;
  const map = {};
  for (const [k, v] of Object.entries(q)) {
    const m = /^qty_(\d+)$/.exec(k);
    if (m) map[m[1]] = v;
  }
  return Object.keys(map).length ? map : null;
}

router.get('/:id/full-cost', auth, requirePermission('production_cost', 'view'), (req, res) => {
  handle(res, () => {
    adv.clearRollUpMemo();
    const outputQtys = readOutputQtys(req.query);
    const data = adv.rollUpBom(getDB(), {
      bomId: Number(req.params.id),
      qtyTarget: Number(req.query.qty) || 1,
      period: req.query.period || '',
      priceBasis: req.query.price_basis || 'average',
      outputQtys,
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
      outputQtys: readOutputQtys(req.query),
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
