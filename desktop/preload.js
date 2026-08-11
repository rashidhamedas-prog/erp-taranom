'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const UPDATE_STATUSES = new Set([
  'idle',
  'checking',
  'uptodate',
  'available-fallback',
  'downloading',
  'ready',
  'installing',
  'error'
]);

function boundedString(value, maxLength) {
  return typeof value === 'string' ? value.slice(0, maxLength) : null;
}

function sanitizeUpdateState(value) {
  const state = value && typeof value === 'object' ? value : {};
  const status = UPDATE_STATUSES.has(state.status) ? state.status : 'error';
  return Object.freeze({
    status,
    currentVersion: boundedString(state.currentVersion, 64),
    latestVersion: boundedString(state.latestVersion, 64),
    percent: Number.isFinite(state.percent) ? Math.max(0, Math.min(100, Math.round(state.percent))) : 0,
    error: boundedString(state.error, 500),
    code: boundedString(state.code, 100),
    fallbackUrl: boundedString(state.fallbackUrl, 4096),
    sha256: boundedString(state.sha256, 64),
    size: Number.isSafeInteger(state.size) && state.size > 0 ? state.size : null,
    installerSource: boundedString(state.installerSource, 64),
    signatureVerified: state.signatureVerified === true
  });
}

function sanitizeInstallPayload(value) {
  const payload = value && typeof value === 'object' ? value : {};
  return {
    url: boundedString(payload.url, 4096),
    sha256: boundedString(payload.sha256, 64),
    size: Number.isSafeInteger(payload.size) ? payload.size : null
  };
}

const desktopApi = Object.freeze({
  checkForUpdates: async () => sanitizeUpdateState(await ipcRenderer.invoke('desktop:check-update')),
  installUpdate: payload => ipcRenderer.invoke('desktop:install-update', sanitizeInstallPayload(payload)),
  getUpdateStatus: async () => sanitizeUpdateState(await ipcRenderer.invoke('desktop:get-update-status')),
  onUpdateStatus: callback => {
    if (typeof callback !== 'function') throw new TypeError('Update listener must be a function');
    const listener = (_event, state) => callback(sanitizeUpdateState(state));
    ipcRenderer.on('desktop:update-status', listener);
    return () => ipcRenderer.removeListener('desktop:update-status', listener);
  }
});

contextBridge.exposeInMainWorld('desktopAPI', desktopApi);
