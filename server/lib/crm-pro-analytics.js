/**
 * CRM Pro analytics — real aggregates, rial-only, parameterized filters.
 */
const { firmSaleTypeSql } = require('./sales-document');
const { todayJalali, addDaysToJalali } = require('../jalali');
const {
  sqlInvoiceAmountRial, getSettingInt, PIPELINE_STAGES, normalizeStage,
  computeCustomerMetrics,
} = require('./crm-pro');
const { resolveEffectiveUserId, chequeKpis } = require('./crm-analytics-scope');

const INTERVALS = new Set(['day', 'week', 'month']);
const INVOICE_TYPES = new Set(['proforma', 'normal', 'final']);
const ACTIVITY_TYPES = new Set(['call', 'meeting', 'message', 'visit', 'note', 'task', 'complaint', 'service']);
const SEGMENTS = new Set(['VIP', 'A', 'B', 'C', 'churn_risk', 'inactive', 'new']);
const STAGE_SET = new Set(PIPELINE_STAGES);

const DRILL_METRICS = new Set([
  'new_leads', 'open_opportunities', 'won_opportunities', 'lost_opportunities',
  'stale_opportunities', 'open_followups', 'overdue_followups', 'due_today_followups',
  'new_customers', 'repeat_customers', 'inactive_customers_90d', 'churn_risk_customers',
  'firm_sales', 'proforma', 'normal', 'final',
  'receivables', 'overdue_receivables', 'cheques_due', 'cheques_bounced',
  'pipeline_lead', 'pipeline_qualified', 'pipeline_proposal', 'pipeline_negotiation',
  'pipeline_first_order', 'pipeline_won', 'pipeline_repeat', 'pipeline_lost',
  'funnel_lead', 'funnel_qualified', 'funnel_proposal', 'funnel_negotiation',
  'funnel_firm', 'funnel_repeat',
  'expert_sales', 'campaign_sales', 'source_sales', 'product_sales',
  'activities_open', 'activities_done', 'activities_today', 'activities_overdue',
]);

function parseLimit(raw, fallback = 50, max = 200) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(max, n);
}

