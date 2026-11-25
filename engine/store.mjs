import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { normalizeMerkItem, readSharedMerkliste, sharedSqliteBytes } from '../shared/merklisteMerge.mjs'

const MAX_LOGS = 3000

export function defaultConfig(dataDir) {
  const downloadsBase = path.join(os.homedir(), 'Downloads')
  const host = os.hostname() || 'Rechner'
  return {
    enabled: true,
    autostartWindows: true,
    closeToTray: true,
    preventSuspend: true,
    checkIntervalMinutes: 30,
    merkSyncIntervalMinutes: 5,
    concurrency: 1,
    maxBandwidthKbps: 0,
    downloadWindowEnabled: false,
    downloadWindowStart: '23:00',
    downloadWindowEnd: '07:00',
    downloadWindowMode: 'throttle_outside',
    daytimeMaxBandwidthKbps: 1500,

    language: 'auto',
    languagePriority: ['ger_dub', 'ger_sub', 'eng_sub'],
    autoUpgradeLanguage: false,
    waitForPreferredLanguage: true,
    languageWaitFallbackHours: 0,
    mode: 'video',
    videoPref: 'best',
    audioPref: 'high',
    audioFormat: 'original',
    hosterPriority: ['voe', 'filemoon', 'vidmoly', 'streamtape', 'vidoza', 'doodstream'],
    browserCookies: '',
    cookiesFile: '',
    bindAddress: 'default',
    useGpuEncoding: true,

    storageTarget: 'drive_only',
    localDir: path.join(downloadsBase, 'Sondra-AD'),
    localNamingScheme: 'sondra',
    tempDir: path.join(dataDir, 'staging'),
    localArchiveDir: path.join(downloadsBase, 'Sondra-AD-Archiv'),
    webdavUrl: '',
    webdavUsername: '',
    webdavPassword: '',
    webdavBasePath: '/Sondra',

    watchStatuses: ['watching', 'later', 'done'],
    backlogMode: 'from_current',
    lookaheadLimit: 0,
    seriesOverrides: {},

    maxRetries: 6,
    retryBaseMinutes: 5,
    autoRetryOnNetworkRestore: true,

    cleanupEnabled: true,
    pauseOnLowSpace: true,
    maxSondraDriveGb: 0,
    minFreeDriveGb: 2,
    minFreeLocalGb: 5,
    emptyDriveTrashFirst: true,
    deleteWatchedFirst: true,
    keepRecentWatchedCount: 1,
    deleteArchivedWhenFull: false,
    protectUnwatched: true,

    inactivityEnabled: true,
    inactivityDays: 45,
    inactivityActions: ['drive_archive', 'pause_series'],
    archiveCompressHeight: 720,
    archiveDeleteAfterDays: 0,

    deviceName: `Sondra AD · ${host}`.slice(0, 40),
    registerInSondraDevices: true,
    googleClientId: '',
    googleClientSecret: '',
    desktopNotifications: true,
    notifyOnComplete: true,
    notifyOnFailure: true,
    discordWebhookUrl: '',
    telegramBotToken: '',
    telegramChatId: '',
    ntfyUrl: '',
    ntfyToken: '',
    pushoverAppToken: '',
    pushoverUserKey: '',
    remoteAccessToken: '',

    scheduledShutdownEnabled: false,
    scheduledShutdownTime: '03:00',
    scheduledShutdownAction: 'shutdown',
    scheduledShutdownWaitForDownloads: true,
    scheduledShutdownRepeatDaily: false,
    shutdownAfterQueue: false,
  }
}

function writeAtomic(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, content)
  fs.renameSync(tmp, filePath)
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return fallback
  }
}

