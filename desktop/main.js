// CRM Taranom — Windows/desktop offline app.
// Runs the SAME Express/SQLite backend as the central server, embedded in
// Electron's main process with SYNC_ROLE=device: every operation works fully
// offline against a local database in the user's profile directory, and the
// built-in sync client pushes/pulls changes to the central server whenever a
// connection is available. The window simply loads the local server's URL —
// the UI is byte-identical to the web app.
const { app, BrowserWindow, shell, dialog, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');
const crypto = require('crypto');
const pkg = require('./package.json');

let mainWindow = null;
let autoUpdater = null;
let updateState = {
  status: 'idle',
  currentVersion: pkg.version || '1.0.4',
  latestVersion: null,
  percent: 0,
  error: null
};

function broadcastUpdateState() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('desktop:update-status', { ...updateState });
  }
}

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
  process.env.APP_PLATFORM = 'desktop';
  process.env.APP_VERSION = pkg.version || '1.0.4';
  process.env.PORT = String(port);
  process.env.DB_PATH = path.join(dataDir, 'crm.db');
  process.env.UPLOADS_DIR = path.join(dataDir, 'uploads');
  process.env.JWT_SECRET = getOrCreateSecret(dataDir);

  require(path.join(__dirname, 'server', 'server.js'));
  return port;
}

async function applyUpdateFeed(port) {
  if (!autoUpdater) return false;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/system/update-feed`);
    const { url } = await r.json();
    if (!url) return false;
    autoUpdater.setFeedURL({ provider: 'generic', url: url.endsWith('/') ? url : url + '/' });
    return true;
  } catch {
    return false;
  }
}

async function checkForUpdates(port) {
  if (!autoUpdater) return updateState;
  updateState.error = null;
  updateState.status = 'checking';
  broadcastUpdateState();
  if (!(await applyUpdateFeed(port))) {
    updateState.status = 'error';
    updateState.error = 'اتصال به سرور مرکزی برای بررسی به‌روزرسانی برقرار نیست';
    broadcastUpdateState();
    return updateState;
  }
  try {
    await autoUpdater.checkForUpdates();
  } catch (e) {
    updateState.status = 'error';
    updateState.error = e.message;
    broadcastUpdateState();
  }
  return updateState;
}

function setupAutoUpdate(port) {
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch {
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowDowngrade = false;

  autoUpdater.on('checking-for-update', () => {
    updateState.status = 'checking';
    updateState.error = null;
    broadcastUpdateState();
  });

  autoUpdater.on('update-not-available', () => {
    updateState.status = 'uptodate';
    updateState.latestVersion = null;
    updateState.percent = 0;
    broadcastUpdateState();
  });

  autoUpdater.on('update-available', (info) => {
    updateState.status = 'downloading';
    updateState.latestVersion = info.version;
    updateState.percent = 0;
    broadcastUpdateState();
  });

  autoUpdater.on('download-progress', (p) => {
    updateState.status = 'downloading';
    updateState.percent = Math.round(p.percent || 0);
    broadcastUpdateState();
  });

  autoUpdater.on('update-downloaded', (info) => {
    updateState.status = 'ready';
    updateState.latestVersion = info.version;
    updateState.percent = 100;
    broadcastUpdateState();
  });

  autoUpdater.on('error', (e) => {
    updateState.status = 'error';
    updateState.error = e.message;
    broadcastUpdateState();
  });

  ipcMain.handle('desktop:get-update-status', () => ({ ...updateState }));
  ipcMain.handle('desktop:check-update', () => checkForUpdates(port));
  ipcMain.handle('desktop:install-update', () => {
    if (updateState.status !== 'ready') {
      return { ok: false, error: 'به‌روزرسانی هنوز آماده نصب نیست' };
    }
    try {
      autoUpdater.quitAndInstall(false, true);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  setTimeout(() => checkForUpdates(port), 10000);
  setInterval(() => checkForUpdates(port), 60 * 60 * 1000);
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
    title: 'CRM Taranom',
    icon: path.join(__dirname, 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  const url = `http://127.0.0.1:${port}`;
  const tryLoad = (attempt) => {
    mainWindow.loadURL(url).catch(() => {
      if (attempt < 20) setTimeout(() => tryLoad(attempt + 1), 300);
    });
  };
  setTimeout(() => tryLoad(0), 300);

  setupAutoUpdate(port);

  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (target.startsWith(url)) return { action: 'allow' };
    shell.openExternal(target);
    return { action: 'deny' };
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => app.quit());
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
