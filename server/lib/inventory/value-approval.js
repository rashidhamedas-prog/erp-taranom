'use strict';
/**
 * v522 — value change after sale needs accountant approval (whole change).
 *
 * When a value change (landed cost, purchase amend price change, GRNI invoice price
 * difference, …) hits a product×pool where part of the affected receipt quantity was
 * already issued, the change is NOT applied: the source posts its JE side to the clearing
 * account «تعدیل بهای در انتظار تأیید» and a pending approval document is created.
 *
 *   approve → clearing → inventory (in-stock share, value rows/buckets) + COGS (sold share)
 *             + WIP (share consumed by production), one transaction.
 *   reject  → clearing → «انحراف بها»; item rate unchanged.
 *   reopen  → R13 full reversal of the decision (value rows + JE), back to pending.
 *   cancelForSource → source voided/amended: reopen decided docs, then status cancelled.
 *
 * reason: 'after_sale' (above) | 'closed_period' — the source is dated in a month closed in
 * inventory_period_locks: EVERY value change is parked (whole delta), and a back-dated inbound
 * receipt enters at the pool rate with its difference parked (parkReceiptDifference). Sources
 * whose own JE already hit inventory use finish({park:true}) → parking JE Dr clearing / Cr
 * inventory. Approve: post_date_mode 'original' (document date, lock bypassed for this doc
 * only) | 'next_open' (first day of the next open month).
 * v525: withSourceGroup → one doc per multi-line source (warehouse doc); cancelForSourceCarry →
 * incremental sources (cutting-lay delta, receipt align) re-route their un-applied change.
 */
const VA = require('./value-accounts');

const PROD_ISSUE_EVENTS = new Set(['production_issue', 'material_issue', 'consumption']);
const SRC = 'inventory_value_approval';

function vaErr(code, status, message, extra) {
  const e = new Error(message);
  e.code = code;
  e.status = status;
  if (extra) e.extra = extra;
  return e;
}

function today() {
  try { return require('../../jalali').todayJalali(); } catch (_) { return ''; }
}

function ensureValueApprovalSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS inventory_value_approvals (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_no           TEXT,
      status           TEXT NOT NULL DEFAULT 'pending',
      source_type      TEXT NOT NULL DEFAULT '',
      source_id        INTEGER,
      source_label     TEXT DEFAULT '',
      date             TEXT DEFAULT '',
      total_delta_rial INTEGER NOT NULL DEFAULT 0,
      clearing_code    TEXT,
      decision         TEXT,
      decision_je_id   INTEGER,
      decision_date    TEXT,
      decision_note    TEXT DEFAULT '',
      decided_by       INTEGER,
      decided_at       INTEGER,
      reopen_count     INTEGER NOT NULL DEFAULT 0,
      note             TEXT DEFAULT '',
      created_by       INTEGER,
      created_at       INTEGER DEFAULT (strftime('%s','now')),
      updated_at       INTEGER
    );
    CREATE INDEX IF NOT EXISTS ix_inv_val_appr_src ON inventory_value_approvals(source_type, source_id, status);
    CREATE INDEX IF NOT EXISTS ix_inv_val_appr_status ON inventory_value_approvals(status);

    CREATE TABLE IF NOT EXISTS inventory_value_approval_lines (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      approval_id      INTEGER NOT NULL,
      product_id       INTEGER NOT NULL,
      warehouse_id     INTEGER,
      ref_qty          REAL NOT NULL DEFAULT 0,
      sold_qty         REAL NOT NULL DEFAULT 0,
      wip_qty          REAL NOT NULL DEFAULT 0,
      in_stock_qty     REAL NOT NULL DEFAULT 0,
      delta_rial       INTEGER NOT NULL DEFAULT 0,
      inv_share_rial   INTEGER NOT NULL DEFAULT 0,
      cogs_share_rial  INTEGER NOT NULL DEFAULT 0,
      wip_share_rial   INTEGER NOT NULL DEFAULT 0,
      inventory_code   TEXT,
      ledger_ids_json  TEXT,
      note             TEXT DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS ix_inv_val_appr_lines ON inventory_value_approval_lines(approval_id);
  `);
  const addCol = (table, col, ddl) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
  };
  addCol('inventory_value_approvals', 'reason', "TEXT NOT NULL DEFAULT 'after_sale'");
  addCol('inventory_value_approvals', 'post_date_mode', 'TEXT');
  addCol('inventory_value_approval_lines', 'status', "TEXT NOT NULL DEFAULT 'active'");
  addCol('inventory_value_approval_lines', 'ledger_ref_id', 'INTEGER');
  addCol('inventory_value_approval_lines', 'park_je_id', 'INTEGER');
  addCol('inventory_value_approval_lines', 'inventory_name', 'TEXT');
  // v525: explicit counter account (manual stock adjustment): approve = clearing ↔ this account, whole amount.
  addCol('inventory_value_approval_lines', 'counter_code', 'TEXT');
  addCol('inventory_value_approval_lines', 'counter_name', 'TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS ix_inv_val_appr_lines_led ON inventory_value_approval_lines(ledger_ref_id)');
}

const REASONS = ['after_sale', 'closed_period'];

/** On-hand of the pool that (product, warehouse) belongs to. */
function poolOnHand(db, productId, warehouseId) {
  const V = require('./valuation');
  const lv = V.levelFor(db, productId, warehouseId || null);
  if (lv.level === 'warehouse' && warehouseId) {
    const b = V.getBucket(db, productId, warehouseId);
    return { qty: Math.max(0, Number(b && b.qty) || 0), warehouseIds: [Number(warehouseId)] };
  }
  const pools = V.productPools(db, productId);
  if (pools.mode === 'mixed') {
    const st = V.sharedPoolState(db, productId, pools);
    return { qty: Math.max(0, st.qty), warehouseIds: [...pools.shared] };
  }
  const p = db.prepare('SELECT stock FROM products WHERE id=?').get(productId);
  return { qty: Math.max(0, Number(p && p.stock) || 0), warehouseIds: null };
}

/** Split issued qty into production-consumed (WIP) vs sold (COGS) from the latest outbound rows. */
function splitIssued(db, productId, warehouseIds, soldQty) {
  if (!(soldQty > 1e-9)) return { wip: 0, cogs: 0 };
  let sql = `SELECT event_type, qty_out, warehouse_id FROM inventory_ledger
    WHERE product_id=? AND status='posted' AND qty_out>0 AND reversed_of IS NULL
      AND event_type NOT IN ('transfer_out','reversal','purchase','purchase_return')`;
  const params = [productId];
  if (warehouseIds && warehouseIds.length) {
    sql += ` AND COALESCE(warehouse_id,0) IN (${warehouseIds.map(() => '?').join(',')})`;
    params.push(...warehouseIds.map((x) => Number(x) || 0));
  }
  sql += ' ORDER BY id DESC LIMIT 500';
  let left = soldQty;
  let wip = 0;
  for (const r of db.prepare(sql).all(...params)) {
    if (left <= 1e-9) break;
    const q = Math.min(left, Number(r.qty_out) || 0);
    if (PROD_ISSUE_EVENTS.has(String(r.event_type || ''))) wip += q;
    left -= q;
  }
  return { wip, cogs: soldQty - wip };
}

/**
 * Does a value change on (product, warehouse) for a receipt of refQty need approval?
 * sold = refQty − pool on-hand (clamped). No refQty → never gated (apply as before).
 */
function planGate(db, { productId, warehouseId = null, refQty }) {
  const rq = Number(refQty) || 0;
  if (!(rq > 1e-9) || process.env.SYNC_ROLE === 'device') {
    return { needs: false, ref_qty: rq, sold_qty: 0, wip_qty: 0, in_stock_qty: rq };
  }
  return splitPlan(db, { productId, warehouseId, refQty: rq });
}

/** Closed month: every value change is parked; the split is informational (recomputed at approval). */
function closedPlan(db, { productId, warehouseId = null, refQty }) {
  const rq = Number(refQty) || 0;
  if (!(rq > 1e-9)) return { needs: true, ref_qty: 0, sold_qty: 0, wip_qty: 0, in_stock_qty: 0 };
  return { ...splitPlan(db, { productId, warehouseId, refQty: rq }), needs: true };
}

function splitPlan(db, { productId, warehouseId, refQty }) {
  const rq = refQty;
  const oh = poolOnHand(db, productId, warehouseId);
  const sold = Math.min(rq, Math.max(0, rq - oh.qty));
  const split = splitIssued(db, productId, oh.warehouseIds, sold);
  return {
    needs: sold > 1e-9,
    ref_qty: rq,
    sold_qty: sold,
    wip_qty: split.wip,
    in_stock_qty: rq - sold,
    pool_on_hand: oh.qty,
  };
}

/**
 * Collector for one source document (call inside the source transaction).
 * gate(line) → true when the line was parked for approval (caller must post its JE side
 * to clearing and skip the value row). finish() creates the doc + notification.
 */
function begin(db, { sourceType, sourceId, date, createdBy = null, label = '', note = '' }) {
  const lines = [];
  const clearing = VA.clearingAccount(db);
  const closed = !!date && require('./period-lock').isValueLocked(db, date);
  return {
    clearing,
    lines,
    closed,
    reason: closed ? 'closed_period' : 'after_sale',
    gate(line) {
      const delta = Math.round(Number(line.deltaRial) || 0);
      if (!delta) return false;
      if (closed) {
        lines.push({ ...line, delta, plan: closedPlan(db, line) });
        return true;
      }
      const g = planGate(db, { productId: line.productId, warehouseId: line.warehouseId, refQty: line.refQty });
      if (!g.needs) return false;
      lines.push({ ...line, delta, plan: g });
      return true;
    },
    gatedTotal() { return lines.reduce((s, l) => s + l.delta, 0); },
    gatedFor(productId) { return lines.filter((l) => Number(l.productId) === Number(productId)).reduce((s, l) => s + l.delta, 0); },
    /**
     * park=true: the source JE already debited inventory with the full change, so a
     * parking JE (Dr clearing / Cr inventory, signed) moves the gated part to clearing.
     */
    finish({ park = false } = {}) {
      if (!lines.length) return null;
      return createApproval(db, {
        sourceType, sourceId, date, createdBy, label, note, lines, clearing,
        reason: closed ? 'closed_period' : 'after_sale', park,
      });
    },
  };
}

function lineInventoryAccount(db, l) {
  if (l.inventoryCode) return { code: l.inventoryCode, name: l.inventoryName || '' };
  return require('./ledger').inventoryAccountForWarehouse(db, l.warehouseId || null);
}

function insertLines(db, approvalId, lines) {
  const ins = db.prepare(`
    INSERT INTO inventory_value_approval_lines
      (approval_id, product_id, warehouse_id, ref_qty, sold_qty, wip_qty, in_stock_qty, delta_rial,
       inventory_code, inventory_name, note, ledger_ref_id, counter_code, counter_name)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  return lines.map((l) => {
    const inv = lineInventoryAccount(db, l);
    return ins.run(approvalId, l.productId, l.warehouseId || null, l.plan.ref_qty, l.plan.sold_qty, l.plan.wip_qty,
      l.plan.in_stock_qty, l.delta, inv.code, inv.name || null, String(l.note || '').slice(0, 200),
      l.ledgerRefId || null, l.counterCode || null, l.counterCode ? (l.counterName || null) : null).lastInsertRowid;
  });
}

