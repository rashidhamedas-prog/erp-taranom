'use strict';
/**
 * v642 professional notification inbox — live cheques + events + pending actions.
 * Writes only to app_notification_user_state (never mutates source rows / resolved_at).
 */

const { todayJalaliTehran, diffJalaliDays, addJalaliDaysExact } = require('../jalali');
const { invoiceTypeLabel } = require('./sales-document');
const { canDo } = require('./rbac');

const KIND_META = {
  followup_new: {
    category: 'followup', severity: 'info',
    target: (n) => ({ kind: 'followup', id: n.entity_id, route: 'followups', inv_type: null }),
  },
  value_change_approval: {
    category: 'inventory', severity: 'warning',
    target: () => ({ kind: 'value_approval', id: null, route: 'acc-inv-valuation', inv_type: null }),
  },
  value_change_auto_cogs: {
    category: 'inventory', severity: 'info',
    target: () => ({ kind: 'route', id: null, route: 'acc-inv-valuation', inv_type: null }),
  },
  alert: {
    category: 'production', severity: 'danger',
    target: (n) => ({
      kind: 'route', id: n.entity_id,
      route: n.entity_type === 'production_health' ? 'acc-production-orders' : 'acc-production-orders',
      inv_type: null,
    }),
  },
  production_health: {
    category: 'production', severity: 'danger',
    target: () => ({ kind: 'route', id: null, route: 'acc-production-orders', inv_type: null }),
  },
  production_cost_deviation: {
    category: 'production', severity: 'warning',
    target: (n) => ({ kind: 'route', id: n.entity_id, route: 'acc-production-orders', inv_type: null }),
  },
  production_period_reopen: {
    category: 'production', severity: 'warning',
    target: (n) => ({ kind: 'route', id: n.entity_id, route: 'acc-production-close', inv_type: null }),
  },
  portal_request: {
    category: 'portal', severity: 'info',
    target: () => ({ kind: 'route', id: null, route: 'acc-portal-units', inv_type: null }),
  },
  portal_approval: {
    category: 'portal', severity: 'info',
    target: () => ({ kind: 'route', id: null, route: 'acc-portal-units', inv_type: null }),
  },
  app_update: {
    category: 'system', severity: 'info',
    target: () => ({ kind: 'app_update', id: null, route: null, inv_type: null }),
  },
};

function roleSees(n, role) {
  if (n.kind === 'app_update') return true;
  try {
    const roles = JSON.parse(n.target_roles || '[]');
    return roles.includes(role) || roles.includes('*');
  } catch {
    return false;
  }
}

function canSeeCheques(user, db) {
  const role = user && user.role;
  if (role === 'admin' || role === 'accounting') return true;
  try {
    return !!canDo(user, 'acc-cheque-register', 'view', db);
  } catch {
    return false;
  }
}

function loadUserState(db, userId) {
  const rows = db.prepare(`
    SELECT item_key, read_at, dismissed_at
    FROM app_notification_user_state WHERE user_id=?
  `).all(userId);
  const map = new Map();
  for (const r of rows) map.set(r.item_key, r);
  return map;
}

function attachState(item, stateMap) {
  const st = stateMap.get(item.key);
  item.read = !!(st && st.read_at);
  item.dismissed = !!(st && st.dismissed_at);
  return item;
}

function faNum(n) {
  return Number(n || 0).toLocaleString('fa-IR');
}

function chequeTitle(direction, days) {
  const dirLabel = direction === 'out' ? 'چک پرداختی' : 'چک دریافتی';
  let when;
  if (days < 0) when = `${Math.abs(days)} روز از سررسید گذشته`;
  else if (days === 0) when = 'سررسید امروز';
  else if (days === 1) when = 'فردا';
  else when = `${days} روز دیگر`;
  return `${dirLabel} — ${when}`;
}

