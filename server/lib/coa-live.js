'use strict';

/**
 * اتصال زندهٔ مسترهای هر بخش به ردیف دفترکل.
 * کد موجود عوض نمی‌شود. اگر کد هست ولی ردیف chart نیست، همان کد درج می‌شود.
 * اگر کد خالی است، همان allocTafsili قبلی (۱۲ رقم زیر پوسته) پر می‌شود.
 * روی دستگاه (SYNC_ROLE=device) نوشتن انجام نمی‌شود.
 */

const { allocTafsili } = require('./coa-map');
const {
  ensureSupplierTafsili,
  ensureCustomerTafsili,
  ensurePartyTafsili,
} = require('./party-tafsili');

const PRODUCT_CAP = 400;

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function inferParent(db, code) {
  const c = String(code || '');
  if (!c) return null;
  if (c.includes('-')) {
    const head = c.split('-')[0];
    if (head && head !== c && db.prepare('SELECT 1 FROM chart_of_accounts WHERE code=?').get(head)) return head;
  }
  if (c.length >= 12) {
    const six = c.slice(0, 6);
    if (db.prepare('SELECT 1 FROM chart_of_accounts WHERE code=?').get(six)) return six;
    const four = c.slice(0, 4);
    if (db.prepare('SELECT 1 FROM chart_of_accounts WHERE code=?').get(four)) return four;
  }
  return null;
}

/** ردیف دفترکل برای کد تفصیلی‌ای که روی مستر هست ولی در chart نیست. کد کنترل ۴رقمی ساخته نمی‌شود. */
function ensureChartRow(db, code, name, typeHint, tafsiliType) {
  const c = String(code || '').trim();
  if (!c) return false;
  const existing = db.prepare('SELECT code, parent_code FROM chart_of_accounts WHERE code=?').get(c);
  if (existing) {
    if (!existing.parent_code) {
      const parent = inferParent(db, c);
      if (parent) {
        db.prepare("UPDATE chart_of_accounts SET parent_code=? WHERE code=? AND (parent_code IS NULL OR TRIM(parent_code)='')")
          .run(parent, c);
      }
    }
    return false;
  }
  const operational = c.length >= 12 || c.includes('-');
  if (!operational) return false;
  const parent = inferParent(db, c);
  let type = typeHint || 'asset';
  if (parent) {
    const prow = db.prepare('SELECT type FROM chart_of_accounts WHERE code=?').get(parent);
    if (prow && prow.type) type = prow.type;
  }
  const label = String(name || '').trim() || c;
  db.prepare(`INSERT INTO chart_of_accounts (code,name,type,parent_code,level,tafsili_type,is_active)
    VALUES (?,?,?,?,4,?,1)`).run(c, label, type, parent, tafsiliType || null);
  return true;
}

function isDeviceRole() {
  try {
    const dbMod = require('../db');
    if (typeof dbMod.isDevice === 'function') return !!dbMod.isDevice();
    return !!dbMod.isDevice;
  } catch (_) {
    return String(process.env.SYNC_ROLE || '') === 'device';
  }
}

/**
 * @returns {{skipped?:string, repaired:number, filled:number}}
 */
