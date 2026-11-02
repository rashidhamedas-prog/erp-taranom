'use strict';
/**
 * P8a item1 — کالای 333: ابطال ۱۰ ردیف افتتاحیه/هم‌ترازی بی‌سند
 * پیش‌فرض: dry-run روی کپی موقت (DB مبدأ فقط readonly) → reports/prodcycle-p8/p8a-item1-p333-legacy-kardex.csv
 *   node server/scripts/p8a-item1-p333-legacy-kardex.js [--db=PATH] [--out=DIR] [--date=1405/08/11]
 * اجرا (فقط با تأیید مالک):  --apply --i-have-approval --reason="..."
 * بازگردانی R13:             --undo=<audit_id> --i-have-approval --reason="..."
 */
const { runItem } = require('./lib/p8a-common');
const { item1 } = require('./lib/p8a-items');

runItem(item1).then((r) => {
  console.log(JSON.stringify({ mode: r.mode, csv: r.csvFile, audit_id: r.auditId, gl: r.res.gl, kardex: r.res.kardex, result: r.result }, null, 2));
}).catch((e) => {
  console.error('FAILED:', e.code || '', e.message);
  process.exit(1);
});