function buildChequeItems(db, user, today, stateMap) {
  if (!canSeeCheques(user, db)) return [];
  const until = addJalaliDaysExact(today, 7);
  if (!until) return [];
  const rows = db.prepare(`
    SELECT id, direction, cheque_number, due_date, amount, party_name, lifecycle_status
    FROM cheque_records
    WHERE COALESCE(record_status,'posted') NOT IN ('void','reversed')
      AND TRIM(COALESCE(lifecycle_status,'')) IN ('','registered','in_hand','pending','in_collection')
      AND TRIM(COALESCE(due_date,'')) <> '' AND due_date <= ?
    ORDER BY due_date, id
  `).all(until);

  const items = [];
  for (const r of rows) {
    const days = diffJalaliDays(r.due_date, today);
    if (days == null || days > 7) continue;
    let bucket; let severity;
    if (days < 0) { bucket = 'overdue'; severity = 'danger'; }
    else if (days === 0) { bucket = 'today'; severity = 'warning'; }
    else { bucket = 'soon'; severity = 'info'; }
    const key = `chq:${r.id}:${r.due_date}:${bucket}`;
    items.push(attachState({
      key,
      source: 'cheque',
      kind: 'cheque_live',
      category: 'cheque',
      severity,
      title: chequeTitle(r.direction, days),
      subtitle: r.party_name || '',
      ref_label: String(r.cheque_number || ('#' + r.id)),
      amount_rial: Number(r.amount) || 0,
      due_jalali: r.due_date,
      days,
      bucket,
      direction: r.direction,
      created_at: null,
      target: { kind: 'cheque', id: r.id, route: r.direction === 'out' ? 'acc-cheques-pay' : 'acc-cheques-recv', inv_type: null },
    }, stateMap));
  }
  return items;
}

function summaryDelta(cur, prev) {
  if (!prev) return 'اولین اجرا';
  const parts = [];
  for (const k of ['warn', 'error']) {
    const a = Number(cur?.[k] || 0);
    const b = Number(prev?.[k] || 0);
    const d = a - b;
    if (d === 0) continue;
    const label = k === 'warn' ? 'هشدار' : 'خطا';
    parts.push(`${label} ${a} (${d > 0 ? '+' : ''}${d})`);
  }
  if (!parts.length) return 'بدون تغییر نسبت به اجرای قبل';
  return parts.join(' · ');
}

function buildEventItems(db, user, stateMap) {
  const role = user.role;
  const rows = db.prepare(`
    SELECT n.*,
      i.type AS inv_type, i.num AS inv_num, i.final AS inv_final, i.deleted_at AS inv_deleted,
      c.biz AS inv_biz,
      r.result_json AS recon_json, r.as_of AS recon_as_of, r.created_at AS recon_created
    FROM app_notifications n
    LEFT JOIN invoices i ON n.entity_type='invoice' AND n.entity_id=i.id
    LEFT JOIN customers c ON i.cust_id=c.id
    LEFT JOIN subledger_recon_runs r ON n.kind='subledger_recon_nightly' AND n.entity_id=r.id
    WHERE n.resolved_at IS NULL AND n.kind <> 'cheque_due'
    ORDER BY n.created_at DESC, n.id DESC
    LIMIT 400
  `).all().filter((n) => roleSees(n, role));

  const reconHistory = listRuns(db, { limit: 30 });
  let latestReconNotifId = null;
  for (const n of rows) {
    if (n.kind === 'subledger_recon_nightly') {
      if (latestReconNotifId == null) latestReconNotifId = n.id;
    }
  }

  const items = [];
  for (const n of rows) {
    if (n.kind === 'subledger_recon_nightly') {
      if (n.id !== latestReconNotifId) continue;
      let summary = {};
      try {
        const parsed = JSON.parse(n.recon_json || '{}');
        summary = parsed.summary || {};
      } catch { summary = {}; }
      let severity = 'success';
      if (Number(summary.error) > 0) severity = 'danger';
      else if (Number(summary.warn) > 0) severity = 'warning';
      const prev = reconHistory.length > 1 ? reconHistory[1].summary : null;
      const delta = summaryDelta(summary, prev);
      const failing = [];
      try {
        const parsed = JSON.parse(n.recon_json || '{}');
        for (const c of (parsed.checks || [])) {
          if (c.status === 'warn' || c.status === 'error') {
            failing.push(`${c.name || c.code}${c.sub_status === 'negative_cash' ? ' (صندوق منفی)' : ''}`);
          }
        }
      } catch { /* ignore */ }
      items.push(attachState({
        key: `n:${n.id}`,
        source: 'event',
        kind: n.kind,
        category: 'recon',
        severity,
        title: n.title || 'تطبیق شبانه',
        subtitle: `هشدار ${summary.warn || 0} · خطا ${summary.error || 0} — ${delta}`,
        ref_label: n.recon_as_of || '',
        amount_rial: null,
        due_jalali: null,
        days: null,
        bucket: null,
        direction: null,
        created_at: n.created_at,
        meta: { failing: failing.slice(0, 12), summary },
        target: { kind: 'recon_run', id: n.entity_id, route: 'acc-subledger-recon', inv_type: null },
      }, stateMap));
      continue;
    }

    if (n.kind === 'invoice_new' || n.kind === 'invoice_cancelled') {
      const type = n.inv_type;
      const num = n.inv_num;
      let title;
      let severity = n.kind === 'invoice_cancelled' ? 'warning' : 'info';
      let subtitle = n.inv_biz || '';
      let amount = n.inv_final != null ? Number(n.inv_final) : null;
      if (type && num) {
        title = `${invoiceTypeLabel(type)} جدید ${num}`;
        if (n.kind === 'invoice_cancelled') title = `${invoiceTypeLabel(type)} باطل‌شده ${num}`;
      } else {
        title = n.title || 'فاکتور';
        subtitle = n.body || subtitle;
      }
      if (n.inv_deleted) {
        severity = 'muted';
        subtitle = (subtitle ? subtitle + ' — ' : '') + 'باطل‌شده';
      }
      items.push(attachState({
        key: `n:${n.id}`,
        source: 'event',
        kind: n.kind,
        category: 'sales',
        severity,
        title,
        subtitle,
        ref_label: num || '',
        amount_rial: amount,
        due_jalali: null,
        days: null,
        bucket: null,
        direction: null,
        created_at: n.created_at,
        target: { kind: 'invoice', id: n.entity_id, route: type === 'proforma' ? 'acc-proforma' : 'acc-sales-invoices', inv_type: type || null },
      }, stateMap));
      continue;
    }

    const meta = KIND_META[n.kind] || {
      category: String(n.kind || '').startsWith('portal_') ? 'portal'
        : (n.entity_type === 'production_health' || String(n.kind || '').startsWith('production_') ? 'production' : 'system'),
      severity: 'info',
      target: () => ({ kind: 'route', id: n.entity_id, route: null, inv_type: null }),
    };
    if (String(n.kind || '').startsWith('portal_') && !KIND_META[n.kind]) {
      meta.category = 'portal';
      meta.target = () => ({ kind: 'route', id: n.entity_id, route: 'acc-portal-units', inv_type: null });
    }
    items.push(attachState({
      key: `n:${n.id}`,
      source: 'event',
      kind: n.kind,
      category: meta.category,
      severity: meta.severity,
      title: n.title || '',
      subtitle: n.body || '',
      ref_label: '',
      amount_rial: null,
      due_jalali: null,
      days: null,
      bucket: null,
      direction: null,
      created_at: n.created_at,
      target: typeof meta.target === 'function' ? meta.target(n) : meta.target,
    }, stateMap));
  }

  return { items: items.slice(0, 200), recon_history: reconHistory };
}

