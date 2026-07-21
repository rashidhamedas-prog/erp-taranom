/**
 * Portal Karmandan — operational units, departments, and parameter workflow.
 * Spec: docs/PORTAL-KARMANDAN-SPEC.md
 */
const router = require('express').Router();
const { getDB, audit, allocateNumber, createJournalEntry } = require('../db');
const { auth, requirePermission, centralOnly } = require('../middleware/auth');
const { ensurePersonUser } = require('../lib/portal-users');
const { postInventoryMovement, warehouseQty, invErr } = require('../lib/inventory/ledger');
const { acct } = require('../lib/coa-map');
const { postToLedger } = require('../lib/ledger');
const { rialToLedger } = require('../lib/money');
const { todayJalali } = require('../jalali');
const { notifyRoles } = require('../lib/notifications');
const { round3, parseQty } = require('../lib/round3');

// ─── helpers ───────────────────────────────────────────────────────────────

function nowEpoch(db) {
  return db.prepare("SELECT strftime('%s','now') v").get().v;
}

function hasTable(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function personIdForUser(db, user) {
  if (!user?.username) return null;
  const p = db.prepare('SELECT id FROM persons WHERE phone=?').get(String(user.username).trim());
  return p?.id || null;
}

/** null = unrestricted (admin/accounting); [] = no scope */
function scopeUnitIds(db, user) {
  if (['admin', 'accounting'].includes(user.role)) return null;
  const pid = personIdForUser(db, user);
  if (!pid) return [];
  if (user.role === 'unit_manager') {
    return db.prepare(`
      SELECT id FROM op_units WHERE status!='archived' AND (
        manager_person_id=? OR manager2_person_id=? OR manager3_person_id=?
      )
    `).all(pid, pid, pid).map(r => r.id);
  }
  if (user.role === 'department_manager') {
    return db.prepare(`
      SELECT DISTINCT unit_id AS id FROM op_departments
      WHERE manager_person_id=? AND status='active'
    `).all(pid).map(r => r.id);
  }
  return [];
}

function scopeDeptIds(db, user) {
  if (['admin', 'accounting'].includes(user.role)) return null;
  const pid = personIdForUser(db, user);
  if (!pid) return [];
  if (user.role === 'department_manager') {
    return db.prepare(`
      SELECT id FROM op_departments WHERE manager_person_id=? AND status='active'
    `).all(pid).map(r => r.id);
  }
  if (user.role === 'unit_manager') {
    const uids = scopeUnitIds(db, user);
    if (!uids.length) return [];
    const ph = uids.map(() => '?').join(',');
    return db.prepare(`SELECT id FROM op_departments WHERE unit_id IN (${ph}) AND status='active'`)
      .all(...uids).map(r => r.id);
  }
  return [];
}

function canAccessUnit(db, user, unitId) {
  const ids = scopeUnitIds(db, user);
  if (ids === null) return true;
  return ids.includes(parseInt(unitId, 10));
}

function canAccessParam(db, user, param) {
  if (['admin', 'accounting'].includes(user.role)) return true;
  const uids = scopeUnitIds(db, user);
  if (uids !== null && uids.includes(param.unit_id)) return true;
  const dids = scopeDeptIds(db, user);
  if (dids !== null && param.current_department_id && dids.includes(param.current_department_id)) return true;
  return false;
}

function personDetailId(db, personId) {
  const da = db.prepare(`
    SELECT id FROM detail_accounts
    WHERE linked_table='persons' AND linked_id=? AND is_active=1
  `).get(personId);
  return da?.id || null;
}

function stockErrPersian(e, whName) {
  if (e.code === 'E_NEGATIVE_STOCK' || (e.available != null && e.needed != null)) {
    return `موجودی انبار ${whName || ''} کافی نیست (موجود: ${e.available ?? e.message}، نیاز: ${e.needed ?? ''})`.trim();
  }
  if (/موجود/.test(e.message || '')) return e.message;
  return e.message || 'خطای موجودی انبار';
}

function syncUnitWarehouses(db, unitId, warehouseIds) {
  db.prepare('DELETE FROM op_unit_warehouses WHERE unit_id=?').run(unitId);
  const ins = db.prepare('INSERT INTO op_unit_warehouses (unit_id, warehouse_id) VALUES (?,?)');
  for (const wid of warehouseIds || []) {
    const w = parseInt(wid, 10);
    if (w) ins.run(unitId, w);
  }
}

function syncUnitPersons(db, unitId, personIds) {
  db.prepare('DELETE FROM op_unit_persons WHERE unit_id=?').run(unitId);
  const ins = db.prepare('INSERT INTO op_unit_persons (unit_id, person_id) VALUES (?,?)');
  for (const pid of personIds || []) {
    const p = parseInt(pid, 10);
    if (p) ins.run(unitId, p);
  }
}

function assertDeptUnlocked(db, param, deptId) {
  const dept = db.prepare('SELECT * FROM op_departments WHERE id=?').get(deptId);
  if (!dept) {
    const e = new Error('بخش یافت نشد');
    e.status = 404;
    throw e;
  }
  const log = db.prepare(`
    SELECT * FROM op_parameter_dept_log WHERE parameter_id=? AND department_id=?
  `).get(param.id, deptId);
  if (!log) {
    const e = new Error('لاگ بخش یافت نشد');
    e.status = 404;
    throw e;
  }
  if (log.sequence_order > 1) {
    const prev = db.prepare(`
      SELECT status FROM op_parameter_dept_log
      WHERE parameter_id=? AND sequence_order=?
    `).get(param.id, log.sequence_order - 1);
    if (!prev || prev.status !== 'completed') {
      const e = new Error('بخش قبلی هنوز تکمیل نشده — عملیات مجاز نیست');
      e.status = 409;
      throw e;
    }
  }
  if (param.current_department_id && param.current_department_id !== deptId && log.status !== 'completed') {
    const e = new Error('این بخش در حال حاضر فعال نیست');
    e.status = 409;
    throw e;
  }
  return { dept, log };
}

function transferBetweenWarehouses(db, { productId, fromWh, toWh, qty, userId, note, date }) {
  const q = parseQty(qty);
  if (!q || q <= 0) throw new Error('تعداد انتقال معتبر نیست');
  const product = db.prepare('SELECT * FROM products WHERE id=?').get(productId);
  if (!product) throw new Error('کالا یافت نشد');
  const fromWarehouse = db.prepare('SELECT * FROM warehouses WHERE id=?').get(fromWh);
  const toWarehouse = db.prepare('SELECT * FROM warehouses WHERE id=?').get(toWh);
  if (!fromWarehouse || !toWarehouse) throw new Error('انبار مبدأ یا مقصد یافت نشد');
  const available = warehouseQty(db, productId, fromWh);
  if (available < q) {
    const e = new Error(stockErrPersian({ available, needed: q }, fromWarehouse.name));
    e.status = 400;
    throw e;
  }
  const d = date || todayJalali();
  const unit = Math.round(Number(product.average_cost_rial) || 0);
  const ledOut = postInventoryMovement(db, {
    eventType: 'transfer_out',
    productId,
    warehouseId: fromWh,
    qty: -q,
    unitCostRial: unit,
    sourceType: 'portal_transfer',
    date: d,
    note: note || `خروج انتقال به ${toWarehouse.name}`,
    createdBy: userId,
    updateAvg: false,
  });
  const ledIn = postInventoryMovement(db, {
    eventType: 'transfer_in',
    productId,
    warehouseId: toWh,
    qty: q,
    unitCostRial: unit,
    amountRial: ledOut.amount_rial,
    sourceType: 'portal_transfer',
    date: d,
    note: note || `ورود انتقال از ${fromWarehouse.name}`,
    createdBy: userId,
    updateAvg: false,
  });
  const move = db.prepare(`
    INSERT INTO warehouse_moves
      (type,product_id,from_warehouse_id,to_warehouse_id,qty,date,note,created_by,ledger_id,unit_cost_rial,amount_rial,status)
    VALUES ('transfer',?,?,?,?,?,?,?,?,?,?,'posted')
  `).run(productId, fromWh, toWh, q, d, note || '', userId, ledOut.id, unit, ledOut.amount_rial);
  db.prepare('UPDATE inventory_ledger SET source_id=? WHERE id IN (?,?)').run(move.lastInsertRowid, ledOut.id, ledIn.id);
  return move.lastInsertRowid;
}

function loadParam(db, id) {
  return db.prepare('SELECT * FROM op_parameters WHERE id=?').get(id);
}

function unitHasActiveParams(db, unitId) {
  return db.prepare(`
    SELECT COUNT(*) c FROM op_parameters
    WHERE unit_id=? AND status IN ('initiated','in_progress','under_review')
  `).get(unitId).c > 0;
}

function nextDept(db, unitId, afterSequence) {
  return db.prepare(`
    SELECT * FROM op_departments
    WHERE unit_id=? AND status='active' AND sequence_order>?
    ORDER BY sequence_order ASC LIMIT 1
  `).get(unitId, afterSequence);
}

function portalNotify(db, opts) {
  try {
    notifyRoles(db, opts);
  } catch (_) { /* non-fatal */ }
}

// ─── units (config — centralOnly) ──────────────────────────────────────────

router.post('/units', auth, centralOnly, requirePermission('portal', 'create'), (req, res) => {
  const {
    name, manager_person_id, manager2_person_id, manager3_person_id,
    output_type, warehouse_ids, person_ids,
  } = req.body;
  if (!name || !manager_person_id) {
    return res.status(400).json({ error: 'نام واحد و مدیر اصلی الزامی است' });
  }
  const db = getDB();
  let unitId;
  try {
    db.transaction(() => {
      ensurePersonUser(db, parseInt(manager_person_id, 10), 'unit_manager');
      if (manager2_person_id) ensurePersonUser(db, parseInt(manager2_person_id, 10), 'unit_manager');
      if (manager3_person_id) ensurePersonUser(db, parseInt(manager3_person_id, 10), 'unit_manager');
      const r = db.prepare(`
        INSERT INTO op_units (name, manager_person_id, manager2_person_id, manager3_person_id, output_type, created_by)
        VALUES (?,?,?,?,?,?)
      `).run(
        String(name).trim(),
        parseInt(manager_person_id, 10),
        manager2_person_id ? parseInt(manager2_person_id, 10) : null,
        manager3_person_id ? parseInt(manager3_person_id, 10) : null,
        output_type || '',
        req.user.id
      );
      unitId = r.lastInsertRowid;
      syncUnitWarehouses(db, unitId, warehouse_ids);
      syncUnitPersons(db, unitId, person_ids);
    })();
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message });
  }
  audit(req.user.id, 'create', 'op_unit', unitId, `ساخت واحد عملیاتی ${name}`);
  res.json(db.prepare('SELECT * FROM op_units WHERE id=?').get(unitId));
});

