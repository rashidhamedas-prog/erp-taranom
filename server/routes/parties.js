const router = require('express').Router();
const { getDB, audit } = require('../db');
const { auth, adminOnly, adminOrAccounting } = require('../middleware/auth');
const { tomanToRial } = require('../lib/money');
const { syncPartyToLegacy, deactivatePartyCascade } = require('../lib/parties-sync');
const { allocTafsili } = require('../lib/coa-map');

const PARTY_TYPES = ['customer', 'supplier', 'both', 'other'];
const ROLE_KEYS = ['customer', 'supplier', 'employee', 'partner', 'marketer', 'other'];

function nextPartyCode(db) {
  const row = db.prepare("SELECT person_code FROM parties WHERE person_code GLOB 'P-[0-9]*' ORDER BY id DESC LIMIT 1").get();
  let n = 1;
  if (row?.person_code) {
    const m = row.person_code.match(/P-(\d+)/);
    if (m) n = parseInt(m[1], 10) + 1;
  }
  return `P-${String(n).padStart(5, '0')}`;
}

function parseRoles(raw, partyType) {
  if (Array.isArray(raw)) return raw.filter(r => ROLE_KEYS.includes(r));
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return arr.filter(r => ROLE_KEYS.includes(r));
    } catch (_) { /* fall through */ }
  }
  if (partyType === 'both') return ['customer', 'supplier'];
  if (partyType === 'supplier') return ['supplier'];
  if (partyType === 'other') return ['other'];
  return ['customer'];
}

function derivePartyType(roles) {
  const hasC = roles.includes('customer');
  const hasS = roles.includes('supplier');
  if (hasC && hasS) return 'both';
  if (hasS) return 'supplier';
  if (hasC) return 'customer';
  return 'other';
}

function coaKindForRoles(roles) {
  if (roles.includes('customer')) return 'customer';
  if (roles.includes('supplier')) return 'supplier';
  return 'person';
}

function mapPartyRow(row) {
  if (!row) return row;
  let party_roles = [];
  try { party_roles = row.party_roles ? JSON.parse(row.party_roles) : parseRoles(null, row.party_type); } catch (_) {
    party_roles = parseRoles(null, row.party_type);
  }
  // UI is rial-identity: expose stored INTEGER rial as display amounts (legacy *_toman keys kept for compatibility)
  return {
    ...row,
    party_roles,
    credit_limit_toman: row.credit_limit ? Number(row.credit_limit) : 0,
    opening_balance_toman: row.opening_balance ? Number(row.opening_balance) : 0,
  };
}

/** Parties linked via users.party_id are private user profiles. */
function canSeeAllUserParties(role) {
  return role === 'admin' || role === 'accounting';
}

function appendUserPartyPrivacyFilter(sql, params, req) {
  if (canSeeAllUserParties(req.user?.role)) return sql;
  // Non-privileged: hide other users' linked person records; own profile OK.
  sql += ` AND (
    NOT EXISTS (SELECT 1 FROM users uu WHERE uu.party_id = p.id)
    OR EXISTS (SELECT 1 FROM users uu WHERE uu.party_id = p.id AND uu.id = ?)
  )`;
  params.push(req.user.id);
  return sql;
}

function assertCanViewUserLinkedParty(db, req, partyId) {
  if (canSeeAllUserParties(req.user?.role)) return true;
  const owner = db.prepare('SELECT id FROM users WHERE party_id=?').get(partyId);
  if (!owner) return true;
  return owner.id === req.user.id;
}

