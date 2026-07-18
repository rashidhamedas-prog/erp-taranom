const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopAPI', {
  checkForUpdates: () => ipcRenderer.invoke('desktop:check-update'),
  installUpdate: () => ipcRenderer.invoke('desktop:install-update'),
  getUpdateStatus: () => ipcRenderer.invoke('desktop:get-update-status'),
  onUpdateStatus: (cb) => {
    ipcRenderer.on('desktop:update-status', (_e, state) => cb(state));
  }
});
