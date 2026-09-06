/**
 * CRM analytics — real aggregates only (no mock).
 * RBAC: when scopeUserId is non-null, client user_id is ignored (never widens/overrides).
 */
const { firmSaleTypeSql } = require('./sales-document');
const { todayJalali, addDaysToJalali } = require('../jalali');
const {
  crmScopeUserId, resolveEffectiveUserId, tableHasColumn,
  chequeRowsForCustomer, chequeKpis,
} = require('./crm-analytics-scope');

function sqlInvoiceAmountRial(alias = 'i') {
  const a = alias ? `${alias}.` : '';
  return `COALESCE(NULLIF(${a}final_rial,0), ROUND(${a}final), 0)`;
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
  if (leadSource) { custWhere.push('COALESCE(c.lead_source,c.source,\'\')=?'); custParams.push(leadSource); }
  if (campaign) { custWhere.push('c.campaign=?'); custParams.push(campaign); }

  const invWhere = ["COALESCE(i.deleted_at,0)=0"];
  try {
    const hasStatus = db.prepare('PRAGMA table_info(invoices)').all().some((c) => c.name === 'status');
    if (hasStatus) invWhere.push("COALESCE(i.status,'posted')<>'reversed'");
  } catch (_) {}
  const invParams = [];
  if (userId) { invWhere.push('i.user_id=?'); invParams.push(userId); }
  if (from) { invWhere.push('i.date>=?'); invParams.push(from); }
  if (to) { invWhere.push('i.date<=?'); invParams.push(to); }
  if (leadSource) { invWhere.push('i.lead_source=?'); invParams.push(leadSource); }
  if (campaign) { invWhere.push('i.campaign=?'); invParams.push(campaign); }

  const fuWhere = ['1=1'];
  const fuParams = [];
  if (userId) { fuWhere.push('f.user_id=?'); fuParams.push(userId); }
  if (from) { fuWhere.push('f.date>=?'); fuParams.push(from); }
  if (to) { fuWhere.push('f.date<=?'); fuParams.push(to); }

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

  const todayJ = todayJalali();
  const inactiveSince = addDaysToJalali(todayJ, -90);

  const overdueFollowups = db.prepare(
    `SELECT COUNT(*) AS c FROM followups f WHERE ${fuWhere.join(' AND ')} AND f.status='open' AND f.next_date<>'' AND f.next_date < ?`
  ).get(...fuParams, todayJ)?.c || 0;

  const byType = db.prepare(`
    SELECT i.type, COUNT(*) AS cnt, COALESCE(SUM(${sqlInvoiceAmountRial('i')}),0) AS amount_rial
    FROM invoices i WHERE ${invWhere.join(' AND ')}
    GROUP BY i.type
  `).all(...invParams);

  const firmSales = db.prepare(`
    SELECT COUNT(*) AS cnt, COALESCE(SUM(${sqlInvoiceAmountRial('i')}),0) AS amount_rial
    FROM invoices i WHERE ${invWhere.join(' AND ')} AND ${firmSaleTypeSql('i')}
  `).get(...invParams);

  const proformaCount = byType.find((r) => r.type === 'proforma')?.cnt || 0;
  const normalCount = byType.find((r) => r.type === 'normal')?.cnt || 0;
  const finalCount = byType.find((r) => r.type === 'final')?.cnt || 0;

  let pipeline = [];
  const hasOpp = !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='crm_opportunities'").get();
  if (hasOpp) {
    const oppWhere = ['1=1']; const oppParams = [];
    if (userId) { oppWhere.push('o.owner_user_id=?'); oppParams.push(userId); }
    if (leadSource) { oppWhere.push('o.lead_source=?'); oppParams.push(leadSource); }
    if (campaign) { oppWhere.push('o.campaign=?'); oppParams.push(campaign); }
    pipeline = db.prepare(`
      SELECT o.pipeline_stage AS stage, COUNT(*) AS cnt,
        COALESCE(SUM(o.estimated_amount_rial),0) AS amount_rial,
        COALESCE(SUM(o.weighted_amount_rial),0) AS weighted_amount_rial
      FROM crm_opportunities o WHERE ${oppWhere.join(' AND ')}
      GROUP BY o.pipeline_stage
    `).all(...oppParams);
  } else {
    pipeline = db.prepare(`
      SELECT COALESCE(f.pipeline_stage,'lead') AS stage, COUNT(*) AS cnt
      FROM followups f WHERE ${fuWhere.join(' AND ')}
      GROUP BY COALESCE(f.pipeline_stage,'lead')
    `).all(...fuParams);
  }

  const byExpert = db.prepare(`
    SELECT u.id, u.name, COUNT(i.id) AS cnt,
      COALESCE(SUM(${sqlInvoiceAmountRial('i')}),0) AS amount_rial
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
      : db.prepare('SELECT COALESCE(SUM(debit-credit),0) AS bal FROM customer_ledger').get();
    receivablesRial = Math.round(Number(q?.bal) || 0);
  } catch (_) {}

  const inactiveCustomers = db.prepare(`
    SELECT COUNT(*) AS c FROM customers c
    WHERE ${custWhere.join(' AND ')}
      AND NOT EXISTS (
        SELECT 1 FROM invoices i WHERE i.cust_id=c.id AND ${firmSaleTypeSql('i')}
          AND COALESCE(i.deleted_at,0)=0 AND i.date>=?
      )
      AND NOT EXISTS (
        SELECT 1 FROM followups f WHERE f.cust_id=c.id AND f.date>=?
      )
  `).get(...custParams, inactiveSince, inactiveSince)?.c || 0;

  const conversion = {
    leads_or_customers: newCustomers,
    proforma: proformaCount,
    normal: normalCount,
    final: finalCount,
    firm: Number(firmSales?.cnt) || 0,
    firm_amount_rial: Number(firmSales?.amount_rial) || 0,
  };

  const applied = {
    from, to, user_id: userId, party_group_id: partyGroupId,
    province, lead_source: leadSource, campaign,
  };

  let pro = {};
  try {
    const analytics = require('./crm-pro-analytics');
    pro = {
      kpis_compare: analytics.buildKpis(db, filters, scopeUserId).kpis,
      pipeline_detail: analytics.buildPipeline(db, filters, scopeUserId).stages,
      funnel: analytics.buildConversionFunnel(db, filters, scopeUserId).funnel,
      sales_trend: analytics.buildSalesTrend(db, filters, scopeUserId).series,
      experts_detail: analytics.buildExpertPerformance(db, filters, scopeUserId).experts,
      sources: analytics.buildSourcePerformance(db, filters, scopeUserId).sources,
      campaigns: analytics.buildCampaignPerformance(db, filters, scopeUserId).campaigns,
      segments: analytics.buildSegmentReport(db, filters, scopeUserId).segments,
      urgent: analytics.buildUrgentActions(db, filters, scopeUserId),
    };
  } catch (_) { pro = {}; }

  return {
    filters: applied,
    applied_filters: applied,
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
    ...pro,
  };
}

function buildTimeline(db, {
  partyId, customerId, limit = 50, offset = 0, scopeUserId = null, kinds = '',
} = {}) {
  const events = [];
  let custId = customerId ? parseInt(customerId, 10) : null;
  if (!custId && partyId) {
    const p = db.prepare('SELECT legacy_table, legacy_id FROM parties WHERE id=?').get(partyId);
    if (p?.legacy_table === 'customers') custId = p.legacy_id;
  }
  if (!custId) return { events: [], total: 0, applied_filters: { customer_id: null } };

  if (scopeUserId) {
    const own = db.prepare('SELECT user_id FROM customers WHERE id=?').get(custId);
    if (own && own.user_id !== scopeUserId) {
      const err = new Error('دسترسی به این مشتری ندارید');
      err.status = 403;
      throw err;
    }
  }

  const kindFilter = String(kinds || '').split(',').map((s) => s.trim()).filter(Boolean);

  const fus = db.prepare(`
    SELECT id, date, type, subject, status, note, action, user_id, created_at, pipeline_stage
    FROM followups WHERE cust_id=? ORDER BY created_at DESC LIMIT 200
  `).all(custId);
  for (const f of fus) {
    events.push({
      kind: 'followup', id: f.id, date: f.date, title: f.subject || f.type,
      description: f.note || '', status: f.status, ts: f.created_at || 0,
      sourceType: 'followups', sourceId: f.id, user_id: f.user_id,
    });
  }
  const invs = db.prepare(`
    SELECT id, num, type, date, final, final_rial, created_at, status
    FROM invoices WHERE cust_id=? AND COALESCE(deleted_at,0)=0 ORDER BY created_at DESC LIMIT 200
  `).all(custId);
  for (const i of invs) {
    const reversed = i.status === 'reversed';
    events.push({
      kind: i.type === 'proforma' ? 'proforma' : (i.type === 'final' ? 'invoice_final' : 'invoice'),
      id: i.id, date: i.date,
      title: `${i.type} ${i.num}`,
      amount_rial: i.final_rial || Math.round(i.final || 0),
      status: reversed ? 'reversed' : i.type, ts: i.created_at || 0,
      sourceType: 'invoices', sourceId: i.id, reversed,
    });
  }
  try {
    const settles = db.prepare(`
      SELECT id, date, amount, amount_rial, pay_type, created_at FROM settlements WHERE cust_id=? ORDER BY created_at DESC LIMIT 100
    `).all(custId);
    for (const s of settles) {
      events.push({
        kind: 'settlement', id: s.id, date: s.date, title: `دریافت ${s.pay_type}`,
        amount_rial: s.amount_rial || Math.round(s.amount || 0),
        ts: s.created_at || 0, sourceType: 'settlements', sourceId: s.id,
      });
    }
  } catch (_) {}
  try {
    const rets = db.prepare(`
      SELECT id, date, amount, created_at, status FROM sales_returns WHERE cust_id=? ORDER BY created_at DESC LIMIT 100
    `).all(custId);
    for (const r of rets) {
      events.push({
        kind: 'sales_return', id: r.id, date: r.date, title: `برگشت از فروش #${r.id}`,
        amount_rial: Math.round(r.amount || 0),
        status: r.status, ts: r.created_at || 0,
        sourceType: 'sales_returns', sourceId: r.id,
        reversed: r.status === 'reversed',
      });
    }
  } catch (_) {}
  try {
    for (const c of chequeRowsForCustomer(db, custId, { limit: 50 })) {
      events.push({
        kind: 'cheque', id: c.id, date: c.due_date, title: `چک ${c.cheque_number || c.id}`,
        amount_rial: Math.round(c.amount || 0),
        status: c.lifecycle_status || c.status, ts: c.created_at || 0,
        sourceType: 'cheque_records', sourceId: c.id,
      });
    }
  } catch (_) {}
  try {
    const hist = db.prepare(`
      SELECT h.id, h.to_stage, h.from_stage, h.changed_at, h.reason, h.changed_by
      FROM crm_stage_history h
      JOIN crm_opportunities o ON o.id=h.opportunity_id
      WHERE o.customer_id=? ORDER BY h.changed_at DESC LIMIT 100
    `).all(custId);
    for (const h of hist) {
      events.push({
        kind: 'opportunity_stage', id: h.id, date: '', title: `مرحله ${h.from_stage || '—'} ← ${h.to_stage}`,
        description: h.reason || '', ts: h.changed_at || 0, user_id: h.changed_by,
        sourceType: 'crm_stage_history', sourceId: h.id,
      });
    }
  } catch (_) {}
  try {
    const segs = db.prepare(`
      SELECT id, from_segment, to_segment, reason, changed_at FROM crm_segment_history
      WHERE customer_id=? ORDER BY changed_at DESC LIMIT 50
    `).all(custId);
    for (const s of segs) {
      events.push({
        kind: 'segment', id: s.id, date: '', title: `سگمنت ${s.from_segment || '—'} ← ${s.to_segment}`,
        description: s.reason || '', ts: s.changed_at || 0,
        sourceType: 'crm_segment_history', sourceId: s.id,
      });
    }
  } catch (_) {}

  const filtered = kindFilter.length ? events.filter((e) => kindFilter.includes(e.kind)) : events;
  filtered.sort((a, b) => (b.ts || 0) - (a.ts || 0) || String(b.date).localeCompare(String(a.date)));
  const total = filtered.length;
  const lim = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
  const off = Math.max(0, parseInt(offset, 10) || 0);
  return { events: filtered.slice(off, off + lim), total, applied_filters: { customer_id: custId, kinds: kindFilter } };
}

