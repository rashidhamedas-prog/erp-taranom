// Quick checks for legacy central URL migration + resetPairing recovery.
const path = require('path');
const fs = require('fs');
const os = require('os');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-repair-'));
process.env.DB_PATH = path.join(dir, 't.db');
process.env.SYNC_ROLE = 'device';
process.env.JWT_SECRET = 'test';

const { initDB, getDB } = require('../db');
initDB();
const client = require('../sync/client');
const db = getDB();

function ok(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exit(1);
  }
  console.log('OK:', msg);
}

db.prepare('INSERT INTO sync_local_kv (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
  .run('central_url', 'http://45.90.98.99:3000');
db.prepare('INSERT INTO sync_local_kv (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
  .run('device_id', '7');
db.prepare('INSERT INTO sync_local_kv (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
  .run('device_token', 'tok');

ok(client.isPaired(db), 'paired before migrate');
const cfg = client.getConfig(db);
ok(cfg.centralUrl === client.CANONICAL_CENTRAL_URL, 'legacy URL migrated to canonical');
ok(client.isPaired(db), 'still paired after migrate');

const reset = client.resetPairing();
ok(reset.ok, 'resetPairing ok');
ok(!client.isPaired(db), 'unpaired after reset');
const admin = db.prepare("SELECT username, role FROM users WHERE username='admin'").get();
ok(admin && admin.role === 'admin', 'placeholder admin restored');
const cust = db.prepare('SELECT COUNT(*) c FROM customers').get().c;
ok(cust === 0, 'customers wiped');

console.log('ALL PASS');
process.exit(0);
