// AI sales assistant: nightly churn scoring + insights + weekly admin summary.
//
// Two layers:
//  1. Deterministic heuristics (always on): churn score 0-100 per customer from recency
//     of invoices/follow-ups and purchase cadence. No external calls, runs for every tenant.
//  2. Claude API narratives (optional): when the tenant has feature_ai_assistant=1 AND an
//     ai_api_key configured, the nightly job asks Claude for prioritized action suggestions
//     and the Sunday weekly summary, with structured-JSON output. Results are cached in
//     ai_insights so the dashboard never calls the API on page load.

const { getSetting } = require('../db');
const { decrypt } = require('./crypto');

const DAY = 24 * 3600;

function nowSec() { return Math.floor(Date.now() / 1000); }

// ── Heuristic churn score ────────────────────────────────────────────────────
// 0 = healthy, 100 = almost certainly churned.
function computeChurnScore(db, tenantId, cust) {
  const now = nowSec();
  const lastInv = db.prepare(
    "SELECT MAX(created_at) t FROM invoices WHERE tenant_id=? AND cust_id=? AND type='final'"
  ).get(tenantId, cust.id).t;
  const lastFup = db.prepare(
    'SELECT MAX(created_at) t FROM followups WHERE tenant_id=? AND cust_id=?'
  ).get(tenantId, cust.id).t;
  const invCount = db.prepare(
    "SELECT COUNT(*) c FROM invoices WHERE tenant_id=? AND cust_id=? AND type='final'"
  ).get(tenantId, cust.id).c;

  const lastTouch = Math.max(lastInv || 0, lastFup || 0, cust.created_at || 0);
  const daysSinceTouch = Math.floor((now - lastTouch) / DAY);
  const daysSinceInv = lastInv ? Math.floor((now - lastInv) / DAY) : null;

  let score = 0;
  // recency of any interaction: 0..60
  score += Math.min(60, daysSinceTouch * 2);
  // recency of actual purchase: 0..30 (only if they've ever bought)
  if (invCount > 0 && daysSinceInv !== null) score += Math.min(30, Math.max(0, (daysSinceInv - 14)));
  // never purchased and older than 2 weeks: flat risk bump
  if (invCount === 0 && daysSinceTouch > 14) score += 20;
  // VIPs decay slower
  if (cust.status === 'vip') score = Math.round(score * 0.7);
  return Math.max(0, Math.min(100, Math.round(score)));
}

// ── Claude API (optional narrative layer) ────────────────────────────────────
async function callClaude(apiKey, model, system, userText, maxTokens = 1500) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model, max_tokens: maxTokens, system,
      messages: [{ role: 'user', content: userText }],
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return (data.content || []).map(b => b.text || '').join('');
}

function getApiKey(tenantId) {
  const raw = getSetting(tenantId, 'ai_api_key');
  if (!raw) return null;
  try { return raw.includes(':') ? decrypt(raw) : raw; } catch { return raw; }
}

function extractJSON(text) {
  const m = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (!m) throw new Error('no JSON in response');
  return JSON.parse(m[0]);
}

// ── Nightly analysis (02:00 cron + manual refresh) ──────────────────────────
async function runNightlyAnalysis(db, { tenantId = null, weekly = false } = {}) {
  const tenants = tenantId
    ? [{ id: tenantId }]
    : db.prepare("SELECT id FROM tenants WHERE status='active'").all();

  for (const t of tenants) {
    try {
      await analyzeTenant(db, t.id, { weekly });
    } catch (e) {
      console.error(`ai analysis error (tenant ${t.id}):`, e.message);
    }
  }
}

