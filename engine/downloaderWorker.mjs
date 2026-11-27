import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  DEFAULT_USER_AGENT,
  boundedFetch,
  extractDirectMedia,
  is9AnimeUrl,
  isAnimeKaizenUrl,
  isAniworldUrl,
  isBilibiliUrl,
  isGoogleDriveUrl,
  isHosterUrl,
  isMvflixUrl,
  isPodcastOrRssUrl,
  isSpotifyUrl,
} from '../api/extractors.js'
import {
  folderMatchKey,
  hintProperties,
  seasonFolderName,
  seasonNumberFromFolderName,
  seriesFolderName,
} from '../shared/merklisteMerge.mjs'
import { extensionForKind, isFragmentedMp4, isNonMediaKind, sniffMediaFile, sniffMediaBuffer } from './mediaCheck.mjs'
import { resolveBindIpv4 } from './mediaTools.mjs'
import { dispatchPushNotifications } from './pushNotify.mjs'
import { deleteWebdavFile, uploadFileToWebdav } from './webdavClient.mjs'

function parseMinutesOfDay(timeStr) {
  const m = String(timeStr || '').trim().match(/^(\d{1,2}):(\d{2})$/)
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h < 0 || h > 23 || min < 0 || min > 59) return null
  return h * 60 + min
}

export function isInsideTimeWindow(startStr, endStr, nowMs = Date.now()) {
  const start = parseMinutesOfDay(startStr)
  const end = parseMinutesOfDay(endStr)
  if (start === null || end === null || start === end) return true
  const d = new Date(nowMs)
  const cur = d.getHours() * 60 + d.getMinutes()
  if (start < end) {
    return cur >= start && cur < end
  }
  return cur >= start || cur < end
}

export function resolveEffectiveBandwidthKbps(cfg, nowMs = Date.now()) {
  const baseLimit = Math.max(0, Number(cfg?.maxBandwidthKbps) || 0)
  if (!cfg?.downloadWindowEnabled) {
    return { allowed: true, maxBandwidthKbps: baseLimit, inWindow: true }
  }
  const inWindow = isInsideTimeWindow(cfg.downloadWindowStart, cfg.downloadWindowEnd, nowMs)
  if (inWindow) {
    return { allowed: true, maxBandwidthKbps: baseLimit, inWindow: true }
  }
  if (cfg.downloadWindowMode === 'pause_outside') {
    return { allowed: false, maxBandwidthKbps: 0, inWindow: false }
  }
  const dayLimit = Math.max(50, Number(cfg.daytimeMaxBandwidthKbps) || 1500)
  return { allowed: true, maxBandwidthKbps: dayLimit, inWindow: false }
}

export function getLocalFreeBytes(dirPath) {
  try {
    fs.mkdirSync(dirPath, { recursive: true })
    const st = fs.statfsSync(dirPath)
    if (Number(st.blocks) <= 0 || Number(st.bsize) <= 0) return null
    const avail = st.bavail ?? st.bfree
    return Number(avail) * Number(st.bsize)
  } catch {
    return null
  }
}

export function getSeriesUsedBytes(store, seriesId) {
  if (!seriesId) return 0
  const idx = store.getEpisodeIndex()?.downloaded || {}
  let total = 0
  for (const rec of Object.values(idx)) {
    if (rec && rec.seriesId === seriesId && typeof rec.sizeBytes === 'number') {
      total += rec.sizeBytes
    }
  }
  return total
}