function syncLiveTafsili(db) {
  const summary = { repaired: 0, filled: 0 };
  if (isDeviceRole()) return { skipped: 'device', ...summary };
  if (!tableExists(db, 'chart_of_accounts')) return { skipped: 'no-chart', ...summary };

  const run = db.transaction(() => {
    const specs = [
      { table: 'suppliers', nameCol: 'name', type: 'liability', taf: 'اشخاص', active: null, fill: (id) => ensureSupplierTafsili(db, id) },
      { table: 'customers', nameCol: 'biz', type: 'asset', taf: 'اشخاص', active: null, fill: (id) => ensureCustomerTafsili(db, id) },
      { table: 'parties', nameCol: 'full_name', type: 'asset', taf: 'اشخاص', active: 'is_active', fill: (id) => ensurePartyTafsili(db, id) },
      { table: 'persons', nameCol: 'name', type: 'asset', taf: 'اشخاص', active: 'active', fill: (id) => allocKind(db, 'person', id, 'persons', 'name') },
      { table: 'banks', nameCol: 'name', type: 'asset', taf: 'بانک ها', active: 'active', legacy: '1102-', fill: (id) => allocKind(db, 'bank', id, 'banks', 'name') },
      { table: 'cash_boxes', nameCol: 'name', type: 'asset', taf: 'صندوق ها', active: 'active', legacy: '1101-', fill: (id) => allocKind(db, 'cashbox', id, 'cash_boxes', 'name') },
      { table: 'products', nameCol: 'name', type: 'asset', taf: 'کالاها', active: null, cap: PRODUCT_CAP, fill: (id) => allocKind(db, 'product', id, 'products', 'name') },
    ];
    for (const spec of specs) {
      if (!tableExists(db, spec.table)) continue;
      const missingChart = db.prepare(`
        SELECT t.id, t.${spec.nameCol} AS nm, t.coa_code
        FROM ${spec.table} t
        LEFT JOIN chart_of_accounts c ON c.code = t.coa_code
        WHERE t.coa_code IS NOT NULL AND TRIM(t.coa_code) <> '' AND c.code IS NULL
      `).all();
      for (const row of missingChart) {
        try {
          if (ensureChartRow(db, row.coa_code, row.nm, spec.type, spec.taf)) summary.repaired += 1;
        } catch (_) { /* ردیف بدشکل بقیه را قطع نمی‌کند */ }
      }
      const unparented = db.prepare(`
        SELECT t.${spec.nameCol} AS nm, t.coa_code
        FROM ${spec.table} t
        JOIN chart_of_accounts c ON c.code = t.coa_code
        WHERE (c.parent_code IS NULL OR TRIM(c.parent_code) = '')
          AND (length(t.coa_code) >= 12 OR instr(t.coa_code, '-') > 0)
      `).all();
      for (const row of unparented) {
        try { ensureChartRow(db, row.coa_code, row.nm, spec.type, spec.taf); } catch (_) {}
      }
      const activeSql = spec.active ? ` AND COALESCE(t.${spec.active},1) <> 0` : '';
      const capSql = spec.cap ? ` LIMIT ${Number(spec.cap)}` : '';
      const blanks = db.prepare(`
        SELECT t.id, t.${spec.nameCol} AS nm
        FROM ${spec.table} t
        WHERE (t.coa_code IS NULL OR TRIM(t.coa_code) = '')${activeSql}${capSql}
      `).all();
      for (const row of blanks) {
        if (spec.legacy) {
          const legacy = spec.legacy + row.id;
          const leg = db.prepare('SELECT code FROM chart_of_accounts WHERE code=?').get(legacy);
          if (leg) {
            db.prepare(`UPDATE ${spec.table} SET coa_code=? WHERE id=? AND (coa_code IS NULL OR TRIM(coa_code)='')`).run(legacy, row.id);
            summary.filled += 1;
            continue;
          }
        }
        try {
          const made = spec.fill(row.id);
          const after = db.prepare(`SELECT coa_code FROM ${spec.table} WHERE id=?`).get(row.id);
          const next = String((after && after.coa_code) || made || '').trim();
          if (next) {
            ensureChartRow(db, next, row.nm, spec.type, spec.taf);
            summary.filled += 1;
          }
        } catch (_) { /* یک ردیف خراب بقیه را نگه نمی‌دارد */ }
      }
    }
  });
  run();
  return summary;
}

function allocKind(db, kind, id, table, nameCol) {
  const row = db.prepare(`SELECT id, ${nameCol} AS nm, coa_code FROM ${table} WHERE id=?`).get(id);
  if (!row) return null;
  if (String(row.coa_code || '').trim()) return row.coa_code;
  const code = allocTafsili(db, kind, row.nm);
  if (!code) return null;
  db.prepare(`UPDATE ${table} SET coa_code=? WHERE id=? AND (coa_code IS NULL OR TRIM(coa_code)='')`).run(code, id);
  return code;
}

module.exports = { syncLiveTafsili, ensureChartRow, inferParent };
