// ERP Taranom — Android embedded-backend bootstrap.
// CRITICAL: never call process.exit() — it terminates the whole Android app process.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const dataDir = process.argv[2];
const port = process.argv[3] || '3210';
const nativeLibDir = process.argv[4] || '';
const bootLog = path.join(dataDir, 'boot.log');
const readyFile = path.join(dataDir, 'server.ready');
const failFile = path.join(dataDir, 'server.fail');

function logBoot(msg) {
  try {
    fs.appendFileSync(bootLog, `[${new Date().toISOString()}] ${msg}\n`);
  } catch { /* ignore */ }
  console.log(msg);
}

function writeFail(msg) {
  try {
    fs.writeFileSync(failFile, String(msg || 'boot failed'), 'utf8');
  } catch { /* ignore */ }
}

// Hosted inside Android — process.exit() would kill the whole app UI.
process.exit = (code) => {
  const msg = `blocked process.exit(${code}) on Android embed`;
  logBoot(`WARN ${msg}`);
  writeFail(msg);
};

// Prefer the JNI-packaged lib (pageSizeCompat / extracted under nativeLibraryDir),
// then fall back to assets prebuilt copies.
function ensureBetterSqlite3Native() {
  const destDir = path.join(__dirname, 'node_modules', 'better-sqlite3', 'build', 'Release');
  const dest = path.join(destDir, 'better_sqlite3.node');
  fs.mkdirSync(destDir, { recursive: true });

  // #region agent log
  function agentLog(hypothesisId, message, data) {
    const payload = {
      sessionId: 'e9970c',
      runId: 'android-boot',
      hypothesisId,
      location: 'main.js:ensureBetterSqlite3Native',
      message,
      data: data || {},
      timestamp: Date.now(),
    };
    try { logBoot('DBG ' + JSON.stringify(payload)); } catch { /* ignore */ }
    try {
      fetch('http://127.0.0.1:7289/ingest/f0bd7efb-e01b-4c84-91db-1073bbd1ced1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': 'e9970c' },
        body: JSON.stringify(payload),
      }).catch(() => {});
    } catch { /* ignore */ }
  }
  function fileMeta(p) {
    try {
      if (!p || !fs.existsSync(p)) return { path: p || null, exists: false };
      const st = fs.statSync(p);
      const fd = fs.openSync(p, 'r');
      const buf = Buffer.alloc(Math.min(st.size, 64 * 1024));
      fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      const sha = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
      const magic = buf.slice(0, 4).toString('hex');
      // ELF DT_NEEDED scan (best-effort): look for ASCII "libnode.so"
      const asStr = buf.toString('binary');
      return {
        path: p,
        exists: true,
        size: st.size,
        magic,
        sha256_64k: sha,
        mentions_libnode: asStr.indexOf('libnode.so') >= 0,
      };
    } catch (e) {
      return { path: p, exists: false, err: String(e && e.message || e) };
    }
  }
  // #endregion

  const jniCandidates = [];
  if (nativeLibDir) {
    jniCandidates.push(path.join(nativeLibDir, 'libbetter_sqlite3.so'));
    jniCandidates.push(path.join(nativeLibDir, 'better_sqlite3.node'));
  }

  // #region agent log
  let nativeLibListing = [];
  try {
    if (nativeLibDir && fs.existsSync(nativeLibDir)) {
      nativeLibListing = fs.readdirSync(nativeLibDir).filter((n) => /node|sqlite|c\+\+/i.test(n));
    }
  } catch { /* ignore */ }
  agentLog('B', 'boot native inventory', {
    arch: process.arch,
    node: process.version,
    modules: process.versions && process.versions.modules,
    nativeLibDir: nativeLibDir || null,
    nativeLibListing,
    jniMetas: jniCandidates.map(fileMeta),
  });
  // #endregion

  for (const p of jniCandidates) {
    if (p && fs.existsSync(p)) {
      fs.copyFileSync(p, dest);
      // #region agent log
      agentLog('B', 'picked JNI better_sqlite3', { source: fileMeta(p), dest: fileMeta(dest) });
      // #endregion
      logBoot(`better-sqlite3 ready: JNI ${p} (${fs.statSync(dest).size} bytes)`);
      return;
    }
  }

  const archToAbi = {
    arm64: 'arm64-v8a',
    arm: 'armeabi-v7a',
    ia32: 'armeabi-v7a',
    x64: 'x86_64',
  };
  const abi = archToAbi[process.arch];
  const prebuiltRoot = path.join(__dirname, 'node_modules', 'better-sqlite3', 'prebuilt', 'android');
  const candidates = abi ? [abi] : [];
  for (const name of ['arm64-v8a', 'armeabi-v7a', 'x86_64']) {
    if (!candidates.includes(name)) candidates.push(name);
  }
  let src = null;
  let pickedAbi = null;
  for (const name of candidates) {
    const p = path.join(prebuiltRoot, name, 'better_sqlite3.node');
    if (fs.existsSync(p)) { src = p; pickedAbi = name; break; }
  }
  if (!src) {
    throw new Error(`better_sqlite3 native module missing (arch=${process.arch}, tried ${candidates.join(', ')})`);
  }
  fs.copyFileSync(src, dest);
  // #region agent log
  agentLog('B', 'picked assets better_sqlite3', {
    pickedAbi,
    source: fileMeta(src),
    dest: fileMeta(dest),
  });
  // #endregion
  logBoot(`better-sqlite3 ready: assets ${pickedAbi} via arch=${process.arch} (${fs.statSync(dest).size} bytes)`);
}

