'use strict';
const { swAtLeast } = require('./lib/sw-at-least');
/**
 * SW v451 — person phone dedupe for BOM labor picker + sync paths
 * Run: node server/scripts/test-person-phone-dedupe-v451.js
 */
process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-jwt-secret-person-phone-dedupe-v451-dummy-key-32';

const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  OK', msg); }
  else { failed++; console.log('  FAIL', msg, detail != null ? detail : ''); }
}

console.log('\n══ Person phone dedupe v451 ══\n');

const dedupeSrc = fs.readFileSync(path.join(__dirname, '../lib/person-dedupe.js'), 'utf8');
const syncSrc = fs.readFileSync(path.join(__dirname, '../lib/party-employee-sync.js'), 'utf8');
const turnSrc = fs.readFileSync(path.join(__dirname, '../lib/party-turnover.js'), 'utf8');
const personsSrc = fs.readFileSync(path.join(__dirname, '../routes/persons.js'), 'utf8');
const dbSrc = fs.readFileSync(path.join(__dirname, '../db.js'), 'utf8');
const appJs = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const swSrc = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
const idxSrc = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');

ok(dedupeSrc.includes('dedupePersonsForPicker'), 'lib dedupePersonsForPicker');
ok(dedupeSrc.includes('findPersonForParty'), 'lib findPersonForParty');
ok(dedupeSrc.includes('runPersonPhoneDedupeHealV450'), 'lib heal');
ok(syncSrc.includes('findPersonForParty'), 'syncPartyToPerson uses findPersonForParty');
ok(syncSrc.includes('never INSERT a second row') || syncSrc.includes('Reuse by party_id'), 'sync comments reuse');
ok(turnSrc.includes('findPersonForParty'), 'ensurePersonForParty uses findPersonForParty');
ok(personsSrc.includes('E_PERSON_PHONE_DUP'), 'POST/PUT phone dup 409');
ok(personsSrc.includes('for_picker'), 'GET for_picker');
ok(dbSrc.includes('runPersonPhoneDedupeHealV450'), 'db boots heal');
ok(appJs.includes('dedupePersonsForPicker'), 'UI dedupePersonsForPicker');
ok(appJs.includes('/persons?for_picker=1'), 'BOM loads for_picker');
ok(appJs.includes('جستجوی شخص (v451)'), 'Help mentions v451');
ok(swAtLeast(swSrc, 452), 'SW v452');
ok(idxSrc.includes('app.js?v=452'), 'index cache bust v452');

const {
  dedupePersonsForPicker,
  findPersonForParty,
  findPersonByPhone,
  runPersonPhoneDedupeHealV450,
  normalizePersonPhone,
} = require('../lib/person-dedupe');

ok(normalizePersonPhone(' 0912 111 ') === '0912111', 'normalize phone');

const picker = dedupePersonsForPicker([
  { id: 3, name: 'مهدیه ابراهیمی', phone: '09360887707', active: 0, party_id: 102 },
  { id: 132, name: 'مهدیه ابراهیمی', phone: '09360887707', active: 0, party_id: 136 },
  { id: 10, name: 'دیگر', phone: '09120000000', active: 1 },
], null);
ok(picker.length === 2, 'picker collapses same phone', picker.length);
ok(picker.filter((p) => p.phone === '09360887707').length === 1, 'one مهدیه');
ok(Number(picker.find((p) => p.phone === '09360887707').id) === 3, 'survivor prefers older id when both inactive');

let Database;
try {
  Database = require('better-sqlite3');
  const probe = new Database(':memory:');
  probe.close();
} catch (e) {
  console.log('\nSKIP SQLite ABI — static checks only:', e.message);
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE party_groups (id INTEGER PRIMARY KEY, code INTEGER, name TEXT, entity_type TEXT, description TEXT);
  CREATE TABLE parties (
    id INTEGER PRIMARY KEY, person_code TEXT, party_type TEXT, party_roles TEXT,
    full_name TEXT, phone TEXT, address TEXT, notes TEXT, biz TEXT, company_name TEXT,
    party_group_id INTEGER, national_id TEXT, birth_date TEXT, coa_code TEXT,
    position_id INTEGER, is_active INTEGER DEFAULT 1
  );
  CREATE TABLE persons (
    id INTEGER PRIMARY KEY, name TEXT, phone TEXT, address TEXT, note TEXT,
    party_id INTEGER, party_group_id INTEGER, national_id TEXT, birth_date TEXT,
    coa_code TEXT, position_id INTEGER, active INTEGER DEFAULT 1, category_id INTEGER
  );
  CREATE UNIQUE INDEX idx_persons_party_id_unique ON persons(party_id) WHERE party_id IS NOT NULL;
`);

db.prepare("INSERT INTO party_groups (id,code,name,entity_type) VALUES (3,3,'پرسنل','person')").run();
db.prepare(`
  INSERT INTO parties (id, person_code, party_type, party_roles, full_name, phone, party_group_id, is_active)
  VALUES (102,'P-102','other','["employee"]','فاطمه شرفی','09360887707',3,0)
`).run();
db.prepare(`
  INSERT INTO parties (id, person_code, party_type, party_roles, full_name, phone, party_group_id, is_active, coa_code)
  VALUES (136,'P-136','other','["customer","supplier","employee"]','مهدیه ابراهیمی','09360887707',3,1,'210101000006')
`).run();
db.prepare(`
  INSERT INTO persons (id, name, phone, party_id, active) VALUES
  (3,'مهدیه ابراهیمی','09360887707',102,0),
  (132,'مهدیه ابراهیمی','09360887707',136,0)
`).run();

const byPhone = findPersonByPhone(db, '09360887707');
ok(byPhone && Number(byPhone.id) === 3, 'findPersonByPhone survivor', byPhone && byPhone.id);

const for136 = findPersonForParty(db, 136);
ok(for136 && Number(for136.id) === 132, 'findPersonForParty prefers party_id match', for136 && for136.id);

const for102 = findPersonForParty(db, 102);
ok(for102 && Number(for102.id) === 3, 'findPersonForParty 102', for102 && for102.id);

const { syncPartyToPerson } = require('../lib/party-employee-sync');
const before = db.prepare('SELECT COUNT(*) c FROM persons WHERE phone=?').get('09360887707').c;
const synced = syncPartyToPerson(db, 136);
const after = db.prepare('SELECT COUNT(*) c FROM persons WHERE phone=?').get('09360887707').c;
ok(synced === 132 || synced === 3, 'sync returns existing person id', synced);
ok(after === before, 'sync does not insert third person', { before, after, synced });

const heal = runPersonPhoneDedupeHealV450(db);
ok(heal && heal.skipped === false, 'heal runs once', heal);
const heal2 = runPersonPhoneDedupeHealV450(db);
ok(heal2 && heal2.skipped === true, 'heal idempotent');

// ensurePersonForParty must not create a third row for a new party with same phone
db.prepare(`
  INSERT INTO parties (id, person_code, party_type, party_roles, full_name, phone, party_group_id, is_active)
  VALUES (200,'P-200','other','["employee"]','مهدیه ابراهیمی','09360887707',3,1)
`).run();
const { ensurePersonForParty } = require('../lib/party-turnover');
const ensured = ensurePersonForParty(db, 200);
const cnt = db.prepare('SELECT COUNT(*) c FROM persons WHERE phone=?').get('09360887707').c;
ok(ensured != null, 'ensurePersonForParty returns id', ensured);
ok(cnt === 2, 'ensurePersonForParty no new insert for same phone', cnt);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
