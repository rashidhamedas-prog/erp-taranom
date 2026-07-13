// CRM Taranom — Android embedded-backend bootstrap.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const dataDir = process.argv[2];
const port = process.argv[3] || '3210';
const bootLog = path.join(dataDir, 'boot.log');

function logBoot(msg) {
  try {
    fs.appendFileSync(bootLog, `[${new Date().toISOString()}] ${msg}\n`);
  } catch { /* ignore */ }
  console.log(msg);
}

// bindings() only looks under build/Release/, but cross-compiled binaries live
// under prebuilt/android/<abi>/ — copy the correct one before opening SQLite.
function ensureBetterSqlite3Native() {
  const archToAbi = { arm64: 'arm64-v8a', arm: 'armeabi-v7a', x64: 'x86_64' };
  const abi = archToAbi[process.arch];
  if (!abi) {
    logBoot(`better-sqlite3: unknown process.arch=${process.arch}`);
    return;
  }
  const src = path.join(__dirname, 'node_modules', 'better-sqlite3', 'prebuilt', 'android', abi, 'better_sqlite3.node');
  if (!fs.existsSync(src)) {
    throw new Error(`better_sqlite3 native module missing for ${abi} at ${src}`);
  }
  const destDir = path.join(__dirname, 'node_modules', 'better-sqlite3', 'build', 'Release');
  const dest = path.join(destDir, 'better_sqlite3.node');
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(src, dest);
  logBoot(`better-sqlite3 ready: ${abi} (${fs.statSync(dest).size} bytes)`);
}

process.on('uncaughtException', (err) => {
  logBoot(`FATAL uncaughtException: ${err.stack || err}`);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logBoot(`FATAL unhandledRejection: ${reason}`);
  process.exit(1);
});

try {
  logBoot(`boot start arch=${process.arch} node=${process.version}`);
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
  process.env.APP_VERSION = '2.0.7';
  process.env.PORT = port;
  process.env.DB_PATH = path.join(dataDir, 'crm.db');
  process.env.UPLOADS_DIR = path.join(dataDir, 'uploads');
  process.env.JWT_SECRET = getOrCreateSecret(dataDir);

  require(path.join(__dirname, 'server', 'server.js'));
  logBoot('server.js loaded');
} catch (err) {
  logBoot(`FATAL boot: ${err.stack || err}`);
  process.exit(1);
}