process.on('uncaughtException', (err) => {
  const msg = err && err.stack ? err.stack : String(err);
  logBoot(`FATAL uncaughtException: ${msg}`);
  writeFail(msg);
  // Do NOT process.exit — that kills the Android host process.
});

process.on('unhandledRejection', (reason) => {
  const msg = reason && reason.stack ? reason.stack : String(reason);
  logBoot(`FATAL unhandledRejection: ${msg}`);
  writeFail(msg);
});

try {
  try { fs.unlinkSync(readyFile); } catch { /* first boot */ }
  try { fs.unlinkSync(failFile); } catch { /* first boot */ }
  logBoot(`boot start arch=${process.arch} node=${process.version} nativeLibDir=${nativeLibDir || '(none)'}`);
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
  process.env.APP_VERSION = '2.0.13';
  process.env.PORT = port;
  process.env.LISTEN_HOST = '127.0.0.1';
  process.env.DB_PATH = path.join(dataDir, 'crm.db');
  process.env.UPLOADS_DIR = path.join(dataDir, 'uploads');
  process.env.JWT_SECRET = getOrCreateSecret(dataDir);

  // #region agent log
  (function probeSqliteMeta() {
    const dest = path.join(__dirname, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
    const jniSo = nativeLibDir ? path.join(nativeLibDir, 'libbetter_sqlite3.so') : null;
    function meta(p) {
      try {
        if (!p || !fs.existsSync(p)) return { path: p || null, exists: false };
        const st = fs.statSync(p);
        const buf = Buffer.alloc(Math.min(st.size, 64 * 1024));
        const fd = fs.openSync(p, 'r');
        fs.readSync(fd, buf, 0, buf.length, 0);
        fs.closeSync(fd);
        return {
          path: p,
          exists: true,
          size: st.size,
          mentions_libnode: buf.toString('binary').indexOf('libnode.so') >= 0,
        };
      } catch (e) {
        return { path: p, err: String(e && e.message || e) };
      }
    }
    const payload = {
      sessionId: 'e9970c',
      runId: 'android-boot',
      hypothesisId: 'A',
      location: 'main.js:probeSqliteMeta',
      message: 'pre-require better_sqlite3 metas (no dlopen probe)',
      data: {
        node: process.version,
        modules: process.versions && process.versions.modules,
        dest: meta(dest),
        jniSo: meta(jniSo),
      },
      timestamp: Date.now(),
    };
    try { logBoot('DBG ' + JSON.stringify(payload)); } catch { /* ignore */ }
    try {
      fetch('http://127.0.0.1:7289/ingest/f0bd7efb-e01b-4c84-91db-1073bbd1ced1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': 'e9970c' },
        body: JSON.stringify(payload),
      }).catch(() => {});
    } catch { /* ignore */ }
  })();
  // #endregion

  try {
    require(path.join(__dirname, 'server', 'server.js'));
    // #region agent log
    try {
      const okPayload = {
        sessionId: 'e9970c',
        runId: 'android-boot',
        hypothesisId: 'A',
        location: 'main.js:afterRequire',
        message: 'server.js require OK',
        data: { appVersion: process.env.APP_VERSION },
        timestamp: Date.now(),
      };
      logBoot('DBG ' + JSON.stringify(okPayload));
      fetch('http://127.0.0.1:7289/ingest/f0bd7efb-e01b-4c84-91db-1073bbd1ced1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': 'e9970c' },
        body: JSON.stringify(okPayload),
      }).catch(() => {});
    } catch { /* ignore */ }
    // #endregion
    logBoot('server.js loaded');
  } catch (reqErr) {
    throw reqErr;
  }
} catch (err) {
  const msg = err && err.stack ? err.stack : String(err);
  // #region agent log
  try {
    const payload = {
      sessionId: 'e9970c',
      runId: 'android-boot',
      hypothesisId: 'A',
      location: 'main.js:catch',
      message: 'FATAL boot catch',
      data: {
        errHead: String(msg).slice(0, 400),
        handleScopeMissing: /HandleScope/i.test(String(msg)),
        modules: process.versions && process.versions.modules,
        node: process.version,
      },
      timestamp: Date.now(),
    };
    logBoot('DBG ' + JSON.stringify(payload));
    fetch('http://127.0.0.1:7289/ingest/f0bd7efb-e01b-4c84-91db-1073bbd1ced1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': 'e9970c' },
      body: JSON.stringify(payload),
    }).catch(() => {});
  } catch { /* ignore */ }
  // #endregion
  logBoot(`FATAL boot: ${msg}`);
  writeFail(msg);
  // Keep the event loop alive briefly so Java can read server.fail / boot.log
  // instead of the whole Android process disappearing via process.exit().
  setInterval(() => {}, 60 * 60 * 1000);
}
