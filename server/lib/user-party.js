const { allocTafsili } = require('./coa-map');

const SALES_ROLES = new Set(['salesperson', 'field_sales', 'inside_sales', 'distribution_office', 'sales_manager']);

function parseRoles(raw) {
  try {
    const roles = JSON.parse(raw || '[]');
    return Array.isArray(roles) ? roles : [];
  } catch (_) {
    return [];
  }
}

function partyRolesForUser(role, current = []) {
  const roles = new Set(current);
  roles.add('employee');
  if (SALES_ROLES.has(role)) roles.add('marketer');
  else roles.delete('marketer');
  return [...roles];
}

function nextUserPartyCode(db, userId) {
  const preferred = `USER-${String(userId).padStart(5, '0')}`;
  if (!db.prepare('SELECT 1 FROM parties WHERE person_code=?').get(preferred)) return preferred;
  let suffix = 1;
  while (db.prepare('SELECT 1 FROM parties WHERE person_code=?').get(`${preferred}-${suffix}`)) suffix++;
  return `${preferred}-${suffix}`;
}

function choose(value, fallback) {
  return value === undefined ? fallback : value;
}

function partyAlreadyLinkedError(owner) {
  const err = new Error(`این شخص قبلاً به کاربر «${owner.name || owner.username}» متصل است — هر شخص فقط می‌تواند به یک کاربر متصل باشد`);
  err.status = 409;
  err.code = 'E_PARTY_ALREADY_LINKED';
  return err;
}

function ensureUserParty(db, userId, details = {}) {
  details = { ...details, ...(details.person || {}) };
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(userId);
  if (!user) throw new Error('کاربر یافت نشد');

  let party = null;
  const requestedPartyId = details.party_id ? Number(details.party_id) : null;
  if (requestedPartyId) party = db.prepare('SELECT * FROM parties WHERE id=?').get(requestedPartyId);
  if (requestedPartyId && !party) throw new Error('شخص انتخاب‌شده یافت نشد');
  if (!party && user.party_id) party = db.prepare('SELECT * FROM parties WHERE id=?').get(user.party_id);
  // Check before mutating the party or user. Normal requests must never steal a
  // link or silently clear the existing owner's users.party_id.
  if (party) {
    const otherOwner = db.prepare('SELECT id,name,username FROM users WHERE party_id=? AND id<>?').get(party.id, userId);
    if (otherOwner) throw partyAlreadyLinkedError(otherOwner);
  }

  const source = party || {};
  const fullName = String(choose(details.full_name, choose(details.person_full_name, user.name)) || user.name).trim();
  const phone = String(choose(details.person_phone, choose(details.phone, user.phone || source.phone || '')) || '').trim();
  const roles = partyRolesForUser(user.role, parseRoles(source.party_roles));
  const values = {
    legal_type: choose(details.legal_type, source.legal_type || 'real'),
    company_name: choose(details.company_name, source.company_name || null),
    national_id: choose(details.national_id, source.national_id || null),
    economic_code: choose(details.economic_code, source.economic_code || null),
    secondary_phone: choose(details.secondary_phone, source.secondary_phone || null),
    mobile: choose(details.mobile, source.mobile || phone || null),
    fax: choose(details.fax, source.fax || null),
    email: choose(details.email, source.email || null),
    city: choose(details.city, source.city || null),
    province: choose(details.province, source.province || null),
    address: choose(details.address, source.address || null),
    postal_code: choose(details.postal_code, source.postal_code || null),
    birth_date: choose(details.birth_date, source.birth_date || null),
    notes: choose(details.person_notes, choose(details.notes, source.notes || null)),
    party_group_id: details.party_group_id === '' ? null : choose(details.party_group_id, source.party_group_id || null),
    account_nature: choose(details.account_nature, source.account_nature || null),
  };

  let partyId;
  if (party) {
    db.prepare(`
      UPDATE parties SET full_name=?,phone=?,party_roles=?,legal_type=?,company_name=?,
        national_id=?,economic_code=?,secondary_phone=?,mobile=?,fax=?,email=?,city=?,province=?,address=?,
        postal_code=?,birth_date=?,notes=?,party_group_id=?,account_nature=?,is_active=1,
        biz=?,updated_at=strftime('%s','now') WHERE id=?
    `).run(
      fullName, phone, JSON.stringify(roles), values.legal_type, values.company_name,
      values.national_id, values.economic_code, values.secondary_phone, values.mobile, values.fax,
      values.email, values.city, values.province, values.address, values.postal_code, values.birth_date,
      values.notes, values.party_group_id, values.account_nature, fullName, party.id
    );
    partyId = party.id;
  } else {
    let coaCode = null;
    try { coaCode = allocTafsili(db, 'person', fullName); } catch (_) { /* optional in legacy bootstrap */ }
    const result = db.prepare(`
      INSERT INTO parties (
        person_code,party_type,party_roles,legal_type,full_name,company_name,national_id,economic_code,
        phone,secondary_phone,mobile,fax,email,city,province,address,postal_code,birth_date,notes,
        party_group_id,account_nature,coa_code,biz,is_active
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)
    `).run(
      nextUserPartyCode(db, user.id), 'other', JSON.stringify(roles), values.legal_type, fullName,
      values.company_name, values.national_id, values.economic_code, phone, values.secondary_phone,
      values.mobile, values.fax, values.email, values.city, values.province, values.address,
      values.postal_code, values.birth_date, values.notes, values.party_group_id, values.account_nature,
      coaCode, fullName
    );
    partyId = result.lastInsertRowid;
  }

  try {
    db.prepare('UPDATE users SET party_id=? WHERE id=?').run(partyId, user.id);
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE' || /UNIQUE constraint failed: users\.party_id/.test(e.message)) {
      const owner = db.prepare('SELECT id,name,username FROM users WHERE party_id=? AND id<>?').get(partyId, user.id);
      if (owner) throw partyAlreadyLinkedError(owner);
    }
    throw e;
  }
  return db.prepare('SELECT * FROM parties WHERE id=?').get(partyId);
}

