/**
 * SMS Module — templates / options / scheduled / auto-rules.
 */
const router = require('express').Router();
const { getDB, audit } = require('../db');
const { auth, adminOnly, adminOrAccounting, centralOnly } = require('../middleware/auth');
const { sendSMS } = require('../sms');
const { todayJalali } = require('../jalali');
const {
  SMS_VARS, SMS_EVENTS, dispatchSmsEvent, ensureSmsRulesTable, settingsMap,
} = require('../lib/sms-dispatch');
const {
  getPublicSmsSettings,
  updateSettings,
} = require('../lib/secret-settings');

function canManageSms(req) {
  return req.user && (req.user.role === 'admin' || req.user.role === 'accounting');
}

router.get('/vars', auth, adminOrAccounting, (req, res) => {
  res.json({ vars: SMS_VARS, events: SMS_EVENTS });
});

// ── Provider settings
router.get('/provider', auth, adminOrAccounting, (req, res) => {
  res.json(getPublicSmsSettings(getDB(), ['welcome_sms_text']));
});

router.put('/provider', auth, adminOnly, centralOnly, (req, res) => {
  const db = getDB();
  const keys = ['sms_provider', 'sms_api_key', 'sms_from', 'niksms_api_key', 'smsir_api_key', 'smsir_line', 'welcome_sms_text'];
  updateSettings(db, Object.entries(req.body || {}), new Set(keys));
  audit(req.user.id, 'update', 'sms_provider', null, 'ویرایش تنظیمات پیامک');
  res.json({ ok: true });
});

router.post('/test', auth, adminOnly, async (req, res) => {
  const to = String(req.body.to || '').trim();
  if (!to) return res.status(400).json({ error: 'شماره الزامی است' });
  const db = getDB();
  const s = settingsMap(db);
  const text = req.body.text || s.welcome_sms_text || 'تست پیامک ERP ترنم';
  const result = await sendSMS(s, to, text);
  res.json(result);
});

// ── Templates
router.get('/templates', auth, adminOrAccounting, (req, res) => {
  res.json(getDB().prepare('SELECT * FROM sms_templates ORDER BY name').all());
});

router.post('/templates', auth, adminOrAccounting, (req, res) => {
  if (!canManageSms(req)) return res.status(403).json({ error: 'دسترسی ندارید' });
  const { code, name, event_key, body, active } = req.body;
  if (!code || !name) return res.status(400).json({ error: 'کد و نام الزامی است' });
  const db = getDB();
  try {
    const r = db.prepare('INSERT INTO sms_templates (code,name,event_key,body,active,created_by) VALUES (?,?,?,?,?,?)')
      .run(String(code).trim(), String(name).trim(), event_key || '', body || '', active != null ? (active ? 1 : 0) : 1, req.user.id);
    res.json(db.prepare('SELECT * FROM sms_templates WHERE id=?').get(r.lastInsertRowid));
  } catch (e) {
    res.status(400).json({ error: e.message.includes('UNIQUE') ? 'کد تکراری است' : e.message });
  }
});

router.put('/templates/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM sms_templates WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  const { name, event_key, body, active } = req.body;
  db.prepare('UPDATE sms_templates SET name=?,event_key=?,body=?,active=?,updated_at=strftime(\'%s\',\'now\') WHERE id=?')
    .run(name || row.name, event_key ?? row.event_key, body ?? row.body, active != null ? (active ? 1 : 0) : row.active, row.id);
  res.json({ ok: true });
});