router.get('/export/excel', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const rows = db.prepare(`
    SELECT p.*, pg.name AS party_group_name, u.name AS expert_name
    FROM parties p
    LEFT JOIN party_groups pg ON p.party_group_id = pg.id
    LEFT JOIN users u ON u.id = p.user_id
    WHERE p.is_active=1 ORDER BY p.id DESC
  `).all().map(mapPartyRow);
  const header = ['کد', 'نام', 'پیشوند', 'تلفن', 'موبایل', 'شهر', 'گروه', 'سمت‌ها', 'کد تفصیلی', 'کارشناس', 'ایمیل', 'کد ملی'];
  const lines = [header.join(',')];
  for (const p of rows) {
    const cols = [
      p.person_code, p.full_name || p.biz, p.prefix, p.phone, p.mobile, p.city,
      p.party_group_name, (p.party_roles || []).join('|'), p.coa_code, p.expert_name, p.email, p.national_id
    ].map(v => '"' + String(v ?? '').replace(/"/g, '""') + '"');
    lines.push(cols.join(','));
  }
  const bom = '\uFEFF';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="parties.csv"');
  res.send(bom + lines.join('\n'));
});

router.get('/import/template', auth, adminOrAccounting, (req, res) => {
  const bom = '\uFEFF';
  const csv = 'نام*,تلفن*,پیشوند,موبایل,شهر,گروه,سمت‌ها,ایمیل,کد ملی\nنمونه فروشگاه,09120000000,آقا,,تهران,مشتریان,customer,,';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="parties-template.csv"');
  res.send(bom + csv);
});

router.post('/import', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (!rows.length) return res.status(400).json({ error: 'ردیفی برای ورود نیست' });
  let created = 0, skipped = 0;
  const groups = db.prepare('SELECT id,name FROM party_groups').all();
  const groupByName = {};
  groups.forEach(g => { groupByName[String(g.name || '').trim()] = g.id; });

  const tx = db.transaction(() => {
    for (const r of rows) {
      const full_name = String(r.full_name || r.name || '').trim();
      const phone = String(r.phone || '').trim();
      if (!full_name || !phone) { skipped++; continue; }
      const exists = db.prepare('SELECT id FROM parties WHERE phone=? AND is_active=1').get(phone);
      if (exists) { skipped++; continue; }
      const roles = parseRoles(r.party_roles || r.roles || ['customer'], r.party_type);
      const partyType = derivePartyType(roles);
      let pgid = r.party_group_id ? parseInt(r.party_group_id, 10) : null;
      if (!pgid && r.party_group_name) pgid = groupByName[String(r.party_group_name).trim()] || null;
      const personCode = nextPartyCode(db);
      const nameForCoa = full_name;
      const coa = allocTafsili(db, coaKindForRoles(roles), nameForCoa);
      const ins = db.prepare(`
        INSERT INTO parties (
          person_code, party_type, party_roles, legal_type, full_name, company_name,
          phone, mobile, city, email, national_id, user_id, biz, status, type,
          party_group_id, prefix, coa_code, is_active
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)
      `).run(
        personCode, partyType, JSON.stringify(roles), 'real', full_name, r.company_name || null,
        phone, r.mobile || null, r.city || null, r.email || null, r.national_id || null,
        r.user_id || req.user.id, full_name, 'new', 'بوتیک',
        pgid, r.prefix || null, coa || null
      );
      try { syncPartyToLegacy(db, ins.lastInsertRowid); } catch (_) {}
      created++;
    }
  });
  try { tx(); } catch (e) { return res.status(500).json({ error: e.message }); }
  res.json({ ok: true, created, skipped });
});

