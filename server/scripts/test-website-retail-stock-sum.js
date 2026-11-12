#!/usr/bin/env node
/**
 * website-retail-stock-sum (v643)
 *  - RETAIL multi-warehouse qty = Σ per-warehouse COALESCE(vws, ledger, 0)
 *  - 429/5xx/timeout never burn an outbox row into 'error' (global pause + Retry-After)
 *  - staggered full sync / channel resync / transient requeue / stale warehouse set
 *  - ledger movement → notifyStockChanged
 *
 * Fresh temp DB, SYNC_ROLE=central, requestJSON stubbed (no network), clock stubbed.
 * Never touches product 342.
 */
'use strict';

process.env.SYNC_ROLE = 'central';
process.env.WEBSITE_STOCK_CHUNK_GAP_MS = '0';

const { ok, eq, freshDb, summary } = require('./lib/test-harness');

console.log('══ website-retail-stock-sum (v643) ══');
const { db, cleanup } = freshDb();
const sync = require('../lib/website-stock-sync');
const { setSetting } = require('../lib/secret-settings');

const T0 = 1_800_000_000_000; // fixed clock (ms)
const SEC0 = Math.floor(T0 / 1000);

let calls = [];
let respond = () => ({ status: 200, body: '{}', headers: {} });
sync.requestJSON = async (url, method, body, headers) => {
  calls.push({ url, method, body, headers });
  return respond(body);
};
function okMatrix(body) {
  return {
    status: 200,
    headers: {},
    body: JSON.stringify({ matched: (body.variants || []).map((v) => v.erpVariantSku), unmatched: [] }),
  };
}

function setSettings(map) {
  for (const [k, v] of Object.entries(map)) setSetting(db, k, v);
}

