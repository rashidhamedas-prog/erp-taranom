const router = require('express').Router();
const { getDB, audit } = require('../db');
const { auth, adminOrAccounting, requireWarehouseOps } = require('../middleware/auth');

// Warehouse Phase 2 — acc_warehouse_ops: view (reads) | create (start/count/complete) | delete (=void/delete).
// orDelegatedAccounting keeps existing acc_stocktaking delegates working; `apply` (posts JE) stays
// admin/accounting-only so a create-only storekeeper can count but never apply.
// v578 (Phase 5): create = count entry · apply = admin/accounting (posts the «مغایرت انبارگردانی» JE) ·
// void/delete = acc_warehouse_ops:delete (R13 full reverse). Blind sheet = /:id/sheet (no system qty).
const stView = requireWarehouseOps('view', { orDelegatedAccounting: true });
const stCreate = requireWarehouseOps('create', { orDelegatedAccounting: true });
const stVoid = requireWarehouseOps('delete', { orDelegatedAccounting: true });
const { applyCycleCount, voidCycleCount, syncSessionVariantLines, createSession, lockMode, STOCKTAKE_DOC_TYPE, STOCKTAKE_DOC_LABEL } = require('../lib/inventory/cycle-count');
const { round3, parseQty } = require('../lib/round3');

/** v578 — open (draft/completed) sessions freeze movements on their warehouse unless the lock is off/warn. */
function withLockInfo(db, s) {
  if (!s) return s;
  const open = s.status === 'draft' || s.status === 'completed';
  const mode = lockMode(db);
  return {
    ...s,
    movements_locked: open && mode === 'lock' ? 1 : 0,
    movement_lock_mode: mode,
    snapshot_source: s.snapshot_source || 'legacy',
    adjust_doc_type: STOCKTAKE_DOC_TYPE,
    adjust_doc_label: STOCKTAKE_DOC_LABEL,
  };
}

function qtyFromConfirmed(it, fallback) {
  const conf = parseInt(it.confirmed_count, 10) || 1;
  if (conf === 2 && it.count2_qty != null && it.count2_qty !== '') return parseQty(it.count2_qty);
  if (conf === 3 && it.count3_qty != null && it.count3_qty !== '') return parseQty(it.count3_qty);
  if (it.count1_qty != null && it.count1_qty !== '') return parseQty(it.count1_qty);
  if (it.counted_qty != null && it.counted_qty !== '') return parseQty(it.counted_qty);
  return parseQty(fallback);
}

router.get('/', auth, stView, (req, res) => {
  const db = getDB();
  const { warehouse_id, user_id, date_from, date_to, status } = req.query;
  const where = [];
  const params = [];
  if (warehouse_id) { where.push('s.warehouse_id=?'); params.push(parseInt(warehouse_id, 10)); }
  if (user_id) { where.push('s.responsible_user_id=?'); params.push(parseInt(user_id, 10)); }
  if (status) { where.push('s.status=?'); params.push(status); }
  if (date_from) { where.push('s.date >= ?'); params.push(date_from); }
  if (date_to) { where.push('s.date <= ?'); params.push(date_to); }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const rows = db.prepare(`
    SELECT s.*, w.name as warehouse_name, u.name as responsible_name, c.name as creator_name
    FROM stocktaking_sessions s
    LEFT JOIN warehouses w ON s.warehouse_id=w.id
    LEFT JOIN users u ON s.responsible_user_id=u.id
    LEFT JOIN users c ON s.created_by=c.id
    ${whereSql}
    ORDER BY s.created_at DESC LIMIT 200
  `).all(...params);
  res.json(rows.map((r) => withLockInfo(db, r)));
});

/**
 * BLIND count sheet (v578): what a storekeeper prints / counts from. NO system, snapshot, counted
 * or per-round qty — not even the pre-filled counted=system defaults — only identity + tag fields.
 */
