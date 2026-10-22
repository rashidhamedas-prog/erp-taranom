'use strict';
/**
 * Inventory revaluation documents (v521) — all-warehouse twin of production cost-revaluation.
 *
 * Bases:
 *   replay        re-cost past outbound rows (back-dated receipts, negative-stock true-ups,
 *                 voids) → Dr counter (COGS/WIP/…)/Cr inventory per row + header/bucket fix.
 *   manual_unit   set on-hand unit cost to unit_cost_rial.
 *   percent       ± percent of current average.
 *   last_purchase latest posted purchase/receipt unit cost.
 *   std_rollup    production BOM roll-up (computeNewUnitCost).
 * Non-replay bases book inventory vs the revaluation difference account.
 *
 * Post = one transaction: value-only ledger rows + buckets + header avg + ONE balanced JE
 * + queue rows marked done. Reverse (R13) = opposite value rows by value + soft-void JE +
 * adjustments voided + queue rows re-opened. Never restores blind snapshots.
 */
const crypto = require('crypto');
const V = require('./valuation');

const BASES = new Set(['replay', 'manual_unit', 'last_purchase', 'percent', 'std_rollup']);
const RULE_BASES = new Set(['replay', 'last_purchase', 'percent', 'std_rollup']);
const RULE_TRIGGERS = new Set(['back_dated', 'negative_recovery', 'zero_cost_inbound', 'value_change_after_sale', 'schedule']);
const RULE_SCHEDULES = { none: 0, daily: 86400, weekly: 7 * 86400, monthly: 30 * 86400 };
const SRC_MANUAL = 'inventory_revaluation';
const SRC_REPLAY = V.REPLAY_SELF_SOURCE;

function revErr(code, status, message, extra) {
  const e = new Error(message);
  e.code = code;
  e.status = status;
  if (extra) e.extra = extra;
  return e;
}

function todayJalali() {
  try { return require('../../jalali').todayJalali(); } catch (_) { /* fallback */ }
  try {
    return new Intl.DateTimeFormat('en-CA-u-ca-persian', { year: 'numeric', month: '2-digit', day: '2-digit' })
      .format(new Date()).replace(/-/g, '/');
  } catch (_) {
    return '1405/01/01';
  }
}

/* ───────────── v522 schedule_json ─────────────
 * {mode: none|daily|weekly|monthly, weekdays: [0..6] (0 = شنبه), monthdays: [1..31] (روز شمسی),
 *  hour: 0..23, minute: 0..59}. Slot = «تاریخ شمسی HH:MM» of the scheduled run; a rule runs at
 * most once per slot (last_run_slot). Monthday beyond month length → last day of month.
 */
const SCHEDULE_MODES = ['none', 'daily', 'weekly', 'monthly'];

function legacySchedule(s) {
  const m = SCHEDULE_MODES.includes(String(s)) ? String(s) : 'none';
  if (m === 'none') return { mode: 'none', weekdays: [], monthdays: [], hour: 1, minute: 0 };
  return { mode: m, weekdays: m === 'weekly' ? [0] : [], monthdays: m === 'monthly' ? [1] : [], hour: 1, minute: 0 };
}

function normalizeSchedule(input, fallbackLegacy = 'none') {
  let s = input;
  if (typeof s === 'string') {
    const t = s.trim();
    if (!t) s = null;
    else if (SCHEDULE_MODES.includes(t)) return legacySchedule(t);
    else { try { s = JSON.parse(t); } catch (_) { throw revErr('E_RULE_SCHEDULE', 400, 'زمان‌بندی قاعده نامعتبر است'); } }
  }
  if (!s || typeof s !== 'object') return legacySchedule(fallbackLegacy);
  const mode = String(s.mode || 'none');
  if (!SCHEDULE_MODES.includes(mode)) throw revErr('E_RULE_SCHEDULE', 400, 'حالت زمان‌بندی نامعتبر است');
  const ints = (arr, lo, hi) => [...new Set((Array.isArray(arr) ? arr : String(arr || '').split(','))
    .map((x) => parseInt(x, 10)).filter((n) => Number.isFinite(n) && n >= lo && n <= hi))].sort((a, b) => a - b);
  const hour = Math.min(23, Math.max(0, parseInt(s.hour, 10) || 0));
  const minute = Math.min(59, Math.max(0, parseInt(s.minute, 10) || 0));
  const out = { mode, weekdays: ints(s.weekdays, 0, 6), monthdays: ints(s.monthdays, 1, 31), hour, minute };
  if (mode === 'weekly' && !out.weekdays.length) throw revErr('E_RULE_SCHEDULE', 400, 'برای زمان‌بندی هفتگی حداقل یک روز هفته انتخاب کنید');
  if (mode === 'monthly' && !out.monthdays.length) throw revErr('E_RULE_SCHEDULE', 400, 'برای زمان‌بندی ماهانه حداقل یک روز ماه انتخاب کنید');
  if (mode !== 'weekly') out.weekdays = [];
  if (mode !== 'monthly') out.monthdays = [];
  return out;
}