/** Parking JE for the given lines: Dr clearing / Cr their inventory accounts (signed). */
function postParkJe(db, head, lineIds, { userId, date } = {}) {
  if (!lineIds.length) return null;
  const rows = db.prepare(`SELECT * FROM inventory_value_approval_lines WHERE id IN (${lineIds.map(() => '?').join(',')})`).all(...lineIds);
  const clearing = { code: head.clearing_code || VA.clearingAccount(db).code, name: 'تعدیل بهای در انتظار تأیید' };
  const je = new Map();
  for (const l of rows) {
    const d = Math.round(Number(l.delta_rial) || 0);
    pushNet(je, clearing, d, 'تغییر بها در انتظار تأیید (قفل دوره)');
    pushNet(je, { code: l.inventory_code, name: l.inventory_name || '' }, -d, 'تغییر بها در انتظار تأیید (قفل دوره)');
  }
  const jeId = postNetJe(db, je, {
    sourceId: head.id, date: date || head.date, userId,
    description: `انتقال تغییر بها به «در انتظار تأیید» ${head.doc_no}`,
  });
  if (jeId) {
    db.prepare(`UPDATE inventory_value_approval_lines SET park_je_id=? WHERE id IN (${lineIds.map(() => '?').join(',')})`).run(jeId, ...lineIds);
  }
  return jeId;
}

function notifyApproval(db, { id, docNo, label, sourceType, total, reason }) {
  try {
    require('../notifications').notifyRoles(db, {
      kind: 'value_change_approval',
      entity_type: 'inventory_value_approval',
      entity_id: id,
      title: `تأیید تغییر بها ${docNo}${reason === 'closed_period' ? ' (قفل دوره)' : ''}`,
      body: reason === 'closed_period'
        ? `${label || sourceType} — ${Math.round(total).toLocaleString('fa-IR')} ریال؛ تاریخ سند در ماه قفل‌شدهٔ ارزش‌گذاری است و اثر ریالی آن منتظر تأیید است`
        : `${label || sourceType} — ${Math.round(total).toLocaleString('fa-IR')} ریال؛ بخشی از کالا قبلاً فروش/مصرف شده و تغییر بها منتظر تأیید حسابدار است`,
      target_roles: ['admin', 'accounting'],
    });
  } catch (_) { /* notifications optional */ }
}

function createApproval(db, { sourceType, sourceId, date, createdBy, label, note, lines, clearing, reason = 'after_sale', park = false }) {
  let docNo;
  try { docNo = require('../../db').allocateNumber(db, 'inv_value_approval', 'IVA'); } catch (_) { docNo = 'IVA-' + Date.now().toString(36).toUpperCase(); }
  const total = lines.reduce((s, l) => s + l.delta, 0);
  const id = db.prepare(`
    INSERT INTO inventory_value_approvals
      (doc_no, status, source_type, source_id, source_label, date, total_delta_rial, clearing_code, note, created_by, reason, updated_at)
    VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%s','now'))
  `).run(docNo, sourceType, sourceId || null, String(label || '').slice(0, 200), date || today(), total,
    clearing.code, String(note || '').slice(0, 400), createdBy || null, REASONS.includes(reason) ? reason : 'after_sale').lastInsertRowid;
  const lineIds = insertLines(db, id, lines);
  if (park) {
    const head = db.prepare('SELECT * FROM inventory_value_approvals WHERE id=?').get(id);
    postParkJe(db, head, lineIds, { userId: createdBy, date: head.date });
  }
  notifyApproval(db, { id, docNo, label, sourceType, total, reason });
  return get(db, id);
}