function blindSheet(req, res) {
  const db = getDB();
  const session = db.prepare(`
    SELECT s.id, s.status, s.date, s.note, s.warehouse_id, w.name AS warehouse_name, u.name AS responsible_name
    FROM stocktaking_sessions s
    LEFT JOIN warehouses w ON s.warehouse_id=w.id
    LEFT JOIN users u ON s.responsible_user_id=u.id
    WHERE s.id=?
  `).get(req.params.id);
  if (!session) return res.status(404).json({ error: 'یافت نشد' });
  if (session.status !== 'adjusted') syncSessionVariantLines(db, session.id);
  const items = db.prepare(`
    SELECT i.id, i.product_id, i.variant_id, i.count_tag, p.code, p.name, p.unit,
      pc.name AS color_name, ps.name AS size_name
    FROM stocktaking_items i
    JOIN products p ON i.product_id=p.id
    LEFT JOIN product_variants pv ON pv.id=i.variant_id
    LEFT JOIN product_colors pc ON pc.id=pv.color_id
    LEFT JOIN product_sizes ps ON ps.id=pv.size_id
    WHERE i.session_id=?
    ORDER BY i.count_tag, p.name, pc.name, ps.name, i.id
  `).all(session.id);
  res.json({ session_id: session.id, blind: true, session, items });
}
router.get('/:id/sheet', auth, stView, blindSheet);
router.get('/:id/tags', auth, stView, blindSheet);

router.get('/:id', auth, stView, (req, res) => {
  const db = getDB();
  const session = db.prepare(`
    SELECT s.*, w.name as warehouse_name, u.name as responsible_name
    FROM stocktaking_sessions s
    LEFT JOIN warehouses w ON s.warehouse_id=w.id
    LEFT JOIN users u ON s.responsible_user_id=u.id
    WHERE s.id=?
  `).get(req.params.id);
  if (!session) return res.status(404).json({ error: 'یافت نشد' });
  if (session.status !== 'adjusted') syncSessionVariantLines(db, session.id);
  const items = db.prepare(`
    SELECT i.*, p.code, p.name, p.unit, pc.name AS color_name, ps.name AS size_name,
      COALESCE(ws.qty, CASE WHEN p.warehouse_id=? THEN p.stock ELSE 0 END) AS header_qty
    FROM stocktaking_items i
    JOIN products p ON i.product_id=p.id
    LEFT JOIN product_variants pv ON pv.id=i.variant_id
    LEFT JOIN product_colors pc ON pc.id=pv.color_id
    LEFT JOIN product_sizes ps ON ps.id=pv.size_id
    LEFT JOIN warehouse_stock ws ON ws.product_id=p.id AND ws.warehouse_id=?
    WHERE i.session_id=?
    ORDER BY p.name, pc.name, ps.name, i.id
  `).all(session.warehouse_id, session.warehouse_id, session.id);
  // variance = counted − FROZEN kardex snapshot (never live stock).
  items.forEach((it) => {
    const snap = it.snapshot_qty != null && it.snapshot_qty !== '' ? Number(it.snapshot_qty) : (Number(it.system_qty) || 0);
    it.snapshot_qty = round3(snap);
    it.system_qty = round3(snap);
    it.variance = round3((it.counted_qty || 0) - snap);
  });
  res.json({ session: withLockInfo(db, session), items });
});

router.post('/', auth, stCreate, (req, res) => {
  const { warehouse_id, date, responsible_user_id, note } = req.body;
  const whId = parseInt(warehouse_id, 10);
  if (!whId) return res.status(400).json({ error: 'انبار الزامی است' });
  const db = getDB();
  try {
    // system_qty = kardex snapshot (Σ live ledger) frozen NOW per product × warehouse × variant.
    const out = createSession(db, {
      warehouseId: whId,
      date,
      responsibleUserId: responsible_user_id ? parseInt(responsible_user_id, 10) : req.user.id,
      note,
      createdBy: req.user.id,
    });
    audit(req.user.id, 'create', 'stocktaking', out.id,
      `شروع انبارگردانی انبار #${whId} — snapshot کاردکس ${out.item_count} قلم`);
    res.json(out);
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message, code: e.code, session_id: e.session_id });
  }
});