/** Slot key for `now` (Date, server local time) or null when nothing is due yet today. */
function slotFor(schedule, now = new Date()) {
  const s = schedule && typeof schedule === 'object' ? schedule : legacySchedule(schedule);
  if (!s || s.mode === 'none') return null;
  const J = require('../../jalali');
  const [jy, jm, jd] = J.g2j(now.getFullYear(), now.getMonth() + 1, now.getDate());
  if (s.mode === 'weekly') {
    const wd = (now.getDay() + 1) % 7;
    if (!s.weekdays.includes(wd)) return null;
  } else if (s.mode === 'monthly') {
    const dim = J.daysInJalaliMonth(jy, jm);
    const hit = s.monthdays.some((d) => Math.min(d, dim) === jd);
    if (!hit) return null;
  }
  const mins = now.getHours() * 60 + now.getMinutes();
  if (mins < s.hour * 60 + s.minute) return null;
  const p2 = (n) => String(n).padStart(2, '0');
  return `${jy}/${p2(jm)}/${p2(jd)} ${p2(s.hour)}:${p2(s.minute)}`;
}

/** One-time migration: legacy `schedule` text → schedule_json (central boot). */
function migrateRuleSchedulesV522(db) {
  const rows = db.prepare("SELECT id, schedule, schedule_json FROM inventory_revaluation_rules WHERE schedule_json IS NULL OR schedule_json=''").all();
  const up = db.prepare('UPDATE inventory_revaluation_rules SET schedule_json=? WHERE id=?');
  for (const r of rows) up.run(JSON.stringify(legacySchedule(r.schedule)), r.id);
  return rows.length;
}

function parseIds(v) {
  if (v == null || v === '') return [];
  const arr = Array.isArray(v) ? v : String(v).split(',');
  return [...new Set(arr.map((x) => parseInt(x, 10)).filter((n) => Number.isFinite(n) && n > 0))];
}

function parseJsonIds(s) {
  try { return parseIds(JSON.parse(s || '[]')); } catch (_) { return []; }
}

function validDate(d) {
  return /^\d{4}\/\d{2}\/\d{2}$/.test(String(d || ''));
}

/** Revaluation difference account: settings coa_inventory_revaluation (if a valid COA) else COGS. */
function revaluationCounterAccount(db) {
  const { acct } = require('../coa-map');
  try {
    const r = db.prepare("SELECT value FROM settings WHERE key='coa_inventory_revaluation'").get();
    const code = String(r?.value || '').trim();
    if (code) {
      const row = db.prepare('SELECT code, name FROM chart_of_accounts WHERE code=? AND COALESCE(is_active,1)=1').get(code);
      if (row) return { code: row.code, name: row.name };
    }
  } catch (_) { /* default */ }
  return acct(db, 'coa_cogs');
}

function productsInScope(db, body) {
  const ids = parseIds(body.product_ids != null ? body.product_ids : body.product_id);
  const cats = parseIds(body.category_ids != null ? body.category_ids : body.category_id);
  if (!ids.length && !cats.length) return null;
  const where = [];
  const params = [];
  if (ids.length) { where.push(`id IN (${ids.map(() => '?').join(',')})`); params.push(...ids); }
  if (cats.length) { where.push(`category_id IN (${cats.map(() => '?').join(',')})`); params.push(...cats); }
  return db.prepare(`SELECT * FROM products WHERE ${where.join(' OR ')} ORDER BY id`).all(...params);
}

/** v522: last purchase of the same pool (warehouse pool → that warehouse; shared → shared warehouses). */
function lastPurchaseUnit(db, productId, warehouseId = null) {
  return V.lastPurchaseUnitForPool(db, productId, warehouseId || null);
}

/**
 * On-hand keys to revalue per pool: pure shared → header (key 0); separate → buckets;
 * mixed → key 0 = shared pool aggregate + one key per separate-warehouse bucket.
 */
function onHandKeys(db, product, level, warehouseIds) {
  const pools = V.productPools(db, product.id);
  const mode = pools.mode;
  void level;
  if (mode === 'product') {
    const q = Number(product.stock) || 0;
    if (q <= 1e-9) return [];
    if (warehouseIds.length && !warehouseIds.some((w) => pools.shared.has(w))) return [];
    return [{ warehouse_id: 0, pool: 'shared', qty: q, avg: Math.round(Number(product.average_cost_rial) || 0) }];
  }
  const wip = new Set();
  try {
    for (const w of db.prepare("SELECT id FROM warehouses WHERE kind='wip' OR warehouse_type='wip'").all()) wip.add(Number(w.id));
  } catch (_) { /* old schema */ }
  const out = [];
  if (mode === 'mixed' && (!warehouseIds.length || warehouseIds.some((w) => pools.shared.has(w)))) {
    const st = V.sharedPoolState(db, product.id, pools);
    if (st.qty > 1e-9) {
      const firstShared = [...pools.shared].find((k) => k && !wip.has(k)) || null;
      out.push({ warehouse_id: 0, pool: 'shared', qty: st.qty, avg: st.avg_rial, purchase_wh: firstShared });
    }
  }
  for (const b of db.prepare('SELECT * FROM inventory_valuation_buckets WHERE product_id=? AND qty>0 ORDER BY warehouse_id').all(product.id)) {
    const k = Number(b.warehouse_id) || 0;
    if (mode === 'mixed' && !pools.separate.has(k)) continue;
    if (warehouseIds.length ? !warehouseIds.includes(k) : wip.has(k)) continue;
    out.push({ warehouse_id: k, pool: 'warehouse', qty: Number(b.qty) || 0, avg: Math.round(Number(b.avg_rial) || 0), purchase_wh: k || null });
  }
  return out;
}

function newUnitFor(db, basis, product, oldUnit, body, date, key) {
  if (basis === 'manual_unit') return Math.round(Number(body.unit_cost_rial) || 0);
  if (basis === 'percent') return Math.max(0, Math.round(oldUnit * (1 + (Number(body.percent) || 0) / 100)));
  if (basis === 'last_purchase') return lastPurchaseUnit(db, product.id, key ? key.purchase_wh : null);
  if (basis === 'std_rollup') {
    const { computeNewUnitCost } = require('../production/cost-revaluation');
    return Math.round(Number(computeNewUnitCost(db, product, String(date).slice(0, 7)).unit_cost_rial) || 0);
  }
  return oldUnit;
}

