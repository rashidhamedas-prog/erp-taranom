'use strict';
/**
 * P5 — touch POS + barcode/labels. Offline test.
 * Run (Node 20/22 for better-sqlite3): node server/scripts/test-p5-touch-pos-barcode.js
 *
 * Covers: EAN-13 / Code128 generators, legacy-compatible internal EAN, variant-first barcode lookup,
 * variant barcode generation (idempotent), label layouts + CSP-safe HTML + store_retail access,
 * store_insufficient_stock_mode (warn default / block → 422), tender-split builder, static UI gates.
 */
const fs = require('fs');
const path = require('path');
const { ok, freshDb, summary } = require('./lib/test-harness');
const BG = require('../lib/barcode-gen');

console.log('\n══ P5 touch POS + barcode ══\n');

(async () => {
  // ── 1) pure generators ────────────────────────────────────────────────────
  console.log('— 1) EAN-13 / Code128 —');
  ok('EAN-13 check digit of 400638133393 is 1', BG.ean13CheckDigit('400638133393') === 1);
  ok('isValidEan13(4006381333931)', BG.isValidEan13('4006381333931'));
  ok('isValidEan13 rejects bad check digit', !BG.isValidEan13('4006381333932'));
  ok('isValidEan13 rejects non-13-digit', !BG.isValidEan13('12345') && !BG.isValidEan13('ABCDEFGHIJKLM'));
  const legacy = (id) => { const b = '20' + String(id).padStart(10, '0'); return b + BG.ean13CheckDigit(b); };
  ok('internalEan13(20, 5) equals legacy product format', BG.internalEan13('20', 5) === legacy(5), BG.internalEan13('20', 5));
  ok('internalEan13 output is valid EAN-13', BG.isValidEan13(BG.internalEan13('21', 123456)));
  ok('product/variant prefixes do not overlap', BG.PRODUCT_PREFIXES.every((p) => !BG.VARIANT_PREFIXES.includes(p)));
  ok('Code128 table has 107 patterns', BG.CODE128_WIDTHS.length === 107);
  ok('Code128 patterns sum to 11 modules (stop = 13)', BG.CODE128_WIDTHS.every((w, i) => {
    const s = String(w).split('').reduce((a, d) => a + Number(d), 0);
    return i === 106 ? s === 13 : s === 11;
  }));
  const cv = BG.code128BValues('PJJ123C');
  const expectChk = (104 + 'PJJ123C'.split('').reduce((a, ch, i) => a + (ch.charCodeAt(0) - 32) * (i + 1), 0)) % 103;
  ok('Code128-B checksum = (104 + Σ i·v) mod 103', cv.checksum === expectChk, `${cv.checksum} vs ${expectChk}`);
  ok('Code128-B values end with checksum + stop(106)', cv.values[cv.values.length - 1] === 106 && cv.values[cv.values.length - 2] === expectChk);
  const svgE = BG.barcodeSvg('4006381333931', 'auto');
  const svgC = BG.barcodeSvg('SKU-ABC-12', 'auto');
  ok('auto symbology: valid EAN → EAN-13 SVG', /<svg/.test(svgE) && /data-symbology="ean13"/.test(svgE), svgE.slice(0, 120));
  ok('auto symbology: non-EAN text → Code128 SVG', /<svg/.test(svgC) && /data-symbology="code128"/.test(svgC), svgC.slice(0, 120));
  ok('SVG has no inline style attribute', !/style=/.test(svgE + svgC));

  // ── 2) DB + HTTP via real routers ─────────────────────────────────────────
  console.log('— 2) HTTP: by-barcode / labels / variant barcode / store stock mode —');
  const { db, cleanup } = freshDb();
  for (const [id, username, role] of [[201, 'p5_cashier', 'store_retail'], [202, 'p5_acc', 'accounting']]) {
    db.prepare('INSERT OR IGNORE INTO users (id, username, password, name, role, active) VALUES (?,?,?,?,?,1)')
      .run(id, username, 'x', username, role);
  }
  const adminRow = db.prepare("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1").get();
  const adminId = adminRow ? adminRow.id : 1;
  db.prepare('UPDATE users SET must_change_password=0').run();

  const express = require('express');
  const http = require('http');
  const { issueStaffSession } = require('../lib/auth-sessions');
  const tokenFor = (uid, tag) => issueStaffSession(db, db.prepare('SELECT * FROM users WHERE id=?').get(uid), {
    device_kind: 'test', device_name: 'p5-' + tag, device_fingerprint: 'p5-fp-' + tag,
  }).token;
  const tok = { admin: tokenFor(adminId, 'admin'), cashier: tokenFor(201, 'cashier'), acc: tokenFor(202, 'acc') };
  const app = express();
  app.use(express.json());
  app.use('/api/products', require('../routes/products'));
  app.use('/api/product-variants', require('../routes/product-variants'));
  app.use('/api/store', require('../routes/store'));
  const server = http.createServer(app);
  await new Promise((rs) => server.listen(0, '127.0.0.1', rs));
  const BASE = `http://127.0.0.1:${server.address().port}`;
  async function call(method, p, body, who = 'admin', raw = false) {
    const headers = { 'Content-Type': 'application/json' };
    if (who) headers.Authorization = 'Bearer ' + tok[who];
    const res = await fetch(BASE + p, { method, headers, body: body == null ? undefined : JSON.stringify(body) });
    if (raw) return { status: res.status, text: await res.text(), headers: res.headers };
    let json = null;
    try { json = await res.json(); } catch (_) { json = null; }
    return { status: res.status, json };
  }

  try {
    const create = await call('POST', '/api/products', {
      name: 'مانتو P5', code: 'P5-001', price: 1000, retail_price: 1500, cost: 500, unit: 'عدد',
    });
    const pid = create.json && (create.json.id || (create.json.product && create.json.product.id));
    ok('seed: product created', create.status === 200 && pid, JSON.stringify(create.json).slice(0, 200));

    const gen = await call('POST', `/api/products/${pid}/generate-barcode`);
    ok('product barcode generated (legacy-compatible EAN-13)', gen.status === 200 && gen.json.barcode === legacy(pid), JSON.stringify(gen.json));
    const gen2 = await call('POST', `/api/products/${pid}/generate-barcode`);
    ok('product generate-barcode idempotent', gen2.json && gen2.json.existed === true && gen2.json.barcode === gen.json.barcode);

    const colorId = db.prepare("INSERT INTO product_colors (code, name) VALUES ('RD','قرمز')").run().lastInsertRowid;
    const sizeId = db.prepare("INSERT INTO product_sizes (code, name) VALUES ('M','مدیوم')").run().lastInsertRowid;
    const vid = db.prepare(`INSERT INTO product_variants (product_id, color_id, size_id, sku, price_rial, active)
      VALUES (?,?,?,?,?,1)`).run(pid, colorId, sizeId, 'P5-001-RD-M', 1800).lastInsertRowid;

    const vg = await call('POST', `/api/product-variants/${vid}/generate-barcode`, null, 'acc');
    ok('variant barcode generated by accounting (variant prefix, valid EAN)',
      vg.status === 200 && BG.isValidEan13(vg.json.barcode) && BG.VARIANT_PREFIXES.includes(vg.json.barcode.slice(0, 2)), JSON.stringify(vg.json));
    const vg2 = await call('POST', `/api/product-variants/${vid}/generate-barcode`, null, 'acc');
    ok('variant generate-barcode idempotent', vg2.json && vg2.json.existed === true && vg2.json.barcode === vg.json.barcode);
    const vgC = await call('POST', `/api/product-variants/${vid}/generate-barcode`, null, 'cashier');
    ok('cashier cannot generate variant barcode (403)', vgC.status === 403, vgC.status);
    ok('variant barcode does not collide with product barcode', vg.json.barcode !== gen.json.barcode);

    const byV = await call('GET', `/api/products/by-barcode/${vg.json.barcode}`, null, 'cashier');
    ok('by-barcode: variant barcode → variant match with colour/size',
      byV.status === 200 && Number(byV.json.variant_id) === Number(vid) && byV.json.matched_by === 'variant'
        && byV.json.color_name === 'قرمز' && byV.json.size_name === 'مدیوم', JSON.stringify(byV.json).slice(0, 240));
    const byFa = await call('GET', `/api/products/by-barcode/${encodeURIComponent(vg.json.barcode.replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d]))}`, null, 'cashier');
    ok('by-barcode: Persian digits normalised', byFa.status === 200 && Number(byFa.json.variant_id) === Number(vid));
    const bySku = await call('GET', '/api/products/by-barcode/P5-001-RD-M', null, 'cashier');
    ok('by-barcode: variant SKU match', bySku.status === 200 && Number(bySku.json.variant_id) === Number(vid));
    const byP = await call('GET', `/api/products/by-barcode/${gen.json.barcode}`, null, 'cashier');
    ok('by-barcode: product barcode → product match (no variant)', byP.status === 200 && byP.json.matched_by === 'product' && !byP.json.variant_id);
    const byNo = await call('GET', '/api/products/by-barcode/9999999999999', null, 'cashier');
    ok('by-barcode: unknown → 404', byNo.status === 404, byNo.status);

    const lb = await call('GET', `/api/products/${pid}/labels?layout=40x25&count=3&variant_id=${vid}`, null, 'cashier', true);
    ok('labels: store_retail (products:view) → 200', lb.status === 200, lb.status + ' ' + lb.text.slice(0, 120));
    ok('labels: layout class + external CSS', /class="labels layout-40x25"/.test(lb.text) && lb.text.includes('/labels-print.css'));
    ok('labels: exactly 3 labels', (lb.text.match(/<div class="label">/g) || []).length === 3);
    ok('labels: colour/size + variant consumer price', lb.text.includes('قرمز / مدیوم') && lb.text.includes((1800).toLocaleString('fa-IR')));
    ok('labels: no inline style / on* handlers', !/\sstyle=/.test(lb.text) && !/\son[a-z]+=/i.test(lb.text));
    const lbA4 = await call('GET', `/api/products/${pid}/labels?layout=a4-3x8`, null, 'admin', true);
    ok('labels: A4 3×8 default count 24 + retail price', lbA4.status === 200 && (lbA4.text.match(/<div class="label">/g) || []).length === 24
      && lbA4.text.includes((1500).toLocaleString('fa-IR')));
    const lbCode = await call('GET', `/api/products/${pid}/labels?symbology=code128&count=1`, null, 'admin', true);
    ok('labels: forced Code128 symbology', /data-symbology="code128"/.test(lbCode.text));
    const lbBad = await call('GET', `/api/products/${pid}/labels?layout=zzz&count=999`, null, 'admin', true);
    ok('labels: unknown layout → 50x30, count capped at 96', /layout-50x30/.test(lbBad.text) && (lbBad.text.match(/<div class="label">/g) || []).length === 96);

    // store stock policy — P6 owns the server logic (applyInsufficientStockPolicy); P5 only reads it.
    const SQ = require('../lib/store-quick-sale');
    ok('P5 duplicate stock policy removed (P6 is SSOT)', typeof SQ.assertStoreStockPolicy === 'undefined' && typeof SQ.getStoreInsufficientStockMode === 'undefined'
      && typeof SQ.applyInsufficientStockPolicy === 'function');
    ok('stock mode default = warn', SQ.getInsufficientStockMode(db) === 'warn');
    const boot = await call('GET', '/api/store/bootstrap', null, 'admin');
    ok('bootstrap exposes insufficient_stock_mode (warn)', boot.status === 200 && boot.json.insufficient_stock_mode === 'warn', JSON.stringify(boot.json || {}).slice(0, 160));
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('store_insufficient_stock_mode','block')").run();
    const bootB = await call('GET', '/api/store/bootstrap', null, 'admin');
    ok('bootstrap exposes insufficient_stock_mode (block) → UI locks checkout', bootB.json && bootB.json.insufficient_stock_mode === 'block');
    let thrown = null;
    try { SQ.applyInsufficientStockPolicy(db, { rows: [{ product_id: pid, qty: 5 }], warehouseId: null }); } catch (e) { thrown = e; }
    ok('block mode: P6 policy throws 422 E_STORE_INSUFFICIENT_STOCK with shortages (shape the UI renders)',
      thrown && thrown.status === 422 && thrown.code === 'E_STORE_INSUFFICIENT_STOCK' && Array.isArray(thrown.shortages) && thrown.shortages.length > 0
      && thrown.shortages[0].requested != null && thrown.shortages[0].atp != null, thrown && thrown.message);
    db.prepare("DELETE FROM settings WHERE key='store_insufficient_stock_mode'").run();  } finally {
    await new Promise((rs) => server.close(rs));
  }

  // ── 3) tender split builder (extracted from app.js) ───────────────────────
  console.log('— 3) tender → pay_splits —');
  const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const a = appJs.indexOf('function storeQsBuildPaySplits(');
  const b = appJs.indexOf('function storeQsSaleRows(');
  ok('storeQsBuildPaySplits + storeQsBuildTenderSplits present before storeQsSaleRows',
    a > 0 && b > a && appJs.slice(a, b).includes('function storeQsBuildTenderSplits('));
  const toasts = [];
  // eslint-disable-next-line no-new-func
  const mk = new Function('el', 'showToast', '_storeQs', 'toEnDigits', appJs.slice(a, b) + '\nreturn storeQsBuildPaySplits;');
  const build = (state, amt) => mk(() => null, (m) => toasts.push(m), state, (s) => String(s).replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))))(amt);
  const legacyMixed = build({ payType: 'mixed', cashBoxId: 1, terminalId: 2, uiMixedCash: 300000, uiMixedCard: 600000 }, 900000);
  ok('legacy path (no tenders) unchanged: mixed 300k/600k', legacyMixed && legacyMixed.pay_splits.length === 2
    && legacyMixed.pay_splits[0].amount === 300000 && legacyMixed.pay_splits[1].amount === 600000);
  const IP = require('../lib/invoice-payments');
  const t1 = build({ cashBoxId: 1, terminalId: 2, tenders: [{ method: 'card', amount: 400, last4: '۱۲۳۴', trace: 'TR9' }, { method: 'cash', amount: 1000 }] }, 1200);
  ok('P6 contract: card 400 (+last4/trace) + cash trimmed to 800', t1 && t1.payType === 'mixed'
    && t1.pay_splits.every((s) => s.method && !s.pay_type)
    && t1.pay_splits.find((s) => s.method === 'card').amount === 400 && t1.pay_splits.find((s) => s.method === 'card').terminal_id === 2
    && t1.pay_splits.find((s) => s.method === 'card').last4 === '1234' && t1.pay_splits.find((s) => s.method === 'card').trace === 'TR9'
    && t1.pay_splits.find((s) => s.method === 'cash').amount === 800 && t1.pay_splits.find((s) => s.method === 'cash').cash_box_id === 1, JSON.stringify(t1));
  ok('splits sum equals final', t1 && t1.pay_splits.reduce((s, x) => s + x.amount, 0) === 1200);
  const t2 = build({ cashBoxId: 1, terminalId: 2, tenders: [{ method: 'card', amount: 1500 }] }, 1200);
  ok('non-cash over due rejected client-side (mirrors E_PAY_SPLIT_OVER)', t2 === null);
  const t3 = build({ cashBoxId: 1, tenders: [{ method: 'cash', amount: 500 }] }, 1200);
  ok('underpay rejected', t3 === null);
  const t4 = build({ cashBoxId: 1, tenders: [{ method: 'credit', amount: 1200 }] }, 1200);
  ok('credit only → header credit, no splits', t4 && t4.payType === 'credit' && t4.pay_splits.length === 0);
  const t5 = build({ cashBoxId: 1, terminalId: 2, tenders: [{ method: 'credit', amount: 200 }, { method: 'cash', amount: 1000 }] }, 1200);
  ok('credit + cash combined (P6) → method credit 200 + cash 1000', t5 && t5.pay_splits.length === 2
    && t5.pay_splits.find((s) => s.method === 'credit').amount === 200 && t5.pay_splits.find((s) => s.method === 'cash').amount === 1000, JSON.stringify(t5));
  const t6 = build({ cashBoxId: 1, tenders: [{ method: 'cheque', amount: 1200, sayadi: '1234-5678-9012-3456', bank: 'ملی', due: '1405/09/01', number: '3' }] }, 1200);
  ok('cheque → {method:cheque, cheque:{sayad_id,bank_name,due_date,number}}', t6 && t6.pay_splits[0].method === 'cheque'
    && t6.pay_splits[0].cheque.sayad_id === '1234567890123456' && t6.pay_splits[0].cheque.bank_name === 'ملی'
    && t6.pay_splits[0].cheque.due_date === '1405/09/01' && t6.pay_splits[0].cheque.number === '3' && !('owner' in t6.pay_splits[0].cheque));
  const t7 = build({ cashBoxId: 1, terminalId: 2, tenders: [{ method: 'card', amount: 600 }, { method: 'credit', amount: 700 }] }, 1200);
  ok('card + credit over due rejected', t7 === null);
  // Round-trip through P6 server expansion: builder output is accepted as-is.
  let rt5 = null; let rt6 = null; let rtErr = null;
  try {
    rt5 = IP.expandMethodSplits(t5.pay_splits, 1200);
    rt6 = IP.expandMethodSplits(t6.pay_splits, 1200);
  } catch (e) { rtErr = e; }
  ok('P6 expandMethodSplits accepts credit+cash (creditRial 200, cash split 1000)', !rtErr && rt5 && rt5.contract && rt5.creditRial === 200
    && rt5.splits.length === 1 && rt5.splits[0].pay_type === 'cash' && rt5.splits[0].amount === 1000, rtErr && rtErr.message);
  ok('P6 expandMethodSplits maps cheque contract fields', rt6 && rt6.splits[0].pay_type === 'cheque' && rt6.splits[0].sayadi === '1234567890123456'
    && rt6.splits[0].cheque_bank === 'ملی' && rt6.splits[0].cheque_due === '1405/09/01' && rt6.splits[0].cheque_contract === true);
  let rtPlan = null;
  try { rtPlan = IP.resolveInvoicePayments({ pay_splits: t1.pay_splits }, 1200); } catch (e) { rtErr = e; }
  ok('P6 resolveInvoicePayments accepts card+cash with trace/last4', rtPlan && rtPlan.splits.length === 2
    && rtPlan.splits.find((s) => s.pay_type === 'pos_card').last4 === '1234' && rtPlan.splits.find((s) => s.pay_type === 'pos_card').trace === 'TR9', rtErr && rtErr.message);
  ok('UI maps E_CREDIT_LIMIT / E_PAY_SPLIT_OVER / E_STORE_INSUFFICIENT_STOCK to messages',
    /function storeQsCheckoutErrorText\(/.test(appJs) && ['E_CREDIT_LIMIT', 'E_PAY_SPLIT_OVER', 'E_STORE_INSUFFICIENT_STOCK'].every((k) => appJs.includes("code==='" + k + "'")));
  ok('UI no longer blocks credit combined with other methods', !appJs.includes('ترکیب نسیه با سایر روش‌ها هنوز پشتیبانی نمی‌شود'));
  ok('quick-sale sends idempotency_key alias', appJs.includes('idempotency_key:cartIdem'));
  // ── 4) static UI / CSP / versions ─────────────────────────────────────────
  console.log('— 4) static UI gates —');
  try { new Function(appJs); ok('app.js parses', true); } catch (e) { ok('app.js parses', false, e.message); } // eslint-disable-line no-new-func
  for (const fn of ['storeQsAddTender', 'storeQsRemoveTender', 'storeQsTenderFillRemain', 'storeQsNumpad', 'storeQsRenderNumpad',
    'storeQsSettleState', 'storeQsToggleFullscreen', 'storeQsSetFullscreen', 'storeQsLeave', 'storeQsToggleTouch',
    'storeQsResetCart', 'storeQsNewInvoiceClick', 'storeQsClearCartConfirmed', 'storeQsDraftSave', 'storeQsDraftRestore',
    'storeQsAfterSuccess', 'storeQsNormQuery', 'storeQsBeep', 'storeQsArmScanAutoSubmit', 'openBarcodeLabelsDoc']) {
    ok(`app.js defines ${fn}()`, new RegExp('function ' + fn + '\\(').test(appJs));
  }
  ok('Alt+1..4 / Alt+F bound via e.code', appJs.includes('(?:Digit|Numpad)([1-4])') && appJs.includes("e.code==='KeyF'"));
  ok('scan burst threshold 50ms', /STORE_QS_SCAN_GAP_MS\s*=\s*50\b/.test(appJs));
  ok('go() leaves POS fullscreen', appJs.includes("page!=='store-quick-sale' && typeof storeQsLeave==='function'"));
  ok('network error keeps client_request_id (retry same invoice)', appJs.includes('تلاش مجدد (همان فاکتور)') && appJs.includes('client_request_id:cartIdem'));
  ok('store price regex bug fixed (no /[^\\\\d]/ in storeQs price edit)', !appJs.includes("replace(/[^\\\\d]/g,'');_storeQs.lines[idx]"));
  const p5Start = appJs.indexOf('/* ---------- P5: new invoice');
  const p5End = appJs.indexOf('function storeQsSaleRows(');
  const p5Block = appJs.slice(p5Start, p5End);
  ok('P5 helper block: no inline style= / onclick=', p5Start > 0 && !/\sstyle="/.test(p5Block) && !/\sonclick=/.test(p5Block));
  const payStart = appJs.indexOf('const payPanel=`<div class="pos-glass" id="posPayPanel">');
  const payEnd = appJs.indexOf('try{ initCustSearches(box); }catch(_){}', payStart);
  const payBlock = appJs.slice(payStart, payEnd);
  ok('pay panel + POS shell: no inline style= / on*= attributes', payStart > 0 && payEnd > payStart
    && !/\sstyle="/.test(payBlock) && !/\son(click|change|input|keydown|focus|blur)=/.test(payBlock));
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'pos-v2.css'), 'utf8');
  ok('pos-v2.css: touch + fullscreen + tender + settle styles', ['.pos-v2.pos-touch', 'body.pos-fullscreen .sidebar', '.pos-tender-grid', '.pos-numpad', '.pos-settle-status', '.pos-row-flash']
    .every((s) => css.includes(s)));
  ok('pos-v2.css: row flash ≤150ms + reduced-motion', /pos-row-flash 150ms/.test(css) && /prefers-reduced-motion[\s\S]*pos-row-flash/.test(css));
  const labelsCss = fs.readFileSync(path.join(__dirname, '..', 'public', 'labels-print.css'), 'utf8');
  ok('labels-print.css: three layouts', ['layout-40x25', 'layout-50x30', 'layout-a4-3x8'].every((s) => labelsCss.includes(s)));
  const sw = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');
  const idx = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const verAtLeast = (re, src, min) => Number((src.match(re) || [])[1] || 0) >= min;
  ok('SW cache ≥ v596', verAtLeast(/'erp-taranom-v(\d+)'/, sw, 596));
  ok('index.html assets ?v ≥ 596', verAtLeast(/app\.js\?v=(\d+)/, idx, 596) && verAtLeast(/pos-v2\.css\?v=(\d+)/, idx, 596) && verAtLeast(/acc-nav\.js\?v=(\d+)/, idx, 596));
  ok('help mentions P5 / v596 tenders + keeps P6/P8 help', appJs.includes('P5 / v596') && appJs.includes('تسویه چندروشی + کارتخوان + سقف اعتبار (v594)') && appJs.includes('P8 (v595)') && appJs.includes('store_insufficient_stock_mode'));
  const settingsJs = fs.readFileSync(path.join(__dirname, '..', 'routes', 'settings.js'), 'utf8');
  ok('settings allow-list has store_insufficient_stock_mode', settingsJs.includes("'store_insufficient_stock_mode'"));

  cleanup();
  summary('P5 touch POS + barcode');
})().catch((e) => { console.error(e); process.exit(1); });
