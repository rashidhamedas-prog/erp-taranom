const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { getDB, getDBPath, reopenDatabase, initDB, audit, isDevice } = require('../db');
const { auth, adminOnly, centralOnly } = require('../middleware/auth');
const ws = require('../lib/company-workspace');
const { revokeAllAuthSessions } = require('../lib/auth-sessions');
const { beginCompanySwitch } = require('../lib/company-switch-guard');

function activateCompanySafely(companyId, options = {}) {
  const previousCompany = ws.getActiveCompany();
  const previousDbPath = getDBPath();
  const endSwitch = beginCompanySwitch();
  try {
    const oldDb = getDB();
    // Global session rows use numeric ids that can collide across company DBs.
    // Revoke before changing either registry or handle; cid binding remains a
    // second independent deny if a stale token survived unexpectedly.
    revokeAllAuthSessions();
    try { oldDb.prepare('DELETE FROM user_device_sessions').run(); } catch { /* migration-safe */ }
    const company = ws.setActiveCompanyId(companyId);
    try {
      if (typeof options.openTarget === 'function') options.openTarget(company);
      else {
        reopenDatabase(company.dbPath);
        initDB();
      }
    } catch (switchError) {
      // Registry is written before the handle swap. Restore both registry and
      // live handle before surfacing failure so startup and subsequent requests
      // cannot observe different active companies.
      try {
        if (previousCompany) ws.setActiveCompanyId(previousCompany.id);
        reopenDatabase(previousDbPath);
        initDB();
      } catch (rollbackError) {
        const fatal = new Error('تغییر شرکت و بازگردانی وضعیت قبلی هر دو ناموفق شدند');
        fatal.code = 'COMPANY_SWITCH_ROLLBACK_FAILED';
        fatal.status = 500;
        fatal.cause = rollbackError;
        throw fatal;
      }
      switchError.code = switchError.code || 'COMPANY_SWITCH_FAILED';
      switchError.status = switchError.status || 500;
      throw switchError;
    }
    try { getDB().prepare('DELETE FROM user_device_sessions').run(); } catch { /* migration-safe */ }
    return company;
  } finally {
    endSwitch();
  }
}

router.get('/', auth, adminOnly, (req, res) => {
  if (isDevice()) {
    return res.json({
      activeCompanyId: 1,
      companies: [{ id: 1, name: 'محلی', code: 'DEVICE', isDefault: true, isActive: true, dbExists: true }],
      device: true,
    });
  }
  const data = ws.listCompanies();
  // Enrich active company name from settings if default still has placeholder
  try {
    const db = getDB();
    const cn = db.prepare("SELECT value FROM settings WHERE key='company_name'").get()?.value;
    const active = data.companies.find(c => c.isActive);
    if (active && cn && (active.name === 'پوشاک ترنم' || !active.name)) {
      active.name = cn;
    }
  } catch { /* ignore */ }
  res.json(data);
});

router.post('/', auth, adminOnly, centralOnly, (req, res) => {
  try {
    const { name, code, start_date, fiscal_label, activate } = req.body || {};
    const db = getDB();
    const entry = ws.createCompanyWorkspace({
      name,
      code,
      startDate: start_date,
      fiscalLabel: fiscal_label,
      sourceDb: db,
      createdByUserId: req.user.id,
    });
    audit(req.user.id, 'company_create', 'company', entry.id, `ایجاد شرکت ${entry.name}`);

    if (activate) {
      activateCompanySafely(entry.id);
      audit(req.user.id, 'company_activate', 'company', entry.id, `فعال‌سازی شرکت ${entry.name}`);
      return res.json({ ok: true, company: entry, activated: true, reload: true });
    }
    res.json({ ok: true, company: entry, activated: false });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
});

router.put('/:id', auth, adminOnly, centralOnly, (req, res) => {
  try {
    const c = ws.updateCompanyMeta(req.params.id, {
      name: req.body?.name,
      code: req.body?.code,
    });
    // If editing the active company, also mirror name into settings
    const active = ws.getActiveCompany();
    if (active && active.id === c.id && req.body?.name) {
      getDB().prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('company_name',?)")
        .run(String(req.body.name).trim());
    }
    audit(req.user.id, 'company_update', 'company', c.id, `ویرایش شرکت ${c.name}`);
    res.json({ ok: true, company: { id: c.id, name: c.name, code: c.code } });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/:id/activate', auth, adminOnly, centralOnly, (req, res) => {
  try {
    const c = activateCompanySafely(req.params.id);
    audit(req.user.id, 'company_activate', 'company', c.id, `فعال‌سازی شرکت ${c.name}`);
    res.json({ ok: true, company: { id: c.id, name: c.name, code: c.code }, reload: true });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
});

router.delete('/:id', auth, adminOnly, centralOnly, (req, res) => {
  try {
    const { confirm_password, confirm_text } = req.body || {};
    const user = getDB().prepare('SELECT password FROM users WHERE id=?').get(req.user.id);
    if (!user || !bcrypt.compareSync(confirm_password || '', user.password)) {
      return res.status(403).json({ error: 'رمز عبور نادرست است' });
    }
    const force = confirm_text === 'DELETE-COMPANY';
    const result = ws.deleteCompanyWorkspace(req.params.id, { force });
    audit(req.user.id, 'company_delete', 'company', result.id, 'حذف شرکت');
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
module.exports._test = { activateCompanySafely };