function buildDrilldown(db, metric, filters, scopeUserId) {
  const analytics = require('./crm-pro-analytics');
  const { getSettingInt } = require('./crm-pro');
  const m = String(metric || '').trim();
  if (!analytics.DRILL_METRICS.has(m)) {
    const err = new Error('metric ناشناخته');
    err.status = 400;
    throw err;
  }
  const f = analytics.parseFilters(filters, scopeUserId);
  const page = f.page;
  const pageSize = analytics.parseLimit(filters.page_size || filters.limit, 50);
  const offset = (page - 1) * pageSize;

  const finish = (sql, params, countSql, countParams) => {
    const total = countSql
      ? (db.prepare(countSql).get(...(countParams || params))?.c || 0)
      : 0;
    const rows = db.prepare(sql).all(...params);
    rows.total = total || rows.length;
    rows.page = page;
    rows.page_size = pageSize;
    return rows;
  };

  if (m === 'open_followups' || m === 'overdue_followups' || m === 'due_today_followups') {
    const where = ["f.status='open'"]; const params = [];
    analytics.addFuFilters(where, params, { ...f, status: '' });
    if (m === 'overdue_followups') { where.push("f.next_date<>'' AND f.next_date < ?"); params.push(todayJalali()); }
    if (m === 'due_today_followups') { where.push('f.next_date=?'); params.push(todayJalali()); }
    return finish(
      `SELECT f.*, c.biz as cust_biz FROM followups f LEFT JOIN customers c ON c.id=f.cust_id
       WHERE ${where.join(' AND ')} ORDER BY f.created_at DESC LIMIT ? OFFSET ?`,
      [...params, pageSize, offset],
      `SELECT COUNT(*) AS c FROM followups f WHERE ${where.join(' AND ')}`,
      params
    );
  }
  if (m === 'firm_sales' || m === 'normal' || m === 'final' || m === 'proforma' || m === 'funnel_firm') {
    const where = []; const params = [];
    const invF = (m === 'normal' || m === 'final' || m === 'proforma') ? { ...f, invoice_type: m } : f;
    analytics.addInvFilters(where, params, invF);
    if (m === 'firm_sales' || m === 'funnel_firm') where.push(firmSaleTypeSql('i'));
    return finish(
      `SELECT i.id,i.num,i.type,i.date,i.final,i.final_rial,i.cust_id,c.biz as cust_biz
       FROM invoices i LEFT JOIN customers c ON c.id=i.cust_id
       WHERE ${where.join(' AND ')} ORDER BY i.created_at DESC LIMIT ? OFFSET ?`,
      [...params, pageSize, offset],
      `SELECT COUNT(*) AS c FROM invoices i WHERE ${where.join(' AND ')}`,
      params
    );
  }

  const stageMetric = m.match(/^pipeline_(.+)$/) || m.match(/^funnel_(lead|qualified|proposal|negotiation)$/);
  if (stageMetric) {
    const stage = stageMetric[1];
    const hasOpp = !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='crm_opportunities'").get();
    if (hasOpp) {
      const where = []; const params = [];
      analytics.addOppFilters(where, params, { ...f, pipeline_stage: stage });
      return finish(
        `SELECT o.*, c.biz AS cust_biz FROM crm_opportunities o LEFT JOIN customers c ON c.id=o.customer_id
         WHERE ${where.join(' AND ')} ORDER BY o.updated_at DESC LIMIT ? OFFSET ?`,
        [...params, pageSize, offset],
        `SELECT COUNT(*) AS c FROM crm_opportunities o WHERE ${where.join(' AND ')}`,
        params
      );
    }
    const where = []; const params = [];
    analytics.addFuFilters(where, params, { ...f, pipeline_stage: stage });
    return finish(
      `SELECT f.*, c.biz AS cust_biz FROM followups f LEFT JOIN customers c ON c.id=f.cust_id
       WHERE ${where.join(' AND ')} ORDER BY f.created_at DESC LIMIT ? OFFSET ?`,
      [...params, pageSize, offset],
      `SELECT COUNT(*) AS c FROM followups f WHERE ${where.join(' AND ')}`,
      params
    );
  }

  if (m === 'new_customers' || m === 'inactive_customers_90d' || m === 'churn_risk_customers' || m === 'repeat_customers' || m === 'funnel_repeat') {
    const where = ['1=1']; const params = [];
    if (m === 'inactive_customers_90d') {
      analytics.addCustFilters(where, params, { ...f, from: '', to: '' });
      const since = addDaysToJalali(todayJalali(), -90);
      where.push(`NOT EXISTS (SELECT 1 FROM invoices i WHERE i.cust_id=c.id AND ${firmSaleTypeSql('i')} AND COALESCE(i.deleted_at,0)=0 AND i.date>=?)`);
      where.push('NOT EXISTS (SELECT 1 FROM followups fu WHERE fu.cust_id=c.id AND fu.date>=?)');
      params.push(since, since);
    } else if (m === 'repeat_customers' || m === 'funnel_repeat') {
      analytics.addCustFilters(where, params, { ...f, from: '', to: '' });
      const invWhere = []; const invParams = [];
      analytics.addInvFilters(invWhere, invParams, f);
      where.push(`c.id IN (SELECT i.cust_id FROM invoices i WHERE ${invWhere.join(' AND ')} AND ${firmSaleTypeSql('i')} GROUP BY i.cust_id HAVING COUNT(*)>1)`);
      params.push(...invParams);
    } else if (m === 'churn_risk_customers') {
      analytics.addCustFilters(where, params, { ...f, from: '', to: '' });
      where.push("EXISTS (SELECT 1 FROM crm_customer_segments s WHERE s.customer_id=c.id AND s.effective_segment='churn_risk')");
    } else {
      analytics.addCustFilters(where, params, f);
      if (f.from) { const b = analytics.jalaliDayBounds(f.from); if (b) { where.push('COALESCE(c.created_at,0)>=?'); params.push(b.start); } }
      if (f.to) { const b = analytics.jalaliDayBounds(f.to); if (b) { where.push('COALESCE(c.created_at,0)<=?'); params.push(b.end); } }
    }
    return finish(
      `SELECT c.id, c.biz, c.city, c.user_id FROM customers c WHERE ${where.join(' AND ')} ORDER BY c.id DESC LIMIT ? OFFSET ?`,
      [...params, pageSize, offset],
      `SELECT COUNT(*) AS c FROM customers c WHERE ${where.join(' AND ')}`,
      params
    );
  }

  if (m === 'open_opportunities' || m === 'won_opportunities' || m === 'lost_opportunities' || m === 'stale_opportunities' || m === 'new_leads') {
    const where = []; const params = [];
    analytics.addOppFilters(where, params, f);
    if (m === 'open_opportunities') where.push("o.status='open'");
    if (m === 'won_opportunities') where.push("o.pipeline_stage IN ('first_order','won','repeat')");
    if (m === 'lost_opportunities') where.push("o.pipeline_stage='lost'");
    if (m === 'new_leads') where.push("o.pipeline_stage='lead'");
    if (m === 'stale_opportunities') {
      where.push("o.status='open'");
      const staleDays = getSettingInt(db, 'crm_stale_opportunity_days', 14);
      params.push(Math.floor(Date.now() / 1000) - staleDays * 86400);
      where.push('COALESCE(o.entered_stage_at,o.updated_at,0)<?');
    }
    return finish(
      `SELECT o.*, c.biz AS cust_biz FROM crm_opportunities o LEFT JOIN customers c ON c.id=o.customer_id
       WHERE ${where.join(' AND ')} ORDER BY o.updated_at DESC LIMIT ? OFFSET ?`,
      [...params, pageSize, offset],
      `SELECT COUNT(*) AS c FROM crm_opportunities o WHERE ${where.join(' AND ')}`,
      params
    );
  }

  const err = new Error('metric ناشناخته');
  err.status = 400;
  throw err;
}

module.exports = {
  crmScopeUserId,
  resolveEffectiveUserId,
  buildDashboard,
  buildTimeline,
  buildDrilldown,
  chequeRowsForCustomer,
  chequeKpis,
  tableHasColumn,
  sqlInvoiceAmountRial,
};
