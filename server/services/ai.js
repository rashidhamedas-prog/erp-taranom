// AI sales assistant — ported from CRM v4 (single-tenant adaptation).
//
// Two layers:
//  1. Deterministic heuristics (always on): churn score 0-100 per customer from
//     recency of invoices/follow-ups and purchase cadence. No external calls.
//  2. Claude API narratives (optional): when feature_ai_assistant=1 AND an
//     ai_api_key is configured, the nightly job asks Claude for prioritized
//     action suggestions and the weekly summary. Results are cached in
//     ai_insights so the dashboard never calls the API on page load.

const { decrypt } = require('./crypto');

const DAY = 24 * 3600;

function nowSec() { return Math.floor(Date.now() / 1000); }

function getSettingValue(db, key) {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return row ? row.value : '';
}

// ── Heuristic churn score ────────────────────────────────────────────────────
// 0 = healthy, 100 = almost certainly churned.
function computeChurnScore(db, cust) {
  const now = nowSec();
  const lastInv = db.prepare(
    "SELECT MAX(created_at) t FROM invoices WHERE cust_id=? AND type='final'"
  ).get(cust.id).t;
  const lastFup = db.prepare(
    'SELECT MAX(created_at) t FROM followups WHERE cust_id=?'
  ).get(cust.id).t;
  const invCount = db.prepare(
    "SELECT COUNT(*) c FROM invoices WHERE cust_id=? AND type='final'"
  ).get(cust.id).c;

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

function getApiKey(db) {
  const raw = getSettingValue(db, 'ai_api_key');
  if (!raw) return null;
  try { return raw.includes(':') ? decrypt(raw) : raw; } catch { return raw; }
}

function extractJSON(text) {
  const m = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (!m) throw new Error('no JSON in response');
  return JSON.parse(m[0]);
}

// ── Nightly analysis (02:00 cron + manual refresh) ──────────────────────────
async function runNightlyAnalysis(db, { weekly = false } = {}) {
  const customers = db.prepare('SELECT * FROM customers').all();
  if (!customers.length) return;

  // 1) churn scores (always)
  const updScore = db.prepare('UPDATE customers SET churn_score=? WHERE id=?');
  const scored = [];
  const tx = db.transaction(() => {
    for (const c of customers) {
      const score = computeChurnScore(db, c);
      updScore.run(score, c.id);
      scored.push({ ...c, churn_score: score });
    }
  });
  tx();

  // 2) refresh heuristic insights: wipe today's generated rows, insert fresh
  const today = new Date().toISOString().slice(0, 10);
  db.prepare("DELETE FROM ai_insights WHERE period=? AND kind IN ('churn_risk','opportunity','daily_action')").run(today);
  const ins = db.prepare('INSERT INTO ai_insights (customer_id,user_id,kind,score,title,body,period) VALUES (?,?,?,?,?,?,?)');

  const atRisk = scored.filter(c => c.churn_score >= 60).sort((a, b) => b.churn_score - a.churn_score).slice(0, 30);
  for (const c of atRisk) {
    const lastInv = db.prepare("SELECT MAX(created_at) t FROM invoices WHERE cust_id=? AND type='final'").get(c.id).t;
    const days = lastInv ? Math.floor((nowSec() - lastInv) / DAY) : null;
    ins.run(c.id, c.user_id, 'churn_risk', c.churn_score,
      `ریسک ریزش ${c.churn_score}٪ — ${c.biz}`,
      days !== null
        ? `مشتری «${c.biz}» ${days} روز است فاکتور نداشته و پیگیری فعالی ندارد. تماس یا پیشنهاد ویژه توصیه می‌شود.`
        : `مشتری «${c.biz}» هنوز خریدی ثبت نکرده و مدتی بدون پیگیری مانده است.`,
      today);
  }

  // Re-order opportunities: bought ≥3 times, average gap passed since last purchase, low churn
  const buyers = db.prepare(`
    SELECT cust_id, COUNT(*) n, MIN(created_at) first_t, MAX(created_at) last_t
    FROM invoices WHERE type='final' GROUP BY cust_id HAVING n >= 3
  `).all();
  for (const b of buyers) {
    const avgGap = (b.last_t - b.first_t) / Math.max(1, b.n - 1);
    const sinceLast = nowSec() - b.last_t;
    if (avgGap > 0 && sinceLast > avgGap && sinceLast < avgGap * 3) {
      const c = scored.find(x => x.id === b.cust_id);
      if (!c || c.churn_score >= 80) continue;
      ins.run(c.id, c.user_id, 'opportunity', Math.round(Math.min(99, (sinceLast / avgGap) * 50)),
        `فرصت فروش مجدد — ${c.biz}`,
        `«${c.biz}» معمولاً هر ${Math.max(1, Math.round(avgGap / DAY))} روز خرید می‌کند و اکنون ${Math.floor(sinceLast / DAY)} روز از آخرین خرید گذشته — زمان مناسب برای تماس و معرفی محصولات جدید.`,
        today);
    }
  }

  // 3) daily action suggestions per salesperson (Claude if configured, else template)
  const apiKey = getSettingValue(db, 'feature_ai_assistant') === '1' ? getApiKey(db) : null;
  const model = getSettingValue(db, 'ai_model') || 'claude-haiku-4-5-20251001';
  const reps = db.prepare("SELECT id,name FROM users WHERE active=1 AND role IN ('field_sales','inside_sales','sales_manager')").all();
  for (const rep of reps) {
    const repRisk = atRisk.filter(c => c.user_id === rep.id).slice(0, 5);
    const openFups = db.prepare("SELECT COUNT(*) c FROM followups WHERE user_id=? AND status='open'").get(rep.id).c;
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
        console.error(`ai daily-action claude error (rep ${rep.id}):`, e.message);
      }
    }
    if (!body) {
      const names = repRisk.map(c => `«${c.biz}»`).join('، ');
      body = repRisk.length
        ? `امروز با ${names} تماس بگیر — ریسک ریزش بالاست. ${openFups ? `${openFups} پیگیری باز هم داری.` : ''}`
        : `${openFups} پیگیری باز داری — امروز آن‌ها را ببند.`;
    }
    ins.run(null, rep.id, 'daily_action', repRisk.length ? repRisk[0].churn_score : 40,
      `پیشنهاد اقدام امروز — ${rep.name}`, body, today);
  }

  // 4) weekly admin summary (Sundays or forced)
  const isSunday = new Date().getDay() === 0; // یکشنبه
  if (weekly || isSunday) {
    const weekAgo = nowSec() - 7 * DAY;
    const sales = db.prepare("SELECT COUNT(*) c, COALESCE(SUM(final),0) s FROM invoices WHERE type='final' AND created_at>=?").get(weekAgo);
    const newCust = db.prepare('SELECT COUNT(*) c FROM customers WHERE created_at>=?').get(weekAgo).c;
    const settled = db.prepare('SELECT COALESCE(SUM(amount),0) s FROM settlements WHERE created_at>=?').get(weekAgo).s;
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
        console.error('ai weekly-summary claude error:', e.message);
      }
    }
    if (!body) {
      body = `این هفته ${stats.invoices} فاکتور رسمی به مبلغ ${Number(stats.revenue).toLocaleString('fa-IR')} ریال صادر شد و ${Number(stats.collected).toLocaleString('fa-IR')} ریال وصول گردید. ${stats.new_customers} مشتری جدید اضافه شد و ${stats.at_risk_customers} مشتری در ریسک ریزش هستند${atRisk.length ? ` (در صدر: «${atRisk[0].biz}»)` : ''}.`;
    }
    const period = 'w-' + new Date().toISOString().slice(0, 10);
    db.prepare("DELETE FROM ai_insights WHERE kind='weekly_summary' AND period=?").run(period);
    ins.run(null, null, 'weekly_summary', null, 'خلاصه هفتگی مدیر', body, period);
  }

  console.log(`🤖 تحلیل AI: ${customers.length} مشتری امتیازدهی شد، ${atRisk.length} در ریسک`);
}