function pushJe(map, acc, signedDebitRial, description) {
  const amt = Math.round(Number(signedDebitRial) || 0);
  if (!amt) return;
  const cur = map.get(acc.code) || { code: acc.code, name: acc.name, net: 0, description };
  cur.net += amt;
  map.set(acc.code, cur);
}

function finalizeJe(map) {
  return [...map.values()]
    .filter((l) => l.net)
    .map((l) => ({
      code: l.code, name: l.name,
      debit_rial: l.net > 0 ? l.net : 0,
      credit_rial: l.net < 0 ? -l.net : 0,
      description: l.description,
    }));
}

/**
 * Preview (no writes). body: {mode, basis, product_ids?, warehouse_ids?, category_id(s)?,
 * date?, date_from?, unit_cost_rial?, percent?, note?}
 */
function preview(db, body = {}) {
  V.ready(db);
  const { inventoryAccountForWarehouse } = require('./ledger');
  const mode = body.mode === 'auto' ? 'auto' : 'manual';
  const basis = String(body.basis || 'replay');
  if (!BASES.has(basis)) throw revErr('E_BASIS', 400, 'مبنای تجدید ارزیابی نامعتبر است');
  let date = String(body.date || todayJalali()).trim();
  if (!validDate(date)) throw revErr('E_DATE', 400, 'تاریخ باید به صورت ۱۴۰۵/۰۷/۰۱ باشد');
  // v522 monthly lock: manual docs inside a closed month are rejected; auto/replay move forward.
  const PL = require('./period-lock');
  if (PL.isPeriodLocked(db, date)) {
    if (mode === 'auto') date = PL.firstOpenDate(db, date);
    else PL.assertPeriodOpen(db, date, 'سند تجدید ارزیابی');
  }
  const dateFrom = String(body.date_from || '').trim();
  if (dateFrom && !validDate(dateFrom)) throw revErr('E_DATE', 400, 'تاریخ شروع باید به صورت ۱۴۰۵/۰۷/۰۱ باشد');
  const level = V.getLevel(db);
  const warehouseIds = parseIds(body.warehouse_ids != null ? body.warehouse_ids : body.warehouse_id);
  const reval = revaluationCounterAccount(db);
  const je = new Map();
  const lines = [];
  const queueIds = new Set();
  const noopQueueIds = new Set();

  if (basis === 'replay') {
    let products = productsInScope(db, body);
    if (!products) {
      const pids = db.prepare(`
        SELECT DISTINCT product_id FROM inventory_valuation_queue WHERE status='pending' ORDER BY product_id
      `).all().map((r) => r.product_id);
      products = pids.length
        ? db.prepare(`SELECT * FROM products WHERE id IN (${pids.map(() => '?').join(',')})`).all(...pids)
        : [];
    }
    for (const p of products) {
      const pending = db.prepare(`
        SELECT id, warehouse_id, from_date FROM inventory_valuation_queue
        WHERE product_id=? AND status='pending'
      `).all(p.id).filter((q) => level === 'product' || !warehouseIds.length || warehouseIds.includes(Number(q.warehouse_id)));
      let from = dateFrom;
      if (!from && pending.length) {
        const fds = pending.map((q) => String(q.from_date || '')).filter(Boolean).sort();
        from = pending.some((q) => !q.from_date) ? '' : (fds[0] || '');
      }
      const pmode = V.productPools(db, p.id).mode;
      const r = V.previewReplay(db, {
        productId: p.id,
        warehouseId: pmode !== 'product' && warehouseIds.length === 1 ? warehouseIds[0] : null,
        fromDate: from,
      });
      if (r.skipped) continue;
      const linesBefore = lines.length;
      for (const k of r.keys) {
        if (pmode === 'warehouse' && warehouseIds.length && !warehouseIds.includes(k.warehouse_id)) continue;
        const own = r.lines.filter((l) => l.bucket_key === k.warehouse_id);
        const transferIn = pmode !== 'product'
          ? r.lines.filter((l) => l.event_type === 'transfer_out' && l.counter_pool_key === k.warehouse_id)
          : [];
        let invDelta = 0;
        let counterDelta = 0;
        for (const a of own) {
          const inv = { code: a.inventory_code, name: a.inventory_name };
          const ctr = { code: a.counter_code, name: a.counter_name };
          pushJe(je, ctr, a.delta_rial, 'تجدید ارزیابی — اصلاح بهای خروجی');
          pushJe(je, inv, -a.delta_rial, 'تجدید ارزیابی — اصلاح بهای خروجی');
          invDelta -= a.delta_rial;
          if (a.event_type !== 'transfer_out') counterDelta += a.delta_rial;
        }
        for (const a of transferIn) invDelta += a.delta_rial;
        if (!own.length && !transferIn.length && !k.onhand_delta_rial) continue;
        lines.push({
          product_id: p.id, product_code: p.code, product_name: p.name,
          warehouse_id: k.warehouse_id,
          qty_on_hand: k.qty_on_hand,
          old_unit_rial: k.old_unit_rial,
          new_unit_rial: k.new_unit_rial,
          header_delta_rial: k.onhand_delta_rial,
          delta_inventory_rial: invDelta,
          delta_cogs_rial: counterDelta,
          from_date: from,
          adjusts: own.map((a) => ({
            ledger_id: a.ledger_id, tx_no: a.tx_no, date: a.date, event_type: a.event_type, kind: a.kind,
            qty_out: a.qty_out, old_amount_rial: a.old_amount_rial, new_amount_rial: a.new_amount_rial,
            delta_rial: a.delta_rial, counter_code: a.counter_code, counter_name: a.counter_name,
          })),
        });
        for (const q of pending) {
          if (pmode === 'product' || Number(q.warehouse_id) === k.warehouse_id
            || (k.warehouse_id === 0 && pmode === 'mixed')) queueIds.add(q.id);
        }
      }
      if (lines.length === linesBefore) for (const q of pending) noopQueueIds.add(q.id);
    }
  } else {
    const products = productsInScope(db, body);
    if (!products || !products.length) {
      throw revErr('E_SCOPE_REQUIRED', 400, 'حداقل یک کالا یا گروه کالا برای تجدید ارزیابی انتخاب کنید');
    }
    if (basis === 'manual_unit') {
      const u = Number(body.unit_cost_rial);
      if (!(u >= 0) || body.unit_cost_rial == null || body.unit_cost_rial === '') {
        throw revErr('E_UNIT_REQUIRED', 400, 'بهای واحد جدید (ریال) الزامی است');
      }
    }
    if (basis === 'percent' && !Number(body.percent)) {
      throw revErr('E_PERCENT_REQUIRED', 400, 'درصد تعدیل الزامی است');
    }
    for (const p of products) {
      for (const k of onHandKeys(db, p, level, warehouseIds)) {
        const newUnit = newUnitFor(db, basis, p, k.avg, body, date, k);
        if (basis !== 'manual_unit' && !(newUnit > 0)) continue;
        const delta = Math.round((newUnit - k.avg) * k.qty);
        if (!delta) continue;
        const inv = inventoryAccountForWarehouse(db, k.warehouse_id || p.warehouse_id || null);
        pushJe(je, inv, delta, 'تجدید ارزیابی موجودی');
        pushJe(je, reval, -delta, 'تجدید ارزیابی موجودی');
        lines.push({
          product_id: p.id, product_code: p.code, product_name: p.name,
          warehouse_id: k.warehouse_id,
          qty_on_hand: k.qty,
          old_unit_rial: k.avg,
          new_unit_rial: newUnit,
          header_delta_rial: delta,
          delta_inventory_rial: delta,
          delta_cogs_rial: 0,
          adjusts: [],
        });
      }
    }
    for (const q of parseIds(body.queue_ids)) queueIds.add(q);
  }

  const jeLines = finalizeJe(je);
  const deltaInv = lines.reduce((s, l) => s + l.delta_inventory_rial, 0);
  const hashSrc = JSON.stringify({
    basis, date, level,
    lines: lines.map((l) => [l.product_id, l.warehouse_id, l.header_delta_rial, l.delta_inventory_rial,
      l.adjusts.map((a) => [a.ledger_id, a.kind, a.delta_rial])]),
  });
  return {
    mode, basis, level, date, date_from: dateFrom,
    scope: {
      product_ids: parseIds(body.product_ids != null ? body.product_ids : body.product_id),
      category_ids: parseIds(body.category_ids != null ? body.category_ids : body.category_id),
      warehouse_ids: warehouseIds,
      unit_cost_rial: body.unit_cost_rial != null ? Math.round(Number(body.unit_cost_rial) || 0) : null,
      percent: body.percent != null ? Number(body.percent) : null,
    },
    counter_account: reval,
    line_count: lines.length,
    delta_inventory_rial: deltaInv,
    delta_counter_rial: -deltaInv,
    je_lines: jeLines,
    lines,
    queue_ids: [...queueIds],
    noop_queue_ids: [...noopQueueIds].filter((q) => !queueIds.has(q)),
    hash: crypto.createHash('sha256').update(hashSrc).digest('hex'),
  };
}