/**
 * v525: a multi-line source document (warehouse doc, …) wraps its postings so every parked
 * receipt difference lands in ONE approval doc keyed by the document, not one per ledger row.
 * Synchronous, same transaction (like withLockBypass).
 */
const sourceGroups = [];
function withSourceGroup(group, fn) {
  sourceGroups.push(group || null);
  try { return fn(); } finally { sourceGroups.pop(); }
}
function currentSourceGroup() {
  const g = sourceGroups.length ? sourceGroups[sourceGroups.length - 1] : null;
  return g && g.sourceType && g.sourceId != null ? g : null;
}

/**
 * Rate a closed-month inbound row of (product, warehouse) enters at: the current average of
 * the pool that warehouse belongs to. null = nothing to protect (empty pool, periodic, WIP).
 */
function closedInboundPoolUnit(db, productId, warehouseId) {
  const V = require('./valuation');
  try {
    if (warehouseId && require('./periodic-close').isPeriodicWarehouse(db, warehouseId)) return null;
  } catch (_) { /* periodic module optional */ }
  if (warehouseId && isWipWarehouse(db, warehouseId)) return null;
  const lv = V.levelFor(db, productId, warehouseId || null);
  let qty;
  let unit;
  if (lv.level === 'warehouse' && warehouseId) {
    const b = V.getBucket(db, productId, warehouseId);
    qty = Number(b && b.qty) || 0;
    unit = Math.round(Number(b && b.avg_rial) || 0);
  } else {
    const pools = V.productPools(db, productId);
    if (pools.mode === 'mixed') {
      const st = V.sharedPoolState(db, productId, pools);
      qty = st.qty;
      unit = st.avg_rial;
    } else {
      const p = db.prepare('SELECT stock, average_cost_rial FROM products WHERE id=?').get(productId);
      qty = Number(p && p.stock) || 0;
      unit = Math.round(Number(p && p.average_cost_rial) || 0);
    }
  }
  if (!(qty > 1e-9) || !(unit > 0)) return null;
  return unit;
}

function isWipWarehouse(db, warehouseId) {
  try {
    return !!db.prepare("SELECT 1 FROM warehouses WHERE id=? AND (kind='wip' OR warehouse_type='wip')").get(warehouseId);
  } catch (_) {
    try { return !!db.prepare("SELECT 1 FROM warehouses WHERE id=? AND warehouse_type='wip'").get(warehouseId); } catch (__) { return false; }
  }
}

/** Pool identity of (product, warehouse): its own bucket for warehouse level, else the shared pool. */
function poolKeyOf(db, productId, warehouseId) {
  const lv = require('./valuation').levelFor(db, productId, warehouseId || null);
  if (lv.level === 'warehouse' && warehouseId) return `w:${Number(warehouseId)}`;
  return 'shared';
}

/**
 * Back-dated inbound receipt into a closed month (called by postInventoryMovement):
 * qty entered at the current pool rate; the receipt-vs-pool difference is parked here
 * (one doc per source document, one line per ledger row) with its own parking JE.
 */
function parkReceiptDifference(db, {
  sourceType, sourceId, ledgerId, productId, warehouseId, qtyIn, diffRial, date, createdBy, note, label: labelIn,
}) {
  const delta = Math.round(Number(diffRial) || 0);
  if (!delta) return null;
  const grp = currentSourceGroup();
  const srcType = grp ? grp.sourceType : `receipt:${sourceType || 'inventory'}`;
  const srcId = grp ? grp.sourceId : sourceId;
  const line = {
    productId, warehouseId: warehouseId || null, refQty: qtyIn, delta, ledgerRefId: ledgerId,
    note: note || 'رسید با تاریخ ماه قفل‌شده',
    plan: closedPlan(db, { productId, warehouseId, refQty: qtyIn }),
  };
  let head = srcId != null ? db.prepare(`
    SELECT * FROM inventory_value_approvals
    WHERE source_type=? AND source_id=? AND status='pending' AND reason='closed_period' AND date=?
    ORDER BY id DESC LIMIT 1
  `).get(srcType, srcId, date) : null;
  if (!head) {
    const clearing = VA.clearingAccount(db);
    const label = (grp && grp.label) || labelIn
      || `رسید ${sourceType || ''} #${sourceId || ledgerId} — مابه‌التفاوت نرخ رسید با میانگین (قفل دوره)`;
    const doc = createApproval(db, {
      sourceType: srcType, sourceId: srcId != null ? srcId : null, date, createdBy, label,
      lines: [line], clearing, reason: 'closed_period', park: true,
    });
    return doc;
  }
  const [lineId] = insertLines(db, head.id, [line]);
  db.prepare("UPDATE inventory_value_approvals SET total_delta_rial=total_delta_rial+?, updated_at=strftime('%s','now') WHERE id=?").run(delta, head.id);
  head = db.prepare('SELECT * FROM inventory_value_approvals WHERE id=?').get(head.id);
  postParkJe(db, head, [lineId], { userId: createdBy, date });
  return get(db, head.id);
}

