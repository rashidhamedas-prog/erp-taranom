#!/usr/bin/env node
// Quick sanity check after Mahak go-live (run on server: node scripts/verify-mahak-db.js)
const path = require('path');
process.env.DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'crm.db');
const { initDB, getDB } = require('../db');
initDB();
const db = getDB();
const coa = db.prepare("SELECT value FROM settings WHERE key='coa_mode'").get();
const entries = db.prepare("SELECT COUNT(*) c FROM journal_entries WHERE src_system='mahak'").get().c;
const products = db.prepare('SELECT COUNT(*) c FROM products').get().c;
const stock = db.prepare('SELECT COALESCE(SUM(stock),0) s FROM products').get().s;
const tb = db.prepare(`
  SELECT ROUND(SUM(debit)) d, ROUND(SUM(credit)) c
  FROM journal_lines jl JOIN journal_entries je ON jl.entry_id=je.id
  WHERE COALESCE(je.deleted_at,0)=0
`).get();
const ok = coa?.value === 'mahak' && entries === 1530 && tb.d === tb.c;
console.log(JSON.stringify({ coa_mode: coa?.value, mahak_entries: entries, products, stock_sum: stock, trial_balance: tb, ok }, null, 2));
process.exit(ok ? 0 : 1);
