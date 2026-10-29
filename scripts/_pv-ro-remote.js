#!/usr/bin/env node
'use strict';
const Database = require('better-sqlite3');
const DB = process.env.PV_DB || '/home/taranom/crm-taranom/server/data/crm.db';
const db = new Database(DB, { readonly: true, fileMustExist: true });

function q(sql, params = []) {
  try { return db.prepare(sql).all(...params); }
  catch (e) { return [{ error: e.message, sql: sql.slice(0, 100) }]; }
}
function q1(sql, params = []) {
  try { return db.prepare(sql).get(...params) || null; }
  catch (e) { return { error: e.message }; }
}

const out = {};

out['10_settings_sep'] = q(`SELECT key,value FROM settings
  WHERE key LIKE 'coa_%' AND (value LIKE '%,%' OR value LIKE '%٬%' OR value LIKE '% %')`);
out['10_wh_non_digit'] = q(`SELECT id,inventory_coa_code,cogs_coa_code FROM warehouses
  WHERE IFNULL(inventory_coa_code,'') GLOB '*[^0-9]*'
     OR IFNULL(cogs_coa_code,'') GLOB '*[^0-9]*'`);

out['11_accounts'] = q(`SELECT code,name,is_active,
  (SELECT COUNT(*) FROM journal_lines l WHERE l.account_code=c.code) AS n
  FROM chart_of_accounts c
  WHERE code IN ('1104','110401','110402','110403','1110','1111','3102','3201','5101','610801','1201')
  ORDER BY code`);

out['12_warehouses'] = q(`SELECT id,name,active,kind,warehouse_type,inventory_system,allow_negative,
  inventory_coa_code,cogs_coa_code FROM warehouses WHERE id BETWEEN 33 AND 37 ORDER BY id`);

out['9_settings'] = q(`SELECT key,value FROM settings WHERE key IN
  ('vat_rate','coa_vat_payable','coa_vat_receivable','ledger_leaf_enforcement','coa_product_tafsili_mode')
  ORDER BY key`);
out['7_roles'] = q(`SELECT role, COUNT(*) AS n FROM users WHERE active=1 GROUP BY role ORDER BY role`);

out['13_bal_1104'] = q1(`SELECT SUM(debit_rial)-SUM(credit_rial) AS bal_1104
  FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id
  WHERE l.account_code LIKE '1104%' AND e.deleted_at IS NULL
    AND COALESCE(e.status,'posted')='posted'`);

out['4_ledger_cols'] = q(`PRAGMA table_info(inventory_ledger)`).map(r => r.name);

out['16_adjust_no_je'] = q(`SELECT id,product_id,warehouse_id,amount_rial,event_type,status
  FROM inventory_ledger
  WHERE event_type LIKE '%adjust%' AND je_id IS NULL AND IFNULL(status,'')<>'void'
  ORDER BY id`);

out['15_return_null_wh'] = q1(`SELECT COUNT(*) AS n, IFNULL(SUM(amount_rial),0) AS amt
  FROM inventory_ledger
  WHERE (event_type LIKE '%return%' OR event_type LIKE '%sales_return%')
    AND warehouse_id IS NULL AND IFNULL(status,'')<>'void'`);
out['15_return_sample'] = q(`SELECT id,product_id,warehouse_id,amount_rial,je_id,event_type
  FROM inventory_ledger
  WHERE (event_type LIKE '%return%' OR event_type LIKE '%sales_return%')
    AND warehouse_id IS NULL AND IFNULL(status,'')<>'void'
  ORDER BY id LIMIT 40`);

out['18_ledger_1977'] = q1(`SELECT id,product_id,warehouse_id,qty_in,qty_out,amount_rial,event_type,je_id,status
  FROM inventory_ledger WHERE id=1977`);
out['18_n3201'] = q1(`SELECT COUNT(*) AS n FROM journal_lines WHERE account_code='3201'`);
out['18_je_490'] = q(`SELECT id,entry_id,account_code,debit_rial,credit_rial FROM journal_lines WHERE entry_id=490`);
out['18_ledger_1230'] = q1(`SELECT id,product_id,warehouse_id,amount_rial,event_type FROM inventory_ledger WHERE id=1230`);

out['14_zero_in_wh35'] = q1(`SELECT COUNT(*) AS n FROM inventory_ledger
  WHERE warehouse_id=35 AND IFNULL(amount_rial,0)=0 AND IFNULL(qty_in,0)>0
    AND IFNULL(status,'')<>'void'`);

out['14_event_types_sample'] = q(`SELECT event_type, COUNT(*) n FROM inventory_ledger
  WHERE warehouse_id IN (34,35) GROUP BY event_type ORDER BY n DESC LIMIT 30`);

console.log(JSON.stringify(out, null, 2));