// Business consultant for managers — aggregated anonymized business context
async function buildConsultantReply(db, question) {
  const now = nowSec();
  const weekAgo = now - 7 * DAY;
  const monthPrefix = require('../jalali').todayJalali().slice(0, 8);

  const weekSales = db.prepare("SELECT COUNT(*) c, COALESCE(SUM(final),0) s FROM invoices WHERE type='final' AND created_at>=? AND COALESCE(deleted_at,0)=0").get(weekAgo);
  const monthSales = db.prepare("SELECT COALESCE(SUM(final),0) s FROM invoices WHERE type='final' AND date LIKE ? AND COALESCE(deleted_at,0)=0").get(monthPrefix + '%');
  const overdue = db.prepare(`
    SELECT c.biz, SUM(cl.debit - cl.credit) as balance
    FROM customer_ledger cl JOIN customers c ON cl.customer_id=c.id
    GROUP BY c.id HAVING balance > 1000000 ORDER BY balance DESC LIMIT 5
  `).all();
  const lowStock = db.prepare('SELECT name, stock FROM products WHERE stock <= stock_alert ORDER BY stock LIMIT 5').all();
  let topProducts = [];
  try {
    topProducts = db.prepare(`
      SELECT p.name, COUNT(*) as qty
      FROM invoices i, json_each(i.rows) je
      JOIN products p ON p.id = CAST(json_extract(je.value,'$.product_id') AS INTEGER)
      WHERE i.type='final' AND COALESCE(i.deleted_at,0)=0 AND i.created_at>=?
      GROUP BY p.id ORDER BY qty DESC LIMIT 5
    `).all(weekAgo);
  } catch { /* json_each may fail on empty rows */ }

  const context = {
    week_invoices: weekSales.c, week_revenue: weekSales.s,
    month_revenue: monthSales.s,
    overdue_customers: overdue.map(o => ({ label: o.biz, balance: Math.round(o.balance) })),
    low_stock: lowStock.map(p => ({ name: p.name, stock: p.stock })),
    at_risk_count: db.prepare('SELECT COUNT(*) c FROM customers WHERE churn_score>=60').get().c,
  };

  const systemPrompt = `شما یک مشاور ارشد کسب‌وکار و مالی برای یک تولیدی پوشاک عمده‌فروشی (برند ترنم) هستید.
نقش شما: تحلیل داده‌های تجمیع‌شده، ارائه بینش عملی، پیشنهاد اقدام مشخص.
محدودیت‌ها: فقط از داده‌های ارائه‌شده استفاده کنید؛ عدد نسازید؛ پاسخ فارسی، حرفه‌ای و مختصر (حداکثر ۶ جمله).
اگر داده کافی نیست، صریح بگویید چه اطلاعاتی لازم است.`;

  const apiKey = getSettingValue(db, 'feature_ai_assistant') === '1' ? getApiKey(db) : null;
  const model = getSettingValue(db, 'ai_model') || 'claude-haiku-4-5-20251001';

  if (apiKey) {
    try {
      const text = await callClaude(apiKey, model, systemPrompt,
        `داده‌های تجمیع‌شده (بدون نام مشتری خاص در سؤال):\n${JSON.stringify(context)}\n\nسؤال مدیر: ${question}`, 800);
      return { answer: text, context_summary: context, source: 'claude' };
    } catch (e) {
      console.error('ai consult claude error:', e.message);
    }
  }

  const parts = [];
  parts.push(`این هفته ${weekSales.c} فاکتور رسمی به مبلغ ${Number(weekSales.s).toLocaleString('fa-IR')} ریال ثبت شده.`);
  parts.push(`فروش این ماه: ${Number(monthSales.s).toLocaleString('fa-IR')} ریال.`);
  if (overdue.length) parts.push(`${overdue.length} مشتری با مانده بالای ۱ میلیون ریال دارید — اولویت وصول.`);
  if (lowStock.length) parts.push(`${lowStock.length} محصول موجودی کم دارند.`);
  parts.push(`سؤال شما: «${question}» — برای تحلیل عمیق‌تر، کلید API هوش مصنوعی را در تنظیمات فعال کنید.`);
  return { answer: parts.join(' '), context_summary: context, source: 'heuristic' };
}

