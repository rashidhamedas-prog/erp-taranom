// ERP Taranom — Windows/desktop offline app.
// Runs the same Express/SQLite backend as the central server, embedded in
// Electron with SYNC_ROLE=device. The renderer only loads the loopback server.
'use strict';

const { app, BrowserWindow, shell, dialog, ipcMain, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');
const { spawn } = require('child_process');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const pkg = require('./package.json');
const { getOrCreateLocalJwtSecret } = require('./local-secret-store');
const {
  isLoopbackUrl,
  isAllowedChildWindowUrl,
  isAllowedExternalUrl,
  normalizeSha256,
  normalizeUpdateSize,
  normalizePublisherNames,
  signedUpdatesRequired,
  resolveSignedUpdatesFlag,
  validateManualUpdateMetadata,
  createUpdateIntegrityVerifier,
  evaluateUpdateInstallPolicy,
  secureChildWindowOptions,
  hardenWebviewPreferences
} = require('./security-policy');

let mainWindow = null;
let autoUpdater = null;
let embeddedPort = null;
let signedUpdaterPolicyReady = false;
let manualInstallInFlight = null;
const hardenedSessions = new WeakSet();

let updateState = {
  status: 'idle',
  currentVersion: pkg.version || '1.0.4',
  latestVersion: null,
  percent: 0,
  error: null,
  fallbackUrl: null,
  sha256: null,
  size: null,
  installerSource: null,
  signatureVerified: false
};

function configureSignedUpdateDefault() {
  process.env.REQUIRE_SIGNED_UPDATES = resolveSignedUpdatesFlag(
    process.env.REQUIRE_SIGNED_UPDATES,
    { isPackaged: app.isPackaged, platform: process.platform }
  );
}

function broadcastUpdateState() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('desktop:update-status', { ...updateState });
  }
}

function resetInstallerState() {
  updateState.fallbackUrl = null;
  updateState.sha256 = null;
  updateState.size = null;
  updateState.installerSource = null;
  updateState.signatureVerified = false;
  signedUpdaterPolicyReady = false;
}

