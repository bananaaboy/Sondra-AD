import { net } from 'electron'
import electronUpdater from 'electron-updater'

const { autoUpdater } = electronUpdater

const FIRST_CHECK_MS = 20_000
const EVERY_MS = 6 * 60 * 60 * 1000
const RELEASES = 'https://github.com/bananaaboy/Sondra-AD/releases/latest/download'

function later(a, b) {
  const [x, y] = [a, b].map((version) => version.split('.').map((part) => Number.parseInt(part, 10) || 0))
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0)
  }
  return false
}

export function setupUpdates({ log, ipcMain, window, version, enabled, channel = 'setup', onState = () => {} }) {
  const portable = channel === 'portable'
  const download = portable
    ? `${RELEASES}/${process.arch === 'arm64' ? 'Sondra-AD-Portable-arm64.exe' : 'Sondra-AD-Portable.exe'}`
    : undefined
  let state = { status: enabled ? 'idle' : 'off', version, channel, download }

  const publish = (next) => {
    state = { ...next, version, channel, download }
    const win = window()
    if (win && !win.isDestroyed()) {
      try {
        win.webContents.send('sondra-ad:update', state)
      } catch {}
    }
    try {
      onState(state)
    } catch {}
  }

  let checkNow = () => {}

  const installNow = () => {
    if (state.status !== 'ready') return false
    log(`Update ${state.next}: Neustart auf Wunsch`)
    setImmediate(() => {
      try {
        autoUpdater.quitAndInstall(true, true)
      } catch (failure) {
        const message = String(failure?.message ?? failure).split('\n')[0].slice(0, 200)
        log(`Update installieren fehlgeschlagen: ${failure?.stack ?? failure}`)
        publish({ status: 'error', message, next: state.next })
      }
    })
    return true
  }

  ipcMain.handle('sondra-ad:update-state', () => state)
  ipcMain.handle('sondra-ad:update-check', () => {
    if (!enabled) return state
    checkNow()
    return state
  })
  ipcMain.handle('sondra-ad:update-install', () => installNow())

  if (!enabled) {
    return {
      getState: () => state,
      checkNow: () => state,
      installNow: () => false,
    }
  }

  if (portable) {
    const check = async () => {
      try {
        const response = await net.fetch(`${RELEASES}/latest.yml`, { cache: 'no-store' })
        if (!response.ok) throw new Error(`latest.yml: HTTP ${response.status}`)
        const newest = /^version:\s*['"]?([\d.]+)/m.exec(await response.text())?.[1]
        if (!newest) throw new Error('latest.yml nennt keine Version')
        if (later(newest, version)) {
          log(`Portabel: ${newest} ist erschienen`)
          publish({ status: 'available', next: newest })
        } else {
          publish({ status: 'current' })
        }
      } catch (failure) {
        const message = String(failure?.message ?? failure).split('\n')[0].slice(0, 200)
        log(`Portabel: Update-Prüfung fehlgeschlagen: ${message}`)
        if (state.status !== 'available') publish({ status: 'error', message })
      }
    }
    checkNow = () => {
      if (state.status === 'checking') return
      publish({ status: 'checking' })
      void check()
    }
    setTimeout(check, FIRST_CHECK_MS).unref?.()
    setInterval(check, EVERY_MS).unref?.()
    return {
      getState: () => state,
      checkNow: () => {
        checkNow()
        return state
      },
      installNow: () => false,
    }
  }

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.logger = {
    info: (message) => log(`Update: ${message}`),
    debug: () => {},
    warn: (message) => log(`Update: ${message}`),
    error: (message) => log(`Update: ${message}`),
  }
  autoUpdater.disableWebInstaller = true

  autoUpdater.on('checking-for-update', () => {
    if (state.status !== 'downloading' && state.status !== 'ready') publish({ status: 'checking' })
  })
  autoUpdater.on('update-available', (info) => {
    log(`Update ${info.version} gefunden, wird geladen`)
    publish({ status: 'downloading', next: info.version, percent: 0 })
  })
  autoUpdater.on('download-progress', (progress) => {
    if (state.status === 'downloading') publish({ ...state, percent: Math.round(progress.percent ?? 0) })
  })
  autoUpdater.on('update-not-available', (info) => {
    log(`Keine neuere Fassung (neueste: ${info.version})`)
    publish({ status: 'current' })
  })
  autoUpdater.on('update-downloaded', (info) => {
    log(`Update ${info.version} geladen und geprüft`)
    publish({ status: 'ready', next: info.version })
  })
  autoUpdater.on('error', (failure) => {
    const message = String(failure?.message ?? failure).split('\n')[0].slice(0, 200)
    log(`Update nicht möglich: ${failure?.stack ?? message}`)
    if (state.status !== 'ready') publish({ status: 'error', message })
  })

  const check = () =>
    autoUpdater.checkForUpdates().catch((failure) => log(`Update-Prüfung fehlgeschlagen: ${failure?.message ?? failure}`))

  checkNow = () => {
    if (state.status !== 'downloading' && state.status !== 'ready' && state.status !== 'checking') {
      publish({ status: 'checking' })
      void check()
    }
  }

  setTimeout(check, FIRST_CHECK_MS).unref?.()
  setInterval(check, EVERY_MS).unref?.()

  return {
    getState: () => state,
    checkNow: () => {
      checkNow()
      return state
    },
    installNow,
  }
}