// Personal performance summary (spec 1.0.9 §6)
async function buildMySummary(db, userId, { narrative = false } = {}) {
  const { todayJalali } = require('../jalali');
  const now = nowSec();
  const weekAgo = now - 7 * DAY;
  const monthPrefix = todayJalali().slice(0, 8); // '1405/04/'

  const week = db.prepare(
    "SELECT COUNT(*) c, COALESCE(SUM(final),0) s FROM invoices WHERE user_id=? AND type='final' AND created_at>=?"
  ).get(userId, weekAgo);
  const month = db.prepare(
    "SELECT COUNT(*) c, COALESCE(SUM(final),0) s FROM invoices WHERE user_id=? AND type='final' AND date LIKE ?"
  ).get(userId, monthPrefix + '%');
  const prevWeek = db.prepare(
    "SELECT COALESCE(SUM(final),0) s FROM invoices WHERE user_id=? AND type='final' AND created_at>=? AND created_at<?"
  ).get(userId, now - 14 * DAY, weekAgo);
  const openFups = db.prepare("SELECT COUNT(*) c FROM followups WHERE user_id=? AND status='open'").get(userId).c;
  const myCustomers = db.prepare('SELECT COUNT(*) c FROM customers WHERE user_id=?').get(userId).c;
  const atRisk = db.prepare(
    'SELECT biz, churn_score FROM customers WHERE user_id=? AND churn_score>=60 ORDER BY churn_score DESC LIMIT 5'
  ).all(userId);
  const topCustomers = db.prepare(`
    SELECT c.biz, COALESCE(SUM(i.final),0) total FROM invoices i JOIN customers c ON i.cust_id=c.id
    WHERE i.user_id=? AND i.type='final' AND i.date LIKE ?
    GROUP BY i.cust_id ORDER BY total DESC LIMIT 3
  `).all(userId, monthPrefix + '%');

  const stats = {
    week_sales: week.s, week_invoices: week.c,
    month_sales: month.s, month_invoices: month.c,
    prev_week_sales: prevWeek.s,
    open_followups: openFups, my_customers: myCustomers,
    at_risk: atRisk, top_customers: topCustomers,
  };

  let body = null;
  const apiKey = getSettingValue(db, 'feature_ai_assistant') === '1' ? getApiKey(db) : null;
  if (narrative && apiKey) {
    const model = getSettingValue(db, 'ai_model') || 'claude-haiku-4-5-20251001';
    try {
      const text = await callClaude(apiKey, model,
        'تو دستیار فروش شخصی یک کارشناس فروش پوشاک عمده هستی. فقط بر اساس داده‌ای که داده می‌شود تحلیل کن و از خودت عدد نساز. خروجی فقط JSON: {"summary": "تحلیل فارسی عملکرد شخصی در ۳-۵ جمله + یک توصیه مشخص برای این هفته"}',
        `آمار شخصی این کارشناس: ${JSON.stringify(stats)}`, 600);
      body = extractJSON(text).summary;
    } catch (e) {
      console.error(`ai my-summary claude error (user ${userId}):`, e.message);
    }
  }
  if (narrative && !body) {
    const trend = prevWeek.s > 0
      ? (week.s >= prevWeek.s ? `فروش این هفته نسبت به هفته قبل ${prevWeek.s ? Math.round(((week.s - prevWeek.s) / prevWeek.s) * 100) : 0}٪ رشد داشته.` : `فروش این هفته نسبت به هفته قبل ${Math.round(((prevWeek.s - week.s) / prevWeek.s) * 100)}٪ کمتر بوده.`)
      : '';
    body = `این هفته ${week.c} فاکتور رسمی به مبلغ ${Number(week.s).toLocaleString('fa-IR')} ریال ثبت کرده‌ای و فروش این ماه به ${Number(month.s).toLocaleString('fa-IR')} ریال رسیده. ${trend} ${openFups ? `${openFups} پیگیری باز داری.` : ''} ${atRisk.length ? `مشتریان در ریسک: ${atRisk.map(c => `«${c.biz}»`).join('، ')} — امروز با آن‌ها تماس بگیر.` : 'مشتری پرریسکی نداری — روی جذب مشتری جدید تمرکز کن.'}`;
  }
  return { stats, narrative: body };
}

module.exports = { runNightlyAnalysis, computeChurnScore, buildMySummary, buildConsultantReply };
