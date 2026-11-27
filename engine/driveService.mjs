import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { isNonMediaKind, sniffMediaBuffer } from './mediaCheck.mjs'
import {
  deviceIdOf,
  importStoredKeys,
  makeExportableKeys,
  pickDevices,
  signRecord,
  uniqueName,
} from '../shared/deviceIdentity.mjs'
import {
  archiveSeasonPath,
  HINT_KEYS,
  folderMatchKey,
  hintOf,
  hintProperties,
  mergeShared,
  readSharedMerkliste,
  seasonFolderName,
  seasonNumberFromFolderName,
  seasonPath,
  seriesFolderName,
  sharedKey,
  sharedSqliteBytes,
} from '../shared/merklisteMerge.mjs'

const FOLDER_MIME = 'application/vnd.google-apps.folder'
/** Projektnummer des Google-Clients der Sondra-App (bananaaboy/Sondra, src/lib/googleDrive.ts). */
const SONDRA_GOOGLE_PROJECT = '736809827454'
const FILE_FIELDS = 'id,name,size,modifiedTime,createdTime,mimeType,parents,appProperties,trashedTime'
const SIMPLE_LIMIT = 5 * 1024 * 1024
const CHUNK_SIZE = 8 * 1024 * 1024
const MERKLISTE_SQLITE = 'Sondra-Merkliste.sqlite'
const MERKLISTE_LEGACY = 'Sondra-Merkliste.json'

function quote(value) {
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

function asFile(raw) {
  const size = raw.size === undefined || raw.size === null ? 0 : Number(raw.size)
  return {
    id: String(raw.id),
    name: String(raw.name ?? ''),
    size: Number.isFinite(size) ? size : 0,
    modifiedTime: typeof raw.modifiedTime === 'string' ? raw.modifiedTime : null,
    createdTime: typeof raw.createdTime === 'string' ? raw.createdTime : null,
    mimeType: typeof raw.mimeType === 'string' ? raw.mimeType : null,
    parents: Array.isArray(raw.parents) ? raw.parents.map(String) : [],
    trashedTime: typeof raw.trashedTime === 'string' ? raw.trashedTime : null,
    appProperties: raw.appProperties && typeof raw.appProperties === 'object' ? raw.appProperties : {},
  }
}

function isRetryable(status, text) {
  return status === 429 || status >= 500 || (status === 403 && /rateLimitExceeded|userRateLimitExceeded/i.test(text))
}

const backoff = (attempt) => Math.min(16_000, 800 * 2 ** attempt) + Math.floor(Math.random() * 200)

function parseRangeEnd(rangeHeader) {
  const m = rangeHeader ? /bytes=0-(\d+)/i.exec(rangeHeader) : null
  return m ? Number(m[1]) + 1 : null
}

export function getLocalDiskStats(dirPath) {
  try {
    const target = fs.existsSync(dirPath) ? dirPath : path.dirname(dirPath)
    const checkPath = fs.existsSync(target) ? target : os.homedir()
    const stat = fs.statfsSync(checkPath)
    const blockSize = Number(stat.bsize || stat.frsize || 4096)
    const totalBytes = Number(stat.blocks) * blockSize
    const freeBytes = Number(stat.bavail ?? stat.bfree) * blockSize
    const usedBytes = Math.max(0, totalBytes - freeBytes)
    return { totalBytes, freeBytes, usedBytes, path: checkPath }
  } catch {
    return { totalBytes: 0, freeBytes: 0, usedBytes: 0, path: dirPath }
  }
}

export function computeDirectoryBytes(dirPath) {
  if (!dirPath || !fs.existsSync(dirPath)) return { bytes: 0, files: 0 }
  let bytes = 0
  let files = 0
  const stack = [dirPath]
  while (stack.length > 0) {
    const current = stack.pop()
    let entries = []
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
      } else if (entry.isFile()) {
        try {
          bytes += fs.statSync(full).size
          files += 1
        } catch {}
      }
    }
  }
  return { bytes, files }
}