function pushNet(map, acc, signedDebit, description) {
  const amt = Math.round(Number(signedDebit) || 0);
  if (!amt) return;
  const cur = map.get(acc.code) || { code: acc.code, name: acc.name, net: 0, description };
  cur.net += amt;
  map.set(acc.code, cur);
}

function postNetJe(db, map, { sourceId, date, description, userId }) {
  const lines = [...map.values()].filter((l) => l.net).map((l) => ({
    code: l.code, name: l.name,
    debit: l.net > 0 ? l.net / 10 : 0,
    credit: l.net < 0 ? -l.net / 10 : 0,
    description: l.description,
  }));
  if (!lines.length) return null;
  return require('../ledger').postToLedger(db, {
    sourceType: SRC, sourceId, date, description, createdBy: userId || null, lines,
  });
}

function loadPending(db, id) {
  const head = db.prepare('SELECT * FROM inventory_value_approvals WHERE id=?').get(Number(id));
  if (!head) throw vaErr('E_APPROVAL_NOT_FOUND', 404, 'سند تأیید تغییر بها یافت نشد');
  if (head.status !== 'pending') throw vaErr('E_APPROVAL_NOT_PENDING', 409, 'فقط سند در انتظار قابل تصمیم‌گیری است');
  return head;
}

const POST_DATE_MODES = ['original', 'next_open'];

/**
 * Posting date of a decision.
 *  closed_period docs (or an explicit post_date_mode): 'original' (default) = document date,
 *    posted inside the closed month under the approval's lock bypass; 'next_open' = first day
 *    of the first open month after the document month.
 *  after_sale docs without post_date_mode: body.date || today, must be an open month (legacy).
 */
function decisionDate(db, head, body = {}) {
  const PL = require('./period-lock');
  const raw = body && body.post_date_mode != null && body.post_date_mode !== '' ? String(body.post_date_mode) : null;
  if (raw && !POST_DATE_MODES.includes(raw)) {
    throw vaErr('E_POST_DATE_MODE', 400, 'نحوهٔ تاریخ ثبت باید original یا next_open باشد');
  }
  if (head.reason === 'closed_period' || raw) {
    const mode = raw || 'original';
    const original = String(head.date || today());
    if (mode === 'next_open') return { date: PL.nextOpenMonthFirst(db, original), mode, bypass: false };
    return { date: original, mode, bypass: true };
  }
  const d = String((body && body.date) || today());
  PL.assertPeriodOpen(db, d, 'تأیید تغییر بها');
  return { date: d, mode: 'decision_date', bypass: false };
}

function activeLines(db, approvalId) {
  return db.prepare("SELECT * FROM inventory_value_approval_lines WHERE approval_id=? AND COALESCE(status,'active')='active' ORDER BY id").all(approvalId);
}