router.get('/units', auth, requirePermission('portal', 'view'), (req, res) => {
  const db = getDB();
  const ids = scopeUnitIds(db, req.user);
  let rows;
  if (ids === null) {
    rows = db.prepare("SELECT * FROM op_units WHERE status!='archived' ORDER BY name").all();
  } else if (!ids.length) {
    rows = [];
  } else {
    const ph = ids.map(() => '?').join(',');
    rows = db.prepare(`SELECT * FROM op_units WHERE id IN (${ph}) AND status!='archived' ORDER BY name`).all(...ids);
  }
  res.json(rows);
});

router.get('/units/:id', auth, requirePermission('portal', 'view'), (req, res) => {
  const db = getDB();
  const unit = db.prepare('SELECT * FROM op_units WHERE id=?').get(req.params.id);
  if (!unit || unit.status === 'archived') return res.status(404).json({ error: 'یافت نشد' });
  if (!canAccessUnit(db, req.user, unit.id)) return res.status(403).json({ error: 'دسترسی ندارید' });
  const departments = db.prepare(`
    SELECT d.*, w.name AS warehouse_name, p.name AS manager_name
    FROM op_departments d
    LEFT JOIN warehouses w ON d.warehouse_id=w.id
    LEFT JOIN persons p ON d.manager_person_id=p.id
    WHERE d.unit_id=? AND d.status='active'
    ORDER BY d.sequence_order
  `).all(unit.id);
  const warehouses = db.prepare(`
    SELECT w.* FROM op_unit_warehouses uw
    JOIN warehouses w ON uw.warehouse_id=w.id
    WHERE uw.unit_id=?
  `).all(unit.id);
  const persons = db.prepare(`
    SELECT p.* FROM op_unit_persons up
    JOIN persons p ON up.person_id=p.id
    WHERE up.unit_id=?
  `).all(unit.id);
  res.json({ ...unit, departments, warehouses, persons });
});

