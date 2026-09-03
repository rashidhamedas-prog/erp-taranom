/**
 * SMS auto-dispatch: templates + rules → send now or schedule.
 */
const { sendSMS } = require('../sms');
const { todayJalali } = require('../jalali');
const { getSmsSettings } = require('./secret-settings');

const SMS_VARS = [
  { key: '{name}', label: 'نام شخص / مشتری' },
  { key: '{biz}', label: 'نام فروشگاه / کسب‌وکار' },
  { key: '{phone}', label: 'شماره موبایل' },
  { key: '{amount}', label: 'مبلغ (ریال)' },
  { key: '{num}', label: 'شماره فاکتور / سند' },
  { key: '{date}', label: 'تاریخ' },
  { key: '{note}', label: 'یادداشت' },
  { key: '{user}', label: 'نام کاربر ثبت‌کننده' },
  { key: '{group}', label: 'گروه اشخاص' },
  { key: '{status}', label: 'وضعیت (نوع سند / حساب)' },
  { key: '{tracking}', label: 'کد رهگیری / شماره پیگیری' },
  { key: '{code}', label: 'کد یک‌بارمصرف (OTP)' },
];

const SMS_EVENTS = [
  { key: 'invoice.approved', label: 'تأیید فاکتور رسمی', kind: 'rule' },
  { key: 'invoice.created', label: 'ثبت فاکتور رسمی', kind: 'rule' },
  { key: 'invoice.converted', label: 'تبدیل پیش‌فاکتور به فاکتور قطعی', kind: 'rule' },
  { key: 'settlement.created', label: 'ثبت دریافت / تسویه', kind: 'rule' },
  { key: 'payment.created', label: 'ثبت پرداخت', kind: 'rule' },
  { key: 'customer.created', label: 'ثبت مشتری جدید (قانون قالب)', kind: 'rule' },
  { key: 'customer.welcome', label: 'پیامک خوش‌آمدگویی ثبت مشتری', kind: 'system' },
  { key: 'party.created', label: 'ثبت شخص جدید', kind: 'rule' },
  { key: 'person.created', label: 'ثبت شخص (legacy)', kind: 'rule' },
  { key: 'followup.reminder', label: 'یادآوری پیگیری زمان‌دار', kind: 'system' },
  { key: 'followup.group', label: 'یادآور گروهی پیگیری روزانه', kind: 'system' },
  { key: 'auth.otp', label: 'کد ورود / بازیابی رمز کاربر', kind: 'system' },
  { key: 'b2b.otp', label: 'کد ورود پورتال مشتری (B2B)', kind: 'system' },
  { key: 'portal.invite', label: 'فعال‌سازی دسترسی پورتال مشتری', kind: 'rule' },
  { key: 'portal.dept', label: 'پیامک واحد عملیاتی پورتال', kind: 'system' },
  { key: 'rep.notify', label: 'اعلان نماینده فروش', kind: 'system' },
];

function settingsMap(db) {
  return getSmsSettings(db);
}

function applyVars(body, vars) {
  let out = String(body || '');
  const map = vars || {};
  for (const [k, v] of Object.entries(map)) {
    const token = k.startsWith('{') ? k : `{${k}}`;
    out = out.split(token).join(v == null ? '' : String(v));
  }
  return out;
}

function fmtAmount(n) {
  const x = Math.round(Number(n) || 0);
  try { return x.toLocaleString('fa-IR'); } catch (_) { return String(x); }
}

function ensureSmsRulesTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sms_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_key TEXT NOT NULL,
      party_group_id INTEGER,
      user_id INTEGER,
      template_id INTEGER NOT NULL,
      delay_minutes INTEGER NOT NULL DEFAULT 0,
      active INTEGER DEFAULT 1,
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      updated_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(template_id) REFERENCES sms_templates(id)
    );
    CREATE INDEX IF NOT EXISTS idx_sms_rules_event ON sms_rules(event_key, active);
  `);
}

function jalaliSendAt(delayMinutes) {
  const d = new Date(Date.now() + Math.max(0, Number(delayMinutes) || 0) * 60000);
  // Store as Jalali date + HH:MM for processScheduledSms date compare; also keep ISO in note via space time
  const j = todayJalali();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  // If delay is 0 we don't schedule; for future delays use todayJalali of target day when crossing midnight is rare —
  // use Gregorian ISO as send_at when delay > 0 so processScheduledSms can compare loosely.
  if ((Number(delayMinutes) || 0) <= 0) return j + ' ' + hh + ':' + mm;
  return d.toISOString();
}

/**
 * @param {object} db
 * @param {string} eventKey
 * @param {object} payload { phone, name, biz, amount, num, date, note, user, group, party_group_id, user_id }
 */
async function dispatchSmsEvent(db, eventKey, payload) {
  try {
    ensureSmsRulesTable(db);
    const phone = String(payload.phone || '').trim();
    if (!phone) return { ok: false, reason: 'no_phone' };

    let rules = db.prepare(`
      SELECT r.*, t.body as template_body, t.active as template_active, t.name as template_name
      FROM sms_rules r
      JOIN sms_templates t ON t.id=r.template_id
      WHERE r.active=1 AND t.active=1 AND r.event_key=?
    `).all(eventKey);

    rules = rules.filter((r) => {
      if (r.party_group_id != null && Number(r.party_group_id) !== Number(payload.party_group_id || 0)) return false;
      if (r.user_id != null && Number(r.user_id) !== Number(payload.user_id || 0)) return false;
      return true;
    });
    if (!rules.length) return { ok: true, sent: 0 };

    const vars = {
      '{name}': payload.name || payload.biz || '',
      '{biz}': payload.biz || payload.name || '',
      '{phone}': phone,
      '{amount}': fmtAmount(payload.amount),
      '{num}': payload.num || '',
      '{date}': payload.date || todayJalali(),
      '{note}': payload.note || '',
      '{user}': payload.user || '',
      '{group}': payload.group || '',
      '{status}': payload.status || '',
      '{tracking}': payload.tracking || '',
      '{code}': payload.code || '',
    };

    const s = settingsMap(db);
    let sent = 0;
    for (const r of rules) {
      const body = applyVars(r.template_body, vars);
      const delay = Math.max(0, parseInt(r.delay_minutes, 10) || 0);
      if (delay > 0) {
        const sendAt = jalaliSendAt(delay);
        db.prepare('INSERT INTO sms_scheduled (phone,body,send_at,template_id,created_by) VALUES (?,?,?,?,?)')
          .run(phone, body, sendAt, r.template_id, payload.created_by || null);
        sent++;
      } else {
        const result = await sendSMS(s, phone, body);
        if (result && result.ok) sent++;
      }
    }
    return { ok: true, sent };
  } catch (e) {
    console.warn('sms-dispatch:', e.message);
    return { ok: false, reason: e.message };
  }
}

/**
 * Prefer an active rule+template; if none, send fallbackText once.
 * Prevents OTP/reminder double-send when both hardcoded and a rule exist.
 */
async function dispatchSmsOrFallback(db, eventKey, payload, fallbackText) {
  const r = await dispatchSmsEvent(db, eventKey, payload);
  if (r && r.sent > 0) return { ...r, via: 'rule' };
  const phone = String((payload && payload.phone) || '').trim();
  if (!phone || !fallbackText) return { ok: true, sent: 0, via: 'none' };
  const result = await sendSMS(settingsMap(db), phone, fallbackText);
  return { ok: !!(result && result.ok), sent: result && result.ok ? 1 : 0, via: 'fallback', result };
}

module.exports = {
  SMS_VARS,
  SMS_EVENTS,
  applyVars,
  dispatchSmsEvent,
  dispatchSmsOrFallback,
  ensureSmsRulesTable,
  settingsMap,
};
