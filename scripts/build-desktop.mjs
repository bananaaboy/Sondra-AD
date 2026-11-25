import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { build } from 'esbuild'

const DESKTOP = path.resolve('desktop')
const STAGE = path.join(DESKTOP, '.stage')
const RESOURCES = path.join(DESKTOP, '.build')
const SITE = path.join(DESKTOP, '.site')

const onlyDir = process.argv.includes('--dir')
const arm = process.argv.includes('--arm64')
const archFlag = arm ? '--arm64' : '--x64'
const archTag = arm ? '-arm64' : ''

if (!fs.existsSync('dist/index.html')) {
  console.error('dist/index.html fehlt. Zuerst `npm run build` ausführen.')
  process.exit(1)
}
if (!fs.existsSync(path.join(DESKTOP, 'node_modules/electron-builder'))) {
  console.error('Electron fehlt. Zuerst `npm ci --prefix desktop` ausführen.')
  process.exit(1)
}

fs.rmSync(STAGE, { recursive: true, force: true })
fs.rmSync(RESOURCES, { recursive: true, force: true })
fs.rmSync(SITE, { recursive: true, force: true })
fs.mkdirSync(STAGE, { recursive: true })
fs.mkdirSync(RESOURCES, { recursive: true })

console.log('· Hauptprozess bündeln')
await build({
  entryPoints: ['desktop/electron.mjs'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  define: {
    'process.env.SONDRA_GOOGLE_CLIENT_ID_INLINED': JSON.stringify(process.env.SONDRA_GOOGLE_CLIENT_ID ?? ''),
    'process.env.SONDRA_GOOGLE_CLIENT_SECRET_INLINED': JSON.stringify(process.env.SONDRA_GOOGLE_CLIENT_SECRET ?? ''),
  },
  outfile: path.join(STAGE, 'main.cjs'),
  logLevel: 'warning',
})

fs.copyFileSync('desktop/preload.cjs', path.join(STAGE, 'preload.cjs'))

const rootPkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
fs.writeFileSync(
  path.join(STAGE, 'package.json'),
  JSON.stringify(
    {
      name: 'sondra-ad',
      productName: 'Sondra AD',
      version: rootPkg.version,
      description: 'Sondra AD — Automatischer Hintergrund-Downloader für Sondra.',
      author: 'Lizge',
      main: 'main.cjs',
    },
    null,
    2,
  ),
)

console.log('· Oberfläche kopieren')
fs.cpSync('dist', SITE, { recursive: true })

fs.writeFileSync(path.join(RESOURCES, 'LIZENZ.txt'), '\uFEFF' + fs.readFileSync('desktop/LIZENZ.txt', 'utf8'))
fs.copyFileSync('public/icon-512.png', path.join(RESOURCES, 'icon.png'))

const licences = path.join(RESOURCES, 'lizenzen')
fs.cpSync('desktop/lizenzen', licences, { recursive: true })
for (const [name, file] of [
  ['react.txt', 'node_modules/react/LICENSE'],
  ['zustand.txt', 'node_modules/zustand/LICENSE'],
]) {
  if (fs.existsSync(file)) fs.copyFileSync(file, path.join(licences, name))
}

const builder = path.join(DESKTOP, 'node_modules/electron-builder/cli.js')
console.log(onlyDir ? '· App-Ordner bauen' : '· Windows-Installer bauen')

const args = onlyDir
  ? ['--dir']
  : [
      '--win',
      'nsis',
      archFlag,
      ...(arm ? ['-c.win.artifactName=Sondra-AD-Setup-arm64-${version}.${ext}', '-c.toolsets.nsis=1.2.1'] : []),
    ]

const env = arm ? { ...process.env, ELECTRON_BUILDER_7Z_FILTER: 'BCJ' } : process.env
execFileSync(process.execPath, [builder, ...args, '--publish', 'never'], {
  cwd: DESKTOP,
  stdio: 'inherit',
  env,
})

if (!onlyDir) {
  console.log('· Portable Fassung bauen')
  const unpacked = path.resolve('release', arm ? 'win-arm64-unpacked' : 'win-unpacked')
  const updateInfo = path.resolve('release', 'latest.yml')
  const kept = fs.existsSync(updateInfo) ? fs.readFileSync(updateInfo) : null

  execFileSync(
    process.execPath,
    [
      builder,
      '--win',
      'portable',
      archFlag,
      '--prepackaged',
      unpacked,
      `-c.portable.artifactName=Sondra-AD-Portable${archTag}-\${version}.\${ext}`,
      ...(arm ? ['-c.toolsets.nsis=1.2.1'] : []),
      '--publish',
      'never',
    ],
    { cwd: DESKTOP, stdio: 'inherit', env },
  )

  if (kept && fs.existsSync(updateInfo) && !fs.readFileSync(updateInfo).equals(kept)) {
    fs.writeFileSync(updateInfo, kept)
  }
}
