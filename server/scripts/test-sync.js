// End-to-end sync verification: central (:4100) + two devices (:4101, :4102),
// fresh databases. Covers: pairing, true-offline queueing (central down),
// concurrent numbering from two devices, chained refs, pull propagation of
// edits + tombstoned deletes, version conflict on concurrent edit, oversell
// conflict, idempotency — asserting Trial Balance + Balance Sheet stay
// balanced on central and all instances converge.
const { spawn } = require('child_process');
const fs = require('fs');

const os = require('os');
const path = require('path');
const S = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-sync-e2e-'));
const SERVER = path.join(__dirname, '..', 'server.js');
const CWD = path.join(__dirname, '..');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log('  ✅', label); }
  else { failed++; console.log('  ❌', label); }
}

const procs = {};
function start(name, env) {
  const p = spawn('node', [SERVER], { cwd: CWD, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', () => {});
  p.stderr.on('data', d => console.error(`[${name}]`, d.toString().slice(0, 200)));
  procs[name] = p;
  return p;
}
function stop(name) { if (procs[name]) { procs[name].kill('SIGKILL'); delete procs[name]; } }
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function req(base, method, path, token, body) {
  const r = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, body: j };
}

const C = 'http://127.0.0.1:4100';
const A = 'http://127.0.0.1:4101';
const B = 'http://127.0.0.1:4102';

const centralEnv = { JWT_SECRET: 'c', PORT: '4100', DB_PATH: `${S}/e2e-central.db` };

(async () => {

  console.log('— boot central + devices —');
  start('central', centralEnv);
  start('devA', { JWT_SECRET: 'a', PORT: '4101', DB_PATH: `${S}/e2e-devA.db`, SYNC_ROLE: 'device', SYNC_INTERVAL_MS: '3600000' });
  start('devB', { JWT_SECRET: 'b', PORT: '4102', DB_PATH: `${S}/e2e-devB.db`, SYNC_ROLE: 'device', SYNC_INTERVAL_MS: '3600000' });
  await sleep(3000);

  const ct = (await req(C, 'POST', '/api/auth/login', null, { username: 'admin', password: 'admin123' })).body.token;
  let at = (await req(A, 'POST', '/api/auth/login', null, { username: 'admin', password: 'admin123' })).body.token;
  let bt = (await req(B, 'POST', '/api/auth/login', null, { username: 'admin', password: 'admin123' })).body.token;
  ok(ct && at && bt, 'all three instances up + login');

  console.log('— seed central —');
  await req(C, 'POST', '/api/products', ct, { name: 'کالای اصلی', code: 'M-1', price: 50000, cost: 20000, stock: 100 });
  const custC = (await req(C, 'POST', '/api/customers', ct, { biz: 'مشتری مشترک' })).body;
  await req(C, 'POST', '/api/followups', ct, { cust_id: custC.id, date: '1405/04/01', type: 'تماس', subject: 'برای حذف', status: 'open' });

  console.log('— scenario 1: pair both devices —');
  const pA = await req(A, 'POST', '/api/sync/pair-device', at, { central_url: C, username: 'admin', password: 'admin123', device_name: 'دستگاه A' });
  const pB = await req(B, 'POST', '/api/sync/pair-device', bt, { central_url: C, username: 'admin', password: 'admin123', device_name: 'دستگاه B' });
  ok(pA.body.ok && pB.body.ok, `pairing (A=device ${pA.body.device_id}, B=device ${pB.body.device_id})`);
  const aCust = (await req(A, 'GET', '/api/customers', at)).body;
  const bProd = (await req(B, 'GET', '/api/products', bt)).body;
  ok(aCust.some(c => c.biz === 'مشتری مشترک'), 'A pulled central customer');
  ok(bProd.some(p => p.code === 'M-1' && p.stock === 100), 'B pulled central product');

  console.log('— scenario 2: TRUE offline — central down, device A keeps working —');
  stop('central');
  await sleep(400);
  const offCust = (await req(A, 'POST', '/api/customers', at, { biz: 'مشتری در قطعی' })).body;
  const offInv = (await req(A, 'POST', '/api/invoices', at, {
    cust_id: offCust.id, type: 'final', rows: [{ product_id: 1, qty: 5, price: 50000 }]
  })).body;
  ok(offCust.id >= 1e12 && offInv.id >= 1e12, `offline creates use provisional ids (${offCust.id}, ${offInv.id})`);
  ok(String(offInv.num).startsWith('موقت'), `offline invoice number provisional (${offInv.num})`);
  const syncFail = (await req(A, 'POST', '/api/sync/now', at)).body;
  ok(syncFail.ok === false, `sync while central down fails gracefully (${syncFail.error})`);
  let stA = (await req(A, 'GET', '/api/sync/status', at)).body;
  ok(stA.pending === 2 && stA.online === false, `2 ops queued, offline state reported`);

  console.log('— scenario 3: central returns; A syncs; chained refs resolve —');
  start('central', centralEnv);
  await sleep(2500);
  let syncOK = null, totalConfirmed = 0;
  for (let i = 0; i < 4; i++) {
    syncOK = (await req(A, 'POST', '/api/sync/now', at)).body;
    console.log(`   attempt ${i + 1}:`, JSON.stringify(syncOK));
    totalConfirmed += syncOK.confirmed || 0;
    if (syncOK.ok && syncOK.pending === 0 && !syncOK.conflicts) break;
    await sleep(1500);
  }
  ok(totalConfirmed === 2 || (syncOK.ok && syncOK.pending === 0), `sync after reconnect confirmed both ops (total ${totalConfirmed})`);
  const cInv = (await req(C, 'GET', '/api/invoices', ct)).body;
  const applied = cInv.find(i => i.final === 250000);
  ok(applied && /^T-\d{4}$/.test(applied.num), `central assigned real number (${applied && applied.num})`);
  const cCust2 = (await req(C, 'GET', '/api/customers', ct)).body.find(c => c.biz === 'مشتری در قطعی');
  ok(cCust2 && applied.cust_id === cCust2.id, 'chained provisional customer ref translated');
  const aInvAfter = (await req(A, 'GET', '/api/invoices', at)).body;
  ok(aInvAfter.every(i => i.id < 1e12) && aInvAfter.some(i => i.num === applied.num), 'A converged to central rows');

  console.log('— scenario 4: concurrent invoices from A and B → unique numbers —');
  const abCust = (await req(A, 'GET', '/api/customers', at)).body.find(c => c.biz === 'مشتری مشترک');
  await req(A, 'POST', '/api/invoices', at, { cust_id: abCust.id, type: 'final', rows: [{ product_id: 1, qty: 1, price: 50000 }] });
  await req(B, 'POST', '/api/invoices', bt, { cust_id: abCust.id, type: 'final', rows: [{ product_id: 1, qty: 2, price: 50000 }] });
  await req(A, 'POST', '/api/sync/now', at);
  await req(B, 'POST', '/api/sync/now', bt);
  const nums = (await req(C, 'GET', '/api/invoices', ct)).body.map(i => i.num);
  ok(new Set(nums).size === nums.length, `all invoice numbers unique: ${nums.join(', ')}`);

  console.log('— scenario 5: central edit + tombstoned delete propagate to devices —');
  await req(C, 'PUT', `/api/customers/${custC.id}`, ct, { biz: 'مشتری مشترک (ویرایش مرکزی)' });
  const fu = (await req(C, 'GET', '/api/followups', ct)).body.find(f => f.subject === 'برای حذف');
  await req(C, 'DELETE', `/api/followups/${fu.id}`, ct);
  await req(A, 'POST', '/api/sync/now', at);
  await req(B, 'POST', '/api/sync/now', bt);
  const aC = (await req(A, 'GET', '/api/customers', at)).body.find(c => c.id === custC.id);
  const bFu = (await req(B, 'GET', '/api/followups', bt)).body;
  ok(aC && aC.biz.includes('ویرایش مرکزی'), 'central edit reached device A');
  ok(!bFu.some(f => f.id === fu.id), 'tombstoned delete reached device B');

  console.log('— scenario 6: version conflict — A edits stale row, central edited meanwhile —');
  // A is currently in sync. Central edits the customer; then A (without pulling) edits the same customer.
  await req(C, 'PUT', `/api/customers/${custC.id}`, ct, { biz: 'نام مرکزی جدیدتر' });
  const aEdit = await req(A, 'PUT', `/api/customers/${custC.id}`, at, { biz: 'نام از دستگاه A' });
  ok(aEdit.status === 200, 'A local edit applied locally');
  const pushRes = (await req(A, 'POST', '/api/sync/now', at)).body;
  const conflictsA = (await req(A, 'GET', '/api/sync/conflicts', at)).body;
  ok(conflictsA.some(c => c.method === 'PUT' && c.path.includes('/customers/')), 'concurrent edit flagged as conflict (not last-write-wins)');
  const cName = (await req(C, 'GET', '/api/customers', ct)).body.find(c => c.id === custC.id).biz;
  ok(cName === 'نام مرکزی جدیدتر', `central kept its newer value (${cName})`);
  // discard on A → row restored to central state
  const cid = conflictsA.find(c => c.method === 'PUT').id;
  await req(A, 'POST', `/api/sync/conflicts/${cid}/discard`, at);
  const aName = (await req(A, 'GET', '/api/customers', at)).body.find(c => c.id === custC.id).biz;
  ok(aName === 'نام مرکزی جدیدتر', 'discard restored central value on A');

  console.log('— scenario 7: oversell conflict (STALE local stock) + idempotent retry —');
  // B pulls while stock is high, THEN central stock drops without B knowing.
  await req(B, 'POST', '/api/sync/now', bt);
  const bStale = (await req(B, 'GET', '/api/products', bt)).body.find(p => p.code === 'M-1').stock;
  await req(C, 'PATCH', '/api/products/1/stock', ct, { stock: 1 });
  // B, seeing the stale higher stock, sells more than central now has:
  const oversellQty = Math.min(bStale, 5);
  const bInv = (await req(B, 'POST', '/api/invoices', bt, { cust_id: abCust.id, type: 'final', rows: [{ product_id: 1, qty: oversellQty, price: 50000 }] })).body;
  ok(bInv.id >= 1e12, `B created invoice locally against stale stock ${bStale} (qty ${oversellQty})`);
  await req(B, 'POST', '/api/sync/now', bt);
  await req(B, 'POST', '/api/sync/now', bt); // idempotent retry
  const confB = (await req(B, 'GET', '/api/sync/conflicts', bt)).body;
  ok(confB.length === 1 && confB[0].reason.includes('کافی نیست'), `oversell flagged exactly once (${confB[0] && confB[0].reason})`);
  const cStock = (await req(C, 'GET', '/api/products', ct)).body.find(p => p.code === 'M-1').stock;
  ok(cStock === 1, `central stock untouched by conflicted op (${cStock})`);
  // cleanup: discard so final balance checks run on a conflict-free state
  await req(B, 'POST', `/api/sync/conflicts/${confB[0].id}/discard`, bt);
  const confB2 = (await req(B, 'GET', '/api/sync/conflicts', bt)).body;
  ok(confB2.length === 0, 'discard cleared the conflict on B');

  console.log('— final: books balanced on central —');
  const tb = (await req(C, 'GET', '/api/accounting/trial-balance', ct)).body;
  const bs = (await req(C, 'GET', '/api/accounting/balance-sheet', ct)).body;
  ok(tb.balanced, `Trial Balance balanced (D=${tb.totalDebit} C=${tb.totalCredit})`);
  ok(bs.balanced, `Balance Sheet balanced (assets=${bs.totalAssets})`);

  console.log(`\n${failed === 0 ? '🎉' : '💥'} ${passed} passed, ${failed} failed`);
  for (const n of Object.keys(procs)) stop(n);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR:', e); for (const n of Object.keys(procs)) stop(n); process.exit(1); });
