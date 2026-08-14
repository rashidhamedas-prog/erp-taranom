/**
 * CRM Pro — opportunities, stage changes, segmentation, automations.
 * Read-only on financial documents; amounts stay INTEGER rial.
 */
const { firmSaleTypeSql } = require('./sales-document');
const { todayJalali, addDaysToJalali } = require('../jalali');
const { normalizeStage, defaultProb, mapFollowupType } = require('./crm-pro-schema');

const PIPELINE_STAGES = [
  'lead', 'qualified', 'proposal', 'negotiation', 'first_order', 'won', 'repeat', 'lost',
];
const STAGE_RANK = Object.fromEntries(PIPELINE_STAGES.map((s, i) => [s, i]));
const OPEN_STAGES = new Set(['lead', 'qualified', 'proposal', 'negotiation']);
const CLOSED_STAGES = new Set(['first_order', 'won', 'repeat', 'lost']);

function sqlInvoiceAmountRial(alias = 'i') {
  const a = alias ? `${alias}.` : '';
  return `COALESCE(NULLIF(${a}final_rial,0), ROUND(${a}final), 0)`;
}

function getSetting(db, key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  if (row == null || row.value == null || row.value === '') return fallback;
  return row.value;
}

function getSettingInt(db, key, fallback) {
  const n = parseInt(getSetting(db, key, String(fallback)), 10);
  return Number.isFinite(n) ? n : fallback;
}

function getSettingFloat(db, key, fallback) {
  const n = parseFloat(getSetting(db, key, String(fallback)));
  return Number.isFinite(n) ? n : fallback;
}

function clampProb(n) {
  const p = parseInt(n, 10);
  if (!Number.isFinite(p)) return 10;
  return Math.max(0, Math.min(100, p));
}

function weightedRial(amount, prob) {
  return Math.round((Number(amount) || 0) * clampProb(prob) / 100);
}

function assertOpportunityAccess(db, opp, scopeUserId) {
  if (scopeUserId == null || !opp) return;
  if (Number(opp.owner_user_id) !== Number(scopeUserId)) {
    const cust = db.prepare('SELECT user_id FROM customers WHERE id=?').get(opp.customer_id);
    if (!cust || Number(cust.user_id) !== Number(scopeUserId)) {
      const err = new Error('دسترسی به این فرصت ندارید');
      err.status = 403;
      throw err;
    }
  }
}

function findOpenOpportunity(db, customerId) {
  return db.prepare(`
    SELECT * FROM crm_opportunities
    WHERE customer_id=? AND status='open'
    ORDER BY updated_at DESC, id DESC LIMIT 1
  `).get(customerId);
}

function findLatestOpportunity(db, customerId) {
  return db.prepare(`
    SELECT * FROM crm_opportunities WHERE customer_id=?
    ORDER BY updated_at DESC, id DESC LIMIT 1
  `).get(customerId);
}

