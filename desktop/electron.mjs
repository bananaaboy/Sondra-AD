import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  powerSaveBlocker,
  safeStorage,
  shell,
  Tray,
} from 'electron'
import electronUpdater from 'electron-updater'
import { createEngineServer } from '../engine/httpServer.mjs'
import { buildTrayIconPng } from './trayIcon.mjs'

const { autoUpdater } = electronUpdater
const IN_STORE = process.windowsStore === true
const PORTABLE_EXE_DIR = IN_STORE ? null : (process.env.PORTABLE_EXECUTABLE_DIR ?? null)
const PORTABLE_EXE_FILE = IN_STORE ? null : (process.env.PORTABLE_EXECUTABLE_FILE ?? null)
const PORT = PORTABLE_EXE_DIR ? 47211 : 47210

function resolvePortableDataDir() {
  if (!PORTABLE_EXE_DIR) return null
  const beside = path.join(PORTABLE_EXE_DIR, 'Sondra-AD-Daten')
  try {
    fs.mkdirSync(beside, { recursive: true })
    const probe = path.join(beside, '.schreibprobe')
    fs.writeFileSync(probe, '')
    fs.rmSync(probe, { force: true })
    return beside
  } catch {
    return path.join(app.getPath('appData'), 'Sondra AD Portabel')
  }
}

const PORTABLE_DATA = resolvePortableDataDir()
if (PORTABLE_DATA) app.setPath('userData', PORTABLE_DATA)

const SMOKE = process.env.SONDRA_SMOKE
const START_MINIMIZED = process.argv.includes('--minimized') || process.argv.includes('--hidden')

const primary = app.requestSingleInstanceLock()
if (!primary) app.exit(0)

let mainWindow = null
let tray = null
let engine = null
let isQuitting = false
let blockerId = null

function logFile() {
  return path.join(app.getPath('userData'), 'sondra-ad.log')
}

function writeLog(message) {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true })
    fs.appendFileSync(logFile(), `${new Date().toISOString()}  ${message}\n`)
  } catch {}
}

function updatePowerSaveBlocker(active) {
  try {
    if (active) {
      if (blockerId === null || !powerSaveBlocker.isStarted(blockerId)) {
        blockerId = powerSaveBlocker.start('prevent-app-suspension')
      }
    } else if (blockerId !== null && powerSaveBlocker.isStarted(blockerId)) {
      powerSaveBlocker.stop(blockerId)
      blockerId = null
    }
  } catch {}
}

function applyWindowsAutostart(enable) {
  if (process.platform !== 'win32' || SMOKE) return false
  try {
    if (PORTABLE_EXE_FILE) {
      const regKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
      if (enable) {
        execFileSync(
          'reg.exe',
          ['add', regKey, '/v', 'SondraAD', '/t', 'REG_SZ', '/d', `"${PORTABLE_EXE_FILE}" --minimized`, '/f'],
          { windowsHide: true },
        )
      } else {
        execFileSync('reg.exe', ['delete', regKey, '/v', 'SondraAD', '/f'], { windowsHide: true })
      }
      return true
    }
    if (app.isPackaged) {
      app.setLoginItemSettings({
        openAtLogin: Boolean(enable),
        args: ['--minimized'],
      })
      return true
    }
  } catch (err) {
    writeLog(`Autostart-Änderung fehlgeschlagen: ${err?.message ?? err}`)
  }
  return false
}

function readWindowsAutostart() {
  if (process.platform !== 'win32') return false
  try {
    if (PORTABLE_EXE_FILE) {
      execFileSync('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'SondraAD'], {
        windowsHide: true,
        stdio: 'ignore',
      })
      return true
    }
    if (app.isPackaged) {
      return Boolean(app.getLoginItemSettings({ args: ['--minimized'] }).openAtLogin)
    }
  } catch {}
  return Boolean(engine?.store.getConfig().autostartWindows)
}

