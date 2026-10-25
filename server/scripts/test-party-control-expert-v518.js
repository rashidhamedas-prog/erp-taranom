'use strict';
const { swAtLeast } = require('./lib/sw-at-least');
/**
 * کنترل حساب اشخاص — فیلتر کارشناس (SW v518)
 * Run: node server/scripts/test-party-control-expert-v518.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-expert-v518-'));
const dbPath = path.join(tmpDir, 't.db');
process.env.DB_PATH = dbPath;
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-party-control-expert-v518-secret-32b';
process.env.NODE_ENV = 'test';

const { getDB, initDB } = require('../db');
const { buildPartyControlDashboard } = require('../lib/party-control-dashboard');

initDB();
const db = getDB();

let passed = 0;
function ok(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exit(1);
  }
  passed++;
  console.log('OK:', msg);
}

const insUser = db.prepare('INSERT INTO users (name, username, password, role, active) VALUES (?,?,?,?,1)');
const expertA = insUser.run('نگار احمدی', 'exp-v518-a', 'x', 'field_sales').lastInsertRowid;
const expertB = insUser.run('رضا محمدی', 'exp-v518-b', 'x', 'inside_sales').lastInsertRowid;

const insParty = db.prepare(`
  INSERT INTO parties (person_code, party_type, party_roles, full_name, phone, opening_balance, is_active, user_id)
  VALUES (?,?,?,?,?,?,1,?)
`);
insParty.run('PX-A', 'customer', JSON.stringify(['customer']), 'مشتری نگار', '09121800001', 1000000, expertA);
insParty.run('PX-B', 'customer', JSON.stringify(['customer']), 'مشتری رضا', '09121800002', 2000000, expertB);
insParty.run('PX-C', 'supplier', JSON.stringify(['supplier']), 'تأمین بدون کارشناس', '09121800003', -3000000, null);
insParty.run('PX-D', 'customer', JSON.stringify(['customer']), 'مشتری از لینک', '09121800004', 400000, null);
insParty.run('PX-E', 'customer', JSON.stringify(['customer']), 'کارت شخص مقدم است', '09121800005', 500000, expertB);

const idOf = (code) => db.prepare('SELECT id FROM parties WHERE person_code=?').get(code).id;
const partyA = idOf('PX-A');
const partyB = idOf('PX-B');
const partyC = idOf('PX-C');
const partyD = idOf('PX-D');
const partyE = idOf('PX-E');

db.prepare(`
  INSERT INTO customers (user_id, biz, phone, assigned_to, party_id)
  VALUES (?,?,?,?,?)
`).run(expertB, 'فروشگاه لینک', '09121800004', expertA, partyD);

db.prepare(`
  INSERT INTO customers (user_id, biz, phone, assigned_to, party_id)
  VALUES (?,?,?,?,?)
`).run(expertA, 'فروشگاه کارت', '09121800005', expertA, partyE);

const base = { balance: 'all', limit: 100 };
const all = buildPartyControlDashboard(db, base);
ok(all.kpis.parties_total >= 5, 'company party count');
ok(all.kpis.total_debit_rial >= 1000000 + 2000000 + 400000 + 500000, 'company debit includes every opening');
ok(all.kpis.total_credit_rial >= 3000000, 'supplier credit stays in company total');
ok(all.parties.find((p) => p.id === partyA).expert_name === 'نگار احمدی', 'party user_id name');
ok(all.parties.find((p) => p.id === partyD).expert_id === expertA, 'customer assigned_to fills empty party expert');
ok(all.parties.find((p) => p.id === partyE).expert_id === expertB, 'party user_id wins over customer owner');
ok(!all.parties.find((p) => p.id === partyC).expert_id, 'supplier without owner has no expert');
ok(all.experts.some((e) => e.id === expertA && e.count === 2), 'expert catalog counts A and linked D');
ok(all.unassigned_count >= 1, 'unassigned count');

const onlyA = buildPartyControlDashboard(db, { ...base, expert_id: String(expertA) });
const idsA = onlyA.parties.map((p) => p.id).sort((x, y) => x - y);
ok(idsA.length === 2 && idsA.includes(partyA) && idsA.includes(partyD), 'expert A list is A+D');
ok(!idsA.includes(partyB) && !idsA.includes(partyE) && !idsA.includes(partyC), 'expert A excludes others');
ok(onlyA.kpis.total_debit_rial === 1400000, 'expert A KPI debit is 1.4M');
ok(onlyA.kpis.total_credit_rial === 0, 'expert A KPI has no supplier credit');
ok(onlyA.kpis.parties_total >= 5, 'company total stays on KPI when expert filtered');
ok(onlyA.kpis.parties_in_scope === 2, 'scope count is the expert book');
ok(onlyA.filters.expert_id === expertA, 'echoes expert filter');
ok(onlyA.by_role.every((r) => r.role === 'customer'), 'role split is inside the expert book');

const onlyB = buildPartyControlDashboard(db, { ...base, expert_id: expertB });
const idsB = onlyB.parties.map((p) => p.id);
ok(idsB.includes(partyB) && idsB.includes(partyE) && idsB.length === 2, 'expert B list is B+E');
ok(onlyB.kpis.total_debit_rial === 2500000, 'expert B KPI debit is 2.5M');

const none = buildPartyControlDashboard(db, { ...base, expert_id: 'none' });
const noneIds = new Set(none.parties.map((p) => p.id));
ok(noneIds.has(partyC) && ![partyA, partyB, partyD, partyE].some((id) => noneIds.has(id)), 'none keeps only unassigned parties');
ok(none.parties.every((p) => !p.expert_id), 'none rows have no expert');
ok(none.kpis.total_credit_rial === all.kpis.total_credit_rial, 'none credit is the unassigned book');
ok(none.kpis.total_debit_rial === all.kpis.total_debit_rial - 3900000, 'none debit excludes assigned openings');

const junk = buildPartyControlDashboard(db, { ...base, expert_id: 'not-a-number' });
ok(junk.kpis.parties_in_scope === all.kpis.parties_in_scope, 'invalid expert id does not filter');

const narrowed = buildPartyControlDashboard(db, { ...base, expert_id: expertA, side: 'debit', search: 'لینک' });
ok(narrowed.parties.length === 1 && narrowed.parties[0].id === partyD, 'search still applies inside expert');
ok(narrowed.kpis.total_debit_rial === 1400000, 'side/search do not shrink expert KPI');

const src = fs.readFileSync(path.join(__dirname, '../lib/party-control-dashboard.js'), 'utf8');
ok(src.includes('parseExpertFilter'), 'builder parses expert filter');
const ui = fs.readFileSync(path.join(__dirname, '../public/portal-ui.js'), 'utf8');
ok(ui.includes('id="pcExpert"') && ui.includes('expert_id='), 'dashboard filter sends expert_id');
const help = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
ok(help.includes('کارشناس</b> (v518)'), 'admin help mentions expert filter');
const sw = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
ok(swAtLeast(sw, 518), 'service worker v518');

console.log(`\nPASS ${passed} assertions — party-control expert v518`);