router.put('/units/:id', auth, centralOnly, requirePermission('portal', 'edit'), (req, res) => {
  const db = getDB();
  const unit = db.prepare('SELECT * FROM op_units WHERE id=?').get(req.params.id);
  if (!unit || unit.status === 'archived') return res.status(404).json({ error: 'یافت نشد' });
  const {
    name, manager_person_id, manager2_person_id, manager3_person_id,
    output_type, status, warehouse_ids, person_ids,
  } = req.body;
  try {
    db.transaction(() => {
      if (manager_person_id) ensurePersonUser(db, parseInt(manager_person_id, 10), 'unit_manager');
      if (manager2_person_id) ensurePersonUser(db, parseInt(manager2_person_id, 10), 'unit_manager');
      if (manager3_person_id) ensurePersonUser(db, parseInt(manager3_person_id, 10), 'unit_manager');
      db.prepare(`
        UPDATE op_units SET
          name=?, manager_person_id=?, manager2_person_id=?, manager3_person_id=?,
          output_type=?, status=?, updated_at=strftime('%s','now')
        WHERE id=?
      `).run(
        name || unit.name,
        manager_person_id != null ? parseInt(manager_person_id, 10) : unit.manager_person_id,
        manager2_person_id != null ? (manager2_person_id ? parseInt(manager2_person_id, 10) : null) : unit.manager2_person_id,
        manager3_person_id != null ? (manager3_person_id ? parseInt(manager3_person_id, 10) : null) : unit.manager3_person_id,
        output_type != null ? output_type : unit.output_type,
        status || unit.status,
        unit.id
      );
      if (warehouse_ids) syncUnitWarehouses(db, unit.id, warehouse_ids);
      if (person_ids) syncUnitPersons(db, unit.id, person_ids);
    })();
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message });
  }
  audit(req.user.id, 'update', 'op_unit', unit.id, `ویرایش واحد ${name || unit.name}`);
  res.json({ ok: true });
});

router.delete('/units/:id', auth, centralOnly, requirePermission('portal', 'edit'), (req, res) => {
  const db = getDB();
  const unit = db.prepare('SELECT * FROM op_units WHERE id=?').get(req.params.id);
  if (!unit) return res.status(404).json({ error: 'یافت نشد' });
  db.prepare("UPDATE op_units SET status='archived', updated_at=strftime('%s','now') WHERE id=?").run(unit.id);
  audit(req.user.id, 'archive', 'op_unit', unit.id, `بایگانی واحد ${unit.name}`);
  res.json({ ok: true });
});

// ─── departments (config — centralOnly) ────────────────────────────────────

