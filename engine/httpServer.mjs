import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { createStore } from './store.mjs'
import { createDriveAuth } from './driveAuth.mjs'
import { createDriveService } from './driveService.mjs'
import { createMediaTools } from './mediaTools.mjs'
import { createDownloaderWorker } from './downloaderWorker.mjs'
import { createScheduler } from './scheduler.mjs'
import { createCalendarStore } from './calendar.mjs'
import { dispatchPushNotifications } from './pushNotify.mjs'
import { testWebdavConnection } from './webdavClient.mjs'

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
}

function resolveStaticFile(root, pathname) {
  let decoded
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }
  const resolvedRoot = path.resolve(root)
  const candidate = path.resolve(resolvedRoot, '.' + path.posix.normalize(decoded))
  const inside = candidate === resolvedRoot || candidate.startsWith(resolvedRoot + path.sep)
  if (!inside) return null
  if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
  return path.extname(decoded) ? null : path.join(resolvedRoot, 'index.html')
}

async function readBodyJson(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > 2 * 1024 * 1024) throw new Error('Anfrage zu groß')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw ? JSON.parse(raw) : {}
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(JSON.stringify(payload))
}

function isLoopbackAddress(remoteAddress) {
  const addr = String(remoteAddress || '')
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
}

export async function createEngineServer({
  rootDir,
  dataDir,
  host = '127.0.0.1',
  port = 47210,
  runtimeMode = 'server',
  vault = null,
  openExternal = null,
  builtClientId = '',
  builtClientSecret = '',
  onNotify = null,
  onFocus = null,
  onAutostartChange = null,
  onConfigChange = null,
  onPowerAction = undefined,
  fetchImpl = fetch,
}) {
  const store = createStore(dataDir)
  let driveService = null
  const driveAuth = createDriveAuth({
    dataDir,
    store,
    vault,
    openExternal,
    onConnected: () => {
      onFocus?.()
      if (driveService) {
        void driveService.syncMerkliste().catch(() => {})
        void driveService.heartbeatDeviceRecord().catch(() => {})
      }
    },
    builtClientId,
    builtClientSecret,
    fetchImpl,
  })
  driveService = createDriveService({
    dataDir,
    store,
    driveAuth,
    fetchImpl,
  })
  const mediaTools = createMediaTools({
    dataDir,
    store,
    fetchImpl,
  })
  const worker = createDownloaderWorker({
    store,
    driveAuth,
    driveService,
    mediaTools,
    onNotify,
  })
  const calendarStore = createCalendarStore({ dataDir, store })
  const scheduler = createScheduler({
    store,
    driveAuth,
    driveService,
    mediaTools,
    worker,
    calendarStore,
    onNotify,
    ...(onPowerAction ? { onPowerAction } : {}),
  })

  const sseClients = new Set()
  const broadcastSse = (event, data) => {
    const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const client of sseClients) {
      try {
        client.write(line)
      } catch {
        sseClients.delete(client)
      }
    }
  }

  store.events.on('job', (job) => broadcastSse('job', job))
  store.events.on('queue', (queue) => broadcastSse('queue', queue))
  store.events.on('log', (log) => broadcastSse('log', log))
  store.events.on('status', (st) => broadcastSse('status', st))
  store.events.on('change', (chg) => broadcastSse('change', chg))
  store.events.on('reminder', (line) => broadcastSse('reminder', line))

  const sseHeartbeat = setInterval(() => {
    for (const client of sseClients) {
      try {
        client.write(': ping\n\n')
      } catch {
        sseClients.delete(client)
      }
    }
  }, 20_000)
  sseHeartbeat.unref?.()

  const checkAccess = (req, urlObj) => {
    const cfg = store.getConfig()
    if (!cfg.remoteAccessToken || isLoopbackAddress(req.socket?.remoteAddress)) return true
    if (urlObj.pathname === '/api/ad/drive/callback') return true
    const headerToken = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim()
    const queryToken = urlObj.searchParams.get('token') || ''
    return headerToken === cfg.remoteAccessToken || queryToken === cfg.remoteAccessToken
  }

  const server = http.createServer(async (req, res) => {
    const safeUrl = (req.url ?? '/').replace(/^\/{2,}/, '/')
    const urlObj = new URL(safeUrl, `http://${req.headers.host || 'localhost'}`)
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
    res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless')

    if (urlObj.pathname.startsWith('/api/ad/')) {
      if (!checkAccess(req, urlObj)) {
        return sendJson(res, 401, { ok: false, error: 'Zugangsschlüssel erforderlich.' })
      }

      if (urlObj.pathname === '/api/ad/events' && req.method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
        })
        res.write(`event: ready\ndata: ${JSON.stringify({ at: Date.now() })}\n\n`)
        sseClients.add(res)
        req.on('close', () => sseClients.delete(res))
        return
      }

      try {
        const route = urlObj.pathname.slice('/api/ad/'.length)
        const body = req.method === 'POST' ? await readBodyJson(req) : {}

        if (route === 'bootstrap' && req.method === 'GET') {
          const tools = await mediaTools.getToolsStatus()
          return sendJson(res, 200, {
            ok: true,
            runtimeMode,
            platform: process.platform,
            checking: scheduler.isChecking(),
            shutdownState: scheduler.getShutdownState(),
            config: store.getConfig(),
            drive: driveAuth.getStatus(),
            tools,
            merkItems: store.getMerkItems(),
            merkMeta: store.getMerkMeta(),
            queue: store.getQueue(),
            episodeIndex: store.getEpisodeIndex(),
            logs: store.getLogs(400),
            calendar: calendarStore.snapshot(),
          })
        }

        if (route === 'calendar' && req.method === 'GET') {
          return sendJson(res, 200, { ok: true, calendar: calendarStore.snapshot() })
        }

        if (route === 'calendar/event' && req.method === 'POST') {
          const saved = calendarStore.saveEvent(body.event || {})
          if (!saved) return sendJson(res, 400, { ok: false, error: 'Der Eintrag konnte nicht gespeichert werden.' })
          return sendJson(res, 200, { ok: true, event: saved, calendar: calendarStore.snapshot() })
        }

        if (route === 'calendar/event/delete' && req.method === 'POST') {
          calendarStore.deleteEvent(String(body.id || ''))
          return sendJson(res, 200, { ok: true, calendar: calendarStore.snapshot() })
        }

        if (route === 'calendar/airing' && req.method === 'POST') {
          const seriesId = String(body.seriesId || '')
          if (!seriesId) return sendJson(res, 400, { ok: false, error: 'seriesId fehlt' })
          const result = calendarStore.setAiring(seriesId, body.airing || null)
          if (body.airing && !result) return sendJson(res, 400, { ok: false, error: 'Ungültiger Sendetag.' })
          return sendJson(res, 200, { ok: true, calendar: calendarStore.snapshot() })
        }

        if (route === 'config' && req.method === 'POST') {
          const prev = store.getConfig()
          const updated = store.saveConfig(body || {})
          if (typeof body.autostartWindows === 'boolean' && body.autostartWindows !== prev.autostartWindows) {
            await onAutostartChange?.(body.autostartWindows)
          }
          onConfigChange?.(updated)
          const shutdownState = scheduler.recomputeShutdownSchedule()
          if (updated.enabled && !prev.enabled) {
            void worker.pumpQueue()
          }
          return sendJson(res, 200, {
            ok: true,
            config: updated,
            drive: driveAuth.getStatus(),
            shutdownState,
          })
        }

        if (route === 'power/cancel-shutdown' && req.method === 'POST') {
          const shutdownState = scheduler.cancelPendingShutdown()
          return sendJson(res, 200, { ok: true, shutdownState, config: store.getConfig() })
        }

        if (route === 'power/after-queue' && req.method === 'POST') {
          const shutdownState = scheduler.setShutdownAfterQueue(Boolean(body.enabled))
          return sendJson(res, 200, { ok: true, shutdownState, config: store.getConfig() })
        }

        if (route === 'notifications/test' && req.method === 'POST') {
          const cfg = { ...store.getConfig(), ...(body || {}) }
          const results = await dispatchPushNotifications(cfg, {
            title: 'Sondra AD · Test-Meldung',
            body: 'Push-Benachrichtigungen sind korrekt eingerichtet.',
            level: 'info',
          })
          return sendJson(res, 200, { ok: true, results })
        }

        if (route === 'storage/test-webdav' && req.method === 'POST') {
          const cfg = { ...store.getConfig(), ...(body || {}) }
          const result = await testWebdavConnection({
            url: cfg.webdavUrl,
            username: cfg.webdavUsername,
            password: cfg.webdavPassword,
            basePath: cfg.webdavBasePath,
          })
          return sendJson(res, 200, result)
        }

        if (route === 'toggle' && req.method === 'POST') {
          const cur = store.getConfig()
          const nextEnabled = typeof body.enabled === 'boolean' ? body.enabled : !cur.enabled
          const updated = store.saveConfig({ enabled: nextEnabled })
          onConfigChange?.(updated)
          store.addLog({
            category: 'system',
            title: nextEnabled ? 'Auto-Downloader fortgesetzt' : 'Auto-Downloader pausiert',
            message: nextEnabled
              ? 'Hintergrund-Überwachung und Warteschlange sind aktiv.'
              : 'Automatische Prüfungen und Downloads wurden angehalten.',
          })
          if (nextEnabled) void worker.pumpQueue()
          return sendJson(res, 200, { ok: true, enabled: updated.enabled, config: updated })
        }

        if (route === 'check-now' && req.method === 'POST') {
          const result = await scheduler.runCheckCycle({
            reason: 'manual',
            seriesId: body.seriesId || null,
          })
          return sendJson(res, 200, {
            ...result,
            merkItems: store.getMerkItems(),
            merkMeta: store.getMerkMeta(),
            queue: store.getQueue(),
          })
        }

        if (route === 'merkliste/sync' && req.method === 'POST') {
          const result = await driveService.syncMerkliste()
          return sendJson(res, 200, {
            ...result,
            merkItems: store.getMerkItems(),
            merkMeta: store.getMerkMeta(),
            episodeIndex: store.getEpisodeIndex(),
          })
        }

        if (route === 'merkliste/upsert' && req.method === 'POST') {
          const { normalizeMerkItem } = await import('../shared/merklisteMerge.mjs')
          const current = store.getMerkItems()
          const incoming = normalizeMerkItem({
            ...body,
            updatedAt: Date.now(),
          })
          const existingIdx = current.findIndex((i) => i.id === incoming.id)
          const next =
            existingIdx >= 0
              ? current.map((entry, idx) => (idx === existingIdx ? { ...entry, ...incoming, updatedAt: Date.now() } : entry))
              : [incoming, ...current]
          const removed = store.getMerkRemoved()
          delete removed[incoming.id]
          store.saveMerkliste(next, removed)
          if (driveAuth.isConnected()) {
            await driveService.pushMerkliste().catch(() => {})
          }
          if (body.checkImmediately !== false && incoming.url) {
            void scheduler.runCheckCycle({ reason: 'manual', seriesId: incoming.id })
          }
          return sendJson(res, 200, { ok: true, item: incoming, merkItems: store.getMerkItems() })
        }

        if (route === 'merkliste/remove' && req.method === 'POST') {
          const id = String(body.id || '')
          const next = store.getMerkItems().filter((i) => i.id !== id)
          const removed = { ...store.getMerkRemoved(), [id]: Date.now() }
          store.saveMerkliste(next, removed)
          if (driveAuth.isConnected()) {
            await driveService.pushMerkliste().catch(() => {})
          }
          return sendJson(res, 200, { ok: true, merkItems: store.getMerkItems() })
        }

        if (route === 'merkliste/series-override' && req.method === 'POST') {
          const seriesId = String(body.seriesId || '')
          if (!seriesId) return sendJson(res, 400, { ok: false, error: 'seriesId fehlt' })
          const cfg = store.getConfig()
          const overrides = { ...(cfg.seriesOverrides || {}) }
          if (body.reset) {
            delete overrides[seriesId]
          } else {
            overrides[seriesId] = { ...(body.override || {}) }
          }
          const updated = store.saveConfig({ seriesOverrides: overrides })
          return sendJson(res, 200, { ok: true, config: updated })
        }

        if (route === 'queue/add' && req.method === 'POST') {
          const result = await scheduler.enqueueManualUrl(body)
          return sendJson(res, 200, { ok: true, ...result, queue: store.getQueue() })
        }

        if (route === 'queue/retry' && req.method === 'POST') {
          const job = worker.retryJob(String(body.id || ''), body.preferredHoster ?? null)
          return sendJson(res, 200, { ok: true, job, queue: store.getQueue() })
        }

        if (route === 'queue/retry-all' && req.method === 'POST') {
          const count = worker.retryAllFailed()
          return sendJson(res, 200, { ok: true, count, queue: store.getQueue() })
        }

        if (route === 'queue/cancel' && req.method === 'POST') {
          worker.cancelJob(String(body.id || ''))
          return sendJson(res, 200, { ok: true, queue: store.getQueue() })
        }

        if (route === 'queue/cancel-all' && req.method === 'POST') {
          const count = worker.cancelAllJobs()
          return sendJson(res, 200, { ok: true, count, queue: store.getQueue() })
        }

        if (route === 'queue/remove' && req.method === 'POST') {
          worker.removeJob(String(body.id || ''))
          return sendJson(res, 200, { ok: true, queue: store.getQueue() })
        }

        if (route === 'queue/clear-completed' && req.method === 'POST') {
          worker.clearCompletedJobs()
          return sendJson(res, 200, { ok: true, queue: store.getQueue() })
        }

        if (route === 'history/remove' && req.method === 'POST') {
          if (body.key) {
            store.removeDownloadHistoryEntry(String(body.key))
          }
          if (body.jobId) {
            worker.removeJob(String(body.jobId))
          }
          return sendJson(res, 200, {
            ok: true,
            episodeIndex: store.getEpisodeIndex(),
            queue: store.getQueue(),
          })
        }

        if (route === 'history/clear' && req.method === 'POST') {
          worker.clearCompletedJobs()
          if (body.clearEpisodeIndex !== false) {
            store.clearDownloadHistory()
          }
          return sendJson(res, 200, {
            ok: true,
            episodeIndex: store.getEpisodeIndex(),
            queue: store.getQueue(),
          })
        }

        if (route === 'watch-history/remove' && req.method === 'POST') {
          const now = Date.now()
          if (body.clearAll) {
            const next = store.getMerkItems().map((item) =>
              Array.isArray(item.history) && item.history.length > 0
                ? { ...item, history: [], updatedAt: now }
                : item,
            )
            store.saveMerkliste(next)
          } else {
            const sid = String(body.seriesId || '')
            const eid = String(body.entryId || '')
            const next = store.getMerkItems().map((item) => {
              if (item.id !== sid) return item
              const target = (item.history || []).find((h) => h.id === eid)
              const nextHistory = (item.history || []).filter((h) => h.id !== eid)
              let nextSeasons = item.seasons
              if (body.undoWatched && target && Array.isArray(item.seasons)) {
                nextSeasons = item.seasons.map((s) =>
                  s.number === target.season
                    ? { ...s, watched: (s.watched || []).filter((ep) => ep !== target.episode) }
                    : s,
                )
              }
              return {
                ...item,
                history: nextHistory,
                ...(nextSeasons ? { seasons: nextSeasons } : {}),
                updatedAt: now,
              }
            })
            store.saveMerkliste(next)
          }
          if (driveAuth.isConnected()) {
            void driveService.pushMerkliste().catch(() => {})
          }
          return sendJson(res, 200, { ok: true, merkItems: store.getMerkItems() })
        }

        if (route === 'storage' && req.method === 'GET') {
          const info = await driveService.inspectStorage()
          return sendJson(res, 200, { ok: true, storage: info, episodeIndex: store.getEpisodeIndex() })
        }

        if (route === 'storage/cleanup' && req.method === 'POST') {
          const result = await scheduler.runStorageCleanup({ dryRun: Boolean(body.dryRun) })
          const storage = await driveService.inspectStorage().catch(() => null)
          return sendJson(res, 200, { ...result, storage, episodeIndex: store.getEpisodeIndex() })
        }

        if (route === 'archive/run' && req.method === 'POST') {
          const result = await scheduler.runInactivityCheck({ dryRun: Boolean(body.dryRun) })
          const storage = await driveService.inspectStorage().catch(() => null)
          return sendJson(res, 200, { ...result, storage, episodeIndex: store.getEpisodeIndex() })
        }

        if (route === 'archive/restore' && req.method === 'POST') {
          const result = await scheduler.restoreFromArchive(body)
          const storage = await driveService.inspectStorage().catch(() => null)
          return sendJson(res, 200, { ...result, storage, episodeIndex: store.getEpisodeIndex() })
        }

        if (route === 'logs' && req.method === 'GET') {
          return sendJson(res, 200, { ok: true, logs: store.getLogs(1000) })
        }

        if (route === 'logs/remove' && req.method === 'POST') {
          store.removeLog(String(body.id || ''))
          return sendJson(res, 200, { ok: true, logs: store.getLogs(1000) })
        }

        if (route === 'logs/clear' && req.method === 'POST') {
          store.clearLogs()
          return sendJson(res, 200, { ok: true, logs: [] })
        }

        if (route === 'drive/start' && req.method === 'POST') {
          const origin = body.origin || `${urlObj.protocol}//${urlObj.host}`
          const flow = await driveAuth.startAuthFlow({
            origin,
            openBrowser: Boolean(body.openBrowser),
          })
          return sendJson(res, 200, { ok: true, ...flow, drive: driveAuth.getStatus() })
        }

        if (route === 'drive/callback' && req.method === 'POST') {
          const status = await driveAuth.completeCallback(body.input ?? body)
          if (status.connected) {
            void driveService.syncMerkliste().catch(() => {})
            void driveService.heartbeatDeviceRecord().catch(() => {})
          }
          return sendJson(res, 200, { ok: true, drive: status, merkItems: store.getMerkItems() })
        }

        if (route === 'drive/disconnect' && req.method === 'POST') {
          const status = await driveAuth.disconnect()
          return sendJson(res, 200, { ok: true, drive: status })
        }

        if (route === 'sondra/import' && req.method === 'POST') {
          const imported = await driveAuth.importFromLocalSondra(body.customDir || '')
          if (driveAuth.isConnected()) {
            await driveService.syncMerkliste().catch(() => {})
            await driveService.heartbeatDeviceRecord().catch(() => {})
          }
          return sendJson(res, 200, {
            ok: true,
            imported,
            config: store.getConfig(),
            drive: driveAuth.getStatus(),
            merkItems: store.getMerkItems(),
          })
        }

        if (route === 'pairing/export' && req.method === 'POST') {
          const bundle = driveAuth.exportPairing(body.passphrase)
          return sendJson(res, 200, { ok: true, bundle })
        }

        if (route === 'pairing/import' && req.method === 'POST') {
          const status = await driveAuth.importPairing(body.bundle, body.passphrase)
          if (status.connected) {
            await driveService.syncMerkliste().catch(() => {})
            await driveService.heartbeatDeviceRecord().catch(() => {})
          }
          return sendJson(res, 200, {
            ok: true,
            drive: status,
            config: store.getConfig(),
            merkItems: store.getMerkItems(),
          })
        }

        if (route === 'cookies/upload' && req.method === 'POST') {
          const content = String(body.content || '')
          if (!content.trim()) {
            store.saveConfig({ cookiesFile: '' })
            return sendJson(res, 200, { ok: true, config: store.getConfig() })
          }
          const target = path.join(dataDir, 'cookies.txt')
          fs.writeFileSync(target, content, { mode: 0o600 })
          const updated = store.saveConfig({ cookiesFile: target })
          store.addLog({
            category: 'system',
            title: 'Portal-Cookies hinterlegt',
            message: `cookies.txt (${content.split('\n').length} Zeilen) gespeichert.`,
          })
          return sendJson(res, 200, { ok: true, config: updated })
        }

        if (route === 'tools/install-ytdlp' && req.method === 'POST') {
          await mediaTools.installYtdlp()
          const tools = await mediaTools.getToolsStatus()
          return sendJson(res, 200, { ok: true, tools })
        }

        if (route === 'devices/heartbeat' && req.method === 'POST') {
          const resHb = await driveService.heartbeatDeviceRecord()
          return sendJson(res, 200, { ok: true, result: resHb })
        }

        return sendJson(res, 404, { ok: false, error: 'Unbekannter Endpunkt' })
      } catch (err) {
        return sendJson(res, 400, {
          ok: false,
          error: String(err?.message ?? err),
        })
      }
    }

    if (!rootDir || !fs.existsSync(path.join(rootDir, 'index.html'))) {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Sondra AD Hintergrund-Dienst läuft.')
      return
    }

    const staticFile = resolveStaticFile(rootDir, urlObj.pathname)
    if (!staticFile) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Nicht gefunden.')
      return
    }

    res.setHeader('Content-Type', MIME_TYPES[path.extname(staticFile).toLowerCase()] ?? 'application/octet-stream')
    if (staticFile.includes(`${path.sep}assets${path.sep}`)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
    } else {
      res.setHeader('Cache-Control', 'no-cache')
    }
    const stream = fs.createReadStream(staticFile)
    stream.on('error', () => {
      if (!res.headersSent) res.statusCode = 500
      res.end()
    })
    stream.pipe(res)
  })

  const listenOn = (candidatePort) =>
    new Promise((resolve, reject) => {
      const onError = (err) => {
        server.off('listening', onListening)
        reject(err)
      }
      const onListening = () => {
        server.off('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(candidatePort, host)
    })

  let bound = false
  for (let attempt = 0; attempt < 10 && !bound; attempt += 1) {
    try {
      await listenOn(port)
      bound = true
    } catch (err) {
      if (err.code !== 'EADDRINUSE' && err.code !== 'EACCES') throw err
      if (port === 0 || err.code === 'EACCES') break
      await new Promise((r) => setTimeout(r, 200))
    }
  }
  if (!bound) {
    await listenOn(0)
  }

  const boundPort = server.address().port
  const displayHost = host === '0.0.0.0' ? '127.0.0.1' : host
  const url = `http://${displayHost}:${boundPort}/`

  scheduler.start()

  const close = async () => {
    scheduler.stop()
    clearInterval(sseHeartbeat)
    for (const c of sseClients) {
      try {
        c.end()
      } catch {}
    }
    sseClients.clear()
    store.flushQueue()
    await new Promise((resolve) => server.close(() => resolve()))
  }

  return {
    server,
    url,
    port: boundPort,
    store,
    driveAuth,
    driveService,
    mediaTools,
    worker,
    scheduler,
    close,
  }
}