function showMainWindow() {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

let trayRefreshTimer = null

function scheduleTrayRebuild() {
  if (!tray || !engine) return
  if (trayRefreshTimer) return
  trayRefreshTimer = setTimeout(() => {
    trayRefreshTimer = null
    rebuildTrayMenu()
  }, 600)
}

function rebuildTrayMenu() {
  if (!tray || !engine) return
  const cfg = engine.store.getConfig()
  const queue = engine.store.getQueue()
  const shutdownState = engine.scheduler.getShutdownState()
  const activeJob = queue.find((j) => j.status === 'downloading' || j.status === 'uploading')
  const queuedCount = queue.filter((j) => j.status === 'queued').length

  let statusLabel = cfg.enabled ? 'Bereit · keine aktiven Downloads' : 'Pausiert'
  let tooltip = cfg.enabled ? 'Sondra AD — Überwacht Merkliste im Hintergrund' : 'Sondra AD — Pausiert'
  if (activeJob) {
    const verb = activeJob.status === 'uploading' ? 'Upload' : 'Download'
    const pct = Math.max(0, Math.min(100, Math.round(activeJob.progress || 0)))
    const shortTitle = String(activeJob.seriesTitle || activeJob.title || 'Folge').slice(0, 28)
    statusLabel = `${verb}: ${shortTitle} · ${pct} %`
    tooltip = `Sondra AD — ${statusLabel}`
  } else if (queuedCount > 0) {
    statusLabel = `Warteschlange: ${queuedCount} offen`
    tooltip = `Sondra AD — ${statusLabel}`
  }

  const iconPng = buildTrayIconPng(32, Boolean(cfg.enabled))
  tray.setImage(nativeImage.createFromBuffer(iconPng))
  tray.setToolTip(tooltip)

  const template = [
    {
      label: statusLabel,
      enabled: false,
    },
    { type: 'separator' },
    {
      label: 'Sondra AD öffnen',
      click: () => showMainWindow(),
    },
    {
      label: 'Jetzt auf neue Folgen prüfen',
      click: () => {
        void engine.scheduler.runCheckCycle({ reason: 'manual' })
      },
    },
    { type: 'separator' },
    {
      label: cfg.enabled ? 'Downloads pausieren' : 'Downloads fortsetzen',
      click: () => {
        const updated = engine.store.saveConfig({ enabled: !cfg.enabled })
        updatePowerSaveBlocker(Boolean(updated.preventSuspend && updated.enabled))
        if (updated.enabled) void engine.worker.pumpQueue()
        rebuildTrayMenu()
      },
    },
    {
      label: 'Nach Warteschlange herunterfahren',
      type: 'checkbox',
      checked: Boolean(cfg.shutdownAfterQueue),
      click: (item) => {
        engine.scheduler.setShutdownAfterQueue(item.checked)
        rebuildTrayMenu()
      },
    },
  ]

  if (shutdownState.countdownEndsAt || shutdownState.waitingForDownloads) {
    template.push({
      label: 'Herunterfahren abbrechen',
      click: () => {
        engine.scheduler.cancelPendingShutdown()
        rebuildTrayMenu()
      },
    })
  }

  template.push(
    {
      label: 'Mit Windows starten',
      type: 'checkbox',
      checked: Boolean(cfg.autostartWindows),
      click: (item) => {
        engine.store.saveConfig({ autostartWindows: item.checked })
        applyWindowsAutostart(item.checked)
        rebuildTrayMenu()
      },
    },
    { type: 'separator' },
    ...(AUTO_UPDATE_SUPPORTED
      ? [
          updateState.status === 'downloaded'
            ? {
                label: `Update v${updateState.availableVersion || ''} installieren & neu starten`,
                click: () => {
                  isQuitting = true
                  autoUpdater.quitAndInstall(false, true)
                },
              }
            : {
                label: 'Nach Updates suchen',
                click: () => {
                  void autoUpdater.checkForUpdates().catch(() => {})
                },
              },
        ]
      : []),
    {
      label: 'Beenden',
      click: () => {
        isQuitting = true
        app.quit()
      },
    },
  )

  const menu = Menu.buildFromTemplate(template)
  tray.setContextMenu(menu)
}

function setupTray() {
  if (SMOKE) return
  try {
    const icon = nativeImage.createFromBuffer(buildTrayIconPng(32, true))
    tray = new Tray(icon)
    tray.on('click', () => showMainWindow())
    tray.on('double-click', () => showMainWindow())
    engine?.store.events.on('queue', scheduleTrayRebuild)
    engine?.store.events.on('status', scheduleTrayRebuild)
    engine?.store.events.on('config', scheduleTrayRebuild)
    rebuildTrayMenu()
  } catch (err) {
    writeLog(`System-Tray nicht verfügbar: ${err?.message ?? err}`)
  }
}

ipcMain.handle('sondra-ad:pick-folder', async (_event, title) => {
  const opts = {
    title: String(title || 'Ordner auswählen'),
    properties: ['openDirectory', 'createDirectory'],
  }
  const res = mainWindow ? await dialog.showOpenDialog(mainWindow, opts) : await dialog.showOpenDialog(opts)
  if (res.canceled || !res.filePaths?.[0]) return null
  return res.filePaths[0]
})

ipcMain.handle('sondra-ad:open-folder', async (_event, dirPath) => {
  if (!dirPath) return false
  try {
    fs.mkdirSync(dirPath, { recursive: true })
    await shell.openPath(dirPath)
    return true
  } catch {
    return false
  }
})

ipcMain.handle('sondra-ad:hide-to-tray', () => {
  if (mainWindow && tray) {
    mainWindow.hide()
    return true
  }
  return false
})

ipcMain.handle('sondra-ad:get-autostart', () => readWindowsAutostart())

ipcMain.handle('sondra-ad:set-autostart', (_event, enabled) => {
  const flag = Boolean(enabled)
  engine?.store.saveConfig({ autostartWindows: flag })
  applyWindowsAutostart(flag)
  rebuildTrayMenu()
  return flag
})

const AUTO_UPDATE_SUPPORTED = Boolean(app.isPackaged && !IN_STORE && !PORTABLE_EXE_DIR && !SMOKE)

let updateState = {
  supported: AUTO_UPDATE_SUPPORTED,
  status: 'idle',
  currentVersion: app.getVersion(),
  availableVersion: null,
  progress: 0,
  error: null,
}

function broadcastUpdateState(patch = {}) {
  updateState = { ...updateState, ...patch, currentVersion: app.getVersion() }
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.webContents.send('sondra-ad:update-state', updateState)
    } catch {}
  }
  scheduleTrayRebuild()
}

