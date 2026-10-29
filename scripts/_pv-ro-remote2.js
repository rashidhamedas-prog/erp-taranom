#!/usr/bin/env node
'use strict';
const Database = require('better-sqlite3');
const DB = process.env.PV_DB || '/home/taranom/crm-taranom/server/crm.db';
const db = new Database(DB, { readonly: true, fileMustExist: true });
const LEDGER_LIVE = `
  status='posted'
  AND reversed_of IS NULL
  AND COALESCE(event_type,'') <> 'reversal'
  AND COALESCE(event_type,'') NOT GLOB '*_reversal'
`;

function q(sql, params = []) {
  try { return db.prepare(sql).all(...params); }
  catch (e) { return [{ error: e.message, sql: sql.slice(0, 120) }]; }
}
function q1(sql, params = []) {
  try { return db.prepare(sql).get(...params) || null; }
  catch (e) { return { error: e.message }; }
}

const jlCols = q(`PRAGMA table_info(journal_lines)`).map(r => r.name);
const jeCols = q(`PRAGMA table_info(journal_entries)`).map(r => r.name);

const out = { jlCols, jeCols };

// money columns may be debit/credit or debit_rial/credit_rial
const debitCol = jlCols.includes('debit_rial') ? 'debit_rial' : (jlCols.includes('debit') ? 'debit' : null);
const creditCol = jlCols.includes('credit_rial') ? 'credit_rial' : (jlCols.includes('credit') ? 'credit' : null);
out.moneyCols = { debitCol, creditCol };

if (debitCol && creditCol) {
  out['13_bal_1104'] = q1(`SELECT SUM(${debitCol})-SUM(${creditCol}) AS bal_1104
    FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id
    WHERE l.account_code LIKE '1104%'
      AND IFNULL(e.deleted_at,'')=''
      AND COALESCE(e.status,'posted')='posted'`);
  out['13_bal_1104_exact'] = q1(`SELECT SUM(${debitCol})-SUM(${creditCol}) AS bal
    FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id
    WHERE l.account_code='1104'
      AND IFNULL(e.deleted_at,'')=''
      AND COALESCE(e.status,'posted')='posted'`);
}

out['13_kardex_wh'] = q(`
  SELECT warehouse_id,
    SUM(CASE WHEN qty_out>0 THEN -amount_rial ELSE amount_rial END) AS signed_amt,
    SUM(qty_in-qty_out) AS qty,
    COUNT(*) AS n
  FROM inventory_ledger
  WHERE warehouse_id IN (34,35) AND ${LEDGER_LIVE}
  GROUP BY warehouse_id
`);

out['13_kardex_formula2'] = q(`
  SELECT warehouse_id, SUM(amount_rial) AS amt_raw,
    SUM(CASE WHEN IFNULL(qty_out,0)>0 THEN -ABS(amount_rial) ELSE ABS(amount_rial) END) AS signed_abs
  FROM inventory_ledger
  WHERE warehouse_id IN (34,35) AND ${LEDGER_LIVE}
  GROUP BY warehouse_id
`);

// transfer zero-in pairs for wh35
out['14_zero_in_types'] = q(`
  SELECT event_type, source_type, COUNT(*) n, SUM(amount_rial) amt
  FROM inventory_ledger
  WHERE warehouse_id=35 AND IFNULL(amount_rial,0)=0 AND IFNULL(qty_in,0)>0 AND ${LEDGER_LIVE}
  GROUP BY event_type, source_type ORDER BY n DESC
`);

out['14_transfer_pairs'] = q1(`
  WITH outs AS (
    SELECT source_type, source_id, amount_rial AS out_amt
    FROM inventory_ledger
    WHERE ${LEDGER_LIVE}
      AND IFNULL(qty_out,0)>0
      AND (event_type LIKE '%transfer%' OR source_type LIKE '%transfer%' OR event_type LIKE '%xfer%')
  ),
  ins AS (
    SELECT source_type, source_id, warehouse_id, amount_rial AS in_amt, qty_in
    FROM inventory_ledger
    WHERE ${LEDGER_LIVE}
      AND IFNULL(qty_in,0)>0
      AND (event_type LIKE '%transfer%' OR source_type LIKE '%transfer%' OR event_type LIKE '%xfer%')
  )
  SELECT COUNT(*) AS pairs,
    SUM(CASE WHEN i.warehouse_id=35 AND IFNULL(i.in_amt,0)=0 THEN 1 ELSE 0 END) AS zero_in_wh35,
    SUM(CASE WHEN i.warehouse_id=35 AND IFNULL(i.in_amt,0)=0 THEN o.out_amt ELSE 0 END) AS effect_out_amt
  FROM outs o
  JOIN ins i ON i.source_type=o.source_type AND i.source_id=o.source_id
`);

out['15_return_null_wh'] = q1(`
  SELECT COUNT(*) AS n, IFNULL(SUM(amount_rial),0) AS amt,
    GROUP_CONCAT(DISTINCT je_id) AS je_ids
  FROM inventory_ledger
  WHERE warehouse_id IS NULL AND ${LEDGER_LIVE}
    AND (event_type LIKE '%return%' OR event_type LIKE '%sales_return%' OR event_type LIKE '%invoice_return%')
`);
out['15_any_null_wh'] = q(`
  SELECT event_type, COUNT(*) n, SUM(amount_rial) amt
  FROM inventory_ledger
  WHERE warehouse_id IS NULL AND ${LEDGER_LIVE}
  GROUP BY event_type ORDER BY n DESC LIMIT 20
`);

out['16_adjust_live_no_je'] = q(`
  SELECT id,product_id,warehouse_id,amount_rial,event_type,status,je_id
  FROM inventory_ledger
  WHERE event_type LIKE '%adjust%' AND je_id IS NULL AND ${LEDGER_LIVE}
  ORDER BY id
`);

out['18_ledger_1977'] = q1(`SELECT * FROM inventory_ledger WHERE id=1977`);
out['18_ledger_1230'] = q1(`SELECT id,product_id,warehouse_id,amount_rial,event_type,je_id,status FROM inventory_ledger WHERE id=1230`);
out['18_n3201'] = q1(`SELECT COUNT(*) AS n FROM journal_lines WHERE account_code='3201'`);
out['18_je_490'] = q(`SELECT * FROM journal_lines WHERE entry_id=490 LIMIT 20`);

out['11_missing_codes'] = {
  has_110402: !!q1(`SELECT 1 AS x FROM chart_of_accounts WHERE code='110402'`),
  has_110403: !!q1(`SELECT 1 AS x FROM chart_of_accounts WHERE code='110403'`),
};

console.log(JSON.stringify(out, null, 2));