/** Queue rows whose replay changed nothing are closed without a document (run_id stays NULL). */
function closeNoopQueue(db, ids) {
  if (!ids || !ids.length) return 0;
  return db.prepare(`
    UPDATE inventory_valuation_queue SET status='done'
    WHERE status='pending' AND id IN (${ids.map(() => '?').join(',')})
  `).run(...ids).changes;
}

function post(db, body = {}, user) {
  V.ready(db);
  const userId = user?.id || null;
  const note = String(body.note || '').slice(0, 400);
  const { postToLedger } = require('../ledger');

  const id = db.transaction(() => {
    const pv = preview(db, body);
    if (body.preview_hash && body.preview_hash !== pv.hash) {
      throw revErr('E_PREVIEW_STALE', 409, 'پیش‌نمایش منقضی شده است؛ دوباره پیش‌نمایش بگیرید', { hash: pv.hash });
    }
    if (!pv.lines.length) throw revErr('E_NO_LINES', 400, 'ردیفی برای تجدید ارزیابی یافت نشد');
    const dup = db.prepare(
      "SELECT id, doc_no FROM inventory_revaluations WHERE preview_hash=? AND status='posted' LIMIT 1"
    ).get(pv.hash);
    if (dup) {
      throw revErr('E_DUPLICATE_REVALUATION', 409, `همین تجدید ارزیابی قبلاً با سند ${dup.doc_no || dup.id} ثبت شده است`, { revaluation_id: dup.id });
    }
    let docNo;
    try {
      docNo = require('../../db').allocateNumber(db, 'inventory_reval', 'IRV');
    } catch (_) {
      docNo = 'IRV-' + Date.now().toString(36).toUpperCase();
    }
    const head = db.prepare(`
      INSERT INTO inventory_revaluations
        (doc_no, mode, basis, rule_id, date, date_from, scope_json, status, line_count,
         delta_inventory_rial, delta_counter_rial, preview_hash, note, created_by)
      VALUES (?,?,?,?,?,?,?,'posted',?,?,?,?,?,?)
    `).run(
      docNo, pv.mode, pv.basis, body.rule_id ? Number(body.rule_id) : null, pv.date, pv.date_from || '',
      JSON.stringify(pv.scope), pv.lines.length, pv.delta_inventory_rial, pv.delta_counter_rial,
      pv.hash, note, userId
    );
    const revId = head.lastInsertRowid;
    const insLine = db.prepare(`
      INSERT INTO inventory_revaluation_lines
        (revaluation_id, product_id, warehouse_id, qty_on_hand, old_unit_rial, new_unit_rial,
         delta_inventory_rial, delta_cogs_rial, ledger_ids_json, adjusts_json, note)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `);
    const insAdj = db.prepare(`
      INSERT INTO inventory_revaluation_adjustments
        (revaluation_id, line_id, ledger_id, kind, delta_rial, counter_code, status)
      VALUES (?,?,?,?,?,?,'posted')
    `);
    const valueLedgerIds = [];
    for (const L of pv.lines) {
      const ledgerIds = [];
      if (L.header_delta_rial) {
        const res = V.postValueAdjustment(db, {
          productId: L.product_id,
          warehouseId: L.warehouse_id || null,
          deltaRial: L.header_delta_rial,
          date: pv.date,
          sourceType: pv.basis === 'replay' ? SRC_REPLAY : SRC_MANUAL,
          sourceId: revId,
          note: `تجدید ارزیابی ${docNo}${note ? ' — ' + note : ''}`,
          createdBy: userId,
          eventType: 'cost_adjustment',
        });
        if (res.ledger_id) { ledgerIds.push(res.ledger_id); valueLedgerIds.push(res.ledger_id); }
      }
      const lineId = insLine.run(
        revId, L.product_id, L.warehouse_id || 0, L.qty_on_hand, L.old_unit_rial, L.new_unit_rial,
        L.delta_inventory_rial, L.delta_cogs_rial, JSON.stringify(ledgerIds), JSON.stringify(L.adjusts || []),
        L.from_date ? `from ${L.from_date}` : ''
      ).lastInsertRowid;
      for (const a of (L.adjusts || [])) {
        insAdj.run(revId, lineId, a.ledger_id, a.kind || 'outbound', a.delta_rial, a.counter_code || null);
      }
    }

    let jeId = null;
    if (pv.je_lines.length) {
      jeId = postToLedger(db, {
        sourceType: 'inventory_revaluation',
        sourceId: revId,
        date: pv.date,
        description: `تجدید ارزیابی موجودی ${docNo} (${pv.basis})${note ? ' — ' + note : ''}`,
        createdBy: userId,
        lines: pv.je_lines.map((l) => ({
          code: l.code, name: l.name,
          debit: l.debit_rial / 10, credit: l.credit_rial / 10,
          description: l.description,
        })),
      });
      db.prepare('UPDATE inventory_revaluations SET je_id=? WHERE id=?').run(jeId, revId);
      if (valueLedgerIds.length) {
        db.prepare(`UPDATE inventory_ledger SET je_id=? WHERE id IN (${valueLedgerIds.map(() => '?').join(',')})`)
          .run(jeId, ...valueLedgerIds);
      }
    }
    if (pv.queue_ids.length) {
      db.prepare(`
        UPDATE inventory_valuation_queue SET status='done', run_id=?
        WHERE status='pending' AND id IN (${pv.queue_ids.map(() => '?').join(',')})
      `).run(revId, ...pv.queue_ids);
    }
    closeNoopQueue(db, pv.noop_queue_ids);
    return revId;
  })();
  return get(db, id);
}