router.get('/', auth, (req, res) => {
  const db = getDB();
  const { type, segment, city, search, party_group_id, page = 1, limit = 50 } = req.query;
  let sql = `
    SELECT p.*, pg.name AS party_group_name, u.name AS expert_name
    FROM parties p
    LEFT JOIN party_groups pg ON p.party_group_id = pg.id
    LEFT JOIN users u ON u.id = p.user_id
    WHERE p.is_active=1
  `;
  const params = [];
  if (type) { sql += ' AND p.party_type=?'; params.push(type); }
  if (party_group_id) { sql += ' AND p.party_group_id=?'; params.push(parseInt(party_group_id, 10)); }
  if (segment) { sql += ' AND p.segment=?'; params.push(segment); }
  if (city) { sql += ' AND p.city=?'; params.push(city); }
  if (search) {
    const norm = String(search).replace(/ي/g, 'ی').replace(/ك/g, 'ک').trim();
    sql += ' AND (REPLACE(REPLACE(IFNULL(p.full_name,\'\'),\'ي\',\'ی\'),\'ك\',\'ک\') LIKE ? OR REPLACE(REPLACE(IFNULL(p.company_name,\'\'),\'ي\',\'ی\'),\'ك\',\'ک\') LIKE ? OR p.phone LIKE ? OR p.person_code LIKE ? OR p.mobile LIKE ? OR p.coa_code LIKE ? OR IFNULL(p.biz,\'\') LIKE ?)';
    const q = '%' + norm + '%';
    params.push(q, q, q, q, q, q, q);
  }
  sql = appendUserPartyPrivacyFilter(sql, params, req);
  const countSql = sql.replace(/SELECT[\s\S]+?FROM parties p/, 'SELECT COUNT(*) AS c FROM parties p');
  const total = db.prepare(countSql).get(...params)?.c || 0;
  const lim = Math.min(500, parseInt(limit, 10) || 200);
  sql += ' ORDER BY p.id DESC LIMIT ? OFFSET ?';
  params.push(lim, (Math.max(1, parseInt(page, 10)) - 1) * lim);
  const rows = db.prepare(sql).all(...params).map(mapPartyRow);
  res.json({ success: true, data: rows, pagination: { page: parseInt(page, 10) || 1, limit: parseInt(limit, 10) || 50, total } });
});

router.get('/:id', auth, (req, res) => {
  const db = getDB();
  const row = db.prepare(`
    SELECT p.*, pg.name AS party_group_name, pg.entity_type AS party_group_entity, u.name AS expert_name
    FROM parties p
    LEFT JOIN party_groups pg ON p.party_group_id = pg.id
    LEFT JOIN users u ON u.id = p.user_id
    WHERE p.id=?
  `).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  if (!assertCanViewUserLinkedParty(db, req, row.id)) {
    return res.status(403).json({ error: 'دسترسی به اطلاعات این کاربر مجاز نیست' });
  }
  res.json({ success: true, data: mapPartyRow(row) });
});

