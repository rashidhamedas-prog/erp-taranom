'use strict';
const { initDB, getDB } = require('../db');
initDB();
const db = getDB();
const t42 = db.prepare(`
  SELECT id,num,type,converted,vat_exempt,subtotal,disc,disc_amt,final,final_rial,
         vat_amount,vat_amount_rial,pay_type,pay_amount_rial,settled_amount,balance_due
  FROM invoices WHERE num='T-0042'
`).get();
console.log('T-0042', JSON.stringify(t42));
const cand = db.prepare(`
  SELECT COUNT(*) AS c FROM invoices
  WHERE COALESCE(converted,0)=1 AND COALESCE(vat_exempt,0)=1
    AND COALESCE(deleted_at,0)=0
    AND (COALESCE(vat_amount,0)>0 OR COALESCE(vat_amount_rial,0)>0)
`).get();
console.log('vat_exempt_with_vat', cand);
const near = db.prepare(`
  SELECT num,final,final_rial,vat_exempt,vat_amount,disc_amt,subtotal,converted
  FROM invoices
  WHERE COALESCE(converted,0)=1
    AND ABS(COALESCE(final_rial,final) - ROUND((COALESCE(subtotal,0)-COALESCE(disc_amt,0))*1.1)) < 50
  ORDER BY id DESC LIMIT 10
`).all();
console.log('near_11pct', JSON.stringify(near));