function changeOpportunityStage(db, opportunityId, toStage, {
  userId = null, reason = '', lostReason = '', wonInvoiceId = null, force = false,
} = {}) {
  const opp = db.prepare('SELECT * FROM crm_opportunities WHERE id=?').get(opportunityId);
  if (!opp) {
    const err = new Error('فرصت یافت نشد');
    err.status = 404;
    throw err;
  }
  const dest = normalizeStage(toStage);
  if (dest === normalizeStage(opp.pipeline_stage)) {
    return { opportunity: opp, changed: false };
  }
  if (CLOSED_STAGES.has(normalizeStage(opp.pipeline_stage)) && !force && OPEN_STAGES.has(dest)) {
    const err = new Error('بازگشایی مرحله بسته‌شده نیاز به مجوز دارد');
    err.status = 409;
    throw err;
  }
  if (dest === 'lost' && !String(lostReason || reason || '').trim()) {
    const err = new Error('دلیل باخت برای مرحله از دست رفته الزامی است');
    err.status = 400;
    throw err;
  }
  let invoiceId = wonInvoiceId || opp.won_invoice_id;
  if ((dest === 'won' || dest === 'first_order' || dest === 'repeat') && !invoiceId) {
    const inv = db.prepare(`
      SELECT id FROM invoices i
      WHERE i.cust_id=? AND ${firmSaleTypeSql('i')}
        AND COALESCE(i.deleted_at,0)=0 AND COALESCE(i.status,'posted')<>'reversed'
      ORDER BY i.date DESC, i.id DESC LIMIT 1
    `).get(opp.customer_id);
    invoiceId = inv?.id || null;
    if (dest === 'won' && !invoiceId) {
      const err = new Error('فرصت برنده باید به فاکتور قطعی معتبر متصل شود');
      err.status = 400;
      throw err;
    }
  }
  const now = Math.floor(Date.now() / 1000);
  const entered = Number(opp.entered_stage_at) || Number(opp.updated_at) || now;
  const duration = Math.max(0, now - entered);
  const status = dest === 'lost' ? 'lost' : (CLOSED_STAGES.has(dest) ? 'won' : 'open');
  const prob = dest === 'lost' ? 0 : (CLOSED_STAGES.has(dest) ? 100 : clampProb(opp.probability_percent || defaultProb(dest)));
  const weighted = weightedRial(opp.estimated_amount_rial, prob);
  db.transaction(() => {
    db.prepare(`
      INSERT INTO crm_stage_history (opportunity_id, from_stage, to_stage, changed_by, changed_at, duration_seconds, reason)
      VALUES (?,?,?,?,?,?,?)
    `).run(opp.id, opp.pipeline_stage, dest, userId, now, duration, reason || lostReason || '');
    db.prepare(`
      UPDATE crm_opportunities SET
        pipeline_stage=?, status=?, probability_percent=?, weighted_amount_rial=?,
        lost_reason=?, won_invoice_id=?, entered_stage_at=?, updated_at=?,
        closed_at=CASE WHEN ? IN ('lost','won','first_order','repeat') THEN ? ELSE closed_at END
      WHERE id=?
    `).run(
      dest, status, prob, weighted,
      dest === 'lost' ? String(lostReason || reason) : (opp.lost_reason || ''),
      invoiceId, now, now, dest, now, opp.id
    );
    db.prepare('UPDATE followups SET pipeline_stage=?, lost_reason=? WHERE opportunity_id=?')
      .run(dest, dest === 'lost' ? String(lostReason || reason) : '', opp.id);
  })();
  try {
    db.prepare(`
      INSERT INTO audit_log (user_id, action, entity, entity_id, detail, created_at)
      VALUES (?,?,?,?,?,?)
    `).run(userId, 'crm_stage_change', 'crm_opportunities', opp.id,
      JSON.stringify({ from: opp.pipeline_stage, to: dest, reason: reason || lostReason || '' }), now);
  } catch (_) { /* audit_log shape may vary */ }
  return { opportunity: db.prepare('SELECT * FROM crm_opportunities WHERE id=?').get(opp.id), changed: true };
}

