const { initDB, getDB } = require('../db');
initDB();
const db = getDB();
console.log('parties', db.prepare('SELECT COUNT(*) c FROM parties').get());
console.log('coa5101', db.prepare("SELECT code FROM chart_of_accounts WHERE code='5101'").get());
console.log('coa3201', db.prepare("SELECT code FROM chart_of_accounts WHERE code='3201'").get());
const { runIntegrityCheck } = require('../lib/integrity-check');
console.log('integrity', runIntegrityCheck(db).passed);