function setupAutoUpdater() {
  if (!AUTO_UPDATE_SUPPORTED) return
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.logger = {
    info: (m) => writeLog(`Updater: ${m}`),
    warn: (m) => writeLog(`Updater (Warnung): ${m}`),
    error: (m) => writeLog(`Updater (Fehler): ${m}`),
    debug: () => {},
  }
  autoUpdater.on('checking-for-update', () => {
    broadcastUpdateState({ status: 'checking', error: null })
  })
  autoUpdater.on('update-available', (info) => {
    broadcastUpdateState({ status: 'available', availableVersion: info?.version || null, progress: 0, error: null })
  })
  autoUpdater.on('update-not-available', () => {
    broadcastUpdateState({ status: 'up_to_date', availableVersion: null, progress: 0, error: null })
  })
  autoUpdater.on('download-progress', (p) => {
    broadcastUpdateState({ status: 'downloading', progress: Math.round(p?.percent || 0), error: null })
  })
  autoUpdater.on('update-downloaded', (info) => {
    broadcastUpdateState({ status: 'downloaded', availableVersion: info?.version || null, progress: 100, error: null })
    if (Notification.isSupported()) {
      try {
        new Notification({
          title: `Sondra AD v${info?.version || ''} bereit`,
          body: 'Das Update wurde geladen und wird beim nächsten Neustart installiert.',
        }).show()
      } catch {}
    }
  })
  autoUpdater.on('error', (err) => {
    broadcastUpdateState({ status: 'error', error: String(err?.message ?? err).slice(0, 240) })
  })

  setTimeout(() => {
    void autoUpdater.checkForUpdates().catch(() => {})
  }, 15_000).unref?.()
  setInterval(() => {
    void autoUpdater.checkForUpdates().catch(() => {})
  }, 6 * 60 * 60_000).unref?.()
}

ipcMain.handle('sondra-ad:get-update-state', () => updateState)

ipcMain.handle('sondra-ad:check-updates', async () => {
  if (!AUTO_UPDATE_SUPPORTED) return updateState
  try {
    await autoUpdater.checkForUpdates()
  } catch (err) {
    broadcastUpdateState({ status: 'error', error: String(err?.message ?? err).slice(0, 240) })
  }
  return updateState
})

ipcMain.handle('sondra-ad:install-update', () => {
  if (!AUTO_UPDATE_SUPPORTED || updateState.status !== 'downloaded') return false
  isQuitting = true
  autoUpdater.quitAndInstall(false, true)
  return true
})

app.on('second-instance', () => {
  writeLog('Zweiter Start erkannt: bringe Fenster nach vorn.')
  showMainWindow()
})

app.on('before-quit', () => {
  isQuitting = true
})

process.on('uncaughtException', (err) => writeLog(`Unbehandelt: ${err?.stack ?? err}`))
process.on('unhandledRejection', (err) => writeLog(`Unbehandelt (Promise): ${err?.stack ?? err}`))

const BUILT_GOOGLE = {
  clientId: process.env.SONDRA_GOOGLE_CLIENT_ID_INLINED || '',
  clientSecret: process.env.SONDRA_GOOGLE_CLIENT_SECRET_INLINED || '',
}