export function createDriveService({ dataDir, store, driveAuth, fetchImpl = fetch }) {
  const apiBase = () => process.env.SONDRA_DRIVE_API_BASE || 'https://www.googleapis.com/drive/v3'
  const uploadBase = () => process.env.SONDRA_DRIVE_UPLOAD_BASE || 'https://www.googleapis.com/upload/drive/v3'

  const folderCache = new Map()
  const deviceKeyFile = path.join(dataDir, 'device-identity.json')
  let deviceKeys = null
  let deviceCreated = Date.now()
  let deviceRecordFileId = null

  async function ensureDeviceKeys() {
    if (deviceKeys) return deviceKeys
    if (fs.existsSync(deviceKeyFile)) {
      try {
        const saved = JSON.parse(fs.readFileSync(deviceKeyFile, 'utf8'))
        if (saved?.privateJwk && saved?.publicJwk) {
          deviceKeys = await importStoredKeys(saved.privateJwk, saved.publicJwk)
          deviceCreated = Number(saved.created) || Date.now()
          deviceRecordFileId = saved.fileId || null
          return deviceKeys
        }
      } catch {}
    }
    const generated = await makeExportableKeys()
    deviceCreated = Date.now()
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(
      deviceKeyFile,
      JSON.stringify(
        {
          privateJwk: generated.privateJwk,
          publicJwk: generated.publicJwk,
          created: deviceCreated,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    )
    deviceKeys = generated
    return deviceKeys
  }

  async function callDrive(url, init = {}) {
    let forceRefresh = false
    for (let attempt = 0; ; attempt += 1) {
      const token = await driveAuth.getAccessToken(forceRefresh)
      let res
      try {
        res = await fetchImpl(url, {
          ...init,
          headers: {
            ...(init.headers || {}),
            Authorization: `Bearer ${token}`,
          },
        })
      } catch (err) {
        if (init.signal?.aborted) throw err
        if (attempt < 3) {
          await new Promise((r) => setTimeout(r, backoff(attempt)))
          continue
        }
        const netErr = new Error(`Google Drive nicht erreichbar: ${err?.message ?? err}`)
        netErr.code = 'offline'
        throw netErr
      }
      if (res.ok || res.status === 308) return res
      if (res.status === 401 && !forceRefresh) {
        forceRefresh = true
        continue
      }
      const errText = await res.text().catch(() => '')
      if (isRetryable(res.status, errText) && attempt < 4) {
        await new Promise((r) => setTimeout(r, backoff(attempt)))
        continue
      }
      const driveErr = new Error(`Google Drive Fehler (${res.status}): ${errText.slice(0, 180)}`)
      driveErr.code =
        res.status === 404
          ? 'missing'
          : /storageQuotaExceeded|quotaExceeded/i.test(errText)
            ? 'quota'
            : res.status === 401
              ? 'unauthorized'
              : 'failed'
      throw driveErr
    }
  }

  async function callJson(url, init) {
    const res = await callDrive(url, init)
    return res.json()
  }

  // Ordner-Operationen laufen nacheinander, damit zwei gleichzeitig fertige Downloads
  // derselben Serie nicht beide „Serien/<Titel>“ neu anlegen (doppelte Ordner).
  let folderChain = Promise.resolve()
  function withFolderLock(fn) {
    const run = folderChain.then(() => fn())
    folderChain = run.catch(() => {})
    return run
  }

  async function listChildFolders(parentId) {
    const out = []
    let pageToken = ''
    do {
      const page = await callJson(
        `${apiBase()}/files?${new URLSearchParams({
          q: `${quote(parentId)} in parents and mimeType = '${FOLDER_MIME}' and trashed = false`,
          fields: 'nextPageToken,files(id,name,createdTime,parents)',
          orderBy: 'createdTime',
          spaces: 'drive',
          pageSize: '500',
          ...(pageToken ? { pageToken } : {}),
        }).toString()}`,
      )
      for (const f of page.files ?? []) {
        out.push({ id: String(f.id), name: String(f.name ?? ''), createdTime: f.createdTime || null })
      }
      pageToken = page.nextPageToken ?? ''
    } while (pageToken && out.length < 10_000)
    return out
  }

  async function createFolder(name, parentId) {
    const created = await callJson(`${apiBase()}/files?fields=id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
    })
    return String(created.id)
  }

  function ensureFolderPath(segments = []) {
    return withFolderLock(() => ensureFolderPathUnlocked(segments))
  }

  async function ensureFolderPathUnlocked(segments = []) {
    const fullParts = ['Sondra', ...segments.filter(Boolean)]
    let parentId = 'root'
    let builtKey = ''
    for (const part of fullParts) {
      builtKey = builtKey ? `${builtKey}/${part}` : part
      const cached = folderCache.get(builtKey)
      if (cached) {
        try {
          const meta = await callJson(
            `${apiBase()}/files/${encodeURIComponent(cached)}?fields=id,trashed,mimeType`,
          )
          if (!meta.trashed && meta.mimeType === FOLDER_MIME) {
            parentId = cached
            continue
          }
        } catch {
          folderCache.delete(builtKey)
        }
      }
      const q = `name = ${quote(part)} and mimeType = '${FOLDER_MIME}' and ${quote(parentId)} in parents and trashed = false`
      const found = await callJson(
        `${apiBase()}/files?${new URLSearchParams({
          q,
          fields: 'files(id,name,createdTime)',
          orderBy: 'createdTime',
          spaces: 'drive',
          pageSize: '10',
        }).toString()}`,
      )
      let id = found.files?.[0]?.id ? String(found.files[0].id) : null
      if (!id) id = await createFolder(part, parentId)
      folderCache.set(builtKey, id)
      parentId = id
    }
    return parentId
  }

  const seriesIdFolderCache = new Map()

  async function fileMeta(id) {
    return callJson(`${apiBase()}/files/${encodeURIComponent(id)}?fields=id,name,parents,trashed,mimeType,createdTime`)
  }

  /** Findet den Serienordner unter `rootId`, in dem bereits Folgen mit dieser Serien-ID liegen. */
  async function findSeriesFolderBySeriesId(seriesId, rootId) {
    let page
    try {
      page = await callJson(
        `${apiBase()}/files?${new URLSearchParams({
          q: `appProperties has { key='${HINT_KEYS.series}' and value=${quote(seriesId)} } and mimeType != '${FOLDER_MIME}' and trashed = false`,
          fields: 'files(id,parents,appProperties)',
          spaces: 'drive',
          pageSize: '200',
        }).toString()}`,
      )
    } catch {
      return null
    }
    const metaCache = new Map()
    const meta = async (id) => {
      if (!metaCache.has(id)) metaCache.set(id, await fileMeta(id).catch(() => null))
      return metaCache.get(id)
    }
    const counts = new Map()
    for (const f of page.files ?? []) {
      if (String(f.appProperties?.[HINT_KEYS.series] ?? '') !== String(seriesId)) continue
      for (const parentId of f.parents ?? []) {
        const parent = await meta(parentId)
        if (!parent || parent.trashed) continue
        if ((parent.parents ?? []).includes(rootId)) {
          // Datei liegt direkt im Serienordner (ohne Staffelordner).
          counts.set(parent.id, (counts.get(parent.id) || 0) + 1)
          continue
        }
        for (const grandId of parent.parents ?? []) {
          const grand = await meta(grandId)
          if (grand && !grand.trashed && (grand.parents ?? []).includes(rootId)) {
            counts.set(grand.id, (counts.get(grand.id) || 0) + 1)
          }
        }
      }
    }
    let best = null
    for (const [id, n] of counts) if (!best || n > best.n) best = { id, n }
    return best ? best.id : null
  }

  /**
   * Liefert den Zielordner einer Folge: `Sondra/<root>/<Serie>/<Staffel>`.
   * Reihenfolge: (1) Ordner, in dem schon Folgen derselben Serie (appProperties
   * `sondraSerie`) liegen, (2) exakt gleicher Name, (3) tolerant gleicher Name
   * (Groß-/Kleinschreibung, Satzzeichen, Umlaute), (4) erst dann neu anlegen.
   * Staffelordner werden auch als „Season 02“, „S2“ usw. erkannt.
   */
  function resolveSeasonFolder(opts) {
    return withFolderLock(() => resolveSeasonFolderUnlocked(opts))
  }

  async function resolveSeasonFolderUnlocked({ root = 'Serien', seriesId = null, seriesTitle, season = 1 }) {
    const rootId = await ensureFolderPathUnlocked([root])
    const wantedName = seriesFolderName(seriesTitle)
    const wantedKey = folderMatchKey(wantedName)
    const children = await listChildFolders(rootId)

    // Zuerst exakt der Name, den auch die Sondra-App verwendet – dann findet Sondra die Folgen sofort.
    let series = children.find((c) => c.name === wantedName) || null
    if (!series && seriesId) {
      const cacheKey = `${rootId}::${seriesId}`
      const cachedId = seriesIdFolderCache.get(cacheKey)
      if (cachedId) series = children.find((c) => c.id === cachedId) || null
      if (!series) {
        const foundId = await findSeriesFolderBySeriesId(seriesId, rootId)
        if (foundId) series = children.find((c) => c.id === foundId) || null
      }
    }
    if (!series && wantedKey) series = children.find((c) => folderMatchKey(c.name) === wantedKey) || null
    if (!series) series = { id: await createFolder(wantedName, rootId), name: wantedName }
    if (seriesId) seriesIdFolderCache.set(`${rootId}::${seriesId}`, series.id)

    const seasonNum = Number.isFinite(Number(season)) ? Number(season) : 1
    const wantedSeason = seasonFolderName(seasonNum)
    const seasons = await listChildFolders(series.id)
    const seasonFolder =
      seasons.find((c) => c.name === wantedSeason) ||
      seasons.find((c) => seasonNumberFromFolderName(c.name) === seasonNum) || {
        id: await createFolder(wantedSeason, series.id),
        name: wantedSeason,
      }
    return { folderId: seasonFolder.id, segments: [root, series.name, seasonFolder.name] }
  }

  async function setTrashed(fileId, trashed = true) {
    await callJson(`${apiBase()}/files/${encodeURIComponent(fileId)}?fields=id`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ trashed }),
    })
  }

  async function reparentFile(file, targetFolderId) {
    const removeParents = (file.parents ?? []).filter((p) => p !== targetFolderId).join(',')
    const params = new URLSearchParams({
      addParents: targetFolderId,
      fields: FILE_FIELDS,
      ...(removeParents ? { removeParents } : {}),
    })
    return asFile(
      await callJson(`${apiBase()}/files/${encodeURIComponent(file.id)}?${params.toString()}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json; charset=UTF-8' },
        body: JSON.stringify({}),
      }),
    )
  }

  /**
   * Führt doppelte Serienordner unter `Sondra/<root>/` zusammen (gleicher Name nach
   * tolerantem Vergleich oder Folgen mit derselben Serien-ID). Alle Folgen wandern in den
   * Ordner mit den meisten Dateien (bei Gleichstand den ältesten), in die passende Staffel.
   * Doppelte Folgen und der leere Zusatzordner kommen in den Papierkorb (wiederherstellbar).
   */
  function repairDuplicateSeriesFolders(tree, root = 'Serien') {
    return withFolderLock(() => repairDuplicateSeriesFoldersUnlocked(tree, root))
  }

  async function repairDuplicateSeriesFoldersUnlocked(tree, root) {
    const result = { groups: 0, moved: 0, trashedFiles: 0, trashedFolders: 0 }
    const rootDir = tree.dirs.find((d) => d.path === root)
    if (!rootDir) return result
    const dirById = new Map(tree.dirs.map((d) => [d.id, d]))
    const top = tree.dirs.filter((d) => (d.parents ?? []).includes(rootDir.id))
    if (top.length < 2) return result
    const topIds = new Set(top.map((d) => d.id))

    // Zu welchem Serienordner (und welchem direkten Unterordner) gehört eine Datei?
    const locate = (file) => {
      let childOfTop = null
      let current = (file.parents ?? [])[0]
      for (let guard = 0; current && guard < 12; guard += 1) {
        if (topIds.has(current)) return { topId: current, childId: childOfTop }
        const dir = dirById.get(current)
        if (!dir) return null
        if (topIds.has((dir.parents ?? [])[0])) childOfTop = dir.id
        current = (dir.parents ?? [])[0]
      }
      return null
    }

    const uf = new Map(top.map((d) => [d.id, d.id]))
    const find = (x) => {
      while (uf.get(x) !== x) {
        uf.set(x, uf.get(uf.get(x)))
        x = uf.get(x)
      }
      return x
    }
    const union = (a, b) => {
      const ra = find(a)
      const rb = find(b)
      if (ra !== rb) uf.set(rb, ra)
    }

    const byKey = new Map()
    for (const d of top) {
      const k = folderMatchKey(d.name)
      if (!k) continue
      if (byKey.has(k)) union(byKey.get(k), d.id)
      else byKey.set(k, d.id)
    }
    const filesByTop = new Map(top.map((d) => [d.id, []]))
    const seriesByTop = new Map(top.map((d) => [d.id, new Set()]))
    for (const f of tree.files) {
      const loc = locate(f)
      if (!loc) continue
      filesByTop.get(loc.topId).push({ file: f, childId: loc.childId })
      if (f.hint?.series) seriesByTop.get(loc.topId).add(String(f.hint.series))
    }
    // Über die Serien-ID nur zusammenführen, wenn ein Ordner ausschließlich Folgen von
    // Serien enthält, die auch im anderen liegen – so werden zwei verschiedene Serien
    // nie wegen einer einzelnen falsch einsortierten Datei vermischt.
    const subset = (a, b) => a.size > 0 && [...a].every((x) => b.has(x))
    for (let i = 0; i < top.length; i += 1) {
      for (let j = i + 1; j < top.length; j += 1) {
        const a = seriesByTop.get(top[i].id)
        const b = seriesByTop.get(top[j].id)
        if (subset(a, b) || subset(b, a)) union(top[i].id, top[j].id)
      }
    }

    const groups = new Map()
    for (const d of top) {
      const r = find(d.id)
      if (!groups.has(r)) groups.set(r, [])
      groups.get(r).push(d)
    }

    for (const members of groups.values()) {
      if (members.length < 2) continue
      result.groups += 1
      // Ordner, der genau so heißt, wie die Sondra-App ihn für einen Merklisten-Titel anlegt,
      // gewinnt immer – sonst legt Sondra beim nächsten Einordnen wieder einen eigenen an.
      const canonical = new Set(store.getMerkItems().map((i) => seriesFolderName(i.title)))
      members.sort((a, b) => {
        const ca = canonical.has(a.name) ? 1 : 0
        const cb = canonical.has(b.name) ? 1 : 0
        if (ca !== cb) return cb - ca
        const diff = filesByTop.get(b.id).length - filesByTop.get(a.id).length
        if (diff !== 0) return diff
        return String(a.createdTime || '').localeCompare(String(b.createdTime || ''))
      })
      const primary = members[0]
      const primarySeasons = tree.dirs.filter((d) => (d.parents ?? [])[0] === primary.id)
      const occupied = new Map()
      const occupancy = (folderId) => {
        if (!occupied.has(folderId)) {
          const names = new Set()
          const hints = new Set()
          for (const f of tree.files) {
            if (!(f.parents ?? []).includes(folderId)) continue
            names.add(f.name)
            if (f.hint) hints.add(`${f.hint.series}::${f.hint.season}::${f.hint.episode}`)
          }
          occupied.set(folderId, { names, hints })
        }
        return occupied.get(folderId)
      }
      const seasonTarget = async (childDir) => {
        if (!childDir) return primary.id
        const num = seasonNumberFromFolderName(childDir.name)
        let hit =
          primarySeasons.find((d) => d.name === childDir.name) ||
          (num !== null ? primarySeasons.find((d) => seasonNumberFromFolderName(d.name) === num) : null)
        if (!hit) {
          const name = num !== null ? seasonFolderName(num) : childDir.name
          hit = { id: await createFolder(name, primary.id), name, parents: [primary.id] }
          primarySeasons.push(hit)
        }
        return hit.id
      }

      for (const other of members.slice(1)) {
        let failures = 0
        for (const { file, childId } of filesByTop.get(other.id)) {
          try {
            const targetId = await seasonTarget(childId ? dirById.get(childId) : null)
            const occ = occupancy(targetId)
            const hintKey = file.hint ? `${file.hint.series}::${file.hint.season}::${file.hint.episode}` : null
            if (occ.names.has(file.name) || (hintKey && occ.hints.has(hintKey))) {
              await setTrashed(file.id, true)
              result.trashedFiles += 1
            } else {
              await reparentFile(file, targetId)
              occ.names.add(file.name)
              if (hintKey) occ.hints.add(hintKey)
              result.moved += 1
            }
          } catch {
            failures += 1
          }
        }
        if (failures === 0) {
          try {
            await setTrashed(other.id, true)
            result.trashedFolders += 1
            for (const [k, v] of folderCache) if (v === other.id) folderCache.delete(k)
            for (const [k, v] of seriesIdFolderCache) if (v === other.id) seriesIdFolderCache.delete(k)
          } catch {}
        }
        store.addLog({
          category: 'sync',
          level: failures ? 'warn' : 'info',
          title: `Doppelten Serienordner zusammengeführt: ${primary.name}`,
          message: `„${root}/${other.name}“ wurde in „${root}/${primary.name}“ einsortiert${
            failures ? ` (${failures} Datei(en) konnten nicht verschoben werden)` : ''
          }.`,
        })
      }
    }
    return result
  }

  /**
   * Prüft hochgeladene Folgen einmalig per kurzem Range-Abruf darauf, ob in einer
   * ".mp4" wirklich ein MP4 steckt. Liefert die defekten Dateien zurück (z. B. MPEG-TS
   * unter .mp4-Namen, HTML-Fehlerseiten), damit sie repariert oder neu geladen werden.
   */
  const mediaCheckFile = path.join(dataDir, 'drive-media-checks.json')
  async function findBrokenDriveMedia(tree, { limit = 60 } = {}) {
    let checked = {}
    try {
      checked = JSON.parse(fs.readFileSync(mediaCheckFile, 'utf8')) || {}
    } catch {}
    const candidates = tree.files.filter(
      (f) =>
        f.path.startsWith('Serien/') &&
        f.size > 0 &&
        /\.(?:mp4|m4v)$/i.test(f.name) &&
        checked[f.id] !== f.modifiedTime,
    )
    const broken = []
    let changed = false
    for (const f of candidates.slice(0, limit)) {
      try {
        const res = await callDrive(`${apiBase()}/files/${encodeURIComponent(f.id)}?alt=media`, {
          headers: { Range: 'bytes=0-4095' },
        })
        const buf = Buffer.from(await res.arrayBuffer()).subarray(0, 4096)
        const kind = sniffMediaBuffer(buf)
        if (kind === 'ts' || isNonMediaKind(kind)) broken.push({ ...f, kind })
        else checked[f.id] = f.modifiedTime
        changed = true
      } catch {}
    }
    if (changed) {
      try {
        fs.writeFileSync(mediaCheckFile, JSON.stringify(checked))
      } catch {}
    }
    return broken
  }

  function markMediaChecked(file) {
    let checked = {}
    try {
      checked = JSON.parse(fs.readFileSync(mediaCheckFile, 'utf8')) || {}
    } catch {}
    checked[file.id] = file.modifiedTime
    try {
      fs.writeFileSync(mediaCheckFile, JSON.stringify(checked))
    } catch {}
  }

  async function findFileInFolder(parentId, name) {
    const q = `name = ${quote(name)} and ${quote(parentId)} in parents and mimeType != '${FOLDER_MIME}' and trashed = false`
    const found = await callJson(
      `${apiBase()}/files?${new URLSearchParams({
        q,
        fields: `files(${FILE_FIELDS})`,
        orderBy: 'modifiedTime desc',
        spaces: 'drive',
        pageSize: '5',
      }).toString()}`,
    )
    return found.files?.[0] ? asFile(found.files[0]) : null
  }

  async function putBytes(segments, fileName, bytes, { mime = 'application/octet-stream', appProperties, folderId = null } = {}) {
    const parentId = folderId || (await ensureFolderPath(segments))
    const existing = await findFileInFolder(parentId, fileName)
    const bodyBuf = Buffer.from(bytes)
    if (existing) {
      const updated = await callJson(
        `${uploadBase()}/files/${encodeURIComponent(existing.id)}?uploadType=media&fields=${FILE_FIELDS}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': mime },
          body: bodyBuf,
        },
      )
      return asFile(updated)
    }
    const boundary = `sondraad${Math.random().toString(36).slice(2)}`
    const meta = JSON.stringify({
      name: fileName,
      parents: [parentId],
      mimeType: mime,
      ...(appProperties ? { appProperties } : {}),
    })
    const multipart = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`),
      bodyBuf,
      Buffer.from(`\r\n--${boundary}--`),
    ])
    const created = await callJson(`${uploadBase()}/files?uploadType=multipart&fields=${FILE_FIELDS}`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body: multipart,
    })
    return asFile(created)
  }

  async function uploadFileToDrive(
    segments,
    fileName,
    localFilePath,
    {
      mime = 'video/mp4',
      appProperties = undefined,
      onProgress = null,
      signal = undefined,
      replaceExisting = true,
      folderId = null,
    } = {},
  ) {
    const totalSize = fs.statSync(localFilePath).size
    const parentId = folderId || (await ensureFolderPath(segments))
    const existing = replaceExisting ? await findFileInFolder(parentId, fileName) : null

    if (totalSize <= SIMPLE_LIMIT) {
      const bytes = fs.readFileSync(localFilePath)
      onProgress?.(0, totalSize)
      const res = await putBytes(segments, fileName, bytes, { mime, appProperties, folderId: parentId })
      onProgress?.(totalSize, totalSize)
      return res
    }

    const sessionRes = await callDrive(
      existing
        ? `${uploadBase()}/files/${encodeURIComponent(existing.id)}?uploadType=resumable&fields=${FILE_FIELDS}`
        : `${uploadBase()}/files?uploadType=resumable&fields=${FILE_FIELDS}`,
      {
        method: existing ? 'PATCH' : 'POST',
        headers: {
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Type': mime,
          'X-Upload-Content-Length': String(totalSize),
        },
        body: JSON.stringify(
          existing
            ? { ...(appProperties ? { appProperties } : {}) }
            : {
                name: fileName,
                parents: [parentId],
                mimeType: mime,
                ...(appProperties ? { appProperties } : {}),
              },
        ),
        signal,
      },
    )
    const sessionUrl = sessionRes.headers.get('location')
    if (!sessionUrl) throw new Error('Google Drive hat keine Upload-Sitzung geöffnet.')

    const fd = fs.openSync(localFilePath, 'r')
    try {
      let offset = 0
      let retries = 0
      const chunkBuf = Buffer.allocUnsafe(Math.min(CHUNK_SIZE, totalSize))
      while (offset < totalSize) {
        if (signal?.aborted) throw new Error('Upload abgebrochen')
        const toRead = Math.min(CHUNK_SIZE, totalSize - offset)
        const bytesRead = fs.readSync(fd, chunkBuf, 0, toRead, offset)
        if (bytesRead <= 0) break
        const slice = chunkBuf.subarray(0, bytesRead)
        const end = offset + bytesRead
        let putRes = null
        try {
          putRes = await fetchImpl(sessionUrl, {
            method: 'PUT',
            headers: {
              'Content-Length': String(bytesRead),
              'Content-Range': `bytes ${offset}-${end - 1}/${totalSize}`,
            },
            body: slice,
            signal,
          })
        } catch (err) {
          if (signal?.aborted) throw err
        }

        if (putRes && (putRes.status === 200 || putRes.status === 201)) {
          onProgress?.(totalSize, totalSize)
          return asFile(await putRes.json())
        }
        if (putRes && putRes.status === 308) {
          offset = parseRangeEnd(putRes.headers.get('range')) ?? end
          retries = 0
          onProgress?.(offset, totalSize)
          continue
        }
        if (putRes && (putRes.status === 404 || putRes.status === 410)) {
          throw new Error('Die Google-Drive-Uploadsitzung ist abgelaufen.')
        }
        retries += 1
        if (retries > 5) {
          const reason = putRes ? await putRes.text().catch(() => `HTTP ${putRes.status}`) : 'Verbindung unterbrochen'
          throw new Error(`Upload zu Google Drive fehlgeschlagen: ${reason.slice(0, 160)}`)
        }
        await new Promise((r) => setTimeout(r, backoff(retries)))
        const statusCheck = await fetchImpl(sessionUrl, {
          method: 'PUT',
          headers: { 'Content-Length': '0', 'Content-Range': `bytes */${totalSize}` },
          signal,
        }).catch(() => null)
        if (statusCheck && (statusCheck.status === 200 || statusCheck.status === 201)) {
          onProgress?.(totalSize, totalSize)
          return asFile(await statusCheck.json())
        }
        if (statusCheck && statusCheck.status === 308) {
          offset = parseRangeEnd(statusCheck.headers.get('range')) ?? offset
          onProgress?.(offset, totalSize)
        }
      }
      throw new Error('Upload vorzeitig beendet.')
    } finally {
      fs.closeSync(fd)
    }
  }

  async function readFileBytes(fileId) {
    const res = await callDrive(`${apiBase()}/files/${encodeURIComponent(fileId)}?alt=media`)
    return new Uint8Array(await res.arrayBuffer())
  }

  async function downloadFileToLocal(fileId, destPath) {
    fs.mkdirSync(path.dirname(destPath), { recursive: true })
    const res = await callDrive(`${apiBase()}/files/${encodeURIComponent(fileId)}?alt=media`)
    if (!res.body) throw new Error('Leere Antwort von Google Drive.')
    const tmp = `${destPath}.part`
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp))
    fs.renameSync(tmp, destPath)
    return fs.statSync(destPath).size
  }

  async function moveDriveFile(fileId, targetSegments, currentParents = [], appProperties = undefined, folderId = null) {
    const targetFolderId = folderId || (await ensureFolderPath(targetSegments))
    const removeParents = currentParents.filter((p) => p !== targetFolderId).join(',')
    const params = new URLSearchParams({
      addParents: targetFolderId,
      fields: FILE_FIELDS,
      ...(removeParents ? { removeParents } : {}),
    })
    const updated = await callJson(`${apiBase()}/files/${encodeURIComponent(fileId)}?${params.toString()}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify(appProperties ? { appProperties } : {}),
    })
    return asFile(updated)
  }

  async function deleteFilePermanently(fileId) {
    try {
      await callDrive(`${apiBase()}/files/${encodeURIComponent(fileId)}`, { method: 'DELETE' })
    } catch (err) {
      if (err.code !== 'missing') throw err
    }
  }

  async function listTrashedFiles() {
    const files = []
    let pageToken = ''
    do {
      const page = await callJson(
        `${apiBase()}/files?${new URLSearchParams({
          q: `trashed = true and mimeType != '${FOLDER_MIME}'`,
          fields: `nextPageToken,files(${FILE_FIELDS})`,
          orderBy: 'modifiedTime asc',
          spaces: 'drive',
          pageSize: '200',
          ...(pageToken ? { pageToken } : {}),
        }).toString()}`,
      )
      for (const raw of page.files ?? []) files.push(asFile(raw))
      pageToken = page.nextPageToken ?? ''
    } while (pageToken && files.length < 2000)
    return files
  }

  async function listSondraTree() {
    const rootId = await ensureFolderPath([])
    const files = []
    const dirs = []
    const queue = [{ id: rootId, path: '' }]
    while (queue.length > 0) {
      const current = queue.shift()
      let pageToken = ''
      do {
        const page = await callJson(
          `${apiBase()}/files?${new URLSearchParams({
            q: `${quote(current.id)} in parents and trashed = false`,
            fields: `nextPageToken,files(${FILE_FIELDS})`,
            spaces: 'drive',
            pageSize: '500',
            ...(pageToken ? { pageToken } : {}),
          }).toString()}`,
        )
        for (const raw of page.files ?? []) {
          const entry = asFile(raw)
          const relPath = current.path ? `${current.path}/${entry.name}` : entry.name
          if (entry.mimeType === FOLDER_MIME) {
            dirs.push({
              id: entry.id,
              name: entry.name,
              path: relPath,
              parents: entry.parents,
              createdTime: entry.createdTime,
            })
            queue.push({ id: entry.id, path: relPath })
          } else {
            files.push({
              ...entry,
              path: relPath,
              hint: hintOf(entry.appProperties),
            })
          }
        }
        pageToken = page.nextPageToken ?? ''
      } while (pageToken && files.length < 20_000)
    }
    return { rootId, files, dirs }
  }

  let lastSyncedTree = null
  let projectWarned = false

  /**
   * Google gibt mit dem Recht „drive.file“ nur Dateien frei, die eine App desselben
   * Google-Cloud-Projekts angelegt hat. Nutzt Sondra AD einen Client aus einem anderen
   * Projekt als die Sondra-App, sieht es deren „Sondra“-Ordner nicht und legt einen
   * eigenen an. Das wird hier einmal pro Start deutlich im Protokoll gemeldet.
   */
  function warnIfForeignProject() {
    if (projectWarned) return
    const clientId = String(driveAuth.getClientId?.() || '')
    const project = /^(\d+)-[a-z0-9]+\.apps\.googleusercontent\.com$/i.exec(clientId)?.[1]
    if (!project) return
    projectWarned = true
    if (project === SONDRA_GOOGLE_PROJECT) return
    store.addLog({
      category: 'sync',
      level: 'warn',
      title: 'Google-Client gehört nicht zum Sondra-Projekt',
      message: `Sondra AD verwendet einen Google-Client aus Projekt ${project}, die Sondra-App aus Projekt ${SONDRA_GOOGLE_PROJECT}. Google zeigt Sondra AD dann die Ordner und Folgen der Sondra-App nicht an – es entstehen eigene Ordner. Bitte in beiden Apps einen Client aus demselben Google-Cloud-Projekt verwenden.`,
    })
  }

  async function syncMerkliste() {
    warnIfForeignProject()
    if (!driveAuth.isConnected()) return { ok: false, reason: 'not-connected' }
    const merkFolderId = await ensureFolderPath(['Merkliste'])
    let remoteFile = await findFileInFolder(merkFolderId, MERKLISTE_SQLITE)
    let fromLegacy = false
    if (!remoteFile) {
      remoteFile = await findFileInFolder(merkFolderId, MERKLISTE_LEGACY)
      if (remoteFile) fromLegacy = true
    }

    const localItems = store.getMerkItems()
    const localRemoved = store.getMerkRemoved()
    const localKey = sharedKey(localItems, localRemoved)

    if (!remoteFile) {
      if (localItems.length > 0 || Object.keys(localRemoved).length > 0) {
        const bytes = sharedSqliteBytes(localItems, localRemoved, store.getMerkAppState())
        await putBytes(['Merkliste'], MERKLISTE_SQLITE, bytes, { mime: 'application/vnd.sqlite3' })
      }
      store.updateMerkMeta({ lastSyncAt: Date.now() })
      return { ok: true, items: localItems, added: 0, updated: 0, uploaded: localItems.length > 0 }
    }

    const rawBytes = await readFileBytes(remoteFile.id)
    const parsedRemote = readSharedMerkliste(rawBytes)
    if (!parsedRemote) {
      throw new Error('Merkliste in Google Drive konnte nicht gelesen werden.')
    }

    const merged = mergeShared(localItems, localRemoved, parsedRemote)
    const mergedAppState = { ...parsedRemote.appState, ...store.getMerkAppState() }
    const nextKey = sharedKey(merged.items, merged.removed)

    if (nextKey !== localKey) {
      store.saveMerkliste(merged.items, merged.removed, mergedAppState)
    }

    let uploaded = false
    if (fromLegacy || nextKey !== parsedRemote.key) {
      const outBytes = sharedSqliteBytes(merged.items, merged.removed, mergedAppState)
      await putBytes(['Merkliste'], MERKLISTE_SQLITE, outBytes, { mime: 'application/vnd.sqlite3' })
      uploaded = true
    }

    let tree = await listSondraTree().catch(() => null)
    if (tree) {
      // Doppelte Serienordner (z. B. durch abweichende Schreibweise entstanden) zusammenführen.
      const repaired = await repairDuplicateSeriesFolders(tree).catch((err) => {
        store.addLog({
          category: 'sync',
          level: 'warn',
          title: 'Ordner-Zusammenführung fehlgeschlagen',
          message: String(err?.message ?? err),
        })
        return null
      })
      if (repaired && (repaired.moved > 0 || repaired.trashedFiles > 0 || repaired.trashedFolders > 0)) {
        tree = (await listSondraTree().catch(() => null)) || tree
      }
      lastSyncedTree = tree
      for (const f of tree.files) {
        if (!f.hint) continue
        if (f.path.startsWith('Serien/')) {
          store.markEpisodeDownloaded(f.hint.series, f.hint.season, f.hint.episode, {
            driveFileId: f.id,
            fileName: f.name,
            sizeBytes: f.size,
            drivePath: f.path,
            modifiedTime: f.modifiedTime,
          })
        } else if (f.path.startsWith('Archiv/')) {
          store.markEpisodeArchived(f.hint.series, f.hint.season, f.hint.episode, {
            driveFileId: f.id,
            fileName: f.name,
            sizeBytes: f.size,
            drivePath: f.path,
            modifiedTime: f.modifiedTime,
          })
        }
      }
    }

    store.updateMerkMeta({ lastSyncAt: Date.now() })
    return {
      ok: true,
      items: merged.items,
      added: merged.added,
      updated: merged.updated,
      uploaded,
    }
  }

  async function pushMerkliste() {
    if (!driveAuth.isConnected()) return false
    const bytes = store.getMerkSqliteBytes()
    await putBytes(['Merkliste'], MERKLISTE_SQLITE, bytes, { mime: 'application/vnd.sqlite3' })
    store.updateMerkMeta({ lastSyncAt: Date.now() })
    return true
  }

  async function heartbeatDeviceRecord() {
    const cfg = store.getConfig()
    if (!cfg.registerInSondraDevices || !driveAuth.isConnected()) return null
    const keys = await ensureDeviceKeys()
    const id = await deviceIdOf(keys.publicJwk)
    const devicesFolderId = await ensureFolderPath(['Geräte'])

    const existingList = await callJson(
      `${apiBase()}/files?${new URLSearchParams({
        q: `${quote(devicesFolderId)} in parents and mimeType != '${FOLDER_MIME}' and trashed = false`,
        fields: 'files(id,name)',
        spaces: 'drive',
        pageSize: '50',
      }).toString()}`,
    ).catch(() => ({ files: [] }))

    const otherRawRecords = []
    for (const f of existingList.files ?? []) {
      if (f.name === `${id}.json`) {
        deviceRecordFileId = String(f.id)
        continue
      }
      try {
        const bytes = await readFileBytes(String(f.id))
        otherRawRecords.push(JSON.parse(new TextDecoder().decode(bytes)))
      } catch {}
    }
    const peers = await pickDevices(otherRawRecords)
    const chosenName = uniqueName(
      cfg.deviceName || 'Sondra AD',
      peers.filter((p) => p.id !== id).map((p) => p.name),
    )
    const kind = process.platform === 'win32' ? 'windows' : 'browser'
    const platformLabel =
      process.platform === 'win32'
        ? 'Sondra AD auf Windows'
        : process.platform === 'darwin'
          ? 'Sondra AD auf macOS'
          : 'Sondra AD Server'

    const signed = await signRecord(keys, {
      name: chosenName,
      kind,
      platform: platformLabel,
      created: deviceCreated,
      seen: Date.now(),
      caps: ['text', 'folder', 'resume'],
    })

    const saved = await putBytes(['Geräte'], `${id}.json`, Buffer.from(JSON.stringify(signed)), {
      mime: 'application/json',
    })
    deviceRecordFileId = saved.id
    return { self: signed, peers, fileId: deviceRecordFileId }
  }

  async function inspectStorage() {
    const cfg = store.getConfig()
    const localMain = getLocalDiskStats(cfg.localDir)
    const localTemp = computeDirectoryBytes(cfg.tempDir)
    const localSaved = computeDirectoryBytes(cfg.localDir)
    const localArchive = computeDirectoryBytes(cfg.localArchiveDir)

    if (!driveAuth.isConnected()) {
      return {
        connected: false,
        drive: null,
        local: {
          ...localMain,
          tempBytes: localTemp.bytes,
          savedBytes: localSaved.bytes,
          savedFiles: localSaved.files,
          archiveBytes: localArchive.bytes,
          archiveFiles: localArchive.files,
        },
      }
    }

    const about = await callJson(
      `${apiBase()}/about?fields=${encodeURIComponent('user(displayName,emailAddress),storageQuota(limit,usage,usageInDrive,usageInDriveTrash)')}`,
    )
    const quota = about.storageQuota || {}
    const limitBytes = quota.limit ? Number(quota.limit) : 0
    const usageBytes = quota.usage ? Number(quota.usage) : 0
    const usageTrashBytes = quota.usageInDriveTrash ? Number(quota.usageInDriveTrash) : 0
    const freeBytes = limitBytes > 0 ? Math.max(0, limitBytes - usageBytes) : null

    const tree = await listSondraTree()
    const trashed = await listTrashedFiles()

    let seriesBytes = 0
    let seriesFiles = 0
    let archiveBytes = 0
    let archiveFiles = 0
    let otherSondraBytes = 0

    for (const f of tree.files) {
      if (f.path.startsWith('Serien/')) {
        seriesBytes += f.size
        seriesFiles += 1
      } else if (f.path.startsWith('Archiv/')) {
        archiveBytes += f.size
        archiveFiles += 1
      } else {
        otherSondraBytes += f.size
      }
    }
    const sondraTrashBytes = trashed.reduce((sum, f) => sum + f.size, 0)

    return {
      connected: true,
      drive: {
        limitBytes,
        usageBytes,
        usageTrashBytes,
        freeBytes,
        sondraTotalBytes: seriesBytes + archiveBytes + otherSondraBytes,
        seriesBytes,
        seriesFiles,
        archiveBytes,
        archiveFiles,
        otherSondraBytes,
        sondraTrashBytes,
        sondraTrashFiles: trashed.length,
        files: tree.files,
        trashed,
      },
      local: {
        ...localMain,
        tempBytes: localTemp.bytes,
        savedBytes: localSaved.bytes,
        savedFiles: localSaved.files,
        archiveBytes: localArchive.bytes,
        archiveFiles: localArchive.files,
      },
    }
  }

  return {
    ensureFolderPath,
    resolveSeasonFolder,
    repairDuplicateSeriesFolders,
    findBrokenDriveMedia,
    getLastSyncedTree: () => lastSyncedTree,
    markMediaChecked,
    setTrashed,
    findFileInFolder,
    putBytes,
    uploadFileToDrive,
    readFileBytes,
    downloadFileToLocal,
    moveDriveFile,
    deleteFilePermanently,
    listTrashedFiles,
    listSondraTree,
    syncMerkliste,
    pushMerkliste,
    heartbeatDeviceRecord,
    inspectStorage,
    seasonPath,
    archiveSeasonPath,
    hintProperties,
  }
}
