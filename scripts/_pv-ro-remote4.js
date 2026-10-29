#!/usr/bin/env node
'use strict';
const Database = require('better-sqlite3');
const db = new Database(process.env.PV_DB || './crm.db', { readonly: true, fileMustExist: true });
const LIVE = `status='posted' AND reversed_of IS NULL AND COALESCE(event_type,'') <> 'reversal' AND COALESCE(event_type,'') NOT GLOB '*_reversal'`;

const balApproved = db.prepare(`SELECT
  SUM(debit_rial)-SUM(credit_rial) AS bal_rial,
  SUM(debit)-SUM(credit) AS bal_toman
  FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id
  WHERE l.account_code LIKE '1104%'
    AND e.deleted_at IS NULL
    AND e.status='approved'`).get();

const balAnyLive = db.prepare(`SELECT
  SUM(debit_rial)-SUM(credit_rial) AS bal_rial
  FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id
  WHERE l.account_code LIKE '1104%'
    AND e.deleted_at IS NULL
    AND e.status NOT IN ('draft','void','reversed','cancelled')`).get();

const kardex = db.prepare(`SELECT warehouse_id,
  SUM(CASE WHEN IFNULL(qty_out,0)>0 THEN -amount_rial ELSE amount_rial END) AS signed_amt
  FROM inventory_ledger WHERE warehouse_id IN (34,35) AND ${LIVE}
  GROUP BY warehouse_id`).all();

const adjIds = [1978, 1979, 1273];
const adjs = db.prepare(`SELECT id,product_id,warehouse_id,amount_rial,je_id,status,event_type
  FROM inventory_ledger WHERE id IN (1978,1979,1273)`).all();

const adj1977 = db.prepare(`SELECT id,product_id,warehouse_id,amount_rial,event_type,je_id,status FROM inventory_ledger WHERE id=1977`).get();
const n3201 = db.prepare(`SELECT COUNT(*) n FROM journal_lines WHERE account_code='3201'`).get();
const je490 = db.prepare(`SELECT id,entry_id,account_code,debit_rial,credit_rial,debit,credit FROM journal_lines WHERE entry_id=490`).all();
const led1230 = db.prepare(`SELECT id,product_id,warehouse_id,amount_rial,event_type,je_id,status FROM inventory_ledger WHERE id=1230`).get();

const adjLiveNoJeSum = db.prepare(`SELECT COUNT(*) n, SUM(amount_rial) amt
  FROM inventory_ledger WHERE event_type LIKE '%adjust%' AND je_id IS NULL AND ${LIVE}`).get();

const adjTargetSum = db.prepare(`SELECT SUM(amount_rial) amt FROM inventory_ledger
  WHERE id IN (1978,1979,1273)`).get();

console.log(JSON.stringify({
  balApproved, balAnyLive, kardex,
  gap: {
    gl: balApproved && balApproved.bal_rial,
    k34: (kardex.find(x => x.warehouse_id === 34) || {}).signed_amt,
    k35: (kardex.find(x => x.warehouse_id === 35) || {}).signed_amt,
    kSum: kardex.reduce((s, x) => s + (x.signed_amt || 0), 0),
  },
  adjs, adj1977, n3201, je490, led1230, adjLiveNoJeSum, adjTargetSum,
}, null, 2));