function reverse(db, revaluationId, user, { reason } = {}) {
  V.ready(db);
  const id = Number(revaluationId);
  const head = db.prepare('SELECT * FROM inventory_revaluations WHERE id=?').get(id);
  if (!head) throw revErr('E_NOT_FOUND', 404, 'سند تجدید ارزیابی یافت نشد');
  if (head.status === 'reversed') throw revErr('E_ALREADY_REVERSED', 409, 'این سند قبلاً ابطال شده است');
  if (head.status !== 'posted') throw revErr('E_NOT_POSTED', 409, 'فقط سند ثبت‌شده قابل ابطال است');
  const { reverseInventoryMovement } = require('./ledger');
  const { reverseJournalEntry } = require('../void-journal');
  const why = String(reason || '').slice(0, 200) || `ابطال تجدید ارزیابی ${head.doc_no || id}`;
  db.transaction(() => {
    const rows = db.prepare(`
      SELECT id FROM inventory_ledger
      WHERE source_type IN (?, ?) AND source_id=? AND status='posted'
        AND COALESCE(qty_in,0)=0 AND COALESCE(qty_out,0)=0
      ORDER BY id DESC
    `).all(SRC_MANUAL, SRC_REPLAY, id);
    for (const r of rows) {
      reverseInventoryMovement(db, r.id, { createdBy: user?.id || null, note: why });
    }
    db.prepare("UPDATE inventory_revaluation_adjustments SET status='reversed' WHERE revaluation_id=?").run(id);
    let revJe = null;
    if (head.je_id) {
      revJe = reverseJournalEntry(db, head.je_id, {
        userId: user?.id || null, reason: why, sourceType: 'inventory_revaluation',
      });
    }
    db.prepare(`
      UPDATE inventory_revaluations
      SET status='reversed', reversed_je_id=?, reversed_at=strftime('%s','now'), reversed_by=?
      WHERE id=?
    `).run(revJe || null, user?.id || null, id);
    db.prepare("UPDATE inventory_valuation_queue SET status='pending', run_id=NULL WHERE run_id=?").run(id);
  })();
  return get(db, id);
}