function streamSlugOf(rawUrl) {
  const m = String(rawUrl || '').match(/\/(?:anime|serie)\/stream\/([^/?#]+)/i)
  return m ? m[1].toLowerCase() : null
}

/**
 * Sucht unter `baseDir` einen bereits vorhandenen Ordner mit gleichem Namen
 * (unabhängig von Groß-/Kleinschreibung und Sonderzeichen) und gibt dessen Namen zurück.
 */
function findExistingLocalDir(baseDir, wantedName, matcher) {
  try {
    const entries = fs.readdirSync(baseDir, { withFileTypes: true }).filter((e) => e.isDirectory())
    const exact = entries.find((e) => e.name === wantedName)
    if (exact) return exact.name
    const hit = entries.find((e) => matcher(e.name))
    return hit ? hit.name : null
  } catch {
    return null
  }
}

function resolveLocalSeasonDir(baseDir, seriesTitle, season, scheme) {
  const wantedSeries = seriesFolderName(seriesTitle)
  const key = folderMatchKey(wantedSeries)
  const seriesName =
    findExistingLocalDir(baseDir, wantedSeries, (n) => Boolean(key) && folderMatchKey(n) === key) || wantedSeries
  const seriesDir = path.join(baseDir, seriesName)
  const wantedSeason = localSeasonDirName(season, scheme)
  const seasonNum = Number(season)
  const seasonName =
    findExistingLocalDir(seriesDir, wantedSeason, (n) => seasonNumberFromFolderName(n) === seasonNum) || wantedSeason
  return { dir: path.join(seriesDir, seasonName), segments: [seriesName, seasonName] }
}

function localSeasonDirName(season, scheme) {
  if (scheme === 'jellyfin') {
    if (Number(season) === 0) return 'Specials'
    return `Season ${String(season).padStart(2, '0')}`
  }
  return seasonFolderName(season)
}

function sanitizeFileName(raw) {
  return (
    String(raw || 'Episode')
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 160) || 'Episode'
  )
}

function formatEpisodeTag(season, episode) {
  if (Number(season) === 0) return `Film ${episode}`
  return `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`
}

function mimeForExt(ext, mode) {
  const clean = String(ext || '').toLowerCase().replace(/^\./, '')
  const map = {
    mp4: 'video/mp4',
    m4v: 'video/mp4',
    mkv: 'video/x-matroska',
    webm: 'video/webm',
    ts: 'video/mp2t',
    mp3: 'audio/mpeg',
    m4a: 'audio/mp4',
    flac: 'audio/flac',
    opus: 'audio/ogg',
    ogg: 'audio/ogg',
    wav: 'audio/wav',
  }
  return map[clean] || (mode === 'audio' ? 'audio/mp4' : 'video/mp4')
}

export function computeRetryDelayMs(attempt, baseMinutes = 5) {
  const baseMs = Math.max(0.1, Number(baseMinutes) || 5) * 60_000
  const mult = Math.pow(3, Math.max(0, attempt - 1))
  return Math.min(12 * 60 * 60_000, Math.round(baseMs * mult))
}

function buildStreamHeaders(referer) {
  let origin = null
  if (referer) {
    try {
      origin = new URL(referer).origin
    } catch {
      origin = null
    }
  }
  return {
    'User-Agent': DEFAULT_USER_AGENT,
    ...(referer ? { Referer: referer, ...(origin ? { Origin: origin } : {}) } : {}),
  }
}

async function streamUrlToFile(url, destFile, { referer, localAddress, maxBandwidthKbps = 0, onProgress, signal } = {}) {
  const headers = buildStreamHeaders(referer)
  const res = await boundedFetch(url, {
    headers,
    localAddress,
    signal,
    timeout: 30_000,
  })
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} beim Laden des Streams`)
  }
  const total = Number(res.headers.get('content-length')) || 0
  const contentType = String(res.headers.get('content-type') || '')
  // HLS-Segmente sind MPEG-TS – niemals unter ".mp4" ablegen, sonst ist die Datei
  // für Drive, Browser und Windows-Player unbrauchbar. Später wird sie umgepackt.
  const hlsDest = /\.ts$/i.test(destFile) ? destFile : destFile.replace(/\.[^./\\]+$/, '') + '.ts'
  if (/mpegurl/i.test(contentType) || /\.m3u8(?:$|\?)/i.test(url)) {
    const text = await res.text()
    if (text.replace(/^\uFEFF/, '').trimStart().startsWith('#EXTM3U')) {
      return downloadHlsSegmentsNative(text, res.url || url, hlsDest, {
        referer,
        localAddress,
        maxBandwidthKbps,
        onProgress,
        signal,
      })
    }
    throw new Error('Hoster lieferte statt eines Videos eine ungültige Wiedergabeliste.')
  }

  const reader = res.body?.getReader()
  if (!reader) throw new Error('Stream enthielt keine Daten.')

  // Erste Bytes ansehen: Manche Hoster schicken die m3u8-Liste ohne passenden Content-Type.
  let firstChunk = null
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value && value.byteLength > 0) {
      firstChunk = value
      break
    }
  }
  if (!firstChunk) throw new Error('Empfangene Datei war leer (0 Bytes).')
  const firstKind = sniffMediaBuffer(Buffer.from(firstChunk.buffer, firstChunk.byteOffset, Math.min(firstChunk.byteLength, 4096)))
  if (firstKind === 'playlist') {
    const parts = [Buffer.from(firstChunk)]
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      parts.push(Buffer.from(value))
    }
    return downloadHlsSegmentsNative(Buffer.concat(parts).toString('utf8'), res.url || url, hlsDest, {
      referer,
      localAddress,
      maxBandwidthKbps,
      onProgress,
      signal,
    })
  }
  if (firstKind === 'html') {
    try {
      await reader.cancel()
    } catch {}
    throw new Error('Hoster lieferte statt eines Videos eine Webseite (vermutlich gesperrt oder abgelaufen).')
  }

  fs.mkdirSync(path.dirname(destFile), { recursive: true })
  const out = fs.createWriteStream(destFile)
  let loaded = 0
  const startedAt = Date.now()
  let lastReport = 0
  let pendingChunk = firstChunk

  try {
    for (;;) {
      if (signal?.aborted) throw new Error('Abgebrochen')
      let done = false
      let value
      if (pendingChunk) {
        value = pendingChunk
        pendingChunk = null
      } else {
        ;({ done, value } = await reader.read())
      }
      if (done) break
      loaded += value.byteLength
      if (!out.write(Buffer.from(value))) {
        await new Promise((r) => out.once('drain', r))
      }
      if (maxBandwidthKbps > 0) {
        const expectedMs = (loaded / (maxBandwidthKbps * 1024)) * 1000
        const elapsedMs = Date.now() - startedAt
        if (expectedMs > elapsedMs + 40) {
          await new Promise((r) => setTimeout(r, Math.min(1000, expectedMs - elapsedMs)))
        }
      }
      const now = Date.now()
      if (onProgress && now - lastReport >= 200) {
        lastReport = now
        const elapsedSec = Math.max(0.2, (now - startedAt) / 1000)
        const speedBps = Math.round(loaded / elapsedSec)
        const etaSeconds = total > loaded && speedBps > 0 ? Math.round((total - loaded) / speedBps) : null
        onProgress({
          pct: total > 0 ? Math.min(99, Math.round((loaded / total) * 100)) : 0,
          loaded,
          total,
          speedBps,
          etaSeconds,
        })
      }
    }
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())))
  } catch (err) {
    out.destroy()
    try {
      fs.rmSync(destFile, { force: true })
    } catch {}
    throw err
  }

  if (loaded === 0) {
    fs.rmSync(destFile, { force: true })
    throw new Error('Empfangene Datei war leer (0 Bytes).')
  }
  return destFile
}

export async function downloadHlsSegmentsNative(
  playlistText,
  baseUrl,
  destFile,
  { referer, localAddress, maxBandwidthKbps = 0, onProgress, signal, maxHeight = 0 } = {},
) {
  let activeText = playlistText
  let activeBase = baseUrl
  const headers = buildStreamHeaders(referer)

  const masterLines = activeText.split(/\r?\n/).map((l) => l.trim())
  if (masterLines.some((l) => l.startsWith('#EXT-X-MEDIA') && /TYPE=AUDIO/i.test(l) && /URI=/i.test(l))) {
    throw new Error('HLS besitzt separate Tonspur')
  }

  const variants = []
  for (let i = 0; i < masterLines.length; i += 1) {
    if (masterLines[i].startsWith('#EXT-X-STREAM-INF')) {
      const resMatch = masterLines[i].match(/RESOLUTION=(\d+)x(\d+)/i)
      const bwMatch = masterLines[i].match(/BANDWIDTH=(\d+)/i)
      const nextUri = masterLines.slice(i + 1).find((l) => l && !l.startsWith('#'))
      if (nextUri) {
        variants.push({
          height: resMatch ? Number(resMatch[2]) : 0,
          bandwidth: bwMatch ? Number(bwMatch[1]) : 0,
          url: new URL(nextUri, activeBase).href,
        })
      }
    }
  }

  if (variants.length > 0) {
    variants.sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth)
    const fitting = maxHeight > 0 ? variants.filter((v) => v.height <= maxHeight) : []
    const chosen = fitting.length > 0 ? fitting[0] : variants[0]
    const subRes = await boundedFetch(chosen.url, {
      headers,
      localAddress,
      signal,
    })
    if (!subRes.ok) throw new Error(`HLS-Variante nicht erreichbar (${subRes.status})`)
    activeText = await subRes.text()
    activeBase = subRes.url || chosen.url
  }

  const mediaLines = activeText.split(/\r?\n/).map((l) => l.trim())
  let mediaSequence = 0
  let currentMapUrl = null
  let currentKey = null
  const segments = []

  for (const line of mediaLines) {
    if (!line) continue
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      const seqMatch = line.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/i)
      if (seqMatch) mediaSequence = Number(seqMatch[1])
      continue
    }
    if (line.startsWith('#EXT-X-MAP:')) {
      const uriMatch = line.match(/URI="([^"]+)"/i) || line.match(/URI=([^,\s]+)/i)
      if (uriMatch && uriMatch[1]) {
        currentMapUrl = new URL(uriMatch[1], activeBase).href
      }
      continue
    }
    if (line.startsWith('#EXT-X-KEY:')) {
      const methodMatch = line.match(/METHOD=([^,\s]+)/i)
      const method = methodMatch ? methodMatch[1].replace(/^"|"$/g, '').toUpperCase() : 'NONE'
      if (method === 'NONE') {
        currentKey = null
      } else if (method === 'AES-128') {
        const uriMatch = line.match(/URI="([^"]+)"/i) || line.match(/URI=([^,\s]+)/i)
        const ivMatch = line.match(/IV=0x([0-9a-fA-F]+)/i)
        if (!uriMatch || !uriMatch[1]) {
          throw new Error('HLS-Schlüsseladresse fehlt.')
        }
        currentKey = {
          method: 'AES-128',
          uri: new URL(uriMatch[1], activeBase).href,
          ivHex: ivMatch ? ivMatch[1] : null,
        }
      } else {
        throw new Error(`Nicht unterstützte HLS-Verschlüsselung: ${method}`)
      }
      continue
    }
    if (line.startsWith('#')) continue
    const segIndex = segments.length
    segments.push({
      url: new URL(line, activeBase).href,
      seq: mediaSequence + segIndex,
      key: currentKey,
      mapUrl: currentMapUrl,
    })
  }

  if (segments.length === 0) {
    throw new Error('HLS-Wiedergabeliste enthält keine Segmente.')
  }

  const hasFmp4 = segments.some((s) => s.mapUrl || /\.(?:m4s|mp4|cmfv)(?:$|\?)/i.test(s.url))
  const actualDestFile = hasFmp4 && destFile.endsWith('.ts') ? `${destFile.slice(0, -3)}.mp4` : destFile

  const fetchBufferWithRetry = async (targetUrl, label) => {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      if (signal?.aborted) throw new Error('Abgebrochen')
      try {
        const res = await boundedFetch(targetUrl, {
          headers,
          localAddress,
          signal,
          timeout: 25_000,
        })
        if (!res.ok) throw new Error(`${label} fehlgeschlagen (${res.status})`)
        return Buffer.from(await res.arrayBuffer())
      } catch (err) {
        if (signal?.aborted || attempt === 3) throw err
        await new Promise((r) => setTimeout(r, 350 * attempt))
      }
    }
    throw new Error(`${label} fehlgeschlagen`)
  }

  const keyCache = new Map()
  const decryptBuffer = async (buf, keySpec, seq) => {
    if (!keySpec) return buf
    let keyBuf = keyCache.get(keySpec.uri)
    if (!keyBuf) {
      keyBuf = await fetchBufferWithRetry(keySpec.uri, 'HLS-Schlüssel')
      if (keyBuf.byteLength !== 16) {
        throw new Error(`Ungültige HLS-Schlüssellänge (${keyBuf.byteLength} Bytes)`)
      }
      keyCache.set(keySpec.uri, keyBuf)
    }
    let ivBuf
    if (keySpec.ivHex) {
      ivBuf = Buffer.from(keySpec.ivHex.padStart(32, '0').slice(-32), 'hex')
    } else {
      ivBuf = Buffer.alloc(16)
      ivBuf.writeBigUInt64BE(BigInt(seq), 8)
    }
    const decipher = crypto.createDecipheriv('aes-128-cbc', keyBuf, ivBuf)
    return Buffer.concat([decipher.update(buf), decipher.final()])
  }

  fs.mkdirSync(path.dirname(actualDestFile), { recursive: true })
  const out = fs.createWriteStream(actualDestFile)
  let loadedBytes = 0
  let writtenMapUrl = null
  const startedAt = Date.now()
  try {
    for (let idx = 0; idx < segments.length; idx += 1) {
      if (signal?.aborted) throw new Error('Abgebrochen')
      const seg = segments[idx]
      if (seg.mapUrl && seg.mapUrl !== writtenMapUrl) {
        const rawMap = await fetchBufferWithRetry(seg.mapUrl, 'HLS-Init-Segment')
        const mapBuf = seg.key && seg.key.ivHex ? await decryptBuffer(rawMap, seg.key, seg.seq) : rawMap
        loadedBytes += mapBuf.byteLength
        if (!out.write(mapBuf)) {
          await new Promise((r) => out.once('drain', r))
        }
        writtenMapUrl = seg.mapUrl
      }

      const rawSeg = await fetchBufferWithRetry(seg.url, `HLS-Segment ${idx + 1}/${segments.length}`)
      const buf = await decryptBuffer(rawSeg, seg.key, seg.seq)
      loadedBytes += buf.byteLength
      if (!out.write(buf)) {
        await new Promise((r) => out.once('drain', r))
      }
      if (maxBandwidthKbps > 0) {
        const expectedMs = (loadedBytes / (maxBandwidthKbps * 1024)) * 1000
        const elapsedMs = Date.now() - startedAt
        if (expectedMs > elapsedMs + 40) {
          await new Promise((r) => setTimeout(r, Math.min(1000, expectedMs - elapsedMs)))
        }
      }
      if (onProgress) {
        const pct = Math.round(((idx + 1) / segments.length) * 100)
        const elapsedSec = Math.max(0.2, (Date.now() - startedAt) / 1000)
        const speedBps = Math.round(loadedBytes / elapsedSec)
        const remainingSegs = segments.length - (idx + 1)
        const avgSegSec = elapsedSec / (idx + 1)
        onProgress({
          pct,
          loaded: loadedBytes,
          total: Math.round((loadedBytes / (idx + 1)) * segments.length),
          speedBps,
          etaSeconds: Math.round(remainingSegs * avgSegSec),
        })
      }
    }
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())))
  } catch (err) {
    out.destroy()
    try {
      fs.rmSync(actualDestFile, { force: true })
    } catch {}
    throw err
  }
  return actualDestFile
}

export function createDownloaderWorker({ store, driveAuth, driveService, mediaTools, onNotify = null }) {
  const activeControllers = new Map()
  let pumping = false
  let onQueueIdle = null
  let lastLowSpaceLogAt = 0
  const budgetLogAt = new Map()

  function effectiveSettingsForJob(job) {
    const cfg = store.getConfig()
    const override = (job.seriesId && cfg.seriesOverrides?.[job.seriesId]) || {}
    return {
      ...cfg,
      language: job.language || override.language || cfg.language || 'auto',
      mode: override.mode || job.mode || cfg.mode || 'video',
      videoPref: override.videoPref || job.videoPref || cfg.videoPref || 'best',
      audioPref: override.audioPref || job.audioPref || cfg.audioPref || 'high',
      audioFormat: override.audioFormat || job.audioFormat || cfg.audioFormat || 'original',
    }
  }

  /**
   * Stellt sicher, dass am Ende eine abspielbare Datei hochgeladen wird:
   * - HTML-Fehlerseiten, m3u8-Listen und leere Dateien werden abgelehnt (→ nächster Hoster),
   * - MPEG-TS (HLS) und fragmentiertes MP4 werden mit FFmpeg verlustfrei in ein normales MP4
   *   mit vorgezogenem Index umgepackt, das Drive, Browser und Windows-Player direkt abspielen,
   * - stimmt die Dateiendung nicht zum Inhalt, wird sie korrigiert.
   * Gibt den (ggf. neuen) Pfad zurück.
   */
  async function ensurePlayableMedia(filePath, { mode = 'video', signal } = {}) {
    const kind = sniffMediaFile(filePath)
    if (isNonMediaKind(kind)) {
      try {
        fs.rmSync(filePath, { force: true })
      } catch {}
      const what =
        kind === 'html'
          ? 'eine Webseite'
          : kind === 'playlist'
            ? 'nur eine Wiedergabeliste'
            : kind === 'empty'
              ? 'eine leere Datei'
              : 'Text'
      throw new Error(`Hoster lieferte ${what} statt einer Videodatei.`)
    }

    const ext = path.extname(filePath).replace(/^\./, '').toLowerCase()
    const base = filePath.slice(0, filePath.length - path.extname(filePath).length)
    const wantsMp4Remux =
      mode !== 'audio' && (kind === 'ts' || (kind === 'mp4' && isFragmentedMp4(filePath)))

    if (wantsMp4Remux && mediaTools.findFfmpeg()) {
      const target = `${base}${ext === 'mp4' ? '.remux' : ''}.mp4`
      const ok = await mediaTools.remuxToMp4({ inputFile: filePath, outputFile: target, signal })
      if (ok && sniffMediaFile(target) === 'mp4') {
        if (target !== filePath) {
          try {
            fs.rmSync(filePath, { force: true })
          } catch {}
        }
        const finalPath = `${base}.mp4`
        if (target !== finalPath) fs.renameSync(target, finalPath)
        return finalPath
      }
      try {
        fs.rmSync(target, { force: true })
      } catch {}
      if (signal?.aborted) throw new Error('Abgebrochen')
      store.addLog({
        category: 'download',
        level: 'warn',
        title: 'Umwandlung in MP4 fehlgeschlagen',
        message: `${path.basename(filePath)} konnte nicht in ein normales MP4 umgepackt werden und wird im Originalformat gespeichert.`,
      })
    } else if (kind === 'ts' && mode !== 'audio') {
      store.addLog({
        category: 'download',
        level: 'warn',
        title: 'FFmpeg fehlt — Folge bleibt im TS-Format',
        message: `${path.basename(filePath)} ist ein HLS-Mitschnitt (MPEG-TS). Ohne FFmpeg kann Sondra AD ihn nicht in MP4 umpacken; Google Drive und Browser spielen .ts-Dateien meist nicht ab. Bitte FFmpeg installieren.`,
      })
    }

    const wantedExt = extensionForKind(kind)
    const audioContainer = ['mp3', 'aac', 'flac', 'ogg', 'wav'].includes(kind)
    if (wantedExt && wantedExt !== ext && !(audioContainer && mode === 'audio' && ext)) {
      const renamed = `${base}.${wantedExt}`
      fs.renameSync(filePath, renamed)
      return renamed
    }
    return filePath
  }

  function isDirectSupportedUrl(target) {
    return (
      isAniworldUrl(target) ||
      isHosterUrl(target) ||
      isPodcastOrRssUrl(target) ||
      isBilibiliUrl(target) ||
      isSpotifyUrl(target) ||
      isMvflixUrl(target) ||
      is9AnimeUrl(target) ||
      isAnimeKaizenUrl(target) ||
      isGoogleDriveUrl(target)
    )
  }

  async function sendNotification(title, message, level = 'info') {
    const cfg = store.getConfig()
    if (cfg.desktopNotifications && onNotify) {
      try {
        onNotify({ title, body: message })
      } catch {}
    }
    await dispatchPushNotifications(cfg, { title, body: message, level }).catch(() => {})
  }

  /**
   * Ordnet einen Auftrag der passenden Serie aus der Merkliste zu, damit die Folge im
   * bestehenden Serienordner landet – auch wenn der Link manuell eingeworfen wurde und
   * der Titel nur aus der Adresse abgeleitet ist („Frieren Beyond Journeys End“ statt
   * „Frieren: Beyond Journey's End“).
   */
  function withSeriesIdentity(job) {
    const items = store.getMerkItems()
    if (job.seriesId) {
      const item = items.find((i) => i.id === job.seriesId)
      return item?.title && item.title !== job.seriesTitle ? { ...job, seriesTitle: item.title } : job
    }
    if (typeof job.season !== 'number' || typeof job.episode !== 'number') return job
    const slug = streamSlugOf(job.url)
    const key = job.seriesTitle ? folderMatchKey(job.seriesTitle) : ''
    const match =
      (slug && items.find((i) => streamSlugOf(i.url) === slug)) ||
      (key && items.find((i) => i.title && folderMatchKey(i.title) === key)) ||
      null
    return match ? { ...job, seriesId: match.id, seriesTitle: match.title || job.seriesTitle } : job
  }

  async function executeSingleJob(rawJob) {
    let job = rawJob
    try {
      job = withSeriesIdentity(rawJob)
      if (job.seriesId !== rawJob.seriesId || job.seriesTitle !== rawJob.seriesTitle) {
        store.patchQueueItem(job.id, { seriesId: job.seriesId, seriesTitle: job.seriesTitle })
      }
    } catch {
      job = rawJob
    }
    const controller = new AbortController()
    activeControllers.set(job.id, controller)
    const settings = effectiveSettingsForJob(job)
    const localAddress = resolveBindIpv4(settings.bindAddress)
    const stageDir = path.join(settings.tempDir, job.id)
    fs.mkdirSync(stageDir, { recursive: true })

    const triedHosters = []
    let usedHoster = null
    let downloadedPath = null
    let finalFileName = null
    let resolvedLanguage = settings.language !== 'auto' ? settings.language : null

    try {
      store.patchQueueItem(
        job.id,
        {
          status: 'downloading',
          progress: 0,
          speedBps: 0,
          etaSeconds: null,
          error: null,
          startedAt: Date.now(),
        },
        true,
      )

      const maxHeight =
        settings.videoPref === '1080p'
          ? 1080
          : settings.videoPref === '720p'
            ? 720
            : settings.videoPref === '480p'
              ? 480
              : settings.videoPref === '360p'
                ? 360
                : 0

      const shouldStrictWaitLanguage =
        settings.language !== 'auto' &&
        settings.waitForPreferredLanguage &&
        (settings.languageWaitFallbackHours <= 0 ||
          Date.now() - (job.createdAt || Date.now()) < settings.languageWaitFallbackHours * 3600_000)

      const effectiveBw = resolveEffectiveBandwidthKbps(settings)

      if (isDirectSupportedUrl(job.url)) {
        const extracted = await extractDirectMedia(job.url, {
          localAddress,
          language: settings.language,
          languagePriority: settings.language === 'auto' ? settings.languagePriority : undefined,
          hosterPriority: settings.hosterPriority,
          maxMirrors: 6,
          strictLanguage: shouldStrictWaitLanguage,
          signal: controller.signal,
        })
        if (!resolvedLanguage && extracted?.selectedLanguage) {
          resolvedLanguage = extracted.selectedLanguage
        }

        if (extracted?.isPlaylist && Array.isArray(extracted.items) && extracted.items.length > 0) {
          let addedCount = 0
          for (let i = 0; i < extracted.items.length; i += 1) {
            const ep = extracted.items[i]
            if (!ep?.url) continue
            const enq = enqueueJob({
              url: ep.url,
              title: ep.title || `${extracted.title || job.title} - ${i + 1}`,
              seriesId: job.seriesId || null,
              seriesTitle: job.seriesId
                ? job.seriesTitle || extracted.seriesTitle || extracted.title || null
                : extracted.seriesTitle || job.seriesTitle || extracted.title || null,
              season: typeof ep.seasonNumber === 'number' ? ep.seasonNumber : job.season ?? 1,
              episode: typeof ep.episodeNumber === 'number' ? ep.episodeNumber : i + 1,
              language: job.language,
              mode: job.mode,
              videoPref: job.videoPref,
              manualForce: Boolean(job.manualForce),
            })
            if (enq.added) addedCount += 1
          }
          store.setQueue(store.getQueue().filter((q) => q.id !== job.id), true)
          store.addLog({
            category: 'download',
            level: 'info',
            title: `Sammlung aufgelöst: ${extracted.title || job.title}`,
            message: `${addedCount} Einzeleinträge wurden in die Warteschlange eingereiht.`,
          })
          return
        }

        if (extracted?.languageMissing) {
          const availNames = (extracted.availableLanguages || []).map((l) => l.label).join(', ') || 'keine'
          const nextCheckAt = Date.now() + Math.max(15, settings.checkIntervalMinutes || 30) * 60_000
          store.patchQueueItem(
            job.id,
            {
              status: 'waiting_language',
              nextRetryAt: nextCheckAt,
              error: `Wartet auf Wunschsprache (${settings.language}) — aktuell vorhanden: ${availNames}`,
            },
            true,
          )
          store.addLog({
            category: 'download',
            level: 'info',
            title: `Wartet auf Wunschsprache: ${job.seriesTitle || job.title}`,
            message: `${formatEpisodeTag(job.season ?? 1, job.episode ?? 1)} ist bisher nur auf [${availNames}] verfügbar. Prüfe später erneut.`,
            seriesId: job.seriesId,
            seriesTitle: job.seriesTitle,
            season: job.season,
            episode: job.episode,
          })
          return
        }

        const candidateStreams = []
        if (extracted && Array.isArray(extracted.streams) && extracted.streams.length > 0) {
          candidateStreams.push(...extracted.streams)
        } else if (extracted && extracted.url) {
          candidateStreams.push({
            provider: extracted.hoster || 'Direkt',
            url: extracted.url,
            isHls: Boolean(extracted.isHls),
            referer: extracted.referer || null,
            ext: extracted.ext || 'mp4',
          })
        }

        const epTag = formatEpisodeTag(job.season ?? 1, job.episode ?? 1)
        const baseTitle = sanitizeFileName(
          job.seriesTitle ? `${job.seriesTitle} - ${epTag}` : extracted?.title || job.title || 'Episode',
        )

        let lastStreamError = null
        if (extracted?.isSpotifyTrack && extracted.searchQuery) {
          try {
            downloadedPath = await mediaTools.downloadViaYtdlp({
              url: extracted.searchQuery,
              outputPathNoExt: path.join(stageDir, baseTitle),
              mode: 'audio',
              videoPref: settings.videoPref,
              audioFormat: settings.audioFormat === 'original' ? 'mp3' : settings.audioFormat,
              maxBandwidthKbps: effectiveBw.maxBandwidthKbps,
              signal: controller.signal,
              onProgress: (p) =>
                store.patchQueueItem(job.id, {
                  progress: p.pct,
                  loadedBytes: p.loaded,
                  totalBytes: p.total,
                  speedBps: p.speedBps,
                  etaSeconds: p.etaSeconds,
                }),
            })
            usedHoster = 'Spotify · yt-dlp'
            finalFileName = path.basename(downloadedPath)
          } catch (spotErr) {
            if (extracted.previewUrl) {
              const previewDest = path.join(stageDir, `${baseTitle}.mp3`)
              await streamUrlToFile(extracted.previewUrl, previewDest, {
                localAddress,
                maxBandwidthKbps: effectiveBw.maxBandwidthKbps,
                signal: controller.signal,
              })
              downloadedPath = previewDest
              usedHoster = 'Spotify · Vorschau'
              finalFileName = path.basename(previewDest)
            } else {
              lastStreamError = spotErr
            }
          }
        }

        if (!downloadedPath) {
          for (const stream of candidateStreams) {
            if (controller.signal.aborted) throw new Error('Abgebrochen')
            if (!stream?.url) continue
            const providerName = stream.provider || 'Stream'
            if (job.preferredHoster && !providerName.toLowerCase().includes(String(job.preferredHoster).toLowerCase())) {
              continue
            }
            store.patchQueueItem(job.id, { activeHoster: providerName })
            try {
              const outExt =
                settings.mode === 'audio'
                  ? settings.audioFormat === 'original'
                    ? 'm4a'
                    : settings.audioFormat
                  : stream.ext || 'mp4'
              const candidateFile = path.join(stageDir, `${baseTitle}.${outExt}`)
              const isHls = Boolean(stream.isHls) || /\.m3u8(?:$|\?)/i.test(stream.url)

              if (isHls && mediaTools.findFfmpeg()) {
                const ok = await mediaTools.remuxHlsWithFfmpeg({
                  m3u8Url: stream.url,
                  referer: stream.referer,
                  outputFile: candidateFile,
                  mode: settings.mode,
                  audioFormat: settings.audioFormat,
                  signal: controller.signal,
                })
                if (!ok) throw new Error(`${providerName}: HLS-Verarbeitung mit FFmpeg fehlgeschlagen`)
                downloadedPath = candidateFile
              } else if (isHls) {
                const m3u8Res = await boundedFetch(stream.url, {
                  headers: buildStreamHeaders(stream.referer),
                  localAddress,
                  signal: controller.signal,
                })
                if (!m3u8Res.ok) throw new Error(`${providerName}: HTTP ${m3u8Res.status}`)
                const m3u8Text = await m3u8Res.text()
                const tsFile = path.join(stageDir, `${baseTitle}.ts`)
                downloadedPath = await downloadHlsSegmentsNative(m3u8Text, m3u8Res.url || stream.url, tsFile, {
                  referer: stream.referer,
                  localAddress,
                  maxBandwidthKbps: effectiveBw.maxBandwidthKbps,
                  maxHeight,
                  signal: controller.signal,
                  onProgress: (p) =>
                    store.patchQueueItem(job.id, {
                      progress: p.pct,
                      loadedBytes: p.loaded,
                      totalBytes: p.total,
                      speedBps: p.speedBps,
                      etaSeconds: p.etaSeconds,
                    }),
                })
              } else {
                downloadedPath = await streamUrlToFile(stream.url, candidateFile, {
                  referer: stream.referer,
                  localAddress,
                  maxBandwidthKbps: effectiveBw.maxBandwidthKbps,
                  signal: controller.signal,
                  onProgress: (p) =>
                    store.patchQueueItem(job.id, {
                      progress: p.pct,
                      loadedBytes: p.loaded,
                      totalBytes: p.total,
                      speedBps: p.speedBps,
                      etaSeconds: p.etaSeconds,
                    }),
                })
              }

              downloadedPath = await ensurePlayableMedia(downloadedPath, {
                mode: settings.mode,
                signal: controller.signal,
              })
              usedHoster = providerName
              finalFileName = path.basename(downloadedPath)
              break
            } catch (streamErr) {
              if (downloadedPath) {
                try {
                  fs.rmSync(downloadedPath, { force: true })
                } catch {}
              }
              downloadedPath = null
              if (controller.signal.aborted) throw streamErr
              lastStreamError = streamErr
              triedHosters.push(`${providerName} (${streamErr?.message || 'Fehler'})`)
              store.addLog({
                category: 'retry',
                level: 'warn',
                title: `Hoster-Wechsel bei ${job.seriesTitle || job.title}`,
                message: `${providerName} fehlgeschlagen (${streamErr?.message || 'Fehler'}) — versuche nächsten Hoster.`,
                seriesId: job.seriesId,
                seriesTitle: job.seriesTitle,
                season: job.season,
                episode: job.episode,
                hoster: providerName,
              })
            }
          }
        }

        if (!downloadedPath && mediaTools.findYtdlp() && candidateStreams.length > 0) {
          for (const stream of candidateStreams.slice(0, 2)) {
            if (controller.signal.aborted) throw new Error('Abgebrochen')
            const targetStreamUrl = stream.embedUrl || stream.url
            if (!targetStreamUrl) continue
            try {
              const templateBase = path.join(stageDir, baseTitle)
              downloadedPath = await mediaTools.downloadViaYtdlp({
                url: targetStreamUrl,
                outputPathNoExt: templateBase,
                mode: settings.mode,
                videoPref: settings.videoPref,
                audioFormat: settings.audioFormat,
                referer: stream.referer || undefined,
                maxBandwidthKbps: effectiveBw.maxBandwidthKbps,
                signal: controller.signal,
                onProgress: (p) =>
                  store.patchQueueItem(job.id, {
                    progress: p.pct,
                    loadedBytes: p.loaded,
                    totalBytes: p.total,
                    speedBps: p.speedBps,
                    etaSeconds: p.etaSeconds,
                  }),
              })
              downloadedPath = await ensurePlayableMedia(downloadedPath, {
                mode: settings.mode,
                signal: controller.signal,
              })
              usedHoster = `${stream.provider || 'Stream'} · yt-dlp`
              finalFileName = path.basename(downloadedPath)
              break
            } catch (ytdlpStreamErr) {
              if (downloadedPath) {
                try {
                  fs.rmSync(downloadedPath, { force: true })
                } catch {}
              }
              downloadedPath = null
              if (controller.signal.aborted) throw ytdlpStreamErr
              if (!lastStreamError) lastStreamError = ytdlpStreamErr
            }
          }
        }

        if (!downloadedPath && /^https?:\/\//i.test(job.url) && !isAniworldUrl(job.url)) {
          try {
            const templateBase = path.join(stageDir, baseTitle)
            downloadedPath = await mediaTools.downloadViaYtdlp({
              url: job.url,
              outputPathNoExt: templateBase,
              mode: settings.mode,
              videoPref: settings.videoPref,
              audioFormat: settings.audioFormat,
              maxBandwidthKbps: effectiveBw.maxBandwidthKbps,
              signal: controller.signal,
              onProgress: (p) =>
                store.patchQueueItem(job.id, {
                  progress: p.pct,
                  loadedBytes: p.loaded,
                  totalBytes: p.total,
                  speedBps: p.speedBps,
                  etaSeconds: p.etaSeconds,
                }),
            })
            usedHoster = 'yt-dlp'
            finalFileName = path.basename(downloadedPath)
          } catch (ytdlpErr) {
            if (!lastStreamError) lastStreamError = ytdlpErr
          }
        }

        if (!downloadedPath) {
          throw lastStreamError || new Error('Kein funktionierender Stream bei den verfügbaren Hostern gefunden.')
        }
      } else {
        const epTag = formatEpisodeTag(job.season ?? 1, job.episode ?? 1)
        const baseTitle = sanitizeFileName(job.seriesTitle ? `${job.seriesTitle} - ${epTag}` : job.title || 'Download')
        if (/\.(?:mp4|m4v|webm|mkv|mp3|m4a|flac|ogg|opus|wav)(?:$|\?)/i.test(job.url)) {
          const urlExt = new URL(job.url).pathname.split('.').pop() || 'mp4'
          const directDest = path.join(stageDir, `${baseTitle}.${urlExt}`)
          downloadedPath = await streamUrlToFile(job.url, directDest, {
            localAddress,
            maxBandwidthKbps: effectiveBw.maxBandwidthKbps,
            signal: controller.signal,
            onProgress: (p) =>
              store.patchQueueItem(job.id, {
                progress: p.pct,
                loadedBytes: p.loaded,
                totalBytes: p.total,
                speedBps: p.speedBps,
                etaSeconds: p.etaSeconds,
              }),
          })
          usedHoster = 'Direkt'
          finalFileName = path.basename(downloadedPath)
        } else {
          downloadedPath = await mediaTools.downloadViaYtdlp({
            url: job.url,
            outputPathNoExt: path.join(stageDir, baseTitle),
            mode: settings.mode,
            videoPref: settings.videoPref,
            audioFormat: settings.audioFormat,
            maxBandwidthKbps: effectiveBw.maxBandwidthKbps,
            signal: controller.signal,
            onProgress: (p) =>
              store.patchQueueItem(job.id, {
                progress: p.pct,
                loadedBytes: p.loaded,
                totalBytes: p.total,
                speedBps: p.speedBps,
                etaSeconds: p.etaSeconds,
              }),
          })
          usedHoster = 'yt-dlp'
          finalFileName = path.basename(downloadedPath)
        }
      }

      // Für alle Wege (yt-dlp, Direkt-Link, Spotify …) noch einmal sicherstellen,
      // dass eine abspielbare Datei mit passender Endung hochgeladen wird.
      downloadedPath = await ensurePlayableMedia(downloadedPath, { mode: settings.mode, signal: controller.signal })
      finalFileName = path.basename(downloadedPath)

      const fileSize = fs.statSync(downloadedPath).size
      const ext = path.extname(finalFileName)
      const mime = mimeForExt(ext, settings.mode)
      const wantsDrive =
        settings.storageTarget === 'drive_only' ||
        settings.storageTarget === 'drive_and_local' ||
        settings.storageTarget === 'drive_and_webdav'
      const wantsLocal = settings.storageTarget === 'local_only' || settings.storageTarget === 'drive_and_local'
      const wantsWebdav = settings.storageTarget === 'webdav_only' || settings.storageTarget === 'drive_and_webdav'

      let effectiveWantsDrive = wantsDrive
      let effectiveWantsLocal = wantsLocal
      let fellBackToLocal = false
      if (effectiveWantsDrive && !driveAuth.isConnected()) {
        effectiveWantsDrive = false
        if (!wantsWebdav) {
          effectiveWantsLocal = true
          fellBackToLocal = true
        }
      }

      let driveFile = null
      let driveRelPath = null

      if (effectiveWantsDrive) {
        store.patchQueueItem(
          job.id,
          {
            status: 'uploading',
            progress: 0,
            speedBps: 0,
            etaSeconds: null,
          },
          true,
        )
        let targetSegments = ['Heruntergeladen']
        let targetFolderId = null
        if (job.seriesTitle) {
          // Bestehenden Serien-/Staffelordner wiederverwenden (über Serien-ID der vorhandenen
          // Folgen oder tolerant verglichenen Namen) statt blind einen neuen anzulegen.
          const resolved = await driveService.resolveSeasonFolder({
            seriesId: job.seriesId || null,
            seriesTitle: job.seriesTitle,
            season: job.season ?? 1,
          })
          targetSegments = resolved.segments
          targetFolderId = resolved.folderId
        }
        const appProperties =
          job.seriesId && typeof job.season === 'number' && typeof job.episode === 'number'
            ? hintProperties({ series: job.seriesId, season: job.season, episode: job.episode })
            : undefined

        const upStart = Date.now()
        driveFile = await driveService.uploadFileToDrive(targetSegments, finalFileName, downloadedPath, {
          mime,
          appProperties,
          folderId: targetFolderId,
          signal: controller.signal,
          onProgress: (loaded, total) => {
            const elapsed = Math.max(0.2, (Date.now() - upStart) / 1000)
            const speedBps = Math.round(loaded / elapsed)
            store.patchQueueItem(job.id, {
              progress: total > 0 ? Math.round((loaded / total) * 100) : 100,
              loadedBytes: loaded,
              totalBytes: total,
              speedBps,
              etaSeconds: total > loaded && speedBps > 0 ? Math.round((total - loaded) / speedBps) : 0,
            })
          },
        })
        driveRelPath = `${targetSegments.join('/')}/${finalFileName}`
      }

      let savedLocalPath = null
      if (effectiveWantsLocal) {
        const subDir = job.seriesTitle
          ? resolveLocalSeasonDir(settings.localDir, job.seriesTitle, job.season ?? 1, settings.localNamingScheme).dir
          : settings.localDir
        fs.mkdirSync(subDir, { recursive: true })
        savedLocalPath = path.join(subDir, finalFileName)
        fs.copyFileSync(downloadedPath, savedLocalPath)
      }

      let webdavRelPath = null
      if (wantsWebdav) {
        store.patchQueueItem(
          job.id,
          {
            status: 'uploading',
            progress: 50,
            speedBps: 0,
            etaSeconds: null,
          },
          true,
        )
        const targetSegments = job.seriesTitle
          ? [seriesFolderName(job.seriesTitle), localSeasonDirName(job.season ?? 1, settings.localNamingScheme)]
          : ['Heruntergeladen']
        const uploaded = await uploadFileToWebdav({
          url: settings.webdavUrl,
          username: settings.webdavUsername,
          password: settings.webdavPassword,
          basePath: settings.webdavBasePath,
          segments: targetSegments,
          fileName: finalFileName,
          localFilePath: downloadedPath,
          mime,
          signal: controller.signal,
        })
        webdavRelPath = uploaded.relPath
      }

      if (job.isUpgrade) {
        if (job.upgradeFromDriveFileId && driveFile?.id && job.upgradeFromDriveFileId !== driveFile.id && driveAuth.isConnected()) {
          await driveService.deleteDriveFile(job.upgradeFromDriveFileId).catch(() => {})
        }
        if (job.upgradeFromLocalPath && job.upgradeFromLocalPath !== savedLocalPath) {
          try {
            fs.rmSync(job.upgradeFromLocalPath, { force: true })
          } catch {}
        }
        if (job.upgradeFromWebdavPath && job.upgradeFromWebdavPath !== webdavRelPath && settings.webdavUrl) {
          await deleteWebdavFile({
            url: settings.webdavUrl,
            username: settings.webdavUsername,
            password: settings.webdavPassword,
            relPath: job.upgradeFromWebdavPath,
          }).catch(() => {})
        }
      }

      try {
        fs.rmSync(stageDir, { recursive: true, force: true })
      } catch {}

      if (job.seriesId && typeof job.season === 'number' && typeof job.episode === 'number') {
        store.markEpisodeDownloaded(job.seriesId, job.season, job.episode, {
          fileName: finalFileName,
          sizeBytes: fileSize,
          driveFileId: driveFile?.id || null,
          drivePath: driveRelPath,
          localPath: savedLocalPath,
          webdavPath: webdavRelPath,
          language: resolvedLanguage,
          hoster: usedHoster,
        })
      }

      store.patchQueueItem(
        job.id,
        {
          status: 'completed',
          progress: 100,
          loadedBytes: fileSize,
          totalBytes: fileSize,
          speedBps: 0,
          etaSeconds: 0,
          activeHoster: usedHoster,
          triedHosters,
          driveFileId: driveFile?.id || null,
          drivePath: driveRelPath,
          localPath: savedLocalPath,
          completedAt: Date.now(),
          error: null,
        },
        true,
      )

      const locationLabel = driveRelPath
        ? `Sondra/${driveRelPath}`
        : webdavRelPath
          ? `WebDAV/${webdavRelPath}`
          : savedLocalPath
      store.addLog({
        category: 'download',
        level: 'info',
        title: job.isUpgrade ? `Sprach-Upgrade: ${finalFileName}` : `Geladen: ${finalFileName}`,
        message: `Gespeichert unter ${locationLabel} (${(fileSize / (1024 * 1024)).toFixed(1)} MB via ${usedHoster})${fellBackToLocal ? ' · Google Drive nicht verbunden, lokal gesichert' : ''}.`,
        seriesId: job.seriesId,
        seriesTitle: job.seriesTitle,
        season: job.season,
        episode: job.episode,
        hoster: usedHoster,
        ...(triedHosters.length > 0 ? { triedHosters } : {}),
      })

      if (settings.notifyOnComplete) {
        await sendNotification(
          `Folge bereit: ${job.seriesTitle || finalFileName}`,
          `${formatEpisodeTag(job.season ?? 1, job.episode ?? 1)} wurde automatisch in ${driveRelPath ? 'Google Drive' : 'den Zielordner'} geladen.`,
          'info',
        )
      }
    } catch (error) {
      try {
        fs.rmSync(stageDir, { recursive: true, force: true })
      } catch {}

      if (controller.signal.aborted && job._cancelledByUser) {
        store.patchQueueItem(
          job.id,
          {
            status: 'cancelled',
            speedBps: 0,
            etaSeconds: null,
            error: 'Vom Benutzer abgebrochen',
          },
          true,
        )
        return
      }

      const attempts = (job.attempts || 0) + 1
      const maxRetries = settings.maxRetries
      const errMsg = String(error?.message ?? error).slice(0, 300)
      const canRetry = maxRetries === -1 || attempts <= maxRetries

      if (canRetry) {
        const delayMs = computeRetryDelayMs(attempts, settings.retryBaseMinutes)
        const nextRetryAt = Date.now() + delayMs
        store.patchQueueItem(
          job.id,
          {
            status: 'retrying',
            attempts,
            nextRetryAt,
            progress: 0,
            speedBps: 0,
            etaSeconds: null,
            triedHosters,
            error: errMsg,
          },
          true,
        )
        store.addLog({
          category: 'retry',
          level: 'warn',
          title: `Fehlversuch ${attempts}${maxRetries > 0 ? `/${maxRetries}` : ''}: ${job.seriesTitle || job.title}`,
          message: `${errMsg} — Nächster Versuch in ${Math.max(1, Math.round(delayMs / 60_000))} Min.`,
          seriesId: job.seriesId,
          seriesTitle: job.seriesTitle,
          season: job.season,
          episode: job.episode,
          triedHosters,
          detail: errMsg,
        })
      } else {
        store.patchQueueItem(
          job.id,
          {
            status: 'failed',
            attempts,
            nextRetryAt: null,
            progress: 0,
            speedBps: 0,
            etaSeconds: null,
            triedHosters,
            error: errMsg,
          },
          true,
        )
        store.addLog({
          category: 'retry',
          level: 'error',
          title: `Dauerhaft fehlgeschlagen: ${job.seriesTitle || job.title}`,
          message: `Nach ${attempts} Versuchen abgebrochen: ${errMsg}`,
          seriesId: job.seriesId,
          seriesTitle: job.seriesTitle,
          season: job.season,
          episode: job.episode,
          triedHosters,
          detail: errMsg,
        })
        if (settings.notifyOnFailure) {
          await sendNotification(
            `Download fehlgeschlagen: ${job.seriesTitle || job.title}`,
            `${formatEpisodeTag(job.season ?? 1, job.episode ?? 1)} konnte nach ${attempts} Versuchen nicht geladen werden: ${errMsg}`,
            'error',
          )
        }
      }
    } finally {
      try {
        fs.rmSync(stageDir, { recursive: true, force: true })
      } catch {}
      activeControllers.delete(job.id)
    }
  }

  async function pumpQueue() {
    if (pumping) return
    pumping = true
    try {
      for (;;) {
        const cfg = store.getConfig()
        const now = Date.now()
        const bwState = resolveEffectiveBandwidthKbps(cfg, now)

        let wokeAny = false
        const currentQueue = store.getQueue()
        for (const item of currentQueue) {
          if (
            (item.status === 'retrying' || item.status === 'waiting_language') &&
            item.nextRetryAt &&
            item.nextRetryAt <= now
          ) {
            store.patchQueueItem(item.id, { status: 'queued', nextRetryAt: null })
            wokeAny = true
          }
        }
        const refreshed = wokeAny ? store.getQueue() : currentQueue
        const hasForced = refreshed.some(
          (item) => item.status === 'queued' && item.manualForce && !activeControllers.has(item.id),
        )

        if ((!cfg.enabled || !bwState.allowed) && !hasForced) break

        if (cfg.pauseOnLowSpace && Number(cfg.minFreeLocalGb) > 0) {
          const freeBytes = getLocalFreeBytes(cfg.tempDir)
          const minBytes = Number(cfg.minFreeLocalGb) * 1024 * 1024 * 1024
          if (freeBytes !== null && freeBytes < minBytes) {
            if (now - lastLowSpaceLogAt > 15 * 60_000) {
              lastLowSpaceLogAt = now
              const freeGb = (freeBytes / (1024 * 1024 * 1024)).toFixed(2)
              store.addLog({
                category: 'storage',
                level: 'warn',
                title: 'Downloads pausiert: Wenig freier Speicher',
                message: `Nur noch ${freeGb} GB frei (Puffer: ${cfg.minFreeLocalGb} GB). Downloads starten wieder, sobald Platz frei wird.`,
              })
              await sendNotification(
                'Speicher knapp — Downloads pausiert',
                `Lokal sind nur noch ${freeGb} GB frei (Minimum: ${cfg.minFreeLocalGb} GB).`,
                'warn',
              )
            }
            break
          }
        }

        const concurrency = Math.max(1, Math.min(4, Number(cfg.concurrency) || 1))
        const activeCount = activeControllers.size
        if (activeCount >= concurrency) break

        const eligible = refreshed.filter((item) => {
          if (item.status !== 'queued' || activeControllers.has(item.id)) return false
          if ((!cfg.enabled || !bwState.allowed) && !item.manualForce) return false
          if (item.seriesId) {
            const ov = cfg.seriesOverrides?.[item.seriesId]
            const maxGb = Number(ov?.maxStorageGb || 0)
            if (maxGb > 0) {
              const used = getSeriesUsedBytes(store, item.seriesId)
              if (used >= maxGb * 1024 * 1024 * 1024) {
                const prevLog = budgetLogAt.get(item.seriesId) || 0
                if (now - prevLog > 15 * 60_000) {
                  budgetLogAt.set(item.seriesId, now)
                  store.addLog({
                    category: 'storage',
                    level: 'warn',
                    title: `Speicherbudget erreicht: ${item.seriesTitle || item.title}`,
                    message: `Belegt ${(used / (1024 * 1024 * 1024)).toFixed(2)} GB von maximal ${maxGb} GB.`,
                    seriesId: item.seriesId,
                    seriesTitle: item.seriesTitle,
                  })
                }
                return false
              }
            }
          }
          return true
        })

        if (eligible.length === 0) break

        const slots = concurrency - activeCount
        const batch = eligible.slice(0, slots)

        if (batch.length === 0) break
        await Promise.all(batch.map((job) => executeSingleJob(job)))
      }
    } finally {
      pumping = false
      const remaining = store
        .getQueue()
        .some((j) => j.status === 'queued' || j.status === 'downloading' || j.status === 'uploading')
      if (!remaining && activeControllers.size === 0 && onQueueIdle) {
        try {
          onQueueIdle()
        } catch {}
      }
    }
  }

  function enqueueJob(input) {
    const queue = store.getQueue()
    const dup = queue.find(
      (q) =>
        ['queued', 'downloading', 'uploading', 'retrying', 'waiting_language'].includes(q.status) &&
        ((input.seriesId &&
          q.seriesId === input.seriesId &&
          q.season === input.season &&
          q.episode === input.episode) ||
          (!input.seriesId && q.url === input.url)),
    )
    if (dup) return { added: false, job: dup }

    const job = {
      id: `job-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      url: String(input.url).trim(),
      title: String(input.title || 'Episode'),
      seriesId: input.seriesId || null,
      seriesTitle: input.seriesTitle || null,
      season: typeof input.season === 'number' ? input.season : 1,
      episode: typeof input.episode === 'number' ? input.episode : 1,
      language: input.language || null,
      mode: input.mode || null,
      videoPref: input.videoPref || null,
      preferredHoster: input.preferredHoster || null,
      manualForce: Boolean(input.manualForce),
      isUpgrade: Boolean(input.isUpgrade),
      upgradeFromDriveFileId: input.upgradeFromDriveFileId || null,
      upgradeFromLocalPath: input.upgradeFromLocalPath || null,
      upgradeFromWebdavPath: input.upgradeFromWebdavPath || null,
      status: 'queued',
      progress: 0,
      loadedBytes: 0,
      totalBytes: 0,
      speedBps: 0,
      etaSeconds: null,
      attempts: 0,
      nextRetryAt: null,
      activeHoster: null,
      triedHosters: [],
      error: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    store.setQueue([...queue, job], true)
    void pumpQueue()
    return { added: true, job }
  }

  function retryJob(jobId, preferredHoster = null) {
    const queue = store.getQueue()
    const target = queue.find((j) => j.id === jobId)
    if (!target) return null
    const updated = store.patchQueueItem(
      jobId,
      {
        status: 'queued',
        manualForce: true,
        nextRetryAt: null,
        error: null,
        progress: 0,
        ...(preferredHoster !== null ? { preferredHoster } : {}),
      },
      true,
    )
    void pumpQueue()
    return updated
  }

  function retryAllFailed() {
    const queue = store.getQueue()
    let count = 0
    const next = queue.map((j) => {
      if (j.status === 'failed' || j.status === 'retrying' || j.status === 'cancelled' || j.status === 'waiting_language') {
        count += 1
        return {
          ...j,
          status: 'queued',
          manualForce: true,
          attempts: 0,
          nextRetryAt: null,
          error: null,
          progress: 0,
          updatedAt: Date.now(),
        }
      }
      return j
    })
    if (count > 0) {
      store.setQueue(next, true)
      store.addLog({
        category: 'retry',
        title: 'Wiederholung gestartet',
        message: `${count} ausstehende oder fehlgeschlagene Einträge wurden neu eingereiht.`,
      })
      void pumpQueue()
    }
    return count
  }

  function cancelJob(jobId) {
    const queue = store.getQueue()
    const target = queue.find((j) => j.id === jobId)
    if (!target) return false
    target._cancelledByUser = true
    const ctrl = activeControllers.get(jobId)
    if (ctrl) {
      store.patchQueueItem(jobId, { _cancelledByUser: true })
      ctrl.abort()
    } else {
      store.patchQueueItem(jobId, { status: 'cancelled', nextRetryAt: null, error: 'Vom Benutzer abgebrochen' }, true)
    }
    return true
  }

  function cancelAllJobs() {
    const queue = store.getQueue()
    const cancellableStatuses = new Set(['downloading', 'uploading', 'queued', 'retrying', 'waiting_language'])
    let count = 0
    const now = Date.now()
    const next = queue.map((j) => {
      if (!cancellableStatuses.has(j.status)) return j
      count += 1
      j._cancelledByUser = true
      const ctrl = activeControllers.get(j.id)
      if (ctrl) {
        try {
          ctrl.abort()
        } catch {}
      }
      return {
        ...j,
        _cancelledByUser: true,
        status: 'cancelled',
        speedBps: 0,
        etaSeconds: null,
        nextRetryAt: null,
        error: 'Vom Benutzer abgebrochen',
        updatedAt: now,
      }
    })
    if (count > 0) {
      store.setQueue(next, true)
      store.addLog({
        category: 'download',
        title: 'Alle Downloads abgebrochen',
        message: `${count} aktive oder wartende Aufträge wurden abgebrochen.`,
      })
    }
    return count
  }

  function removeJob(jobId) {
    cancelJob(jobId)
    const next = store.getQueue().filter((j) => j.id !== jobId)
    store.setQueue(next, true)
    return true
  }

  function clearCompletedJobs() {
    const next = store.getQueue().filter((j) => j.status !== 'completed' && j.status !== 'cancelled')
    store.setQueue(next, true)
  }

  return {
    pumpQueue,
    enqueueJob,
    retryJob,
    retryAllFailed,
    cancelJob,
    cancelAllJobs,
    removeJob,
    clearCompletedJobs,
    sendNotification,
    setOnQueueIdle: (fn) => {
      onQueueIdle = typeof fn === 'function' ? fn : null
    },
    getActiveCount: () => activeControllers.size,
  }
}
