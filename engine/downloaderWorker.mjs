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
import { hintProperties, seasonFolderName, seasonPath, seriesFolderName } from '../shared/merklisteMerge.mjs'
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
    return Number(st.bavail) * Number(st.bsize)
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

async function streamUrlToFile(url, destFile, { referer, localAddress, maxBandwidthKbps = 0, onProgress, signal } = {}) {
  const headers = {
    'User-Agent': DEFAULT_USER_AGENT,
    ...(referer ? { Referer: referer } : {}),
  }
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
  if (/mpegurl/i.test(contentType) || /\.m3u8(?:$|\?)/i.test(url)) {
    const text = await res.text()
    if (text.trimStart().startsWith('#EXTM3U')) {
      return downloadHlsSegmentsNative(text, res.url || url, destFile, { referer, localAddress, onProgress, signal })
    }
  }

  const reader = res.body?.getReader()
  if (!reader) throw new Error('Stream enthielt keine Daten.')
  fs.mkdirSync(path.dirname(destFile), { recursive: true })
  const out = fs.createWriteStream(destFile)
  let loaded = 0
  const startedAt = Date.now()
  let lastReport = 0

  try {
    for (;;) {
      if (signal?.aborted) throw new Error('Abgebrochen')
      const { done, value } = await reader.read()
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

async function downloadHlsSegmentsNative(playlistText, baseUrl, destFile, { referer, localAddress, onProgress, signal, maxHeight = 0 } = {}) {
  let activeText = playlistText
  let activeBase = baseUrl

  const lines = activeText.split(/\r?\n/).map((l) => l.trim())
  const variants = []
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
      const resMatch = lines[i].match(/RESOLUTION=(\d+)x(\d+)/i)
      const bwMatch = lines[i].match(/BANDWIDTH=(\d+)/i)
      const nextUri = lines.slice(i + 1).find((l) => l && !l.startsWith('#'))
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
    const chosen = (fitting.length > 0 ? fitting[0] : variants[0])
    const subRes = await boundedFetch(chosen.url, {
      headers: {
        'User-Agent': DEFAULT_USER_AGENT,
        ...(referer ? { Referer: referer } : {}),
      },
      localAddress,
      signal,
    })
    if (!subRes.ok) throw new Error(`HLS-Variante nicht erreichbar (${subRes.status})`)
    activeText = await subRes.text()
    activeBase = subRes.url || chosen.url
  }

  const segmentUrls = activeText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => new URL(l, activeBase).href)

  if (segmentUrls.length === 0) {
    throw new Error('HLS-Wiedergabeliste enthält keine Segmente.')
  }

  fs.mkdirSync(path.dirname(destFile), { recursive: true })
  const out = fs.createWriteStream(destFile)
  let loadedBytes = 0
  const startedAt = Date.now()
  try {
    for (let idx = 0; idx < segmentUrls.length; idx += 1) {
      if (signal?.aborted) throw new Error('Abgebrochen')
      const segRes = await boundedFetch(segmentUrls[idx], {
        headers: {
          'User-Agent': DEFAULT_USER_AGENT,
          ...(referer ? { Referer: referer } : {}),
        },
        localAddress,
        signal,
        timeout: 25_000,
      })
      if (!segRes.ok) throw new Error(`HLS-Segment ${idx + 1}/${segmentUrls.length} fehlgeschlagen (${segRes.status})`)
      const buf = Buffer.from(await segRes.arrayBuffer())
      loadedBytes += buf.byteLength
      if (!out.write(buf)) {
        await new Promise((r) => out.once('drain', r))
      }
      if (onProgress) {
        const pct = Math.round(((idx + 1) / segmentUrls.length) * 100)
        const elapsedSec = Math.max(0.2, (Date.now() - startedAt) / 1000)
        const speedBps = Math.round(loadedBytes / elapsedSec)
        const remainingSegs = segmentUrls.length - (idx + 1)
        const avgSegSec = elapsedSec / (idx + 1)
        onProgress({
          pct,
          loaded: loadedBytes,
          total: Math.round((loadedBytes / (idx + 1)) * segmentUrls.length),
          speedBps,
          etaSeconds: Math.round(remainingSegs * avgSegSec),
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
  return destFile
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

  async function executeSingleJob(job) {
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
        let extracted = null
        if (settings.language === 'auto' && Array.isArray(settings.languagePriority) && settings.languagePriority.length > 0 && isAniworldUrl(job.url)) {
          for (let i = 0; i < settings.languagePriority.length; i += 1) {
            const prefLang = settings.languagePriority[i]
            if (!prefLang || prefLang === 'auto') continue
            const isLast = i === settings.languagePriority.length - 1
            const attempt = await extractDirectMedia(job.url, {
              localAddress,
              language: prefLang,
              hosterPriority: settings.hosterPriority,
              maxMirrors: 6,
              strictLanguage: !isLast,
              signal: controller.signal,
            })
            if (attempt && !attempt.languageMissing && ((attempt.streams && attempt.streams.length > 0) || attempt.url)) {
              extracted = attempt
              resolvedLanguage = prefLang
              break
            }
          }
        }
        if (!extracted) {
          extracted = await extractDirectMedia(job.url, {
            localAddress,
            language: settings.language,
            hosterPriority: settings.hosterPriority,
            maxMirrors: 6,
            strictLanguage: shouldStrictWaitLanguage,
            signal: controller.signal,
          })
          if (!resolvedLanguage && extracted?.selectedLanguage) {
            resolvedLanguage = extracted.selectedLanguage
          }
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
        for (const stream of candidateStreams) {
          if (controller.signal.aborted) throw new Error('Abgebrochen')
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
                headers: {
                  'User-Agent': DEFAULT_USER_AGENT,
                  ...(stream.referer ? { Referer: stream.referer } : {}),
                },
                localAddress,
                signal: controller.signal,
              })
              if (!m3u8Res.ok) throw new Error(`${providerName}: HTTP ${m3u8Res.status}`)
              const m3u8Text = await m3u8Res.text()
              const tsFile = path.join(stageDir, `${baseTitle}.ts`)
              await downloadHlsSegmentsNative(m3u8Text, m3u8Res.url || stream.url, tsFile, {
                referer: stream.referer,
                localAddress,
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
              downloadedPath = tsFile
            } else {
              await streamUrlToFile(stream.url, candidateFile, {
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
              downloadedPath = candidateFile
            }

            usedHoster = providerName
            finalFileName = path.basename(downloadedPath)
            break
          } catch (streamErr) {
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

        if (!downloadedPath && /^https?:\/\//i.test(job.url) && !isAniworldUrl(job.url)) {
          try {
            const templateBase = path.join(stageDir, baseTitle)
            downloadedPath = await mediaTools.downloadViaYtdlp({
              url: job.url,
              outputPathNoExt: templateBase,
              mode: settings.mode,
              videoPref: settings.videoPref,
              audioFormat: settings.audioFormat,
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
          await streamUrlToFile(job.url, directDest, {
            localAddress,
            maxBandwidthKbps: settings.maxBandwidthKbps,
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
          downloadedPath = directDest
          usedHoster = 'Direkt'
          finalFileName = path.basename(directDest)
        } else {
          downloadedPath = await mediaTools.downloadViaYtdlp({
            url: job.url,
            outputPathNoExt: path.join(stageDir, baseTitle),
            mode: settings.mode,
            videoPref: settings.videoPref,
            audioFormat: settings.audioFormat,
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

      const fileSize = fs.statSync(downloadedPath).size
      const ext = path.extname(finalFileName)
      const mime = mimeForExt(ext, settings.mode)
      const wantsDrive =
        settings.storageTarget === 'drive_only' ||
        settings.storageTarget === 'drive_and_local' ||
        settings.storageTarget === 'drive_and_webdav'
      const wantsLocal = settings.storageTarget === 'local_only' || settings.storageTarget === 'drive_and_local'
      const wantsWebdav = settings.storageTarget === 'webdav_only' || settings.storageTarget === 'drive_and_webdav'

      let driveFile = null
      let driveRelPath = null

      if (wantsDrive) {
        if (!driveAuth.isConnected()) {
          throw new Error('Speicherziel ist Google Drive, aber Google Drive ist aktuell nicht verbunden.')
        }
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
        const targetSegments = job.seriesTitle
          ? seasonPath(job.seriesTitle, job.season ?? 1)
          : ['Heruntergeladen']
        const appProperties =
          job.seriesId && typeof job.season === 'number' && typeof job.episode === 'number'
            ? hintProperties({ series: job.seriesId, season: job.season, episode: job.episode })
            : undefined

        const upStart = Date.now()
        driveFile = await driveService.uploadFileToDrive(targetSegments, finalFileName, downloadedPath, {
          mime,
          appProperties,
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
      if (wantsLocal) {
        const subDir = job.seriesTitle
          ? path.join(
              settings.localDir,
              seriesFolderName(job.seriesTitle),
              localSeasonDirName(job.season ?? 1, settings.localNamingScheme),
            )
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
        message: `Gespeichert unter ${locationLabel} (${(fileSize / (1024 * 1024)).toFixed(1)} MB via ${usedHoster}).`,
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
        if (!cfg.enabled) break
        const now = Date.now()
        const bwState = resolveEffectiveBandwidthKbps(cfg, now)
        if (!bwState.allowed) break

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
        const activeCount = activeControllers.size
        if (activeCount >= concurrency) break

        const eligible = refreshed.filter((item) => {
          if (item.status !== 'queued' || activeControllers.has(item.id)) return false
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
        return { ...j, status: 'queued', attempts: 0, nextRetryAt: null, error: null, progress: 0, updatedAt: Date.now() }
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