function list(db, { limit = 50, status } = {}) {
  V.ready(db);
  const lim = Math.min(500, Math.max(1, Number(limit) || 50));
  const where = status ? 'WHERE r.status=?' : '';
  const params = status ? [status, lim] : [lim];
  return db.prepare(`
    SELECT r.*, u.name AS created_by_name, rl.name AS rule_name
    FROM inventory_revaluations r
    LEFT JOIN users u ON u.id=r.created_by
    LEFT JOIN inventory_revaluation_rules rl ON rl.id=r.rule_id
    ${where}
    ORDER BY r.id DESC LIMIT ?
  `).all(...params);
}

function get(db, id) {
  V.ready(db);
  const head = db.prepare(`
    SELECT r.*, rl.name AS rule_name FROM inventory_revaluations r
    LEFT JOIN inventory_revaluation_rules rl ON rl.id=r.rule_id
    WHERE r.id=?
  `).get(Number(id));
  if (!head) throw revErr('E_NOT_FOUND', 404, 'سند تجدید ارزیابی یافت نشد');
  const lines = db.prepare(`
    SELECT l.*, p.code AS product_code, p.name AS product_name, w.name AS warehouse_name
    FROM inventory_revaluation_lines l
    LEFT JOIN products p ON p.id=l.product_id
    LEFT JOIN warehouses w ON w.id=l.warehouse_id
    WHERE l.revaluation_id=? ORDER BY l.id
  `).all(head.id).map((l) => ({
    ...l,
    ledger_ids: (() => { try { return JSON.parse(l.ledger_ids_json || '[]'); } catch (_) { return []; } })(),
    adjusts: (() => { try { return JSON.parse(l.adjusts_json || '[]'); } catch (_) { return []; } })(),
  }));
  let scope = null;
  try { scope = JSON.parse(head.scope_json || 'null'); } catch (_) { scope = null; }
  return { ...head, scope, lines };
}

/* ───────────────────────────── rules ───────────────────────────── */

function normalizeRule(body, existing = {}) {
  const pick = (k, d) => (body[k] !== undefined ? body[k] : (existing[k] !== undefined ? existing[k] : d));
  const name = String(pick('name', '')).trim();
  if (!name) throw revErr('E_RULE_NAME', 400, 'نام قاعده الزامی است');
  let triggers = body.triggers !== undefined ? body.triggers : (() => {
    try { return JSON.parse(existing.triggers_json || '[]'); } catch (_) { return []; }
  })();
  if (!Array.isArray(triggers)) triggers = String(triggers || '').split(',');
  triggers = [...new Set(triggers.map((t) => String(t).trim()).filter(Boolean))];
  if (triggers.some((t) => !RULE_TRIGGERS.has(t))) throw revErr('E_RULE_TRIGGER', 400, 'رویداد قاعده نامعتبر است');
  if (!triggers.length) throw revErr('E_RULE_TRIGGER', 400, 'حداقل یک رویداد برای قاعده انتخاب کنید');
  const basis = String(pick('basis', 'replay'));
  if (!RULE_BASES.has(basis)) throw revErr('E_RULE_BASIS', 400, 'مبنای قاعده نامعتبر است');
  const action = String(pick('action', 'review'));
  if (!['auto_post', 'review'].includes(action)) throw revErr('E_RULE_ACTION', 400, 'اقدام قاعده باید auto_post یا review باشد');
  let scheduleObj;
  if (body.schedule_json !== undefined) scheduleObj = normalizeSchedule(body.schedule_json);
  else if (body.schedule !== undefined) scheduleObj = normalizeSchedule(body.schedule);
  else scheduleObj = normalizeSchedule(existing.schedule_json || null, existing.schedule || 'none');
  const schedule = scheduleObj.mode;
  if (!(schedule in RULE_SCHEDULES)) throw revErr('E_RULE_SCHEDULE', 400, 'زمان‌بندی قاعده نامعتبر است');
  const idsJson = (k, jsonKey) => JSON.stringify(body[k] !== undefined ? parseIds(body[k]) : parseJsonIds(existing[jsonKey]));
  const thresholdRial = Math.max(0, Math.round(Number(pick('threshold_rial', 0)) || 0));
  const thresholdPct = Math.max(0, Number(pick('threshold_pct', 0)) || 0);
  const percent = pick('percent', null);
  if (basis === 'percent' && !Number(percent)) throw revErr('E_PERCENT_REQUIRED', 400, 'درصد تعدیل برای مبنای درصدی الزامی است');
  if (basis !== 'replay' && !triggers.includes('schedule')) {
    throw revErr('E_RULE_TRIGGER', 400, 'مبنای غیر بازپخش فقط با رویداد زمان‌بندی (schedule) اجرا می‌شود');
  }
  const enabledRaw = pick('enabled', 1);
  return {
    name: name.slice(0, 120),
    enabled: enabledRaw === false || enabledRaw === 0 || enabledRaw === '0' ? 0 : 1,
    triggers_json: JSON.stringify(triggers),
    basis,
    warehouse_ids_json: idsJson('warehouse_ids', 'warehouse_ids_json'),
    category_ids_json: idsJson('category_ids', 'category_ids_json'),
    product_ids_json: idsJson('product_ids', 'product_ids_json'),
    threshold_rial: thresholdRial,
    threshold_pct: thresholdPct,
    percent: percent == null || percent === '' ? null : Number(percent),
    action,
    schedule,
    schedule_json: JSON.stringify(scheduleObj),
  };
}

