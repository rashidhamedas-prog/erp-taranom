const router = require('express').Router();
const { getDB, audit } = require('../db');
const { auth, adminOrAccounting } = require('../middleware/auth');
const { todayJalali } = require('../jalali');
const { postInventoryMovement, warehouseQty, invErr } = require('../lib/inventory/ledger');
const { postToLedger } = require('../lib/ledger');
const { acct } = require('../lib/coa-map');
const { parseQty } = require('../lib/round3');
const { voidWarehouseMove } = require('../lib/void-warehouse-move');


// Stock overview — all warehouses with product quantities
router.get('/stock/overview', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const warehouses = db.prepare('SELECT * FROM warehouses WHERE active=1 ORDER BY name').all();
  const stockRows = db.prepare(`
    SELECT p.id, p.code, p.name, p.unit, p.warehouse_id, p.stock,
      ws.warehouse_id as ws_wh, ws.qty as ws_qty
    FROM products p
    LEFT JOIN warehouse_stock ws ON ws.product_id=p.id
    ORDER BY p.name
  `).all();
  const result = warehouses.map(w => {
    const products = [];
    const seen = new Set();
    for (const p of stockRows) {
      if (p.warehouse_id === w.id && !seen.has(p.id)) {
        products.push({ id: p.id, code: p.code, name: p.name, unit: p.unit, qty: p.stock || 0 });
        seen.add(p.id);
      }
      if (p.ws_wh === w.id) {
        const qty = p.ws_qty != null ? p.ws_qty : (p.warehouse_id === w.id ? p.stock : 0);
        if (!seen.has(p.id)) {
          products.push({ id: p.id, code: p.code, name: p.name, unit: p.unit, qty: qty || 0 });
          seen.add(p.id);
        }
      }
    }
    const totalQty = products.reduce((a, p) => a + (p.qty || 0), 0);
    return { ...w, product_count: products.length, total_qty: totalQty, products };
  });
  res.json(result);
});

// Read-only list is open to all authenticated users — the products/catalog
// page needs it for its warehouse filter (spec 1.0.9 §2: sales users were
// getting "access denied" on the catalog). Mutations below stay restricted.
router.get('/', auth, (req, res) => {
  const db = getDB();
  res.json(db.prepare('SELECT * FROM warehouses ORDER BY name').all());
});