router.post('/units/:id/departments', auth, centralOnly, requirePermission('portal', 'create'), (req, res) => {
  const { name, manager_person_id, warehouse_id, sequence_order } = req.body;
  if (!name || !manager_person_id || !warehouse_id) {
    return res.status(400).json({ error: 'نام، مدیر و انبار بخش الزامی است' });
  }
  const db = getDB();
  const unitId = parseInt(req.params.id, 10);
  const unit = db.prepare('SELECT * FROM op_units WHERE id=?').get(unitId);
  if (!unit || unit.status === 'archived') return res.status(404).json({ error: 'واحد یافت نشد' });
  const whLink = db.prepare('SELECT 1 FROM op_unit_warehouses WHERE unit_id=? AND warehouse_id=?')
    .get(unitId, parseInt(warehouse_id, 10));
  if (!whLink) return res.status(400).json({ error: 'انبار باید به همین واحد متصل باشد' });
  let deptId;
  try {
    db.transaction(() => {
      ensurePersonUser(db, parseInt(manager_person_id, 10), 'department_manager');
      let seq = parseInt(sequence_order, 10);
      if (!seq) {
        seq = (db.prepare('SELECT COALESCE(MAX(sequence_order),0)+1 s FROM op_departments WHERE unit_id=?').get(unitId).s);
      }
      const r = db.prepare(`
        INSERT INTO op_departments (unit_id, name, manager_person_id, warehouse_id, sequence_order)
        VALUES (?,?,?,?,?)
      `).run(unitId, String(name).trim(), parseInt(manager_person_id, 10), parseInt(warehouse_id, 10), seq);
      deptId = r.lastInsertRowid;
    })();
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message });
  }
  audit(req.user.id, 'create', 'op_department', deptId, `افزودن بخش ${name} به واحد ${unit.name}`);
  res.json(db.prepare('SELECT * FROM op_departments WHERE id=?').get(deptId));
});

router.get('/units/:id/departments', auth, requirePermission('portal', 'view'), (req, res) => {
  const db = getDB();
  const unitId = parseInt(req.params.id, 10);
  if (!canAccessUnit(db, req.user, unitId)) return res.status(403).json({ error: 'دسترسی ندارید' });
  const rows = db.prepare(`
    SELECT d.*, w.name AS warehouse_name, p.name AS manager_name
    FROM op_departments d
    LEFT JOIN warehouses w ON d.warehouse_id=w.id
    LEFT JOIN persons p ON d.manager_person_id=p.id
    WHERE d.unit_id=? AND d.status='active'
    ORDER BY d.sequence_order
  `).all(unitId);
  res.json(rows);
});

router.put('/departments/:id', auth, centralOnly, requirePermission('portal', 'edit'), (req, res) => {
  const db = getDB();
  const dept = db.prepare('SELECT * FROM op_departments WHERE id=?').get(req.params.id);
  if (!dept) return res.status(404).json({ error: 'یافت نشد' });
  const { name, manager_person_id, warehouse_id, status } = req.body;
  if (warehouse_id) {
    const whLink = db.prepare('SELECT 1 FROM op_unit_warehouses WHERE unit_id=? AND warehouse_id=?')
      .get(dept.unit_id, parseInt(warehouse_id, 10));
    if (!whLink) return res.status(400).json({ error: 'انبار باید به واحد متصل باشد' });
  }
  try {
    db.transaction(() => {
      if (manager_person_id) ensurePersonUser(db, parseInt(manager_person_id, 10), 'department_manager');
      db.prepare(`
        UPDATE op_departments SET name=?, manager_person_id=?, warehouse_id=?, status=?
        WHERE id=?
      `).run(
        name || dept.name,
        manager_person_id != null ? parseInt(manager_person_id, 10) : dept.manager_person_id,
        warehouse_id != null ? parseInt(warehouse_id, 10) : dept.warehouse_id,
        status || dept.status,
        dept.id
      );
    })();
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message });
  }
  audit(req.user.id, 'update', 'op_department', dept.id, `ویرایش بخش ${name || dept.name}`);
  res.json({ ok: true });
});

router.put('/departments/:id/sequence', auth, centralOnly, requirePermission('portal', 'edit'), (req, res) => {
  const { sequence_order } = req.body;
  const newSeq = parseInt(sequence_order, 10);
  if (!newSeq || newSeq < 1) return res.status(400).json({ error: 'ترتیب معتبر الزامی است' });
  const db = getDB();
  const dept = db.prepare('SELECT * FROM op_departments WHERE id=?').get(req.params.id);
  if (!dept) return res.status(404).json({ error: 'یافت نشد' });
  if (unitHasActiveParams(db, dept.unit_id)) {
    return res.status(409).json({ error: 'امکان تغییر گردش‌کار نیست؛ پارامتر فعال وجود دارد' });
  }
  const conflict = db.prepare(`
    SELECT id FROM op_departments WHERE unit_id=? AND sequence_order=? AND id!=?
  `).get(dept.unit_id, newSeq, dept.id);
  if (conflict) {
    db.transaction(() => {
      db.prepare('UPDATE op_departments SET sequence_order=? WHERE id=?').run(dept.sequence_order, conflict.id);
      db.prepare('UPDATE op_departments SET sequence_order=? WHERE id=?').run(newSeq, dept.id);
    })();
  } else {
    db.prepare('UPDATE op_departments SET sequence_order=? WHERE id=?').run(newSeq, dept.id);
  }
  audit(req.user.id, 'update', 'op_department', dept.id, `تغییر ترتیب بخش به ${newSeq}`);
  res.json({ ok: true });
});

// ─── parameters (ops — syncable) ───────────────────────────────────────────

