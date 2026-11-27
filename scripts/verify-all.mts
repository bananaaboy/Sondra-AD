import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

process.env.SONDRA_TEST_ALLOW_LOCAL = '1'

import { createEngineServer } from '../engine/httpServer.mjs'
import { computeNextShutdownAt } from '../engine/scheduler.mjs'
import {
  downloadHlsSegmentsNative,
  getSeriesUsedBytes,
  isInsideTimeWindow,
  resolveEffectiveBandwidthKbps,
} from '../engine/downloaderWorker.mjs'
import { dispatchPushNotifications } from '../engine/pushNotify.mjs'
import { testWebdavConnection, uploadFileToWebdav } from '../engine/webdavClient.mjs'
import { decryptPairingBundle, encryptPairingBundle } from '../engine/driveAuth.mjs'
import { checkRecord } from '../shared/deviceIdentity.mjs'
import {
  folderMatchKey,
  mergeShared,
  normalizeMerkItem,
  readSharedMerkliste,
  seasonNumberFromFolderName,
  sharedSqliteBytes,
} from '../shared/merklisteMerge.mjs'
import { sniffMediaBuffer } from '../engine/mediaCheck.mjs'
import { spawnSync } from 'node:child_process'
import { buildTrayIconPng } from '../desktop/trayIcon.mjs'
import { makeStoreTiles } from './store-tiles.mjs'