function ensureAllUserParties(db) {
  const users = db.prepare('SELECT id FROM users WHERE party_id IS NULL OR party_id NOT IN (SELECT id FROM parties)').all();
  const tx = db.transaction(() => {
    for (const user of users) ensureUserParty(db, user.id);
  });
  tx();
  return users.length;
}

/**
 * ACC-CRM-UNIFY v1 migration — transaction-safe unique users.party_id.
 * Policy for legacy duplicates: keep lowest user id; audit then clear others.
 * Stamp settings.acc_crm_unify_v1=1 only after unique index is verified.
 */
function verifyPartyUniqueIndex(db) {
  const indexName = 'idx_users_party_id_unique';
  const master = db.prepare(
    'SELECT name, sql FROM sqlite_master WHERE type=? AND name=?'
  ).get('index', indexName);
  const listed = db.prepare("PRAGMA index_list('users')").all().find((row) => row.name === indexName);
  const columns = master ? db.prepare(`PRAGMA index_info('${indexName}')`).all() : [];
  const valid = !!master
    && listed?.unique === 1
    && listed?.partial === 1
    && columns.length === 1
    && columns[0].name === 'party_id'
    && /\bWHERE\s+party_id\s+IS\s+NOT\s+NULL\b/i.test(master.sql || '');
  if (!valid) {
    const err = new Error(
      `${indexName} missing or invalid (expected UNIQUE users(party_id) WHERE party_id IS NOT NULL)`
    );
    err.code = 'E_ACC_CRM_UNIFY_INDEX_INVALID';
    throw err;
  }
  return { name: master.name, sql: master.sql, unique: true, partial: true };
}

function runAccCrmUnifyV1(db, options = {}) {
  const done = db.prepare("SELECT value FROM settings WHERE key='acc_crm_unify_v1'").get();
  if (done && done.value === '1') {
    return { skipped: true, index: verifyPartyUniqueIndex(db) };
  }

  const run = db.transaction(() => {
    db.prepare("INSERT OR IGNORE INTO settings (key,value) VALUES ('feature_perpetual_docs','1')").run();
    db.prepare("INSERT OR IGNORE INTO settings (key,value) VALUES ('feature_cogs_voucher','1')").run();

    const dups = db.prepare(`
      SELECT party_id AS party_id, GROUP_CONCAT(id) AS ids, COUNT(*) AS c
      FROM users
      WHERE party_id IS NOT NULL
      GROUP BY party_id
      HAVING c > 1
    `).all();

    const reconcileLog = [];
    const nowIso = new Date().toISOString();
    for (const d of dups) {
      const ids = String(d.ids).split(',').map((x) => parseInt(x, 10)).filter(Number.isFinite).sort((a, b) => a - b);
      const keep = ids[0];
      for (const uid of ids.slice(1)) {
        const entry = {
          action: 'clear_duplicate_party_link',
          user_id: uid,
          party_id: d.party_id,
          kept_user_id: keep,
          policy: 'keep_lowest_user_id',
          at: nowIso,
        };
        reconcileLog.push(entry);
      }
    }
    if (reconcileLog.length) {
      // This settings record is the authoritative audit trail. It is written
      // before clearing any duplicate link and shares the same transaction.
      const auditRecord = {
        migration: 'acc_crm_unify_v1',
        policy: 'keep_lowest_user_id',
        reconciled_at: nowIso,
        records: reconcileLog,
      };
      db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('acc_crm_unify_v1_reconcile',?)")
        .run(JSON.stringify(auditRecord));
      for (const entry of reconcileLog) {
        const changed = db.prepare('UPDATE users SET party_id=NULL WHERE id=? AND party_id=?')
          .run(entry.user_id, entry.party_id);
        if (changed.changes !== 1) {
          const err = new Error(`duplicate link changed during reconcile (user_id=${entry.user_id}, party_id=${entry.party_id})`);
          err.code = 'E_ACC_CRM_UNIFY_RECONCILE';
          throw err;
        }
      }
    }

    if (typeof options.beforeCreateIndex === 'function') options.beforeCreateIndex();
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_party_id_unique ON users(party_id) WHERE party_id IS NOT NULL');
    const index = verifyPartyUniqueIndex(db);
    const still = db.prepare(`
      SELECT party_id FROM users WHERE party_id IS NOT NULL GROUP BY party_id HAVING COUNT(*)>1
    `).get();
    if (still) {
      const err = new Error(`acc_crm_unify_v1: duplicate party_id=${still.party_id} پس از reconcile باقی است`);
      err.code = 'E_ACC_CRM_UNIFY_DUP';
      throw err;
    }

    db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('acc_crm_unify_v1','1')").run();
    return { skipped: false, reconciled: reconcileLog.length, index };
  });

  try {
    return run();
  } catch (cause) {
    const err = new Error(`acc_crm_unify_v1 failed; transaction rolled back: ${cause.message}`);
    err.code = cause.code || 'E_ACC_CRM_UNIFY_MIGRATION';
    err.cause = cause;
    throw err;
  }
}

module.exports = {
  ensureUserParty, ensureAllUserParties, partyRolesForUser, runAccCrmUnifyV1,
};