router.post('/parameters', auth, requirePermission('portal', 'create'), (req, res) => {
  const { name, unit_id, items, description, source_warehouse_id } = req.body;
  if (!name || !unit_id || !Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: 'نام، واحد و حداقل یک قلم کالا الزامی است' });
  }
  const db = getDB();
  const unitId = parseInt(unit_id, 10);
  if (!canAccessUnit(db, req.user, unitId)) return res.status(403).json({ error: 'دسترسی ندارید' });
  const unit = db.prepare("SELECT * FROM op_units WHERE id=? AND status='active'").get(unitId);
  if (!unit) return res.status(404).json({ error: 'واحد یافت نشد' });
  const depts = db.prepare(`
    SELECT * FROM op_departments WHERE unit_id=? AND status='active' ORDER BY sequence_order
  `).all(unitId);
  if (!depts.length) return res.status(400).json({ error: 'واحد باید حداقل یک بخش داشته باشد' });
  const firstDept = depts[0];
  let srcWh;
  if (source_warehouse_id) {
    srcWh = parseInt(source_warehouse_id, 10);
    const link = db.prepare('SELECT 1 FROM op_unit_warehouses WHERE unit_id=? AND warehouse_id=?').get(unitId, srcWh);
    if (!link) return res.status(400).json({ error: 'انبار مبدأ باید به واحد متصل باشد' });
  } else {
    const uw = db.prepare('SELECT warehouse_id FROM op_unit_warehouses WHERE unit_id=? LIMIT 1').get(unitId);
    if (!uw) return res.status(400).json({ error: 'source_warehouse_id الزامی است — واحد انبار متصل ندارد' });
    srcWh = uw.warehouse_id;
  }
  const parsedItems = items.map(it => ({
    product_id: parseInt(it.product_id, 10),
    quantity: parseQty(it.quantity),
    unit_of_measure: it.unit_of_measure || '',
  })).filter(it => it.product_id && it.quantity > 0);
  if (!parsedItems.length) return res.status(400).json({ error: 'اقلام کالا معتبر نیست' });

  let paramId;
  const d = todayJalali();
  try {
    db.transaction(() => {
      for (const it of parsedItems) {
        const prod = db.prepare('SELECT name FROM products WHERE id=?').get(it.product_id);
        if (!prod) throw Object.assign(new Error('کالا یافت نشد'), { status: 404 });
        const avail = warehouseQty(db, it.product_id, srcWh);
        if (avail < it.quantity) {
          const wh = db.prepare('SELECT name FROM warehouses WHERE id=?').get(srcWh);
          throw Object.assign(new Error(
            `موجودی انبار ${wh?.name || ''} کافی نیست (موجود: ${avail}، نیاز: ${it.quantity})`
          ), { status: 400 });
        }
      }
      const num = allocateNumber(db, 'op_parameter', 'P');
      const pr = db.prepare(`
        INSERT INTO op_parameters (num, name, unit_id, current_department_id, status, description, created_by)
        VALUES (?,?,?,?,?,?,?)
      `).run(num, String(name).trim(), unitId, firstDept.id, 'in_progress', description || '', req.user.id);
      paramId = pr.lastInsertRowid;
      const itemIns = db.prepare(`
        INSERT INTO op_parameter_items (parameter_id, product_id, quantity, unit_of_measure)
        VALUES (?,?,?,?)
      `);
      for (const it of parsedItems) itemIns.run(paramId, it.product_id, it.quantity, it.unit_of_measure);
      const logIns = db.prepare(`
        INSERT INTO op_parameter_dept_log (parameter_id, department_id, sequence_order, status)
        VALUES (?,?,?,?)
      `);
      for (const dep of depts) {
        logIns.run(paramId, dep.id, dep.sequence_order, dep.id === firstDept.id ? 'in_progress' : 'pending');
      }
      db.prepare(`
        UPDATE op_parameter_dept_log SET started_at=strftime('%s','now')
        WHERE parameter_id=? AND department_id=?
      `).run(paramId, firstDept.id);
      for (const it of parsedItems) {
        transferBetweenWarehouses(db, {
          productId: it.product_id,
          fromWh: srcWh,
          toWh: firstDept.warehouse_id,
          qty: it.quantity,
          userId: req.user.id,
          note: `پارامتر ${num} — ورود به بخش ${firstDept.name}`,
          date: d,
        });
      }
    })();
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message });
  }
  audit(req.user.id, 'create', 'op_parameter', paramId, `ساخت پارامتر ${name}`);
  portalNotify(db, {
    kind: 'portal_param_new',
    entity_type: 'op_parameter',
    entity_id: paramId,
    title: `پارامتر جدید ${name}`,
    body: `ورود به بخش ${firstDept.name}`,
    target_roles: ['department_manager', 'unit_manager', 'admin'],
  });
  res.json(loadParam(db, paramId));
});

router.get('/parameters', auth, requirePermission('portal', 'view'), (req, res) => {
  const db = getDB();
  const uids = scopeUnitIds(db, req.user);
  const dids = scopeDeptIds(db, req.user);
  let rows;
  if (uids === null) {
    rows = db.prepare('SELECT * FROM op_parameters ORDER BY created_at DESC LIMIT 500').all();
  } else {
    const parts = [];
    const params = [];
    if (uids.length) {
      parts.push(`unit_id IN (${uids.map(() => '?').join(',')})`);
      params.push(...uids);
    }
    if (dids.length) {
      parts.push(`current_department_id IN (${dids.map(() => '?').join(',')})`);
      params.push(...dids);
    }
    if (!parts.length) return res.json([]);
    rows = db.prepare(`
      SELECT * FROM op_parameters WHERE (${parts.join(' OR ')})
      ORDER BY created_at DESC LIMIT 500
    `).all(...params);
  }
  res.json(rows);
});