function startMockEcosystem() {
  const driveFiles = new Map()
  const uploadSessions = new Map()
  let nextId = 1
  let quotaLimitBytes = 20 * 1024 * 1024
  let otherUsageBytes = 2 * 1024 * 1024

  let voeShouldFail = true
  let s1e3Languages = [2]
  let season2Released = false
  const mp4Payload = crypto.randomBytes(6 * 1024 * 1024)

  const calcSondraBytes = () => {
    let sum = 0
    for (const f of driveFiles.values()) {
      if (f.mimeType !== 'application/vnd.google-apps.folder') sum += f.data.byteLength
    }
    return sum
  }

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url || '/', `http://${req.headers.host}`)

    if (u.pathname === '/oauth/token' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          access_token: 'mock-access-token',
          refresh_token: 'mock-refresh-token',
          expires_in: 3600,
          scope: 'https://www.googleapis.com/auth/drive.file',
        }),
      )
      return
    }

    if (u.pathname === '/drive/v3/about') {
      const sondraBytes = calcSondraBytes()
      const trashBytes = [...driveFiles.values()]
        .filter((f) => f.trashed && f.mimeType !== 'application/vnd.google-apps.folder')
        .reduce((s, f) => s + f.data.byteLength, 0)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          user: { displayName: 'Test Nutzer', emailAddress: 'nutzer@example.com' },
          storageQuota: {
            limit: String(quotaLimitBytes),
            usage: String(otherUsageBytes + sondraBytes),
            usageInDrive: String(otherUsageBytes + sondraBytes - trashBytes),
            usageInDriveTrash: String(trashBytes),
          },
        }),
      )
      return
    }

    if (u.pathname === '/drive/v3/files' && req.method === 'GET') {
      const q = u.searchParams.get('q') || ''
      const wantTrashed = q.includes('trashed = true')
      const parentMatch = q.match(/'([^']+)' in parents/)
      const nameMatch = q.match(/name = '([^']+)'/)
      const wantFolder = q.includes("mimeType = 'application/vnd.google-apps.folder'")
      const wantNotFolder = q.includes("mimeType != 'application/vnd.google-apps.folder'")

      const matched = [...driveFiles.values()].filter((f) => {
        if (Boolean(f.trashed) !== wantTrashed) return false
        if (parentMatch && !f.parents.includes(parentMatch[1])) return false
        if (nameMatch && f.name !== nameMatch[1]) return false
        if (wantFolder && f.mimeType !== 'application/vnd.google-apps.folder') return false
        if (wantNotFolder && f.mimeType === 'application/vnd.google-apps.folder') return false
        return true
      })

      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          files: matched.map((f) => ({
            id: f.id,
            name: f.name,
            size: String(f.data.byteLength),
            modifiedTime: f.modifiedTime,
            mimeType: f.mimeType,
            parents: f.parents,
            appProperties: f.appProperties,
          })),
        }),
      )
      return
    }

    if (u.pathname === '/drive/v3/files' && req.method === 'POST') {
      const chunks = []
      for await (const c of req) chunks.push(c)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const id = `df-${nextId++}`
      const record = {
        id,
        name: body.name,
        mimeType: body.mimeType || 'application/octet-stream',
        parents: body.parents || ['root'],
        appProperties: body.appProperties || {},
        trashed: false,
        modifiedTime: new Date().toISOString(),
        data: Buffer.alloc(0),
      }
      driveFiles.set(id, record)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id, name: record.name, mimeType: record.mimeType, parents: record.parents }))
      return
    }

    const fileIdMatch = u.pathname.match(/^\/drive\/v3\/files\/([^/]+)$/)
    if (fileIdMatch) {
      const fid = decodeURIComponent(fileIdMatch[1])
      const f = driveFiles.get(fid)
      if (!f) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'Not found' } }))
        return
      }
      if (req.method === 'GET') {
        if (u.searchParams.get('alt') === 'media') {
          res.writeHead(200, { 'content-type': f.mimeType, 'content-length': String(f.data.byteLength) })
          res.end(f.data)
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            id: f.id,
            name: f.name,
            size: String(f.data.byteLength),
            trashed: f.trashed,
            mimeType: f.mimeType,
            parents: f.parents,
            modifiedTime: f.modifiedTime,
            appProperties: f.appProperties,
          }),
        )
        return
      }
      if (req.method === 'DELETE') {
        driveFiles.delete(fid)
        res.writeHead(204)
        res.end()
        return
      }
      if (req.method === 'PATCH') {
        const chunks = []
        for await (const c of req) chunks.push(c)
        const patch = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
        const addParents = u.searchParams.get('addParents')
        const removeParents = u.searchParams.get('removeParents')
        if (removeParents) {
          const rm = new Set(removeParents.split(','))
          f.parents = f.parents.filter((p) => !rm.has(p))
        }
        if (addParents && !f.parents.includes(addParents)) f.parents.push(addParents)
        if (patch.appProperties) f.appProperties = { ...f.appProperties, ...patch.appProperties }
        if (typeof patch.trashed === 'boolean') f.trashed = patch.trashed
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            id: f.id,
            name: f.name,
            size: String(f.data.byteLength),
            mimeType: f.mimeType,
            parents: f.parents,
            modifiedTime: f.modifiedTime,
            appProperties: f.appProperties,
          }),
        )
        return
      }
    }

    if (u.pathname.startsWith('/upload/drive/v3/files')) {
      const uploadType = u.searchParams.get('uploadType')
      const existingMatch = u.pathname.match(/^\/upload\/drive\/v3\/files\/([^/]+)$/)
      const existingId = existingMatch ? decodeURIComponent(existingMatch[1]) : null

      if (uploadType === 'resumable') {
        const chunks = []
        for await (const c of req) chunks.push(c)
        const meta = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
        const sid = `sess-${nextId++}`
        const total = Number(req.headers['x-upload-content-length']) || 0
        uploadSessions.set(sid, {
          existingId,
          meta,
          mime: req.headers['x-upload-content-type'] || 'video/mp4',
          total,
          buf: Buffer.alloc(total),
          received: 0,
        })
        res.writeHead(200, {
          Location: `http://${req.headers.host}/upload/session/${sid}`,
        })
        res.end()
        return
      }

      const chunks = []
      for await (const c of req) chunks.push(c)
      const raw = Buffer.concat(chunks)

      if (existingId && uploadType === 'media') {
        const f = driveFiles.get(existingId)
        f.data = raw
        f.modifiedTime = new Date().toISOString()
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            id: f.id,
            name: f.name,
            size: String(f.data.byteLength),
            mimeType: f.mimeType,
            parents: f.parents,
            modifiedTime: f.modifiedTime,
            appProperties: f.appProperties,
          }),
        )
        return
      }

      const contentType = String(req.headers['content-type'] || '')
      const bMatch = contentType.match(/boundary=(.+)$/)
      const boundary = bMatch ? bMatch[1].trim() : ''
      const sep = Buffer.from(`--${boundary}`)
      const firstIdx = raw.indexOf('\r\n\r\n')
      const metaPartEnd = raw.indexOf(sep, firstIdx)
      const metaJsonStr = raw.subarray(firstIdx + 4, metaPartEnd - 2).toString('utf8')
      const meta = JSON.parse(metaJsonStr)
      const secondHeaderEnd = raw.indexOf('\r\n\r\n', metaPartEnd)
      const endBoundary = raw.lastIndexOf(Buffer.from(`\r\n--${boundary}--`))
      const payload = raw.subarray(secondHeaderEnd + 4, endBoundary)

      const id = `df-${nextId++}`
      const record = {
        id,
        name: meta.name,
        mimeType: meta.mimeType || 'application/octet-stream',
        parents: meta.parents || ['root'],
        appProperties: meta.appProperties || {},
        trashed: false,
        modifiedTime: new Date().toISOString(),
        data: Buffer.from(payload),
      }
      driveFiles.set(id, record)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          id: record.id,
          name: record.name,
          size: String(record.data.byteLength),
          mimeType: record.mimeType,
          parents: record.parents,
          modifiedTime: record.modifiedTime,
          appProperties: record.appProperties,
        }),
      )
      return
    }

    const sessMatch = u.pathname.match(/^\/upload\/session\/([^/]+)$/)
    if (sessMatch && req.method === 'PUT') {
      const sess = uploadSessions.get(sessMatch[1])
      const chunks = []
      for await (const c of req) chunks.push(c)
      const body = Buffer.concat(chunks)
      const cr = String(req.headers['content-range'] || '')
      const m = cr.match(/bytes (\d+)-(\d+)\/(\d+)/)
      if (m) {
        const start = Number(m[1])
        body.copy(sess.buf, start)
        sess.received = Math.max(sess.received, start + body.length)
      }
      if (sess.received < sess.total) {
        res.writeHead(308, { Range: `bytes=0-${sess.received - 1}` })
        res.end()
        return
      }
      uploadSessions.delete(sessMatch[1])
      const id = sess.existingId || `df-${nextId++}`
      const prev = sess.existingId ? driveFiles.get(sess.existingId) : null
      const record = {
        id,
        name: prev?.name || sess.meta.name,
        mimeType: sess.mime,
        parents: prev?.parents || sess.meta.parents || ['root'],
        appProperties: { ...(prev?.appProperties || {}), ...(sess.meta.appProperties || {}) },
        trashed: false,
        modifiedTime: new Date().toISOString(),
        data: sess.buf,
      }
      driveFiles.set(id, record)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          id: record.id,
          name: record.name,
          size: String(record.data.byteLength),
          mimeType: record.mimeType,
          parents: record.parents,
          modifiedTime: record.modifiedTime,
          appProperties: record.appProperties,
        }),
      )
      return
    }

    const origin = `http://${req.headers.host}`

    if (u.pathname === '/anime/stream/frieren') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(`
        <div class="series-title"><h1><span>Frieren</span></h1></div>
        <a href="/anime/stream/frieren/staffel-1">Staffel 1</a>
        ${season2Released ? '<a href="/anime/stream/frieren/staffel-2">Staffel 2</a>' : ''}
        <a href="/anime/stream/frieren/staffel-1/episode-1">E1</a>
        <a href="/anime/stream/frieren/staffel-1/episode-2">E2</a>
        <a href="/anime/stream/frieren/staffel-1/episode-3">E3</a>
      `)
      return
    }

    if (u.pathname === '/anime/stream/frieren/staffel-2') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(`
        <div class="series-title"><h1><span>Frieren</span></h1></div>
        <a href="/anime/stream/frieren/staffel-2/episode-1">S2E1</a>
      `)
      return
    }

    const epMatch = u.pathname.match(/^\/anime\/stream\/frieren\/staffel-(\d+)\/episode-(\d+)$/)
    if (epMatch) {
      const sNum = Number(epMatch[1])
      const eNum = Number(epMatch[2])
      const langs = sNum === 1 && eNum === 3 ? s1e3Languages : [3, 1]
      const lis = langs
        .flatMap((lk) => [
          `<li class="episodeLink" data-lang-key="${lk}" data-link-target="/redirect/voe-${sNum}-${eNum}"><h4>VOE</h4></li>`,
          `<li class="episodeLink" data-lang-key="${lk}" data-link-target="/redirect/fm-${sNum}-${eNum}"><h4>Filemoon</h4></li>`,
        ])
        .join('\n')
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(`
        <div class="series-title"><h1><span>Frieren</span></h1></div>
        <span class="episodeGermanTitle">Folge ${eNum}</span>
        <ul>${lis}</ul>
      `)
      return
    }

    if (u.pathname.startsWith('/redirect/voe-')) {
      res.writeHead(302, { Location: `${origin}/voe/embed` })
      res.end()
      return
    }

    if (u.pathname.startsWith('/redirect/fm-')) {
      res.writeHead(302, { Location: `${origin}/filemoon/embed` })
      res.end()
      return
    }

    if (u.pathname === '/voe/embed') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(`<script>var sources = { 'mp4': '${origin}/media/voe-broken.mp4' };</script>`)
      return
    }

    if (u.pathname === '/filemoon/embed') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(`<script>file: "${origin}/media/filemoon-ok.mp4"</script>`)
      return
    }

    if (u.pathname === '/media/voe-broken.mp4') {
      if (voeShouldFail) {
        res.writeHead(503)
        res.end('VOE Server Overload')
        return
      }
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(mp4Payload.byteLength) })
      res.end(mp4Payload)
      return
    }

    if (u.pathname === '/media/filemoon-ok.mp4') {
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(mp4Payload.byteLength) })
      res.end(mp4Payload)
      return
    }

    res.writeHead(404)
    res.end('Not found')
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        driveFiles,
        setVoeFail: (val) => {
          voeShouldFail = val
        },
        setS1E3Langs: (langs) => {
          s1e3Languages = langs
        },
        releaseSeason2: () => {
          season2Released = true
        },
        setQuotaLimit: (bytes) => {
          quotaLimitBytes = bytes
        },
        close: () => new Promise((r) => server.close(() => r())),
      })
    })
  })
}