async function boot() {
  writeLog(
    `Start ${app.getVersion()} · ${process.platform} ${process.arch} · Electron ${process.versions.electron}${IN_STORE ? ' · Microsoft Store' : ''}${PORTABLE_DATA ? ` · portabel, Daten in ${PORTABLE_DATA}` : ''}`,
  )
  Menu.setApplicationMenu(null)

  const siteRoot = process.env.SONDRA_APP_DIR ?? path.join(process.resourcesPath, 'site')
  engine = await createEngineServer({
    rootDir: siteRoot,
    dataDir: app.getPath('userData'),
    host: '127.0.0.1',
    port: PORT,
    runtimeMode: 'desktop',
    vault: {
      canEncrypt: () => safeStorage.isEncryptionAvailable(),
      encrypt: (text) => safeStorage.encryptString(text),
      decrypt: (buf) => safeStorage.decryptString(buf),
    },
    openExternal: (url) => shell.openExternal(url),
    onFocus: () => showMainWindow(),
    builtClientId: BUILT_GOOGLE.clientId,
    builtClientSecret: BUILT_GOOGLE.clientSecret,
    onNotify: ({ title, body }) => {
      try {
        if (!Notification.isSupported()) return
        const n = new Notification({ title, body })
        n.on('click', () => showMainWindow())
        n.show()
      } catch {}
    },
    onAutostartChange: (flag) => {
      applyWindowsAutostart(flag)
      rebuildTrayMenu()
    },
    onConfigChange: (cfg) => {
      updatePowerSaveBlocker(Boolean(cfg.preventSuspend && cfg.enabled))
      rebuildTrayMenu()
    },
  })

  writeLog(`Dienst läuft auf ${engine.url}`)

  const initialCfg = engine.store.getConfig()
  if (initialCfg.autostartWindows) {
    applyWindowsAutostart(true)
  }
  updatePowerSaveBlocker(Boolean(initialCfg.preventSuspend && initialCfg.enabled))

  setupTray()
  setupAutoUpdater()

  mainWindow = new BrowserWindow({
    title: 'Sondra AD',
    width: 1280,
    height: 860,
    minWidth: 360,
    minHeight: 520,
    show: !SMOKE && !START_MINIMIZED,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0a110d' : '#f8faf8',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(app.getAppPath(), 'preload.cjs'),
    },
  })

  mainWindow.on('page-title-updated', (e) => e.preventDefault())

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url) && !url.startsWith(engine.url.replace(/\/$/, ''))) {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  mainWindow.on('close', (event) => {
    if (isQuitting || SMOKE) return
    const cfg = engine.store.getConfig()
    if (cfg.closeToTray && tray) {
      event.preventDefault()
      mainWindow.hide()
    }
  })

  mainWindow.webContents.on('did-finish-load', () => {
    writeLog(`Geladen: ${mainWindow?.webContents.getURL()}`)
  })

  if (SMOKE) {
    mainWindow.webContents.once('did-finish-load', async () => {
      await new Promise((r) => setTimeout(r, 3000))
      const seen = await mainWindow.webContents.executeJavaScript(
        `({ isolated: crossOriginIsolated, heading: document.querySelector('h1,h2')?.textContent ?? null, tabs: document.querySelectorAll('[data-tab]').length })`,
      )
      fs.writeFileSync(SMOKE, JSON.stringify({ url: engine.url, ...seen, userData: app.getPath('userData') }))
      isQuitting = true
      await engine.close()
      app.exit(0)
    })
  }

  let lastErr = null
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await mainWindow.loadURL(engine.url)
      lastErr = null
      break
    } catch (err) {
      lastErr = err
      await new Promise((r) => setTimeout(r, 500 * attempt))
    }
  }

  if (lastErr && SMOKE) {
    fs.writeFileSync(SMOKE, JSON.stringify({ error: String(lastErr?.message ?? lastErr) }))
    isQuitting = true
    await engine.close()
    app.exit(1)
  }
}

app.setAppUserModelId('ch.lizge.sondra.ad')

if (primary) {
  app.whenReady().then(() =>
    boot().catch((err) => {
      const msg = String(err?.message ?? err)
      writeLog(`Start fehlgeschlagen: ${err?.stack ?? err}`)
      if (SMOKE) fs.writeFileSync(SMOKE, JSON.stringify({ error: msg }))
      else dialog.showErrorBox('Sondra AD konnte nicht starten', `${msg}\n\nProtokoll: ${logFile()}`)
      app.exit(1)
    }),
  )
}
