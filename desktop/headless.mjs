import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createEngineServer } from '../engine/httpServer.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')

function parseArgs(argv) {
  const out = {
    port: Number(process.env.PORT || process.env.SONDRA_AD_PORT || 47210),
    host: process.env.HOST || process.env.SONDRA_AD_HOST || '127.0.0.1',
    dataDir: process.env.SONDRA_AD_DATA || '',
    printSystemd: false,
    installWindowsAutostart: false,
    removeWindowsAutostart: false,
  }
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--port' && argv[i + 1]) out.port = Number(argv[++i])
    else if (arg === '--host' && argv[i + 1]) out.host = String(argv[++i])
    else if (arg === '--data-dir' && argv[i + 1]) out.dataDir = path.resolve(argv[++i])
    else if (arg === '--print-systemd') out.printSystemd = true
    else if (arg === '--install-windows-autostart') out.installWindowsAutostart = true
    else if (arg === '--remove-windows-autostart') out.removeWindowsAutostart = true
  }
  return out
}

function defaultServerDataDir() {
  const home = os.homedir()
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Sondra AD')
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Sondra AD')
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'sondra-ad')
}

function setWindowsRegistryAutostart(enable, scriptPath, dataDir, port, host) {
  if (process.platform !== 'win32') return false
  const regKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
  try {
    if (enable) {
      const cmd = `"${process.execPath}" "${scriptPath}" --host ${host} --port ${port} --data-dir "${dataDir}"`
      execFileSync('reg.exe', ['add', regKey, '/v', 'SondraADServer', '/t', 'REG_SZ', '/d', cmd, '/f'], {
        windowsHide: true,
      })
    } else {
      execFileSync('reg.exe', ['delete', regKey, '/v', 'SondraADServer', '/f'], { windowsHide: true })
    }
    return true
  } catch {
    return false
  }
}

const args = parseArgs(process.argv)
const dataDir = args.dataDir || defaultServerDataDir()
const selfScript = fileURLToPath(import.meta.url)

if (args.printSystemd) {
  const unit = [
    '[Unit]',
    'Description=Sondra AD Automatischer Downloader',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `WorkingDirectory=${repoRoot}`,
    `ExecStart=${process.execPath} ${selfScript} --host ${args.host} --port ${args.port} --data-dir ${dataDir}`,
    'Restart=always',
    'RestartSec=5',
    '',
    '[Install]',
    'WantedBy=default.target',
  ].join('\n')
  process.stdout.write(unit + '\n')
  process.exit(0)
}

if (args.installWindowsAutostart) {
  const ok = setWindowsRegistryAutostart(true, selfScript, dataDir, args.port, args.host)
  process.stdout.write(ok ? 'Windows-Autostart für Sondra AD Server eingerichtet.\n' : 'Autostart nur unter Windows verfügbar.\n')
  process.exit(ok ? 0 : 1)
}

if (args.removeWindowsAutostart) {
  const ok = setWindowsRegistryAutostart(false, selfScript, dataDir, args.port, args.host)
  process.stdout.write(ok ? 'Windows-Autostart entfernt.\n' : 'Kein Eintrag entfernt.\n')
  process.exit(0)
}

const rootDir = path.join(repoRoot, 'dist')
if (!fs.existsSync(path.join(rootDir, 'index.html'))) {
  process.stderr.write('Hinweis: dist/index.html fehlt noch. Führen Sie einmal `npm run build` für die Web-Oberfläche aus.\n')
}

const instance = await createEngineServer({
  rootDir,
  dataDir,
  host: args.host,
  port: args.port,
  runtimeMode: 'server',
  onAutostartChange: (enabled) => setWindowsRegistryAutostart(enabled, selfScript, dataDir, args.port, args.host),
})

process.on('uncaughtException', (err) => {
  instance.store.addLog({
    category: 'system',
    level: 'error',
    title: 'Unerwarteter Laufzeitfehler abgefangen',
    message: String(err?.message ?? err),
  })
})

process.on('unhandledRejection', (err) => {
  instance.store.addLog({
    category: 'system',
    level: 'warn',
    title: 'Abgelehntes Promise abgefangen',
    message: String(err?.message ?? err),
  })
})

process.stdout.write(`Sondra AD Server läuft unter ${instance.url} (Daten: ${dataDir})\n`)

const shutdown = async () => {
  await instance.close()
  process.exit(0)
}
process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