function ruleOut(r) {
  if (!r) return r;
  const j = (s) => { try { return JSON.parse(s || '[]'); } catch (_) { return []; } };
  return {
    ...r,
    enabled: !!r.enabled,
    triggers: j(r.triggers_json),
    warehouse_ids: j(r.warehouse_ids_json),
    category_ids: j(r.category_ids_json),
    product_ids: j(r.product_ids_json),
    schedule_obj: (() => {
      try { return normalizeSchedule(r.schedule_json || null, r.schedule || 'none'); } catch (_) { return legacySchedule(r.schedule); }
    })(),
  };
}

function listRules(db) {
  V.ready(db);
  return db.prepare('SELECT * FROM inventory_revaluation_rules ORDER BY id').all().map(ruleOut);
}

function getRule(db, id) {
  V.ready(db);
  const r = db.prepare('SELECT * FROM inventory_revaluation_rules WHERE id=?').get(Number(id));
  if (!r) throw revErr('E_RULE_NOT_FOUND', 404, 'قاعده یافت نشد');
  return ruleOut(r);
}

function createRule(db, body = {}, user) {
  V.ready(db);
  const r = normalizeRule(body);
  const id = db.prepare(`
    INSERT INTO inventory_revaluation_rules
      (name, enabled, triggers_json, basis, warehouse_ids_json, category_ids_json, product_ids_json,
       threshold_rial, threshold_pct, percent, action, schedule, schedule_json, created_by, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,strftime('%s','now'))
  `).run(
    r.name, r.enabled, r.triggers_json, r.basis, r.warehouse_ids_json, r.category_ids_json, r.product_ids_json,
    r.threshold_rial, r.threshold_pct, r.percent, r.action, r.schedule, r.schedule_json, user?.id || null
  ).lastInsertRowid;
  return getRule(db, id);
}

function updateRule(db, id, body = {}) {
  V.ready(db);
  const existing = db.prepare('SELECT * FROM inventory_revaluation_rules WHERE id=?').get(Number(id));
  if (!existing) throw revErr('E_RULE_NOT_FOUND', 404, 'قاعده یافت نشد');
  const r = normalizeRule(body, existing);
  db.prepare(`
    UPDATE inventory_revaluation_rules SET
      name=?, enabled=?, triggers_json=?, basis=?, warehouse_ids_json=?, category_ids_json=?, product_ids_json=?,
      threshold_rial=?, threshold_pct=?, percent=?, action=?, schedule=?, schedule_json=?, updated_at=strftime('%s','now')
    WHERE id=?
  `).run(
    r.name, r.enabled, r.triggers_json, r.basis, r.warehouse_ids_json, r.category_ids_json, r.product_ids_json,
    r.threshold_rial, r.threshold_pct, r.percent, r.action, r.schedule, r.schedule_json, existing.id
  );
  return getRule(db, existing.id);
}

function toggleRule(db, id, enabled) {
  V.ready(db);
  const existing = db.prepare('SELECT * FROM inventory_revaluation_rules WHERE id=?').get(Number(id));
  if (!existing) throw revErr('E_RULE_NOT_FOUND', 404, 'قاعده یافت نشد');
  const next = enabled == null ? (existing.enabled ? 0 : 1) : (enabled ? 1 : 0);
  db.prepare("UPDATE inventory_revaluation_rules SET enabled=?, updated_at=strftime('%s','now') WHERE id=?").run(next, existing.id);
  return getRule(db, existing.id);
}

const AUTO_SEMANTICS = {
  auto_post: 'همیشه ثبت خودکار (هر مبلغی)',
  review: 'زیر آستانه → ثبت خودکار؛ هم‌اندازه یا بالای آستانه → در انتظار بازبینی (صف باز می‌ماند)',
  no_threshold: 'برای قاعدهٔ review بدون آستانه، همه موارد بازبینی می‌شوند',
  magnitude: 'مبلغ = مجموع بدهکار سند پیش‌نمایش؛ درصد = مبلغ ÷ ارزش موجودی فعلی ردیف‌ها',
};

function ruleBody(db, rule) {
  const triggers = rule.triggers;
  const productIds = rule.product_ids;
  const categoryIds = rule.category_ids;
  const warehouseIds = rule.warehouse_ids;
  const base = {
    mode: 'auto', basis: rule.basis, date: todayJalali(), rule_id: rule.id,
    warehouse_ids: warehouseIds, note: `قاعده خودکار «${rule.name}»`,
  };
  if (rule.basis === 'replay') {
    const reasons = triggers.filter((t) => t !== 'schedule');
    if (!reasons.length) return null;
    let sql = `SELECT DISTINCT q.product_id FROM inventory_valuation_queue q
      LEFT JOIN products p ON p.id=q.product_id
      WHERE q.status='pending' AND q.reason IN (${reasons.map(() => '?').join(',')})`;
    const params = [...reasons];
    if (productIds.length) { sql += ` AND q.product_id IN (${productIds.map(() => '?').join(',')})`; params.push(...productIds); }
    if (categoryIds.length) { sql += ` AND p.category_id IN (${categoryIds.map(() => '?').join(',')})`; params.push(...categoryIds); }
    if (warehouseIds.length) {
      sql += ` AND (q.warehouse_id=0 OR q.warehouse_id IN (${warehouseIds.map(() => '?').join(',')}))`;
      params.push(...warehouseIds);
    }
    const pids = db.prepare(sql).all(...params).map((r) => r.product_id);
    if (!pids.length) return null;
    return { ...base, product_ids: pids };
  }
  if (!productIds.length && !categoryIds.length) return null;
  return { ...base, product_ids: productIds, category_ids: categoryIds, percent: rule.percent };
}