function approve(db, id, user, body = {}) {
  const V = require('./valuation');
  const { acct } = require('../coa-map');
  const { inventoryAccountForWarehouse } = require('./ledger');
  const PL = require('./period-lock');
  const { assertMakerChecker } = require('../rbac');
  db.transaction(() => {
    const head = loadPending(db, id);
    assertMakerChecker(user, head.created_by);
    const dd = decisionDate(db, head, body);
    const date = dd.date;
    const run = (fn) => (dd.bypass ? PL.withLockBypass(fn) : fn());
    run(() => {
    const clearing = { code: head.clearing_code || VA.clearingAccount(db).code, name: 'تعدیل بهای در انتظار تأیید' };
    const cogs = acct(db, 'coa_cogs');
    const wipAcc = acct(db, 'coa_wip');
    const je = new Map();
    const upd = db.prepare(`
      UPDATE inventory_value_approval_lines SET sold_qty=?, wip_qty=?, in_stock_qty=?,
        inv_share_rial=?, cogs_share_rial=?, wip_share_rial=?, ledger_ids_json=? WHERE id=?
    `);
    for (const l of activeLines(db, head.id)) {
      if (l.counter_code) {
        // Manual adjustment: qty already moved; nothing sold/in-stock to split — whole amount to its counter account.
        const d = Math.round(Number(l.delta_rial) || 0);
        pushNet(je, { code: l.counter_code, name: l.counter_name || '' }, d, 'تأیید تغییر بها — حساب مقابل تعدیل');
        pushNet(je, clearing, -d, 'تسویه تعدیل بهای در انتظار تأیید');
        upd.run(0, 0, 0, 0, 0, 0, '[]', l.id);
        continue;
      }
      const rq = Number(l.ref_qty) || 0;
      // No reference qty (closed-month change without a receipt qty): all to on-hand stock.
      const g = rq > 1e-9
        ? planGate(db, { productId: l.product_id, warehouseId: l.warehouse_id, refQty: rq })
        : { sold_qty: 0, wip_qty: 0, in_stock_qty: 0 };
      // Later receipts must not hide what was already issued when the change was parked.
      if ((Number(l.sold_qty) || 0) > g.sold_qty) {
        g.sold_qty = Math.min(rq, Number(l.sold_qty) || 0);
        g.wip_qty = Math.min(g.sold_qty, Math.max(g.wip_qty, Number(l.wip_qty) || 0));
        g.in_stock_qty = rq - g.sold_qty;
      }
      const delta = Math.round(Number(l.delta_rial) || 0);
      let invShare = rq > 0 ? Math.round(delta * (g.in_stock_qty / rq)) : 0;
      const ledgerIds = [];
      if (invShare) {
        const res = V.postValueAdjustment(db, {
          productId: l.product_id, warehouseId: l.warehouse_id || null, deltaRial: invShare, date,
          sourceType: SRC, sourceId: head.id, eventType: 'cost_adjustment', createdBy: user?.id || null,
          note: `تأیید تغییر بها ${head.doc_no}`,
        });
        if (res.ledger_id) ledgerIds.push(res.ledger_id);
        invShare = Math.round(Number(res.applied_rial) || 0);
      }
      const soldShare = delta - invShare;
      const soldQty = Math.max(1e-9, g.sold_qty);
      const wipShare = g.sold_qty > 1e-9 ? Math.round(soldShare * (g.wip_qty / soldQty)) : 0;
      const cogsShare = soldShare - wipShare;
      const inv = l.inventory_code ? { code: l.inventory_code, name: l.inventory_name || '' } : inventoryAccountForWarehouse(db, l.warehouse_id || null);
      pushNet(je, inv, invShare, 'تأیید تغییر بها — سهم موجودی');
      pushNet(je, cogs, cogsShare, 'تأیید تغییر بها — سهم فروش‌رفته');
      pushNet(je, wipAcc, wipShare, 'تأیید تغییر بها — سهم مصرف تولید');
      pushNet(je, clearing, -delta, 'تسویه تعدیل بهای در انتظار تأیید');
      upd.run(g.sold_qty, g.wip_qty, g.in_stock_qty, invShare, cogsShare, wipShare, JSON.stringify(ledgerIds), l.id);
    }
    const jeId = postNetJe(db, je, {
      sourceId: head.id, date, userId: user?.id, description: `تأیید تغییر بها ${head.doc_no}${body.note ? ' — ' + String(body.note).slice(0, 120) : ''}`,
    });
    if (jeId) {
      db.prepare(`UPDATE inventory_ledger SET je_id=? WHERE source_type=? AND source_id=? AND status='posted' AND je_id IS NULL`).run(jeId, SRC, head.id);
    }
    db.prepare(`
      UPDATE inventory_value_approvals SET status='approved', decision='approve', decision_je_id=?, decision_date=?,
        decision_note=?, decided_by=?, decided_at=strftime('%s','now'), post_date_mode=?, updated_at=strftime('%s','now') WHERE id=?
    `).run(jeId, date, String(body.note || '').slice(0, 400), user?.id || null, dd.mode, head.id);
    audit(user, 'approve', head.id, `${head.doc_no} تأیید شد (تاریخ ثبت ${date}${dd.bypass && PL.isPeriodLocked(db, date) ? ' — داخل ماه قفل با مجوز همین سند' : ''})`);
    });
  })();
  return get(db, id);
}

function reject(db, id, user, body = {}) {
  db.transaction(() => {
    const head = loadPending(db, id);
    const dd = decisionDate(db, head, body);
    const date = dd.date;
    const clearing = { code: head.clearing_code || VA.clearingAccount(db).code, name: 'تعدیل بهای در انتظار تأیید' };
    const variance = VA.priceVarianceAccount(db);
    const total = activeLines(db, head.id).reduce((s, l) => s + Math.round(Number(l.delta_rial) || 0), 0);
    const je = new Map();
    pushNet(je, variance, total, 'رد تغییر بها — انحراف بها');
    pushNet(je, clearing, -total, 'تسویه تعدیل بهای در انتظار تأیید');
    const jeId = postNetJe(db, je, {
      sourceId: head.id, date, userId: user?.id, description: `رد تغییر بها ${head.doc_no}${body.note ? ' — ' + String(body.note).slice(0, 120) : ''}`,
    });
    db.prepare(`
      UPDATE inventory_value_approval_lines SET inv_share_rial=0, cogs_share_rial=0, wip_share_rial=0, ledger_ids_json='[]'
      WHERE approval_id=?
    `).run(head.id);
    db.prepare(`
      UPDATE inventory_value_approvals SET status='rejected', decision='reject', decision_je_id=?, decision_date=?,
        decision_note=?, decided_by=?, decided_at=strftime('%s','now'), post_date_mode=?, updated_at=strftime('%s','now') WHERE id=?
    `).run(jeId, date, String(body.note || '').slice(0, 400), user?.id || null, dd.mode, head.id);
    audit(user, 'reject', head.id, `${head.doc_no} رد شد`);
  })();
  return get(db, id);
}