function setUpdateError(message) {
  updateState.status = 'error';
  updateState.error = message || 'Update verification failed';
  resetInstallerState();
  broadcastUpdateState();
  return { ...updateState };
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

async function startEmbeddedServer() {
  const dataDir = app.getPath('userData');
  fs.mkdirSync(dataDir, { recursive: true });

  const port = await getFreePort();
  process.env.SYNC_ROLE = 'device';
  process.env.APP_PLATFORM = 'desktop';
  process.env.APP_VERSION = pkg.version || '1.0.8';
  process.env.PORT = String(port);
  process.env.LISTEN_HOST = '127.0.0.1';
  process.env.DB_PATH = path.join(dataDir, 'crm.db');
  process.env.UPLOADS_DIR = path.join(dataDir, 'uploads');
  process.env.JWT_SECRET = getOrCreateLocalJwtSecret({
    dataDir,
    safeStorage,
    isPackaged: app.isPackaged,
    platform: process.platform
  });

  require(path.join(__dirname, 'server', 'server.js'));
  return port;
}

function trustedRenderer(event, port) {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return false;
  const senderUrl = event.senderFrame && event.senderFrame.url
    ? event.senderFrame.url
    : event.sender.getURL();
  return isLoopbackUrl(senderUrl, port);
}

function hardenSession(session) {
  if (!session || hardenedSessions.has(session)) return;
  hardenedSessions.add(session);
  session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
  if (typeof session.setDevicePermissionHandler === 'function') {
    session.setDevicePermissionHandler(() => false);
  }
}

function openAllowedExternalUrl(target) {
  if (!isAllowedExternalUrl(target)) return;
  shell.openExternal(target).catch(() => {
    // External launch failures are intentionally not retried with another scheme.
  });
}

function installWebContentsGuards(contents) {
  contents.setWindowOpenHandler(({ url: target }) => {
    if (isAllowedChildWindowUrl(target, embeddedPort)) {
      return { action: 'allow', overrideBrowserWindowOptions: secureChildWindowOptions() };
    }
    openAllowedExternalUrl(target);
    return { action: 'deny' };
  });

  const blockUntrustedNavigation = (event, target) => {
    if (!isLoopbackUrl(target, embeddedPort)) event.preventDefault();
  };
  contents.on('will-navigate', blockUntrustedNavigation);
  contents.on('will-redirect', blockUntrustedNavigation);
  contents.on('will-attach-webview', (event, webPreferences) => {
    hardenWebviewPreferences(webPreferences);
    event.preventDefault();
  });
}

app.on('web-contents-created', (_event, contents) => {
  installWebContentsGuards(contents);
});

async function applyUpdateFeed(port) {
  if (!autoUpdater) return false;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/system/update-feed`);
    if (!response.ok) return false;
    const body = await response.json();
    if (!isAllowedExternalUrl(body && body.url)) return false;
    const feedUrl = new URL(body.url);
    feedUrl.hash = '';
    feedUrl.search = '';
    if (/\/[^/]+\.ya?ml$/i.test(feedUrl.pathname)) {
      feedUrl.pathname = feedUrl.pathname.replace(/[^/]+$/, '');
    } else if (!feedUrl.pathname.endsWith('/')) {
      feedUrl.pathname += '/';
    }
    autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl.toString() });
    return true;
  } catch {
    return false;
  }
}

async function configuredPublisherNames() {
  if (!autoUpdater || !autoUpdater.configOnDisk || !autoUpdater.configOnDisk.value) return [];
  try {
    const config = await autoUpdater.configOnDisk.value;
    return normalizePublisherNames(config && config.publisherName);
  } catch {
    return [];
  }
}

async function requireSignedUpdaterConfiguration() {
  if (!signedUpdatesRequired()) return false;
  if (process.platform !== 'win32') {
    throw new Error('Signed update enforcement is only supported for the Windows installer');
  }
  if (!autoUpdater || typeof autoUpdater.verifyUpdateCodeSignature !== 'function') {
    throw new Error('The signed Windows updater verifier is unavailable');
  }
  const publishers = await configuredPublisherNames();
  if (publishers.length === 0) {
    throw new Error('The packaged updater has no trusted publisher identity');
  }
  return true;
}

async function checkUpdateViaManifest(port) {
  try {
    const current = updateState.currentVersion || pkg.version || '0';
    const response = await fetch(
      `http://127.0.0.1:${port}/api/system/app-update?platform=desktop&version=${encodeURIComponent(current)}`
    );
    if (!response.ok) throw new Error('Could not contact the update service');
    const update = await response.json();
    resetInstallerState();

    if (update.update_available) {
      const sha256 = normalizeSha256(update.sha256);
      const size = normalizeUpdateSize(update.size);
      if (!update.downloadable || !isAllowedExternalUrl(update.url) || !sha256 || !size) {
        throw new Error('The update manifest does not contain a safe downloadable installer');
      }
      updateState.status = 'available-fallback';
      updateState.latestVersion = update.latest_version;
      updateState.fallbackUrl = update.url;
      updateState.sha256 = sha256;
      updateState.size = size;
      updateState.installerSource = 'verified-manifest';
      updateState.error = null;
    } else {
      updateState.status = 'uptodate';
      updateState.latestVersion = null;
      updateState.error = null;
    }
  } catch (error) {
    return setUpdateError(error && error.message);
  }
  broadcastUpdateState();
  return { ...updateState };
}

async function checkForUpdates(port) {
  updateState.error = null;
  updateState.status = 'checking';
  resetInstallerState();
  broadcastUpdateState();

  if (!autoUpdater) {
    if (signedUpdatesRequired()) {
      return setUpdateError('Signed update enforcement is enabled, but the updater is unavailable');
    }
    return checkUpdateViaManifest(port);
  }

  if (!(await applyUpdateFeed(port))) {
    return checkUpdateViaManifest(port);
  }

  try {
    signedUpdaterPolicyReady = await requireSignedUpdaterConfiguration();
    await autoUpdater.checkForUpdates();
    return { ...updateState };
  } catch (error) {
    if (signedUpdatesRequired()) return setUpdateError(error && error.message);
    return checkUpdateViaManifest(port);
  }
}

async function fetchWithSafeRedirects(initialUrl, maxRedirects = 3) {
  let currentUrl = initialUrl;
  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    if (!isAllowedExternalUrl(currentUrl)) throw new Error('Update URL is not allowed');
    const response = await fetch(currentUrl, {
      redirect: 'manual',
      headers: { 'User-Agent': `ERP-Taranom/${pkg.version || '0'}` }
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location || redirectCount === maxRedirects) throw new Error('Unsafe or excessive update redirect');
      const nextUrl = new URL(location, currentUrl).toString();
      if (!isAllowedExternalUrl(nextUrl)) throw new Error('Update redirect left the trusted host allowlist');
      if (response.body) await response.body.cancel();
      currentUrl = nextUrl;
      continue;
    }
    if (!response.ok || !response.body) throw new Error(`Update download failed with HTTP ${response.status}`);
    return response;
  }
  throw new Error('Update redirect limit exceeded');
}

