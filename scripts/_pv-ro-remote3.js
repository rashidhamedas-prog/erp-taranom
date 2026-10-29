#!/usr/bin/env node
'use strict';
const Database = require('better-sqlite3');
const db = new Database(process.env.PV_DB || './crm.db', { readonly: true, fileMustExist: true });

const samples = db.prepare(`SELECT account_code, debit, credit, debit_rial, credit_rial
  FROM journal_lines WHERE account_code LIKE '1104%' LIMIT 5`).all();
const cnt = db.prepare(`SELECT COUNT(*) c FROM journal_lines WHERE account_code LIKE '1104%'`).get();
const cntExact = db.prepare(`SELECT COUNT(*) c FROM journal_lines WHERE account_code='1104'`).get();
const statuses = db.prepare(`SELECT COALESCE(e.status,'(null)') st, COUNT(*) c
  FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id
  WHERE l.account_code LIKE '1104%' GROUP BY 1`).all();
const deleted = db.prepare(`SELECT COUNT(*) c FROM journal_entries e
  JOIN journal_lines l ON l.entry_id=e.id
  WHERE l.account_code LIKE '1104%' AND e.deleted_at IS NOT NULL`).get();

const balDebit = db.prepare(`SELECT
  SUM(COALESCE(debit_rial, ROUND(debit*10))) - SUM(COALESCE(credit_rial, ROUND(credit*10))) AS bal_coalesce,
  SUM(debit_rial) AS sum_dr_rial, SUM(credit_rial) AS sum_cr_rial,
  SUM(debit) AS sum_dr, SUM(credit) AS sum_cr
  FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id
  WHERE l.account_code LIKE '1104%'
    AND e.deleted_at IS NULL
    AND COALESCE(e.status,'posted')='posted'`).get();

const balDebitToman = db.prepare(`SELECT
  SUM(debit)-SUM(credit) AS bal_toman,
  (SUM(debit)-SUM(credit))*10 AS bal_rial_x10
  FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id
  WHERE l.account_code LIKE '1104%'
    AND e.deleted_at IS NULL
    AND COALESCE(e.status,'posted')='posted'`).get();

const bal1104only = db.prepare(`SELECT
  SUM(debit)-SUM(credit) AS bal_toman,
  SUM(COALESCE(debit_rial,0))-SUM(COALESCE(credit_rial,0)) AS bal_rial
  FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id
  WHERE l.account_code='1104'
    AND e.deleted_at IS NULL
    AND COALESCE(e.status,'posted')='posted'`).get();

console.log(JSON.stringify({ samples, cnt, cntExact, statuses, deleted, balDebit, balDebitToman, bal1104only }, null, 2));
