/**
 * CRM analytics — real aggregates only (no mock).
 * RBAC: when scopeUserId is non-null, client user_id is ignored (never widens/overrides).
 */
const { firmSaleTypeSql } = require('./sales-document');

function crmScopeUserId(req) {
  const role = req.user?.role;
  if (role === 'admin' || role === 'accounting') return null;
  if (role === 'sales_manager') return null;
  return req.user.id;
}

/**
 * Effective filter user id.
 * - Scoped sessions (scopeUserId != null): ALWAYS scopeUserId; ignore filters.user_id
 *   (including 0 / NaN / other reps).
 * - Privileged (scopeUserId == null): optional positive user_id filter.
 */
function resolveEffectiveUserId(scopeUserId, filters = {}) {
  if (scopeUserId != null) {
    return scopeUserId;
  }
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

/** Cheque rows for a customer: prefer customer_id / party_id; legacy name only if UNIQUE. */
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

  // Legacy party_name fallback — only when the name uniquely identifies one customer.
  for (const name of [cust.biz, cust.owner].filter(Boolean)) {
    const nameCount = db.prepare(`
      SELECT COUNT(*) AS c FROM customers
      WHERE biz=? OR owner=?
    `).get(name, name)?.c || 0;
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

function chequeKpis(db, userId) {
  let chequesDue = 0;
  let chequesBounced = 0;
  try {
    const hasCustCol = tableHasColumn(db, 'cheque_records', 'customer_id');
    const hasPartyCol = tableHasColumn(db, 'cheque_records', 'party_id');
    if (userId != null && (hasCustCol || hasPartyCol)) {
      const dueSql = `
        SELECT COUNT(*) AS c FROM cheque_records cr
        WHERE COALESCE(cr.record_status,'posted')<>'reversed'
          AND COALESCE(cr.lifecycle_status,cr.status) IN ('registered','in_collection','pending')
          AND cr.due_date<>'' AND cr.due_date<=date('now','+14 day')
          AND (
            ${hasCustCol ? 'cr.customer_id IN (SELECT id FROM customers WHERE user_id=?)' : '0'}
            ${hasCustCol && hasPartyCol ? ' OR ' : ''}
            ${hasPartyCol ? 'cr.party_id IN (SELECT party_id FROM customers WHERE user_id=? AND party_id IS NOT NULL)' : ''}
          )
      `;
      const params = [];
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
      // Privileged: company-wide KPIs
      chequesDue = db.prepare(`
        SELECT COUNT(*) AS c FROM cheque_records
        WHERE COALESCE(record_status,'posted')<>'reversed'
          AND COALESCE(lifecycle_status,status) IN ('registered','in_collection','pending')
          AND due_date<>'' AND due_date<=date('now','+14 day')
      `).get()?.c || 0;
      chequesBounced = db.prepare(`
        SELECT COUNT(*) AS c FROM cheque_records
        WHERE COALESCE(record_status,'posted')<>'reversed'
          AND COALESCE(lifecycle_status,status)='bounced'
      `).get()?.c || 0;
    } else {
      // Scoped but no stable cheque FK columns yet — hide company-wide leak
      chequesDue = 0;
      chequesBounced = 0;
    }
  } catch (_) { /* table may vary */ }
  return { chequesDue, chequesBounced };
}

function buildDashboard(db, filters = {}, scopeUserId = null) {
  const from = String(filters.from || '').trim();
  const to = String(filters.to || '').trim();
  const userId = resolveEffectiveUserId(scopeUserId, filters);
  const partyGroupId = filters.party_group_id ? parseInt(filters.party_group_id, 10) : null;
  const province = String(filters.province || '').trim();
  const leadSource = String(filters.lead_source || '').trim();
  const campaign = String(filters.campaign || '').trim();

  const custWhere = ['1=1'];
  const custParams = [];
  if (userId) { custWhere.push('c.user_id=?'); custParams.push(userId); }
  if (province) { custWhere.push('(c.city LIKE ? OR c.province=?)'); custParams.push('%' + province + '%', province); }
  if (partyGroupId) {
    custWhere.push('EXISTS (SELECT 1 FROM parties p WHERE p.legacy_table=\'customers\' AND p.legacy_id=c.id AND p.party_group_id=?)');
    custParams.push(partyGroupId);
  }
  if (leadSource) { custWhere.push('c.lead_source=?'); custParams.push(leadSource); }
  if (campaign) { custWhere.push('c.campaign=?'); custParams.push(campaign); }

  const invWhere = ["COALESCE(i.deleted_at,0)=0"];
  try {
    const hasStatus = db.prepare("PRAGMA table_info(invoices)").all().some((c) => c.name === 'status');
    if (hasStatus) invWhere.push("COALESCE(i.status,'posted')<>'reversed'");
  } catch (_) {}
  const invParams = [];
  if (userId) { invWhere.push('i.user_id=?'); invParams.push(userId); }
  if (from) { invWhere.push('i.date>=?'); invParams.push(from); }
  if (to) { invWhere.push('i.date<=?'); invParams.push(to); }
  if (leadSource) { invWhere.push('i.lead_source=?'); invParams.push(leadSource); }
  if (campaign) { invWhere.push('i.campaign=?'); invParams.push(campaign); }

  const fuWhere = ["1=1"];
  const fuParams = [];
  if (userId) { fuWhere.push('f.user_id=?'); fuParams.push(userId); }
  if (from) { fuWhere.push('f.date>=?'); fuParams.push(from); }
  if (to) { fuWhere.push('f.date<=?'); fuParams.push(to); }

  // new_customers: when from/to set, filter by customers.created_at (unix) in Jalali day bounds
  if (from || to) {
    const { j2g } = require('../jalali');
    const dayBounds = (jStr) => {
      const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(String(jStr || '').trim());
      if (!m) return null;
      const [gy, gm, gd] = j2g(+m[1], +m[2], +m[3]);
      const start = Math.floor(new Date(gy, gm - 1, gd, 0, 0, 0).getTime() / 1000);
      return { start, end: start + 86400 - 1 };
    };
    if (from) {
      const b = dayBounds(from);
      if (b) { custWhere.push('COALESCE(c.created_at,0)>=?'); custParams.push(b.start); }
    }
    if (to) {
      const b = dayBounds(to);
      if (b) { custWhere.push('COALESCE(c.created_at,0)<=?'); custParams.push(b.end); }
    }
  }

  const newCustomers = db.prepare(
    `SELECT COUNT(*) AS c FROM customers c WHERE ${custWhere.join(' AND ')}`
  ).get(...custParams)?.c || 0;

  const openFollowups = db.prepare(
    `SELECT COUNT(*) AS c FROM followups f WHERE ${fuWhere.join(' AND ')} AND f.status='open'`
  ).get(...fuParams)?.c || 0;

  const overdueFollowups = db.prepare(
    `SELECT COUNT(*) AS c FROM followups f WHERE ${fuWhere.join(' AND ')} AND f.status='open' AND f.next_date<>'' AND f.next_date < date('now')`
  ).get(...fuParams)?.c || 0;

  const byType = db.prepare(`
    SELECT i.type, COUNT(*) AS cnt, COALESCE(SUM(COALESCE(NULLIF(i.final_rial,0), ROUND(i.final*10), 0)),0) AS amount_rial
    FROM invoices i WHERE ${invWhere.join(' AND ')}
    GROUP BY i.type
  `).all(...invParams);

  const firmSales = db.prepare(`
    SELECT COUNT(*) AS cnt, COALESCE(SUM(COALESCE(NULLIF(i.final_rial,0), ROUND(i.final*10), 0)),0) AS amount_rial
    FROM invoices i WHERE ${invWhere.join(' AND ')} AND ${firmSaleTypeSql('i')}
  `).get(...invParams);

  const proformaCount = byType.find((r) => r.type === 'proforma')?.cnt || 0;
  const normalCount = byType.find((r) => r.type === 'normal')?.cnt || 0;
  const finalCount = byType.find((r) => r.type === 'final')?.cnt || 0;

  const pipeline = db.prepare(`
    SELECT f.status AS stage, COUNT(*) AS cnt
    FROM followups f WHERE ${fuWhere.join(' AND ')}
    GROUP BY f.status
  `).all(...fuParams);

  const byExpert = db.prepare(`
    SELECT u.id, u.name, COUNT(i.id) AS cnt,
      COALESCE(SUM(COALESCE(NULLIF(i.final_rial,0), ROUND(i.final*10), 0)),0) AS amount_rial
    FROM invoices i
    JOIN users u ON u.id=i.user_id
    WHERE ${invWhere.join(' AND ')} AND ${firmSaleTypeSql('i')}
    GROUP BY u.id ORDER BY amount_rial DESC LIMIT 20
  `).all(...invParams);

  const { chequesDue, chequesBounced } = chequeKpis(db, userId);

  let receivablesRial = 0;
  try {
    const q = userId
      ? db.prepare(`
          SELECT COALESCE(SUM(cl.debit-cl.credit),0) AS bal
          FROM customer_ledger cl
          JOIN customers c ON c.id=cl.customer_id
          WHERE c.user_id=?
        `).get(userId)
      : db.prepare(`SELECT COALESCE(SUM(debit-credit),0) AS bal FROM customer_ledger`).get();
    receivablesRial = Math.round(Number(q?.bal) || 0) * 10;
  } catch (_) {}

  const inactiveCustomers = db.prepare(`
    SELECT COUNT(*) AS c FROM customers c
    WHERE ${custWhere.join(' AND ')}
      AND NOT EXISTS (
        SELECT 1 FROM invoices i WHERE i.cust_id=c.id AND ${firmSaleTypeSql('i')}
          AND COALESCE(i.deleted_at,0)=0 AND i.date>=date('now','-90 day')
      )
      AND NOT EXISTS (
        SELECT 1 FROM followups f WHERE f.cust_id=c.id AND f.date>=date('now','-90 day')
      )
  `).get(...custParams)?.c || 0;

  const conversion = {
    leads_or_customers: newCustomers,
    proforma: proformaCount,
    normal: normalCount,
    final: finalCount,
    firm: Number(firmSales?.cnt) || 0,
    firm_amount_rial: Number(firmSales?.amount_rial) || 0,
  };

  return {
    filters: { from, to, user_id: userId, party_group_id: partyGroupId, province, lead_source: leadSource, campaign },
    kpis: {
      new_customers: newCustomers,
      open_followups: openFollowups,
      overdue_followups: overdueFollowups,
      inactive_customers_90d: inactiveCustomers,
      firm_invoice_count: conversion.firm,
      firm_sales_rial: conversion.firm_amount_rial,
      receivables_rial: receivablesRial,
      cheques_due_14d: chequesDue,
      cheques_bounced: chequesBounced,
    },
    invoices_by_type: byType,
    conversion,
    pipeline,
    sales_by_expert: byExpert,
  };
}

function buildTimeline(db, { partyId, customerId, limit = 50, offset = 0, scopeUserId = null }) {
  const events = [];
  let custId = customerId ? parseInt(customerId, 10) : null;
  if (!custId && partyId) {
    const p = db.prepare('SELECT legacy_table, legacy_id FROM parties WHERE id=?').get(partyId);
    if (p?.legacy_table === 'customers') custId = p.legacy_id;
  }
  if (!custId) return { events: [], total: 0 };

  if (scopeUserId) {
    const own = db.prepare('SELECT user_id FROM customers WHERE id=?').get(custId);
    if (own && own.user_id !== scopeUserId) {
      const err = new Error('دسترسی به این مشتری ندارید');
      err.status = 403;
      throw err;
    }
  }

  const fus = db.prepare(`
    SELECT id, date, type, subject, status, created_at FROM followups WHERE cust_id=? ORDER BY created_at DESC LIMIT 200
  `).all(custId);
  for (const f of fus) {
    events.push({
      kind: 'followup', id: f.id, date: f.date, title: f.subject || f.type,
      status: f.status, ts: f.created_at || 0,
    });
  }
  const invs = db.prepare(`
    SELECT id, num, type, date, final, final_rial, created_at FROM invoices
    WHERE cust_id=? AND COALESCE(deleted_at,0)=0 ORDER BY created_at DESC LIMIT 200
  `).all(custId);
  for (const i of invs) {
    events.push({
      kind: 'invoice', id: i.id, date: i.date,
      title: `${i.type} ${i.num}`, amount: i.final, amount_rial: i.final_rial || Math.round((i.final || 0) * 10),
      status: i.type, ts: i.created_at || 0,
    });
  }
  try {
    const settles = db.prepare(`
      SELECT id, date, amount, pay_type, created_at FROM settlements WHERE cust_id=? ORDER BY created_at DESC LIMIT 100
    `).all(custId);
    for (const s of settles) {
      events.push({
        kind: 'settlement', id: s.id, date: s.date, title: `دریافت ${s.pay_type}`,
        amount: s.amount, ts: s.created_at || 0,
      });
    }
  } catch (_) {}
  try {
    const rets = db.prepare(`
      SELECT id, date, amount, created_at FROM sales_returns
      WHERE cust_id=? AND COALESCE(status,'posted')<>'reversed' ORDER BY created_at DESC LIMIT 100
    `).all(custId);
    for (const r of rets) {
      events.push({
        kind: 'sales_return', id: r.id, date: r.date, title: `برگشت از فروش #${r.id}`,
        amount: r.amount, ts: r.created_at || 0,
      });
    }
  } catch (_) {}
  try {
    for (const c of chequeRowsForCustomer(db, custId, { limit: 50 })) {
      events.push({
        kind: 'cheque', id: c.id, date: c.due_date, title: `چک ${c.cheque_number || c.id}`,
        amount: c.amount, status: c.lifecycle_status || c.status, ts: c.created_at || 0,
      });
    }
  } catch (_) {}

  events.sort((a, b) => (b.ts || 0) - (a.ts || 0) || String(b.date).localeCompare(String(a.date)));
  const total = events.length;
  return { events: events.slice(offset, offset + limit), total };
}

function buildDrilldown(db, metric, filters, scopeUserId) {
  const userId = resolveEffectiveUserId(scopeUserId, filters);
  const from = String(filters.from || '').trim();
  const to = String(filters.to || '').trim();
  if (metric === 'open_followups' || metric === 'overdue_followups') {
    const where = ["f.status='open'"];
    const params = [];
    if (userId) { where.push('f.user_id=?'); params.push(userId); }
    if (metric === 'overdue_followups') where.push("f.next_date<>'' AND f.next_date < date('now')");
    if (from) { where.push('f.date>=?'); params.push(from); }
    if (to) { where.push('f.date<=?'); params.push(to); }
    return db.prepare(`
      SELECT f.*, c.biz as cust_biz FROM followups f
      LEFT JOIN customers c ON c.id=f.cust_id
      WHERE ${where.join(' AND ')} ORDER BY f.created_at DESC LIMIT 200
    `).all(...params);
  }
  if (metric === 'firm_sales' || metric === 'normal' || metric === 'final' || metric === 'proforma') {
    const where = ["COALESCE(i.deleted_at,0)=0"];
    const params = [];
    if (metric === 'firm_sales') where.push(firmSaleTypeSql('i'));
    else where.push('i.type=?'), params.push(metric);
    if (userId) { where.push('i.user_id=?'); params.push(userId); }
    if (from) { where.push('i.date>=?'); params.push(from); }
    if (to) { where.push('i.date<=?'); params.push(to); }
    return db.prepare(`
      SELECT i.id,i.num,i.type,i.date,i.final,i.cust_id,c.biz as cust_biz
      FROM invoices i LEFT JOIN customers c ON c.id=i.cust_id
      WHERE ${where.join(' AND ')} ORDER BY i.created_at DESC LIMIT 200
    `).all(...params);
  }
  return [];
}

module.exports = {
  crmScopeUserId,
  resolveEffectiveUserId,
  buildDashboard,
  buildTimeline,
  buildDrilldown,
  chequeRowsForCustomer,
};
