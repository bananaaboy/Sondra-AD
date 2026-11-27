import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import {
  checkAniworldOnlineUpdates,
  extractAnimeKaizen,
  extractAniworldSeason,
  extractDirectMedia,
  extractGoogleDrive,
  extractPodcast,
  isAnimeKaizenUrl,
  isAniworldSeasonUrl,
  isAniworldUrl,
  isGoogleDriveUrl,
  isPodcastOrRssUrl,
} from '../api/extractors.js'
import {
  archiveSeasonPath,
  buildAniworldEpisodeUrl,
  hintProperties,
  isEpisodeWatched,
  lastActivityAt,
  seasonFolderName,
  seasonPath,
  localSeriesFolderName,
} from '../shared/merklisteMerge.mjs'
import { sniffMediaFile } from './mediaCheck.mjs'
import { resolveBindIpv4 } from './mediaTools.mjs'

export function buildReleaseCalendar(merkItems, config, episodeIndex, nextCheckAt = null) {
  const downloaded = episodeIndex?.downloaded || {}
  const overrides = config?.seriesOverrides || {}
  const entries = []

  for (const item of merkItems || []) {
    if (!item || item.status === 'dropped' || item.status === 'paused') continue
    const ov = overrides[item.id] || {}
    if (ov.enabled === false) continue

    let latestDlAt = 0
    let downloadedCount = 0
    for (const rec of Object.values(downloaded)) {
      if (rec && rec.seriesId === item.id) {
        downloadedCount += 1
        if (typeof rec.at === 'number' && rec.at > latestDlAt) {
          latestDlAt = rec.at
        }
      }
    }

    let airDay = null
    let airDaySource = 'inferred'
    if (typeof ov.airDay === 'number' && ov.airDay >= 0 && ov.airDay <= 6) {
      airDay = ov.airDay
      airDaySource = 'manual'
    } else {
      const refTs = latestDlAt || item.onlineAvailable?.checkedAt || item.updatedAt || Date.now()
      airDay = new Date(refTs).getDay()
      airDaySource = 'inferred'
    }

    entries.push({
      seriesId: item.id,
      title: item.title,
      status: item.status || 'watching',
      airDay,
      airDaySource,
      currentSeason: item.season || 1,
      currentEpisode: typeof item.episode === 'number' ? item.episode : null,
      downloadedCount,
      nextCheckAt,
    })
  }

  return entries
}

export function computeNextShutdownAt(timeStr, nowMs = Date.now()) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(timeStr || '').trim())
  if (!m) return null
  const hour = Number(m[1])
  const minute = Number(m[2])
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null
  }
  const d = new Date(nowMs)
  d.setHours(hour, minute, 0, 0)
  if (d.getTime() <= nowMs) {
    d.setDate(d.getDate() + 1)
  }
  return d.getTime()
}

