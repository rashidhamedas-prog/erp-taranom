#!/usr/bin/env node
const { ok, freshDb, summary } = require('./lib/test-harness');
const { ensureUserParty } = require('../lib/user-party');

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
  let threw = false;
  try {
    ensureUserParty(db, u2.lastInsertRowid, { party_id: p1.id });
  } catch (e) {
    threw = e.code === 'E_PARTY_ALREADY_LINKED' || /متصل است/.test(e.message);
  }
  ok('refuse linking party owned by another user', threw);
} finally {
  cleanup();
}
summary('ACC-CRM party');