router.get('/parameters/:id', auth, requirePermission('portal', 'view'), (req, res) => {
  const db = getDB();
  const param = loadParam(db, req.params.id);
  if (!param) return res.status(404).json({ error: 'یافت نشد' });
  if (!canAccessParam(db, req.user, param)) return res.status(403).json({ error: 'دسترسی ندارید' });
  const items = db.prepare(`
    SELECT pi.*, pr.name AS product_name, pr.code AS product_code
    FROM op_parameter_items pi
    JOIN products pr ON pi.product_id=pr.id
    WHERE pi.parameter_id=?
  `).all(param.id);
  const logs = db.prepare(`
    SELECT l.*, d.name AS department_name, d.sequence_order AS dept_sequence
    FROM op_parameter_dept_log l
    JOIN op_departments d ON l.department_id=d.id
    WHERE l.parameter_id=?
    ORDER BY l.sequence_order
  `).all(param.id);
  const depts = db.prepare(`
    SELECT id, name, sequence_order, warehouse_id, status
    FROM op_departments WHERE unit_id=? ORDER BY sequence_order
  `).all(param.unit_id);
  res.json({ ...param, items, dept_logs: logs, departments_timeline: depts });
});

function deptAction(paramId, deptId, req, res, handler) {
  const db = getDB();
  const param = loadParam(db, paramId);
  if (!param) return res.status(404).json({ error: 'پارامتر یافت نشد' });
  if (param.status === 'completed') return res.status(409).json({ error: 'پارامتر تکمیل شده — فقط خواندنی' });
  if (!canAccessParam(db, req.user, param)) return res.status(403).json({ error: 'دسترسی ندارید' });
  try {
    const ctx = assertDeptUnlocked(db, param, parseInt(deptId, 10));
    const result = db.transaction(() => handler(db, param, ctx))();
    return res.json(result || { ok: true });
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message });
  }
}

router.post('/parameters/:id/dept/:deptId/confirm', auth, requirePermission('portal', 'edit'), (req, res) => {
  const { received_quantity, correction_quantity } = req.body;
  const rq = parseQty(received_quantity);
  if (rq == null || rq < 0) return res.status(400).json({ error: 'مقدار دریافتی معتبر الزامی است' });
  deptAction(req.params.id, req.params.deptId, req, res, (db, param, { log }) => {
    const corr = correction_quantity != null ? parseQty(correction_quantity) : null;
    db.prepare(`
      UPDATE op_parameter_dept_log SET
        received_quantity=?, correction_quantity=?, confirmed=1,
        status=CASE WHEN status='pending' THEN 'in_progress' ELSE status END
      WHERE id=?
    `).run(rq, corr, log.id);
    if (corr && corr !== 0) {
      portalNotify(db, {
        kind: 'portal_correction',
        entity_type: 'op_parameter',
        entity_id: param.id,
        title: 'درخواست اصلاح مقدار',
        body: param.name,
        target_roles: ['unit_manager', 'admin'],
      });
    }
    audit(req.user.id, 'confirm', 'op_parameter_dept', log.id, `تأیید مقدار ${rq}`);
    return { ok: true, received_quantity: rq, correction_quantity: corr };
  });
});

router.post('/parameters/:id/dept/:deptId/request-review', auth, requirePermission('portal', 'create'), (req, res) => {
  deptAction(req.params.id, req.params.deptId, req, res, (db, param, { log }) => {
    db.prepare(`
      UPDATE op_parameter_dept_log SET status='under_review' WHERE id=?
    `).run(log.id);
    db.prepare(`
      UPDATE op_parameters SET status='under_review', updated_at=strftime('%s','now') WHERE id=?
    `).run(param.id);
    portalNotify(db, {
      kind: 'portal_review',
      entity_type: 'op_parameter',
      entity_id: param.id,
      title: 'درخواست بازبینی',
      body: param.name,
      target_roles: ['unit_manager', 'admin'],
    });
    audit(req.user.id, 'review_request', 'op_parameter', param.id, 'درخواست بازبینی');
    return { ok: true, status: 'under_review' };
  });
});

router.post('/parameters/:id/dept/:deptId/payment', auth, requirePermission('portal', 'edit'), (req, res) => {
  const { person_id, amount_rial } = req.body;
  const personId = parseInt(person_id, 10);
  const amt = Math.round(Number(amount_rial) || 0);
  if (!personId || !amt) return res.status(400).json({ error: 'شخص و مبلغ (ریال) الزامی است' });
  deptAction(req.params.id, req.params.deptId, req, res, (db, param, { log, dept }) => {
    const person = db.prepare('SELECT * FROM persons WHERE id=?').get(personId);
    if (!person) throw Object.assign(new Error('شخص یافت نشد'), { status: 404 });
    const expense = acct(db, 'coa_admin_expense');
    const personsAcct = acct(db, 'coa_misc_persons');
    const detailId = personDetailId(db, personId);
    const d = todayJalali();
    const toman = rialToLedger(amt);
    const jeId = postToLedger(db, {
      sourceType: 'portal_payment',
      sourceId: log.id,
      date: d,
      description: `پرداخت پرتال — ${param.name} — ${person.name}`,
      createdBy: req.user.id,
      lines: [
        { code: expense.code, name: expense.name, debit: toman, credit: 0 },
        {
          code: personsAcct.code,
          name: personsAcct.name,
          debit: 0,
          credit: toman,
          detail_account_id: detailId,
        },
      ],
    });
    db.prepare(`
      UPDATE op_parameter_dept_log SET
        payment_person_id=?, payment_amount=?, payment_status='completed', payment_journal_id=?
      WHERE id=?
    `).run(personId, amt, jeId, log.id);
    audit(req.user.id, 'payment', 'op_parameter_dept', log.id, `پرداخت ${amt} ریال به ${person.name}`);
    return { ok: true, payment_journal_id: jeId, amount_rial: amt };
  });
});