function buildPendingActions(db, user) {
  const role = user.role;
  const actions = [];
  if (['admin', 'accounting', 'sales_manager'].includes(role)) {
    const pendingInv = db.prepare(`
      SELECT i.id, i.num, i.date, i.final, c.biz
      FROM invoices i JOIN customers c ON i.cust_id=c.id
      WHERE i.type='final' AND COALESCE(i.approved,0)=0 AND COALESCE(i.deleted_at,0)=0
      ORDER BY i.created_at DESC LIMIT 15
    `).all();
    pendingInv.forEach((i) => actions.push({
      key: `act:invoice_approval:${i.id}`,
      source: 'action',
      kind: 'invoice_approval',
      category: 'sales',
      severity: 'warning',
      title: `تأیید فاکتور ${i.num}`,
      subtitle: i.biz || '',
      ref_label: i.num || '',
      amount_rial: Number(i.final) || 0,
      due_jalali: null,
      days: null,
      bucket: null,
      direction: null,
      created_at: null,
      read: false,
      dismissed: false,
      target: { kind: 'invoice', id: i.id, route: 'acc-final-invoices', inv_type: 'final' },
    }));
    const pendingRep = db.prepare(`
      SELECT rp.id, rp.amount, rp.date, c.biz
      FROM rep_payment_submissions rp JOIN customers c ON rp.cust_id=c.id
      WHERE rp.status='pending' ORDER BY rp.created_at DESC LIMIT 10
    `).all();
    pendingRep.forEach((p) => actions.push({
      key: `act:rep_payment:${p.id}`,
      source: 'action',
      kind: 'rep_payment',
      category: 'sales',
      severity: 'warning',
      title: 'پرداخت میدانی منتظر تأیید',
      subtitle: p.biz || '',
      ref_label: '',
      amount_rial: Number(p.amount) || 0,
      due_jalali: null,
      days: null,
      bucket: null,
      direction: null,
      created_at: null,
      read: false,
      dismissed: false,
      target: { kind: 'route', id: p.id, route: 'acc-reps', inv_type: null },
    }));
  }
  const openFups = db.prepare(`
    SELECT f.id, f.subject, f.priority, c.biz
    FROM followups f JOIN customers c ON f.cust_id=c.id
    WHERE f.status='open' AND f.priority='high'
    ORDER BY f.created_at DESC LIMIT 10
  `).all();
  openFups.forEach((f) => actions.push({
    key: `act:followup:${f.id}`,
    source: 'action',
    kind: 'followup',
    category: 'followup',
    severity: 'warning',
    title: 'پیگیری فوری',
    subtitle: `${f.biz || ''} — ${f.subject || ''}`,
    ref_label: '',
    amount_rial: null,
    due_jalali: null,
    days: null,
    bucket: null,
    direction: null,
    created_at: null,
    read: false,
    dismissed: false,
    target: { kind: 'followup', id: f.id, route: 'followups', inv_type: null },
  }));
  return actions;
}

