/**
 * FX rate adapter (Update 11 / D2).
 * Offline-first: cache in exchange_rates; optional live fetch; manual entry always allowed.
 */
const { round3 } = require('./round3');

const DEFAULT_CURRENCIES = [
  { code: 'IRR', name: 'ریال ایران', symbol: '﷼', is_base: 1 },
  { code: 'USD', name: 'دلار آمریکا', symbol: '$', is_base: 0 },
  { code: 'EUR', name: 'یورو', symbol: '€', is_base: 0 },
  { code: 'AED', name: 'درهم امارات', symbol: 'د.إ', is_base: 0 },
  { code: 'TRY', name: 'لیر ترکیه', symbol: '₺', is_base: 0 },
];

function ensureFxTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS currencies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      symbol TEXT DEFAULT '',
      is_base INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS exchange_rates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      currency TEXT NOT NULL,
      date TEXT NOT NULL,
      rate_rial INTEGER NOT NULL,
      source TEXT DEFAULT 'manual',
      created_at INTEGER DEFAULT (strftime('%s','now')),
      UNIQUE(currency, date, source)
    );
  `);
  const cnt = db.prepare('SELECT COUNT(*) c FROM currencies').get().c;
  if (!cnt) {
    const ins = db.prepare('INSERT OR IGNORE INTO currencies (code,name,symbol,is_base) VALUES (?,?,?,?)');
    for (const c of DEFAULT_CURRENCIES) ins.run(c.code, c.name, c.symbol, c.is_base);
  }
}

/** Latest cached rate_rial for currency (1 unit → rial). IRR → 1. */
function getCachedRate(db, currency, date) {
  const code = String(currency || 'IRR').toUpperCase();
  if (code === 'IRR' || code === 'TMN' || code === 'IRT') return 1;
  const d = date || '';
  let row = null;
  if (d) {
    row = db.prepare(
      "SELECT rate_rial FROM exchange_rates WHERE currency=? AND date<=? ORDER BY date DESC, id DESC LIMIT 1"
    ).get(code, d);
  }
  if (!row) {
    row = db.prepare(
      'SELECT rate_rial FROM exchange_rates WHERE currency=? ORDER BY date DESC, id DESC LIMIT 1'
    ).get(code);
  }
  return row ? Math.round(Number(row.rate_rial) || 0) : 0;
}

function setManualRate(db, currency, date, rateRial, source = 'manual') {
  const code = String(currency || '').toUpperCase();
  const d = date || require('../jalali').todayJalali();
  const rate = Math.round(Number(rateRial) || 0);
  if (!code || rate <= 0) throw new Error('نرخ ارز نامعتبر');
  db.prepare(`
    INSERT INTO exchange_rates (currency,date,rate_rial,source) VALUES (?,?,?,?)
    ON CONFLICT(currency, date, source) DO UPDATE SET rate_rial=excluded.rate_rial
  `).run(code, d, rate, source || 'manual');
  const row = db.prepare(
    'SELECT * FROM exchange_rates WHERE currency=? AND date=? AND source=? ORDER BY id DESC LIMIT 1'
  ).get(code, d, source || 'manual');
  return {
    id: row?.id,
    currency: code,
    date: d,
    rate_rial: rate,
    source: source || 'manual',
  };
}

/** foreign_amount × rate → INTEGER rial */
function toRial(foreignAmount, rateRial) {
  const amt = Number(foreignAmount) || 0;
  const rate = Math.round(Number(rateRial) || 0);
  return Math.round(amt * rate);
}

/**
 * Try live fetch from public FX mirrors (best-effort). Falls back to cache.
 * Sources: tgju.org (unofficial mirror of market/CBI-linked rates). Offline-first.
 */
async function fetchAndCacheRate(db, currency, date) {
  const code = String(currency || '').toUpperCase();
  if (code === 'IRR') return { rate_rial: 1, source: 'base' };
  const cached = getCachedRate(db, code, date);
  const d = date || require('../jalali').todayJalali();
  try {
    const https = require('https');
    // Map currency → tgju slug (best-effort public API; mirrors CBI/market rates)
    const slugMap = {
      USD: 'price_dollar_rl',
      EUR: 'price_eur',
      AED: 'price_aed',
      TRY: 'price_try',
      GBP: 'price_gbp',
    };
    const slug = slugMap[code];
    if (slug) {
      const rate = await new Promise((resolve) => {
        const req = https.get(`https://api.tgju.org/v1/market/indicator/summary-table-data/${slug}`, { timeout: 4000 }, (res) => {
          let body = '';
          res.on('data', (c) => { body += c; });
          res.on('end', () => {
            try {
              const j = JSON.parse(body);
              // tgju returns nested; try common shapes
              const p = j?.data?.[0]?.p || j?.p || j?.price || j?.data?.price;
              const n = parseInt(String(p).replace(/[^\d]/g, ''), 10);
              resolve(n > 0 ? n : 0);
            } catch (_) { resolve(0); }
          });
        });
        req.on('error', () => resolve(0));
        req.on('timeout', () => { req.destroy(); resolve(0); });
      });
      if (rate > 0) {
        setManualRate(db, code, d, rate, 'cbi_tgju');
        return { rate_rial: rate, source: 'cbi_tgju' };
      }
    }
  } catch (_) { /* network unavailable */ }
  if (cached > 0) return { rate_rial: cached, source: 'cache' };
  return { rate_rial: cached, source: cached > 0 ? 'cache' : 'none' };
}

module.exports = {
  DEFAULT_CURRENCIES,
  ensureFxTables,
  getCachedRate,
  setManualRate,
  toRial,
  fetchAndCacheRate,
  round3,
};