router.post('/parameters/:id/dept/:deptId/convert', auth, requirePermission('portal', 'edit'), (req, res) => {
  const { product_id, quantity, from_product_id } = req.body;
  const outPid = parseInt(product_id, 10);
  const qty = parseQty(quantity);
  if (!outPid || !qty || qty <= 0) return res.status(400).json({ error: 'کالای خروجی و تعداد معتبر الزامی است' });
  deptAction(req.params.id, req.params.deptId, req, res, (db, param, { log, dept }) => {
    const outProd = db.prepare('SELECT * FROM products WHERE id=?').get(outPid);
    if (!outProd) throw Object.assign(new Error('کالای خروجی یافت نشد'), { status: 404 });
    let inPid = from_product_id ? parseInt(from_product_id, 10) : null;
    if (!inPid) {
      const firstItem = db.prepare(`
        SELECT product_id FROM op_parameter_items WHERE parameter_id=? LIMIT 1
      `).get(param.id);
      inPid = firstItem?.product_id;
    }
    if (!inPid) throw Object.assign(new Error('کالای ورودی مشخص نیست'), { status: 400 });
    const inProd = db.prepare('SELECT * FROM products WHERE id=?').get(inPid);
    if (!inProd) throw Object.assign(new Error('کالای ورودی یافت نشد'), { status: 404 });
    const whId = dept.warehouse_id;
    const avail = warehouseQty(db, inPid, whId);
    if (avail < qty) {
      const wh = db.prepare('SELECT name FROM warehouses WHERE id=?').get(whId);
      throw Object.assign(new Error(
        `موجودی انبار ${wh?.name || ''} کافی نیست (موجود: ${avail}، نیاز: ${qty})`
      ), { status: 400 });
    }
    const d = todayJalali();
    const unit = Math.round(Number(inProd.average_cost_rial) || 0);
    const ledIssue = postInventoryMovement(db, {
      eventType: 'production_issue',
      productId: inPid,
      warehouseId: whId,
      qty: -qty,
      sourceType: 'portal_convert',
      sourceId: log.id,
      date: d,
      note: `تبدیل پرتال — خروج ${inProd.name}`,
      createdBy: req.user.id,
    });
    const ledReceipt = postInventoryMovement(db, {
      eventType: 'production_receipt',
      productId: outPid,
      warehouseId: whId,
      qty,
      unitCostRial: qty > 0 ? Math.round(ledIssue.amount_rial / qty) : unit,
      amountRial: ledIssue.amount_rial,
      sourceType: 'portal_convert',
      sourceId: log.id,
      date: d,
      note: `تبدیل پرتال — ورود ${outProd.name}`,
      createdBy: req.user.id,
    });
    let runId = null;
    if (hasTable(db, 'production_runs')) {
      const rr = db.prepare(`
        INSERT INTO production_runs (product_id, qty_produced, material_cost, date, note, stock_added, warehouse_id, created_by)
        VALUES (?,?,?,?,?,1,?,?)
      `).run(outPid, Math.round(qty), ledIssue.amount_rial / 10, d,
        `تبدیل پرتال ${param.num || param.id}`, whId, req.user.id);
      runId = rr.lastInsertRowid;
    }
    db.prepare(`
      UPDATE op_parameter_dept_log SET
        converted_product_id=?, conversion_quantity=?, output_quantity=?, production_run_id=?
      WHERE id=?
    `).run(outPid, qty, qty, runId, log.id);
    audit(req.user.id, 'convert', 'op_parameter_dept', log.id, `تبدیل ${qty} ${inProd.name} → ${outProd.name}`);
    return { ok: true, production_run_id: runId, issue_ledger_id: ledIssue.id, receipt_ledger_id: ledReceipt.id };
  });
});

