// Mahak (محک) FullBackup.zip analyzer + optional SQL Server import.
// FullBackup.zip contains multiple SQL Server .bak files — not SQLite.
// Workflow: extract zip → list .bak → restore on SQL Server (manual) →
// connect via MAHAK_MSSQL_* env → import mapped entities into CRM.
const fs = require('fs');
const path = require('path');
const os = require('os');

const IMPORT_ROOT = process.env.MAHAK_IMPORT_DIR ||
  path.join(os.tmpdir(), 'crm-mahak-import');

function ensureImportDir() {
  fs.mkdirSync(IMPORT_ROOT, { recursive: true });
  return IMPORT_ROOT;
}

function extractZip(zipPath) {
  const AdmZip = require('adm-zip');
  const dest = path.join(ensureImportDir(), `extract-${Date.now()}`);
  fs.mkdirSync(dest, { recursive: true });
  const zip = new AdmZip(zipPath);
  zip.extractAllTo(dest, true);
  return dest;
}

function walkFiles(dir, ext, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const fp = path.join(dir, ent.name);
    if (ent.isDirectory()) walkFiles(fp, ext, out);
    else if (!ext || fp.toLowerCase().endsWith(ext)) out.push(fp);
  }
  return out;
}

function analyzeExtracted(dir) {
  const bakFiles = walkFiles(dir, '.bak').map(fp => ({
    path: fp,
    name: path.basename(fp),
    sizeMB: (fs.statSync(fp).size / 1024 / 1024).toFixed(2)
  }));
  const dbNames = bakFiles.map(b => {
    const m = b.name.match(/mahak([^-_.]*)/i);
    return m ? m[1] : null;
  }).filter(Boolean);
  return {
    root: dir,
    bak_files: bakFiles,
    suggested_databases: [...new Set(dbNames)],
    note: bakFiles.length
      ? 'فایل‌های .bak باید روی SQL Server بازگردانی شوند. سپس اتصال MAHAK_MSSQL را تنظیم کنید و «اجرای واردات» را بزنید.'
      : 'فایل .bak در آرشیو یافت نشد — مطمئن شوید FullBackup محک است.'
  };
}

function mssqlConfig() {
  const conn = process.env.MAHAK_MSSQL_CONNECTION || process.env.MAHAK_MSSQL_URL;
  if (conn) return { connectionString: conn };
  const server = process.env.MAHAK_MSSQL_SERVER;
  const database = process.env.MAHAK_MSSQL_DATABASE;
  const user = process.env.MAHAK_MSSQL_USER;
  const password = process.env.MAHAK_MSSQL_PASSWORD;
  if (!server || !database) return null;
  return {
    server, database, user, password,
    options: { encrypt: false, trustServerCertificate: true }
  };
}

async function queryMssql(sql) {
  let mssql;
  try { mssql = require('mssql'); } catch {
    throw new Error('پکیج mssql نصب نیست — روی سرور: npm install mssql');
  }
  const cfg = mssqlConfig();
  if (!cfg) throw new Error('اتصال SQL Server محک تنظیم نشده (MAHAK_MSSQL_*)');
  const pool = await mssql.connect(cfg);
  try {
    return (await pool.request().query(sql)).recordset || [];
  } finally {
    await pool.close();
  }
}

async function discoverTables() {
  const rows = await queryMssql(
    "SELECT TABLE_SCHEMA, TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME"
  );
  return rows.map(r => `${r.TABLE_SCHEMA}.${r.TABLE_NAME}`);
}

function pickTable(tables, patterns) {
  const lower = tables.map(t => t.toLowerCase());
  for (const p of patterns) {
    const i = lower.findIndex(t => t.includes(p.toLowerCase()));
    if (i >= 0) return tables[i];
  }
  return null;
}

async function importFromMssql(db, opts = {}) {
  const tables = await discoverTables();
  const personTbl = pickTable(tables, ['person', 'tblperson', 'ashkhas', 'party']);
  const productTbl = pickTable(tables, ['goods', 'product', 'kala', 'item', 'tblgoods']);
  const customerTbl = pickTable(tables, ['customer', 'moshtari']);

  const stats = { persons: 0, products: 0, customers: 0, skipped: [], tables_found: tables.length };

  const importRows = async (table, mapFn, insertFn) => {
    if (!table) return 0;
    const [schema, name] = table.includes('.') ? table.split('.') : ['dbo', table];
    const rows = await queryMssql(`SELECT TOP 5000 * FROM [${schema}].[${name}]`);
    let n = 0;
    db.transaction(() => {
      for (const row of rows) {
        const mapped = mapFn(row);
        if (mapped) { insertFn(mapped); n++; }
      }
    })();
    return n;
  };

  const mapPerson = row => {
    const name = row.Name || row.name || row.Title || row.PersonName || row.FullName;
    if (!name) return null;
    return {
      biz: String(name).trim(),
      owner: row.ContactName || row.ManagerName || '',
      phone: String(row.Mobile || row.Phone || row.Tel || '').trim(),
      city: row.City || row.CityName || '',
      note: 'واردات از محک'
    };
  };

  if (customerTbl || personTbl) {
    const tbl = customerTbl || personTbl;
    stats.customers = await importRows(tbl, mapPerson, (m) => {
      const exists = db.prepare('SELECT id FROM customers WHERE biz=? AND phone=?').get(m.biz, m.phone);
      if (exists) { stats.skipped.push(m.biz); return; }
      db.prepare(
        'INSERT INTO customers (user_id,biz,owner,city,phone,status,note) VALUES (1,?,?,?,?,"active",?)'
      ).run(m.biz, m.owner, m.city, m.phone, m.note);
    });
  }

  if (productTbl) {
    stats.products = await importRows(productTbl, row => {
      const name = row.Name || row.name || row.GoodsName || row.Title;
      if (!name) return null;
      return {
        name: String(name).trim(),
        code: String(row.Code || row.GoodsCode || '').trim(),
        price: parseFloat(row.SalePrice || row.Price || row.UnitPrice) || 0,
        stock: parseFloat(row.Stock || row.Qty || row.Quantity) || 0
      };
    }, (m) => {
      const exists = db.prepare('SELECT id FROM products WHERE name=? OR (code<>"" AND code=?)').get(m.name, m.code);
      if (exists) return;
      db.prepare(
        'INSERT INTO products (user_id,name,code,price,stock,unit) VALUES (1,?,?,?,?,"عدد")'
      ).run(m.name, m.code, m.price, m.stock);
    });
  }

  return stats;
}

module.exports = {
  IMPORT_ROOT, ensureImportDir, extractZip, analyzeExtracted,
  mssqlConfig, discoverTables, importFromMssql
};
