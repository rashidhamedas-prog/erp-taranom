// CRM Taranom — Android embedded-backend bootstrap.
// Started by MainActivity via nodejs-mobile with:
//   argv[2] = writable data directory (Android app files dir)
//   argv[3] = local port
// Runs the same server as central/desktop with SYNC_ROLE=device.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const dataDir = process.argv[2];
const port = process.argv[3] || '3210';

function getOrCreateSecret(dir) {
  const f = path.join(dir, 'jwt-secret');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  const s = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(f, s);
  return s;
}

process.env.SYNC_ROLE = 'device';
process.env.APP_PLATFORM = 'android';
process.env.APP_VERSION = '2.0.4';
process.env.PORT = port;
process.env.DB_PATH = path.join(dataDir, 'crm.db');
process.env.UPLOADS_DIR = path.join(dataDir, 'uploads');
process.env.JWT_SECRET = getOrCreateSecret(dataDir);

require(path.join(__dirname, 'server', 'server.js'));