router.post('/parameters/:id/dept/:deptId/complete', auth, requirePermission('portal', 'edit'), (req, res) => {
  deptAction(req.params.id, req.params.deptId, req, res, (db, param, { log, dept }) => {
    const ts = nowEpoch(db);
    const d = todayJalali();
    const items = db.prepare('SELECT * FROM op_parameter_items WHERE parameter_id=?').all(param.id);
    const transferQty = (it) => {
      if (log.output_quantity > 0 && log.converted_product_id) {
        return log.converted_product_id === it.product_id ? parseQty(log.output_quantity) : 0;
      }
      return parseQty(it.quantity);
    };
    const next = nextDept(db, param.unit_id, dept.sequence_order);
    if (next) {
      for (const it of items) {
        const q = transferQty(it);
        if (q > 0) {
          transferBetweenWarehouses(db, {
            productId: it.product_id,
            fromWh: dept.warehouse_id,
            toWh: next.warehouse_id,
            qty: q,
            userId: req.user.id,
            note: `پارامتر ${param.num || param.id} — انتقال به ${next.name}`,
            date: d,
          });
        }
      }
      if (log.converted_product_id && log.output_quantity > 0) {
        const convPid = log.converted_product_id;
        const alreadyItem = items.some(i => i.product_id === convPid);
        if (!alreadyItem) {
          transferBetweenWarehouses(db, {
            productId: convPid,
            fromWh: dept.warehouse_id,
            toWh: next.warehouse_id,
            qty: parseQty(log.output_quantity),
            userId: req.user.id,
            note: `پارامتر ${param.num || param.id} — انتقال محصول تبدیل‌شده`,
            date: d,
          });
        }
      }
      db.prepare(`
        UPDATE op_parameter_dept_log SET status='completed', completed_at=?, completed_by=? WHERE id=?
      `).run(ts, req.user.id, log.id);
      db.prepare(`
        UPDATE op_parameter_dept_log SET status='in_progress', started_at=strftime('%s','now')
        WHERE parameter_id=? AND department_id=?
      `).run(param.id, next.id);
      db.prepare(`
        UPDATE op_parameters SET current_department_id=?, status='in_progress', updated_at=? WHERE id=?
      `).run(next.id, ts, param.id);
      portalNotify(db, {
        kind: 'portal_dept_advance',
        entity_type: 'op_parameter',
        entity_id: param.id,
        title: `ورود پارامتر به ${next.name}`,
        body: param.name,
        target_roles: ['department_manager', 'unit_manager'],
      });
      audit(req.user.id, 'complete_dept', 'op_parameter_dept', log.id, `اتمام بخش ${dept.name}`);
      return { ok: true, next_department_id: next.id, status: 'in_progress' };
    }
    db.prepare(`
      UPDATE op_parameter_dept_log SET status='completed', completed_at=?, completed_by=? WHERE id=?
    `).run(ts, req.user.id, log.id);
    db.prepare(`
      UPDATE op_parameters SET status='dept_completed', updated_at=? WHERE id=?
    `).run(ts, param.id);
    portalNotify(db, {
      kind: 'portal_awaiting_final',
      entity_type: 'op_parameter',
      entity_id: param.id,
      title: 'آماده ثبت خروجی نهایی',
      body: param.name,
      target_roles: ['unit_manager', 'admin'],
    });
    audit(req.user.id, 'complete_dept', 'op_parameter_dept', log.id, `اتمام آخرین بخش ${dept.name}`);
    return { ok: true, status: 'dept_completed', awaiting_final: true };
  });
});

router.post('/parameters/:id/final-output', auth, requirePermission('portal', 'approve'), (req, res) => {
  const { quantity, destination_warehouse_id } = req.body;
  const qty = parseQty(quantity);
  const destWh = parseInt(destination_warehouse_id, 10);
  if (!qty || qty <= 0 || !destWh) {
    return res.status(400).json({ error: 'تعداد و انبار مقصد الزامی است' });
  }
  const db = getDB();
  const param = loadParam(db, req.params.id);
  if (!param) return res.status(404).json({ error: 'یافت نشد' });
  if (!canAccessUnit(db, req.user, param.unit_id) && !['admin', 'accounting'].includes(req.user.role)) {
    return res.status(403).json({ error: 'دسترسی ندارید' });
  }
  if (!['dept_completed', 'in_progress'].includes(param.status)) {
    return res.status(409).json({ error: 'پارامتر آماده ثبت خروجی نهایی نیست' });
  }
  const dest = db.prepare('SELECT * FROM warehouses WHERE id=?').get(destWh);
  if (!dest) return res.status(404).json({ error: 'انبار مقصد یافت نشد' });
  const lastDept = db.prepare(`
    SELECT d.* FROM op_departments d
    WHERE d.unit_id=? AND d.status='active'
    ORDER BY d.sequence_order DESC LIMIT 1
  `).get(param.unit_id);
  if (!lastDept) return res.status(400).json({ error: 'بخش یافت نشد' });
  const lastLog = db.prepare(`
    SELECT * FROM op_parameter_dept_log WHERE parameter_id=? AND department_id=?
  `).get(param.id, lastDept.id);
  const srcPid = lastLog?.converted_product_id
    || db.prepare('SELECT product_id FROM op_parameter_items WHERE parameter_id=? LIMIT 1').get(param.id)?.product_id;
  if (!srcPid) return res.status(400).json({ error: 'کالای خروجی مشخص نیست' });
  const product = db.prepare('SELECT * FROM products WHERE id=?').get(srcPid);
  if (!product) return res.status(404).json({ error: 'کالا یافت نشد' });
  const avail = warehouseQty(db, srcPid, lastDept.warehouse_id);
  if (avail < qty) {
    return res.status(400).json({
      error: `موجودی انبار ${lastDept.name} کافی نیست (موجود: ${avail}، نیاز: ${qty})`,
    });
  }
  const d = todayJalali();
  const ts = nowEpoch(db);
  try {
    db.transaction(() => {
      transferBetweenWarehouses(db, {
        productId: srcPid,
        fromWh: lastDept.warehouse_id,
        toWh: destWh,
        qty,
        userId: req.user.id,
        note: `خروجی نهایی پارامتر ${param.num || param.id}`,
        date: d,
      });
      db.prepare(`
        UPDATE op_parameters SET
          final_quantity=?, destination_warehouse_id=?, status='completed',
          completed_at=?, updated_at=?
        WHERE id=?
      `).run(qty, destWh, ts, ts, param.id);
    })();
  } catch (e) {
    return res.status(e.status || 400).json({ error: stockErrPersian(e, dest.name) });
  }
  audit(req.user.id, 'final_output', 'op_parameter', param.id, `خروجی نهایی ${qty} به ${dest.name}`);
  portalNotify(db, {
    kind: 'portal_completed',
    entity_type: 'op_parameter',
    entity_id: param.id,
    title: 'ثبت خروجی نهایی',
    body: `${param.name} — ${qty} عدد`,
    target_roles: ['unit_manager', 'admin', 'accounting'],
  });
  res.json({ ok: true, status: 'completed', final_quantity: qty, destination_warehouse_id: destWh });
});

module.exports = router;
