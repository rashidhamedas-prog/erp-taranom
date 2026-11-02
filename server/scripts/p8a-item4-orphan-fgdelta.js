'use strict';
/**
 * P8a item4 — ابطال JEهای یتیم fg_delta (PO-0010/PO-0012)
 * پیش‌فرض: dry-run روی کپی موقت (DB مبدأ فقط readonly) → reports/prodcycle-p8/p8a-item4-orphan-fgdelta.csv
 *   node server/scripts/p8a-item4-orphan-fgdelta.js [--db=PATH] [--out=DIR] [--date=1405/08/11]
 * اجرا (فقط با تأیید مالک):  --apply --i-have-approval --reason="..."
 * بازگردانی R13:             --undo=<audit_id> --i-have-approval --reason="..."
 */
const { runItem } = require('./lib/p8a-common');
const { item4 } = require('./lib/p8a-items');

runItem(item4).then((r) => {
  console.log(JSON.stringify({ mode: r.mode, csv: r.csvFile, audit_id: r.auditId, gl: r.res.gl, kardex: r.res.kardex, result: r.result }, null, 2));
}).catch((e) => {
  console.error('FAILED:', e.code || '', e.message);
  process.exit(1);
});