function defaultExecuteSystemPowerAction(action) {
  if (process.platform === 'win32') {
    if (action === 'hibernate') {
      spawn('shutdown.exe', ['/h'], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
      return
    }
    if (action === 'sleep') {
      spawn('rundll32.exe', ['powrprof.dll,SetSuspendState', '0,1,0'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      }).unref()
      return
    }
    spawn('shutdown.exe', ['/s', '/t', '0'], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
    return
  }
  if (process.platform === 'darwin') {
    const cmd = action === 'sleep' ? 'tell application "System Events" to sleep' : 'tell application "System Events" to shut down'
    spawn('osascript', ['-e', cmd], { detached: true, stdio: 'ignore' }).unref()
    return
  }
  const verb = action === 'sleep' ? 'suspend' : action === 'hibernate' ? 'hibernate' : 'poweroff'
  spawn('systemctl', [verb], { detached: true, stdio: 'ignore' }).unref()
}

export function createScheduler({
  store,
  driveAuth,
  driveService,
  mediaTools,
  worker,
  onNotify = null,
  onPowerAction = defaultExecuteSystemPowerAction,
}) {
  let checkRunning = false
  let cleanupRunning = false
  let archiveRunning = false
  let tickTimer = null
  let lastOnlineState = true

  function shouldWatchSeries(item, cfg) {
    const override = cfg.seriesOverrides?.[item.id]
    if (override && typeof override.enabled === 'boolean') return override.enabled
    if (!item.url) return false
    const status = item.status || 'watching'
    if (status === 'dropped') return false
    return Array.isArray(cfg.watchStatuses) ? cfg.watchStatuses.includes(status) : status === 'watching'
  }

  function selectEpisodesForSeries(item, discoveredSeasons, cfg) {
    const override = cfg.seriesOverrides?.[item.id] || {}
    const seasonRules = override.seasonRules && typeof override.seasonRules === 'object' ? override.seasonRules : null
    const backlogMode = override.backlogMode || cfg.backlogMode || 'from_current'
    const lookahead =
      typeof override.lookaheadLimit === 'number' ? override.lookaheadLimit : Number(cfg.lookaheadLimit) || 0

    const prevOnline = item.onlineAvailable
    const status = item.status || 'watching'
    const curSeason = typeof item.season === 'number' ? item.season : 1
    const curEpisode = typeof item.episode === 'number' && item.episode > 0 ? item.episode : 1

    const candidates = []
    const sortedSeasons = [...discoveredSeasons]
      .filter((s) => s.number > 0 && typeof s.episodes === 'number' && s.episodes > 0)
      .sort((a, b) => a.number - b.number)

    for (const s of sortedSeasons) {
      const sRule = seasonRules ? (seasonRules[String(s.number)] ?? seasonRules[s.number] ?? null) : null
      if (sRule && sRule.enabled === false) continue

      const fromEp = typeof sRule?.fromEpisode === 'number' && sRule.fromEpisode > 0 ? sRule.fromEpisode : null
      const toEp = typeof sRule?.toEpisode === 'number' && sRule.toEpisode > 0 ? sRule.toEpisode : null
      const maxEp = typeof sRule?.maxEpisodes === 'number' && sRule.maxEpisodes > 0 ? sRule.maxEpisodes : null
      const hasExplicitSeasonRule = Boolean(sRule && sRule.enabled === true && (fromEp || toEp || maxEp))

      let existingInSeason = 0
      if (maxEp) {
        for (let epCheck = 1; epCheck <= s.episodes; epCheck += 1) {
          if (store.hasEpisode(item.id, s.number, epCheck)) existingInSeason += 1
        }
      }
      let addedInSeason = 0

      for (let ep = 1; ep <= s.episodes; ep += 1) {
        if (fromEp && ep < fromEp) continue
        if (toEp && ep > toEp) continue
        if (maxEp && existingInSeason + addedInSeason >= maxEp) break
        if (isEpisodeWatched(item, s.number, ep)) continue
        if (store.hasEpisode(item.id, s.number, ep)) continue

        const isBrandNewOnline = prevOnline
          ? s.number > prevOnline.maxSeason ||
            (s.number === prevOnline.maxSeason && ep > prevOnline.maxEpisode)
          : false

        if (!hasExplicitSeasonRule) {
          if (status === 'done') {
            const knownSeason = (item.seasons || []).find((ks) => ks.number === s.number)
            const beyondKnown =
              !knownSeason ||
              (typeof knownSeason.episodes === 'number' && ep > knownSeason.episodes) ||
              isBrandNewOnline
            if (!beyondKnown) continue
          } else if (backlogMode === 'new_only') {
            if (!prevOnline) continue
            if (!isBrandNewOnline) continue
          } else if (backlogMode === 'from_current') {
            if (s.number < curSeason) continue
            if (s.number === curSeason && ep < curEpisode) continue
          }
        }

        candidates.push({ season: s.number, episode: ep })
        addedInSeason += 1
      }
    }

    if (lookahead > 0 && candidates.length > lookahead) {
      return candidates.slice(0, lookahead)
    }
    return candidates
  }

  async function checkSingleSeries(item, cfg) {
    const localAddress = resolveBindIpv4(cfg.bindAddress)
    let queuedCount = 0

    if (isAniworldUrl(item.url)) {
      const online = await checkAniworldOnlineUpdates(item.url, {
        fullMetadata: true,
        localAddress,
      })
      if (!online || !Array.isArray(online.seasons)) return { checked: false, queued: 0 }

      const existingSeasons = Array.isArray(item.seasons) ? [...item.seasons] : []
      const mergedSeasons = [...existingSeasons]
      let metadataChanged = false

      for (const remoteSeason of online.seasons) {
        if (typeof remoteSeason.number !== 'number' || !remoteSeason.episodes) continue
        const idx = mergedSeasons.findIndex((s) => s.number === remoteSeason.number)
        if (idx === -1) {
          mergedSeasons.push({
            number: remoteSeason.number,
            episodes: remoteSeason.episodes,
            watched: [],
          })
          metadataChanged = true
        } else if (
          mergedSeasons[idx].episodes === null ||
          remoteSeason.episodes > mergedSeasons[idx].episodes
        ) {
          mergedSeasons[idx] = { ...mergedSeasons[idx], episodes: remoteSeason.episodes }
          metadataChanged = true
        }
      }

      const toDownload = selectEpisodesForSeries(item, online.seasons, cfg)

      const updatedOnlineInfo = {
        maxSeason: online.maxSeason,
        maxEpisode: online.maxEpisode,
        checkedAt: Date.now(),
        hasNew: toDownload.length > 0,
      }

      const currentItems = store.getMerkItems()
      const nextItems = currentItems.map((entry) => {
        if (entry.id !== item.id) return entry
        const reopenedStatus =
          entry.status === 'done' && toDownload.length > 0 ? 'watching' : entry.status
        return {
          ...entry,
          seasons: mergedSeasons,
          onlineAvailable: updatedOnlineInfo,
          status: reopenedStatus,
          ...(online.coverUrl && !entry.cover ? { cover: online.coverUrl } : {}),
          ...(metadataChanged ? { updatedAt: Date.now() } : {}),
        }
      })
      store.saveMerkliste(nextItems)

      for (const epInfo of toDownload) {
        const epUrl = buildAniworldEpisodeUrl(item.url, epInfo.season, epInfo.episode)
        if (!epUrl) continue
        const enq = worker.enqueueJob({
          url: epUrl,
          title: `${item.title} - S${String(epInfo.season).padStart(2, '0')}E${String(epInfo.episode).padStart(2, '0')}`,
          seriesId: item.id,
          seriesTitle: item.title,
          season: epInfo.season,
          episode: epInfo.episode,
          language: item.language !== 'auto' ? item.language : undefined,
          mode: item.mode,
          videoPref: item.videoPref !== 'untouched' ? item.videoPref : undefined,
        })
        if (enq.added) queuedCount += 1
      }

      return { checked: true, queued: queuedCount, metadataChanged }
    }

    if (isPodcastOrRssUrl(item.url)) {
      const feed = await extractPodcast(item.url, { localAddress })
      if (!feed || !Array.isArray(feed.items)) return { checked: false, queued: 0 }
      const ordered = [...feed.items].reverse()
      const discovered = [{ number: 1, episodes: ordered.length }]
      const targets = selectEpisodesForSeries(item, discovered, cfg)
      for (const t of targets) {
        const entry = ordered[t.episode - 1]
        if (!entry?.url) continue
        const enq = worker.enqueueJob({
          url: entry.url,
          title: entry.title || `${item.title} - Folge ${t.episode}`,
          seriesId: item.id,
          seriesTitle: item.title,
          season: 1,
          episode: t.episode,
          mode: item.mode || 'audio',
        })
        if (enq.added) queuedCount += 1
      }
      return { checked: true, queued: queuedCount, metadataChanged: false }
    }

    if (/[?&]list=|\/playlist\b|\/sets\//i.test(item.url)) {
      const pl = await mediaTools.listPlaylistEntries(item.url)
      if (!pl || !Array.isArray(pl.entries)) return { checked: false, queued: 0 }
      const discovered = [{ number: item.season || 1, episodes: pl.entries.length }]
      const targets = selectEpisodesForSeries(item, discovered, cfg)
      for (const t of targets) {
        const entry = pl.entries[t.episode - 1]
        if (!entry?.url) continue
        const enq = worker.enqueueJob({
          url: entry.url,
          title: entry.title || `${item.title} - Folge ${t.episode}`,
          seriesId: item.id,
          seriesTitle: item.title,
          season: t.season,
          episode: t.episode,
          mode: item.mode,
        })
        if (enq.added) queuedCount += 1
      }
      return { checked: true, queued: queuedCount, metadataChanged: false }
    }

    const epNum = item.episode || 1
    const sNum = item.season || 1
    if (!isEpisodeWatched(item, sNum, epNum) && !store.hasEpisode(item.id, sNum, epNum)) {
      const enq = worker.enqueueJob({
        url: item.url,
        title: item.title,
        seriesId: item.id,
        seriesTitle: item.title,
        season: sNum,
        episode: epNum,
        mode: item.mode,
      })
      if (enq.added) queuedCount += 1
    }
    return { checked: true, queued: queuedCount, metadataChanged: false }
  }

  async function resolveDriveTarget(root, seriesId, title, season) {
    if (typeof driveService.resolveSeasonFolder === 'function') {
      return driveService.resolveSeasonFolder({ root, seriesId: seriesId || null, seriesTitle: title, season })
    }
    const segments = root === 'Archiv' ? archiveSeasonPath(title, season) : seasonPath(title, season)
    return { segments, folderId: null }
  }

  let mediaRepairRunning = false

  /**
   * Repariert bereits hochgeladene, nicht abspielbare Folgen:
   * MPEG-TS unter ".mp4" wird mit FFmpeg verlustfrei in echtes MP4 umgepackt und an
   * derselben Stelle ersetzt; HTML-/Text-Müll kommt in den Papierkorb und wird neu geladen.
   */
  async function repairBrokenDriveMedia() {
    if (mediaRepairRunning || !driveAuth.isConnected()) return { repaired: 0, requeued: 0 }
    const tree = driveService.getLastSyncedTree?.()
    if (!tree) return { repaired: 0, requeued: 0 }
    mediaRepairRunning = true
    let repaired = 0
    let requeued = 0
    try {
      const broken = await driveService.findBrokenDriveMedia(tree).catch(() => [])
      for (const f of broken) {
        const where = f.path || f.name
        if (f.kind === 'ts') {
          if (!mediaTools.findFfmpeg()) {
            driveService.markMediaChecked(f)
            store.addLog({
              category: 'download',
              level: 'warn',
              title: 'Folge im TS-Format — FFmpeg fehlt',
              message: `${where} ist ein HLS-Mitschnitt mit .mp4-Endung und lässt sich in Drive/Browser nicht abspielen. Nach der Installation von FFmpeg repariert Sondra AD die Datei automatisch.`,
            })
            continue
          }
          const workDir = path.join(store.getConfig().tempDir, `reparatur-${f.id}`)
          try {
            fs.mkdirSync(workDir, { recursive: true })
            const src = path.join(workDir, 'quelle.ts')
            const out = path.join(workDir, 'fertig.mp4')
            await driveService.downloadFileToLocal(f.id, src)
            const ok = await mediaTools.remuxToMp4({ inputFile: src, outputFile: out })
            if (ok && sniffMediaFile(out) === 'mp4') {
              const updated = await driveService.uploadFileToDrive([], f.name, out, {
                folderId: (f.parents ?? [])[0],
                mime: 'video/mp4',
                replaceExisting: true,
              })
              driveService.markMediaChecked(updated)
              repaired += 1
              store.addLog({
                category: 'download',
                title: `Folge repariert: ${f.name}`,
                message: `${where} war ein HLS-Mitschnitt (MPEG-TS) mit .mp4-Endung und wurde verlustfrei in ein abspielbares MP4 umgepackt.`,
              })
              continue
            }
          } catch (err) {
            store.addLog({
              category: 'download',
              level: 'warn',
              title: `Reparatur fehlgeschlagen: ${f.name}`,
              message: String(err?.message ?? err),
            })
          } finally {
            try {
              fs.rmSync(workDir, { recursive: true, force: true })
            } catch {}
          }
        }
        if (!f.hint) {
          driveService.markMediaChecked(f)
          continue
        }
        try {
          await driveService.setTrashed(f.id, true)
          store.unmarkEpisode(f.hint.series, f.hint.season, f.hint.episode)
          requeued += 1
          store.addLog({
            category: 'download',
            level: 'warn',
            title: `Defekte Folge entfernt: ${f.name}`,
            message: `${where} enthielt kein abspielbares Video und liegt jetzt im Google-Drive-Papierkorb. Die Folge wird bei der nächsten Prüfung neu geladen.`,
            seriesId: f.hint.series,
            season: f.hint.season,
            episode: f.hint.episode,
          })
        } catch {}
      }
    } finally {
      mediaRepairRunning = false
    }
    return { repaired, requeued }
  }

  async function runCheckCycle({ reason = 'auto', seriesId = null } = {}) {
    if (checkRunning) return { ok: false, busy: true }
    checkRunning = true
    store.events.emit('status', { checking: true })
    try {
      const cfg = store.getConfig()
      if (driveAuth.isConnected()) {
        await driveService.syncMerkliste().catch((err) => {
          store.addLog({
            category: 'sync',
            level: 'warn',
            title: 'Merklisten-Abgleich fehlgeschlagen',
            message: String(err?.message ?? err),
          })
        })
        await repairBrokenDriveMedia().catch(() => null)
      }

      const items = store.getMerkItems()
      const targets = seriesId
        ? items.filter((i) => i.id === seriesId && i.url)
        : items.filter((i) => shouldWatchSeries(i, cfg))

      let checkedSeries = 0
      let totalQueued = 0
      let merkChanged = false

      for (let idx = 0; idx < targets.length; idx += 1) {
        if (idx > 0 && !seriesId) {
          await new Promise((r) => setTimeout(r, 800))
        }
        const current = store.getMerkItems().find((i) => i.id === targets[idx].id)
        if (!current) continue
        try {
          const res = await checkSingleSeries(current, cfg)
          if (res.checked) checkedSeries += 1
          totalQueued += res.queued
          if (res.metadataChanged) merkChanged = true
        } catch (err) {
          store.addLog({
            category: 'sync',
            level: 'warn',
            title: `Prüfung fehlgeschlagen: ${current.title}`,
            message: String(err?.message ?? err),
            seriesId: current.id,
            seriesTitle: current.title,
          })
        }
      }

      if (merkChanged && driveAuth.isConnected()) {
        await driveService.pushMerkliste().catch(() => {})
      }

      const now = Date.now()
      const nextCheckAt = now + Math.max(5, Number(cfg.checkIntervalMinutes) || 30) * 60_000
      store.updateMerkMeta({ lastCheckAt: now, nextCheckAt })

      if (totalQueued > 0 || reason === 'manual') {
        store.addLog({
          category: 'sync',
          title: totalQueued > 0 ? `${totalQueued} neue Folge(n) eingereiht` : 'Merkliste geprüft — alles aktuell',
          message: `${checkedSeries} Serie(n) überprüft${totalQueued > 0 ? `, ${totalQueued} Download(s) gestartet.` : '.'}`,
        })
      }

      void worker.pumpQueue()
      return { ok: true, checkedSeries, totalQueued }
    } finally {
      checkRunning = false
      store.events.emit('status', { checking: false })
    }
  }

  async function enqueueManualUrl({ url, language, mode, videoPref }) {
    const cleanUrl = String(url || '').trim()
    if (!/^https?:\/\//i.test(cleanUrl)) {
      throw new Error('Bitte eine gültige http(s)-Adresse eingeben.')
    }
    const cfg = store.getConfig()
    const localAddress = resolveBindIpv4(cfg.bindAddress)

    if (isAniworldSeasonUrl(cleanUrl)) {
      const seasonInfo = await extractAniworldSeason(cleanUrl, { localAddress })
      if (seasonInfo && Array.isArray(seasonInfo.items) && seasonInfo.items.length > 0) {
        let added = 0
        for (const ep of seasonInfo.items) {
          const res = worker.enqueueJob({
            url: ep.url,
            title: ep.title,
            seriesTitle: seasonInfo.seriesTitle,
            season: ep.seasonNumber,
            episode: ep.episodeNumber,
            language,
            mode,
            videoPref,
            manualForce: true,
          })
          if (res.added) added += 1
        }
        return { count: added, playlistTitle: seasonInfo.title }
      }
    }

    if (isPodcastOrRssUrl(cleanUrl)) {
      const feed = await extractPodcast(cleanUrl, { localAddress }).catch(() => null)
      if (feed && Array.isArray(feed.items) && feed.items.length > 0) {
        let added = 0
        const ordered = [...feed.items].reverse()
        for (let i = 0; i < ordered.length; i += 1) {
          const ep = ordered[i]
          if (!ep?.url) continue
          const res = worker.enqueueJob({
            url: ep.url,
            title: ep.title || `${feed.title || 'Podcast'} - Folge ${i + 1}`,
            seriesTitle: feed.title || null,
            season: 1,
            episode: i + 1,
            mode: mode || 'audio',
            manualForce: true,
          })
          if (res.added) added += 1
        }
        return { count: added, playlistTitle: feed.title }
      }
    }

    if (isGoogleDriveUrl(cleanUrl) || isAnimeKaizenUrl(cleanUrl)) {
      const folderOrSeries = isGoogleDriveUrl(cleanUrl)
        ? await extractGoogleDrive(cleanUrl, { localAddress }).catch(() => null)
        : await extractAnimeKaizen(cleanUrl, { localAddress }).catch(() => null)
      if (folderOrSeries?.isPlaylist && Array.isArray(folderOrSeries.items) && folderOrSeries.items.length > 0) {
        let added = 0
        for (let i = 0; i < folderOrSeries.items.length; i += 1) {
          const ep = folderOrSeries.items[i]
          if (!ep?.url) continue
          const res = worker.enqueueJob({
            url: ep.url,
            title: ep.title || `${folderOrSeries.title || 'Sammlung'} - ${i + 1}`,
            seriesTitle: folderOrSeries.seriesTitle || folderOrSeries.title || null,
            season: typeof ep.seasonNumber === 'number' ? ep.seasonNumber : 1,
            episode: typeof ep.episodeNumber === 'number' ? ep.episodeNumber : i + 1,
            language,
            mode,
            videoPref,
            manualForce: true,
          })
          if (res.added) added += 1
        }
        return { count: added, playlistTitle: folderOrSeries.title }
      }
    }

    if (/[?&]list=|\/playlist\b|\/sets\//i.test(cleanUrl)) {
      const pl = await mediaTools.listPlaylistEntries(cleanUrl).catch(() => null)
      if (pl && Array.isArray(pl.entries) && pl.entries.length > 0) {
        let added = 0
        for (let i = 0; i < pl.entries.length; i += 1) {
          const ep = pl.entries[i]
          if (!ep?.url) continue
          const res = worker.enqueueJob({
            url: ep.url,
            title: ep.title || `${pl.title || 'Wiedergabeliste'} - ${i + 1}`,
            seriesTitle: pl.title || null,
            season: 1,
            episode: i + 1,
            language,
            mode,
            videoPref,
            manualForce: true,
          })
          if (res.added) added += 1
        }
        return { count: added, playlistTitle: pl.title }
      }
    }

    let initialTitle = cleanUrl
    let seasonNum = 1
    let episodeNum = 1
    let seriesTitle = null
    try {
      const u = new URL(cleanUrl)
      const awMatch = u.pathname.match(/\/(?:anime|serie)\/stream\/([^/?#]+)(?:\/staffel-(\d+)\/episode-(\d+)|\/filme\/film-(\d+))?/i)
      if (awMatch) {
        const slugTitle = awMatch[1]
          .split('-')
          .filter(Boolean)
          .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
          .join(' ')
        seriesTitle = slugTitle || null
        if (awMatch[4]) {
          seasonNum = 0
          episodeNum = Number(awMatch[4]) || 1
          initialTitle = `${slugTitle} - Film ${episodeNum}`
        } else if (awMatch[2] && awMatch[3]) {
          seasonNum = Number(awMatch[2]) || 1
          episodeNum = Number(awMatch[3]) || 1
          initialTitle = `${slugTitle} - S${String(seasonNum).padStart(2, '0')}E${String(episodeNum).padStart(2, '0')}`
        } else {
          initialTitle = slugTitle || cleanUrl
        }
      }
    } catch {}

    const res = worker.enqueueJob({
      url: cleanUrl,
      title: initialTitle,
      seriesTitle,
      season: seasonNum,
      episode: episodeNum,
      language,
      mode,
      videoPref,
      manualForce: true,
    })
    return { count: res.added ? 1 : 0, job: res.job }
  }

  async function runStorageCleanup({ dryRun = false } = {}) {
    if (cleanupRunning && !dryRun) return { ok: false, busy: true }
    if (!dryRun) cleanupRunning = true
    try {
      const cfg = store.getConfig()
      const storage = await driveService.inspectStorage()
      const merkItems = store.getMerkItems()
      const merkMap = new Map(merkItems.map((m) => [m.id, m]))

      let neededDriveBytes = 0
      if (storage.connected && storage.drive) {
        const d = storage.drive
        if (cfg.maxSondraDriveGb > 0) {
          const maxBytes = cfg.maxSondraDriveGb * 1024 ** 3
          const currentWithTrash = d.sondraTotalBytes + d.sondraTrashBytes
          if (currentWithTrash > maxBytes) {
            neededDriveBytes = Math.max(neededDriveBytes, currentWithTrash - maxBytes)
          }
        }
        if (cfg.minFreeDriveGb > 0 && d.freeBytes !== null) {
          const minFreeBytes = cfg.minFreeDriveGb * 1024 ** 3
          if (d.freeBytes < minFreeBytes) {
            neededDriveBytes = Math.max(neededDriveBytes, minFreeBytes - d.freeBytes)
          }
        }
      }

      let neededLocalBytes = 0
      if (cfg.minFreeLocalGb > 0 && storage.local?.totalBytes > 0) {
        const minFreeLocal = cfg.minFreeLocalGb * 1024 ** 3
        if (storage.local.freeBytes < minFreeLocal) {
          neededLocalBytes = minFreeLocal - storage.local.freeBytes
        }
      }

      const drivePlan = []
      if (neededDriveBytes > 0 && storage.drive) {
        let acc = 0
        if (cfg.emptyDriveTrashFirst && storage.drive.trashed.length > 0) {
          for (const tf of storage.drive.trashed) {
            if (acc >= neededDriveBytes) break
            drivePlan.push({
              target: 'drive',
              reason: 'Papierkorb leeren',
              id: tf.id,
              name: tf.name,
              path: `Papierkorb/${tf.name}`,
              sizeBytes: tf.size,
              hint: null,
            })
            acc += tf.size
          }
        }

        const seriesFiles = storage.drive.files.filter((f) => f.path.startsWith('Serien/'))
        if (acc < neededDriveBytes && cfg.deleteWatchedFirst) {
          const watchedBySeries = new Map()
          for (const f of seriesFiles) {
            if (!f.hint) continue
            const series = merkMap.get(f.hint.series)
            if (!series || !isEpisodeWatched(series, f.hint.season, f.hint.episode)) continue
            const list = watchedBySeries.get(series.id) || []
            list.push(f)
            watchedBySeries.set(series.id, list)
          }

          const deletableWatched = []
          const keepCount = Math.max(0, Number(cfg.keepRecentWatchedCount) || 0)
          for (const [, list] of watchedBySeries) {
            list.sort((a, b) => (a.hint.season - b.hint.season) || (a.hint.episode - b.hint.episode))
            const sliceEnd = keepCount > 0 ? Math.max(0, list.length - keepCount) : list.length
            deletableWatched.push(...list.slice(0, sliceEnd))
          }
          deletableWatched.sort(
            (a, b) => new Date(a.modifiedTime || 0).getTime() - new Date(b.modifiedTime || 0).getTime(),
          )

          for (const wf of deletableWatched) {
            if (acc >= neededDriveBytes) break
            drivePlan.push({
              target: 'drive',
              reason: 'Bereits gesehen',
              id: wf.id,
              name: wf.name,
              path: wf.path,
              sizeBytes: wf.size,
              hint: wf.hint,
            })
            acc += wf.size
          }
        }

        if (acc < neededDriveBytes && cfg.deleteArchivedWhenFull) {
          const archivedFiles = storage.drive.files
            .filter((f) => f.path.startsWith('Archiv/'))
            .sort((a, b) => new Date(a.modifiedTime || 0).getTime() - new Date(b.modifiedTime || 0).getTime())
          for (const af of archivedFiles) {
            if (acc >= neededDriveBytes) break
            drivePlan.push({
              target: 'drive',
              reason: 'Ältester Archiv-Eintrag',
              id: af.id,
              name: af.name,
              path: af.path,
              sizeBytes: af.size,
              hint: af.hint,
            })
            acc += af.size
          }
        }

        if (acc < neededDriveBytes && !cfg.protectUnwatched) {
          const pickedIds = new Set(drivePlan.map((p) => p.id))
          const remaining = seriesFiles
            .filter((f) => !pickedIds.has(f.id))
            .sort((a, b) => new Date(a.modifiedTime || 0).getTime() - new Date(b.modifiedTime || 0).getTime())
          for (const uf of remaining) {
            if (acc >= neededDriveBytes) break
            drivePlan.push({
              target: 'drive',
              reason: 'Speicherlimit überschritten',
              id: uf.id,
              name: uf.name,
              path: uf.path,
              sizeBytes: uf.size,
              hint: uf.hint,
            })
            acc += uf.size
          }
        }
      }

      const localPlan = []
      if (neededLocalBytes > 0 && fs.existsSync(cfg.localDir)) {
        const allLocal = []
        const walk = (dir) => {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name)
            if (entry.isDirectory()) walk(full)
            else if (entry.isFile()) {
              const st = fs.statSync(full)
              allLocal.push({ full, name: entry.name, sizeBytes: st.size, mtimeMs: st.mtimeMs })
            }
          }
        }
        walk(cfg.localDir)
        allLocal.sort((a, b) => a.mtimeMs - b.mtimeMs)
        let localAcc = 0
        for (const lf of allLocal) {
          if (localAcc >= neededLocalBytes) break
          localPlan.push({
            target: 'local',
            reason: 'Lokaler Mindest-Freispeicher',
            id: lf.full,
            name: lf.name,
            path: lf.full,
            sizeBytes: lf.sizeBytes,
          })
          localAcc += lf.sizeBytes
        }
      }

      const candidates = [...drivePlan, ...localPlan]
      const reclaimableBytes = candidates.reduce((s, c) => s + c.sizeBytes, 0)

      if (dryRun) {
        return {
          ok: true,
          dryRun: true,
          neededDriveBytes,
          neededLocalBytes,
          reclaimableBytes,
          candidates,
        }
      }

      let deletedBytes = 0
      let deletedCount = 0
      for (const item of candidates) {
        try {
          if (item.target === 'drive') {
            await driveService.deleteFilePermanently(item.id)
            if (item.hint) {
              store.unmarkEpisode(item.hint.series, item.hint.season, item.hint.episode)
            }
          } else if (item.target === 'local') {
            fs.rmSync(item.path, { force: true })
          }
          deletedBytes += item.sizeBytes
          deletedCount += 1
        } catch (err) {
          store.addLog({
            category: 'storage',
            level: 'warn',
            title: `Löschen fehlgeschlagen: ${item.name}`,
            message: String(err?.message ?? err),
          })
        }
      }

      if (deletedCount > 0) {
        store.addLog({
          category: 'storage',
          title: `Speicher bereinigt: ${(deletedBytes / (1024 * 1024)).toFixed(1)} MB freigegeben`,
          message: `${deletedCount} Datei(en) gemäß Speicherregel entfernt.`,
        })
      }

      return {
        ok: true,
        dryRun: false,
        neededDriveBytes,
        neededLocalBytes,
        deletedCount,
        deletedBytes,
        candidates,
      }
    } finally {
      if (!dryRun) cleanupRunning = false
    }
  }

  async function runInactivityCheck({ dryRun = false } = {}) {
    if (archiveRunning && !dryRun) return { ok: false, busy: true }
    if (!dryRun) archiveRunning = true
    try {
      const cfg = store.getConfig()
      if (!driveAuth.isConnected()) return { ok: true, actions: [], processed: 0 }

      const tree = await driveService.listSondraTree()
      const merkItems = store.getMerkItems()
      const merkMap = new Map(merkItems.map((m) => [m.id, m]))
      const now = Date.now()
      const thresholdMs = Math.max(1, Number(cfg.inactivityDays) || 45) * 86_400_000
      const actionsSet = new Set(Array.isArray(cfg.inactivityActions) ? cfg.inactivityActions : ['drive_archive'])

      const planned = []
      const seriesFiles = tree.files.filter((f) => f.path.startsWith('Serien/'))

      for (const file of seriesFiles) {
        const series = file.hint ? merkMap.get(file.hint.series) : null
        const seriesLastActive = series ? lastActivityAt(series) : 0
        const fileModMs = file.modifiedTime ? new Date(file.modifiedTime).getTime() : 0
        const referenceMs = Math.max(seriesLastActive, fileModMs)
        if (!referenceMs || now - referenceMs < thresholdMs) continue

        const inactiveDays = Math.floor((now - referenceMs) / 86_400_000)
        planned.push({
          kind: 'inactive_series_file',
          file,
          series,
          inactiveDays,
          operations: [...actionsSet],
        })
      }

      if (cfg.archiveDeleteAfterDays > 0) {
        const archiveExpiryMs = cfg.archiveDeleteAfterDays * 86_400_000
        const archivedFiles = tree.files.filter((f) => f.path.startsWith('Archiv/'))
        for (const af of archivedFiles) {
          const modMs = af.modifiedTime ? new Date(af.modifiedTime).getTime() : 0
          if (modMs > 0 && now - modMs >= archiveExpiryMs) {
            planned.push({
              kind: 'expired_archive_file',
              file: af,
              series: af.hint ? merkMap.get(af.hint.series) : null,
              inactiveDays: Math.floor((now - modMs) / 86_400_000),
              operations: ['delete_expired_archive'],
            })
          }
        }
      }

      if (dryRun) {
        return {
          ok: true,
          dryRun: true,
          planned: planned.map((p) => ({
            id: p.file.id,
            name: p.file.name,
            path: p.file.path,
            sizeBytes: p.file.size,
            seriesTitle: p.series?.title || null,
            inactiveDays: p.inactiveDays,
            operations: p.operations,
          })),
        }
      }

      let processed = 0
      const pausedSeriesIds = new Set()

      for (const item of planned) {
        const f = item.file
        const title = item.series?.title || f.path.split('/')[1] || 'Unbekannt'
        const season = f.hint?.season ?? 1
        const episode = f.hint?.episode ?? 1

        try {
          if (item.kind === 'expired_archive_file' || actionsSet.has('delete')) {
            await driveService.deleteFilePermanently(f.id)
            if (f.hint) store.unmarkEpisode(f.hint.series, season, episode)
            processed += 1
            continue
          }

          if (actionsSet.has('offload_local')) {
            const destDir = path.join(cfg.localArchiveDir, localSeriesFolderName(title), seasonFolderName(season))
            const destFile = path.join(destDir, f.name)
            await driveService.downloadFileToLocal(f.id, destFile)
            await driveService.deleteFilePermanently(f.id)
            if (f.hint) {
              store.markEpisodeArchived(f.hint.series, season, episode, {
                driveFileId: null,
                localArchivePath: destFile,
                fileName: f.name,
                sizeBytes: fs.statSync(destFile).size,
              })
            }
            processed += 1
          } else if (actionsSet.has('compress_archive') && mediaTools.findFfmpeg()) {
            const workDir = path.join(cfg.tempDir, `arch-${Date.now()}`)
            fs.mkdirSync(workDir, { recursive: true })
            const rawPath = path.join(workDir, f.name)
            const compName = f.name.replace(/\.[^.]+$/, '') + ' (Archiv).mp4'
            const compPath = path.join(workDir, compName)
            try {
              await driveService.downloadFileToLocal(f.id, rawPath)
              const compressed = await mediaTools.compressVideoForArchive({
                inputFile: rawPath,
                outputFile: compPath,
                maxHeight: Number(cfg.archiveCompressHeight) || 720,
                useGpu: cfg.useGpuEncoding,
              })
              const uploadSource = compressed ? compPath : rawPath
              const uploadName = compressed ? compName : f.name
              const target = await resolveDriveTarget('Archiv', f.hint?.series, title, season)
              const targetSegs = target.segments
              const uploaded = await driveService.uploadFileToDrive(targetSegs, uploadName, uploadSource, {
                mime: 'video/mp4',
                appProperties: f.hint ? hintProperties(f.hint) : undefined,
                folderId: target.folderId,
              })
              await driveService.deleteFilePermanently(f.id)
              if (f.hint) {
                store.markEpisodeArchived(f.hint.series, season, episode, {
                  driveFileId: uploaded.id,
                  drivePath: `${targetSegs.join('/')}/${uploadName}`,
                  fileName: uploadName,
                  sizeBytes: uploaded.size,
                })
              }
              processed += 1
            } finally {
              fs.rmSync(workDir, { recursive: true, force: true })
            }
          } else if (actionsSet.has('drive_archive')) {
            const target = await resolveDriveTarget('Archiv', f.hint?.series, title, season)
            const targetSegs = target.segments
            const moved = await driveService.moveDriveFile(
              f.id,
              targetSegs,
              f.parents,
              f.hint ? hintProperties(f.hint) : undefined,
              target.folderId,
            )
            if (f.hint) {
              store.markEpisodeArchived(f.hint.series, season, episode, {
                driveFileId: moved.id,
                drivePath: `${targetSegs.join('/')}/${moved.name}`,
                fileName: moved.name,
                sizeBytes: moved.size,
              })
            }
            processed += 1
          }

          if (actionsSet.has('pause_series') && item.series && !pausedSeriesIds.has(item.series.id)) {
            pausedSeriesIds.add(item.series.id)
          }
        } catch (err) {
          store.addLog({
            category: 'archive',
            level: 'warn',
            title: `Archivierung fehlgeschlagen: ${f.name}`,
            message: String(err?.message ?? err),
          })
        }
      }

      if (pausedSeriesIds.size > 0) {
        const curCfg = store.getConfig()
        const overrides = { ...(curCfg.seriesOverrides || {}) }
        for (const sid of pausedSeriesIds) {
          overrides[sid] = { ...(overrides[sid] || {}), enabled: false }
        }
        store.saveConfig({ seriesOverrides: overrides })
      }

      if (processed > 0 || pausedSeriesIds.size > 0) {
        store.addLog({
          category: 'archive',
          title: `Inaktivitäts-Regel ausgeführt (${processed} Datei(en))`,
          message: `${processed} lange ungenutzte Datei(en) verarbeitet${pausedSeriesIds.size > 0 ? `, ${pausedSeriesIds.size} Serie(n) pausiert` : ''}.`,
        })
      }

      return { ok: true, dryRun: false, processed, pausedSeries: pausedSeriesIds.size }
    } finally {
      if (!dryRun) archiveRunning = false
    }
  }

  async function restoreFromArchive({ driveFileId = null, localArchivePath = null, seriesId = null, season = 1, episode = 1, seriesTitle = 'Serie' }) {
    let targetSegs = seasonPath(seriesTitle, season)
    let targetFolderId = null
    if (driveAuth.isConnected() && (driveFileId || localArchivePath)) {
      const target = await resolveDriveTarget('Serien', seriesId, seriesTitle, season)
      targetSegs = target.segments
      targetFolderId = target.folderId
    }
    const props = seriesId ? hintProperties({ series: seriesId, season, episode }) : undefined

    if (driveFileId) {
      const tree = await driveService.listSondraTree()
      const existing = tree.files.find((f) => f.id === driveFileId)
      const moved = await driveService.moveDriveFile(
        driveFileId,
        targetSegs,
        existing?.parents || [],
        props,
        targetFolderId,
      )
      if (seriesId) {
        store.markEpisodeDownloaded(seriesId, season, episode, {
          driveFileId: moved.id,
          drivePath: `${targetSegs.join('/')}/${moved.name}`,
          fileName: moved.name,
          sizeBytes: moved.size,
        })
      }
      store.addLog({
        category: 'archive',
        title: `Aus Archiv wiederhergestellt: ${moved.name}`,
        message: `Zurückgelegt nach Sondra/${targetSegs.join('/')}.`,
      })
      return { ok: true, file: moved }
    }

    if (localArchivePath && fs.existsSync(localArchivePath) && driveAuth.isConnected()) {
      const fileName = path.basename(localArchivePath)
      const uploaded = await driveService.uploadFileToDrive(targetSegs, fileName, localArchivePath, {
        mime: 'video/mp4',
        appProperties: props,
        folderId: targetFolderId,
      })
      fs.rmSync(localArchivePath, { force: true })
      if (seriesId) {
        store.markEpisodeDownloaded(seriesId, season, episode, {
          driveFileId: uploaded.id,
          drivePath: `${targetSegs.join('/')}/${fileName}`,
          fileName,
          sizeBytes: uploaded.size,
        })
      }
      store.addLog({
        category: 'archive',
        title: `Aus lokalem Archiv nach Drive geladen: ${fileName}`,
        message: `Wiederhergestellt unter Sondra/${targetSegs.join('/')}.`,
      })
      return { ok: true, file: uploaded }
    }

    throw new Error('Archiv-Datei wurde nicht gefunden.')
  }

  let lastSyncRun = 0
  let lastCleanupRun = 0
  let lastHeartbeatRun = 0

  let scheduledShutdownAt = null
  let shutdownWaitingForDownloads = false
  let shutdownCountdownEndsAt = null
  let shutdownTimer = null
  let lastShutdownSignature = ''
  let afterQueueArmed = Boolean(store.getConfig().shutdownAfterQueue)

  function getShutdownState() {
    const cfg = store.getConfig()
    return {
      enabled: Boolean(cfg.scheduledShutdownEnabled),
      shutdownAfterQueue: Boolean(cfg.shutdownAfterQueue),
      action: cfg.scheduledShutdownAction || 'shutdown',
      scheduledAt: cfg.scheduledShutdownEnabled ? scheduledShutdownAt : null,
      waitingForDownloads: shutdownWaitingForDownloads,
      countdownEndsAt: shutdownCountdownEndsAt,
    }
  }

  function emitShutdownState() {
    store.events.emit('status', { shutdownState: getShutdownState() })
  }

  function clearShutdownTimer() {
    if (shutdownTimer) {
      clearTimeout(shutdownTimer)
      shutdownTimer = null
    }
  }

  function recomputeShutdownSchedule(nowMs = Date.now()) {
    const cfg = store.getConfig()
    const sig = `${Boolean(cfg.scheduledShutdownEnabled)}|${cfg.scheduledShutdownTime || ''}|${cfg.scheduledShutdownAction || 'shutdown'}`
    if (!cfg.scheduledShutdownEnabled) {
      if (!cfg.shutdownAfterQueue) {
        clearShutdownTimer()
        shutdownWaitingForDownloads = false
        shutdownCountdownEndsAt = null
      }
      scheduledShutdownAt = null
      lastShutdownSignature = sig
      emitShutdownState()
      return getShutdownState()
    }
    if (sig !== lastShutdownSignature || !scheduledShutdownAt) {
      clearShutdownTimer()
      shutdownWaitingForDownloads = false
      shutdownCountdownEndsAt = null
      scheduledShutdownAt = computeNextShutdownAt(cfg.scheduledShutdownTime, nowMs)
      lastShutdownSignature = sig
      emitShutdownState()
    }
    return getShutdownState()
  }

  function setShutdownAfterQueue(enabled) {
    const flag = Boolean(enabled)
    store.saveConfig({ shutdownAfterQueue: flag })
    afterQueueArmed = flag
    if (!flag && shutdownCountdownEndsAt && !store.getConfig().scheduledShutdownEnabled) {
      clearShutdownTimer()
      shutdownCountdownEndsAt = null
    }
    store.addLog({
      category: 'system',
      title: flag ? 'Herunterfahren nach Warteschlange aktiviert' : 'Herunterfahren nach Warteschlange deaktiviert',
      message: flag
        ? 'Sobald alle laufenden und eingereihten Downloads abgeschlossen sind, startet ein 60-Sekunden-Countdown.'
        : 'Das Gerät bleibt nach Abschluss der Warteschlange eingeschaltet.',
    })
    emitShutdownState()
    return getShutdownState()
  }

  function cancelPendingShutdown() {
    clearShutdownTimer()
    const cfg = store.getConfig()
    shutdownWaitingForDownloads = false
    shutdownCountdownEndsAt = null
    afterQueueArmed = false
    const patch = {}
    if (cfg.shutdownAfterQueue) patch.shutdownAfterQueue = false
    if (cfg.scheduledShutdownEnabled) {
      if (cfg.scheduledShutdownRepeatDaily) {
        scheduledShutdownAt = computeNextShutdownAt(cfg.scheduledShutdownTime, Date.now() + 61_000)
      } else {
        patch.scheduledShutdownEnabled = false
        scheduledShutdownAt = null
        lastShutdownSignature = `false|${cfg.scheduledShutdownTime || ''}|${cfg.scheduledShutdownAction || 'shutdown'}`
      }
    } else {
      scheduledShutdownAt = null
    }
    if (Object.keys(patch).length > 0) {
      store.saveConfig(patch)
    }
    store.addLog({
      category: 'system',
      title: 'Geplantes Herunterfahren abgebrochen',
      message: 'Das Gerät bleibt eingeschaltet.',
    })
    emitShutdownState()
    return getShutdownState()
  }

  function executeScheduledPowerNow(reason = 'scheduled') {
    clearShutdownTimer()
    const cfg = store.getConfig()
    const action = cfg.scheduledShutdownAction || 'shutdown'
    shutdownWaitingForDownloads = false
    shutdownCountdownEndsAt = null
    afterQueueArmed = false
    const patch = {}
    if (cfg.shutdownAfterQueue) patch.shutdownAfterQueue = false
    if (reason === 'scheduled' && cfg.scheduledShutdownEnabled) {
      if (cfg.scheduledShutdownRepeatDaily) {
        scheduledShutdownAt = computeNextShutdownAt(cfg.scheduledShutdownTime, Date.now() + 61_000)
      } else {
        patch.scheduledShutdownEnabled = false
        scheduledShutdownAt = null
        lastShutdownSignature = `false|${cfg.scheduledShutdownTime || ''}|${action}`
      }
    }
    if (Object.keys(patch).length > 0) {
      store.saveConfig(patch)
    }
    const label =
      action === 'sleep' ? 'Energiesparmodus' : action === 'hibernate' ? 'Ruhezustand' : 'Herunterfahren'
    store.addLog({
      category: 'system',
      title: `Energie-Aktion ausgelöst: ${label}`,
      message:
        reason === 'after_queue'
          ? 'Alle Downloads in der Warteschlange wurden abgeschlossen.'
          : `Ausgeführt um ${cfg.scheduledShutdownTime || 'geplanter Zeit'}.`,
    })
    emitShutdownState()
    try {
      onPowerAction(action)
    } catch (err) {
      store.addLog({
        category: 'system',
        level: 'error',
        title: `${label} fehlgeschlagen`,
        message: String(err?.message ?? err),
      })
    }
  }

  function startPowerCountdown(nowMs, delayMs, reason) {
    const cfg = store.getConfig()
    const delay = Math.max(0, Number(delayMs) || 0)
    if (delay === 0) {
      executeScheduledPowerNow(reason)
      return getShutdownState()
    }
    shutdownCountdownEndsAt = nowMs + delay
    const action = cfg.scheduledShutdownAction || 'shutdown'
    const label =
      action === 'sleep' ? 'Energiesparmodus' : action === 'hibernate' ? 'Ruhezustand' : 'Herunterfahren'
    store.addLog({
      category: 'system',
      title: `${label} in ${Math.round(delay / 1000)} Sekunden`,
      message: 'Kann bis zum Ablauf jederzeit in Sondra AD abgebrochen werden.',
    })
    if (cfg.desktopNotifications && onNotify) {
      try {
        onNotify({
          title: `Sondra AD: ${label} in ${Math.round(delay / 1000)} Sek.`,
          body: 'Öffne Sondra AD, falls du den Vorgang abbrechen möchtest.',
        })
      } catch {}
    }
    emitShutdownState()
    shutdownTimer = setTimeout(() => {
      executeScheduledPowerNow(reason)
    }, delay)
    shutdownTimer.unref?.()
    return getShutdownState()
  }

  function triggerShutdownAfterQueueIfReady(nowMs = Date.now(), countdownMs = 60_000) {
    const cfg = store.getConfig()
    if (!cfg.shutdownAfterQueue || !afterQueueArmed) return getShutdownState()
    if (shutdownCountdownEndsAt) return getShutdownState()
    const hasPending =
      worker.getActiveCount() > 0 ||
      store.getQueue().some((j) => j.status === 'queued' || j.status === 'downloading' || j.status === 'uploading')
    if (hasPending) return getShutdownState()
    afterQueueArmed = false
    return startPowerCountdown(nowMs, countdownMs, 'after_queue')
  }

  function checkScheduledShutdown(nowMs = Date.now(), countdownMs = 60_000) {
    const cfg = store.getConfig()
    if (!cfg.scheduledShutdownEnabled) return getShutdownState()
    if (!scheduledShutdownAt) {
      recomputeShutdownSchedule(nowMs)
    }
    if (!scheduledShutdownAt || nowMs < scheduledShutdownAt) return getShutdownState()
    if (shutdownCountdownEndsAt) return getShutdownState()

    const hasActiveTransfers =
      worker.getActiveCount() > 0 ||
      store.getQueue().some((j) => j.status === 'downloading' || j.status === 'uploading')

    if (cfg.scheduledShutdownWaitForDownloads && hasActiveTransfers) {
      if (!shutdownWaitingForDownloads) {
        shutdownWaitingForDownloads = true
        store.addLog({
          category: 'system',
          title: 'Herunterfahren wartet auf laufende Übertragungen',
          message: 'Sobald alle aktiven Downloads und Uploads abgeschlossen sind, startet der 60-Sekunden-Countdown.',
        })
        emitShutdownState()
      }
      return getShutdownState()
    }

    shutdownWaitingForDownloads = false
    return startPowerCountdown(nowMs, countdownMs, 'scheduled')
  }

  async function runLanguageUpgradeCheck() {
    const cfg = store.getConfig()
    const prio = Array.isArray(cfg.languagePriority) ? cfg.languagePriority.filter((l) => l && l !== 'auto') : []
    if (!cfg.autoUpgradeLanguage || prio.length < 2) return { upgraded: 0 }

    const itemsById = new Map(store.getMerkItems().map((m) => [m.id, m]))
    const downloaded = store.getEpisodeIndex().downloaded || {}
    const localAddress = resolveBindIpv4(cfg.bindAddress)
    let upgraded = 0

    for (const rec of Object.values(downloaded)) {
      if (!rec || !rec.seriesId || !rec.language) continue
      const currentIdx = prio.indexOf(rec.language)
      if (currentIdx <= 0) continue
      const item = itemsById.get(rec.seriesId)
      if (!item || !isAniworldUrl(item.url)) continue
      const epUrl = buildAniworldEpisodeUrl(item.url, rec.season, rec.episode)
      if (!epUrl) continue

      for (let i = 0; i < currentIdx; i += 1) {
        const betterLang = prio[i]
        try {
          const probe = await extractDirectMedia(epUrl, {
            localAddress,
            language: betterLang,
            hosterPriority: cfg.hosterPriority,
            maxMirrors: 2,
            strictLanguage: true,
          })
          if (probe && !probe.languageMissing && ((probe.streams && probe.streams.length > 0) || probe.url)) {
            const enq = worker.enqueueJob({
              url: epUrl,
              title: `${item.title} S${String(rec.season).padStart(2, '0')}E${String(rec.episode).padStart(2, '0')}`,
              seriesId: item.id,
              seriesTitle: item.title,
              season: rec.season,
              episode: rec.episode,
              language: betterLang,
              isUpgrade: true,
              upgradeFromDriveFileId: rec.driveFileId || null,
              upgradeFromLocalPath: rec.localPath || null,
              upgradeFromWebdavPath: rec.webdavPath || null,
            })
            if (enq.added) {
              upgraded += 1
              store.addLog({
                category: 'download',
                title: `Sprach-Upgrade verfügbar: ${item.title} S${String(rec.season).padStart(2, '0')}E${String(rec.episode).padStart(2, '0')}`,
                message: `${betterLang} ist jetzt verfügbar — alte Version (${rec.language}) wird automatisch ersetzt.`,
                seriesId: item.id,
                seriesTitle: item.title,
                season: rec.season,
                episode: rec.episode,
              })
            }
            break
          }
        } catch {}
      }
    }
    return { upgraded }
  }

  function getReleaseCalendar() {
    const meta = store.getMerkMeta()
    return buildReleaseCalendar(store.getMerkItems(), store.getConfig(), store.getEpisodeIndex(), meta.nextCheckAt || null)
  }

  worker.setOnQueueIdle?.(() => {
    triggerShutdownAfterQueueIfReady()
  })

  async function tick() {
    const cfg = store.getConfig()
    const now = Date.now()

    checkScheduledShutdown(now)

    if (!shutdownWaitingForDownloads && !shutdownCountdownEndsAt) {
      await worker.pumpQueue()
    }

    if (!cfg.enabled || shutdownWaitingForDownloads || shutdownCountdownEndsAt) return

    const syncEveryMs = Math.max(1, Number(cfg.merkSyncIntervalMinutes) || 5) * 60_000
    if (driveAuth.isConnected() && now - lastSyncRun >= syncEveryMs) {
      lastSyncRun = now
      await driveService.syncMerkliste().catch(() => {})
    }

    if (driveAuth.isConnected() && now - lastHeartbeatRun >= 2 * 60_000) {
      lastHeartbeatRun = now
      await driveService.heartbeatDeviceRecord().catch(() => {})
    }

    const meta = store.getMerkMeta()
    const checkEveryMs = Math.max(5, Number(cfg.checkIntervalMinutes) || 30) * 60_000
    if (!meta.lastCheckAt || now - meta.lastCheckAt >= checkEveryMs) {
      await runCheckCycle({ reason: 'scheduled' }).catch(() => {})
      if (cfg.autoUpgradeLanguage) {
        await runLanguageUpgradeCheck().catch(() => {})
      }
    }

    if (now - lastCleanupRun >= 15 * 60_000) {
      lastCleanupRun = now
      if (cfg.cleanupEnabled) {
        await runStorageCleanup({ dryRun: false }).catch(() => {})
      }
      if (cfg.inactivityEnabled) {
        await runInactivityCheck({ dryRun: false }).catch(() => {})
      }
    }

    if (cfg.autoRetryOnNetworkRestore && driveAuth.isConnected()) {
      const probeOk = await driveAuth
        .getAccessToken(false)
        .then(() => true)
        .catch(() => false)
      if (probeOk && !lastOnlineState) {
        const retrying = store.getQueue().filter((j) => j.status === 'retrying')
        for (const r of retrying) {
          store.patchQueueItem(r.id, { status: 'queued', nextRetryAt: null })
        }
        if (retrying.length > 0) void worker.pumpQueue()
      }
      lastOnlineState = probeOk
    }
  }

  function start() {
    if (tickTimer) return
    recomputeShutdownSchedule()
    const meta = store.getMerkMeta()
    if (!meta.nextCheckAt || meta.nextCheckAt < Date.now()) {
      store.updateMerkMeta({
        nextCheckAt: Date.now() + 15_000,
      })
    }
    setTimeout(() => {
      void tick()
    }, 3_000).unref?.()

    tickTimer = setInterval(() => {
      void tick()
    }, 15_000)
    tickTimer.unref?.()
  }

  function stop() {
    clearShutdownTimer()
    if (tickTimer) {
      clearInterval(tickTimer)
      tickTimer = null
    }
  }

  return {
    start,
    stop,
    isChecking: () => checkRunning,
    getShutdownState,
    recomputeShutdownSchedule,
    setShutdownAfterQueue,
    triggerShutdownAfterQueueIfReady,
    checkScheduledShutdown,
    cancelPendingShutdown,
    runLanguageUpgradeCheck,
    getReleaseCalendar,
    runCheckCycle,
    enqueueManualUrl,
    runStorageCleanup,
    runInactivityCheck,
    restoreFromArchive,
  }
}
