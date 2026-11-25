const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('sondraAd', {
  isDesktopApp: true,
  pickFolder: (title) => ipcRenderer.invoke('sondra-ad:pick-folder', title),
  openFolder: (dirPath) => ipcRenderer.invoke('sondra-ad:open-folder', dirPath),
  hideToTray: () => ipcRenderer.invoke('sondra-ad:hide-to-tray'),
  getAutostartState: () => ipcRenderer.invoke('sondra-ad:get-autostart'),
  setAutostartState: (enabled) => ipcRenderer.invoke('sondra-ad:set-autostart', enabled),
  getUpdateState: () => ipcRenderer.invoke('sondra-ad:get-update-state'),
  checkForUpdates: () => ipcRenderer.invoke('sondra-ad:check-updates'),
  installUpdate: () => ipcRenderer.invoke('sondra-ad:install-update'),
  onUpdateState: (cb) => {
    const handler = (_event, state) => cb(state)
    ipcRenderer.on('sondra-ad:update-state', handler)
    return () => ipcRenderer.removeListener('sondra-ad:update-state', handler)
  },
})
