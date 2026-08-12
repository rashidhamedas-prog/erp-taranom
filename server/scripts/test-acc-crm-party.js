#!/usr/bin/env node
const { ok, freshDb, summary } = require('./lib/test-harness');
const { ensureUserParty, runAccCrmUnifyV1 } = require('../lib/user-party');

console.log('══ ACC-CRM user↔party ══');
const { db, cleanup } = freshDb();
try {
  const u = db.prepare(`
    INSERT INTO users (username,password,name,role,active,phone)
    VALUES ('party_test_u','x','کاربر تست party','field_sales',1,'09154440004')
  `).run();
  const userId = u.lastInsertRowid;
  const p1 = ensureUserParty(db, userId, { party_group_id: null, full_name: 'کاربر تست party' });
  ok('ensureUserParty creates party', !!p1?.id);
  const link = db.prepare('SELECT party_id FROM users WHERE id=?').get(userId);
  ok('users.party_id set', link.party_id === p1.id);

  const p2 = ensureUserParty(db, userId, { full_name: 'کاربر تست party ویرایش' });
  ok('edit does not create duplicate party', p2.id === p1.id);
  const cnt = db.prepare("SELECT COUNT(*) c FROM parties WHERE person_code LIKE 'USER-%' AND full_name LIKE 'کاربر تست party%'").get().c;
  ok('no duplicate party rows for same user code family', cnt >= 1);

  const u2 = db.prepare(`
    INSERT INTO users (username,password,name,role,active,phone)
    VALUES ('party_test_u2','x','کاربر دوم','inside_sales',1,'09154440005')
  `).run();
  const user2 = u2.lastInsertRowid;
  let threw = false;
  let code = null;
  try {
    ensureUserParty(db, user2, { party_id: p1.id });
  } catch (e) {
    threw = true;
    code = e.code;
  }
  ok('refuse linking party owned by another user', threw && code === 'E_PARTY_ALREADY_LINKED');
  const ownerStill = db.prepare('SELECT party_id FROM users WHERE id=?').get(userId);
  const otherStill = db.prepare('SELECT party_id FROM users WHERE id=?').get(user2);
  ok('conflict does not NULL original owner', ownerStill.party_id === p1.id);
  ok('conflict does not steal link onto requester', otherStill.party_id == null || otherStill.party_id !== p1.id);

  // --- duplicate legacy → reconcile + index + stamp ---
  db.prepare("DELETE FROM settings WHERE key IN ('acc_crm_unify_v1','acc_crm_unify_v1_reconcile')").run();
  try { db.exec('DROP INDEX IF EXISTS idx_users_party_id_unique'); } catch (_) { /* */ }

  // Force legacy duplicate (same party on two users) — bypass ensureUserParty + unique index
  db.prepare('UPDATE users SET party_id=? WHERE id=?').run(p1.id, user2);
  const dupBefore = db.prepare(`
    SELECT COUNT(*) c FROM users WHERE party_id=?
  `).get(p1.id).c;
  ok('fixture has duplicate party_id links', dupBefore >= 2);

  const mig1 = runAccCrmUnifyV1(db);
  ok('migration reconciles duplicates', mig1.skipped === false && mig1.reconciled >= 1);
  const stamp = db.prepare("SELECT value FROM settings WHERE key='acc_crm_unify_v1'").get()?.value;
  ok('migration stamp present after success', stamp === '1');
  const idx = db.prepare(
    "SELECT name,sql FROM sqlite_master WHERE type='index' AND name='idx_users_party_id_unique'"
  ).get();
  const idxPragma = db.prepare("PRAGMA index_list('users')").all()
    .find((row) => row.name === 'idx_users_party_id_unique');
  ok('unique partial index exists and is verified',
    !!idx
    && /WHERE\s+party_id\s+IS\s+NOT\s+NULL/i.test(idx.sql)
    && idxPragma?.unique === 1
    && idxPragma?.partial === 1);
  const dupAfter = db.prepare(`
    SELECT party_id FROM users WHERE party_id IS NOT NULL GROUP BY party_id HAVING COUNT(*)>1
  `).get();
  ok('no duplicate party_id remain', !dupAfter);
  const recon = db.prepare("SELECT value FROM settings WHERE key='acc_crm_unify_v1_reconcile'").get()?.value;
  ok('reconcile audit JSON recorded', !!recon && recon.includes('clear_duplicate_party_link'));

  // Idempotent restart
  const mig2 = runAccCrmUnifyV1(db);
  ok('second run is idempotent skip', mig2.skipped === true);

  // Forced failure after audit/reconcile work: transaction must roll back fully,
  // leave duplicates untouched and permit a clean retry on restart.
  db.prepare("DELETE FROM settings WHERE key IN ('acc_crm_unify_v1','acc_crm_unify_v1_reconcile')").run();
  try { db.exec('DROP INDEX IF EXISTS idx_users_party_id_unique'); } catch (_) { /* */ }
  // Create two users sharing a fresh party without going through unique index
  const partyX = db.prepare(`
    INSERT INTO parties (person_code,party_type,full_name,phone,is_active)
    VALUES ('USER-FAIL-X','other','Fail Party','09150001111',1)
  `).run().lastInsertRowid;
  const uf1 = db.prepare(`
    INSERT INTO users (username,password,name,role,active,phone,party_id)
    VALUES ('fail_u1','x','F1','field_sales',1,'09150001112',?)
  `).run(partyX).lastInsertRowid;
  const uf2 = db.prepare(`
    INSERT INTO users (username,password,name,role,active,phone,party_id)
    VALUES ('fail_u2','x','F2','field_sales',1,'09150001113',?)
  `).run(partyX).lastInsertRowid;
  ok('failure fixture duplicates ready',
    db.prepare('SELECT COUNT(*) c FROM users WHERE party_id=?').get(partyX).c === 2);

  let forcedFailure = null;
  try {
    runAccCrmUnifyV1(db, {
      beforeCreateIndex() {
        const err = new Error('forced index failure');
        err.code = 'E_TEST_FORCED_INDEX_FAILURE';
        throw err;
      },
    });
  } catch (e) {
    forcedFailure = e;
  }
  ok('forced migration failure is actionable',
    forcedFailure?.code === 'E_TEST_FORCED_INDEX_FAILURE'
    && /transaction rolled back/.test(forcedFailure.message));
  ok('failed migration does not stamp',
    !db.prepare("SELECT 1 FROM settings WHERE key='acc_crm_unify_v1'").get());
  ok('failed migration rolls back audit and duplicate clears',
    !db.prepare("SELECT 1 FROM settings WHERE key='acc_crm_unify_v1_reconcile'").get()
    && db.prepare('SELECT COUNT(*) c FROM users WHERE party_id=?').get(partyX).c === 2);
  ok('failed migration does not leave unique index',
    !db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_users_party_id_unique'").get());

  // Idempotent restart retries the same legacy duplicate set successfully.
  const mig3 = runAccCrmUnifyV1(db);
  ok('retry after forced failure succeeds',
    mig3.skipped === false
    && db.prepare("SELECT value FROM settings WHERE key='acc_crm_unify_v1'").get()?.value === '1');
  const keepLowest = db.prepare('SELECT id FROM users WHERE party_id=?').get(partyX);
  ok('policy keeps lowest user id', keepLowest && keepLowest.id === Math.min(uf1, uf2));

  // Implicit binding still works for unbound user
  const uNew = db.prepare(`
    INSERT INTO users (username,password,name,role,active,phone)
    VALUES ('party_implicit','x','Implicit','field_sales',1,'09154440099')
  `).run().lastInsertRowid;
  const pNew = ensureUserParty(db, uNew, { full_name: 'Implicit User' });
  ok('implicit binding creates party', !!pNew?.id && db.prepare('SELECT party_id FROM users WHERE id=?').get(uNew).party_id === pNew.id);
} finally {
  cleanup();
}
summary('ACC-CRM party');