async function analyzeTenant(db, tenantId, { weekly = false } = {}) {
  const customers = db.prepare('SELECT * FROM customers WHERE tenant_id=?').all(tenantId);
  if (!customers.length) return;

  // 1) churn scores (always)
  const updScore = db.prepare('UPDATE customers SET churn_score=? WHERE id=? AND tenant_id=?');
  const scored = [];
  const tx = db.transaction(() => {
    for (const c of customers) {
      const score = computeChurnScore(db, tenantId, c);
      updScore.run(score, c.id, tenantId);
      scored.push({ ...c, churn_score: score });
    }
  });
  tx();

  // 2) refresh heuristic insights: wipe today's generated rows, insert fresh
  const today = new Date().toISOString().slice(0, 10);
  db.prepare("DELETE FROM ai_insights WHERE tenant_id=? AND period=? AND kind IN ('churn_risk','opportunity','daily_action')").run(tenantId, today);
  const ins = db.prepare('INSERT INTO ai_insights (tenant_id,customer_id,user_id,kind,score,title,body,period) VALUES (?,?,?,?,?,?,?,?)');

  const atRisk = scored.filter(c => c.churn_score >= 60).sort((a, b) => b.churn_score - a.churn_score).slice(0, 30);
  for (const c of atRisk) {
    const lastInv = db.prepare("SELECT MAX(created_at) t FROM invoices WHERE tenant_id=? AND cust_id=? AND type='final'").get(tenantId, c.id).t;
    const days = lastInv ? Math.floor((nowSec() - lastInv) / DAY) : null;
    ins.run(tenantId, c.id, c.user_id, 'churn_risk', c.churn_score,
      `ریسک ریزش ${c.churn_score}٪ — ${c.biz}`,
      days !== null
        ? `مشتری «${c.biz}» ${days} روز است فاکتور نداشته و پیگیری فعالی ندارد. تماس یا پیشنهاد ویژه توصیه می‌شود.`
        : `مشتری «${c.biz}» هنوز خریدی ثبت نکرده و مدتی بدون پیگیری مانده است.`,
      today);
  }

  // Re-order opportunities: bought ≥3 times, average gap passed since last purchase, low churn
  const buyers = db.prepare(`
    SELECT cust_id, COUNT(*) n, MIN(created_at) first_t, MAX(created_at) last_t
    FROM invoices WHERE tenant_id=? AND type='final' GROUP BY cust_id HAVING n >= 3
  `).all(tenantId);
  for (const b of buyers) {
    const avgGap = (b.last_t - b.first_t) / Math.max(1, b.n - 1);
    const sinceLast = nowSec() - b.last_t;
    if (avgGap > 0 && sinceLast > avgGap && sinceLast < avgGap * 3) {
      const c = scored.find(x => x.id === b.cust_id);
      if (!c || c.churn_score >= 80) continue;
      ins.run(tenantId, c.id, c.user_id, 'opportunity', Math.round(Math.min(99, (sinceLast / avgGap) * 50)),
        `فرصت فروش مجدد — ${c.biz}`,
        `«${c.biz}» معمولاً هر ${Math.max(1, Math.round(avgGap / DAY))} روز خرید می‌کند و اکنون ${Math.floor(sinceLast / DAY)} روز از آخرین خرید گذشته — زمان مناسب برای تماس و معرفی محصولات جدید.`,
        today);
    }
  }

  // 3) daily action suggestions per salesperson (Claude if configured, else template)
  const apiKey = getSetting(tenantId, 'feature_ai_assistant') === '1' ? getApiKey(tenantId) : null;
  const model = getSetting(tenantId, 'ai_model') || 'claude-haiku-4-5-20251001';
  const reps = db.prepare("SELECT id,name FROM users WHERE tenant_id=? AND active=1 AND role IN ('field_sales','inside_sales')").all(tenantId);
  for (const rep of reps) {
    const repRisk = atRisk.filter(c => c.user_id === rep.id).slice(0, 5);
    const openFups = db.prepare("SELECT COUNT(*) c FROM followups WHERE tenant_id=? AND user_id=? AND status='open'").get(tenantId, rep.id).c;
    if (!repRisk.length && !openFups) continue;
    let body;
    if (apiKey) {
      try {
        const context = JSON.stringify({
          at_risk: repRisk.map(c => ({ biz: c.biz, churn: c.churn_score, status: c.status })),
          open_followups: openFups,
        });
        const text = await callClaude(apiKey, model,
          'تو دستیار فروش یک تولیدی پوشاک عمده هستی. خروجی فقط JSON: {"suggestion": "متن فارسی حداکثر ۳ جمله، مشخص و قابل اقدام"}',
          `داده امروز کارشناس ${rep.name}: ${context}`, 400);
        body = extractJSON(text).suggestion;
      } catch (e) {
        console.error(`ai daily-action claude error (tenant ${tenantId}, rep ${rep.id}):`, e.message);
      }
    }
    if (!body) {
      const names = repRisk.map(c => `«${c.biz}»`).join('، ');
      body = repRisk.length
        ? `امروز با ${names} تماس بگیر — ریسک ریزش بالاست. ${openFups ? `${openFups} پیگیری باز هم داری.` : ''}`
        : `${openFups} پیگیری باز داری — امروز آن‌ها را ببند.`;
    }
    ins.run(tenantId, null, rep.id, 'daily_action', repRisk.length ? repRisk[0].churn_score : 40,
      `پیشنهاد اقدام امروز — ${rep.name}`, body, today);
  }

  // 4) weekly admin summary (Sundays or forced)
  const isSunday = new Date().getDay() === 0; // یکشنبه
  if (weekly || isSunday) {
    const weekAgo = nowSec() - 7 * DAY;
    const sales = db.prepare("SELECT COUNT(*) c, COALESCE(SUM(final),0) s FROM invoices WHERE tenant_id=? AND type='final' AND created_at>=?").get(tenantId, weekAgo);
    const newCust = db.prepare('SELECT COUNT(*) c FROM customers WHERE tenant_id=? AND created_at>=?').get(tenantId, weekAgo).c;
    const settled = db.prepare('SELECT COALESCE(SUM(amount),0) s FROM settlements WHERE tenant_id=? AND created_at>=?').get(tenantId, weekAgo).s;
    const riskCount = scored.filter(c => c.churn_score >= 60).length;
    const stats = { invoices: sales.c, revenue: sales.s, new_customers: newCust, collected: settled, at_risk_customers: riskCount };

    let body;
    if (apiKey) {
      try {
        const text = await callClaude(apiKey, model,
          'تو تحلیلگر فروش یک تولیدی پوشاک عمده هستی. خروجی فقط JSON: {"summary": "خلاصه مدیریتی فارسی در ۴-۶ جمله: روند فروش، وصولی، مشتریان در ریسک، و یک توصیه مشخص"}',
          `آمار هفته: ${JSON.stringify(stats)}. ۵ مشتری پرریسک: ${JSON.stringify(atRisk.slice(0, 5).map(c => ({ biz: c.biz, churn: c.churn_score })))}`, 700);
        body = extractJSON(text).summary;
      } catch (e) {
        console.error(`ai weekly-summary claude error (tenant ${tenantId}):`, e.message);
      }
    }
    if (!body) {
      body = `این هفته ${stats.invoices} فاکتور رسمی به مبلغ ${Number(stats.revenue).toLocaleString('fa-IR')} تومان صادر شد و ${Number(stats.collected).toLocaleString('fa-IR')} تومان وصول گردید. ${stats.new_customers} مشتری جدید اضافه شد و ${stats.at_risk_customers} مشتری در ریسک ریزش هستند${atRisk.length ? ` (در صدر: «${atRisk[0].biz}»)` : ''}.`;
    }
    const period = 'w-' + new Date().toISOString().slice(0, 10);
    db.prepare("DELETE FROM ai_insights WHERE tenant_id=? AND kind='weekly_summary' AND period=?").run(tenantId, period);
    ins.run(tenantId, null, null, 'weekly_summary', null, 'خلاصه هفتگی مدیر', body, period);
  }

  console.log(`🤖 تحلیل AI مستأجر ${tenantId}: ${customers.length} مشتری امتیازدهی شد، ${atRisk.length} در ریسک`);
}

module.exports = { runNightlyAnalysis, analyzeTenant, computeChurnScore };