async function waitUntil(predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((r) => setTimeout(r, 80))
  }
  throw new Error('Zeitüberschreitung beim Warten auf Bedingung.')
}

async function main() {
  console.log('1. Prüfe Tray-PNG-Generator, Store-Kacheln und SQLite-Merkliste …')
  const png = buildTrayIconPng(32, true)
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
  const tileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sondra-ad-tiles-'))
  makeStoreTiles('public/icon-512.png', tileDir)
  assert.equal(fs.existsSync(path.join(tileDir, 'StoreLogo.png')), true)
  assert.equal(fs.existsSync(path.join(tileDir, 'Wide310x150Logo.png')), true)
  assert.equal(fs.existsSync(path.join(tileDir, 'Square44x44Logo.targetsize-256_altform-unplated.png')), true)
  fs.rmSync(tileDir, { recursive: true, force: true })

  const itemA = normalizeMerkItem({
    id: 'merk-1',
    title: 'Frieren',
    url: 'https://aniworld.to/anime/stream/frieren',
    season: 1,
    episode: 2,
    seasons: [{ number: 1, episodes: 3, watched: [1] }],
    updatedAt: 1000,
  })
  const sqliteBytes = sharedSqliteBytes([itemA], { 'old-id': 500 })
  const roundtrip = readSharedMerkliste(sqliteBytes)
  assert.ok(roundtrip)
  assert.equal(roundtrip.items.length, 1)
  assert.equal(roundtrip.items[0].title, 'Frieren')
  assert.deepEqual(roundtrip.items[0].seasons?.[0].watched, [1])
  assert.equal(roundtrip.removed['old-id'], 500)

  const newerRemote = {
    items: [normalizeMerkItem({ ...itemA, episode: 3, updatedAt: 2000 })],
    removed: {},
  }
  const merged = mergeShared([itemA], {}, newerRemote)
  assert.equal(merged.items[0].episode, 3)

  console.log('2. Prüfe verschlüsseltes Sondra-Kopplungspaket …')
  const bundle = encryptPairingBundle({ auth: { refreshToken: 'rt-123' }, config: { language: 'ger_sub' } }, 'geheim123')
  assert.ok(bundle.startsWith('SONDRA-AD-PAIR-1.'))
  const opened = decryptPairingBundle(bundle, 'geheim123')
  assert.equal(opened.auth.refreshToken, 'rt-123')
  assert.throws(() => decryptPairingBundle(bundle, 'falsch'))

  console.log('3. Starte Mock-Ökosystem (Google Drive v3 + AniWorld + VOE/FileMoon) …')
  const mock = await startMockEcosystem()
  process.env.SONDRA_DRIVE_API_BASE = `${mock.baseUrl}/drive/v3`
  process.env.SONDRA_DRIVE_UPLOAD_BASE = `${mock.baseUrl}/upload/drive/v3`

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sondra-ad-verify-'))
  const fakeSondraDir = path.join(workDir, 'FakeSondra')
  fs.mkdirSync(fakeSondraDir, { recursive: true })
  fs.writeFileSync(
    path.join(fakeSondraDir, 'herunterladen.json'),
    JSON.stringify({ cookies: 'firefox', bindAddress: 'default' }),
  )
  fs.writeFileSync(path.join(fakeSondraDir, 'google-drive-schluessel.bin'), Buffer.from('plain:mock-sondra-refresh'))

  const triggeredPowerActions = []
  const dataDir = path.join(workDir, 'ad-data')
  const engine = await createEngineServer({
    rootDir: path.resolve('dist'),
    dataDir,
    port: 0,
    runtimeMode: 'server',
    onPowerAction: async (action) => {
      triggeredPowerActions.push(action)
    },
  })

  try {
    console.log('4. Prüfe lokale Sondra-Übernahme & Geräte-Registrierung …')
    const impRes = await fetch(`${engine.url}api/ad/sondra/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ customDir: fakeSondraDir }),
    }).then((r) => r.json())
    assert.equal(impRes.ok, true)
    assert.equal(impRes.config.browserCookies, 'firefox')

    await assert.rejects(() => engine.driveAuth.startAuthFlow({ openBrowser: false }))
    engine.store.saveConfig({
      googleClientId: 'test-desktop-client.apps.googleusercontent.com',
      googleClientSecret: 'test-desktop-secret',
    })
    const authStart = await engine.driveAuth.startAuthFlow({ openBrowser: false })
    const parsedAuth = new URL(authStart.authUrl)
    assert.equal(parsedAuth.searchParams.get('response_type'), 'code')
    assert.equal(parsedAuth.searchParams.get('code_challenge_method'), 'S256')
    assert.equal(parsedAuth.searchParams.get('access_type'), 'offline')
    assert.ok(authStart.redirectUri.startsWith('http://127.0.0.1:'))
    await engine.driveAuth.disconnect()

    await engine.driveAuth.setDirectRefreshToken({
      refreshToken: 'mock-refresh',
      accessToken: 'mock-access',
      expiresIn: 3600,
    })

    const hb = await engine.driveService.heartbeatDeviceRecord()
    assert.ok(hb?.self)
    const verifiedRecord = await checkRecord(hb.self)
    assert.ok(verifiedRecord)
    assert.equal(verifiedRecord.id, hb.self.id)

    console.log('5. Prüfe Auto-Download, Hoster-Fallback (VOE 503 -> FileMoon), Resumable Upload & Sprach-Warteliste …')
    await fetch(`${engine.url}api/ad/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        language: 'ger_sub',
        waitForPreferredLanguage: true,
        storageTarget: 'drive_only',
      }),
    })

    await fetch(`${engine.url}api/ad/merkliste/upsert`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'frieren-id',
        title: 'Frieren',
        url: `${mock.baseUrl}/anime/stream/frieren`,
        status: 'watching',
        season: 1,
        episode: 2,
        seasons: [{ number: 1, episodes: 3, watched: [1] }],
        checkImmediately: false,
      }),
    })

    const check1 = await engine.scheduler.runCheckCycle({ reason: 'manual' })
    assert.equal(check1.totalQueued, 2)

    await waitUntil(() => {
      const q = engine.store.getQueue()
      const e2 = q.find((j) => j.episode === 2)
      const e3 = q.find((j) => j.episode === 3)
      return e2?.status === 'completed' && e3?.status === 'waiting_language'
    })

    const qAfter1 = engine.store.getQueue()
    const jobE2 = qAfter1.find((j) => j.episode === 2)
    assert.equal(jobE2.activeHoster, 'Filemoon')
    assert.ok(jobE2.triedHosters.some((h) => h.includes('VOE')))
    assert.equal(jobE2.drivePath, 'Serien/Frieren/Staffel 1/Frieren - S01E02.mp4')

    const stagingEntries = fs.readdirSync(engine.store.getConfig().tempDir)
    assert.equal(stagingEntries.length, 0)

    mock.setS1E3Langs([3, 2])
    engine.worker.retryJob(qAfter1.find((j) => j.episode === 3).id)
    await waitUntil(() => engine.store.getQueue().find((j) => j.episode === 3)?.status === 'completed')

    console.log('6. Prüfe Erkennung neuer Staffeln bei abgeschlossenen Serien („Fertig“ -> Staffel 2) …')
    const curMerk = engine.store.getMerkItems()
    engine.store.saveMerkliste(
      curMerk.map((m) => ({
        ...m,
        status: 'done',
        seasons: [{ number: 1, episodes: 3, watched: [1, 2, 3] }],
      })),
    )
    mock.releaseSeason2()
    const checkS2 = await engine.scheduler.runCheckCycle({ reason: 'manual' })
    assert.equal(checkS2.totalQueued, 1)
    await waitUntil(() =>
      engine.store.getQueue().some((j) => j.season === 2 && j.episode === 1 && j.status === 'completed'),
    )

    console.log('7. Prüfe Speicherlimit-Bereinigung (Gesehene löschen, Ungesehene schützen) …')
    engine.store.saveConfig({
      cleanupEnabled: true,
      maxSondraDriveGb: 0.01,
      minFreeDriveGb: 0,
      keepRecentWatchedCount: 0,
      protectUnwatched: true,
    })

    const previewCleanup = await engine.scheduler.runStorageCleanup({ dryRun: true })
    assert.ok(previewCleanup.candidates.length >= 1)
    assert.ok(previewCleanup.candidates.every((c) => c.name.includes('S01E02') || c.name.includes('S01E03')))
    assert.ok(!previewCleanup.candidates.some((c) => c.name.includes('S02E01')))

    const execCleanup = await engine.scheduler.runStorageCleanup({ dryRun: false })
    assert.ok(execCleanup.deletedCount >= 1)
    assert.equal(engine.store.hasEpisode('frieren-id', 2, 1), true)

    console.log('8. Prüfe Inaktivitäts-Archivierung & Wiederherstellung …')
    const sixtyDaysAgo = Date.now() - 60 * 86_400_000
    for (const f of mock.driveFiles.values()) {
      if (f.name.includes('S02E01')) {
        f.modifiedTime = new Date(sixtyDaysAgo).toISOString()
      }
    }
    engine.store.saveMerkliste(
      engine.store.getMerkItems().map((m) => ({
        ...m,
        lastOpenedAt: sixtyDaysAgo,
        updatedAt: sixtyDaysAgo,
        history: [],
      })),
    )
    engine.store.saveConfig({
      inactivityEnabled: true,
      inactivityDays: 45,
      inactivityActions: ['drive_archive', 'pause_series'],
    })

    const archRes = await engine.scheduler.runInactivityCheck({ dryRun: false })
    assert.equal(archRes.processed, 1)
    assert.equal(archRes.pausedSeries, 1)

    const archIdx = engine.store.getEpisodeIndex().archived['frieren-id::S2E1']
    assert.ok(archIdx)
    assert.ok(archIdx.drivePath.startsWith('Archiv/Frieren/Staffel 2/'))

    await engine.scheduler.restoreFromArchive({
      driveFileId: archIdx.driveFileId,
      seriesId: 'frieren-id',
      season: 2,
      episode: 1,
      seriesTitle: 'Frieren',
    })
    const dlIdx = engine.store.getEpisodeIndex().downloaded['frieren-id::S2E1']
    assert.ok(dlIdx)
    assert.ok(dlIdx.drivePath.startsWith('Serien/Frieren/Staffel 2/'))

    console.log('9. Prüfe Staffel-spezifische Regeln & Alle-abbrechen …')
    engine.worker.clearCompletedJobs()
    engine.store.unmarkEpisode('frieren-id', 1, 2)
    engine.store.unmarkEpisode('frieren-id', 1, 3)
    engine.store.saveConfig({
      enabled: false,
      seriesOverrides: {
        'frieren-id': {
          enabled: true,
          seasonRules: {
            '1': { enabled: true, fromEpisode: 2, toEpisode: 3, maxEpisodes: 1 },
            '2': { enabled: false },
          },
        },
      },
    })
    engine.store.saveMerkliste(
      engine.store.getMerkItems().map((m) => ({
        ...m,
        status: 'watching',
        season: 1,
        episode: 1,
        updatedAt: Date.now() + 10_000,
        seasons: [
          { number: 1, episodes: 3, watched: [] },
          { number: 2, episodes: 1, watched: [] },
        ],
      })),
    )
    const beforeQueueLen = engine.store.getQueue().length
    const seasonCheck = await engine.scheduler.runCheckCycle({ reason: 'manual', seriesId: 'frieren-id' })
    assert.equal(seasonCheck.totalQueued, 1)
    const addedJob = engine.store.getQueue()[beforeQueueLen]
    assert.equal(addedJob.season, 1)
    assert.equal(addedJob.episode, 2)

    const cancelledCount = engine.worker.cancelAllJobs()
    assert.equal(cancelledCount, 1)
    assert.equal(engine.store.getQueue()[beforeQueueLen].status, 'cancelled')

    console.log('10. Prüfe geplantes Herunterfahren (Wartezeit, Countdown, Abbruch & Auslösung) …')
    const baseTime = new Date(2026, 4, 10, 22, 0, 0, 0).getTime()
    const next03 = computeNextShutdownAt('03:00', baseTime)
    assert.ok(next03 && next03 > baseTime)
    assert.equal(new Date(next03).getHours(), 3)
    assert.equal(new Date(next03).getMinutes(), 0)

    engine.store.saveConfig({
      scheduledShutdownEnabled: true,
      scheduledShutdownTime: '03:00',
      scheduledShutdownAction: 'shutdown',
      scheduledShutdownWaitForDownloads: true,
      scheduledShutdownRepeatDaily: false,
    })
    const schedState1 = engine.scheduler.recomputeShutdownSchedule()
    assert.equal(schedState1.enabled, true)
    assert.ok(schedState1.scheduledAt && schedState1.scheduledAt > Date.now())

    const dummyId = 'shutdown-test-job'
    engine.store.setQueue([
      ...engine.store.getQueue(),
      {
        id: dummyId,
        seriesId: 'frieren-id',
        seriesTitle: 'Frieren',
        seriesUrl: `${mock.baseUrl}/anime/stream/frieren`,
        season: 1,
        episode: 99,
        langKey: 3,
        langLabel: 'Ger-Sub',
        episodeUrl: `${mock.baseUrl}/anime/stream/frieren/staffel-1/episode-1`,
        status: 'downloading',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ])

    const waitState = await engine.scheduler.checkScheduledShutdown(schedState1.scheduledAt + 1000, 60_000)
    assert.equal(waitState.waitingForDownloads, true)
    assert.equal(waitState.countdownEndsAt, null)
    assert.equal(triggeredPowerActions.length, 0)

    engine.store.patchQueueItem(dummyId, { status: 'cancelled' }, true)
    const countdownState = await engine.scheduler.checkScheduledShutdown(schedState1.scheduledAt + 2000, 60_000)
    assert.equal(countdownState.waitingForDownloads, false)
    assert.ok(countdownState.countdownEndsAt && countdownState.countdownEndsAt > schedState1.scheduledAt)

    const cancelRes = await fetch(`${engine.url}api/ad/power/cancel-shutdown`, { method: 'POST' }).then((r) => r.json())
    assert.equal(cancelRes.ok, true)
    assert.equal(cancelRes.shutdownState.enabled, false)
    assert.equal(cancelRes.shutdownState.countdownEndsAt, null)
    assert.equal(triggeredPowerActions.length, 0)

    engine.store.saveConfig({
      scheduledShutdownEnabled: true,
      scheduledShutdownTime: '03:00',
      scheduledShutdownAction: 'shutdown',
      scheduledShutdownWaitForDownloads: true,
      scheduledShutdownRepeatDaily: false,
    })
    const schedState2 = engine.scheduler.recomputeShutdownSchedule()
    await engine.scheduler.checkScheduledShutdown(schedState2.scheduledAt + 1000, 0)
    assert.deepEqual(triggeredPowerActions, ['shutdown'])
    assert.equal(engine.store.getConfig().scheduledShutdownEnabled, false)

    console.log('11. Prüfe Zeitfenster, Nach-Queue-Shutdown, Wochenplan, Push-Dienste & WebDAV …')
    const at0200 = new Date(2026, 4, 11, 2, 0, 0, 0).getTime()
    const at1400 = new Date(2026, 4, 11, 14, 0, 0, 0).getTime()
    assert.equal(isInsideTimeWindow('23:00', '07:00', at0200), true)
    assert.equal(isInsideTimeWindow('23:00', '07:00', at1400), false)
    const nightBw = resolveEffectiveBandwidthKbps(
      {
        downloadWindowEnabled: true,
        downloadWindowStart: '23:00',
        downloadWindowEnd: '07:00',
        downloadWindowMode: 'throttle_outside',
        maxBandwidthKbps: 0,
        daytimeMaxBandwidthKbps: 1200,
      },
      at0200,
    )
    assert.equal(nightBw.allowed, true)
    assert.equal(nightBw.maxBandwidthKbps, 0)
    const dayBw = resolveEffectiveBandwidthKbps(
      {
        downloadWindowEnabled: true,
        downloadWindowStart: '23:00',
        downloadWindowEnd: '07:00',
        downloadWindowMode: 'throttle_outside',
        maxBandwidthKbps: 0,
        daytimeMaxBandwidthKbps: 1200,
      },
      at1400,
    )
    assert.equal(dayBw.allowed, true)
    assert.equal(dayBw.maxBandwidthKbps, 1200)
    const pauseBw = resolveEffectiveBandwidthKbps(
      {
        downloadWindowEnabled: true,
        downloadWindowStart: '23:00',
        downloadWindowEnd: '07:00',
        downloadWindowMode: 'pause_outside',
        maxBandwidthKbps: 0,
      },
      at1400,
    )
    assert.equal(pauseBw.allowed, false)

    const afterQRes = await fetch(`${engine.url}api/ad/power/after-queue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    }).then((r) => r.json())
    assert.equal(afterQRes.ok, true)
    assert.equal(afterQRes.shutdownState.shutdownAfterQueue, true)
    engine.scheduler.triggerShutdownAfterQueueIfReady(Date.now(), 0)
    assert.deepEqual(triggeredPowerActions, ['shutdown', 'shutdown'])
    assert.equal(engine.store.getConfig().shutdownAfterQueue, false)

    engine.store.saveConfig({
      seriesOverrides: {
        ...engine.store.getConfig().seriesOverrides,
        'frieren-id': {
          ...(engine.store.getConfig().seriesOverrides['frieren-id'] || {}),
          airDay: 5,
          maxStorageGb: 10,
        },
      },
    })
    const calRes = await fetch(`${engine.url}api/ad/calendar`).then((r) => r.json())
    assert.equal(calRes.ok, true)
    const frierenCal = calRes.calendar.find((c) => c.seriesId === 'frieren-id')
    assert.ok(frierenCal)
    assert.equal(frierenCal.airDay, 5)
    assert.equal(frierenCal.airDaySource, 'manual')
    assert.ok(getSeriesUsedBytes(engine.store, 'frieren-id') > 0)

    const receivedRequests = []
    const auxServer = http.createServer(async (req, res) => {
      const chunks = []
      for await (const c of req) chunks.push(c)
      receivedRequests.push({ method: req.method, url: req.url, bytes: Buffer.concat(chunks).byteLength })
      if (req.method === 'OPTIONS') {
        res.writeHead(200, { DAV: '1,2' })
        res.end()
        return
      }
      if (req.method === 'MKCOL' || req.method === 'PUT') {
        res.writeHead(201)
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    })
    await new Promise((r) => auxServer.listen(0, '127.0.0.1', () => r()))
    const auxPort = auxServer.address().port
    const auxBase = `http://127.0.0.1:${auxPort}`
    try {
      process.env.SONDRA_TELEGRAM_API_BASE = auxBase
      process.env.SONDRA_PUSHOVER_API_URL = `${auxBase}/pushover`
      const pushResults = await dispatchPushNotifications(
        {
          telegramBotToken: 'bot123',
          telegramChatId: '999',
          ntfyUrl: `${auxBase}/ntfy-topic`,
          pushoverAppToken: 'app1',
          pushoverUserKey: 'usr1',
        },
        { title: 'Test', body: 'Hallo' },
      )
      assert.equal(pushResults.length, 3)
      assert.ok(pushResults.every((r) => r.ok))

      const wdTest = await testWebdavConnection({ url: `${auxBase}/dav`, username: 'u', password: 'p', basePath: '/Sondra' })
      assert.equal(wdTest.ok, true)
      const tmpSample = path.join(workDir, 'sample.mp4')
      fs.writeFileSync(tmpSample, Buffer.from('0123456789'))
      const wdUp = await uploadFileToWebdav({
        url: `${auxBase}/dav`,
        username: 'u',
        password: 'p',
        basePath: '/Sondra',
        segments: ['Frieren', 'Season 01'],
        fileName: 'Frieren - S01E01.mp4',
        localFilePath: tmpSample,
      })
      assert.equal(wdUp.size, 10)
      assert.ok(receivedRequests.some((r) => r.method === 'PUT' && r.url.includes('Frieren%20-%20S01E01.mp4')))
    } finally {
      delete process.env.SONDRA_TELEGRAM_API_BASE
      delete process.env.SONDRA_PUSHOVER_API_URL
      await new Promise((r) => auxServer.close(() => r()))
    }

    console.log('12. Prüfe AES-128/fMP4-HLS, Drive-Fallback auf lokal, Direktstart & Verlauf-Löschung …')
    const hlsKey = crypto.randomBytes(16)
    const hlsInit = Buffer.from('FTYP-FMP4-INIT-HEADER')
    const hlsPlainSeg = Buffer.from('DECRYPTED-VIDEO-SEGMENT-PAYLOAD-12345')
    const seqIv = Buffer.alloc(16)
    seqIv.writeBigUInt64BE(10n, 8)
    const cipher = crypto.createCipheriv('aes-128-cbc', hlsKey, seqIv)
    const hlsEncSeg = Buffer.concat([cipher.update(hlsPlainSeg), cipher.final()])

    const hlsServer = http.createServer((req, res) => {
      if (req.url === '/enc.key') {
        res.writeHead(200, { 'content-type': 'application/octet-stream' })
        res.end(hlsKey)
        return
      }
      if (req.url === '/init.mp4') {
        res.writeHead(200, { 'content-type': 'video/mp4' })
        res.end(hlsInit)
        return
      }
      if (req.url === '/seg10.m4s') {
        res.writeHead(200, { 'content-type': 'video/iso.segment' })
        res.end(hlsEncSeg)
        return
      }
      res.writeHead(404)
      res.end()
    })
    await new Promise((r) => hlsServer.listen(0, '127.0.0.1', () => r()))
    const hlsBase = `http://127.0.0.1:${hlsServer.address().port}`
    try {
      const m3u8 = [
        '#EXTM3U',
        '#EXT-X-VERSION:7',
        '#EXT-X-MEDIA-SEQUENCE:10',
        '#EXT-X-MAP:URI="init.mp4"',
        '#EXT-X-KEY:METHOD=AES-128,URI="enc.key"',
        '#EXTINF:4.0,',
        'seg10.m4s',
        '#EXT-X-ENDLIST',
      ].join('\n')
      const writtenHls = await downloadHlsSegmentsNative(
        m3u8,
        `${hlsBase}/master.m3u8`,
        path.join(workDir, 'test-hls.ts'),
        { referer: `${hlsBase}/embed/1` },
      )
      assert.ok(writtenHls.endsWith('test-hls.mp4'))
      const combined = fs.readFileSync(writtenHls)
      assert.equal(Buffer.compare(combined, Buffer.concat([hlsInit, hlsPlainSeg])), 0)
    } finally {
      await new Promise((r) => hlsServer.close(() => r()))
    }

    await engine.driveAuth.disconnect()
    engine.store.saveConfig({ enabled: false, storageTarget: 'drive_only' })
    const manualAdd = await fetch(`${engine.url}api/ad/queue/add`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: `${mock.baseUrl}/media/filemoon-ok.mp4` }),
    }).then((r) => r.json())
    assert.equal(manualAdd.ok, true)
    assert.equal(manualAdd.count, 1)
    const manualJobId = manualAdd.job.id

    await waitUntil(() => engine.store.getQueue().find((j) => j.id === manualJobId)?.status === 'completed')
    const completedManual = engine.store.getQueue().find((j) => j.id === manualJobId)
    assert.ok(completedManual.localPath && fs.existsSync(completedManual.localPath))
    assert.equal(completedManual.driveFileId, null)

    engine.store.saveMerkliste(
      engine.store.getMerkItems().map((m) =>
        m.id === 'frieren-id'
          ? {
              ...m,
              history: [
                { id: 'wh-1', season: 1, episode: 1, at: Date.now() - 5000 },
                { id: 'wh-2', season: 1, episode: 2, at: Date.now() },
              ],
            }
          : m,
      ),
    )
    const whRem1 = await fetch(`${engine.url}api/ad/watch-history/remove`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ seriesId: 'frieren-id', entryId: 'wh-1' }),
    }).then((r) => r.json())
    assert.equal(whRem1.ok, true)
    assert.equal(whRem1.merkItems.find((m) => m.id === 'frieren-id').history.length, 1)

    const whClear = await fetch(`${engine.url}api/ad/watch-history/remove`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clearAll: true }),
    }).then((r) => r.json())
    assert.equal(whClear.ok, true)
    assert.equal(whClear.merkItems.find((m) => m.id === 'frieren-id').history.length, 0)

    const sampleLog = engine.store.getLogs(1)[0]
    assert.ok(sampleLog)
    const logRem = await fetch(`${engine.url}api/ad/logs/remove`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: sampleLog.id }),
    }).then((r) => r.json())
    assert.equal(logRem.ok, true)
    assert.ok(!logRem.logs.some((l) => l.id === sampleLog.id))

    const dlKeysBefore = Object.keys(engine.store.getEpisodeIndex().downloaded)
    assert.ok(dlKeysBefore.length >= 1)
    const histRem = await fetch(`${engine.url}api/ad/history/remove`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: dlKeysBefore[0] }),
    }).then((r) => r.json())
    assert.equal(histRem.ok, true)
    assert.ok(!histRem.episodeIndex.downloaded[dlKeysBefore[0]])

    const histClear = await fetch(`${engine.url}api/ad/history/clear`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clearEpisodeIndex: true }),
    }).then((r) => r.json())
    assert.equal(histClear.ok, true)
    assert.equal(Object.keys(histClear.episodeIndex.downloaded).length, 0)
    assert.ok(!histClear.queue.some((q) => q.status === 'completed'))

    console.log('13. Prüfe Serienordner-Zuordnung, Zusammenführung doppelter Ordner & abspielbare MP4-Dateien …')
    assert.equal(folderMatchKey("Frieren: Beyond Journey's End"), folderMatchKey('frieren - beyond journeys end'))
    assert.equal(folderMatchKey('Kaguya-sama: Love is War'), folderMatchKey('Kaguya Sama Love Is War'))
    assert.equal(folderMatchKey('Für Elise'), folderMatchKey('Fuer Elise'))
    assert.notEqual(folderMatchKey('Frieren'), folderMatchKey('Frieren 2'))
    assert.equal(seasonNumberFromFolderName('Staffel 2'), 2)
    assert.equal(seasonNumberFromFolderName('Season 02'), 2)
    assert.equal(seasonNumberFromFolderName('S2'), 2)
    assert.equal(seasonNumberFromFolderName('Filme'), 0)
    assert.equal(seasonNumberFromFolderName('Extras Teil 2'), null)

    const tsPacket = Buffer.alloc(188 * 4)
    for (let i = 0; i < 4; i += 1) tsPacket[i * 188] = 0x47
    assert.equal(sniffMediaBuffer(tsPacket), 'ts')
    assert.equal(sniffMediaBuffer(Buffer.from('\0\0\0\x18ftypisom\0\0\0\0', 'latin1')), 'mp4')
    assert.equal(sniffMediaBuffer(Buffer.from('<!DOCTYPE html><html><body>403</body></html>')), 'html')
    assert.equal(sniffMediaBuffer(Buffer.from('#EXTM3U\n#EXT-X-VERSION:3\nseg0.ts\n')), 'playlist')
    assert.equal(sniffMediaBuffer(crypto.randomBytes(4096)), 'unknown')

    const ffmpegAvailable = spawnSync('ffmpeg', ['-version']).status === 0
    let realTs = null
    if (ffmpegAvailable) {
      const tsPath = path.join(workDir, 'probe.ts')
      const gen = spawnSync('ffmpeg', [
        '-y', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'testsrc=duration=1:size=160x120:rate=10',
        '-f', 'lavfi', '-i', 'sine=duration=1',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
        '-f', 'mpegts', tsPath,
      ])
      if (gen.status === 0) realTs = fs.readFileSync(tsPath)
    }

    if (realTs) {
      // Hoster liefert eine m3u8-Liste unter ".mp4"-Adresse ohne passenden Content-Type:
      // Ergebnis muss trotzdem ein echtes MP4 sein (kein MPEG-TS mit .mp4-Endung).
      const sneakyServer = http.createServer((req, res) => {
        if (req.url === '/video/sneaky.mp4') {
          res.writeHead(200, { 'content-type': 'application/octet-stream' })
          res.end('#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXTINF:1.0,\nseg0.ts\n#EXT-X-ENDLIST\n')
          return
        }
        if (req.url === '/video/seg0.ts') {
          res.writeHead(200, { 'content-type': 'video/mp2t' })
          res.end(realTs)
          return
        }
        if (req.url === '/video/blocked.mp4') {
          res.writeHead(200, { 'content-type': 'application/octet-stream' })
          res.end('<!DOCTYPE html><html><body>Zugriff verweigert</body></html>')
          return
        }
        res.writeHead(404)
        res.end()
      })
      await new Promise((r) => sneakyServer.listen(0, '127.0.0.1', () => r()))
      const sneakyBase = `http://127.0.0.1:${sneakyServer.address().port}`
      try {
        const add = await fetch(`${engine.url}api/ad/queue/add`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ url: `${sneakyBase}/video/sneaky.mp4` }),
        }).then((r) => r.json())
        assert.equal(add.ok, true)
        await waitUntil(() => engine.store.getQueue().find((j) => j.id === add.job.id)?.status === 'completed')
        const done = engine.store.getQueue().find((j) => j.id === add.job.id)
        assert.ok(done.localPath.endsWith('.mp4'))
        const head = fs.readFileSync(done.localPath).subarray(0, 4096)
        assert.equal(sniffMediaBuffer(head), 'mp4')

        const addBlocked = await fetch(`${engine.url}api/ad/queue/add`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ url: `${sneakyBase}/video/blocked.mp4` }),
        }).then((r) => r.json())
        await waitUntil(() => {
          const j = engine.store.getQueue().find((q) => q.id === addBlocked.job.id)
          return j && j.status !== 'queued' && j.status !== 'downloading' && j.status !== 'uploading'
        })
        const blocked = engine.store.getQueue().find((q) => q.id === addBlocked.job.id)
        assert.notEqual(blocked.status, 'completed')
        assert.ok(!blocked.localPath)
        engine.worker.cancelJob?.(addBlocked.job.id)
      } finally {
        await new Promise((r) => sneakyServer.close(() => r()))
      }
    } else {
      console.log('   (FFmpeg nicht gefunden – MP4-Umpack-Prüfung übersprungen)')
    }

    await engine.driveAuth.setDirectRefreshToken({
      refreshToken: 'mock-refresh',
      accessToken: 'mock-access',
      expiresIn: 3600,
    })
    const ds = engine.driveService
    // Ordner, wie ihn Sondra selbst angelegt hat (andere Schreibweise als der Merklisten-Titel).
    const origSeasonId = await ds.ensureFolderPath(['Serien', 'Kaguya-sama: Love is War', 'Staffel 1'])
    await ds.putBytes([], 'Kaguya - S01E01.mp4', Buffer.from('\0\0\0\x18ftypisom-original-1', 'latin1'), {
      mime: 'video/mp4',
      appProperties: { sondraSerie: 'kaguya-id', sondraStaffel: '1', sondraFolge: '1' },
      folderId: origSeasonId,
    })
    await ds.ensureFolderPath(['Serien', 'Kaguya-sama: Love is War', 'Season 02'])

    const bySeriesId = await ds.resolveSeasonFolder({ seriesId: 'kaguya-id', seriesTitle: 'Kaguya (umbenannt)', season: 1 })
    assert.deepEqual(bySeriesId.segments, ['Serien', 'Kaguya-sama: Love is War', 'Staffel 1'])
    assert.equal(bySeriesId.folderId, origSeasonId)
    const byName = await ds.resolveSeasonFolder({ seriesTitle: 'kaguya sama love is war', season: 2 })
    assert.deepEqual(byName.segments, ['Serien', 'Kaguya-sama: Love is War', 'Season 02'])

    // Gleichzeitige Aufrufe für eine neue Serie dürfen nur EINEN Ordner anlegen.
    const parallel = await Promise.all(
      [1, 2, 3].map(() => ds.resolveSeasonFolder({ seriesTitle: 'Neue Serie', season: 1 })),
    )
    assert.equal(new Set(parallel.map((p) => p.folderId)).size, 1)

    // Altlast: doppelter Ordner mit abweichender Schreibweise → wird beim Abgleich zusammengeführt.
    const dupSeasonId = await ds.ensureFolderPath(['Serien', 'Kaguya Sama - Love Is War', 'Staffel 1'])
    await ds.putBytes([], 'Kaguya - S01E02.mp4', Buffer.from('\0\0\0\x18ftypisom-neu-2', 'latin1'), {
      mime: 'video/mp4',
      appProperties: { sondraSerie: 'kaguya-id', sondraStaffel: '1', sondraFolge: '2' },
      folderId: dupSeasonId,
    })
    await ds.syncMerkliste()
    const treeAfter = await ds.listSondraTree()
    const kaguyaDirs = treeAfter.dirs.filter((d) => /^Serien\/[^/]+$/.test(d.path) && /kaguya/i.test(d.name))
    assert.equal(kaguyaDirs.length, 1)
    assert.equal(kaguyaDirs[0].name, 'Kaguya-sama: Love is War')
    const e2 = treeAfter.files.find((f) => f.name === 'Kaguya - S01E02.mp4')
    assert.equal(e2.path, 'Serien/Kaguya-sama: Love is War/Staffel 1/Kaguya - S01E02.mp4')

    if (realTs) {
      // Bereits hochgeladene MPEG-TS-Datei mit .mp4-Endung wird automatisch repariert.
      const broken = await ds.putBytes([], 'Kaguya - S01E03.mp4', realTs, {
        mime: 'video/mp4',
        appProperties: { sondraSerie: 'kaguya-id', sondraStaffel: '1', sondraFolge: '3' },
        folderId: origSeasonId,
      })
      await engine.scheduler.runCheckCycle({ reason: 'manual', seriesId: 'gibt-es-nicht' })
      const repairedBytes = await ds.readFileBytes(broken.id)
      assert.equal(sniffMediaBuffer(Buffer.from(repairedBytes).subarray(0, 4096)), 'mp4')
    }

    console.log('Alle Prüfungen erfolgreich bestanden.')
  } finally {
    await engine.close()
    await mock.close()
    fs.rmSync(workDir, { recursive: true, force: true })
  }
}

await main()