function parsePage(raw) {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function prevPeriod(from, to) {
  if (!from || !to) return { from: '', to: '' };
  const a = String(from).split('/').map(Number);
  const b = String(to).split('/').map(Number);
  if (a.length !== 3 || b.length !== 3) return { from: '', to: '' };
  const start = Date.UTC(a[0], a[1] - 1, a[2]);
  const end = Date.UTC(b[0], b[1] - 1, b[2]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return { from: '', to: '' };
  const days = Math.round((end - start) / 86400000) + 1;
  return { from: addDaysToJalali(from, -days), to: addDaysToJalali(from, -1) };
}

function parseFilters(raw = {}, scopeUserId = null) {
  const userId = resolveEffectiveUserId(scopeUserId, raw);
  const interval = INTERVALS.has(String(raw.interval || '')) ? String(raw.interval) : 'month';
  const invoiceType = INVOICE_TYPES.has(String(raw.invoice_type || '')) ? String(raw.invoice_type) : '';
  const activityType = ACTIVITY_TYPES.has(String(raw.activity_type || '')) ? String(raw.activity_type) : '';
  const rawStage = String(raw.pipeline_stage || raw.stage || '').trim();
  let stage = '';
  if (rawStage) {
    if (STAGE_SET.has(rawStage)) stage = rawStage;
    else if (rawStage === 'contact') stage = 'qualified';
  }
  const segment = SEGMENTS.has(String(raw.segment || '')) ? String(raw.segment) : '';
  const filters = {
    from: String(raw.from || '').trim(),
    to: String(raw.to || '').trim(),
    user_id: userId,
    party_group_id: raw.party_group_id ? parseInt(raw.party_group_id, 10) : null,
    province: String(raw.province || '').trim(),
    city: String(raw.city || '').trim(),
    lead_source: String(raw.lead_source || '').trim(),
    campaign: String(raw.campaign || '').trim(),
    pipeline_stage: stage,
    segment,
    customer_id: raw.customer_id || raw.cust_id ? parseInt(raw.customer_id || raw.cust_id, 10) : null,
    party_id: raw.party_id ? parseInt(raw.party_id, 10) : null,
    product_id: raw.product_id ? parseInt(raw.product_id, 10) : null,
    product_category_id: raw.product_category_id ? parseInt(raw.product_category_id, 10) : null,
    invoice_type: invoiceType,
    activity_type: activityType,
    status: String(raw.status || '').trim(),
    interval,
    limit: parseLimit(raw.limit, 50),
    page: parsePage(raw.page),
    offset: Math.max(0, parseInt(raw.offset, 10) || 0),
  };
  if (!Number.isFinite(filters.party_group_id) || filters.party_group_id <= 0) filters.party_group_id = null;
  if (!Number.isFinite(filters.customer_id) || filters.customer_id <= 0) filters.customer_id = null;
  if (!Number.isFinite(filters.party_id) || filters.party_id <= 0) filters.party_id = null;
  if (!Number.isFinite(filters.product_id) || filters.product_id <= 0) filters.product_id = null;
  if (!Number.isFinite(filters.product_category_id) || filters.product_category_id <= 0) filters.product_category_id = null;
  return filters;
}

function appliedFilters(f) {
  return {
    from: f.from, to: f.to, user_id: f.user_id, party_group_id: f.party_group_id,
    province: f.province, city: f.city, lead_source: f.lead_source, campaign: f.campaign,
    pipeline_stage: f.pipeline_stage, segment: f.segment, customer_id: f.customer_id,
    party_id: f.party_id, product_id: f.product_id, product_category_id: f.product_category_id,
    invoice_type: f.invoice_type, activity_type: f.activity_type, status: f.status,
    interval: f.interval,
  };
}

function addCustFilters(where, params, f, alias = 'c') {
  if (f.user_id) { where.push(`${alias}.user_id=?`); params.push(f.user_id); }
  if (f.province) { where.push(`(${alias}.province=? OR ${alias}.city LIKE ?)`); params.push(f.province, '%' + f.province + '%'); }
  if (f.city) { where.push(`${alias}.city=?`); params.push(f.city); }
  if (f.party_group_id) {
    where.push(`EXISTS (SELECT 1 FROM parties p WHERE p.legacy_table='customers' AND p.legacy_id=${alias}.id AND p.party_group_id=?)`);
    params.push(f.party_group_id);
  }
  if (f.lead_source) { where.push(`COALESCE(${alias}.lead_source,${alias}.source,'')=?`); params.push(f.lead_source); }
  if (f.campaign) { where.push(`${alias}.campaign=?`); params.push(f.campaign); }
  if (f.customer_id) { where.push(`${alias}.id=?`); params.push(f.customer_id); }
  if (f.party_id) { where.push(`${alias}.party_id=?`); params.push(f.party_id); }
  if (f.segment) {
    where.push(`EXISTS (SELECT 1 FROM crm_customer_segments s WHERE s.customer_id=${alias}.id AND s.effective_segment=?)`);
    params.push(f.segment);
  }
}

function jalaliDayBounds(jStr) {
  const { j2g } = require('../jalali');
  const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(String(jStr || '').trim());
  if (!m) return null;
  const [gy, gm, gd] = j2g(+m[1], +m[2], +m[3]);
  const start = Math.floor(new Date(gy, gm - 1, gd, 0, 0, 0).getTime() / 1000);
  return { start, end: start + 86400 - 1 };
}

function addLinkedCustFilters(where, params, f, idExpr) {
  if (!f.province && !f.city && !f.party_group_id && !f.segment) return;
  const sub = [`c.id=${idExpr}`];
  const subP = [];
  addCustFilters(sub, subP, {
    user_id: null, province: f.province, city: f.city, party_group_id: f.party_group_id,
    segment: f.segment, lead_source: '', campaign: '', customer_id: null, party_id: null,
  }, 'c');
  where.push(`EXISTS (SELECT 1 FROM customers c WHERE ${sub.join(' AND ')})`);
  params.push(...subP);
}

function addInvFilters(where, params, f, alias = 'i') {
  where.push(`COALESCE(${alias}.deleted_at,0)=0`);
  where.push(`COALESCE(${alias}.status,'posted')<>'reversed'`);
  if (f.user_id) { where.push(`${alias}.user_id=?`); params.push(f.user_id); }
  if (f.from) { where.push(`${alias}.date>=?`); params.push(f.from); }
  if (f.to) { where.push(`${alias}.date<=?`); params.push(f.to); }
  if (f.lead_source) { where.push(`${alias}.lead_source=?`); params.push(f.lead_source); }
  if (f.campaign) { where.push(`${alias}.campaign=?`); params.push(f.campaign); }
  if (f.invoice_type) { where.push(`${alias}.type=?`); params.push(f.invoice_type); }
  if (f.customer_id) { where.push(`${alias}.cust_id=?`); params.push(f.customer_id); }
  if (f.party_id) { where.push(`${alias}.party_id=?`); params.push(f.party_id); }
  addLinkedCustFilters(where, params, f, `${alias}.cust_id`);
}

function addFuFilters(where, params, f, alias = 'f') {
  if (f.user_id) { where.push(`${alias}.user_id=?`); params.push(f.user_id); }
  if (f.from) { where.push(`${alias}.date>=?`); params.push(f.from); }
  if (f.to) { where.push(`${alias}.date<=?`); params.push(f.to); }
  if (f.customer_id) { where.push(`${alias}.cust_id=?`); params.push(f.customer_id); }
  if (f.pipeline_stage) { where.push(`COALESCE(${alias}.pipeline_stage,'lead')=?`); params.push(f.pipeline_stage); }
  if (f.status) { where.push(`${alias}.status=?`); params.push(f.status); }
  if (f.activity_type) { where.push(`${alias}.type LIKE ?`); params.push('%' + f.activity_type + '%'); }
  addLinkedCustFilters(where, params, f, `${alias}.cust_id`);
}

function addOppFilters(where, params, f, alias = 'o') {
  if (f.user_id) {
    where.push(`(${alias}.owner_user_id=? OR ${alias}.customer_id IN (SELECT id FROM customers WHERE user_id=?))`);
    params.push(f.user_id, f.user_id);
  }
  if (f.from) {
    const b = jalaliDayBounds(f.from);
    if (b) { where.push(`COALESCE(${alias}.created_at,0)>=?`); params.push(b.start); }
  }
  if (f.to) {
    const b = jalaliDayBounds(f.to);
    if (b) { where.push(`COALESCE(${alias}.created_at,0)<=?`); params.push(b.end); }
  }
  if (f.pipeline_stage) { where.push(`${alias}.pipeline_stage=?`); params.push(f.pipeline_stage); }
  if (f.lead_source) { where.push(`${alias}.lead_source=?`); params.push(f.lead_source); }
  if (f.campaign) { where.push(`${alias}.campaign=?`); params.push(f.campaign); }
  if (f.customer_id) { where.push(`${alias}.customer_id=?`); params.push(f.customer_id); }
  if (f.status) { where.push(`${alias}.status=?`); params.push(f.status); }
  addLinkedCustFilters(where, params, f, `${alias}.customer_id`);
}

function safeRate(num, den) {
  if (!den) return { rate: null, numerator: num, denominator: 0 };
  return { rate: Math.round((num / den) * 10000) / 100, numerator: num, denominator: den };
}

function delta(cur, prev) {
  const change = (Number(cur) || 0) - (Number(prev) || 0);
  const pct = prev ? Math.round((change / prev) * 10000) / 100 : null;
  return { current: Number(cur) || 0, previous: Number(prev) || 0, change, change_percent: pct };
}

function buildKpis(db, filters, scopeUserId) {
  const f = parseFilters(filters, scopeUserId);
  const prev = prevPeriod(f.from, f.to);
  const cur = computeKpiSet(db, f);
  const prevSet = (prev.from && prev.to) ? computeKpiSet(db, { ...f, from: prev.from, to: prev.to }) : null;
  const wrap = (key, invertGood = false) => {
    if (/_rate$/.test(key) && cur[key] == null) {
      return {
        current: null, previous: prevSet ? prevSet[key] : null,
        change: null, change_percent: null, invert_good: invertGood,
        formula: KPI_FORMULAS[key] || '',
      };
    }
    const d = delta(cur[key], prevSet ? prevSet[key] : 0);
    return { ...d, invert_good: invertGood, formula: KPI_FORMULAS[key] || '' };
  };
  const kpis = {};
  for (const key of Object.keys(cur)) {
    if (key.startsWith('_')) continue;
    const invert = /lost|overdue|bounced|churn|stale|inactive|complaint/.test(key);
    kpis[key] = wrap(key, invert);
  }
  return { kpis, applied_filters: appliedFilters(f), previous_period: prev };
}

const KPI_FORMULAS = {
  new_leads: 'تعداد فرصت‌هایی که مرحله‌شان lead است و در بازه ایجاد شده‌اند (pipeline_stage، نه status فعالیت)',
  open_opportunities: 'فرصت‌های status=open',
  pipeline_value_rial: 'جمع estimated_amount_rial فرصت‌های باز',
  pipeline_weighted_rial: 'جمع weighted_amount_rial فرصت‌های باز',
  won_opportunities: 'فرصت‌های stage در first_order|won|repeat',
  lost_opportunities: 'فرصت‌های stage=lost',
  win_rate: 'won / (won+lost)؛ اگر مخرج صفر → null',
  lead_to_proforma_rate: 'تعداد پیش‌فاکتور / سرنخ‌های بازه',
  proforma_to_firm_rate: 'فاکتور قطعی / پیش‌فاکتور',
  lead_to_firm_rate: 'فاکتور قطعی / سرنخ',
  firm_sales_rial: 'جمع مبلغ فاکتورهای normal|final غیر reversed',
  firm_invoice_count: 'تعداد فاکتورهای normal|final غیر reversed',
  avg_order_rial: 'firm_sales_rial / firm_invoice_count',
  new_customers: 'مشتریان ایجادشده در بازه',
  repeat_customers: 'مشتریان با بیش از یک فاکتور قطعی در بازه',
  open_followups: 'پیگیری status=open',
  due_today_followups: 'پیگیری باز با next_date=امروز',
  overdue_followups: 'پیگیری باز با next_date < امروز',
  stale_opportunities: 'فرصت باز با entered_stage_at قدیمی‌تر از آستانه تنظیمات',
  inactive_customers_90d: 'بدون فاکتور قطعی و پیگیری در ۹۰ روز',
  churn_risk_customers: 'effective_segment=churn_risk',
  receivables_rial: 'جمع مانده دفتر مشتری (ریال)',
  overdue_receivables_rial: 'مانده فاکتورهای قطعی با تاریخ قبل از آستانه سررسید',
  cheques_due: 'چک incoming نزدیک سررسید طبق تنظیم',
  cheques_bounced: 'چک برگشتی غیر reversed',
  sales_target_percent: 'فروش قطعی بازه / جمع monthly_target کارشناسان (ریال)',
};

function computeKpiSet(db, f) {
  const today = todayJalali();
  const staleDays = getSettingInt(db, 'crm_stale_opportunity_days', 14);
  const chequeDays = getSettingInt(db, 'crm_cheque_due_days', 14);
  const overdueDays = getSettingInt(db, 'crm_overdue_receivable_days', 30);
  const dueLimit = addDaysToJalali(today, chequeDays);
  const overdueBefore = addDaysToJalali(today, -overdueDays);
  const inactiveSince = addDaysToJalali(today, -90);
  const staleCutoff = Math.floor(Date.now() / 1000) - staleDays * 86400;

  const custWhere = ['1=1']; const custParams = [];
  addCustFilters(custWhere, custParams, f);
  if (f.from) { const b = jalaliDayBounds(f.from); if (b) { custWhere.push('COALESCE(c.created_at,0)>=?'); custParams.push(b.start); } }
  if (f.to) { const b = jalaliDayBounds(f.to); if (b) { custWhere.push('COALESCE(c.created_at,0)<=?'); custParams.push(b.end); } }

  const invWhere = []; const invParams = [];
  addInvFilters(invWhere, invParams, f);
  const fuWhere = ['1=1']; const fuParams = [];
  addFuFilters(fuWhere, fuParams, f);
  const oppWhere = ['1=1']; const oppParams = [];
  addOppFilters(oppWhere, oppParams, f);

  const newCustomers = db.prepare(`SELECT COUNT(*) AS c FROM customers c WHERE ${custWhere.join(' AND ')}`).get(...custParams)?.c || 0;
  const openFollowups = db.prepare(`SELECT COUNT(*) AS c FROM followups f WHERE ${fuWhere.join(' AND ')} AND f.status='open'`).get(...fuParams)?.c || 0;
  const overdueFollowups = db.prepare(`SELECT COUNT(*) AS c FROM followups f WHERE ${fuWhere.join(' AND ')} AND f.status='open' AND f.next_date<>'' AND f.next_date < ?`).get(...fuParams, today)?.c || 0;
  const dueToday = db.prepare(`SELECT COUNT(*) AS c FROM followups f WHERE ${fuWhere.join(' AND ')} AND f.status='open' AND f.next_date=?`).get(...fuParams, today)?.c || 0;

  const firm = db.prepare(`
    SELECT COUNT(*) AS cnt, COALESCE(SUM(${sqlInvoiceAmountRial('i')}),0) AS amount_rial
    FROM invoices i WHERE ${invWhere.join(' AND ')} AND ${firmSaleTypeSql('i')}
  `).get(...invParams);
  const proforma = db.prepare(`SELECT COUNT(*) AS c FROM invoices i WHERE ${invWhere.join(' AND ')} AND i.type='proforma'`).get(...invParams)?.c || 0;

  const hasOpp = !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='crm_opportunities'").get();
  let newLeads = 0, openOpps = 0, pipeVal = 0, pipeW = 0, wonOpps = 0, lostOpps = 0, staleOpps = 0;
  if (hasOpp) {
    newLeads = db.prepare(`SELECT COUNT(*) AS c FROM crm_opportunities o WHERE ${oppWhere.join(' AND ')} AND o.pipeline_stage='lead'`).get(...oppParams)?.c || 0;
    const openRow = db.prepare(`
      SELECT COUNT(*) AS c, COALESCE(SUM(estimated_amount_rial),0) AS v, COALESCE(SUM(weighted_amount_rial),0) AS w
      FROM crm_opportunities o WHERE ${oppWhere.join(' AND ')} AND o.status='open'
    `).get(...oppParams);
    openOpps = openRow?.c || 0; pipeVal = openRow?.v || 0; pipeW = openRow?.w || 0;
    wonOpps = db.prepare(`SELECT COUNT(*) AS c FROM crm_opportunities o WHERE ${oppWhere.join(' AND ')} AND o.pipeline_stage IN ('first_order','won','repeat')`).get(...oppParams)?.c || 0;
    lostOpps = db.prepare(`SELECT COUNT(*) AS c FROM crm_opportunities o WHERE ${oppWhere.join(' AND ')} AND o.pipeline_stage='lost'`).get(...oppParams)?.c || 0;
    staleOpps = db.prepare(`SELECT COUNT(*) AS c FROM crm_opportunities o WHERE ${oppWhere.join(' AND ')} AND o.status='open' AND COALESCE(o.entered_stage_at,o.updated_at,0)<?`).get(...oppParams, staleCutoff)?.c || 0;
  } else {
    newLeads = db.prepare(`SELECT COUNT(*) AS c FROM followups f WHERE ${fuWhere.join(' AND ')} AND COALESCE(f.pipeline_stage,'lead')='lead'`).get(...fuParams)?.c || 0;
    openOpps = db.prepare(`SELECT COUNT(DISTINCT f.cust_id) AS c FROM followups f WHERE ${fuWhere.join(' AND ')} AND COALESCE(f.pipeline_stage,'lead') NOT IN ('lost','won','first_order','repeat')`).get(...fuParams)?.c || 0;
  }

  const inactiveCustWhere = ['1=1']; const inactiveParams = [];
  addCustFilters(inactiveCustWhere, inactiveParams, { ...f, from: '', to: '' });
  const inactiveCustomers = db.prepare(`
    SELECT COUNT(*) AS c FROM customers c
    WHERE ${inactiveCustWhere.join(' AND ')}
      AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.cust_id=c.id AND ${firmSaleTypeSql('i')} AND COALESCE(i.deleted_at,0)=0 AND i.date>=?)
      AND NOT EXISTS (SELECT 1 FROM followups fu WHERE fu.cust_id=c.id AND fu.date>=?)
  `).get(...inactiveParams, inactiveSince, inactiveSince)?.c || 0;

  let churnRisk = 0;
  try {
    const chWhere = ["s.effective_segment='churn_risk'"]; const chParams = [];
    addCustFilters(chWhere, chParams, { ...f, from: '', to: '' });
    churnRisk = db.prepare(`
      SELECT COUNT(*) AS c FROM crm_customer_segments s
      JOIN customers c ON c.id=s.customer_id
      WHERE ${chWhere.join(' AND ')}
    `).get(...chParams)?.c || 0;
  } catch (_) {}

  let receivables = 0;
  try {
    receivables = f.user_id
      ? db.prepare(`SELECT COALESCE(SUM(cl.debit-cl.credit),0) AS bal FROM customer_ledger cl JOIN customers c ON c.id=cl.customer_id WHERE c.user_id=?`).get(f.user_id)?.bal || 0
      : db.prepare(`SELECT COALESCE(SUM(debit-credit),0) AS bal FROM customer_ledger`).get()?.bal || 0;
    receivables = Math.round(Number(receivables) || 0);
  } catch (_) {}

  let overdueRecv = 0;
  try {
    const recvWhere = ['1=1']; const recvParams = [];
    if (f.user_id) { recvWhere.push('c.user_id=?'); recvParams.push(f.user_id); }
    overdueRecv = db.prepare(`
      SELECT COALESCE(SUM(x.bal),0) AS bal FROM (
        SELECT cl.customer_id, SUM(cl.debit-cl.credit) AS bal
        FROM customer_ledger cl
        JOIN customers c ON c.id=cl.customer_id
        WHERE ${recvWhere.join(' AND ')}
        GROUP BY cl.customer_id
        HAVING bal>0 AND EXISTS (
          SELECT 1 FROM invoices i
          WHERE i.cust_id=cl.customer_id AND ${firmSaleTypeSql('i')}
            AND COALESCE(i.deleted_at,0)=0 AND COALESCE(i.status,'posted')<>'reversed'
            AND i.date<=?
        )
      ) x
    `).get(...recvParams, overdueBefore)?.bal || 0;
    overdueRecv = Math.round(Number(overdueRecv) || 0);
  } catch (_) { overdueRecv = 0; }

  const chq = chequeKpis(db, f.user_id, { dueDays: chequeDays });
  void dueLimit;

  const repeatCustomers = db.prepare(`
    SELECT COUNT(*) AS c FROM (
      SELECT i.cust_id FROM invoices i
      WHERE ${invWhere.join(' AND ')} AND ${firmSaleTypeSql('i')}
      GROUP BY i.cust_id HAVING COUNT(*)>1
    )
  `).get(...invParams)?.c || 0;

  let targetRial = 0;
  try {
    const t = f.user_id
      ? db.prepare('SELECT COALESCE(monthly_target,0) AS t FROM users WHERE id=?').get(f.user_id)?.t
      : db.prepare("SELECT COALESCE(SUM(monthly_target),0) AS t FROM users WHERE COALESCE(active,1)=1 AND role IN ('field_sales','inside_sales','sales_manager')").get()?.t;
    targetRial = Math.round(Number(t) || 0);
    // monthly_target historically toman in UI — if values look like toman (< 1e7 while sales are rial), do not invent ×10; treat as stored.
  } catch (_) {}

  const firmCnt = Number(firm?.cnt) || 0;
  const firmAmt = Number(firm?.amount_rial) || 0;
  const win = safeRate(wonOpps, wonOpps + lostOpps);
  const l2p = safeRate(proforma, newLeads);
  const p2f = safeRate(firmCnt, proforma);
  const l2f = safeRate(firmCnt, newLeads);
  const tgt = safeRate(firmAmt, targetRial);

  let openComplaints = 0;
  try {
    openComplaints = db.prepare(`
      SELECT COUNT(*) AS c FROM crm_activities a
      WHERE a.type='complaint' AND a.status='open' ${f.user_id ? 'AND a.owner_user_id=?' : ''}
    `).get(...(f.user_id ? [f.user_id] : []))?.c || 0;
  } catch (_) {}

  return {
    new_leads: newLeads,
    open_opportunities: openOpps,
    pipeline_value_rial: pipeVal,
    pipeline_weighted_rial: pipeW,
    won_opportunities: wonOpps,
    lost_opportunities: lostOpps,
    win_rate: win.rate,
    lead_to_proforma_rate: l2p.rate,
    proforma_to_firm_rate: p2f.rate,
    lead_to_firm_rate: l2f.rate,
    firm_sales_rial: firmAmt,
    firm_invoice_count: firmCnt,
    avg_order_rial: firmCnt ? Math.round(firmAmt / firmCnt) : 0,
    new_customers: newCustomers,
    repeat_customers: repeatCustomers,
    open_followups: openFollowups,
    due_today_followups: dueToday,
    overdue_followups: overdueFollowups,
    stale_opportunities: staleOpps,
    inactive_customers_90d: inactiveCustomers,
    churn_risk_customers: churnRisk,
    receivables_rial: receivables,
    overdue_receivables_rial: overdueRecv,
    cheques_due: chq.chequesDue,
    cheques_bounced: chq.chequesBounced,
    sales_target_percent: tgt.rate,
    open_complaints: openComplaints,
    _win: win, _l2p: l2p, _p2f: p2f, _l2f: l2f,
  };
}

function buildPipeline(db, filters, scopeUserId) {
  const f = parseFilters(filters, scopeUserId);
  const where = ['1=1']; const params = [];
  addOppFilters(where, params, f);
  const hasOpp = !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='crm_opportunities'").get();
  let rows = [];
  if (hasOpp) {
    rows = db.prepare(`
      SELECT pipeline_stage AS stage, COUNT(*) AS cnt,
        COALESCE(SUM(estimated_amount_rial),0) AS amount_rial,
        COALESCE(SUM(weighted_amount_rial),0) AS weighted_amount_rial
      FROM crm_opportunities o
      WHERE ${where.join(' AND ')}
      GROUP BY pipeline_stage
    `).all(...params);
  } else {
    const fu = ['1=1']; const fp = [];
    addFuFilters(fu, fp, f);
    rows = db.prepare(`
      SELECT COALESCE(f.pipeline_stage,'lead') AS stage, COUNT(*) AS cnt, 0 AS amount_rial, 0 AS weighted_amount_rial
      FROM followups f WHERE ${fu.join(' AND ')}
      GROUP BY COALESCE(f.pipeline_stage,'lead')
    `).all(...fp);
  }
  const by = Object.fromEntries(rows.map((r) => [normalizeStage(r.stage), r]));
  const stages = PIPELINE_STAGES.map((stage) => ({
    stage,
    cnt: by[stage]?.cnt || 0,
    amount_rial: by[stage]?.amount_rial || 0,
    weighted_amount_rial: by[stage]?.weighted_amount_rial || 0,
  }));
  return { stages, applied_filters: appliedFilters(f) };
}

function buildConversionFunnel(db, filters, scopeUserId) {
  const f = parseFilters(filters, scopeUserId);
  const pipe = buildPipeline(db, f, scopeUserId);
  const invWhere = []; const invParams = [];
  addInvFilters(invWhere, invParams, f);
  const firm = db.prepare(`SELECT COUNT(DISTINCT i.cust_id) AS c FROM invoices i WHERE ${invWhere.join(' AND ')} AND ${firmSaleTypeSql('i')}`).get(...invParams)?.c || 0;
  const repeat = db.prepare(`
    SELECT COUNT(*) AS c FROM (
      SELECT i.cust_id FROM invoices i WHERE ${invWhere.join(' AND ')} AND ${firmSaleTypeSql('i')}
      GROUP BY i.cust_id HAVING COUNT(*)>1
    )
  `).get(...invParams)?.c || 0;
  const step = (id, label, count) => ({ id, label, count });
  const stages = pipe.stages;
  const countOf = (...ids) => ids.reduce((a, id) => a + (stages.find((s) => s.stage === id)?.cnt || 0), 0);
  const funnel = [
    step('lead', 'سرنخ', countOf('lead')),
    step('qualified', 'واجد شرایط', countOf('qualified')),
    step('proposal', 'پیشنهاد/پیش‌فاکتور', countOf('proposal')),
    step('negotiation', 'مذاکره', countOf('negotiation')),
    step('firm', 'فروش قطعی', firm),
    step('repeat', 'مشتری تکراری', repeat),
  ];
  return { funnel, applied_filters: appliedFilters(f) };
}

function buildSalesTrend(db, filters, scopeUserId) {
  const f = parseFilters(filters, scopeUserId);
  const invWhere = []; const invParams = [];
  addInvFilters(invWhere, invParams, f);
  const bucket = f.interval === 'month' ? `substr(i.date,1,7)` : `i.date`;
  const rows = db.prepare(`
    SELECT ${bucket} AS bucket, COUNT(*) AS invoice_count,
      COALESCE(SUM(${sqlInvoiceAmountRial('i')}),0) AS amount_rial
    FROM invoices i
    WHERE ${invWhere.join(' AND ')} AND ${firmSaleTypeSql('i')}
    GROUP BY bucket ORDER BY bucket LIMIT 120
  `).all(...invParams);
  const prev = prevPeriod(f.from, f.to);
  let previous = [];
  if (prev.from && prev.to) {
    const pWhere = []; const pParams = [];
    addInvFilters(pWhere, pParams, { ...f, from: prev.from, to: prev.to });
    previous = db.prepare(`
      SELECT ${bucket} AS bucket, COUNT(*) AS invoice_count,
        COALESCE(SUM(${sqlInvoiceAmountRial('i')}),0) AS amount_rial
      FROM invoices i
      WHERE ${pWhere.join(' AND ')} AND ${firmSaleTypeSql('i')}
      GROUP BY bucket ORDER BY bucket LIMIT 120
    `).all(...pParams);
  }
  return { interval: f.interval, series: rows, previous, applied_filters: appliedFilters(f) };
}

function buildActivityTrend(db, filters, scopeUserId) {
  const f = parseFilters(filters, scopeUserId);
  const where = ['1=1']; const params = [];
  addFuFilters(where, params, f);
  const rows = db.prepare(`
    SELECT f.date AS bucket,
      SUM(CASE WHEN f.status='done' THEN 1 ELSE 0 END) AS done,
      SUM(CASE WHEN f.status='open' THEN 1 ELSE 0 END) AS open,
      COUNT(*) AS total
    FROM followups f WHERE ${where.join(' AND ')}
    GROUP BY f.date ORDER BY f.date LIMIT 120
  `).all(...params);
  return { series: rows, applied_filters: appliedFilters(f) };
}

function buildExpertPerformance(db, filters, scopeUserId) {
  const f = parseFilters(filters, scopeUserId);
  const invWhere = []; const invParams = [];
  addInvFilters(invWhere, invParams, f);
  const sales = db.prepare(`
    SELECT u.id, u.name, COALESCE(u.monthly_target,0) AS monthly_target,
      COUNT(i.id) AS invoice_count,
      COALESCE(SUM(${sqlInvoiceAmountRial('i')}),0) AS sales_rial
    FROM users u
    LEFT JOIN invoices i ON i.user_id=u.id AND ${invWhere.join(' AND ')} AND ${firmSaleTypeSql('i')}
    WHERE COALESCE(u.active,1)=1
      ${f.user_id ? 'AND u.id=?' : ''}
    GROUP BY u.id ORDER BY sales_rial DESC LIMIT 50
  `).all(...invParams, ...(f.user_id ? [f.user_id] : []));
  const hasOpp = !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='crm_opportunities'").get();
  const rows = sales.map((r) => {
    const won = hasOpp
      ? db.prepare(`SELECT COUNT(*) AS c FROM crm_opportunities WHERE owner_user_id=? AND pipeline_stage IN ('first_order','won','repeat')`).get(r.id)?.c || 0
      : 0;
    const lost = hasOpp
      ? db.prepare(`SELECT COUNT(*) AS c FROM crm_opportunities WHERE owner_user_id=? AND pipeline_stage='lost'`).get(r.id)?.c || 0
      : 0;
    const followups = db.prepare(`SELECT COUNT(*) AS c FROM followups WHERE user_id=?`).get(r.id)?.c || 0;
    let collected = 0;
    try {
      collected = db.prepare(`
        SELECT COALESCE(SUM(COALESCE(s.amount_rial, ROUND(s.amount),0)),0) AS a
        FROM settlements s JOIN customers c ON c.id=s.cust_id WHERE c.user_id=?
        ${f.from ? 'AND s.date>=?' : ''} ${f.to ? 'AND s.date<=?' : ''}
      `).get(...[r.id, f.from || null, f.to || null].filter((x) => x != null && x !== ''))?.a || 0;
    } catch (_) {}
    const conv = safeRate(won, won + lost);
    const target = Number(r.monthly_target) || 0;
    const tgt = safeRate(r.sales_rial, target);
    return {
      id: r.id, name: r.name,
      sales_rial: r.sales_rial, invoice_count: r.invoice_count,
      won_opportunities: won, conversion_rate: conv.rate,
      collected_rial: Math.round(Number(collected) || 0),
      followup_count: followups,
      target_rial: target, target_percent: tgt.rate,
    };
  });
  return { experts: rows, applied_filters: appliedFilters(f) };
}

function buildCampaignPerformance(db, filters, scopeUserId) {
  const f = parseFilters(filters, scopeUserId);
  const invWhere = []; const invParams = [];
  addInvFilters(invWhere, invParams, f);
  const sales = db.prepare(`
    SELECT COALESCE(NULLIF(i.campaign,''),'(بدون کمپین)') AS campaign,
      COUNT(*) AS invoice_count,
      COALESCE(SUM(${sqlInvoiceAmountRial('i')}),0) AS sales_rial
    FROM invoices i WHERE ${invWhere.join(' AND ')} AND ${firmSaleTypeSql('i')}
    GROUP BY COALESCE(NULLIF(i.campaign,''),'(بدون کمپین)')
    ORDER BY sales_rial DESC LIMIT 40
  `).all(...invParams);
  const hasOpp = !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='crm_opportunities'").get();
  const rows = sales.map((r) => {
    const ow = ['COALESCE(NULLIF(o.campaign,\'\'),\'(بدون کمپین)\')=?']; const op = [r.campaign];
    addOppFilters(ow, op, { ...f, campaign: '' });
    const leads = hasOpp
      ? db.prepare(`SELECT COUNT(*) AS c FROM crm_opportunities o WHERE ${ow.join(' AND ')}`).get(...op)?.c || 0
      : db.prepare(`SELECT COUNT(*) AS c FROM followups f JOIN customers c ON c.id=f.cust_id WHERE COALESCE(NULLIF(c.campaign,''),'(بدون کمپین)')=? ${f.user_id ? 'AND f.user_id=?' : ''}`).get(...(f.user_id ? [r.campaign, f.user_id] : [r.campaign]))?.c || 0;
    const costRow = db.prepare('SELECT cost_rial FROM crm_campaigns WHERE name=? OR code=?').get(r.campaign, r.campaign);
    const cost = Number(costRow?.cost_rial) || 0;
    return {
      campaign: r.campaign, leads, opportunities: leads,
      invoice_count: r.invoice_count, sales_rial: r.sales_rial,
      conversion_rate: safeRate(r.invoice_count, leads).rate,
      cost_rial: cost || null,
      roi: cost > 0 ? Math.round(((r.sales_rial - cost) / cost) * 10000) / 100 : null,
    };
  });
  return { campaigns: rows, applied_filters: appliedFilters(f) };
}

function buildSourcePerformance(db, filters, scopeUserId) {
  const f = parseFilters(filters, scopeUserId);
  const invWhere = []; const invParams = [];
  addInvFilters(invWhere, invParams, f);
  const sales = db.prepare(`
    SELECT COALESCE(NULLIF(i.lead_source,''),'(بدون منبع)') AS lead_source,
      COUNT(*) AS invoice_count,
      COALESCE(SUM(${sqlInvoiceAmountRial('i')}),0) AS sales_rial
    FROM invoices i WHERE ${invWhere.join(' AND ')} AND ${firmSaleTypeSql('i')}
    GROUP BY COALESCE(NULLIF(i.lead_source,''),'(بدون منبع)')
    ORDER BY sales_rial DESC LIMIT 40
  `).all(...invParams);
  const hasOpp = !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='crm_opportunities'").get();
  const rows = sales.map((r) => {
    const ow = ['COALESCE(NULLIF(o.lead_source,\'\'),\'(بدون منبع)\')=?']; const op = [r.lead_source];
    addOppFilters(ow, op, { ...f, lead_source: '' });
    const leads = hasOpp
      ? db.prepare(`SELECT COUNT(*) AS c FROM crm_opportunities o WHERE ${ow.join(' AND ')}`).get(...op)?.c || 0
      : 0;
    return {
      lead_source: r.lead_source, leads,
      invoice_count: r.invoice_count, sales_rial: r.sales_rial,
      conversion_rate: safeRate(r.invoice_count, leads).rate,
    };
  });
  return { sources: rows, applied_filters: appliedFilters(f) };
}

function buildSegmentReport(db, filters, scopeUserId) {
  const f = parseFilters(filters, scopeUserId);
  const where = ['1=1']; const params = [];
  if (f.user_id) { where.push('c.user_id=?'); params.push(f.user_id); }
  if (f.segment) { where.push('s.effective_segment=?'); params.push(f.segment); }
  const rows = db.prepare(`
    SELECT s.effective_segment AS segment, COUNT(*) AS cnt,
      COALESCE(SUM(s.sales_90_rial),0) AS sales_90_rial
    FROM crm_customer_segments s
    JOIN customers c ON c.id=s.customer_id
    WHERE ${where.join(' AND ')}
    GROUP BY s.effective_segment
  `).all(...params);
  return { segments: rows, applied_filters: appliedFilters(f) };
}

function buildChurnRisk(db, filters, scopeUserId) {
  const f = parseFilters(filters, scopeUserId);
  const where = ["s.effective_segment IN ('churn_risk','inactive')"]; const params = [];
  if (f.user_id) { where.push('c.user_id=?'); params.push(f.user_id); }
  const limit = parseLimit(f.limit, 50);
  const offset = (f.page - 1) * limit;
  const total = db.prepare(`
    SELECT COUNT(*) AS c FROM crm_customer_segments s JOIN customers c ON c.id=s.customer_id
    WHERE ${where.join(' AND ')}
  `).get(...params)?.c || 0;
  const rows = db.prepare(`
    SELECT s.*, c.biz, c.user_id FROM crm_customer_segments s
    JOIN customers c ON c.id=s.customer_id
    WHERE ${where.join(' AND ')}
    ORDER BY s.churn_probability_percent DESC LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
  return { rows, total, page: f.page, page_size: limit, applied_filters: appliedFilters(f) };
}

function buildReceivables(db, filters, scopeUserId) {
  const f = parseFilters(filters, scopeUserId);
  const chq = chequeKpis(db, f.user_id, { dueDays: getSettingInt(db, 'crm_cheque_due_days', 14) });
  let receivables = 0;
  try {
    receivables = f.user_id
      ? db.prepare(`SELECT COALESCE(SUM(cl.debit-cl.credit),0) AS bal FROM customer_ledger cl JOIN customers c ON c.id=cl.customer_id WHERE c.user_id=?`).get(f.user_id)?.bal || 0
      : db.prepare(`SELECT COALESCE(SUM(debit-credit),0) AS bal FROM customer_ledger`).get()?.bal || 0;
  } catch (_) {}
  return {
    receivables_rial: Math.round(Number(receivables) || 0),
    cheques_due: chq.chequesDue,
    cheques_bounced: chq.chequesBounced,
    applied_filters: appliedFilters(f),
  };
}

function buildProductInsights(db, filters, scopeUserId) {
  const f = parseFilters(filters, scopeUserId);
  const invWhere = []; const invParams = [];
  addInvFilters(invWhere, invParams, f);
  let products = [];
  try {
    products = db.prepare(`
      SELECT p.id AS product_id, p.name, p.category_id,
        COUNT(DISTINCT i.id) AS invoice_count,
        COALESCE(SUM(CAST(json_extract(j.value,'$.qty') AS REAL) * COALESCE(CAST(json_extract(j.value,'$.price_rial') AS INTEGER), CAST(json_extract(j.value,'$.price') AS INTEGER),0)),0) AS amount_rial
      FROM invoices i
      JOIN json_each(i.rows) j
      JOIN products p ON p.id=CAST(json_extract(j.value,'$.id') AS INTEGER)
      WHERE ${invWhere.join(' AND ')} AND ${firmSaleTypeSql('i')}
        ${f.product_id ? 'AND p.id=?' : ''}
        ${f.product_category_id ? 'AND p.category_id=?' : ''}
      GROUP BY p.id ORDER BY amount_rial DESC LIMIT 20
    `).all(...invParams, ...(f.product_id ? [f.product_id] : []), ...(f.product_category_id ? [f.product_category_id] : []));
  } catch (_) {
    products = [];
  }
  return { products, applied_filters: appliedFilters(f) };
}

function buildUrgentActions(db, filters, scopeUserId) {
  const f = parseFilters(filters, scopeUserId);
  const today = todayJalali();
  const staleDays = getSettingInt(db, 'crm_stale_opportunity_days', 14);
  const staleCutoff = Math.floor(Date.now() / 1000) - staleDays * 86400;
  const fuWhere = ['f.status=\'open\'']; const fuParams = [];
  addFuFilters(fuWhere, fuParams, { ...f, status: '' });
  const overdue = db.prepare(`
    SELECT f.id, f.cust_id, f.subject, f.next_date, c.biz AS cust_biz, 'overdue_followup' AS kind
    FROM followups f LEFT JOIN customers c ON c.id=f.cust_id
    WHERE ${fuWhere.join(' AND ')} AND f.next_date<>'' AND f.next_date < ?
    ORDER BY f.next_date LIMIT 20
  `).all(...fuParams, today);
  let stale = [];
  try {
    const ow = ['o.status=\'open\'']; const op = [];
    addOppFilters(ow, op, f);
    stale = db.prepare(`
      SELECT o.id, o.customer_id AS cust_id, o.title AS subject, c.biz AS cust_biz, 'stale_opportunity' AS kind
      FROM crm_opportunities o LEFT JOIN customers c ON c.id=o.customer_id
      WHERE ${ow.join(' AND ')} AND COALESCE(o.entered_stage_at,o.updated_at,0)<?
      LIMIT 20
    `).all(...op, staleCutoff);
  } catch (_) {}
  let churn = [];
  try {
    churn = db.prepare(`
      SELECT s.customer_id AS id, s.customer_id AS cust_id, c.biz AS cust_biz, s.reason AS subject, 'churn_risk' AS kind
      FROM crm_customer_segments s JOIN customers c ON c.id=s.customer_id
      WHERE s.effective_segment='churn_risk' ${f.user_id ? 'AND c.user_id=?' : ''}
      LIMIT 20
    `).all(...(f.user_id ? [f.user_id] : []));
  } catch (_) {}
  return { overdue_followups: overdue, stale_opportunities: stale, churn_risk: churn, applied_filters: appliedFilters(f) };
}

function customerProfile(db, customerId, scopeUserId) {
  const own = db.prepare('SELECT user_id FROM customers WHERE id=?').get(customerId);
  if (scopeUserId) {
    if (!own || Number(own.user_id) !== Number(scopeUserId)) {
      const err = new Error('دسترسی به این مشتری ندارید');
      err.status = 403;
      throw err;
    }
  } else if (!own) {
    const err = new Error('مشتری یافت نشد');
    err.status = 404;
    throw err;
  }
  const { classifySegment } = require('./crm-pro');
  const seg = db.prepare('SELECT * FROM crm_customer_segments WHERE customer_id=?').get(customerId);
  const metrics = computeCustomerMetrics(db, customerId);
  if (seg) return { segment: seg, metrics };
  const cls = classifySegment(db, metrics);
  return {
    segment: { calculated_segment: cls.segment, effective_segment: cls.segment, reason: cls.reason },
    metrics,
  };
}

module.exports = {
  DRILL_METRICS,
  STAGE_SET,
  KPI_FORMULAS,
  parseFilters,
  appliedFilters,
  parseLimit,
  jalaliDayBounds,
  safeRate,
  buildKpis,
  computeKpiSet,
  buildPipeline,
  buildConversionFunnel,
  buildSalesTrend,
  buildActivityTrend,
  buildExpertPerformance,
  buildCampaignPerformance,
  buildSourcePerformance,
  buildSegmentReport,
  buildChurnRisk,
  buildReceivables,
  buildProductInsights,
  buildUrgentActions,
  customerProfile,
  addInvFilters,
  addFuFilters,
  addOppFilters,
  addCustFilters,
};
