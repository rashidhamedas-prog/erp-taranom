/**
 * Shared CRM scope + cheque helpers (no analytics cycle).
 */
const { todayJalali, addDaysToJalali } = require('../jalali');

function crmScopeUserId(req) {
  const role = req.user?.role;
  if (role === 'admin' || role === 'accounting') return null;
  if (role === 'sales_manager') return null;
  return req.user.id;
}

function resolveEffectiveUserId(scopeUserId, filters = {}) {
  if (scopeUserId != null) return scopeUserId;
  if (filters.user_id == null || String(filters.user_id).trim() === '') return null;
  const requested = parseInt(filters.user_id, 10);
  if (!Number.isFinite(requested) || requested <= 0) return null;
  return requested;
}

function tableHasColumn(db, table, col) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
  } catch {
    return false;
  }
}

function chequeRowsForCustomer(db, custId, { limit = 50 } = {}) {
  const cust = db.prepare('SELECT id, biz, owner, party_id FROM customers WHERE id=?').get(custId);
  if (!cust) return [];
  const hasCustCol = tableHasColumn(db, 'cheque_records', 'customer_id');
  const hasPartyCol = tableHasColumn(db, 'cheque_records', 'party_id');
  const rows = [];
  const seen = new Set();
  const pushAll = (list) => {
    for (const r of list || []) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      rows.push(r);
    }
  };
  if (hasCustCol) {
    pushAll(db.prepare(`
      SELECT * FROM cheque_records
      WHERE COALESCE(record_status,'posted')<>'reversed' AND customer_id=?
      ORDER BY id DESC LIMIT ?
    `).all(custId, limit));
  }
  if (hasPartyCol && cust.party_id) {
    pushAll(db.prepare(`
      SELECT * FROM cheque_records
      WHERE COALESCE(record_status,'posted')<>'reversed' AND party_id=?
      ORDER BY id DESC LIMIT ?
    `).all(cust.party_id, limit));
  }
  for (const name of [cust.biz, cust.owner].filter(Boolean)) {
    const nameCount = db.prepare('SELECT COUNT(*) AS c FROM customers WHERE biz=? OR owner=?').get(name, name)?.c || 0;
    if (nameCount !== 1) continue;
    const chqCount = db.prepare(`
      SELECT COUNT(DISTINCT party_name) AS c FROM cheque_records
      WHERE COALESCE(record_status,'posted')<>'reversed' AND party_name=?
    `).get(name)?.c || 0;
    if (chqCount === 0) continue;
    pushAll(db.prepare(`
      SELECT * FROM cheque_records
      WHERE COALESCE(record_status,'posted')<>'reversed' AND party_name=?
      ORDER BY id DESC LIMIT ?
    `).all(name, limit));
  }
  rows.sort((a, b) => (b.id || 0) - (a.id || 0));
  return rows.slice(0, limit);
}

function chequeKpis(db, userId, { dueDays = 14 } = {}) {
  let chequesDue = 0;
  let chequesBounced = 0;
  const days = Number.isFinite(Number(dueDays)) && Number(dueDays) > 0 ? Number(dueDays) : 14;
  const dueLimit = addDaysToJalali(todayJalali(), days);
  try {
    const hasCustCol = tableHasColumn(db, 'cheque_records', 'customer_id');
    const hasPartyCol = tableHasColumn(db, 'cheque_records', 'party_id');
    if (userId != null && (hasCustCol || hasPartyCol)) {
      const dueSql = `
        SELECT COUNT(*) AS c FROM cheque_records cr
        WHERE COALESCE(cr.record_status,'posted')<>'reversed'
          AND COALESCE(cr.lifecycle_status,cr.status) IN ('registered','in_collection','pending')
          AND cr.due_date<>'' AND cr.due_date<=?
          AND (
            ${hasCustCol ? 'cr.customer_id IN (SELECT id FROM customers WHERE user_id=?)' : '0'}
            ${hasCustCol && hasPartyCol ? ' OR ' : ''}
            ${hasPartyCol ? 'cr.party_id IN (SELECT party_id FROM customers WHERE user_id=? AND party_id IS NOT NULL)' : ''}
          )
      `;
      const params = [dueLimit];
      if (hasCustCol) params.push(userId);
      if (hasPartyCol) params.push(userId);
      chequesDue = db.prepare(dueSql).get(...params)?.c || 0;
      const bounceSql = `
        SELECT COUNT(*) AS c FROM cheque_records cr
        WHERE COALESCE(cr.record_status,'posted')<>'reversed'
          AND COALESCE(cr.lifecycle_status,cr.status)='bounced'
          AND (
            ${hasCustCol ? 'cr.customer_id IN (SELECT id FROM customers WHERE user_id=?)' : '0'}
            ${hasCustCol && hasPartyCol ? ' OR ' : ''}
            ${hasPartyCol ? 'cr.party_id IN (SELECT party_id FROM customers WHERE user_id=? AND party_id IS NOT NULL)' : ''}
          )
      `;
      const bParams = [];
      if (hasCustCol) bParams.push(userId);
      if (hasPartyCol) bParams.push(userId);
      chequesBounced = db.prepare(bounceSql).get(...bParams)?.c || 0;
    } else if (userId == null) {
      chequesDue = db.prepare(`
        SELECT COUNT(*) AS c FROM cheque_records
        WHERE COALESCE(record_status,'posted')<>'reversed'
          AND COALESCE(lifecycle_status,status) IN ('registered','in_collection','pending')
          AND due_date<>'' AND due_date<=?
      `).get(dueLimit)?.c || 0;
      chequesBounced = db.prepare(`
        SELECT COUNT(*) AS c FROM cheque_records
        WHERE COALESCE(record_status,'posted')<>'reversed'
          AND COALESCE(lifecycle_status,status)='bounced'
      `).get()?.c || 0;
    }
  } catch (_) { /* table may vary */ }
  return { chequesDue, chequesBounced };
}

module.exports = {
  crmScopeUserId,
  resolveEffectiveUserId,
  tableHasColumn,
  chequeRowsForCustomer,
  chequeKpis,
};