/** R13: undo an approve/reject decision completely (value rows by value + JE) → pending. */
function reopenInTx(db, head, user, reason) {
  const { reverseInventoryMovement } = require('./ledger');
  const { reverseJournalEntry } = require('../void-journal');
  const why = String(reason || '').slice(0, 200) || `بازگشایی تصمیم ${head.doc_no}`;
  const rows = db.prepare(`
    SELECT id FROM inventory_ledger WHERE source_type=? AND source_id=? AND status='posted'
      AND COALESCE(qty_in,0)=0 AND COALESCE(qty_out,0)=0 AND reversed_of IS NULL ORDER BY id DESC
  `).all(SRC, head.id);
  // Mirror the decision exactly: reversal rows keep the decision's date, even in a closed month.
  for (const r of rows) reverseInventoryMovement(db, r.id, { createdBy: user?.id || null, note: why, keepDate: true });
  if (head.decision_je_id) {
    reverseJournalEntry(db, head.decision_je_id, { userId: user?.id || null, reason: why, sourceType: SRC });
  }
  db.prepare(`
    UPDATE inventory_value_approval_lines SET inv_share_rial=0, cogs_share_rial=0, wip_share_rial=0, ledger_ids_json='[]'
    WHERE approval_id=?
  `).run(head.id);
  db.prepare(`
    UPDATE inventory_value_approvals SET status='pending', decision=NULL, decision_je_id=NULL, decision_date=NULL,
      decided_by=NULL, decided_at=NULL, post_date_mode=NULL, reopen_count=reopen_count+1, decision_note=?, updated_at=strftime('%s','now') WHERE id=?
  `).run(why, head.id);
}

function reverseParkJes(db, lineRows, user, why) {
  const { reverseJournalEntry } = require('../void-journal');
  const done = new Set();
  for (const l of lineRows) {
    const jeId = Number(l.park_je_id) || 0;
    if (!jeId || done.has(jeId)) continue;
    done.add(jeId);
    reverseJournalEntry(db, jeId, { userId: user?.id || null, reason: why, sourceType: SRC });
  }
}

/**
 * An inbound ledger row whose receipt difference was parked got reversed (source void /
 * amend): undo the doc's decision if any, cancel that line + its parking JE; a doc without
 * active lines becomes cancelled. Called by reverseInventoryMovement (same tx).
 */
function onLedgerReversed(db, ledgerId, { createdBy = null, note = '' } = {}) {
  let lines;
  try {
    lines = db.prepare("SELECT * FROM inventory_value_approval_lines WHERE ledger_ref_id=? AND COALESCE(status,'active')='active'").all(ledgerId);
  } catch (_) { return 0; }
  if (!lines.length) return 0;
  const user = { id: createdBy };
  const why = String(note || 'ابطال رسید مبدأ').slice(0, 200);
  for (const l of lines) {
    let head = db.prepare('SELECT * FROM inventory_value_approvals WHERE id=?').get(l.approval_id);
    if (!head || head.status === 'cancelled') continue;
    if (head.status === 'approved' || head.status === 'rejected') {
      reopenInTx(db, head, user, why);
      head = db.prepare('SELECT * FROM inventory_value_approvals WHERE id=?').get(head.id);
    }
    const shared = db.prepare("SELECT COUNT(*) c FROM inventory_value_approval_lines WHERE park_je_id=? AND id<>? AND COALESCE(status,'active')='active'").get(l.park_je_id || -1, l.id).c;
    if (l.park_je_id && !shared) reverseParkJes(db, [l], user, why);
    db.prepare("UPDATE inventory_value_approval_lines SET status='cancelled' WHERE id=?").run(l.id);
    const left = activeLines(db, head.id);
    const total = left.reduce((s, x) => s + Math.round(Number(x.delta_rial) || 0), 0);
    db.prepare(`
      UPDATE inventory_value_approvals SET total_delta_rial=?, status=?, decision_note=?, updated_at=strftime('%s','now') WHERE id=?
    `).run(total, left.length ? head.status : 'cancelled', why, head.id);
  }
  return lines.length;
}

function reopen(db, id, user, { reason } = {}) {
  db.transaction(() => {
    const head = db.prepare('SELECT * FROM inventory_value_approvals WHERE id=?').get(Number(id));
    if (!head) throw vaErr('E_APPROVAL_NOT_FOUND', 404, 'سند تأیید تغییر بها یافت نشد');
    if (!['approved', 'rejected'].includes(head.status)) {
      throw vaErr('E_APPROVAL_NOT_DECIDED', 409, 'فقط تصمیم تأیید/رد قابل ابطال است');
    }
    reopenInTx(db, head, user, reason);
    audit(user, 'reverse', head.id, `${head.doc_no} — ابطال تصمیم ${head.status}`);
  })();
  return get(db, id);
}

/** Source voided or re-amended: undo decisions and cancel its approval docs (inside caller tx). */
function cancelForSource(db, sourceType, sourceId, user, reason) {
  return cancelSourceDocs(db, sourceType, sourceId, user, reason).count;
}

