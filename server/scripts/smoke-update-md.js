const { initDB, getDB } = require('../db');
initDB();
const db = getDB();
const tables = ['product_images', 'user_catalog_categories', 'sms_templates', 'sms_options', 'sms_scheduled', 'marketer_carts'];
for (const t of tables) {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
  console.log(t, row ? 'OK' : 'MISSING');
}
const col = db.prepare("PRAGMA table_info(party_groups)").all().some(c => c.name === 'is_marketer');
console.log('party_groups.is_marketer', col ? 'OK' : 'MISSING');
console.log('sms seed', db.prepare('SELECT COUNT(*) c FROM sms_templates').get().c);