function upsertOpportunityFromFollowup(db, followup, { userId } = {}) {
  if (!followup?.cust_id) return null;
  const cust = db.prepare('SELECT id, user_id, party_id, biz, lead_source, campaign FROM customers WHERE id=?').get(followup.cust_id);
  if (!cust) return null;
  const now = Math.floor(Date.now() / 1000);
  let opp = followup.opportunity_id
    ? db.prepare('SELECT * FROM crm_opportunities WHERE id=?').get(followup.opportunity_id)
    : findOpenOpportunity(db, cust.id) || findLatestOpportunity(db, cust.id);
  const dest = normalizeStage(followup.pipeline_stage);
  const prob = clampProb(followup.purchase_prob);
  if (!opp) {
    const r = db.prepare(`
      INSERT INTO crm_opportunities (
        party_id, customer_id, owner_user_id, title, pipeline_stage, status,
        estimated_amount_rial, probability_percent, weighted_amount_rial,
        lead_source, campaign, lost_reason, entered_stage_at, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      cust.party_id || null, cust.id, followup.user_id || cust.user_id || userId,
      (followup.subject || cust.biz || 'فرصت').slice(0, 200),
      dest, dest === 'lost' ? 'lost' : (CLOSED_STAGES.has(dest) ? 'won' : 'open'),
      0, prob, 0,
      cust.lead_source || '', cust.campaign || '', followup.lost_reason || '',
      now, now, now
    );
    opp = db.prepare('SELECT * FROM crm_opportunities WHERE id=?').get(r.lastInsertRowid);
    db.prepare(`
      INSERT INTO crm_stage_history (opportunity_id, from_stage, to_stage, changed_by, changed_at, reason)
      VALUES (?,?,?,?,?,?)
    `).run(opp.id, null, dest, userId || followup.user_id, now, 'followup_create');
  } else if (normalizeStage(opp.pipeline_stage) !== dest) {
    try {
      changeOpportunityStage(db, opp.id, dest, {
        userId: userId || followup.user_id,
        lostReason: followup.lost_reason || '',
        reason: 'followup_update',
      });
      opp = db.prepare('SELECT * FROM crm_opportunities WHERE id=?').get(opp.id);
    } catch (_) { /* keep existing if auto-advance rejected */ }
  } else {
    db.prepare('UPDATE crm_opportunities SET probability_percent=?, weighted_amount_rial=?, updated_at=? WHERE id=?')
      .run(prob, weightedRial(opp.estimated_amount_rial, prob), now, opp.id);
  }
  db.prepare('UPDATE followups SET opportunity_id=?, party_id=? WHERE id=?')
    .run(opp.id, cust.party_id || null, followup.id);
  const existingAct = db.prepare('SELECT id FROM crm_activities WHERE followup_id=?').get(followup.id);
  if (!existingAct) {
    db.prepare(`
      INSERT INTO crm_activities (
        party_id, customer_id, opportunity_id, owner_user_id, followup_id,
        type, subject, description, status, priority, activity_date, due_date,
        result, next_action, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      cust.party_id || null, cust.id, opp.id, followup.user_id, followup.id,
      mapFollowupType(followup.type), followup.subject || '', followup.note || '',
      followup.status || 'open', followup.priority || 'mid',
      followup.date || '', followup.next_date || '',
      followup.note || '', followup.action || '', now, now
    );
  } else {
    db.prepare(`
      UPDATE crm_activities SET type=?, subject=?, description=?, status=?, priority=?,
        activity_date=?, due_date=?, result=?, next_action=?, updated_at=?
      WHERE followup_id=?
    `).run(
      mapFollowupType(followup.type), followup.subject || '', followup.note || '',
      followup.status || 'open', followup.priority || 'mid',
      followup.date || '', followup.next_date || '',
      followup.note || '', followup.action || '', now, followup.id
    );
  }
  return opp;
}

function onInvoiceCreated(db, {
  invoiceId, custId, userId, type, amountRial = 0, leadSource = '', campaign = '',
} = {}) {
  if (!custId || !invoiceId) return null;
  const dest = type === 'proforma' ? 'proposal'
    : (type === 'normal' || type === 'final') ? null
    : null;
  let opp = findOpenOpportunity(db, custId) || findLatestOpportunity(db, custId);
  const firmCount = db.prepare(`
    SELECT COUNT(*) AS c FROM invoices i
    WHERE i.cust_id=? AND ${firmSaleTypeSql('i')}
      AND COALESCE(i.deleted_at,0)=0 AND COALESCE(i.status,'posted')<>'reversed'
  `).get(custId)?.c || 0;
  let target = dest;
  if (type === 'normal' || type === 'final') {
    target = firmCount >= 2 ? 'repeat' : 'first_order';
  }
  if (!target) return opp;
  const now = Math.floor(Date.now() / 1000);
  if (!opp) {
    const cust = db.prepare('SELECT party_id, user_id, biz FROM customers WHERE id=?').get(custId);
    const r = db.prepare(`
      INSERT INTO crm_opportunities (
        party_id, customer_id, owner_user_id, title, pipeline_stage, status,
        estimated_amount_rial, probability_percent, weighted_amount_rial,
        lead_source, campaign, won_invoice_id, entered_stage_at, created_at, updated_at, closed_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      cust?.party_id || null, custId, userId, (cust?.biz || 'فرصت').slice(0, 200),
      target, CLOSED_STAGES.has(target) ? 'won' : 'open',
      Math.round(amountRial) || 0, defaultProb(target),
      weightedRial(amountRial, defaultProb(target)),
      leadSource || '', campaign || '', (type === 'proforma' ? null : invoiceId),
      now, now, now, CLOSED_STAGES.has(target) ? now : null
    );
    db.prepare(`
      INSERT INTO crm_stage_history (opportunity_id, from_stage, to_stage, changed_by, changed_at, reason)
      VALUES (?,?,?,?,?,?)
    `).run(r.lastInsertRowid, null, target, userId, now, `invoice:${type}:${invoiceId}`);
    return db.prepare('SELECT * FROM crm_opportunities WHERE id=?').get(r.lastInsertRowid);
  }
  const current = normalizeStage(opp.pipeline_stage);
  if (current === 'lost') return opp;
  if (STAGE_RANK[target] <= STAGE_RANK[current]) {
    if ((target === 'first_order' || target === 'repeat' || target === 'won') && !opp.won_invoice_id) {
      db.prepare('UPDATE crm_opportunities SET won_invoice_id=?, updated_at=? WHERE id=?').run(invoiceId, now, opp.id);
    }
    return opp;
  }
  try {
    return changeOpportunityStage(db, opp.id, target, {
      userId, reason: `invoice:${type}:${invoiceId}`, wonInvoiceId: type === 'proforma' ? null : invoiceId,
    }).opportunity;
  } catch {
    return opp;
  }
}

function computeCustomerMetrics(db, customerId) {
  const today = todayJalali();
  const d30 = addDaysToJalali(today, -30);
  const d90 = addDaysToJalali(today, -90);
  const d365 = addDaysToJalali(today, -365);
  const firm = `
    SELECT i.date, ${sqlInvoiceAmountRial('i')} AS amount_rial
    FROM invoices i
    WHERE i.cust_id=? AND ${firmSaleTypeSql('i')}
      AND COALESCE(i.deleted_at,0)=0 AND COALESCE(i.status,'posted')<>'reversed'
    ORDER BY i.date
  `;
  const rows = db.prepare(firm).all(customerId);
  const sumSince = (from) => rows.filter((r) => r.date >= from).reduce((a, r) => a + (Number(r.amount_rial) || 0), 0);
  const last = rows.length ? rows[rows.length - 1].date : '';
  let cycle = null;
  if (rows.length >= 2) {
    const gaps = [];
    for (let i = 1; i < rows.length; i++) {
      const a = String(rows[i - 1].date || '').split('/').map(Number);
      const b = String(rows[i].date || '').split('/').map(Number);
      if (a.length === 3 && b.length === 3) {
        const da = Date.UTC(a[0], a[1] - 1, a[2]);
        const dbv = Date.UTC(b[0], b[1] - 1, b[2]);
        if (Number.isFinite(da) && Number.isFinite(dbv) && dbv > da) gaps.push((dbv - da) / 86400000);
      }
    }
    if (gaps.length) cycle = gaps.reduce((x, y) => x + y, 0) / gaps.length;
  }
  let inactiveDays = 0;
  if (last) {
    const p = String(last).split('/').map(Number);
    const t = String(today).split('/').map(Number);
    if (p.length === 3 && t.length === 3) {
      inactiveDays = Math.max(0, Math.round((Date.UTC(t[0], t[1] - 1, t[2]) - Date.UTC(p[0], p[1] - 1, p[2])) / 86400000));
    }
  } else {
    const cust = db.prepare('SELECT created_at FROM customers WHERE id=?').get(customerId);
    if (cust?.created_at) inactiveDays = Math.max(0, Math.round((Date.now() / 1000 - cust.created_at) / 86400));
  }
  const total = rows.reduce((a, r) => a + (Number(r.amount_rial) || 0), 0);
  return {
    sales_30_rial: Math.round(sumSince(d30)),
    sales_90_rial: Math.round(sumSince(d90)),
    sales_365_rial: Math.round(sumSince(d365)),
    purchase_count: rows.length,
    avg_purchase_rial: rows.length ? Math.round(total / rows.length) : 0,
    last_purchase_date: last,
    avg_cycle_days: cycle,
    inactive_days: inactiveDays,
  };
}

function classifySegment(db, metrics) {
  const vipMonthly = getSettingInt(db, 'crm_seg_vip_monthly_rial', 200000000);
  const vipStreak = getSettingInt(db, 'crm_seg_vip_min_streak', 3);
  const vipCycle = getSettingInt(db, 'crm_seg_vip_max_cycle_days', 45);
  const aMonthly = getSettingInt(db, 'crm_seg_a_monthly_rial', 80000000);
  const aCycle = getSettingInt(db, 'crm_seg_a_max_cycle_days', 60);
  const bMonthly = getSettingInt(db, 'crm_seg_b_monthly_rial', 20000000);
  const bCycle = getSettingInt(db, 'crm_seg_b_max_cycle_days', 90);
  const inactiveDays = getSettingInt(db, 'crm_seg_inactive_days', 180);
  const delayFactor = getSettingFloat(db, 'crm_seg_churn_delay_factor', 1.5);
  const cycle = metrics.avg_cycle_days;
  const expected = cycle || 90;
  if (metrics.purchase_count === 0 && metrics.inactive_days >= inactiveDays) {
    return { segment: 'inactive', reason: `بدون خرید و فعالیت بیش از ${inactiveDays} روز`, churn: 80 };
  }
  if (metrics.purchase_count === 0) {
    return { segment: 'new', reason: 'مشتری جدید بدون فاکتور قطعی', churn: 20 };
  }
  if (metrics.inactive_days >= inactiveDays && metrics.sales_90_rial === 0) {
    return { segment: 'inactive', reason: `عدم خرید در ${inactiveDays} روز`, churn: 85 };
  }
  if (cycle && metrics.inactive_days > expected * delayFactor) {
    return { segment: 'churn_risk', reason: `تأخیر ${metrics.inactive_days} روز نسبت به چرخه ${Math.round(expected)} روز`, churn: 70 };
  }
  if (metrics.sales_30_rial >= vipMonthly || (metrics.purchase_count >= vipStreak && (!cycle || cycle <= vipCycle))) {
    return { segment: 'VIP', reason: `خرید باشگاه VIP (۳۰روز ${metrics.sales_30_rial} ریال)`, churn: 10 };
  }
  if (metrics.sales_30_rial >= aMonthly && (!cycle || cycle <= aCycle)) {
    return { segment: 'A', reason: `خرید ماهانه در بازه A`, churn: 20 };
  }
  if (metrics.sales_30_rial >= bMonthly && (!cycle || cycle <= bCycle)) {
    return { segment: 'B', reason: `خرید ماهانه در بازه B`, churn: 35 };
  }
  return { segment: 'C', reason: 'خرید زیر آستانه یا مشتری تازه‌وارد', churn: 45 };
}

function runSegmentation(db, { customerId = null } = {}) {
  const ids = customerId
    ? [customerId]
    : db.prepare('SELECT id FROM customers').all().map((r) => r.id);
  const now = Math.floor(Date.now() / 1000);
  let updated = 0;
  const upsert = db.prepare(`
    INSERT INTO crm_customer_segments (
      customer_id, party_id, calculated_segment, manual_segment, effective_segment,
      manual_override_reason, reason, sales_30_rial, sales_90_rial, sales_365_rial,
      purchase_count, avg_purchase_rial, last_purchase_date, avg_cycle_days,
      inactive_days, churn_probability_percent, computed_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(customer_id) DO UPDATE SET
      party_id=excluded.party_id,
      calculated_segment=excluded.calculated_segment,
      effective_segment=excluded.effective_segment,
      reason=excluded.reason,
      sales_30_rial=excluded.sales_30_rial,
      sales_90_rial=excluded.sales_90_rial,
      sales_365_rial=excluded.sales_365_rial,
      purchase_count=excluded.purchase_count,
      avg_purchase_rial=excluded.avg_purchase_rial,
      last_purchase_date=excluded.last_purchase_date,
      avg_cycle_days=excluded.avg_cycle_days,
      inactive_days=excluded.inactive_days,
      churn_probability_percent=excluded.churn_probability_percent,
      computed_at=excluded.computed_at
  `);
  const tx = db.transaction(() => {
    for (const id of ids) {
      const cust = db.prepare('SELECT id, party_id FROM customers WHERE id=?').get(id);
      if (!cust) continue;
      const metrics = computeCustomerMetrics(db, id);
      const cls = classifySegment(db, metrics);
      const prev = db.prepare('SELECT * FROM crm_customer_segments WHERE customer_id=?').get(id);
      const manual = prev?.manual_segment || null;
      const effective = manual || cls.segment;
      upsert.run(
        id, cust.party_id || null, cls.segment, manual, effective,
        prev?.manual_override_reason || '', cls.reason,
        metrics.sales_30_rial, metrics.sales_90_rial, metrics.sales_365_rial,
        metrics.purchase_count, metrics.avg_purchase_rial, metrics.last_purchase_date,
        metrics.avg_cycle_days, metrics.inactive_days, cls.churn, now
      );
      if (prev && prev.effective_segment !== effective) {
        db.prepare(`
          INSERT INTO crm_segment_history (customer_id, from_segment, to_segment, source, reason, changed_at)
          VALUES (?,?,?,?,?,?)
        `).run(id, prev.effective_segment, effective, manual ? 'manual' : 'system', cls.reason, now);
      } else if (!prev) {
        db.prepare(`
          INSERT INTO crm_segment_history (customer_id, from_segment, to_segment, source, reason, changed_at)
          VALUES (?,?,?,?,?,?)
        `).run(id, null, effective, 'system', cls.reason, now);
      }
      updated += 1;
    }
  });
  tx();
  return { updated };
}

function logAutomation(db, ruleKey, entityType, entityId, payload = '') {
  try {
    db.prepare(`
      INSERT OR IGNORE INTO crm_automation_log (rule_key, entity_type, entity_id, payload)
      VALUES (?,?,?,?)
    `).run(ruleKey, entityType, entityId, typeof payload === 'string' ? payload : JSON.stringify(payload));
    return db.prepare('SELECT changes() AS c').get()?.c > 0;
  } catch {
    return false;
  }
}

function runAutomations(db) {
  const today = todayJalali();
  const staleDays = getSettingInt(db, 'crm_stale_opportunity_days', 14);
  const chequeDays = getSettingInt(db, 'crm_cheque_due_days', 14);
  const dueLimit = addDaysToJalali(today, chequeDays);
  const now = Math.floor(Date.now() / 1000);
  const created = [];
  const remind = (userId, title, body, entityType, entityId, rule) => {
    if (!logAutomation(db, rule, entityType, entityId, title)) return;
    try {
      db.prepare(`
        INSERT INTO reminders (user_id, title, body, due_date, status, created_at)
        VALUES (?,?,?,?, 'open', ?)
      `).run(userId || 1, title, body, today, now);
      created.push(rule);
    } catch (_) {
      try {
        db.prepare(`
          INSERT INTO reminders (user_id, title, note, date, status, created_at)
          VALUES (?,?,?,?, 'open', ?)
        `).run(userId || 1, title, body, today, now);
        created.push(rule);
      } catch (__) { /* reminder schema varies */ }
    }
  };

  if (getSetting(db, 'crm_auto_alert_overdue', '1') === '1') {
    const rows = db.prepare(`
      SELECT f.id, f.user_id, f.subject, f.next_date, c.biz
      FROM followups f LEFT JOIN customers c ON c.id=f.cust_id
      WHERE f.status='open' AND f.next_date<>'' AND f.next_date < ?
    `).all(today);
    for (const r of rows) {
      remind(r.user_id, `پیگیری عقب‌افتاده: ${r.biz || r.subject || r.id}`,
        `سررسید ${r.next_date}`, 'followup', r.id, `overdue_followup:${r.id}`);
    }
    const todayRows = db.prepare(`
      SELECT f.id, f.user_id, f.subject, c.biz FROM followups f
      LEFT JOIN customers c ON c.id=f.cust_id
      WHERE f.status='open' AND f.next_date=?
    `).all(today);
    for (const r of todayRows) {
      remind(r.user_id, `پیگیری امروز: ${r.biz || r.subject || r.id}`,
        'سررسید امروز', 'followup', r.id, `today_followup:${r.id}`);
    }
  }

  if (getSetting(db, 'crm_auto_alert_stale_opp', '1') === '1') {
    const cutoff = now - staleDays * 86400;
    const opps = db.prepare(`
      SELECT o.id, o.owner_user_id, o.title, o.entered_stage_at, c.biz
      FROM crm_opportunities o LEFT JOIN customers c ON c.id=o.customer_id
      WHERE o.status='open' AND COALESCE(o.entered_stage_at,o.updated_at,0) < ?
    `).all(cutoff);
    for (const o of opps) {
      remind(o.owner_user_id, `فرصت متوقف: ${o.biz || o.title}`,
        `بیش از ${staleDays} روز بدون تغییر مرحله`, 'opportunity', o.id, `stale_opp:${o.id}`);
    }
  }

  if (getSetting(db, 'crm_auto_alert_churn', '1') === '1') {
    const segs = db.prepare(`
      SELECT s.customer_id, s.reason, c.user_id, c.biz
      FROM crm_customer_segments s JOIN customers c ON c.id=s.customer_id
      WHERE s.effective_segment='churn_risk'
    `).all();
    for (const s of segs) {
      remind(s.user_id, `ریسک ریزش: ${s.biz}`, s.reason || '', 'customer', s.customer_id, `churn:${s.customer_id}`);
    }
  }

  if (getSetting(db, 'crm_auto_alert_cheque', '1') === '1') {
    try {
      const cheques = db.prepare(`
        SELECT id, created_by_name, due_date, cheque_number, customer_id
        FROM cheque_records
        WHERE COALESCE(record_status,'posted')<>'reversed'
          AND COALESCE(lifecycle_status,status) IN ('registered','in_collection','pending')
          AND due_date<>'' AND due_date<=?
      `).all(dueLimit);
      for (const c of cheques) {
        const cust = c.customer_id ? db.prepare('SELECT user_id FROM customers WHERE id=?').get(c.customer_id) : null;
        remind(cust?.user_id, `چک نزدیک سررسید ${c.cheque_number || c.id}`,
          `سررسید ${c.due_date}`, 'cheque', c.id, `cheque_due:${c.id}`);
      }
    } catch (_) {}
  }

  db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)')
    .run('crm_automation_last_run', String(now));
  db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)')
    .run('crm_automation_last_result', JSON.stringify({ created: created.length, at: now }));
  return { created: created.length, rules: created };
}

function nextActionSuggestion(stage) {
  const map = {
    lead: 'تماس اول و تکمیل اطلاعات مشتری',
    qualified: 'ارسال کاتالوگ و سنجش نیاز',
    proposal: 'پیگیری پیش‌فاکتور و رفع ابهام قیمت',
    negotiation: 'نهایی کردن شرایط و تاریخ تحویل',
    first_order: 'پیگیری رضایت و ثبت سفارش مکمل',
    won: 'برنامه خرید تکراری و باشگاه مشتری',
    repeat: 'حفظ چرخه خرید و پیشنهاد کالای مرتبط',
    lost: 'ثبت دلیل باخت و بازبینی قیمت/موجودی',
  };
  return map[normalizeStage(stage)] || 'ثبت پیگیری بعدی';
}

module.exports = {
  PIPELINE_STAGES,
  STAGE_RANK,
  OPEN_STAGES,
  CLOSED_STAGES,
  sqlInvoiceAmountRial,
  getSetting,
  getSettingInt,
  clampProb,
  weightedRial,
  assertOpportunityAccess,
  findOpenOpportunity,
  findLatestOpportunity,
  changeOpportunityStage,
  upsertOpportunityFromFollowup,
  onInvoiceCreated,
  computeCustomerMetrics,
  classifySegment,
  runSegmentation,
  runAutomations,
  logAutomation,
  nextActionSuggestion,
  normalizeStage,
};