async function downloadVerifiedInstaller(metadata) {
  const updateDirectory = fs.mkdtempSync(path.join(app.getPath('temp'), 'erp-taranom-update-'));
  const partialPath = path.join(updateDirectory, 'installer.exe.partial');
  const installerPath = path.join(updateDirectory, 'installer.exe');
  let completed = false;

  try {
    const response = await fetchWithSafeRedirects(metadata.url);
    const contentLength = response.headers.get('content-length');
    if (contentLength !== null && Number(contentLength) !== metadata.size) {
      throw new Error('Update Content-Length does not match the signed manifest');
    }

    const verifier = createUpdateIntegrityVerifier(metadata.sha256, metadata.size);
    const integrityGuard = new Transform({
      transform(chunk, _encoding, callback) {
        try {
          verifier.update(chunk);
          callback(null, chunk);
        } catch (error) {
          callback(error);
        }
      }
    });
    const source = typeof response.body.pipe === 'function'
      ? response.body
      : Readable.fromWeb(response.body);
    await pipeline(source, integrityGuard, fs.createWriteStream(partialPath, { flags: 'wx', mode: 0o600 }));

    verifier.verify();
    const magic = Buffer.alloc(2);
    const descriptor = fs.openSync(partialPath, 'r');
    try { fs.readSync(descriptor, magic, 0, 2, 0); } finally { fs.closeSync(descriptor); }
    if (magic[0] !== 0x4d || magic[1] !== 0x5a) throw new Error('Downloaded update is not a Windows executable');

    fs.renameSync(partialPath, installerPath);
    completed = true;
    return { installerPath, updateDirectory };
  } finally {
    if (!completed) {
      try { fs.rmSync(updateDirectory, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
}

async function verifyManualInstallerSignature(installerPath) {
  if (process.platform !== 'win32') throw new Error('Windows signature verification is unavailable');
  if (!autoUpdater || typeof autoUpdater.verifyUpdateCodeSignature !== 'function') {
    throw new Error('Windows signature verifier is unavailable');
  }
  const publishers = await configuredPublisherNames();
  if (publishers.length === 0) throw new Error('No trusted update publisher is configured');
  const verificationError = await autoUpdater.verifyUpdateCodeSignature(publishers, installerPath);
  if (verificationError !== null) throw new Error('The downloaded installer signature is not trusted');
}

function launchInstaller(installerPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(installerPath, [], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      shell: false
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

async function installManifestUpdate(payload) {
  if (manualInstallInFlight) return manualInstallInFlight;
  const expected = {
    url: updateState.fallbackUrl,
    sha256: updateState.sha256,
    size: updateState.size
  };
  const metadataResult = validateManualUpdateMetadata(payload, expected);
  if (!metadataResult.ok) {
    return { ok: false, error: 'Update metadata changed; run update check again', code: metadataResult.code };
  }

  manualInstallInFlight = (async () => {
    updateState.status = 'downloading';
    updateState.percent = 0;
    updateState.error = null;
    broadcastUpdateState();
    let downloaded;
    try {
      downloaded = await downloadVerifiedInstaller(metadataResult.value);
      if (signedUpdatesRequired()) await verifyManualInstallerSignature(downloaded.installerPath);
      updateState.status = 'installing';
      updateState.percent = 100;
      updateState.signatureVerified = signedUpdatesRequired();
      broadcastUpdateState();
      await launchInstaller(downloaded.installerPath);
      setTimeout(() => app.quit(), 500);
      return { ok: true };
    } catch (error) {
      if (downloaded && downloaded.updateDirectory) {
        try { fs.rmSync(downloaded.updateDirectory, { recursive: true, force: true }); } catch { /* best effort */ }
      }
      setUpdateError(error && error.message);
      return { ok: false, error: updateState.error, code: 'E_UPDATE_INSTALL_FAILED' };
    } finally {
      manualInstallInFlight = null;
    }
  })();
  return manualInstallInFlight;
}

async function installUpdate(payload) {
  const policy = evaluateUpdateInstallPolicy({
    state: updateState,
    updaterAvailable: !!autoUpdater,
    requireSigned: signedUpdatesRequired()
  });
  if (!policy.ok) {
    return { ok: false, error: 'Update is not ready for a verified install', code: policy.code };
  }
  if (policy.mode === 'verified-manifest') return installManifestUpdate(payload);

  try {
    autoUpdater.quitAndInstall(false, true);
    return { ok: true };
  } catch {
    return { ok: false, error: 'The verified updater could not start', code: 'E_UPDATE_LAUNCH' };
  }
}

function registerUpdateIpc(port) {
  ipcMain.removeHandler('desktop:get-update-status');
  ipcMain.removeHandler('desktop:check-update');
  ipcMain.removeHandler('desktop:install-update');
  ipcMain.handle('desktop:get-update-status', event => (
    trustedRenderer(event, port)
      ? { ...updateState }
      : { status: 'error', error: 'Untrusted renderer', code: 'E_IPC_ORIGIN' }
  ));
  ipcMain.handle('desktop:check-update', event => (
    trustedRenderer(event, port)
      ? checkForUpdates(port)
      : { status: 'error', error: 'Untrusted renderer', code: 'E_IPC_ORIGIN' }
  ));
  ipcMain.handle('desktop:install-update', (event, payload) => (
    trustedRenderer(event, port)
      ? installUpdate(payload)
      : { ok: false, error: 'Untrusted renderer', code: 'E_IPC_ORIGIN' }
  ));
}

function setupAutoUpdate(port) {
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch {
    autoUpdater = null;
  }

  registerUpdateIpc(port);
  if (!autoUpdater) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowDowngrade = false;
  autoUpdater.disableWebInstaller = true;

  autoUpdater.on('checking-for-update', () => {
    updateState.status = 'checking';
    updateState.error = null;
    broadcastUpdateState();
  });

  autoUpdater.on('update-not-available', () => {
    updateState.status = 'uptodate';
    updateState.latestVersion = null;
    updateState.percent = 0;
    resetInstallerState();
    broadcastUpdateState();
  });

  autoUpdater.on('update-available', info => {
    updateState.status = 'downloading';
    updateState.latestVersion = info.version;
    updateState.percent = 0;
    updateState.installerSource = 'electron-updater';
    broadcastUpdateState();
  });

  autoUpdater.on('download-progress', progress => {
    updateState.status = 'downloading';
    updateState.percent = Math.round(progress.percent || 0);
    updateState.transferred = progress.transferred || 0;
    updateState.total = progress.total || 0;
    updateState.bps = progress.bytesPerSecond || 0;
    broadcastUpdateState();
  });

  autoUpdater.on('update-downloaded', info => {
    updateState.status = 'ready';
    updateState.latestVersion = info.version;
    updateState.percent = 100;
    updateState.installerSource = 'electron-updater';
    updateState.signatureVerified = signedUpdatesRequired() && signedUpdaterPolicyReady;
    broadcastUpdateState();
  });

  autoUpdater.on('error', () => {
    setUpdateError('The automatic updater failed verification or download');
  });

  const firstCheckTimer = setTimeout(() => checkForUpdates(port), 10000);
  const intervalTimer = setInterval(() => checkForUpdates(port), 60 * 60 * 1000);
  if (typeof firstCheckTimer.unref === 'function') firstCheckTimer.unref();
  if (typeof intervalTimer.unref === 'function') intervalTimer.unref();
}

async function createWindow() {
  let port;
  try {
    port = await startEmbeddedServer();
    embeddedPort = port;
  } catch (error) {
    dialog.showErrorBox('ERP ترنم', `خطا در راه‌اندازی سرور داخلی:\n${error.message}`);
    app.quit();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: 'ERP Taranom',
    icon: path.join(__dirname, 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: false,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  hardenSession(mainWindow.webContents.session);

  const localUrl = `http://127.0.0.1:${port}`;
  const tryLoad = attempt => {
    mainWindow.loadURL(localUrl).catch(() => {
      if (attempt < 20) setTimeout(() => tryLoad(attempt + 1), 300);
    });
  };
  setTimeout(() => tryLoad(0), 300);

  setupAutoUpdate(port);

  mainWindow.on('close', event => {
    if (mainWindow._forceClose) return;
    event.preventDefault();
    dialog.showMessageBox(mainWindow, {
      type: 'question',
      buttons: ['خیر', 'بله'],
      defaultId: 0,
      cancelId: 0,
      title: 'ERP ترنم',
      message: 'آیا مطمئن هستید که می‌خواهید از برنامه خارج شوید؟'
    }).then(({ response }) => {
      if (response === 1) {
        mainWindow._forceClose = true;
        mainWindow.close();
      }
    });
  });
}

app.whenReady().then(() => {
  try {
    configureSignedUpdateDefault();
    return createWindow();
  } catch (error) {
    dialog.showErrorBox('ERP ترنم', `تنظیمات امنیتی به‌روزرسانی معتبر نیست:\n${error.message}`);
    app.quit();
    return null;
  }
});

app.on('window-all-closed', () => app.quit());
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

process.on('uncaughtException', error => {
  const message = error && error.stack ? error.stack : String(error);
  console.error('FATAL uncaughtException:', message);
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      dialog.showErrorBox('ERP ترنم', 'خطای داخلی غیرمنتظره رخ داد.');
    }
  } catch { /* ignore UI failure on fatal path */ }
});

process.on('unhandledRejection', reason => {
  const message = reason && reason.stack ? reason.stack : String(reason);
  console.error('FATAL unhandledRejection:', message);
});