router.put('/:id/items', auth, stCreate, (req, res) => {
  const db = getDB();
  const session = db.prepare('SELECT * FROM stocktaking_sessions WHERE id=?').get(req.params.id);
  if (!session) return res.status(404).json({ error: 'یافت نشد' });
  if (session.status === 'adjusted') return res.status(400).json({ error: 'این انبارگردانی قبلاً اعمال شده است' });
  const items = req.body.items || [];
  const upd = db.prepare(`
    UPDATE stocktaking_items SET
      count1_qty=?, count2_qty=?, count3_qty=?, count_tag=?, confirmed_count=?, counted_qty=?
    WHERE id=? AND session_id=?
  `);
  db.transaction(() => {
    for (const it of items) {
      if (!it.id) continue;
      const row = db.prepare('SELECT * FROM stocktaking_items WHERE id=? AND session_id=?').get(it.id, session.id);
      if (!row) continue;
      const count1 = it.count1_qty != null && it.count1_qty !== '' ? parseQty(it.count1_qty) : round3(row.count1_qty != null ? row.count1_qty : row.system_qty || 0);
      const count2 = it.count2_qty != null && it.count2_qty !== '' ? parseQty(it.count2_qty) : (row.count2_qty != null ? round3(row.count2_qty) : null);
      const count3 = it.count3_qty != null && it.count3_qty !== '' ? parseQty(it.count3_qty) : (row.count3_qty != null ? round3(row.count3_qty) : null);
      const count_tag = it.count_tag != null ? String(it.count_tag) : (row.count_tag || null);
      const confirmed = it.confirmed_count != null ? (parseInt(it.confirmed_count, 10) || 1) : (row.confirmed_count || 1);
      const counted = qtyFromConfirmed({
        confirmed_count: confirmed,
        count1_qty: count1,
        count2_qty: count2,
        count3_qty: count3,
        counted_qty: it.counted_qty,
      }, row.counted_qty || 0);
      upd.run(count1, count2, count3, count_tag, confirmed, Math.max(0, counted), it.id, session.id);
    }
  })();
  res.json({ ok: true });
});

router.post('/:id/complete', auth, stCreate, (req, res) => {
  const db = getDB();
  const session = db.prepare('SELECT * FROM stocktaking_sessions WHERE id=?').get(req.params.id);
  if (!session) return res.status(404).json({ error: 'یافت نشد' });
  if (session.status === 'adjusted') return res.status(400).json({ error: 'قبلاً اعمال شده' });
  db.prepare("UPDATE stocktaking_sessions SET status='completed' WHERE id=?").run(session.id);
  audit(req.user.id, 'update', 'stocktaking', session.id, 'تکمیل انبارگردانی');
  res.json({ ok: true });
});

router.post('/:id/apply', auth, adminOrAccounting, (req, res) => {
  try {
    const db = getDB();
    const result = applyCycleCount(db, +req.params.id, { createdBy: req.user.id });
    audit(req.user.id, 'approve', 'stocktaking', req.params.id,
      `اعمال ${STOCKTAKE_DOC_LABEL} (سود ${result.total_gain_rial} / زیان ${result.total_loss_rial} ریال)`);
    res.json(result);
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
});

router.post('/:id/void', auth, stVoid, (req, res) => {
  try {
    const db = getDB();
    const result = voidCycleCount(db, +req.params.id, { createdBy: req.user.id });
    audit(req.user.id, 'reverse', 'stocktaking', req.params.id, 'ابطال اعمال انبارگردانی');
    res.json(result);
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
});

router.delete('/:id', auth, stVoid, (req, res) => {
  const db = getDB();
  const session = db.prepare('SELECT * FROM stocktaking_sessions WHERE id=?').get(req.params.id);
  if (!session) return res.status(404).json({ error: 'یافت نشد' });
  if (session.status === 'adjusted') {
    return res.status(400).json({ error: 'انبارگردانی اعمال‌شده را ابتدا ابطال کنید، سپس حذف کنید' });
  }
  db.prepare('DELETE FROM stocktaking_items WHERE session_id=?').run(session.id);
  db.prepare('DELETE FROM stocktaking_sessions WHERE id=?').run(session.id);
  audit(req.user.id, 'delete', 'stocktaking', session.id, 'حذف انبارگردانی');
  res.json({ ok: true });
});

module.exports = router;
