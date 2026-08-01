/**
 * Rubika Bot API helper — send text / image to a configured chat.
 * Docs pattern: https://botapi.rubika.ir/v3/{token}/...
 */
const https = require('https');
const fs = require('fs');
const path = require('path');
const { getSettings } = require('./secret-settings');

function postJSON(hostname, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname,
      path: urlPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Content-Length': Buffer.byteLength(data),
        ...headers,
      },
      timeout: 20000,
    }, (res) => {
      let raw = '';
      res.on('data', (d) => (raw += d));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(data);
    req.end();
  });
}

function getRubikaSettings(db) {
  return getSettings(db, ['rubika_bot_token', 'rubika_chat_id', 'rubika_invoice_enabled']);
}

async function sendRubikaText(db, text) {
  const s = getRubikaSettings(db);
  if (s.rubika_invoice_enabled !== '1') return { ok: false, reason: 'disabled' };
  const token = (s.rubika_bot_token || '').trim();
  const chatId = (s.rubika_chat_id || '').trim();
  if (!token || !chatId) return { ok: false, reason: 'missing token or chat_id' };
  try {
    const r = await postJSON(
      'botapi.rubika.ir',
      `/v3/${encodeURIComponent(token)}/sendMessage`,
      { chat_id: chatId, text: String(text || '').slice(0, 4000) }
    );
    return { ok: r.status === 200, data: r.body };
  } catch {
    return { ok: false, reason: 'rubika provider request failed' };
  }
}

async function sendRubikaImage(db, filePath, caption) {
  const s = getRubikaSettings(db);
  if (s.rubika_invoice_enabled !== '1') return { ok: false, reason: 'disabled' };
  const token = (s.rubika_bot_token || '').trim();
  const chatId = (s.rubika_chat_id || '').trim();
  if (!token || !chatId) return { ok: false, reason: 'missing token or chat_id' };
  if (!filePath || !fs.existsSync(filePath)) return { ok: false, reason: 'file missing' };

  // Upload as base64 data URL (Rubika bots accept file via sendFile with inline data in many setups)
  const buf = fs.readFileSync(filePath);
  const b64 = buf.toString('base64');
  const ext = path.extname(filePath).toLowerCase() || '.png';
  const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';
  try {
    const r = await postJSON(
      'botapi.rubika.ir',
      `/v3/${encodeURIComponent(token)}/sendFile`,
      {
        chat_id: chatId,
        file: `data:${mime};base64,${b64}`,
        caption: String(caption || '').slice(0, 1000),
        type: 'Image',
      }
    );
    if (r.status === 200) return { ok: true, data: r.body };
    // Fallback: text with caption if file API rejects
    return sendRubikaText(db, (caption || 'فاکتور') + '\n(ارسال تصویر ناموفق — خلاصه متنی)');
  } catch {
    return { ok: false, reason: 'rubika provider request failed' };
  }
}

function invoiceSummaryText(inv, custName) {
  const amt = Math.round(Number(inv.final) || 0).toLocaleString('fa-IR');
  return [
    '✅ فاکتور تأیید شد',
    `شماره: ${inv.num || inv.id}`,
    `مشتری: ${custName || '-'}`,
    `تاریخ: ${inv.date || '-'}`,
    `مبلغ: ${amt} ریال`,
  ].join('\n');
}

module.exports = { sendRubikaText, sendRubikaImage, getRubikaSettings, invoiceSummaryText };
