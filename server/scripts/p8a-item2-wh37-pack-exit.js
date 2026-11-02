'use strict';
/**
 * P8a item2 — WH37: خروج بسته‌های WIP به بهای متناسب بسته
 * پیش‌فرض: dry-run روی کپی موقت (DB مبدأ فقط readonly) → reports/prodcycle-p8/p8a-item2-wh37-pack-exit.csv
 *   node server/scripts/p8a-item2-wh37-pack-exit.js [--db=PATH] [--out=DIR] [--date=1405/08/11]
 * اجرا (فقط با تأیید مالک):  --apply --i-have-approval --reason="..."
 * بازگردانی R13:             --undo=<audit_id> --i-have-approval --reason="..."
 */
const { runItem } = require('./lib/p8a-common');
const { item2 } = require('./lib/p8a-items');

runItem(item2).then((r) => {
  console.log(JSON.stringify({ mode: r.mode, csv: r.csvFile, audit_id: r.auditId, gl: r.res.gl, kardex: r.res.kardex, result: r.result }, null, 2));
}).catch((e) => {
  console.error('FAILED:', e.code || '', e.message);
  process.exit(1);
});