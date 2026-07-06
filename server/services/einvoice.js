// Moadian (سامانه مودیان مالیاتی) e-invoice submission service.
//
// Design: final invoices are queued in einvoice_submissions after approval; a
// 5-minute cron drains the queue with exponential backoff on failure. In sandbox
// mode (einvoice_mode='sandbox', the default) submissions are simulated locally so
// the whole flow can be exercised before real credentials exist. Production mode
// POSTs the invoice payload to the configured service URL — the tenant enters
// شناسه مؤدی / private key / service URL in settings (never committed to git).

const crypto = require('crypto');
const { getSetting } = require('../db');

const MAX_ATTEMPTS = 8;
const BASE_DELAY_S = 60; // 1m, 2m, 4m, ... capped at 4h

function backoffSeconds(attempts) {
  return Math.min(4 * 3600, BASE_DELAY_S * Math.pow(2, attempts));
}

function isEnabled(tenantId) {
  return getSetting(tenantId, 'feature_einvoice') === '1';
}

// Queue a final invoice for submission (no-op if feature disabled or already queued/confirmed)
function queueSubmission(db, tenantId, invoiceId) {
  if (!isEnabled(tenantId)) return { queued: false, reason: 'feature_disabled' };
  const inv = db.prepare("SELECT id, type FROM invoices WHERE id=? AND tenant_id=?").get(invoiceId, tenantId);
  if (!inv || inv.type !== 'final') return { queued: false, reason: 'not_final' };
  const existing = db.prepare(
    "SELECT id, status FROM einvoice_submissions WHERE tenant_id=? AND invoice_id=? AND status IN ('pending','sent','confirmed') ORDER BY id DESC LIMIT 1"
  ).get(tenantId, invoiceId);
  if (existing) return { queued: false, reason: 'already_' + existing.status, id: existing.id };
  const r = db.prepare(
    'INSERT INTO einvoice_submissions (tenant_id, invoice_id, status, next_attempt_at) VALUES (?,?,?,0)'
  ).run(tenantId, invoiceId, 'pending');
  return { queued: true, id: r.lastInsertRowid };
}

// Cancel/void a submission when its invoice is deleted
function cancelSubmission(db, tenantId, invoiceId) {
  db.prepare("UPDATE einvoice_submissions SET status='cancelled', updated_at=strftime('%s','now') WHERE tenant_id=? AND invoice_id=? AND status IN ('pending','sent','confirmed')")
    .run(tenantId, invoiceId);
}

// Build the (simplified) Moadian invoice payload from our invoice row
function buildPayload(db, tenantId, inv) {
  const rows = JSON.parse(inv.rows || '[]');
  return {
    header: {
      taxid_request: true,
      memory_id: getSetting(tenantId, 'einvoice_memory_id') || '',
      invoice_number: inv.num,
      invoice_date: inv.date,
      total: inv.final,
      subtotal: inv.subtotal,
      discount: inv.disc_amt || 0,
      payment_method: inv.pay_type === 'cheque' ? 2 : 1,
    },
    body: rows.map(r => ({
      description: r.name, quantity: r.qty, unit_price: r.price, total: r.sum,
    })),
  };
}

// Perform ONE submission attempt. Returns {ok, tax_id?, response?, error?}
async function attemptSubmission(db, tenantId, inv) {
  const mode = getSetting(tenantId, 'einvoice_mode') || 'sandbox';
  const payload = buildPayload(db, tenantId, inv);

  if (mode !== 'production') {
    // Sandbox: simulate the tax authority — deterministic fake tax ID
    const taxId = 'SBX' + crypto.createHash('sha256').update(`${tenantId}:${inv.id}:${inv.num}`).digest('hex').slice(0, 19).toUpperCase();
    return { ok: true, tax_id: taxId, response: JSON.stringify({ sandbox: true, payload_summary: { num: inv.num, total: inv.final } }) };
  }

  const serviceUrl = getSetting(tenantId, 'einvoice_service_url');
  const memoryId = getSetting(tenantId, 'einvoice_memory_id');
  if (!serviceUrl || !memoryId) return { ok: false, error: 'تنظیمات مودیان ناقص است (آدرس سرویس/شناسه مؤدی)' };

  try {
    // Sign the payload with the tenant's private key when provided (JWS detached-style digest)
    let signature = '';
    const pk = getSetting(tenantId, 'einvoice_private_key');
    if (pk) {
      try {
        const { decrypt } = require('./crypto');
        const keyPem = pk.includes(':') ? decrypt(pk) : pk;
        const signer = crypto.createSign('RSA-SHA256');
        signer.update(JSON.stringify(payload));
        signature = signer.sign(keyPem, 'base64');
      } catch (e) {
        return { ok: false, error: 'خطا در امضای دیجیتال: ' + e.message };
      }
    }
    const res = await fetch(serviceUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(signature ? { 'X-Signature': signature } : {}) },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000),
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 300)}` };
    let data = {};
    try { data = JSON.parse(text); } catch {}
    const taxId = data.taxid || data.tax_id || data.uid || '';
    if (!taxId) return { ok: false, error: 'پاسخ فاقد شناسه مالیاتی: ' + text.slice(0, 300) };
    return { ok: true, tax_id: taxId, response: text.slice(0, 2000) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Drain due queue items across all tenants (called by the 5-minute cron and by manual retry)
async function processQueue(db, { onlyId } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const due = onlyId
    ? db.prepare("SELECT * FROM einvoice_submissions WHERE id=? AND status IN ('pending','failed')").all(onlyId)
    : db.prepare("SELECT * FROM einvoice_submissions WHERE status='pending' AND next_attempt_at<=? ORDER BY id LIMIT 20").all(now);
  let processed = 0;
  for (const sub of due) {
    if (!isEnabled(sub.tenant_id)) continue;
    const inv = db.prepare('SELECT * FROM invoices WHERE id=? AND tenant_id=?').get(sub.invoice_id, sub.tenant_id);
    if (!inv) {
      db.prepare("UPDATE einvoice_submissions SET status='error', error='فاکتور حذف شده', updated_at=? WHERE id=?").run(now, sub.id);
      continue;
    }
    const result = await attemptSubmission(db, sub.tenant_id, inv);
    const attempts = (sub.attempts || 0) + 1;
    if (result.ok) {
      db.prepare("UPDATE einvoice_submissions SET status='confirmed', tax_id=?, raw_response=?, error='', attempts=?, updated_at=? WHERE id=?")
        .run(result.tax_id, result.response || '', attempts, now, sub.id);
      console.log(`🧾 مودیان: فاکتور ${inv.num} تأیید شد (${result.tax_id})`);
    } else if (attempts >= MAX_ATTEMPTS) {
      db.prepare("UPDATE einvoice_submissions SET status='error', error=?, attempts=?, updated_at=? WHERE id=?")
        .run(result.error || 'unknown', attempts, now, sub.id);
      console.error(`🧾 مودیان: فاکتور ${inv.num} پس از ${attempts} تلاش شکست خورد: ${result.error}`);
    } else {
      db.prepare("UPDATE einvoice_submissions SET status='pending', error=?, attempts=?, next_attempt_at=?, updated_at=? WHERE id=?")
        .run(result.error || 'unknown', attempts, now + backoffSeconds(attempts), now, sub.id);
    }
    processed++;
  }
  return processed;
}

module.exports = { queueSubmission, cancelSubmission, processQueue, isEnabled };
