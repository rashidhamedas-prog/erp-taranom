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

// bindings() only looks under build/Release/, but our cross-compile script
// ships per-ABI binaries under prebuilt/android/<abi>/ — copy the right one
// at runtime so SQLite can open on every device architecture.
function ensureBetterSqlite3Native() {
  const archToAbi = { arm64: 'arm64-v8a', arm: 'armeabi-v7a', x64: 'x86_64' };
  const abi = archToAbi[process.arch];
  if (!abi) return;
  const src = path.join(__dirname, 'node_modules', 'better-sqlite3', 'prebuilt', 'android', abi, 'better_sqlite3.node');
  if (!fs.existsSync(src)) return;
  const destDir = path.join(__dirname, 'node_modules', 'better-sqlite3', 'build', 'Release');
  const dest = path.join(destDir, 'better_sqlite3.node');
  fs.mkdirSync(destDir, { recursive: true });
  try {
    const same = fs.existsSync(dest)
      && fs.statSync(dest).size === fs.statSync(src).size
      && fs.statSync(dest).mtimeMs >= fs.statSync(src).mtimeMs;
    if (!same) fs.copyFileSync(src, dest);
  } catch {
    fs.copyFileSync(src, dest);
  }
}
ensureBetterSqlite3Native();

function getOrCreateSecret(dir) {
  const f = path.join(dir, 'jwt-secret');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  const s = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(f, s);
  return s;
}

process.env.SYNC_ROLE = 'device';
process.env.APP_PLATFORM = 'android';
process.env.APP_VERSION = '2.0.6';
process.env.PORT = port;
process.env.DB_PATH = path.join(dataDir, 'crm.db');
process.env.UPLOADS_DIR = path.join(dataDir, 'uploads');
process.env.JWT_SECRET = getOrCreateSecret(dataDir);

require(path.join(__dirname, 'server', 'server.js'));
