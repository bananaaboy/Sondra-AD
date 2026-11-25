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
import { createEngineServer } from '../engine/httpServer.mjs'
import { buildTrayIconPng } from './trayIcon.mjs'

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

function rebuildTrayMenu() {
  if (!tray || !engine) return
  const cfg = engine.store.getConfig()
  const iconPng = buildTrayIconPng(32, Boolean(cfg.enabled))
  tray.setImage(nativeImage.createFromBuffer(iconPng))
  tray.setToolTip(
    cfg.enabled
      ? 'Sondra AD — Überwacht Merkliste im Hintergrund'
      : 'Sondra AD — Pausiert',
  )

  const menu = Menu.buildFromTemplate([
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
      label: 'Auto-Download aktiv',
      type: 'checkbox',
      checked: Boolean(cfg.enabled),
      click: (item) => {
        const updated = engine.store.saveConfig({ enabled: item.checked })
        updatePowerSaveBlocker(Boolean(updated.preventSuspend && updated.enabled))
        if (updated.enabled) void engine.worker.pumpQueue()
        rebuildTrayMenu()
      },
    },
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
    {
      label: 'Beenden',
      click: () => {
        isQuitting = true
        app.quit()
      },
    },
  ])
  tray.setContextMenu(menu)
}

function setupTray() {
  if (SMOKE) return
  try {
    const icon = nativeImage.createFromBuffer(buildTrayIconPng(32, true))
    tray = new Tray(icon)
    tray.on('click', () => showMainWindow())
    tray.on('double-click', () => showMainWindow())
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