router.post('/', auth, adminOrAccounting, (req, res) => {
  const b = req.body;
  const roles = parseRoles(b.party_roles, b.party_type);
  const partyType = PARTY_TYPES.includes(b.party_type) ? b.party_type : derivePartyType(roles);
  if (!b.full_name && !b.company_name) return res.status(400).json({ error: 'نام الزامی است' });
  if (!b.phone) return res.status(400).json({ error: 'تلفن الزامی است' });

  const db = getDB();
  const phone = String(b.phone).trim();
  if (db.prepare('SELECT id FROM parties WHERE phone=? AND is_active=1').get(phone)) {
    return res.status(409).json({ error: 'این تلفن قبلاً ثبت شده — داده تکراری ذخیره نمی‌شود' });
  }
  if (b.person_code && db.prepare('SELECT id FROM parties WHERE person_code=?').get(String(b.person_code).trim())) {
    return res.status(409).json({ error: 'این کد شخص قبلاً ثبت شده — داده تکراری ذخیره نمی‌شود' });
  }
  const personCode = b.person_code || nextPartyCode(db);
  // Rial-identity UI: *_rial preferred; bare credit_limit/opening_balance treated as rial
  const creditRial = b.credit_limit_rial != null ? parseInt(b.credit_limit_rial, 10) : Math.round(Number(b.credit_limit) || 0);
  // Opening balance / مانده: admin only
  const openRial = req.user.role === 'admin'
    ? (b.opening_balance_rial != null ? parseInt(b.opening_balance_rial, 10) : Math.round(Number(b.opening_balance) || 0))
    : 0;
  const pgid = b.party_group_id ? parseInt(b.party_group_id, 10) : null;
  const displayName = b.full_name || b.company_name;
  let coaCode = b.coa_code || null;
  if (!coaCode) {
    try { coaCode = allocTafsili(db, coaKindForRoles(roles), displayName); } catch (_) { coaCode = null; }
  }

  try {
    const result = db.transaction(() => {
      const r = db.prepare(`
        INSERT INTO parties (
          person_code, party_type, party_roles, legal_type, full_name, company_name,
          national_id, economic_code, phone, secondary_phone, mobile, fax, email,
          city, province, address, postal_code, segment, store_type, source,
          credit_limit, opening_balance, opening_balance_date, notes,
          user_id, biz, owner, insta, status, type,
          party_group_id, prefix, birth_date, referrer, account_nature, coa_code
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        personCode, partyType, JSON.stringify(roles), b.legal_type || 'real', b.full_name || b.company_name, b.company_name || null,
        b.national_id || null, b.economic_code || null, b.phone, b.secondary_phone || b.phone2 || null, b.mobile || null, b.fax || null, b.email || null,
        b.city || null, b.province || null, b.address || null, b.postal_code || null,
        b.segment || 'C', b.store_type || null, b.source || null,
        creditRial, openRial, b.opening_balance_date || null, b.notes || null,
        b.user_id || b.assigned_to || req.user.id, b.biz || b.company_name || b.full_name, b.owner || null,
        b.insta || null, b.status || 'new', b.type || 'بوتیک',
        pgid, b.prefix || null, b.birth_date || null, b.referrer || null, b.account_nature || null, coaCode
      );
      const partyId = r.lastInsertRowid;
      try { syncPartyToLegacy(db, partyId); } catch (_) {}
      if (openRial) {
        const { postPartyOpeningBalance } = require('../lib/opening-post');
        postPartyOpeningBalance(db, {
          partyId,
          amountRial: openRial,
          date: b.opening_balance_date || null,
          userId: req.user.id,
          srcSystem: b.from_excel || b.src_system === 'excel' ? 'excel' : null,
        });
      }
      return partyId;
    })();
    audit(req.user.id, 'create', 'party', result, personCode);
    const row = db.prepare('SELECT * FROM parties WHERE id=?').get(result);
    try {
      const { dispatchSmsEvent } = require('../lib/sms-dispatch');
      const { isDevice } = require('../db');
      if (!isDevice()) {
        setImmediate(() => dispatchSmsEvent(db, 'party.created', {
          phone: row.mobile || row.phone,
          name: row.full_name || row.company_name,
          biz: row.biz || row.company_name,
          party_group_id: row.party_group_id,
          user_id: row.user_id,
          created_by: req.user.id,
          user: req.user.name,
        }));
      }
    } catch (_) {}
    res.status(201).json({ success: true, data: mapPartyRow(row) });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'کد یا تلفن تکراری است' });
    if (e.status) return res.status(e.status).json({ error: e.message });
    throw e;
  }
});

router.put('/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM parties WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  const b = req.body;
  const roles = b.party_roles ? parseRoles(b.party_roles, row.party_type) : parseRoles(row.party_roles, row.party_type);
  const partyType = b.party_type && PARTY_TYPES.includes(b.party_type) ? b.party_type : derivePartyType(roles);
  // Prefer *_rial; if only credit_limit is sent from rial UI, store as-is (no ×10)
  const creditRial = b.credit_limit_rial != null ? parseInt(b.credit_limit_rial, 10)
    : (b.credit_limit != null ? Math.round(Number(b.credit_limit) || 0) : row.credit_limit);
  // Opening balance / مانده: admin only — non-admin keep existing value
  const openRial = req.user.role === 'admin'
    ? (b.opening_balance_rial != null ? parseInt(b.opening_balance_rial, 10)
      : (b.opening_balance != null ? Math.round(Number(b.opening_balance) || 0) : row.opening_balance))
    : row.opening_balance;
  const pgid = b.party_group_id != null ? (b.party_group_id ? parseInt(b.party_group_id, 10) : null) : row.party_group_id;
  // ACC-01: allocated tafsili is the identity. Group changes must not rewrite it.
  let coaCode = row.coa_code || null;
  if (!coaCode) {
    coaCode = b.coa_code != null ? b.coa_code : null;
    if (!coaCode) {
      try { coaCode = allocTafsili(db, coaKindForRoles(roles), b.full_name || row.full_name); } catch (_) {}
    }
  }
  const userId = b.user_id != null || b.assigned_to != null
    ? parseInt(b.user_id || b.assigned_to, 10) || row.user_id
    : row.user_id;

  try {
    db.transaction(() => {
      db.prepare(`
        UPDATE parties SET
          full_name=?, company_name=?, phone=?, secondary_phone=?, mobile=?, fax=?, email=?,
          city=?, province=?, address=?, postal_code=?, segment=?,
          national_id=?, economic_code=?, credit_limit=?, opening_balance=?, notes=?,
          biz=?, owner=?, insta=?, status=?, type=?, party_type=?, party_roles=?,
          party_group_id=?, prefix=?, birth_date=?, referrer=?, account_nature=?, coa_code=?,
          user_id=?,
          updated_at=strftime('%s','now')
        WHERE id=?
      `).run(
        b.full_name || row.full_name, b.company_name ?? row.company_name,
        b.phone || row.phone, b.secondary_phone ?? b.phone2 ?? row.secondary_phone,
        b.mobile ?? row.mobile, b.fax ?? row.fax, b.email ?? row.email,
        b.city ?? row.city, b.province ?? row.province, b.address ?? row.address, b.postal_code ?? row.postal_code,
        b.segment ?? row.segment, b.national_id ?? row.national_id, b.economic_code ?? row.economic_code,
        creditRial, openRial, b.notes ?? row.notes,
        b.biz ?? row.biz, b.owner ?? row.owner, b.insta ?? row.insta, b.status ?? row.status, b.type ?? row.type,
        partyType, JSON.stringify(roles), pgid,
        b.prefix ?? row.prefix, b.birth_date ?? row.birth_date, b.referrer ?? row.referrer,
        b.account_nature ?? row.account_nature, coaCode, userId,
        req.params.id
      );
      try { syncPartyToLegacy(db, req.params.id); } catch (_) {}
      if (req.user.role === 'admin' && openRial !== (row.opening_balance || 0)) {
        const oldJe = db.prepare("SELECT id FROM journal_entries WHERE ref_type='opening_balance' AND ref_id=? AND COALESCE(deleted_at,0)=0 ORDER BY id DESC LIMIT 1").get(req.params.id);
        if (oldJe) {
          try {
            const { reverseJournalEntry } = require('../lib/void-journal');
            reverseJournalEntry(db, oldJe.id, {
              userId: req.user.id,
              reason: 'تغییر مانده اول دوره',
              sourceType: 'opening_balance_reversal',
            });
          } catch (_) {}
        }
        if (openRial) {
          const { postPartyOpeningBalance } = require('../lib/opening-post');
          postPartyOpeningBalance(db, {
            partyId: Number(req.params.id),
            amountRial: openRial,
            date: b.opening_balance_date || row.opening_balance_date || null,
            userId: req.user.id,
            srcSystem: b.from_excel || b.src_system === 'excel' ? 'excel' : null,
          });
        }
      }
    })();
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    throw e;
  }
  audit(req.user.id, 'update', 'party', req.params.id, '');
  res.json({ success: true, data: mapPartyRow(db.prepare('SELECT * FROM parties WHERE id=?').get(req.params.id)) });
});

router.delete('/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM parties WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  // Soft-delete party + cascade remove linked CRM customer/supplier + followups (R8)
  const result = db.transaction(() => deactivatePartyCascade(db, req.params.id, { userId: req.user.id }))();
  audit(req.user.id, 'delete', 'party', req.params.id, `soft+cascade cust=${(result.customers||[]).join(',')}`);
  res.json({ success: true, message: 'غیرفعال شد', cascaded: result });
});

module.exports = router;
