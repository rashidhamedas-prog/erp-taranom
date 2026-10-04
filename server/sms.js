const https = require('https');

function postJSON(hostname, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const options = {
      hostname,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        ...headers
      }
    };
    const req = https.request(options, res => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function sendSMS(settings, to, text) {
  try {
    const { guardDemoEgressOrBlock } = require('./lib/demo-egress');
    const blocked = guardDemoEgressOrBlock('sms');
    if (blocked) return blocked;
  } catch {
    if (/^(true|1|yes)$/i.test(String(process.env.ERP_DEMO_MODE || ''))) {
      return { ok: false, simulated: true, demo: true, channel: 'sms', code: 'demo_simulation', reason: 'در نسخه دمو ارسال واقعی انجام نمی‌شود' };
    }
  }
  const provider = (settings.sms_provider || 'kavenegar').trim();
  const apiKey = (settings.sms_api_key || '').trim();
  const from = (settings.sms_from || '').trim();

  if (!apiKey || !to) return { ok: false, reason: 'missing api_key or phone' };

  // Normalize Iranian phone: Persian/Arabic digits → ASCII, strip separators, ensure starts with 09
  const phone = String(to)
    .replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 0x06F0))
    .replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\s\-()]+/g, '')
    .replace(/^(\+98|0098|98)/, '0');
  if (!/^09\d{9}$/.test(phone)) return { ok: false, reason: 'invalid phone: ' + phone };

  try {
    if (provider === 'kavenegar') {
      const r = await postJSON(
        'api.kavenegar.com',
        `/v1/${encodeURIComponent(apiKey)}/sms/send.json`,
        { receptor: phone, message: text, ...(from ? { sender: from } : {}) }
      );
      const envelope = r.body && r.body.return && r.body.return.status;
      const ok = r.status === 200 && (envelope == null || Number(envelope) === 200);
      return { ok, data: r.body };
    }

    if (provider === 'melipayamak') {
      // api_key field stores "username:password" for Melipayamak
      const [username = '', password = ''] = apiKey.split(':');
      const r = await postJSON(
        'rest.payamak-panel.com',
        '/api/SendSMS/SendSMS',
        { username, password, to: [phone], from, text, isFlash: false }
      );
      const ret = r.body && r.body.RetStatus;
      const ok = r.status === 200 && (ret == null || Number(ret) === 1);
      return { ok, data: r.body };
    }

    if (provider === 'niksms') {
      // NikSMS REST API — api_key stores "username:password"
      const [username = '', password = ''] = apiKey.split(':');
      const r = await postJSON(
        'api.niksms.com',
        '/fa/api/sms/single',
        { username, password, textBody: text, receiver: phone, senderNumber: from || '' }
      );
      const ok = r.status === 200 && r.body && r.body.status !== false;
      return { ok, data: r.body };
    }

    if (provider === 'smsir') {
      // SMS.ir REST API v1: X-API-KEY header, body uses MessageText (singular) + Mobiles array
      const body = { MessageText: text, Mobiles: [phone] };
      if (from) body.lineNumber = from; // optional — uses account default line if omitted
      const r = await postJSON(
        'api.sms.ir',
        '/v1/send/bulk',
        body,
        { 'x-api-key': apiKey }
      );
      const ok = r.status === 200 && r.body && r.body.status === 1;
      return { ok, data: r.body };
    }

    return { ok: false, reason: `unsupported provider: ${provider}` };
  } catch {
    // Do not reflect transport errors that may contain a credential-bearing
    // provider path (for example Kavenegar embeds the key in its URL).
    return { ok: false, reason: 'sms provider request failed' };
  }
}

function postForm(hostname, requestPath, params) {
  return new Promise((resolve, reject) => {
    const data = new URLSearchParams(params).toString();
    const options = {
      hostname,
      path: requestPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(data),
      },
    };
    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', (d) => { raw += d; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function normalizeIranMobile(to) {
  return String(to || '')
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06F0))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\s\-()]+/g, '')
    .replace(/^(\+98|0098|98)/, '0');
}

/** Approved OTP pattern. Does not fall back to a second plain SMS. */
async function sendOtpPattern(settings, to, code, template) {
  const provider = (settings.sms_provider || 'kavenegar').trim();
  const apiKey = (settings.sms_api_key || '').trim();
  const pattern = String(template || '').trim();
  const token = String(code || '').trim();
  if (!apiKey || !pattern || !token || /\s/.test(token) || token.length > 100) {
    return { ok: false, reason: 'missing otp pattern' };
  }
  const phone = normalizeIranMobile(to);
  if (!/^09\d{9}$/.test(phone)) return { ok: false, reason: 'invalid phone' };
  try {
    if (provider === 'kavenegar') {
      const r = await postJSON(
        'api.kavenegar.com',
        `/v1/${encodeURIComponent(apiKey)}/verify/lookup.json`,
        { receptor: phone, token, template: pattern }
      );
      const envelope = r.body && r.body.return && r.body.return.status;
      return { ok: r.status === 200 && Number(envelope) === 200 };
    }
    if (provider === 'melipayamak') {
      const [username = '', password = ''] = apiKey.split(':');
      const r = await postForm(
        'rest.payamak-panel.com',
        '/api/SendSMS/BaseServiceNumber',
        { username, password, text: token, to: phone, bodyId: pattern }
      );
      const value = r.body && (r.body.Value != null ? r.body.Value : r.body.value);
      const recId = String(value == null ? '' : value).replace(/\D/g, '');
      return { ok: r.status === 200 && recId.length > 15 };
    }
    return { ok: false, reason: 'otp pattern unsupported for provider' };
  } catch {
    return { ok: false, reason: 'sms provider request failed' };
  }
}

module.exports = { sendSMS, sendOtpPattern };
