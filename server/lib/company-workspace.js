/**
 * Multi-company workspaces — each company has its own SQLite file.
 * Registry lives beside the default DB (not inside a company DB) so switching
 * always finds the catalog even when the active DB changes.
 *
 * Central-only feature. Devices stay on a single DB_PATH.
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const REGISTRY_VERSION = 1;

function defaultDbPath() {
  return process.env.DB_PATH || path.join(__dirname, '..', 'crm.db');
}

function registryPath() {
  const base = process.env.COMPANIES_DIR
    || path.join(path.dirname(defaultDbPath()), 'data', 'companies');
  return path.join(base, 'registry.json');
}

function companiesDir() {
  return path.dirname(registryPath());
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readRegistry() {
  const rp = registryPath();
  ensureDir(path.dirname(rp));
  if (!fs.existsSync(rp)) {
    const dbPath = path.resolve(defaultDbPath());
    const reg = {
      version: REGISTRY_VERSION,
      activeCompanyId: 1,
      nextId: 2,
      companies: [{
        id: 1,
        name: 'پوشاک ترنم',
        code: 'DEFAULT',
        dbPath,
        createdAt: Math.floor(Date.now() / 1000),
        isDefault: true,
      }],
    };
    writeRegistry(reg);
    return reg;
  }
  const reg = JSON.parse(fs.readFileSync(rp, 'utf8'));
  if (!Array.isArray(reg.companies) || !reg.companies.length) {
    throw new Error('رجیستری شرکت‌ها خالی یا خراب است');
  }
  return reg;
}

function writeRegistry(reg) {
  const rp = registryPath();
  ensureDir(path.dirname(rp));
  const tmp = rp + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(reg, null, 2), 'utf8');
  fs.renameSync(tmp, rp);
}

function listCompanies() {
  const reg = readRegistry();
  return {
    activeCompanyId: reg.activeCompanyId,
    companies: reg.companies.map(c => ({
      id: c.id,
      name: c.name,
      code: c.code || '',
      isDefault: !!c.isDefault,
      isActive: c.id === reg.activeCompanyId,
      dbExists: fs.existsSync(c.dbPath),
      createdAt: c.createdAt || null,
    })),
  };
}

function getActiveCompany() {
  const reg = readRegistry();
  const c = reg.companies.find(x => x.id === reg.activeCompanyId) || reg.companies[0];
  return c;
}

function getCompanyById(id) {
  const reg = readRegistry();
  return reg.companies.find(x => x.id === Number(id)) || null;
}

function resolveActiveDbPath() {
  // Explicit test isolation: honor DB_PATH and skip shared Temp company registry.
  if (process.env.ERP_TEST_ISOLATION === '1' && process.env.DB_PATH) {
    return path.resolve(process.env.DB_PATH);
  }
  try {
    const c = getActiveCompany();
    if (c?.dbPath && fs.existsSync(c.dbPath)) return c.dbPath;
  } catch { /* first boot before registry */ }
  return path.resolve(defaultDbPath());
}

function updateCompanyMeta(id, patch) {
  const reg = readRegistry();
  const c = reg.companies.find(x => x.id === Number(id));
  if (!c) throw new Error('شرکت یافت نشد');
  if (patch.name != null) {
    const name = String(patch.name).trim();
    if (!name) throw new Error('نام شرکت الزامی است');
    c.name = name;
  }
  if (patch.code != null) c.code = String(patch.code).trim();
  writeRegistry(reg);
  return c;
}

/**
 * Create a brand-new company DB with schema + copied admin users + clean fiscal year.
 * Does NOT switch the live connection — caller may activate afterwards.
 */
