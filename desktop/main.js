// CRM Taranom — Windows/desktop offline app.
// Runs the SAME Express/SQLite backend as the central server, embedded in
// Electron's main process with SYNC_ROLE=device: every operation works fully
// offline against a local database in the user's profile directory, and the
// built-in sync client pushes/pulls changes to the central server whenever a
// connection is available. The window simply loads the local server's URL —
// the UI is byte-identical to the web app.
const { app, BrowserWindow, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');
const crypto = require('crypto');

let mainWindow = null;

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

// A per-installation JWT secret so local sessions can't be forged with the
// publicly-known default. Persisted in userData alongside the database.
function getOrCreateSecret(dir) {
  const f = path.join(dir, 'jwt-secret');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  const s = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(f, s, { mode: 0o600 });
  return s;
}

async function startEmbeddedServer() {
  const dataDir = app.getPath('userData');
  fs.mkdirSync(dataDir, { recursive: true });

  const port = await getFreePort();
  process.env.SYNC_ROLE = 'device';
  process.env.PORT = String(port);
  process.env.DB_PATH = path.join(dataDir, 'crm.db');
  process.env.UPLOADS_DIR = path.join(dataDir, 'uploads');
  process.env.JWT_SECRET = getOrCreateSecret(dataDir);

  // server.js starts listening at require time
  require(path.join(__dirname, 'server', 'server.js'));
  return port;
}

async function createWindow() {
  let port;
  try {
    port = await startEmbeddedServer();
  } catch (e) {
    dialog.showErrorBox('CRM ترنم', 'خطا در راه‌اندازی سرور داخلی:\n' + e.message);
    app.quit();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: 'CRM ترنم',
    icon: path.join(__dirname, 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  // Give Express a moment to bind, then load the local app
  const url = `http://127.0.0.1:${port}`;
  const tryLoad = (attempt) => {
    mainWindow.loadURL(url).catch(() => {
      if (attempt < 20) setTimeout(() => tryLoad(attempt + 1), 300);
    });
  };
  setTimeout(() => tryLoad(0), 300);

  // External links (e.g. Instagram) open in the system browser, not the app
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (target.startsWith(url)) return { action: 'allow' }; // invoice print windows
    shell.openExternal(target);
    return { action: 'deny' };
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => app.quit());
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