router.post('/', auth, adminOrAccounting, (req, res) => {
  const { name, address, code, entity, warehouse_type, cost_center_id, is_default, allow_negative, costing_method } = req.body;
  if (!name) return res.status(400).json({ error: 'نام انبار الزامی است' });
  const db = getDB();
  const whCode = code || ('WH-' + Date.now().toString(36).toUpperCase());
  const result = db.prepare(`
    INSERT INTO warehouses (name,address,code,entity,warehouse_type,cost_center_id,is_default,allow_negative,costing_method)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(
    name, address || '', whCode,
    entity || 'distribution_office',
    warehouse_type || 'finished_goods',
    cost_center_id ? parseInt(cost_center_id, 10) : null,
    is_default ? 1 : 0,
    allow_negative ? 1 : 0,
    costing_method || null
  );
  audit(req.user.id, 'create', 'warehouse', result.lastInsertRowid, `ساخت انبار ${name}`);
  res.json(db.prepare('SELECT * FROM warehouses WHERE id=?').get(result.lastInsertRowid));
});

router.put('/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM warehouses WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  const { name, address, active, entity, warehouse_type, cost_center_id, is_default, code, allow_negative, costing_method } = req.body;
  db.prepare(`
    UPDATE warehouses SET name=?,address=?,active=?,entity=?,warehouse_type=?,cost_center_id=?,is_default=?,code=?,allow_negative=?,costing_method=?
    WHERE id=?
  `).run(
    name || row.name, address ?? row.address,
    active != null ? (active ? 1 : 0) : row.active,
    entity || row.entity || 'distribution_office',
    warehouse_type || row.warehouse_type || 'finished_goods',
    cost_center_id != null ? (cost_center_id ? parseInt(cost_center_id, 10) : null) : row.cost_center_id,
    is_default != null ? (is_default ? 1 : 0) : (row.is_default || 0),
    code || row.code || null,
    allow_negative != null ? (allow_negative ? 1 : 0) : (row.allow_negative || 0),
    costing_method !== undefined ? (costing_method || null) : (row.costing_method || null),
    req.params.id
  );
  audit(req.user.id, 'update', 'warehouse', req.params.id, `ویرایش انبار ${name || row.name}`);
  res.json({ ok: true });
});

router.delete('/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM warehouses WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  const inUse = db.prepare('SELECT COUNT(*) c FROM products WHERE warehouse_id=?').get(req.params.id).c;
  if (inUse > 0) return res.status(400).json({ error: 'این انبار دارای کالا است و قابل حذف نیست — می‌توانید آن را غیرفعال کنید' });
  db.prepare('DELETE FROM warehouses WHERE id=?').run(req.params.id);
  audit(req.user.id, 'delete', 'warehouse', req.params.id, `حذف انبار ${row.name}`);
  res.json({ ok: true });
});

// Products currently assigned to a warehouse (= "warehouse stock report")
router.get('/:id/stock', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const rows = db.prepare('SELECT id,code,name,stock,unit,stock_alert FROM products WHERE warehouse_id=? ORDER BY name').all(req.params.id);
  res.json(rows);
});

// ---- Warehouse movement history ----
router.get('/moves/list', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const rows = db.prepare(`
    SELECT m.*, p.name as product_name, p.code as product_code,
      fw.name as from_warehouse_name, tw.name as to_warehouse_name, u.name as recorder
    FROM warehouse_moves m
    LEFT JOIN products p ON m.product_id=p.id
    LEFT JOIN warehouses fw ON m.from_warehouse_id=fw.id
    LEFT JOIN warehouses tw ON m.to_warehouse_id=tw.id
    LEFT JOIN users u ON m.created_by=u.id
    WHERE COALESCE(m.status,'posted')<>'reversed'
    ORDER BY m.created_at DESC LIMIT 300
  `).all();
  res.json(rows);
});

// Void warehouse move (R13 full reverse of stock + related batch JE)
router.post('/moves/:id/void', auth, adminOrAccounting, (req, res) => {
  try {
    const db = getDB();
    const result = voidWarehouseMove(db, req.params.id, req.user);
    res.json(result);
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
});

router.post('/moves/receipt', auth, adminOrAccounting, (req, res) => {
  const { product_id, warehouse_id, qty, date, note, unit_cost_rial, batch_id } = req.body;
  const q = parseQty(qty);
  if (!product_id || !warehouse_id || !q || q <= 0) return res.status(400).json({ error: 'کالا، انبار و تعداد معتبر الزامی است' });
  const db = getDB();
  const product = db.prepare('SELECT * FROM products WHERE id=?').get(product_id);
  if (!product) return res.status(404).json({ error: 'کالا یافت نشد' });
  const warehouse = db.prepare('SELECT * FROM warehouses WHERE id=?').get(warehouse_id);
  if (!warehouse) return res.status(404).json({ error: 'انبار یافت نشد' });
  let moveId, led;
  try {
    db.transaction(() => {
      led = postInventoryMovement(db, {
        eventType: 'receipt',
        productId: +product_id,
        warehouseId: +warehouse_id,
        qty: q,
        unitCostRial: unit_cost_rial != null ? +unit_cost_rial : Math.round(Number(product.average_cost_rial) || 0),
        batchId: batch_id ? +batch_id : null,
        sourceType: 'warehouse_move',
        date: date || todayJalali(),
        note: `رسید انبار (${warehouse.name})${note ? ' - ' + note : ''}`,
        createdBy: req.user.id,
      });
      const result = db.prepare(`
        INSERT INTO warehouse_moves
          (type,product_id,to_warehouse_id,qty,date,note,created_by,ledger_id,unit_cost_rial,amount_rial,batch_id,status)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,'posted')
      `).run('receipt', product_id, warehouse_id, q, date || todayJalali(), note || '', req.user.id,
        led.id, led.unit_cost_rial, led.amount_rial, batch_id || null);
      moveId = result.lastInsertRowid;
      db.prepare('UPDATE inventory_ledger SET source_id=? WHERE id=?').run(moveId, led.id);
    })();
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
  audit(req.user.id, 'create', 'warehouse_move', moveId, `رسید انبار: ${q} عدد ${product.name} به ${warehouse.name}`);
  res.json({ id: moveId, ledger_id: led.id, ok: true });
});

router.post('/moves/issue', auth, adminOrAccounting, (req, res) => {
  const { product_id, warehouse_id, qty, date, note, batch_id } = req.body;
  const q = parseQty(qty);
  if (!product_id || !warehouse_id || !q || q <= 0) return res.status(400).json({ error: 'کالا، انبار و تعداد معتبر الزامی است' });
  const db = getDB();
  const product = db.prepare('SELECT * FROM products WHERE id=?').get(product_id);
  if (!product) return res.status(404).json({ error: 'کالا یافت نشد' });
  const available = warehouseQty(db, product_id, warehouse_id);
  if (available < q) return res.status(400).json({ error: `موجودی کافی نیست (موجود: ${available})` });
  const warehouse = db.prepare('SELECT * FROM warehouses WHERE id=?').get(warehouse_id);
  let moveId, led;
  try {
    db.transaction(() => {
      led = postInventoryMovement(db, {
        eventType: 'issue',
        productId: +product_id,
        warehouseId: +warehouse_id,
        qty: -q,
        batchId: batch_id ? +batch_id : null,
        sourceType: 'warehouse_move',
        date: date || todayJalali(),
        note: `حواله انبار (${warehouse?.name || warehouse_id})${note ? ' - ' + note : ''}`,
        createdBy: req.user.id,
      });
      const result = db.prepare(`
        INSERT INTO warehouse_moves
          (type,product_id,from_warehouse_id,qty,date,note,created_by,ledger_id,unit_cost_rial,amount_rial,batch_id,status)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,'posted')
      `).run('issue', product_id, warehouse_id, q, date || todayJalali(), note || '', req.user.id,
        led.id, led.unit_cost_rial, led.amount_rial, batch_id || null);
      moveId = result.lastInsertRowid;
      db.prepare('UPDATE inventory_ledger SET source_id=? WHERE id=?').run(moveId, led.id);
    })();
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
  audit(req.user.id, 'create', 'warehouse_move', moveId, `حواله انبار: ${q} عدد ${product.name} از ${warehouse?.name}`);
  res.json({ id: moveId, ledger_id: led.id, ok: true });
});

router.post('/moves/transfer', auth, adminOrAccounting, (req, res) => {
  const { product_id, from_warehouse_id, to_warehouse_id, qty, date, note } = req.body;
  const q = parseQty(qty);
  if (!product_id || !from_warehouse_id || !to_warehouse_id) return res.status(400).json({ error: 'کالا، انبار مبدأ و مقصد الزامی است' });
  if (!q || q <= 0) return res.status(400).json({ error: 'تعداد انتقال معتبر الزامی است' });
  if (String(from_warehouse_id) === String(to_warehouse_id)) return res.status(400).json({ error: 'انبار مبدأ و مقصد نمی‌تواند یکسان باشد' });
  const db = getDB();
  const product = db.prepare('SELECT * FROM products WHERE id=?').get(product_id);
  if (!product) return res.status(404).json({ error: 'کالا یافت نشد' });
  const available = warehouseQty(db, product_id, from_warehouse_id);
  if (available <= 0) return res.status(400).json({ error: 'این کالا در انبار مبدأ موجود نیست' });
  if (q > available) return res.status(400).json({ error: `موجودی کافی نیست (موجود: ${available})` });
  const toWarehouse = db.prepare('SELECT * FROM warehouses WHERE id=?').get(to_warehouse_id);
  if (!toWarehouse) return res.status(404).json({ error: 'انبار مقصد یافت نشد' });
  const fromWarehouse = db.prepare('SELECT * FROM warehouses WHERE id=?').get(from_warehouse_id);
  let moveId, ledOut, ledIn;
  try {
    db.transaction(() => {
      const unit = Math.round(Number(product.average_cost_rial) || 0);
      ledOut = postInventoryMovement(db, {
        eventType: 'transfer_out',
        productId: +product_id,
        warehouseId: +from_warehouse_id,
        qty: -q,
        unitCostRial: unit,
        sourceType: 'warehouse_transfer',
        date: date || todayJalali(),
        note: `خروج انتقال به ${toWarehouse.name}${note ? ' - ' + note : ''}`,
        createdBy: req.user.id,
        updateAvg: false,
      });
      ledIn = postInventoryMovement(db, {
        eventType: 'transfer_in',
        productId: +product_id,
        warehouseId: +to_warehouse_id,
        qty: q,
        unitCostRial: unit,
        amountRial: ledOut.amount_rial,
        sourceType: 'warehouse_transfer',
        date: date || todayJalali(),
        note: `ورود انتقال از ${fromWarehouse?.name || from_warehouse_id}${note ? ' - ' + note : ''}`,
        createdBy: req.user.id,
        updateAvg: false,
      });
      // Transfer must not double-count products.stock: out then in → net 0 on total
      // postInventoryMovement adjusts products.stock both times; net zero — OK.
      const result = db.prepare(`
        INSERT INTO warehouse_moves
          (type,product_id,from_warehouse_id,to_warehouse_id,qty,date,note,created_by,ledger_id,unit_cost_rial,amount_rial,status)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,'posted')
      `).run('transfer', product_id, from_warehouse_id, to_warehouse_id, q, date || todayJalali(), note || '',
        req.user.id, ledOut.id, unit, ledOut.amount_rial);
      moveId = result.lastInsertRowid;
      db.prepare('UPDATE inventory_ledger SET source_id=? WHERE id IN (?,?)').run(moveId, ledOut.id, ledIn.id);
    })();
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
  audit(req.user.id, 'create', 'warehouse_move', moveId, `انتقال کالا: ${q} عدد ${product.name} به ${toWarehouse.name}`);
  res.json({ id: moveId, ledger_out: ledOut.id, ledger_in: ledIn.id, ok: true });
});

const DEFAULT_WAREHOUSE_ENTITIES = [
  { value: 'workshop', label: 'کارگاه (نوبرت)' },
  { value: 'distribution_office', label: 'دفتر توزیع (کیمیا)' },
];
const DEFAULT_WAREHOUSE_TYPES = [
  { value: 'raw_material', label: 'مواد اولیه' },
  { value: 'finished_goods', label: 'محصول نهایی' },
  { value: 'consignment', label: 'امانی' },
  { value: 'scrap', label: 'ضایعات' },
];

function readLookupOptions(db, key, defaults) {
  const row = db.prepare("SELECT value FROM settings WHERE key=?").get(key);
  if (!row?.value) return defaults;
  try {
    const parsed = JSON.parse(row.value);
    return Array.isArray(parsed) && parsed.length ? parsed : defaults;
  } catch (_) { return defaults; }
}

router.get('/lookup-options', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  res.json({
    entities: readLookupOptions(db, 'warehouse_entities', DEFAULT_WAREHOUSE_ENTITIES),
    types: readLookupOptions(db, 'warehouse_types', DEFAULT_WAREHOUSE_TYPES),
  });
});

router.post('/lookup-options', auth, adminOrAccounting, (req, res) => {
  const { kind, value, label } = req.body;
  if (!kind || !value || !label) return res.status(400).json({ error: 'نوع، مقدار و برچسب الزامی است' });
  const key = kind === 'type' ? 'warehouse_types' : 'warehouse_entities';
  const defaults = kind === 'type' ? DEFAULT_WAREHOUSE_TYPES : DEFAULT_WAREHOUSE_ENTITIES;
  const db = getDB();
  const list = readLookupOptions(db, key, defaults);
  if (!list.some(x => x.value === value)) list.push({ value: String(value), label: String(label) });
  db.prepare("INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(key, JSON.stringify(list));
  res.json({ ok: true, list });
});

/** Multi-line warehouse document — lines: [{product_id, qty}] */
router.post('/moves/batch', auth, adminOrAccounting, (req, res) => {
  const { type, warehouse_id, from_warehouse_id, to_warehouse_id, lines, date, note } = req.body;
  if (!['receipt', 'issue', 'transfer'].includes(type)) return res.status(400).json({ error: 'نوع سند نامعتبر است' });
  if (!Array.isArray(lines) || !lines.length) return res.status(400).json({ error: 'حداقل یک ردیف کالا لازم است' });
  const db = getDB();
  const ids = [];
  try {
    db.transaction(() => {
      let totalAmountRial = 0;
      for (const line of lines) {
        const product_id = parseInt(line.product_id, 10);
        const qty = parseQty(line.qty);
        if (!product_id || !qty || qty <= 0) throw invErr('E_INV_QTY', 400);
        const product = db.prepare('SELECT * FROM products WHERE id=?').get(product_id);
        if (!product) throw invErr('E_PRODUCT_NOT_FOUND', 404);
        const d = date || todayJalali();
        if (type === 'receipt') {
          const whId = parseInt(warehouse_id || to_warehouse_id, 10);
          if (!whId) throw new Error('انبار مقصد الزامی است');
          const warehouse = db.prepare('SELECT * FROM warehouses WHERE id=?').get(whId);
          if (!warehouse) throw new Error('انبار یافت نشد');
          const explicitUnitCost = Math.round(Number(line.unit_cost_rial) || (
            Number(line.amount_rial) > 0 ? Number(line.amount_rial) / qty : 0
          ));
          const led = postInventoryMovement(db, {
            eventType: 'receipt', productId: product_id, warehouseId: whId, qty,
            unitCostRial: explicitUnitCost > 0 ? explicitUnitCost : Math.round(Number(product.average_cost_rial) || 0),
            sourceType: 'warehouse_move', date: d,
            note: `رسید انبار (${warehouse.name})${note ? ' - ' + note : ''}`,
            createdBy: req.user.id,
          });
          const r = db.prepare(`
            INSERT INTO warehouse_moves
              (type,product_id,to_warehouse_id,qty,date,note,created_by,ledger_id,unit_cost_rial,amount_rial,status)
            VALUES (?,?,?,?,?,?,?,?,?,?,'posted')
          `).run('receipt', product_id, whId, qty, d, note || '', req.user.id, led.id, led.unit_cost_rial, led.amount_rial);
          db.prepare('UPDATE inventory_ledger SET source_id=? WHERE id=?').run(r.lastInsertRowid, led.id);
          ids.push(r.lastInsertRowid);
          totalAmountRial += Math.round(Number(led.amount_rial) || 0);
        } else if (type === 'issue') {
          const whId = parseInt(warehouse_id || from_warehouse_id, 10);
          if (!whId) throw new Error('انبار مبدأ الزامی است');
          const available = warehouseQty(db, product_id, whId);
          if (available < qty) throw new Error(`موجودی ${product.name} کافی نیست (موجود: ${available})`);
          const warehouse = db.prepare('SELECT * FROM warehouses WHERE id=?').get(whId);
          const led = postInventoryMovement(db, {
            eventType: 'issue', productId: product_id, warehouseId: whId, qty: -qty,
            sourceType: 'warehouse_move', date: d,
            note: `حواله انبار (${warehouse?.name || whId})${note ? ' - ' + note : ''}`,
            createdBy: req.user.id,
          });
          const r = db.prepare(`
            INSERT INTO warehouse_moves
              (type,product_id,from_warehouse_id,qty,date,note,created_by,ledger_id,unit_cost_rial,amount_rial,status)
            VALUES (?,?,?,?,?,?,?,?,?,?,'posted')
          `).run('issue', product_id, whId, qty, d, note || '', req.user.id, led.id, led.unit_cost_rial, led.amount_rial);
          db.prepare('UPDATE inventory_ledger SET source_id=? WHERE id=?').run(r.lastInsertRowid, led.id);
          ids.push(r.lastInsertRowid);
          totalAmountRial += Math.round(Number(led.amount_rial) || 0);
        } else {
          const fromId = parseInt(from_warehouse_id, 10);
          const toId = parseInt(to_warehouse_id, 10);
          if (!fromId || !toId) throw new Error('انبار مبدأ و مقصد الزامی است');
          if (fromId === toId) throw new Error('انبار مبدأ و مقصد نمی‌تواند یکسان باشد');
          const available = warehouseQty(db, product_id, fromId);
          if (available < qty) throw new Error(`موجودی ${product.name} کافی نیست (موجود: ${available})`);
          const toWarehouse = db.prepare('SELECT * FROM warehouses WHERE id=?').get(toId);
          const fromWarehouse = db.prepare('SELECT * FROM warehouses WHERE id=?').get(fromId);
          const unit = Math.round(Number(product.average_cost_rial) || 0);
          const ledOut = postInventoryMovement(db, {
            eventType: 'transfer_out', productId: product_id, warehouseId: fromId, qty: -qty,
            unitCostRial: unit, sourceType: 'warehouse_transfer', date: d,
            note: `خروج انتقال به ${toWarehouse?.name}`, createdBy: req.user.id, updateAvg: false,
          });
          const ledIn = postInventoryMovement(db, {
            eventType: 'transfer_in', productId: product_id, warehouseId: toId, qty,
            unitCostRial: unit, amountRial: ledOut.amount_rial, sourceType: 'warehouse_transfer', date: d,
            note: `ورود انتقال از ${fromWarehouse?.name}`, createdBy: req.user.id, updateAvg: false,
          });
          const r = db.prepare(`
            INSERT INTO warehouse_moves
              (type,product_id,from_warehouse_id,to_warehouse_id,qty,date,note,created_by,ledger_id,unit_cost_rial,amount_rial,status)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,'posted')
          `).run('transfer', product_id, fromId, toId, qty, d, note || '', req.user.id, ledOut.id, unit, ledOut.amount_rial);
          db.prepare('UPDATE inventory_ledger SET source_id=? WHERE id IN (?,?)').run(r.lastInsertRowid, ledOut.id, ledIn.id);
          ids.push(r.lastInsertRowid);
        }
      }
      if (type !== 'transfer' && totalAmountRial > 0) {
        const inventory = acct(db, 'coa_inventory');
        const isOpening = !!(req.body.opening || /اول\s*دوره|افتتاحیه|موجودی\s*اول/i.test(String(note || '')));
        const counterpart = acct(db, type === 'receipt'
          ? (isOpening ? 'coa_opening_balance' : 'coa_adjustment')
          : 'coa_inventory_loss');
        const amountToman = totalAmountRial / 10;
        const jeId = postToLedger(db, {
          sourceType: isOpening && type === 'receipt' ? 'opening_inventory' : `warehouse_${type}_batch`,
          sourceId: ids[0],
          date: date || todayJalali(),
          description: isOpening && type === 'receipt'
            ? `موجودی اول دوره — رسید انبار (${ids.length} ردیف)`
            : `${type === 'receipt' ? 'رسید' : 'حواله'} انبار (${ids.length} ردیف)`,
          createdBy: req.user.id,
          voucherType: isOpening && type === 'receipt' ? 'opening' : 'auto',
          srcSystem: req.body.from_excel || req.body.src_system === 'excel' ? 'excel' : null,
          lines: type === 'receipt'
            ? [
              { code: inventory.code, name: inventory.name, debit: amountToman, credit: 0 },
              { code: counterpart.code, name: counterpart.name, debit: 0, credit: amountToman },
            ]
            : [
              { code: counterpart.code, name: counterpart.name, debit: amountToman, credit: 0 },
              { code: inventory.code, name: inventory.name, debit: 0, credit: amountToman },
            ],
        });
        if (jeId && ids.length) {
          const placeholders = ids.map(() => '?').join(',');
          db.prepare(`UPDATE warehouse_moves SET je_id=? WHERE id IN (${placeholders})`).run(jeId, ...ids);
        }
      }
    })();
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
  audit(req.user.id, 'create', 'warehouse_move_batch', ids[0] || 0, `${type} ${ids.length} ردیف`);
  res.json({ ok: true, ids, count: ids.length });
});

module.exports = router;