function createCompanyWorkspace(opts) {
  const {
    name,
    code,
    startDate,
    fiscalLabel,
    sourceDb, // better-sqlite3 handle of current company (for copying users)
    createdByUserId,
  } = opts;
  if (!name || !String(name).trim()) throw new Error('نام شرکت الزامی است');

  const reg = readRegistry();
  const id = reg.nextId || (Math.max(...reg.companies.map(c => c.id)) + 1);
  const codeVal = (code && String(code).trim()) || (`C${id}`);
  if (reg.companies.some(c => (c.code || '').toLowerCase() === codeVal.toLowerCase())) {
    throw new Error('کد شرکت تکراری است');
  }

  ensureDir(companiesDir());
  const dbFile = path.join(companiesDir(), `company-${id}.db`);
  if (fs.existsSync(dbFile)) throw new Error('فایل دیتابیس شرکت از قبل وجود دارد');

  // Create empty file then init via db module helpers without swapping live handle.
  const { applyConnectionPragmas, initDBOn, copyUsersInto } = require('../db');
  const fresh = new Database(dbFile, { timeout: 5000 });
  try {
    applyConnectionPragmas(fresh);
    initDBOn(fresh);
    if (sourceDb) copyUsersInto(fresh, sourceDb);
    // Company profile settings
    fresh.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('company_name',?)").run(String(name).trim());
    if (codeVal) fresh.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('company_code',?)").run(codeVal);

    const { todayJalali } = require('../jalali');
    const start = startDate || (todayJalali().slice(0, 4) + '/01/01');
    const label = fiscalLabel || ('سال مالی ' + start.slice(0, 4));
    // Replace any seed FY with the requested clean year
    fresh.prepare('DELETE FROM fiscal_years').run();
    const fy = fresh.prepare(`
      INSERT INTO fiscal_years (label, start_date, status, created_by) VALUES (?, ?, 'open', ?)
    `).run(label, start, createdByUserId || null);
    fresh.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('active_fiscal_year_id',?)")
      .run(String(fy.lastInsertRowid));
  } finally {
    try { fresh.close(); } catch { /* ignore */ }
  }

  const entry = {
    id,
    name: String(name).trim(),
    code: codeVal,
    dbPath: dbFile,
    createdAt: Math.floor(Date.now() / 1000),
    isDefault: false,
  };
  reg.companies.push(entry);
  reg.nextId = id + 1;
  writeRegistry(reg);
  return entry;
}

function setActiveCompanyId(id) {
  const reg = readRegistry();
  const c = reg.companies.find(x => x.id === Number(id));
  if (!c) throw new Error('شرکت یافت نشد');
  if (!fs.existsSync(c.dbPath)) throw new Error('فایل دیتابیس این شرکت پیدا نشد');
  reg.activeCompanyId = c.id;
  writeRegistry(reg);
  return c;
}

function deleteCompanyWorkspace(id, { force } = {}) {
  const reg = readRegistry();
  const c = reg.companies.find(x => x.id === Number(id));
  if (!c) throw new Error('شرکت یافت نشد');
  if (c.isDefault) throw new Error('شرکت پیش‌فرض قابل حذف نیست');
  if (c.id === reg.activeCompanyId) throw new Error('ابتدا شرکت دیگری را فعال کنید، بعد این شرکت را حذف کنید');
  if (reg.companies.length <= 1) throw new Error('حداقل یک شرکت باید باقی بماند');

  // Safety: refuse delete if DB has invoices unless force+confirm handled by route
  if (fs.existsSync(c.dbPath) && !force) {
    const tmp = new Database(c.dbPath, { readonly: true, timeout: 3000 });
    try {
      const inv = tmp.prepare("SELECT COUNT(*) c FROM invoices WHERE COALESCE(deleted_at,0)=0").get()?.c || 0;
      const je = tmp.prepare("SELECT COUNT(*) c FROM journal_entries WHERE COALESCE(deleted_at,0)=0").get()?.c || 0;
      if (inv > 0 || je > 0) {
        throw new Error(`این شرکت ${inv} فاکتور و ${je} سند دارد — برای حذف قطعی confirm_text=DELETE-COMPANY بفرستید`);
      }
    } finally {
      try { tmp.close(); } catch { /* ignore */ }
    }
  }

  reg.companies = reg.companies.filter(x => x.id !== c.id);
  writeRegistry(reg);

  // Move DB aside instead of hard-delete (recoverable)
  if (fs.existsSync(c.dbPath)) {
    const trash = c.dbPath + '.deleted-' + Date.now();
    try { fs.renameSync(c.dbPath, trash); } catch {
      try { fs.unlinkSync(c.dbPath); } catch { /* ignore */ }
    }
    for (const suf of ['-wal', '-shm']) {
      const side = c.dbPath + suf;
      if (fs.existsSync(side)) {
        try { fs.renameSync(side, trash + suf); } catch {
          try { fs.unlinkSync(side); } catch { /* ignore */ }
        }
      }
    }
  }
  return { ok: true, id: c.id };
}

module.exports = {
  registryPath,
  companiesDir,
  readRegistry,
  listCompanies,
  getActiveCompany,
  getCompanyById,
  resolveActiveDbPath,
  updateCompanyMeta,
  createCompanyWorkspace,
  setActiveCompanyId,
  deleteCompanyWorkspace,
};