router.delete('/templates/:id', auth, adminOrAccounting, (req, res) => {
  getDB().prepare('DELETE FROM sms_templates WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ── Options per section
router.get('/options', auth, adminOrAccounting, (req, res) => {
  res.json(getDB().prepare(`
    SELECT o.*, t.name as template_name, t.code as template_code
    FROM sms_options o LEFT JOIN sms_templates t ON t.id=o.template_id
    ORDER BY o.section_key, o.label
  `).all());
});

router.post('/options', auth, adminOrAccounting, (req, res) => {
  const { section_key, label, template_id, active } = req.body;
  if (!section_key || !label) return res.status(400).json({ error: 'بخش و برچسب الزامی است' });
  const db = getDB();
  const r = db.prepare('INSERT INTO sms_options (section_key,label,template_id,active,created_by) VALUES (?,?,?,?,?)')
    .run(section_key, label, template_id || null, active != null ? (active ? 1 : 0) : 1, req.user.id);
  res.json(db.prepare('SELECT * FROM sms_options WHERE id=?').get(r.lastInsertRowid));
});

router.put('/options/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM sms_options WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  const { section_key, label, template_id, active } = req.body;
  db.prepare('UPDATE sms_options SET section_key=?,label=?,template_id=?,active=? WHERE id=?')
    .run(section_key || row.section_key, label || row.label, template_id != null ? template_id : row.template_id,
      active != null ? (active ? 1 : 0) : row.active, row.id);
  res.json({ ok: true });
});

router.delete('/options/:id', auth, adminOrAccounting, (req, res) => {
  getDB().prepare('DELETE FROM sms_options WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ── Auto rules (event + group/user + delay)
router.get('/rules', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  ensureSmsRulesTable(db);
  res.json(db.prepare(`
    SELECT r.*, t.name as template_name, t.code as template_code,
      pg.name as party_group_name, u.name as user_name
    FROM sms_rules r
    LEFT JOIN sms_templates t ON t.id=r.template_id
    LEFT JOIN party_groups pg ON pg.id=r.party_group_id
    LEFT JOIN users u ON u.id=r.user_id
    ORDER BY r.event_key, r.id DESC
  `).all());
});

router.post('/rules', auth, adminOrAccounting, (req, res) => {
  if (!canManageSms(req)) return res.status(403).json({ error: 'دسترسی ندارید' });
  const { event_key, party_group_id, user_id, template_id, delay_minutes, active } = req.body;
  if (!event_key || !template_id) return res.status(400).json({ error: 'رویداد و قالب الزامی است' });
  const db = getDB();
  ensureSmsRulesTable(db);
  const r = db.prepare(`
    INSERT INTO sms_rules (event_key,party_group_id,user_id,template_id,delay_minutes,active,created_by)
    VALUES (?,?,?,?,?,?,?)
  `).run(
    String(event_key).trim(),
    party_group_id ? +party_group_id : null,
    user_id ? +user_id : null,
    +template_id,
    Math.max(0, parseInt(delay_minutes, 10) || 0),
    active != null ? (active ? 1 : 0) : 1,
    req.user.id
  );
  res.json(db.prepare('SELECT * FROM sms_rules WHERE id=?').get(r.lastInsertRowid));
});

router.put('/rules/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  ensureSmsRulesTable(db);
  const row = db.prepare('SELECT * FROM sms_rules WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  const { event_key, party_group_id, user_id, template_id, delay_minutes, active } = req.body;
  db.prepare(`
    UPDATE sms_rules SET event_key=?, party_group_id=?, user_id=?, template_id=?, delay_minutes=?, active=?,
      updated_at=strftime('%s','now') WHERE id=?
  `).run(
    event_key || row.event_key,
    party_group_id !== undefined ? (party_group_id ? +party_group_id : null) : row.party_group_id,
    user_id !== undefined ? (user_id ? +user_id : null) : row.user_id,
    template_id != null ? +template_id : row.template_id,
    delay_minutes != null ? Math.max(0, parseInt(delay_minutes, 10) || 0) : row.delay_minutes,
    active != null ? (active ? 1 : 0) : row.active,
    row.id
  );
  res.json({ ok: true });
});

router.delete('/rules/:id', auth, adminOrAccounting, (req, res) => {
  getDB().prepare('DELETE FROM sms_rules WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ── Scheduled
router.get('/scheduled', auth, adminOrAccounting, (req, res) => {
  res.json(getDB().prepare('SELECT * FROM sms_scheduled ORDER BY send_at DESC, id DESC LIMIT 200').all());
});

router.post('/scheduled', auth, adminOrAccounting, (req, res) => {
  const { phone, body, send_at, template_id } = req.body;
  if (!phone || !body || !send_at) return res.status(400).json({ error: 'شماره، متن و زمان الزامی است' });
  const db = getDB();
  const r = db.prepare('INSERT INTO sms_scheduled (phone,body,send_at,template_id,created_by) VALUES (?,?,?,?,?)')
    .run(phone, body, send_at, template_id || null, req.user.id);
  res.json(db.prepare('SELECT * FROM sms_scheduled WHERE id=?').get(r.lastInsertRowid));
});

router.delete('/scheduled/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM sms_scheduled WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  if (row.status === 'sent') return res.status(400).json({ error: 'پیامک ارسال‌شده قابل حذف نیست' });
  db.prepare('DELETE FROM sms_scheduled WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

/** Process due scheduled SMS — call from cron / boot interval */
async function processScheduledSms(db) {
  const now = todayJalali();
  const due = db.prepare(`
    SELECT * FROM sms_scheduled WHERE status='pending' AND send_at<=? ORDER BY send_at LIMIT 80
  `).all(now + ' 23:59');
  const s = settingsMap(db);
  const nowMs = Date.now();
  const isoNow = new Date().toISOString();
  for (const row of due) {
    const at = String(row.send_at || '');
    // ISO timestamps: only send when due
    if (/^\d{4}-\d{2}-\d{2}T/.test(at) && at > isoNow) continue;
    try {
      const result = await sendSMS(s, row.phone, row.body);
      db.prepare('UPDATE sms_scheduled SET status=?, sent_at=?, error=? WHERE id=?')
        .run(result.ok ? 'sent' : 'failed', Math.floor(nowMs / 1000), result.ok ? '' : (result.reason || 'fail'), row.id);
    } catch (e) {
      db.prepare('UPDATE sms_scheduled SET status=?, error=? WHERE id=?').run('failed', e.message, row.id);
    }
  }
}

module.exports = router;
module.exports.processScheduledSms = processScheduledSms;
module.exports.dispatchSmsEvent = dispatchSmsEvent;
