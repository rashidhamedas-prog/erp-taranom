'use strict';
/**
 * Production access API — health-check + user_cost_centers
 */
const { ok, throws, freshDb, summary } = require('./lib/test-harness');
const { runHealthCheck } = require('../lib/production/health-check');
const {
  getUserCostCenterPayload,
  setUserCostCenters,
  listProductionUsers,
} = require('../routes/production-access');
const { costCenterFilter, assertUserCostCenter } = require('../lib/production/access');

console.log('\n══ Production Access API Tests ══\n');

const { db, cleanup } = freshDb();

db.prepare('INSERT OR IGNORE INTO users (id, username, password, name, role) VALUES (?,?,?,?,?)')
  .run(12, 'po1', 'x', 'اپراتور', 'production_operator');

// HC-01 fresh DB health-check passes
{
  const h = runHealthCheck(db);
  ok('HC-01 health-check ok on fresh db', h.ok === true);
  ok('HC-02 has H1..C7 checks', h.checks.some(c => c.code === 'H1') && h.checks.some(c => c.code === 'C7'));
  ok('HC-03 ADR-011 5210/5211 pass', h.checks.filter(c => c.code === 'ADR').every(c => c.status === 'pass'));
}

// UCC-01 list production users
{
  const users = listProductionUsers(db);
  ok('UCC-01 lists production_operator', users.some(u => u.id === 12));
  ok('UCC-02 operator unrestricted by default', users.find(u => u.id === 12)?.unrestricted === true);
}

// UCC-03 empty assignment = all centers (TP-07 API)
{
  const cc10 = db.prepare("SELECT id FROM cost_centers WHERE code='CC-10'").get()?.id;
  const cc30 = db.prepare("SELECT id FROM cost_centers WHERE code='CC-30'").get()?.id;
  ok('UCC-03 empty rows → null filter', costCenterFilter(db, 12) === null);

  setUserCostCenters(db, 12, [{ cost_center_id: cc10, can_view: 1, can_post: 1 }], 1);
  const payload = getUserCostCenterPayload(db, 12);
  ok('UCC-04 GET payload one center', payload.centers.length === 1);
  ok('UCC-05 restricted not unrestricted', payload.unrestricted === false);
  ok('UCC-06 CC-10 allowed', assertUserCostCenter(db, 12, cc10) === true);
  throws('UCC-07 CC-30 forbidden', () => assertUserCostCenter(db, 12, cc30), 'E_FORBIDDEN_CC');

  setUserCostCenters(db, 12, [], 1);
  ok('UCC-08 clear → unrestricted again', getUserCostCenterPayload(db, 12).unrestricted === true);
  ok('UCC-09 filter null after clear', costCenterFilter(db, 12) === null);
}

// UCC-10 not found user
{
  throws('UCC-10 unknown user GET', () => getUserCostCenterPayload(db, 99999), 'E_NOT_FOUND');
  throws('UCC-11 unknown user PUT', () => setUserCostCenters(db, 99999, [], 1), 'E_NOT_FOUND');
}

cleanup();
summary('Production Access API');
