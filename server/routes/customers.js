const router = require('express').Router();
const { allocTafsili } = require('../lib/coa-map');
const { getDB, audit, createLedgerEntry, isDevice } = require('../db');
const { assignCustomerByTerritory } = require('../lib/rep-ledger');
const { syncCustomerToParty, deactivatePartyFromCustomer, CRM_CUSTOMER_ACTIVE_SQL } = require('../lib/parties-sync');
const { auth, adminOnly } = require('../middleware/auth');
const { sendSMS } = require('../sms');
const { XLSX, readWorkbook } = require('../lib/excel-safe');
const { createSecureUpload } = require('../lib/upload-policy');
const { getSmsSettings } = require('../lib/secret-settings');
const { listQueryPlan, listResponse } = require('../lib/pagination');
const { applyCustomerBalances } = require('../lib/customer-books');

const excelUpload = createSecureUpload('xlsx');

// Pre-aggregated ledger balances — one GROUP BY pass instead of a correlated subquery per row.
const LEDGER_BAL_JOIN = `LEFT JOIN (
  SELECT customer_id, COALESCE(SUM(debit)-SUM(credit),0) AS balance
  FROM customer_ledger GROUP BY customer_id
) lb ON lb.customer_id=c.id`;
const BAL_COL = 'COALESCE(lb.balance,0)';

// Keep the customer's opening-ledger line in sync with the admin-set opening balance.
// Deletes any existing opening line and re-inserts one dated at the customer's own
// created_at so it still sorts first in the statement.
function syncOpeningLedger(db, customerId, bal, createdAt, userId) {
  db.prepare("DELETE FROM customer_ledger WHERE customer_id=? AND ref_type='opening'").run(customerId);
  if (bal) {
    createLedgerEntry(db, {
      customer_id: customerId, date: '', entry_type: 'opening', ref_type: 'opening', ref_id: customerId,
      description: 'مانده اولیه حساب', debit: bal > 0 ? bal : 0, credit: bal < 0 ? -bal : 0,
      user_id: userId, created_at: createdAt || 1
    });
  }
}

// Normalize Arabic characters to Persian and convert Arabic/Persian digits to ASCII
function normalizeStr(s) {
  if (!s) return '';
  return String(s)
    .replace(/ي/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/ة/g, 'ه')
    .replace(/[٠١٢٣٤٥٦٧٨٩]/g, d => d.charCodeAt(0) - 0x0660)
    .replace(/[۰۱۲۳۴۵۶۷۸۹]/g, d => d.charCodeAt(0) - 0x06F0)
    .trim();
}

const DEFAULT_WELCOME_SMS = `سلام 🌸 به خانواده پوشاک ترنم خوش‌آمدید!

برای اطلاع از جدیدترین محصولات و تخفیف‌های ویژه، ما را دنبال کنید:

📱 روبیکا: rubika.ir/toliditaranom_omde
✈️ تلگرام: t.me/toliditaranom
💬 بله: bale.ai/toliditaranom
{address}
پوشاک ترنم 🌿`;

async function sendWelcomeSMSToCust(db, phone) {
  try {
    const s = getSmsSettings(db, ['welcome_sms_text', 'kimia_address']);
    if (!s.sms_api_key || !phone) return;
    const addrLine = s.kimia_address ? `\n🏢 آدرس دفتر: ${s.kimia_address}` : '';
    const text = (s.welcome_sms_text || DEFAULT_WELCOME_SMS).replace('{address}', addrLine);
    return await sendSMS(s, phone, text);
  } catch (e) {
    console.error('welcome SMS error:', e.message);
  }
}

function getScope(req) {
  // Accounting staff see all customers (read scope) — needed for statements & settlements
  const seesAll = req.user.role === 'admin' || req.user.role === 'accounting';
  if (req.user.role === 'admin' && req.query.user_id) return parseInt(req.query.user_id);
  if (seesAll) return null; // all
  return req.user.id;
}

/** Edit/delete: admin OR original creator (created_by). Assigned expert alone cannot mutate. */
function canMutateCustomer(user, row) {
  if (!row) return false;
  if (user.role === 'admin') return true;
  const creator = row.created_by != null ? row.created_by : row.user_id;
  return creator === user.id;
}

