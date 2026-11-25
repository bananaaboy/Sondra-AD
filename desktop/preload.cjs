const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('sondraAd', {
  isDesktopApp: true,
  pickFolder: (title) => ipcRenderer.invoke('sondra-ad:pick-folder', title),
  openFolder: (dirPath) => ipcRenderer.invoke('sondra-ad:open-folder', dirPath),
  hideToTray: () => ipcRenderer.invoke('sondra-ad:hide-to-tray'),
  getAutostartState: () => ipcRenderer.invoke('sondra-ad:get-autostart'),
  setAutostartState: (enabled) => ipcRenderer.invoke('sondra-ad:set-autostart', enabled),
})
