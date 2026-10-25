const { swAtLeast } = require('./lib/sw-at-least');
#!/usr/bin/env node
/**
 * Static invariant: Marketer checkout never offers invoice-type choice;
 * channel always seeds proforma. Server already enforces E_SALES_PROFORMA_ONLY.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'public');
const mk = fs.readFileSync(path.join(root, 'marketer-ui.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');

let failed = 0;
function ok(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    failed += 1;
  } else {
    console.log('OK:', msg);
  }
}

ok(!/name=["']mk-inv-type["']/.test(mk), 'marketer-ui: no mk-inv-type radios');
ok(!/legend>\s*نوع فاکتور/.test(mk), 'marketer-ui: no نوع فاکتور fieldset');
ok(/MARKETER_INV_TYPE\s*=\s*['"]proforma['"]/.test(mk), 'marketer-ui: MARKETER_INV_TYPE=proforma');
ok(/mkCheckout\s*=\s*\{\s*type:\s*['"]proforma['"]/.test(mk), 'marketer-ui: default checkout type proforma');
ok(/__pendingMarketerInvMeta\s*=\s*\{\s*type:\s*meta\.type/.test(mk)
  || /type:\s*meta\.type,\s*vatExempt:\s*meta\.vatExempt/.test(mk),
  'marketer-ui: meta seeded from lockedCheckoutMeta');
ok(/mkProformaLockNote/.test(mk), 'marketer-ui: proforma lock note shown');
ok(/marketer-ui-v270/.test(mk), 'marketer-ui version marker v270');

ok(/fromMarketerCart/.test(app), 'app.js: fromMarketerCart channel flag');
ok(/forceProformaNew/.test(app), 'app.js: forceProformaNew');
ok(/_invForceProformaNew/.test(app), 'app.js: save-time force flag');
ok(/forceProformaSave/.test(app), 'app.js: saveInvoice forces proforma');
ok(/همیشه <b>پیش‌فاکتور<\/b>/.test(app) || /همیشه <b>پیش‌فاکتور<\/b> ثبت می‌شود/.test(app)
  || /از فروش بازاریاب همیشه/.test(app),
  'app.js: help text updated for marketer proforma-only');

ok(/marketer-ui\.js\?v=270/.test(html), 'index.html: marketer-ui ?v=270');
ok(/app\.js\?v=270/.test(html), 'index.html: app.js ?v=270');
ok(swAtLeast(sw, 270), 'sw.js: cache v270');

if (failed) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log('\nAll marketer proforma-lock assertions passed');
process.exit(0);