router.get('/', auth, (req, res) => {
  const db = getDB();
  const scope = getScope(req);
  const pq = listQueryPlan(req.query);
  const hasPartyGroups = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='party_groups'").get();
  const pgJoin = hasPartyGroups ? 'LEFT JOIN party_groups pg ON c.party_group_id=pg.id' : '';
  const pgCol = hasPartyGroups ? ',pg.name as party_group_name' : ",'' as party_group_name";
  // Hide CRM customers whose linked accounting party was soft-deleted
  const activeClause = ` AND ${CRM_CUSTOMER_ACTIVE_SQL}`;
  const whereSql = scope === null ? `WHERE 1=1${activeClause}` : `WHERE c.user_id=?${activeClause}`;
  const params = scope === null ? [] : [scope];
  const total = pq.paginate
    ? (db.prepare(`SELECT COUNT(*) AS c FROM customers c ${whereSql}`).get(...params)?.c || 0)
    : 0;
  const rows = db.prepare(
    `SELECT c.*,${BAL_COL} AS balance,u.name as salesperson,g.name as group_name,g.nature as group_nature${pgCol} FROM customers c ${LEDGER_BAL_JOIN} LEFT JOIN users u ON c.user_id=u.id LEFT JOIN customer_groups g ON c.group_id=g.id ${pgJoin} ${whereSql} ORDER BY c.created_at DESC${pq.limitSql}`
  ).all(...params, ...pq.limitParams);
  applyCustomerBalances(db, rows);
  res.json(listResponse(rows, { page: pq.page, pageSize: pq.pageSize, total: pq.paginate ? total : rows.length }, req.query));
});