(async () => {
try {
  // ── fixture: 2 warehouses, one matrix product (4 variants), one plain product ──
  const user = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get();
  const uid = user ? user.id : db.prepare("INSERT INTO users (username,password,name,role,active) VALUES ('t','x','t','admin',1)").run().lastInsertRowid;
  const whA = Number(db.prepare("INSERT INTO warehouses (name, active) VALUES ('انبار الف',1)").run().lastInsertRowid);
  const whB = Number(db.prepare("INSERT INTO warehouses (name, active) VALUES ('انبار ب',1)").run().lastInsertRowid);
  const whW = Number(db.prepare("INSERT INTO warehouses (name, active) VALUES ('انبار عمده',1)").run().lastInsertRowid);

  const mkProduct = (code, name) => Number(db.prepare(
    'INSERT INTO products (user_id, code, name, price, stock) VALUES (?,?,?,0,0)'
  ).run(uid, code, name).lastInsertRowid);
  const P = mkProduct('T-5001', 'مانتو تست');
  const P2 = mkProduct('T-5002', 'کالای ساده');
  ok('fixture never uses product 342', P !== 342 && P2 !== 342);

  const c1 = Number(db.prepare("INSERT INTO product_colors (name) VALUES ('مشکی')").run().lastInsertRowid);
  const c2 = Number(db.prepare("INSERT INTO product_colors (name) VALUES ('سفید')").run().lastInsertRowid);
  const s1 = Number(db.prepare("INSERT INTO product_sizes (name) VALUES ('M')").run().lastInsertRowid);
  const s2 = Number(db.prepare("INSERT INTO product_sizes (name) VALUES ('L')").run().lastInsertRowid);
  const mkVar = (color, size, sku) => Number(db.prepare(
    'INSERT INTO product_variants (product_id, color_id, size_id, sku, active, is_default) VALUES (?,?,?,?,1,0)'
  ).run(P, color, size, sku).lastInsertRowid);
  const v1 = mkVar(c1, s1, 'T-5001-1');
  const v2 = mkVar(c1, s2, 'T-5001-2');
  const v3 = mkVar(c2, s1, 'T-5001-3');
  const v4 = mkVar(c2, s2, 'T-5001-4');
  const vws = (v, w, q) => db.prepare(
    'INSERT OR REPLACE INTO variant_warehouse_stock (variant_id, warehouse_id, qty) VALUES (?,?,?)'
  ).run(v, w, q);
  vws(v1, whA, 5); vws(v1, whB, 3); // 8
  vws(v2, whA, 2);                  // 2 (B has no row)
  vws(v3, whB, 7);                  // 7
  vws(v4, whA, 0); vws(v4, whB, 1); // 1

  setSettings({
    website_stock_sync_enabled: '1',
    website_stock_sync_mode: 'push',
    website_target: 'site_b2b',
    website_b2b_url: 'https://api.example.com',
    website_b2b_token: 'test-token',
    website_wh_wholesale_id: String(whW),
    website_wh_retail_id: String(whA),
    website_wh_retail_2_id: String(whB),
  });
  const settingsMap = () => sync.getSettingsMap(db, { needB2b: false, needWoo: false });
  const retailIds = sync.channelWarehouseIds(settingsMap(), 'RETAIL');
  ok('retail warehouse set = [A,B]', retailIds.length === 2 && retailIds[0] === whA && retailIds[1] === whB);

  // ── 1. multi-WH SUM per warehouse ──
  const qtyOf = (payload) => payload.variants.map((v) => v.qty);
  let pl = sync.buildMatrixPayload(db, P, 'RETAIL', retailIds);
  ok('1. RETAIL qty is the SUM over both warehouses [8,2,7,1]', JSON.stringify(qtyOf(pl)) === '[8,2,7,1]', JSON.stringify(qtyOf(pl)));

  // ── 2. mixed VWS / ledger: per-warehouse COALESCE, not COALESCE(SUM(vws),SUM(led)) ──
  db.prepare('DELETE FROM variant_warehouse_stock WHERE variant_id=? AND warehouse_id=?').run(v4, whA);
  db.prepare(`
    INSERT INTO inventory_ledger
      (tx_no, event_type, product_id, warehouse_id, variant_id, qty_in, qty_out, qty_balance,
       unit_cost_rial, amount_rial, avg_cost_after_rial, status, date)
    VALUES ('T-LED-1','opening',?,?,?,4,0,4,0,0,0,'posted','1405/01/01')
  `).run(P, whA, v4);
  pl = sync.buildMatrixPayload(db, P, 'RETAIL', retailIds);
  ok('2. variant4 = ledger(A)=4 + vws(B)=1 = 5 (not 1)', pl.variants[3].qty === 5, `qty=${pl.variants[3].qty}`);
  ok('2b. other variants unchanged', JSON.stringify(qtyOf(pl).slice(0, 3)) === '[8,2,7]');

  // ── 3. single-WH wholesale path unchanged ──
  vws(v1, whW, 11);
  const plW = sync.buildMatrixPayload(db, P, 'WHOLESALE', [whW]);
  ok('3. WHOLESALE uses only its warehouse', plW.variants[0].qty === 11 && plW.variants[1].qty === 0);

  // ── 4. breakdown line ──
  const line = sync.retailWarehouseBreakdown(db, P, retailIds);
  ok('4. breakdown «تکی = الف + ب = total»', /^تکی = انبار الف \d+ \+ انبار ب \d+ = \d+$/.test(line), line);
  ok('4b. breakdown total = 8+2+7+5 = 22', /= 22$/.test(line), line);

  // ── 5. dry-run includes the breakdown line for RETAIL ──
  respond = okMatrix;
  calls = [];
  const dry = await sync.dryRunProductMatrix(db, 'T-5001');
  ok('5. dry-run ok', dry.ok === true, JSON.stringify(dry.lines));
  ok('5b. dry-run lines contain RETAIL breakdown', dry.lines.some((l) => l.startsWith('تکی = ')), JSON.stringify(dry.lines));
  ok('5c. dry-run sent dryRun=true', calls.length > 0 && calls.every((c) => c.body.dryRun === true));

  // ── helper: outbox fixtures ──
  sync.ensureWebsiteStockOutbox(db);
  const resetOutbox = () => db.prepare('DELETE FROM website_stock_outbox').run();
  const insRow = (pid, ch, o = {}) => db.prepare(`
    INSERT INTO website_stock_outbox
      (product_id, channel, next_at, attempts, status, last_error, last_result, payload_hash, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(pid, ch, o.next_at != null ? o.next_at : SEC0 - 10, o.attempts || 0, o.status || 'pending',
    o.last_error || '', o.last_result || '', o.payload_hash || '', o.updated_at || SEC0 - 20);
  const getRow = (id) => db.prepare('SELECT * FROM website_stock_outbox WHERE id=?').get(id);

  // ── 6. 429: pending (never error), Retry-After honoured, global pause, others bumped ──
  sync.__setClockForTests(T0);
  sync.__setPauseUntilForTests(0);
  resetOutbox();
  const r429 = Number(insRow(P, 'RETAIL', { attempts: sync.MAX_ATTEMPTS + 3 }).lastInsertRowid); // above the cap
  const rOther = Number(insRow(P, 'WHOLESALE', { next_at: SEC0 + 5 }).lastInsertRowid);
  const rLate = Number(insRow(P2, 'RETAIL', { next_at: SEC0 + 100000 }).lastInsertRowid);
  respond = () => ({ status: 429, body: 'Too Many Requests', headers: { 'retry-after': '120' } });
  calls = [];
  const d1 = await sync.drainWebsiteStockOutbox(db);
  const row429 = getRow(r429);
  ok('6. 429 → status pending (never error) even beyond MAX_ATTEMPTS', row429.status === 'pending', row429.status);
  // Prompt: next_at = now + max(backoff, Retry-After), capped at 3600.
  ok('6b. next_at ≥ Retry-After 120s (max with backoff)', row429.next_at >= SEC0 + 120 && row429.next_at <= SEC0 + 3600, `${row429.next_at - SEC0}`);
  ok('6c. last_error is the HTTP 429 text', /HTTP 429/.test(row429.last_error), row429.last_error);
  ok('6d. global pause ≥ now+120s', sync.__getPauseUntilForTests() >= T0 + 120_000 && sync.__getPauseUntilForTests() <= T0 + 3600_000, String(sync.__getPauseUntilForTests() - T0));
  ok('6e. other pending next_at bumped to ≥ pause end', getRow(rOther).next_at >= Math.ceil(sync.__getPauseUntilForTests() / 1000));
  ok('6f. far-future row not pulled earlier', getRow(rLate).next_at === SEC0 + 100000);
  ok('6g. loop broke after the 429 (single HTTP call)', calls.length === 1, `calls=${calls.length}`);
  ok('6h. drain reports paused', d1.paused === true);

  // ── 7. paused drain does nothing; resumes after the clock passes the pause ──
  calls = [];
  sync.__setClockForTests(T0 + 30_000);
  const d2 = await sync.drainWebsiteStockOutbox(db);
  ok('7. drain skipped while paused (no HTTP)', calls.length === 0 && d2.paused === true);
  const pauseEnd = Math.max(sync.__getPauseUntilForTests(), row429.next_at * 1000) + 1000;
  sync.__setClockForTests(pauseEnd);
  // Due rows may have been bumped to pause end — force the 429 row due again.
  db.prepare('UPDATE website_stock_outbox SET next_at=? WHERE id=?').run(Math.floor(pauseEnd / 1000) - 1, r429);
  respond = okMatrix;
  const d3 = await sync.drainWebsiteStockOutbox(db);
  ok('7b. after pause window drain sends again', calls.length >= 1 && !d3.paused, `calls=${calls.length} paused=${d3.paused}`);
  ok('7c. successful row becomes done', getRow(r429).status === 'done', getRow(r429).status);

  // ── 8. other transient failures: 503 without Retry-After, timeout/no response (status 0) ──
  sync.__setClockForTests(T0);
  sync.__setPauseUntilForTests(0);
  resetOutbox();
  const r503 = Number(insRow(P, 'RETAIL', { attempts: sync.MAX_ATTEMPTS }).lastInsertRowid);
  respond = () => ({ status: 503, body: 'Service Unavailable', headers: {} });
  await sync.drainWebsiteStockOutbox(db);
  let x = getRow(r503);
  ok('8. 503 → pending, never error', x.status === 'pending' && /HTTP 503/.test(x.last_error), `${x.status} ${x.last_error}`);
  ok('8b. 503 backoff scheduled in the future', x.next_at > SEC0, `${x.next_at - SEC0}`);
  ok('8c. 503 sets the global pause', sync.__getPauseUntilForTests() > T0);

  sync.__setPauseUntilForTests(0);
  db.prepare("UPDATE website_stock_outbox SET status='pending', next_at=?, attempts=?").run(SEC0 - 1, sync.MAX_ATTEMPTS + 1);
  respond = () => ({ status: 0, body: 'OUTBOUND_TIMEOUT', reason: 'OUTBOUND_TIMEOUT' });
  await sync.drainWebsiteStockOutbox(db);
  x = getRow(r503);
  ok('8d. timeout/status 0 → pending, never error', x.status === 'pending', x.status);
  ok('8e. timeout does not set the 429 pause', sync.__getPauseUntilForTests() === 0);

  // ── 9. non-transient failure still reaches error at MAX_ATTEMPTS ──
  sync.__setPauseUntilForTests(0);
  db.prepare("UPDATE website_stock_outbox SET status='pending', next_at=?, attempts=?, last_error=''").run(SEC0 - 1, sync.MAX_ATTEMPTS - 1);
  respond = () => ({ status: 400, body: 'bad request', headers: {} });
  await sync.drainWebsiteStockOutbox(db);
  x = getRow(r503);
  ok('9. HTTP 400 at MAX_ATTEMPTS → error', x.status === 'error' && x.attempts === sync.MAX_ATTEMPTS, `${x.status} ${x.attempts}`);
  db.prepare("UPDATE website_stock_outbox SET status='pending', next_at=?, attempts=0").run(SEC0 - 1);
  await sync.drainWebsiteStockOutbox(db);
  x = getRow(r503);
  ok('9b. HTTP 400 below the cap stays pending', x.status === 'pending' && x.attempts === 1, `${x.status} ${x.attempts}`);

  // ── 10. unmatched RETAIL multi-WH: extraWhQtyOnUnmatched stored in last_result ──
  sync.__setPauseUntilForTests(0);
  resetOutbox();
  const rUn = Number(insRow(P, 'RETAIL').lastInsertRowid);
  respond = (body) => ({
    status: 200,
    headers: {},
    body: JSON.stringify({
      matched: body.variants.filter((v) => v.erpVariantSku !== 'T-5001-1').map((v) => v.erpVariantSku),
      unmatched: [{ erpVariantSku: 'T-5001-1', color: 'مشکی', size: 'M', reason: 'variant_not_matched' }],
    }),
  });
  await sync.drainWebsiteStockOutbox(db);
  x = getRow(rUn);
  const lr = JSON.parse(x.last_result || '{}');
  ok('10. unmatched → error with last_result', x.status === 'error' && lr.unmatchedCount === 1, x.status);
  ok('10b. extraWhQtyOnUnmatched = qty in warehouse B for variant1 (3)', lr.extraWhQtyOnUnmatched === 3, String(lr.extraWhQtyOnUnmatched));
  const sum = sync.summarizeOutboxRow({ ...x, product_code: 'T-5001', product_name: 'مانتو تست' });
  ok('10c. summary shows the extra-warehouse hint', /3 عدد/.test(sum.nextStep) && sum.extraWhQtyOnUnmatched === 3, sum.nextStep);
  ok('10d. unmatched is not transient (no requeue)', sum.transient === false);

  // ── 11. requeueTransientWebsiteStockErrors ──
  sync.__setClockForTests(T0);
  resetOutbox();
  const keepLr = JSON.stringify({ matched: 2, unmatched: [], marker: 'keep-me' });
  const e1 = Number(insRow(P, 'RETAIL', { status: 'error', attempts: 8, last_error: 'HTTP 429', last_result: keepLr }).lastInsertRowid);
  const e2 = Number(insRow(P, 'WHOLESALE', { status: 'error', attempts: 8, last_error: 'HTTP 503', last_result: keepLr }).lastInsertRowid);
  const e3 = Number(insRow(P2, 'RETAIL', { status: 'error', attempts: 8, last_error: 'مهلت ارتباط با API سایت تمام شد (timeout) — دوباره تلاش می‌شود', last_result: keepLr }).lastInsertRowid);
  const eBad = Number(insRow(P2, 'WHOLESALE', { status: 'error', attempts: 8, last_error: '1 رنگ/سایز از 4 در سایت هم‌خوان نشد (مشکی / M)', last_result: keepLr }).lastInsertRowid);
  const P3 = mkProduct('T-5003', 'کالای سوم');
  const e401b = Number(insRow(P3, 'RETAIL', { status: 'error', attempts: 2, last_error: 'HTTP 401' }).lastInsertRowid);
  const rq = sync.requeueTransientWebsiteStockErrors(db, {});
  ok('11. requeues exactly the 3 transient error rows', rq.requeued === 3, JSON.stringify(rq));
  for (const id of [e1, e2, e3]) {
    const r = getRow(id);
    ok(`11a. row ${id} pending, attempts 0, last_result kept`, r.status === 'pending' && r.attempts === 0 && r.last_result === keepLr);
  }
  ok('11b. unmatched-name error untouched', getRow(eBad).status === 'error');
  ok('11c. HTTP 401 error untouched', getRow(e401b).status === 'error');
  const nexts = [e1, e2, e3].map((id) => getRow(id).next_at - SEC0).sort((a, b) => a - b);
  ok('11d. staggered next_at = now+2+i*3', JSON.stringify(nexts) === '[2,5,8]', JSON.stringify(nexts));
  const rqRetail = (() => {
    db.prepare("UPDATE website_stock_outbox SET status='error' WHERE id IN (?,?,?)").run(e1, e2, e3);
    return sync.requeueTransientWebsiteStockErrors(db, { channel: 'RETAIL' });
  })();
  ok('11e. channel filter only RETAIL transient rows', rqRetail.requeued === 2 && getRow(e2).status === 'error', JSON.stringify(rqRetail));

  // ── 12. isTransientErrorText / parseRetryAfterHeader / transientBackoffSec ──
  ok('12. isTransientErrorText: HTTP 429/503/0/timeout/DNS',
    sync.isTransientErrorText('HTTP 429') && sync.isTransientErrorText('HTTP 503')
    && sync.isTransientErrorText('HTTP 0 — بدون پاسخ از سایت')
    && sync.isTransientErrorText('OUTBOUND_TIMEOUT')
    && sync.isTransientErrorText('OUTBOUND_DNS_FAILED')
    && sync.isTransientErrorText('مهلت ارتباط با API سایت تمام شد (timeout) — دوباره تلاش می‌شود'));
  ok('12b. isTransientErrorText: not for 401/403/unmatched/SKU/empty',
    !sync.isTransientErrorText('HTTP 401') && !sync.isTransientErrorText('HTTP 403')
    && !sync.isTransientErrorText('2 رنگ/سایز در سایت هم‌خوان نشد') && !sync.isTransientErrorText('کد کالا در سایت پیدا نشد')
    && !sync.isTransientErrorText('product_sku_not_found') && !sync.isTransientErrorText(''));
  ok('12c. parseRetryAfterHeader seconds + HTTP-date + missing',
    sync.parseRetryAfterHeader({ 'retry-after': '90' }, T0) === 90
    && sync.parseRetryAfterHeader({ 'Retry-After': new Date(T0 + 45_000).toUTCString() }, T0) === 45
    && sync.parseRetryAfterHeader({}, T0) === null
    && sync.parseRetryAfterHeader(null, T0) === null);
  const bo = [0, 1, 2, 9].map((a) => sync.transientBackoffSec(a));
  ok('12d. transientBackoffSec grows and is capped at 3600', bo[0] >= 12 && bo[1] > bo[0] && bo[3] <= 3600 && bo.every((n) => n >= 1), JSON.stringify(bo));

  // ── 13. enqueueFullSync staggered (not the 2s debounce) ──
  resetOutbox();
  sync.__setClockForTests(T0);
  const full = sync.enqueueFullSync(db);
  const rows = db.prepare('SELECT product_id, channel, next_at FROM website_stock_outbox ORDER BY next_at').all();
  ok('13. full sync enqueued product × channel rows', full.ok && full.enqueued === rows.length && rows.length === 2, JSON.stringify(full));
  const offs = rows.map((r) => r.next_at - SEC0);
  ok('13b. next_at = now+2+i*3', offs.every((o, i) => o === 2 + i * 3), JSON.stringify(offs));

  // ── 14. enqueueChannelResync ──
  resetOutbox();
  const rs = sync.enqueueChannelResync(db, 'RETAIL', { productIds: [P] });
  ok('14. channel resync only RETAIL + chosen product', rs.ok && rs.enqueued === 1
    && db.prepare("SELECT COUNT(*) c FROM website_stock_outbox WHERE channel='RETAIL' AND product_id=?").get(P).c === 1);
  const rsAll = sync.enqueueChannelResync(db, 'WHOLESALE');
  ok('14b. channel resync without productIds covers all eligible', rsAll.ok && rsAll.products === 1 && rsAll.enqueued === 1, JSON.stringify(rsAll));

  // ── 15. stale warehouse set ──
  resetOutbox();
  const idemOld = `erp:RETAIL:p${P}:wh${whA}:hdeadbeef0001`;      // only A (old setting)
  const idemNew = `erp:RETAIL:p${P2}:wh${whB}+${whA}:hdeadbeef0002`; // same set, other order
  insRow(P, 'RETAIL', { status: 'done', payload_hash: idemOld });
  insRow(P2, 'RETAIL', { status: 'done', payload_hash: idemNew });
  const stale = sync.staleWarehouseSetRows(db);
  ok('15. only the row sent with an older warehouse set is stale',
    stale.length === 1 && stale[0].product_id === P && stale[0].channel === 'RETAIL', JSON.stringify(stale));
  const ob = sync.outboxStatus(db);
  ok('15b. outboxStatus.stale_warehouse_set', ob.stale_warehouse_set && ob.stale_warehouse_set.count === 1
    && /هنوز با انبارهای قبلی روی سایت/.test(ob.stale_warehouse_set.message || ''), JSON.stringify(ob.stale_warehouse_set));

  // ── 16. summary messages for transient rows ──
  const hm = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tehran', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .format(new Date((SEC0 + 600) * 1000));
  const sp = sync.summarizeOutboxRow({
    id: 1, product_id: P, product_code: 'T-5001', product_name: 'x', channel: 'RETAIL', status: 'pending',
    attempts: 2, last_error: 'HTTP 429', last_result: '', next_at: SEC0 + 600,
  });
  ok('16. pending+429 → «سایت موقتاً محدود کرد — تلاش بعدی ساعت HH:MM (تهران)»',
    sp.nextStep.includes('سایت موقتاً محدود کرد — تلاش بعدی ساعت ' + hm + ' (تهران)'), sp.nextStep);
  const se = sync.summarizeOutboxRow({
    id: 2, product_id: P, product_code: 'T-5001', product_name: 'x', channel: 'RETAIL', status: 'error',
    attempts: 8, last_error: 'HTTP 429', last_result: '',
  });
  ok('16b. error+429 → stopped message + button name',
    se.nextStep.includes('تلاش‌ها متوقف شده') && se.nextStep.includes('ارسال دوبارهٔ خطاهای موقت'), se.nextStep);
  const sn = sync.summarizeOutboxRow({
    id: 3, product_id: P, product_code: 'T-5001', product_name: 'x', channel: 'RETAIL', status: 'error',
    attempts: 1, last_error: 'HTTP 401', last_result: '',
  });
  ok('16c. error+401 keeps the key message (not transient)', sn.cause === 'auth' && !sn.nextStep.includes('متوقف شده'));

  // ── 17. enqueueWebsiteStock uses the injected clock (debounce 2s) ──
  resetOutbox();
  sync.__setClockForTests(T0);
  const enq = sync.enqueueWebsiteStock(db, P, { channel: 'RETAIL' });
  const er = db.prepare("SELECT next_at FROM website_stock_outbox WHERE product_id=? AND channel='RETAIL'").get(P);
  ok('17. enqueueWebsiteStock next_at = clock + debounce', enq.ok && er.next_at === SEC0 + Math.ceil(sync.DEBOUNCE_MS / 1000), String(er && er.next_at - SEC0));

  // ── 18. ledger movement → notifyStockChanged (stubbed) ──
  const notified = [];
  const realNotify = sync.notifyStockChanged;
  sync.notifyStockChanged = (_db, pid, opts) => { notified.push({ pid, opts }); };
  try {
    const L = require('../lib/inventory/ledger');
    L.postInventoryMovement(db, {
      eventType: 'opening', productId: P2, warehouseId: whA, qtyIn: 5, unitCostRial: 1000,
      sourceType: 'test_fixture', note: 'fixture', updateAvg: false,
    });
    ok('18. postInventoryMovement notifies website sync with the warehouse',
      notified.some((n) => n.pid === P2 && n.opts && n.opts.warehouseId === whA), JSON.stringify(notified));
  } finally {
    sync.notifyStockChanged = realNotify;
  }

  // ── 19. exports present ──
  const names = ['enqueueChannelResync', 'requeueTransientWebsiteStockErrors', 'staleWarehouseSetRows',
    'retailWarehouseBreakdown', 'isTransientPushFailure', 'isTransientErrorText', 'parseRetryAfterHeader',
    'transientBackoffSec', '__setClockForTests', '__setPauseUntilForTests', '__getPauseUntilForTests'];
  ok('19. new symbols exported', names.every((n) => typeof sync[n] === 'function') && sync.MAX_ATTEMPTS === 8);
  eq('19b. MATRIX_CHUNK_GAP_MS honours env', sync.MATRIX_CHUNK_GAP_MS, 0);
} catch (e) {
  console.error(e);
  ok('unexpected exception', false, e && e.stack);
} finally {
  sync.__setClockForTests(null);
  sync.__setPauseUntilForTests(0);
  try { cleanup(); } catch (_) { /* */ }
}
summary('website-retail-stock-sum');
})();