function listRuns(db, { limit = 30 } = {}) {
  const lim = Math.min(100, Math.max(1, Number(limit) || 30));
  return db.prepare(`
    SELECT id AS run_id, as_of, created_at,
           json_extract(result_json,'$.summary') AS summary_json
    FROM subledger_recon_runs
    ORDER BY id DESC LIMIT ?
  `).all(lim).map((r) => {
    let summary = {};
    try {
      summary = typeof r.summary_json === 'string' ? JSON.parse(r.summary_json) : (r.summary_json || {});
    } catch { summary = {}; }
    return { run_id: r.run_id, as_of: r.as_of, created_at: r.created_at, summary };
  });
}

function getRun(db, id) {
  const r = db.prepare('SELECT id, as_of, result_json, created_by, created_at FROM subledger_recon_runs WHERE id=?').get(id);
  if (!r) return null;
  let parsed = {};
  try { parsed = JSON.parse(r.result_json || '{}'); } catch { parsed = {}; }
  return { ...parsed, run_id: r.id, created_by: r.created_by, created_at: r.created_at, as_of: r.as_of || parsed.as_of };
}

function buildInbox(db, user, { now = new Date() } = {}) {
  const today = todayJalaliTehran(now);
  const stateMap = loadUserState(db, user.id);
  const { items: events, recon_history } = buildEventItems(db, user, stateMap);
  const cheques = buildChequeItems(db, user, today, stateMap);
  const actions = buildPendingActions(db, user);
  const items = [...actions, ...cheques, ...events];

  const by_category = {};
  const by_severity = {};
  let unread = 0;
  for (const it of items) {
    by_category[it.category] = (by_category[it.category] || 0) + 1;
    by_severity[it.severity] = (by_severity[it.severity] || 0) + 1;
    if ((it.source === 'event' || it.source === 'cheque') && !it.read && !it.dismissed) unread += 1;
  }

  return {
    today_jalali: today,
    generated_at: Math.floor(Date.now() / 1000),
    items,
    counts: {
      unread,
      actionable: actions.length,
      by_category,
      by_severity,
    },
    recon_history,
  };
}

function validKeysForUser(db, user, now) {
  const inbox = buildInbox(db, user, { now });
  return new Set(inbox.items.map((i) => i.key));
}