router.post('/', auth, (req, res) => {
  const { biz, owner, city, province, address, phone, insta, type, status, note, source, balance, assigned_to, auto_followup, group_id, party_group_id,
    prefix, phone2, fax, mobile, email, economic_code, postal_code, national_id, referrer, birth_date, company_name, account_nature } = req.body;
  if (!biz) return res.status(400).json({ error: 'نام فروشگاه الزامی است' });
  const db = getDB();
  const bal = (req.user.role === 'admin') ? (parseFloat(balance) || 0) : 0;
  const autoF = (auto_followup === undefined) ? 1 : (auto_followup ? 1 : 0);
  // Only admin/accounting may set the customer's account-nature group
  const canSetGroup = req.user.role === 'admin' || req.user.role === 'accounting';
  const gid = (canSetGroup && group_id) ? parseInt(group_id) : null;
  const pgid = (canSetGroup && party_group_id) ? parseInt(party_group_id) : null;
  // admin can assign customer to a specific salesperson; creator remains the admin
  const uid = (req.user.role === 'admin' && assigned_to) ? parseInt(assigned_to) : req.user.id;
  const createdBy = req.user.id;
  const newId = db.transaction(() => {
    const result = db.prepare(
      `INSERT INTO customers (user_id,biz,owner,city,province,address,phone,insta,type,status,note,source,balance,assigned_to,auto_followup,group_id,party_group_id,
        prefix,phone2,fax,mobile,email,economic_code,postal_code,national_id,referrer,birth_date,company_name,account_nature,created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(uid, biz, owner || '', city || '', province || '', address || '', phone || '', insta || '', type || 'بوتیک', status || 'new', note || '', source || '', bal, assigned_to ? parseInt(assigned_to) : null, autoF, gid, pgid,
      prefix || '', phone2 || '', fax || '', mobile || '', email || '', economic_code || '', postal_code || '', national_id || '', referrer || '', birth_date || '', company_name || '', account_nature || '', createdBy);
    const created = db.prepare('SELECT id,created_at FROM customers WHERE id=?').get(result.lastInsertRowid);
    if (bal) syncOpeningLedger(db, created.id, bal, created.created_at, req.user.id);
    return created.id;
  })();
  const row = db.prepare('SELECT * FROM customers WHERE id=?').get(newId);
  try { syncCustomerToParty(db, newId); } catch (_) {}
  // حالت کدینگ محک (deprecated): فقط اگر coa_mode=mahak
  try {
    const mode = db.prepare("SELECT value FROM settings WHERE key='coa_mode'").get()?.value;
    if (mode === 'mahak') {
      const cc = allocTafsili(db, 'customer', biz);
      if (cc) { db.prepare('UPDATE customers SET coa_code=? WHERE id=?').run(cc, newId); row.coa_code = cc; }
    }
  } catch (_) {}
  if (!(req.user.role === 'admin' && assigned_to) && (city || province)) {
    assignCustomerByTerritory(db, newId, city, province, req.user.id);
  }
  res.json(row);
  // Fire welcome SMS after response — non-blocking. Central-only: device
  // builds never send SMS (the central replay of this op sends it once).
  if (phone && !isDevice()) sendWelcomeSMSToCust(db, phone);
  try {
    if (!isDevice()) {
      const { dispatchSmsEvent } = require('../lib/sms-dispatch');
      setImmediate(() => dispatchSmsEvent(db, 'customer.created', {
        phone: mobile || phone,
        name: owner || biz,
        biz,
        party_group_id: pgid,
        user_id: uid,
        created_by: req.user.id,
        user: req.user.name,
      }));
    }
  } catch (_) {}
});

router.put('/:id', auth, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM customers WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  if (!canMutateCustomer(req.user, row)) return res.status(403).json({ error: 'فقط ایجادکننده یا مدیر می‌تواند این مشتری را ویرایش کند' });
  const { biz, owner, city, province, address, phone, insta, type, status, note, source, balance, assigned_to, auto_followup, group_id, party_group_id,
    prefix, phone2, fax, mobile, email, economic_code, postal_code, national_id, referrer, birth_date, company_name, account_nature } = req.body;
  const bal = (req.user.role === 'admin' && balance !== undefined) ? (parseFloat(balance) || 0) : row.balance || 0;
  const uid = (req.user.role === 'admin' && assigned_to) ? parseInt(assigned_to) : row.user_id;
  const autoF = (auto_followup === undefined) ? (row.auto_followup == null ? 1 : row.auto_followup) : (auto_followup ? 1 : 0);
  const canSetGroup = req.user.role === 'admin' || req.user.role === 'accounting';
  const gid = canSetGroup ? (group_id ? parseInt(group_id) : null) : row.group_id;
  const pgid = canSetGroup ? (party_group_id ? parseInt(party_group_id) : null) : row.party_group_id;
  db.transaction(() => {
    db.prepare(`UPDATE customers SET user_id=?,biz=?,owner=?,city=?,province=?,address=?,phone=?,insta=?,type=?,status=?,note=?,source=?,balance=?,assigned_to=?,auto_followup=?,group_id=?,party_group_id=?,
      prefix=?,phone2=?,fax=?,mobile=?,email=?,economic_code=?,postal_code=?,national_id=?,referrer=?,birth_date=?,company_name=?,account_nature=? WHERE id=?`)
      .run(uid, biz, owner || '', city || '', province || '', address || '', phone || '', insta || '', type || 'بوتیک', status || 'new', note || '', source || '', bal, assigned_to ? parseInt(assigned_to) : row.assigned_to, autoF, gid, pgid,
        prefix ?? row.prefix ?? '', phone2 ?? row.phone2 ?? '', fax ?? row.fax ?? '', mobile ?? row.mobile ?? '',
        email ?? row.email ?? '', economic_code ?? row.economic_code ?? '', postal_code ?? row.postal_code ?? '',
        national_id ?? row.national_id ?? '', referrer ?? row.referrer ?? '', birth_date ?? row.birth_date ?? '',
        company_name ?? row.company_name ?? '', account_nature ?? row.account_nature ?? '', req.params.id);
    if (req.user.role === 'admin' && balance !== undefined && bal !== (row.balance || 0)) {
      syncOpeningLedger(db, req.params.id, bal, row.created_at, req.user.id);
    }
  })();
  try { syncCustomerToParty(db, req.params.id); } catch (_) {}
  if (!(req.user.role === 'admin' && assigned_to) && city && city !== row.city) {
    assignCustomerByTerritory(db, req.params.id, city, province, req.user.id);
  }
  res.json({ ok: true });
});

router.delete('/:id', auth, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM customers WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  if (!canMutateCustomer(req.user, row)) return res.status(403).json({ error: 'فقط ایجادکننده یا مدیر می‌تواند این مشتری را حذف کند' });
  // Cascade: remove followups + soft-delete linked accounting party
  const result = db.transaction(() => deactivatePartyFromCustomer(db, req.params.id))();
  if (!result.ok) return res.status(400).json({ error: 'امکان حذف مشتری نیست (سوابق مالی مرتبط)' });
  audit(req.user.id, 'delete', 'customer', req.params.id, `حذف مشتری ${row.biz}; party=${result.partyId||'-'}`);
  res.json({ ok: true, partyId: result.partyId || null });
});

// Customer balances for current user's customers (non-zero only)
router.get('/balances', auth, (req, res) => {
  const db = getDB();
  const scope = getScope(req);
  // Hide CRM customers whose linked accounting party was soft-deleted
  const activeClause = ` AND ${CRM_CUSTOMER_ACTIVE_SQL}`;
  let rows;
  if (scope === null) {
    rows = db.prepare(`SELECT c.id,c.biz,c.owner,c.city,c.address,${BAL_COL} AS balance,COALESCE(cg.nature,'debit') AS nature,u.name as salesperson FROM customers c ${LEDGER_BAL_JOIN} LEFT JOIN users u ON c.user_id=u.id LEFT JOIN customer_groups cg ON cg.id=c.group_id WHERE 1=1${activeClause}`).all();
  } else {
    rows = db.prepare(`SELECT c.id,c.biz,c.owner,c.city,c.address,${BAL_COL} AS balance,COALESCE(cg.nature,'debit') AS nature FROM customers c ${LEDGER_BAL_JOIN} LEFT JOIN customer_groups cg ON cg.id=c.group_id WHERE c.user_id=?${activeClause}`).all(scope);
  }
  applyCustomerBalances(db, rows);
  rows = rows.filter((r) => Math.abs(Number(r.balance) || 0) > 0)
    .sort((a, b) => Math.abs(Number(b.balance) || 0) - Math.abs(Number(a.balance) || 0));
  res.json(rows);
});

router.get('/export/excel', auth, adminOnly, async (req, res) => {
  const db = getDB();
  const scope = getScope(req);
  const activeClause = ` AND ${CRM_CUSTOMER_ACTIVE_SQL}`;
  let rows;
  if (scope === null) {
    rows = db.prepare(`SELECT c.*,${BAL_COL} AS balance,u.name as salesperson FROM customers c ${LEDGER_BAL_JOIN} LEFT JOIN users u ON c.user_id=u.id WHERE 1=1${activeClause} ORDER BY c.created_at DESC`).all();
  } else {
    rows = db.prepare(`SELECT c.*,${BAL_COL} AS balance FROM customers c ${LEDGER_BAL_JOIN} WHERE c.user_id=?${activeClause} ORDER BY c.created_at DESC`).all(scope);
  }
  applyCustomerBalances(db, rows);
  const isAdmin = req.user.role === 'admin';
  const data = rows.map(r => ({
    'نام فروشگاه': r.biz, 'نام کامل': r.owner, 'شهر': r.city,
    'موبایل': r.phone, 'اینستاگرام': r.insta, 'نوع': r.type, 'وضعیت': r.status,
    'منبع آشنایی': r.source || '', 'کارشناس': r.salesperson || '',
    ...(isAdmin ? { 'موجودی حساب': r.balance || 0 } : {}),
    'یادداشت': r.note
  }));
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(data);
  XLSX.utils.book_append_sheet(wb, ws, 'مشتریان');
  const buf = await XLSX.write(wb);
  res.setHeader('Content-Disposition', 'attachment; filename=customers.xlsx');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// Import customers from Excel
router.post('/import', auth, adminOnly, excelUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'فایل آپلود نشد' });
  try {
    const wb = await readWorkbook(req.file.buffer);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(ws);
    const db = getDB();
    let inserted = 0;
    const allUsers = db.prepare('SELECT id,name FROM users').all();
    const stmt = db.prepare(
      'INSERT INTO customers (user_id,biz,owner,city,province,address,phone,insta,type,status,source,balance,created_by,assigned_to) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
    );
    const insertMany = db.transaction((rows) => {
      for (const row of rows) {
        const biz = normalizeStr(row['نام فروشگاه'] || row['biz'] || row['نام کسب‌وکار'] || '');
        if (!biz) continue;
        // Resolve salesperson by name or id — importer remains created_by
        let targetUserId = req.user.id;
        const salesRep = normalizeStr(row['کارشناس'] || row['نام کارشناس'] || row['salesperson'] || '');
        if (salesRep) {
          const found = allUsers.find(u => u.name === salesRep || String(u.id) === String(salesRep));
          if (found) targetUserId = found.id;
        } else if (row['user_id']) {
          targetUserId = parseInt(row['user_id']);
        }
        const balance = parseFloat(row['موجودی حساب'] || row['balance'] || 0) || 0;
        const assigned = targetUserId !== req.user.id ? targetUserId : null;
        stmt.run(
          targetUserId, biz,
          normalizeStr(row['نام کامل'] || row['owner'] || row['نام مالک'] || ''),
          normalizeStr(row['شهر'] || row['city'] || ''),
          normalizeStr(row['استان'] || row['province'] || ''),
          normalizeStr(row['آدرس'] || row['آدرس کامل'] || row['address'] || ''),
          normalizeStr(row['موبایل'] || row['phone'] || ''),
          row['اینستاگرام'] || row['insta'] || '',
          row['نوع'] || row['type'] || 'بوتیک',
          row['وضعیت'] || row['status'] || 'new',
          row['منبع آشنایی'] || row['source'] || '',
          balance,
          req.user.id,
          assigned
        );
        inserted++;
      }
    });
    insertMany(data);
    audit(req.user.id, 'import', 'customer', null, `ورود ${inserted} مشتری از اکسل`);
    res.json({ ok: true, inserted });
  } catch (e) {
    res.status(400).json({ error: 'خطا در خواندن فایل: ' + e.message });
  }
});

// Manually send welcome SMS to a specific customer
router.post('/:id/welcome-sms', auth, async (req, res) => {
  const db = getDB();
  const c = db.prepare('SELECT * FROM customers WHERE id=?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'مشتری یافت نشد' });
  if (!c.phone) return res.status(400).json({ error: 'این مشتری شماره موبایل ندارد' });
  const result = await sendWelcomeSMSToCust(db, c.phone);
  res.json(result || { ok: false, reason: 'خطای نامشخص' });
});

// Downloadable Excel template for customer import
router.get('/template', auth, adminOnly, async (req, res) => {
  const wb = XLSX.utils.book_new();
  const data = [
    { 'نام فروشگاه': 'بوتیک بهار', 'نام کامل': 'زهره احمدی', 'استان': 'خراسان رضوی', 'شهر': 'مشهد', 'آدرس کامل': 'بلوار فردوسی، پلاک ۱۲', 'موبایل': '09151234567', 'اینستاگرام': 'bahar_boutique', 'نوع': 'بوتیک', 'وضعیت': 'active', 'منبع آشنایی': 'instagram', 'کارشناس': '', 'موجودی حساب': 0 },
    { 'نام فروشگاه': 'فروشگاه نسیم', 'نام کامل': 'فاطمه حسینی', 'استان': 'تهران', 'شهر': 'تهران', 'آدرس کامل': 'خیابان ولیعصر', 'موبایل': '09121234567', 'اینستاگرام': 'nasim_shop', 'نوع': 'فروشگاه', 'وضعیت': 'new', 'منبع آشنایی': 'referral', 'کارشناس': '', 'موجودی حساب': 0 },
  ];
  const ws = XLSX.utils.json_to_sheet(data);
  // Add column widths
  ws['!cols'] = [30,20,15,15,20,15,15,20,20,15].map(w=>({wch:w}));
  XLSX.utils.book_append_sheet(wb, ws, 'مشتریان');
  // Instructions sheet
  const info = [
    { 'راهنما': 'مقادیر مجاز برای وضعیت: new, active, vip, followup, silent' },
    { 'راهنما': 'مقادیر مجاز برای منبع آشنایی: instagram, referral, exhibition, store_front, online, other' },
    { 'راهنما': 'مقادیر مجاز برای نوع: بوتیک، عمده‌فروش، تولیدی، فروشگاه، آنلاین' },
    { 'راهنما': 'ستون کارشناس: نام کارشناس دقیقاً همانطور که در سیستم ثبت شده (اختیاری)' },
    { 'راهنما': 'ستون موجودی حساب: موجودی اولیه مشتری به ریال (فقط مدیر می‌تواند تنظیم کند)' },
  ];
  const ws2 = XLSX.utils.json_to_sheet(info);
  ws2['!cols'] = [{wch:80}];
  XLSX.utils.book_append_sheet(wb, ws2, 'راهنما');
  const buf = await XLSX.write(wb);
  res.setHeader('Content-Disposition', 'attachment; filename=customers-template.xlsx');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

module.exports = router;