/**
 * v525 — incremental sources (covered cutting-lay delta, order receipt align) post their
 * parked change straight to clearing (finish({park:false})) and never reverse that JE.
 * On their next amend/void the docs are cancelled (decisions undone, R13) and the still
 * un-applied lines are handed back so the caller re-routes them: closed month → into its
 * new approval doc (clearing balance kept); open month → clearing → inventory/COGS now.
 * Lines carried by a parking JE are fully reversed here and never carried.
 */
function cancelForSourceCarry(db, sourceType, sourceId, user, reason) {
  return cancelSourceDocs(db, sourceType, sourceId, user, reason);
}

function cancelSourceDocs(db, sourceType, sourceId, user, reason) {
  const empty = { count: 0, lines: [], total: 0 };
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='inventory_value_approvals'").get()) return empty;
  } catch (_) { return empty; }
  const docs = db.prepare(`
    SELECT * FROM inventory_value_approvals WHERE source_type=? AND source_id=? AND status IN ('pending','approved','rejected')
  `).all(sourceType, sourceId);
  const why = reason || 'ابطال/اصلاح سند مبدأ';
  const carried = [];
  for (const head of docs) {
    if (head.status !== 'pending') reopenInTx(db, head, user, why);
    const lines = activeLines(db, head.id);
    reverseParkJes(db, lines, user, why);
    for (const l of lines) {
      if (!l.park_je_id && Math.round(Number(l.delta_rial) || 0)) carried.push(l);
    }
    db.prepare("UPDATE inventory_value_approval_lines SET status='cancelled' WHERE approval_id=?").run(head.id);
    db.prepare(`
      UPDATE inventory_value_approvals SET status='cancelled', decision_note=?, updated_at=strftime('%s','now') WHERE id=?
    `).run(String(why).slice(0, 200), head.id);
  }
  return {
    count: docs.length,
    lines: carried,
    total: carried.reduce((s, l) => s + Math.round(Number(l.delta_rial) || 0), 0),
  };
}

function audit(user, action, id, detail) {
  try { require('../../db').audit(user?.id || null, action, SRC, id, detail); } catch (_) { /* optional */ }
}

function list(db, { status, reason, limit = 100 } = {}) {
  const lim = Math.min(500, Math.max(1, Number(limit) || 100));
  const conds = [];
  const params = [];
  if (status && status !== 'all') { conds.push('a.status=?'); params.push(status); }
  if (reason && REASONS.includes(reason)) { conds.push('a.reason=?'); params.push(reason); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  params.push(lim);
  return db.prepare(`
    SELECT a.*, u.name AS created_by_name, d.name AS decided_by_name,
      (SELECT COUNT(*) FROM inventory_value_approval_lines l WHERE l.approval_id=a.id AND COALESCE(l.status,'active')='active') AS line_count
    FROM inventory_value_approvals a
    LEFT JOIN users u ON u.id=a.created_by
    LEFT JOIN users d ON d.id=a.decided_by
    ${where}
    ORDER BY CASE a.status WHEN 'pending' THEN 0 ELSE 1 END, a.id DESC LIMIT ?
  `).all(...params);
}

function get(db, id) {
  const head = db.prepare('SELECT * FROM inventory_value_approvals WHERE id=?').get(Number(id));
  if (!head) throw vaErr('E_APPROVAL_NOT_FOUND', 404, 'سند تأیید تغییر بها یافت نشد');
  const lines = db.prepare(`
    SELECT l.*, p.code AS product_code, p.name AS product_name, w.name AS warehouse_name
    FROM inventory_value_approval_lines l
    LEFT JOIN products p ON p.id=l.product_id
    LEFT JOIN warehouses w ON w.id=l.warehouse_id
    WHERE l.approval_id=? ORDER BY l.id
  `).all(head.id).map((l) => {
    let ledgerIds = [];
    try { ledgerIds = JSON.parse(l.ledger_ids_json || '[]'); } catch (_) { ledgerIds = []; }
    const rq = Number(l.ref_qty) || 0;
    const preview = head.status === 'pending' ? planGate(db, { productId: l.product_id, warehouseId: l.warehouse_id, refQty: rq }) : null;
    return { ...l, ledger_ids: ledgerIds, current_split: preview };
  });
  const PL = require('./period-lock');
  return {
    ...head,
    lines,
    period_locked: PL.isPeriodLocked(db, head.date),
    next_open_date: head.date ? PL.nextOpenMonthFirst(db, head.date) : null,
  };
}

module.exports = {
  ensureValueApprovalSchema,
  planGate,
  begin,
  parkReceiptDifference,
  withSourceGroup,
  closedInboundPoolUnit,
  poolKeyOf,
  onLedgerReversed,
  REASONS,
  POST_DATE_MODES,
  approve,
  reject,
  reopen,
  cancelForSource,
  cancelForSourceCarry,
  list,
  get,
  SOURCE_TYPE: SRC,
};
