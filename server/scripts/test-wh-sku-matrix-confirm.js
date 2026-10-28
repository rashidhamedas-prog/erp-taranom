'use strict';
/**
 * v579 Phase 0 — warehouse SKU matrix confirm (receipt / issue / transfer).
 * Bug: whConfirmSkuMatrix read #modalRoot (parent form) instead of #nestedModalRoot → «هیچ تعدادی وارد نشده».
 * Dependency-free (no jsdom): functions are extracted from public/app.js and run in a vm with a minimal fake DOM.
 * Run: node server/scripts/test-wh-sku-matrix-confirm.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK  ', label); }
  else { fail += 1; console.log('  FAIL', label, extra == null ? '' : extra); }
}

const appJs = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');

function extractFn(name) {
  const m = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(').exec(appJs);
  if (!m) throw new Error('function not found: ' + name);
  const start = m.index;
  let i = appJs.indexOf('{', appJs.indexOf(')', start));
  let depth = 0;
  for (; i < appJs.length; i++) {
    const c = appJs[i];
    if (c === '{') depth += 1;
    else if (c === '}') { depth -= 1; if (depth === 0) return appJs.slice(start, i + 1); }
  }
  throw new Error('unbalanced: ' + name);
}

console.log('\n══ warehouse SKU matrix confirm (v579 / Phase 0) ══\n');

// ── static guards ──
const confirmSrc = extractFn('whConfirmSkuMatrix');
ok(!/el\('nestedModal'\)/.test(confirmSrc), 'no el(nestedModal) (nonexistent id)');
ok(!/modalRoot'\)/.test(confirmSrc.replace(/nestedModalRoot/g, '')) && !/el\('modalRoot'\)/.test(confirmSrc),
  'whConfirmSkuMatrix never falls back to #modalRoot');
ok(/nestedModalRoot/.test(confirmSrc) && /data-wh-matrix/.test(confirmSrc), 'confirm queries nested root + data-wh-matrix table');
const openSrc = extractFn('openWhSkuMatrixModal');
ok(/data-wh-matrix="\$\{matrixToken\}"/.test(openSrc), 'open modal stamps data-wh-matrix token on table');
ok(/type="text" inputmode="decimal"[^`]*class="wh-sku-qty"/.test(openSrc), 'matrix inputs are type=text inputmode=decimal');
ok(!/type="number"[^`]*wh-sku-qty/.test(openSrc), 'no type=number matrix inputs');

// ── fake DOM ──
function parseInputs(html) {
  const out = [];
  const re = /<input\b([^>]*class="wh-sku-qty"[^>]*)>/g;
  let m;
  while ((m = re.exec(html))) {
    const attrs = {};
    m[1].replace(/([\w-]+)="([^"]*)"/g, (_, k, v) => { attrs[k] = v; return ''; });
    out.push({
      value: '',
      attrs,
      getAttribute(k) { return Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null; },
    });
  }
  return out;
}

function makeEnv(opts) {
  opts = opts || {};
  const state = {
    toasts: [],
    nestedHtml: '',
    nestedInputs: [],
    closed: 0,
    rendered: 0,
    packCalls: [],
    whDocLines: [{ product_id: '', qty: 1 }],
    wh: opts.wh == null ? 5 : opts.wh,
    allowNeg: !!opts.allowNeg,
    mayNeg: !!opts.mayNeg,
  };
  const parentForm = {
    // parent form (#modalRoot) — contains NO matrix inputs (they live in #nestedModalRoot)
    querySelectorAll() { return []; },
    querySelector() { return null; },
  };
  const nestedRoot = {
    querySelector(sel) {
      const m = /data-wh-matrix(?:="([^"]*)")?/.exec(sel);
      if (!m || !state.nestedHtml) return null;
      if (m[1] != null && state.nestedHtml.indexOf('data-wh-matrix="' + m[1] + '"') < 0) return null;
      if (m[1] == null && state.nestedHtml.indexOf('data-wh-matrix="') < 0) return null;
      return { querySelectorAll() { return state.nestedInputs; } };
    },
  };
  const doc = {
    getElementById(id) {
      if (id === 'nestedModalRoot') return nestedRoot;
      if (id === 'modalRoot') return parentForm;
      return null;
    },
  };
  const ctx = {
    document: doc,
    el: (id) => doc.getElementById(id),
    console,
    Number, String, Math, Date, isFinite, Object, Array, Promise,
    CSP: { bind() { return 'b'; }, style() { return 's'; } },
    esc: (s) => String(s == null ? '' : s),
    fmt: (n) => String(n),
    fmtQtyFa: (n) => String(n),
    variantAttrsLabel: (c, s) => [c, s].filter(Boolean).join(' '),
    showToast: (m, t) => state.toasts.push({ m, t: t || 'success' }),
    whDocLines: state.whDocLines,
    whDocType: opts.dtype || 'receipt',
    whLineWarehouseId: () => state.wh,
    whWarehouseAllowsNegative: () => state.allowNeg,
    whUserMayNegative: () => state.mayNeg,
    openNestedModal: (html) => { state.nestedHtml = html; state.nestedInputs = parseInputs(html); },
    closeNestedModal: () => { state.closed += 1; state.nestedHtml = ''; state.nestedInputs = []; },
    renderWhDocLines: () => { state.rendered += 1; },
    resolveServerModalPack: async (id, wh) => { state.packCalls.push([id, wh]); return { has_matrix: true, matrix: [] }; },
  };
  vm.createContext(ctx);
  ['whParseQtyInput', 'whConfirmSkuMatrix', 'openWhSkuMatrixModal', 'whPickProduct'].forEach((n) => {
    vm.runInContext(extractFn(n), ctx);
  });
  return { ctx, state };
}

const MATRIX = [
  { variant_id: 101, color_id: 1, color_name: 'مشکی', size_id: 1, size_name: 'س1', sku_stock: 3 },
  { variant_id: 102, color_id: 1, color_name: 'مشکی', size_id: 2, size_name: 'س2', sku_stock: 0 },
  { variant_id: 103, color_id: 2, color_name: 'سرمه‌ای', size_id: 1, size_name: 'س1', sku_stock: 2 },
];

function openMatrix(env, dtype, lineIndex) {
  env.ctx.whDocType = dtype;
  env.ctx.openWhSkuMatrixModal({
    lineIndex: lineIndex || 0, productId: 131, productLabel: 'بارونی مموری 110',
    warehouseId: env.state.wh, docType: dtype, pack: { has_matrix: true, matrix: MATRIX },
  });
}
function clickConfirm(env) {
  // Re-invoke exactly what the confirm button would call (token read back from rendered table).
  const tok = /data-wh-matrix="([^"]+)"/.exec(env.state.nestedHtml);
  env.ctx.whConfirmSkuMatrix(0, 131, 'بارونی مموری 110', tok && tok[1], env.ctx.whDocType, env.state.wh);
}
function setQty(env, vid, v) {
  const inp = env.state.nestedInputs.find((i) => String(i.attrs['data-vid']) === String(vid));
  if (!inp) throw new Error('input not found vid=' + vid);
  inp.value = v;
}

(async () => {
  // ── whParseQtyInput (pure) ──
  const { ctx: pctx } = makeEnv();
  const P = pctx.whParseQtyInput;
  ok(P('1') === 1, "parse '1' → 1");
  ok(P('۱') === 1, "parse FA '۱' → 1");
  ok(P('١') === 1, "parse AR '١' → 1");
  ok(P('1٫5') === 1.5, "parse '1٫5' → 1.5");
  ok(P('۱٫۵') === 1.5, "parse FA '۱٫۵' → 1.5");
  ok(P('2,5') === 2.5, "parse '2,5' → 2.5");
  ok(P(' ۱۲ ') === 12, 'parse spaces trimmed → 12');
  ok(P('1٬000') === 1000, 'parse thousand sep ٬ stripped → 1000');
  ok(P('') === 0 && P(null) === 0 && P(undefined) === 0, 'empty/null → 0');
  ok(P('abc') === 0 && P('1a') === 0 && P('-3') === 0 && P('.') === 0, 'invalid/negative → 0');

  // ── receipt: parent form open, nested matrix, enter 1 in مشکی/س1 ──
  {
    const env = makeEnv({ dtype: 'receipt' });
    openMatrix(env, 'receipt');
    ok(env.state.nestedInputs.length === 3, 'receipt: 3 inputs rendered (all cells active)');
    setQty(env, 101, '1');
    clickConfirm(env);
    ok(!env.state.toasts.some((t) => t.m === 'هیچ تعدادی وارد نشده'), 'receipt: no «هیچ تعدادی وارد نشده» toast');
    ok(env.state.whDocLines.length === 1 && env.state.whDocLines[0].variant_id === 101
      && env.state.whDocLines[0].qty === 1 && env.state.whDocLines[0].product_id === 131,
      'receipt: line spliced with correct variant_id/qty', JSON.stringify(env.state.whDocLines));
    ok(env.state.whDocLines[0].color_id === 1 && env.state.whDocLines[0].size_id === 1, 'receipt: color/size ids kept');
    ok(env.state.closed === 1 && env.state.rendered === 1, 'receipt: nested modal closed + lines re-rendered');
  }

  // ── receipt with FA / AR / decimal ──
  {
    const env = makeEnv({ dtype: 'receipt' });
    openMatrix(env, 'receipt');
    setQty(env, 101, '۱');
    setQty(env, 102, '١');
    setQty(env, 103, '1٫5');
    clickConfirm(env);
    const q = env.state.whDocLines.map((l) => [l.variant_id, l.qty]);
    ok(JSON.stringify(q) === JSON.stringify([[101, 1], [102, 1], [103, 1.5]]), 'receipt FA/AR/decimal digits parsed', JSON.stringify(q));
  }

  // ── regression: nothing entered → old toast, modal stays ──
  {
    const env = makeEnv({ dtype: 'receipt' });
    openMatrix(env, 'receipt');
    clickConfirm(env);
    ok(env.state.toasts.some((t) => t.m === 'هیچ تعدادی وارد نشده' && t.t === 'error'), 'regression: empty input → toast');
    ok(env.state.closed === 0 && env.state.rendered === 0 && env.state.whDocLines[0].product_id === '', 'regression: empty input → no change, modal stays open');
  }

  // ── missing nested root/table → explicit error, never parent form ──
  {
    const env = makeEnv({ dtype: 'receipt' });
    env.ctx.whConfirmSkuMatrix(0, 131, 'x', 'wm-nope', 'receipt', 5);
    ok(env.state.toasts.some((t) => /پیدا نشد/.test(t.m)), 'missing matrix table → explicit error toast');
    ok(!env.state.toasts.some((t) => t.m === 'هیچ تعدادی وارد نشده'), 'missing matrix table → not the misleading empty toast');
    ok(env.state.closed === 0, 'missing matrix table → no close');
  }

  // ── issue: normal + qty > stock blocked without negative permission ──
  {
    const env = makeEnv({ dtype: 'issue' });
    openMatrix(env, 'issue');
    ok(env.state.nestedInputs.length === 2, 'issue: out-of-stock cell (stock 0) has no input without negative permission');
    setQty(env, 101, '2');
    setQty(env, 103, '1');
    clickConfirm(env);
    ok(env.state.whDocLines.length === 2 && env.state.whDocLines[0].variant_id === 101 && env.state.whDocLines[0].qty === 2,
      'issue: valid lines added', JSON.stringify(env.state.whDocLines));
    ok(env.state.closed === 1 && env.state.rendered === 1, 'issue: closed + rendered');
  }
  {
    const env = makeEnv({ dtype: 'issue' });
    openMatrix(env, 'issue');
    setQty(env, 101, '4'); // stock 3
    clickConfirm(env);
    ok(env.state.toasts.some((t) => /بیشتر از موجودی/.test(t.m) && t.t === 'error'), 'issue: qty>stock → toast');
    ok(env.state.whDocLines.length === 1 && env.state.whDocLines[0].product_id === '' && env.state.closed === 0, 'issue: qty>stock → nothing added, modal open');
  }
  {
    const env = makeEnv({ dtype: 'issue', allowNeg: true, mayNeg: true });
    openMatrix(env, 'issue');
    setQty(env, 101, '4');
    clickConfirm(env);
    ok(env.state.whDocLines.length === 1 && env.state.whDocLines[0].qty === 4, 'issue: qty>stock allowed with warehouse+user negative permission');
  }

  // ── transfer ──
  {
    const env = makeEnv({ dtype: 'transfer' });
    openMatrix(env, 'transfer');
    setQty(env, 103, '۲');
    clickConfirm(env);
    ok(env.state.whDocLines.length === 1 && env.state.whDocLines[0].variant_id === 103 && env.state.whDocLines[0].qty === 2,
      'transfer: line added (FA digit)', JSON.stringify(env.state.whDocLines));
    ok(env.state.closed === 1 && env.state.rendered === 1, 'transfer: closed + rendered');
  }
  {
    const env = makeEnv({ dtype: 'transfer' });
    openMatrix(env, 'transfer');
    setQty(env, 103, '3'); // stock 2
    clickConfirm(env);
    ok(env.state.toasts.some((t) => /بیشتر از موجودی/.test(t.m)) && env.state.closed === 0 && env.state.whDocLines[0].product_id === '',
      'transfer: qty>stock blocked');
  }

  // ── warehouse guard: no warehouse → matrix never opens, pack never resolved ──
  {
    const env = makeEnv({ dtype: 'receipt', wh: 0 });
    env.ctx.whDocLines[0] = { product_id: '', qty: 1 };
    await env.ctx.whPickProduct(0, 131, 'بارونی مموری 110', 3, 'receipt');
    ok(env.state.packCalls.length === 0, 'no warehouse: resolveServerModalPack not called');
    ok(env.state.nestedHtml === '', 'no warehouse: matrix modal not opened');
    ok(env.state.toasts.some((t) => t.m === 'ابتدا انبار را انتخاب کنید'), 'no warehouse: toast «ابتدا انبار را انتخاب کنید»');
  }
  {
    const env = makeEnv({ dtype: 'receipt', wh: 0 });
    openMatrix(env, 'receipt');
    ok(env.state.nestedHtml === '' && env.state.toasts.some((t) => t.m === 'ابتدا انبار را انتخاب کنید'),
      'no warehouse: openWhSkuMatrixModal itself refuses');
  }
  {
    const env = makeEnv({ dtype: 'receipt', wh: 5 });
    await env.ctx.whPickProduct(0, 131, 'x', 3, 'receipt');
    ok(env.state.packCalls.length === 1 && env.state.packCalls[0][1] === 5, 'warehouse selected: resolveServerModalPack gets warehouseId');
    ok(env.state.nestedHtml === '' && env.state.whDocLines[0].product_id === 131, 'empty matrix pack: falls through to plain product line');
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