function upsertState(db, userId, key, patch) {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    INSERT INTO app_notification_user_state (user_id, item_key, read_at, dismissed_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, item_key) DO UPDATE SET
      read_at=COALESCE(excluded.read_at, app_notification_user_state.read_at),
      dismissed_at=COALESCE(excluded.dismissed_at, app_notification_user_state.dismissed_at),
      updated_at=excluded.updated_at
  `).run(
    userId,
    key,
    patch.read_at === undefined ? null : patch.read_at,
    patch.dismissed_at === undefined ? null : patch.dismissed_at,
    now,
  );
  // ON CONFLICT COALESCE keeps old when excluded is null — for clear we need explicit UPDATE
  if (patch.read_at === null || patch.dismissed_at === null || patch.force) {
    const sets = ['updated_at=?'];
    const args = [now];
    if ('read_at' in patch) { sets.push('read_at=?'); args.push(patch.read_at); }
    if ('dismissed_at' in patch) { sets.push('dismissed_at=?'); args.push(patch.dismissed_at); }
    args.push(userId, key);
    db.prepare(`UPDATE app_notification_user_state SET ${sets.join(',')} WHERE user_id=? AND item_key=?`).run(...args);
  }
}

function normalizeKeys(keys) {
  if (!Array.isArray(keys)) return [];
  return [...new Set(keys.map((k) => String(k || '').trim()).filter(Boolean))].slice(0, 500);
}

function markRead(db, user, keys, { now = new Date() } = {}) {
  const allowed = validKeysForUser(db, user, now);
  const ts = Math.floor(Date.now() / 1000);
  let accepted = 0;
  for (const key of normalizeKeys(keys)) {
    if (!allowed.has(key)) continue;
    const existing = db.prepare('SELECT 1 FROM app_notification_user_state WHERE user_id=? AND item_key=?').get(user.id, key);
    if (existing) {
      db.prepare('UPDATE app_notification_user_state SET read_at=?, updated_at=? WHERE user_id=? AND item_key=?')
        .run(ts, ts, user.id, key);
    } else {
      db.prepare(`
        INSERT INTO app_notification_user_state (user_id, item_key, read_at, dismissed_at, updated_at)
        VALUES (?,?,?,NULL,?)
      `).run(user.id, key, ts, ts);
    }
    accepted += 1;
  }
  return { accepted };
}

function markUnread(db, user, keys, { now = new Date() } = {}) {
  const allowed = validKeysForUser(db, user, now);
  const ts = Math.floor(Date.now() / 1000);
  let accepted = 0;
  for (const key of normalizeKeys(keys)) {
    if (!allowed.has(key)) continue;
    const existing = db.prepare('SELECT 1 FROM app_notification_user_state WHERE user_id=? AND item_key=?').get(user.id, key);
    if (existing) {
      db.prepare('UPDATE app_notification_user_state SET read_at=NULL, updated_at=? WHERE user_id=? AND item_key=?')
        .run(ts, user.id, key);
    } else {
      db.prepare(`
        INSERT INTO app_notification_user_state (user_id, item_key, read_at, dismissed_at, updated_at)
        VALUES (?, ?, NULL, NULL, ?)
      `).run(user.id, key, ts);
    }
    accepted += 1;
  }
  return { accepted };
}

function dismiss(db, user, keys, { now = new Date() } = {}) {
  const allowed = validKeysForUser(db, user, now);
  const ts = Math.floor(Date.now() / 1000);
  let accepted = 0;
  for (const key of normalizeKeys(keys)) {
    if (!allowed.has(key)) continue;
    const existing = db.prepare('SELECT 1 FROM app_notification_user_state WHERE user_id=? AND item_key=?').get(user.id, key);
    if (existing) {
      db.prepare('UPDATE app_notification_user_state SET dismissed_at=?, read_at=COALESCE(read_at,?), updated_at=? WHERE user_id=? AND item_key=?')
        .run(ts, ts, ts, user.id, key);
    } else {
      db.prepare(`
        INSERT INTO app_notification_user_state (user_id, item_key, read_at, dismissed_at, updated_at)
        VALUES (?,?,?,?,?)
      `).run(user.id, key, ts, ts, ts);
    }
    accepted += 1;
  }
  return { accepted };
}

function undismiss(db, user, keys, { now = new Date() } = {}) {
  const allowed = validKeysForUser(db, user, now);
  const ts = Math.floor(Date.now() / 1000);
  let accepted = 0;
  for (const key of normalizeKeys(keys)) {
    if (!allowed.has(key)) continue;
    const existing = db.prepare('SELECT 1 FROM app_notification_user_state WHERE user_id=? AND item_key=?').get(user.id, key);
    if (existing) {
      db.prepare('UPDATE app_notification_user_state SET dismissed_at=NULL, updated_at=? WHERE user_id=? AND item_key=?')
        .run(ts, user.id, key);
      accepted += 1;
    }
  }
  return { accepted };
}

function markAllRead(db, user, { category, now = new Date() } = {}) {
  const inbox = buildInbox(db, user, { now });
  const keys = inbox.items
    .filter((i) => (i.source === 'event' || i.source === 'cheque') && !i.read && !i.dismissed)
    .filter((i) => !category || i.category === category)
    .map((i) => i.key);
  return markRead(db, user, keys, { now });
}

function markEntityViewedForUser(db, user, entityType, entityId, { now = new Date() } = {}) {
  const rows = db.prepare(`
    SELECT id, kind, target_roles FROM app_notifications
    WHERE entity_type=? AND entity_id=? AND resolved_at IS NULL AND kind <> 'cheque_due'
  `).all(entityType, entityId).filter((n) => roleSees(n, user.role));
  const keys = rows.map((n) => `n:${n.id}`);
  return markRead(db, user, keys, { now });
}

module.exports = {
  buildInbox,
  buildPendingActions,
  markRead,
  markUnread,
  dismiss,
  undismiss,
  markAllRead,
  markEntityViewedForUser,
  listRuns,
  getRun,
  canSeeCheques,
  roleSees,
  KIND_META,
  faNum,
};