export function createStore(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true })
  const events = new EventEmitter()
  events.setMaxListeners(100)

  const configFile = path.join(dataDir, 'config.json')
  const queueFile = path.join(dataDir, 'queue.json')
  const historyFile = path.join(dataDir, 'episodes-index.json')
  const merkSqliteFile = path.join(dataDir, 'Sondra-Merkliste.sqlite')
  const merkMetaFile = path.join(dataDir, 'merkliste-meta.json')
  const logsFile = path.join(dataDir, 'logs.jsonl')

  const defaults = defaultConfig(dataDir)
  let config = { ...defaults, ...readJsonSafe(configFile, {}) }
  fs.mkdirSync(config.tempDir, { recursive: true })

  let queue = Array.isArray(readJsonSafe(queueFile, [])) ? readJsonSafe(queueFile, []) : []
  for (const job of queue) {
    if (job.status === 'downloading' || job.status === 'uploading' || job.status === 'processing') {
      job.status = 'queued'
      job.progress = 0
      job.speedBps = 0
      job.etaSeconds = null
      job.updatedAt = Date.now()
    }
  }

  let episodeIndex = readJsonSafe(historyFile, { downloaded: {}, archived: {} })
  if (!episodeIndex.downloaded || typeof episodeIndex.downloaded !== 'object') episodeIndex.downloaded = {}
  if (!episodeIndex.archived || typeof episodeIndex.archived !== 'object') episodeIndex.archived = {}

  let merkItems = []
  let merkRemoved = {}
  let merkAppState = {}
  if (fs.existsSync(merkSqliteFile)) {
    const parsed = readSharedMerkliste(new Uint8Array(fs.readFileSync(merkSqliteFile)))
    if (parsed) {
      merkItems = parsed.items
      merkRemoved = parsed.removed
      merkAppState = parsed.appState
    }
  }
  const merkMeta = readJsonSafe(merkMetaFile, { lastSyncAt: 0, lastCheckAt: 0, nextCheckAt: 0 })

  let logs = []
  if (fs.existsSync(logsFile)) {
    try {
      const lines = fs.readFileSync(logsFile, 'utf8').split('\n').filter(Boolean)
      logs = lines
        .slice(-MAX_LOGS)
        .map((line) => {
          try {
            return JSON.parse(line)
          } catch {
            return null
          }
        })
        .filter(Boolean)
    } catch {
      logs = []
    }
  }

  let saveQueueTimer = null
  const flushQueue = () => {
    if (saveQueueTimer) {
      clearTimeout(saveQueueTimer)
      saveQueueTimer = null
    }
    writeAtomic(queueFile, JSON.stringify(queue, null, 2))
  }
  const scheduleSaveQueue = () => {
    if (saveQueueTimer) return
    saveQueueTimer = setTimeout(flushQueue, 250)
    saveQueueTimer.unref?.()
  }

  const saveConfig = (patch) => {
    config = { ...config, ...patch }
    if (config.tempDir) {
      try {
        fs.mkdirSync(config.tempDir, { recursive: true })
      } catch {}
    }
    writeAtomic(configFile, JSON.stringify(config, null, 2))
    events.emit('change', { type: 'config', config })
    return config
  }

  const saveMerkliste = (items, removed = merkRemoved, appState = merkAppState) => {
    merkItems = items.map((item) => normalizeMerkItem(item))
    merkRemoved = { ...removed }
    merkAppState = { ...appState }
    const bytes = sharedSqliteBytes(merkItems, merkRemoved, merkAppState)
    writeAtomic(merkSqliteFile, Buffer.from(bytes))
    events.emit('change', { type: 'merkliste', count: merkItems.length })
    return merkItems
  }

  const updateMerkMeta = (patch) => {
    Object.assign(merkMeta, patch)
    writeAtomic(merkMetaFile, JSON.stringify(merkMeta, null, 2))
    events.emit('change', { type: 'meta', meta: { ...merkMeta } })
  }

  const saveEpisodeIndex = () => {
    writeAtomic(historyFile, JSON.stringify(episodeIndex, null, 2))
    events.emit('change', { type: 'episodes' })
  }

  const addLog = (entry) => {
    const record = {
      id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      at: Date.now(),
      level: entry.level || 'info',
      category: entry.category || 'system',
      title: String(entry.title || ''),
      message: String(entry.message || ''),
      ...(entry.seriesId ? { seriesId: entry.seriesId } : {}),
      ...(entry.seriesTitle ? { seriesTitle: entry.seriesTitle } : {}),
      ...(typeof entry.season === 'number' ? { season: entry.season } : {}),
      ...(typeof entry.episode === 'number' ? { episode: entry.episode } : {}),
      ...(entry.hoster ? { hoster: entry.hoster } : {}),
      ...(Array.isArray(entry.triedHosters) ? { triedHosters: entry.triedHosters } : {}),
      ...(entry.detail ? { detail: String(entry.detail).slice(0, 600) } : {}),
    }
    logs.push(record)
    if (logs.length > MAX_LOGS) {
      logs = logs.slice(-MAX_LOGS)
      try {
        writeAtomic(logsFile, logs.map((l) => JSON.stringify(l)).join('\n') + '\n')
      } catch {}
    } else {
      try {
        fs.appendFileSync(logsFile, JSON.stringify(record) + '\n')
      } catch {}
    }
    events.emit('log', record)
    return record
  }

  const clearLogs = () => {
    logs = []
    writeAtomic(logsFile, '')
    events.emit('change', { type: 'logs-cleared' })
  }

  const setQueue = (nextQueue, immediate = false) => {
    queue = nextQueue
    if (immediate) flushQueue()
    else scheduleSaveQueue()
    events.emit('queue', queue)
  }

  const patchQueueItem = (id, patch, immediate = false) => {
    let updated = null
    queue = queue.map((item) => {
      if (item.id !== id) return item
      updated = { ...item, ...patch, updatedAt: Date.now() }
      return updated
    })
    if (immediate) flushQueue()
    else scheduleSaveQueue()
    if (updated) events.emit('job', updated)
    return updated
  }

  const episodeKey = (seriesId, season, episode) => `${seriesId}::S${season}E${episode}`

  const markEpisodeDownloaded = (seriesId, season, episode, info) => {
    const key = episodeKey(seriesId, season, episode)
    episodeIndex.downloaded[key] = {
      seriesId,
      season,
      episode,
      at: Date.now(),
      ...info,
    }
    delete episodeIndex.archived[key]
    saveEpisodeIndex()
  }

  const markEpisodeArchived = (seriesId, season, episode, info) => {
    const key = episodeKey(seriesId, season, episode)
    const prev = episodeIndex.downloaded[key] || {}
    episodeIndex.archived[key] = {
      ...prev,
      seriesId,
      season,
      episode,
      archivedAt: Date.now(),
      ...info,
    }
    delete episodeIndex.downloaded[key]
    saveEpisodeIndex()
  }

  const unmarkEpisode = (seriesId, season, episode) => {
    const key = episodeKey(seriesId, season, episode)
    delete episodeIndex.downloaded[key]
    delete episodeIndex.archived[key]
    saveEpisodeIndex()
  }

  const hasEpisode = (seriesId, season, episode) => {
    const key = episodeKey(seriesId, season, episode)
    return Boolean(episodeIndex.downloaded[key] || episodeIndex.archived[key])
  }

  flushQueue()

  return {
    dataDir,
    events,
    getConfig: () => ({ ...config }),
    saveConfig,
    getQueue: () => queue.map((item) => ({ ...item })),
    setQueue,
    patchQueueItem,
    flushQueue,
    getMerkItems: () => merkItems.map((item) => ({ ...item })),
    getMerkRemoved: () => ({ ...merkRemoved }),
    getMerkAppState: () => ({ ...merkAppState }),
    getMerkSqliteBytes: () => sharedSqliteBytes(merkItems, merkRemoved, merkAppState),
    saveMerkliste,
    getMerkMeta: () => ({ ...merkMeta }),
    updateMerkMeta,
    getLogs: (limit = 500) => logs.slice(-limit).reverse(),
    getAllLogs: () => [...logs],
    addLog,
    clearLogs,
    getEpisodeIndex: () => ({
      downloaded: { ...episodeIndex.downloaded },
      archived: { ...episodeIndex.archived },
    }),
    markEpisodeDownloaded,
    markEpisodeArchived,
    unmarkEpisode,
    hasEpisode,
    episodeKey,
  }
}