function magnitudeOf(pv) {
  const mag = pv.je_lines.reduce((s, l) => s + l.debit_rial, 0);
  const base = pv.lines.reduce((s, l) => s + Math.abs(Math.round((Number(l.qty_on_hand) || 0) * (Number(l.old_unit_rial) || 0))), 0);
  return { magnitude_rial: mag, base_value_rial: base, pct: base > 0 ? (mag / base) * 100 : (mag ? 100 : 0) };
}

function systemUser(db) {
  const id = db.prepare("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1").get()?.id
    || db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get()?.id || null;
  return { id, role: 'admin', name: 'system' };
}

function runAutoRules(db, { dryRun = true, ruleId = null, user = null, onlyDue = null } = {}) {
  V.ready(db);
  const rules = ruleId
    ? [getRule(db, ruleId)]
    : listRules(db).filter((r) => r.enabled);
  const actor = user || systemUser(db);
  const runs = [];
  for (const rule of rules) {
    if (onlyDue && !onlyDue(rule)) continue;
    const run = { rule_id: rule.id, name: rule.name, action: rule.action, basis: rule.basis };
    if (!rule.enabled && !dryRun) { runs.push({ ...run, decision: 'disabled' }); continue; }
    try {
      const body = ruleBody(db, rule);
      if (!body) { runs.push({ ...run, decision: 'nothing' }); }
      else {
        const pv = preview(db, body);
        if (!pv.lines.length) {
          if (!dryRun) closeNoopQueue(db, pv.noop_queue_ids);
          runs.push({ ...run, decision: 'nothing', closed_queue_ids: dryRun ? [] : pv.noop_queue_ids });
        } else {
          const m = magnitudeOf(pv);
          const hasThreshold = rule.threshold_rial > 0 || rule.threshold_pct > 0;
          const exceeds = !hasThreshold
            || (rule.threshold_rial > 0 && m.magnitude_rial >= rule.threshold_rial)
            || (rule.threshold_pct > 0 && m.pct >= rule.threshold_pct);
          const shouldPost = rule.action === 'auto_post' || !exceeds;
          const summary = {
            line_count: pv.line_count, delta_inventory_rial: pv.delta_inventory_rial,
            magnitude_rial: m.magnitude_rial, pct: Math.round(m.pct * 100) / 100,
            exceeds_threshold: exceeds, product_ids: body.product_ids || [], hash: pv.hash,
          };
          if (!shouldPost) runs.push({ ...run, decision: 'needs_review', preview: summary });
          else if (dryRun) runs.push({ ...run, decision: 'would_post', preview: summary });
          else {
            try {
              const posted = post(db, { ...body, preview_hash: pv.hash }, actor);
              runs.push({ ...run, decision: 'posted', revaluation_id: posted.id, doc_no: posted.doc_no, preview: summary });
            } catch (e) {
              runs.push({ ...run, decision: e.code === 'E_DUPLICATE_REVALUATION' ? 'duplicate' : 'error', error: e.message, code: e.code });
            }
          }
        }
      }
    } catch (e) {
      runs.push({ ...run, decision: 'error', error: e.message, code: e.code });
    }
    if (!dryRun) {
      db.prepare("UPDATE inventory_revaluation_rules SET last_run_at=strftime('%s','now') WHERE id=?").run(rule.id);
    }
  }
  return { dry_run: !!dryRun, semantics: AUTO_SEMANTICS, runs };
}

/**
 * Scheduler hook (central only). Due = daily/weekly/monthly since last_run_at.
 * Event-trigger rules with schedule 'none' run on every tick when matching queue rows exist.
 */
function maybeRunScheduledRules(db, { nowSec, now: nowDate } = {}) {
  if (process.env.SYNC_ROLE === 'device') return { skipped: 'device' };
  if (!V.ready(db)) return { skipped: 'no_schema' };
  const now = nowDate instanceof Date ? nowDate : new Date((Number(nowSec) || Math.floor(Date.now() / 1000)) * 1000);
  const slots = new Map();
  const due = (rule) => {
    const sch = rule.schedule_obj || legacySchedule(rule.schedule);
    if (sch.mode === 'none') return rule.basis === 'replay' && rule.triggers.some((t) => t !== 'schedule');
    const slot = slotFor(sch, now);
    if (!slot || slot === rule.last_run_slot) return false;
    slots.set(rule.id, slot);
    return true;
  };
  const out = runAutoRules(db, { dryRun: false, onlyDue: due });
  const up = db.prepare('UPDATE inventory_revaluation_rules SET last_run_slot=? WHERE id=?');
  for (const [id, slot] of slots) up.run(slot, id);
  return { ...out, slots: Object.fromEntries(slots) };
}

module.exports = {
  preview,
  post,
  reverse,
  list,
  get,
  listRules,
  getRule,
  createRule,
  updateRule,
  toggleRule,
  runAutoRules,
  maybeRunScheduledRules,
  normalizeSchedule,
  slotFor,
  migrateRuleSchedulesV522,
  revaluationCounterAccount,
  AUTO_SEMANTICS,
  BASES,
};
