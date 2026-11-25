import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { build } from 'esbuild'
import { makeStoreTiles } from './store-tiles.mjs'

const DESKTOP = path.resolve('desktop')
const STAGE = path.join(DESKTOP, '.stage')
const RESOURCES = path.join(DESKTOP, '.build')
const SITE = path.join(DESKTOP, '.site')

const onlyDir = process.argv.includes('--dir')
const forStore = process.argv.includes('--store')
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

if (forStore) {
  console.log('· Store-Paket (MSIX) bauen')
  makeStoreTiles('public/icon-512.png', path.join(RESOURCES, 'appx'))
  const bare = (value) =>
    (value ?? '')
      .trim()
      .replace(/^[A-Za-z]+\s*=\s*(?=["'])/, '')
      .replace(/^["']|["']$/g, '')
      .trim()

  const identity = {
    identityName: bare(process.env.SONDRA_STORE_IDENTITY_NAME),
    publisher: bare(process.env.SONDRA_STORE_PUBLISHER),
    publisherDisplayName: bare(process.env.SONDRA_STORE_PUBLISHER_NAME),
  }
  const missing = [
    ['STORE_IDENTITY_NAME', identity.identityName],
    ['STORE_PUBLISHER', identity.publisher],
    ['STORE_PUBLISHER_NAME', identity.publisherDisplayName],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name)

  if (identity.publisher && !identity.publisher.startsWith('CN=')) {
    throw new Error(
      `STORE_PUBLISHER muss mit „CN=“ beginnen (Package/Identity/Publisher aus Partner Center), ist aber „${identity.publisher.slice(0, 12)}…“.`,
    )
  }
  if (missing.length) {
    const message = `Store-Identität unvollständig, es fehlt: ${missing.join(', ')}. Testwerte eingesetzt — dieses Paket nimmt der Store nicht an.`
    console.warn(`  ${message}`)
    if (process.env.GITHUB_ACTIONS) console.log(`::warning title=Store-Paket mit Testwerten::${message}`)
    identity.identityName ||= 'Lizge.SondraAD'
    identity.publisher ||= 'CN=00000000-0000-0000-0000-000000000000'
    identity.publisherDisplayName ||= 'Lizge'
  } else {
    console.log(`  Store-Identität: ${identity.identityName}`)
  }

  const own = JSON.parse(fs.readFileSync(path.join(DESKTOP, 'package.json'), 'utf8')).build
  const config = {
    ...own,
    win: {
      ...own.win,
      target: [{ target: 'appx', arch: [arm ? 'arm64' : 'x64'] }],
      artifactName: `Sondra-AD-Store${archTag}-\${version}.\${ext}`,
    },
    appx: {
      ...identity,
      applicationId: 'SondraAD',
      displayName: process.env.SONDRA_STORE_DISPLAY_NAME || 'Sondra AD',
      languages: ['de-DE'],
      backgroundColor: '#0b4a22',
    },
    publish: null,
  }
  delete config.nsis
  const configFile = path.join(RESOURCES, 'store.json')
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2))
  execFileSync(process.execPath, [builder, '--win', 'appx', archFlag, '--config', configFile, '--publish', 'never'], {
    cwd: DESKTOP,
    stdio: 'inherit',
  })
} else {
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
}
