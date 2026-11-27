import { coerceToSqliteBytes, deserializeSondraSqlite, serializeSondraSqlite } from './sqlite.mjs'

const STATUSES = ['watching', 'later', 'paused', 'done', 'dropped']
export const LOCAL_PICTURE = 'sondra:lokal'
export const HINT_KEYS = { series: 'sondraSerie', season: 'sondraStaffel', episode: 'sondraFolge' }

export const seasonFolderName = (season) => (Number(season) === 0 ? 'Filme' : `Staffel ${season}`)

export const seriesFolderName = (title) =>
  String(title ?? '')
    .replace(/[/\\]+/g, '-')
    .replace(/[<>:"|?*\x00-\x1f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim() || 'Ohne Namen'

/**
 * Vergleichsschlüssel für Serienordner: ignoriert Groß-/Kleinschreibung, Akzente,
 * Umlaut-Schreibweisen und alle Satz-/Sonderzeichen. So landen „Frieren: Beyond
 * Journey's End“, „Frieren - Beyond Journeys End“ und „frieren beyond journeys end“
 * im selben Ordner.
 */
export function folderMatchKey(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/&/g, 'und')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\band\b/g, 'und')
    .replace(/[^\p{L}\p{N}]+/gu, '')
}

/** Liest die Staffelnummer aus einem Ordnernamen („Staffel 2“, „Season 02“, „S2“, „Filme“, „Specials“). */
export function seasonNumberFromFolderName(name) {
  const s = String(name ?? '').trim()
  if (/^(?:filme?|movies?|specials?|extras?)$/i.test(s)) return 0
  const m = s.match(/^(?:staffel|season|s)\s*[-_.]?\s*0*(\d{1,3})$/i)
  return m ? Number(m[1]) : null
}

export const seasonPath = (title, season) => ['Serien', seriesFolderName(title), seasonFolderName(season)]

export const archiveSeasonPath = (title, season) => ['Archiv', seriesFolderName(title), seasonFolderName(season)]

export function hintProperties(hint) {
  return {
    [HINT_KEYS.series]: String(hint.series),
    [HINT_KEYS.season]: String(hint.season),
    [HINT_KEYS.episode]: String(hint.episode),
  }
}

export function hintOf(properties) {
  if (!properties || typeof properties !== 'object') return null
  const series = properties[HINT_KEYS.series]
  const season = Number(properties[HINT_KEYS.season])
  const episode = Number(properties[HINT_KEYS.episode])
  if (!series || !Number.isInteger(season) || season < 0 || !Number.isInteger(episode) || episode < 1) return null
  return { series: String(series), season, episode }
}

export function parseLinkEpisodeInfo(rawUrl) {
  const s = String(rawUrl ?? '').trim()
  if (!s) return { season: 1, episode: 1 }
  const filmMatch = s.match(/\/filme\/film-(\d+)/i)
  if (filmMatch) return { season: 0, episode: Number(filmMatch[1]) || 1 }
  const seasonMatch = s.match(/\/staffel-(\d+)/i)
  const epMatch = s.match(/\/episode-(\d+)/i)
  return {
    season: seasonMatch ? Number(seasonMatch[1]) || 1 : 1,
    episode: epMatch ? Number(epMatch[1]) || 1 : 1,
  }
}

export function deriveLinkTitle(rawUrl) {
  try {
    const u = new URL(rawUrl)
    const slugMatch = u.pathname.match(/\/(?:anime|serie)\/stream\/([^/?#]+)/i)
    if (slugMatch) {
      return decodeURIComponent(slugMatch[1])
        .replace(/-/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase())
    }
    const last = u.pathname.split('/').filter(Boolean).pop()
    if (last) return decodeURIComponent(last).replace(/[-_]+/g, ' ')
    return u.hostname
  } catch {
    return 'Serie'
  }
}

export function buildAniworldEpisodeUrl(rawUrl, season, episode) {
  try {
    const u = new URL(rawUrl)
    const slugMatch = u.pathname.match(/\/(?:anime|serie)\/stream\/([^/?#]+)/i)
    if (!slugMatch) return null
    const baseType = u.pathname.includes('/serie/') ? 'serie' : 'anime'
    const slug = slugMatch[1]
    if (Number(season) === 0) {
      return `${u.origin}/${baseType}/stream/${slug}/filme/film-${episode}`
    }
    return `${u.origin}/${baseType}/stream/${slug}/staffel-${season}/episode-${episode}`
  } catch {
    return null
  }
}

const uniqueSorted = (numbers) =>
  Array.from(new Set((Array.isArray(numbers) ? numbers : []).filter((n) => Number.isInteger(n) && n >= 1))).sort(
    (a, b) => a - b,
  )

export function normalizeMerkItem(raw) {
  const info = parseLinkEpisodeInfo(raw?.url || '')
  const season = typeof raw?.season === 'number' && Number.isFinite(raw.season) ? Math.max(0, Math.floor(raw.season)) : info.season
  const episode =
    raw?.episode === null
      ? null
      : typeof raw?.episode === 'number' && Number.isFinite(raw.episode)
        ? Math.max(1, Math.floor(raw.episode))
        : info.episode
  const seasons = Array.isArray(raw?.seasons)
    ? raw.seasons
        .filter((s) => Boolean(s) && typeof s.number === 'number')
        .map((s) => {
          const epCount = typeof s.episodes === 'number' && s.episodes > 0 ? Math.floor(s.episodes) : null
          const watched = uniqueSorted(s.watched).filter((n) => epCount === null || n <= epCount)
          return {
            number: Math.max(0, Math.floor(s.number)),
            episodes: epCount,
            watched,
            ...(s.title ? { title: String(s.title) } : {}),
            ...(s.cover ? { cover: String(s.cover) } : {}),
            ...(s.coverFrame ? { coverFrame: s.coverFrame } : {}),
            ...(Array.isArray(s.parts) ? { parts: s.parts } : {}),
          }
        })
        .sort((a, b) => (a.number === 0 ? 1 : b.number === 0 ? -1 : a.number - b.number))
    : undefined

  return {
    id: raw?.id || `merk-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    url: String(raw?.url ?? ''),
    title: String(raw?.title || (raw?.url ? deriveLinkTitle(raw.url) : 'Ohne Namen')),
    language: raw?.language || 'auto',
    season,
    episode,
    mode: raw?.mode === 'audio' ? 'audio' : 'video',
    audioFormat: raw?.audioFormat || 'mp3',
    videoPref: raw?.videoPref || 'untouched',
    audioPref: raw?.audioPref || 'high',
    autoTranscribe: Boolean(raw?.autoTranscribe),
    updatedAt: typeof raw?.updatedAt === 'number' ? raw.updatedAt : Date.now(),
    status: raw?.status && STATUSES.includes(raw.status) ? raw.status : 'watching',
    ...(typeof raw?.lastOpenedAt === 'number' ? { lastOpenedAt: raw.lastOpenedAt } : {}),
    ...(seasons ? { seasons } : {}),
    ...(raw?.cover ? { cover: raw.cover } : {}),
    ...(raw?.coverFrame ? { coverFrame: raw.coverFrame } : {}),
    ...(raw?.tileFormat === 'manga' ? { tileFormat: 'manga' } : {}),
    ...(raw?.notes ? { notes: String(raw.notes) } : {}),
    ...(typeof raw?.rating === 'number' ? { rating: raw.rating } : {}),
    ...(typeof raw?.episodeDuration === 'number' ? { episodeDuration: raw.episodeDuration } : {}),
    ...(typeof raw?.filmDuration === 'number' ? { filmDuration: raw.filmDuration } : {}),
    ...(raw?.durations && typeof raw.durations === 'object' ? { durations: raw.durations } : {}),
    ...(Array.isArray(raw?.tags) ? { tags: raw.tags } : {}),
    ...(Array.isArray(raw?.history) ? { history: raw.history } : {}),
    ...(raw?.onlineAvailable && typeof raw.onlineAvailable === 'object' ? { onlineAvailable: raw.onlineAvailable } : {}),
    ...(typeof raw?.opening === 'number' ? { opening: raw.opening } : {}),
    ...(Array.isArray(raw?.intros) ? { intros: raw.intros } : {}),
    ...(raw?.goal && typeof raw.goal === 'object' ? { goal: raw.goal } : {}),
  }
}

export function travelling(item) {
  const away = (holder) =>
    holder?.cover?.startsWith?.('data:') ? { ...holder, cover: LOCAL_PICTURE, coverFrame: undefined } : holder
  return {
    ...away(item),
    ...(item.seasons
      ? {
          seasons: item.seasons.map((s) => ({
            ...away(s),
            ...(s.parts ? { parts: s.parts.map((part) => away(part)) } : {}),
          })),
        }
      : {}),
  }
}

function withLocalPictures(item, local) {
  const back = (holder, mine) =>
    holder?.cover === LOCAL_PICTURE
      ? mine?.cover?.startsWith?.('data:')
        ? { ...holder, cover: mine.cover, coverFrame: mine.coverFrame }
        : { ...holder, cover: undefined, coverFrame: undefined }
      : holder
  const localSeasons = local?.seasons ?? []
  return {
    ...back(item, local),
    ...(item.seasons
      ? {
          seasons: item.seasons.map((s) => {
            const mine = localSeasons.find((entry) => entry.number === s.number)
            return {
              ...back(s, mine),
              ...(s.parts ? { parts: s.parts.map((part, i) => back(part, mine?.parts?.[i])) } : {}),
            }
          }),
        }
      : {}),
  }
}

export function mergeMerkliste(current, incoming) {
  const next = [...current]
  let added = 0
  let updated = 0
  let same = 0
  let kept = 0
  const nameOf = (item) => String(item.title ?? '').trim().toLowerCase()
  for (const entry of incoming) {
    const index = next.findIndex((item) => item.id === entry.id || nameOf(item) === nameOf(entry))
    if (index === -1) {
      next.push(entry)
      added += 1
    } else if (entry.updatedAt > next[index].updatedAt) {
      next[index] = { ...entry, id: next[index].id }
      updated += 1
    } else if (entry.updatedAt === next[index].updatedAt) {
      same += 1
    } else {
      kept += 1
    }
  }
  return { items: next, added, updated, same, kept }
}

export function mergeShared(current, currentRemoved, remote) {
  const removed = { ...currentRemoved }
  for (const [id, at] of Object.entries(remote.removed ?? {})) {
    if (typeof at === 'number' && !(removed[id] >= at)) removed[id] = at
  }
  const gone = (item) => removed[item.id] !== undefined && removed[item.id] >= item.updatedAt
  const merged = mergeMerkliste(current, (remote.items ?? []).filter((item) => !gone(item)))
  const items = merged.items
    .filter((item) => !gone(item))
    .map((item) => withLocalPictures(item, current.find((entry) => entry.id === item.id)))
  for (const item of items) if (removed[item.id] !== undefined) delete removed[item.id]
  return { items, removed, added: merged.added, updated: merged.updated }
}

export function sharedKey(list, removed) {
  return JSON.stringify({ items: list.map(travelling), removed })
}

export function sharedSqliteBytes(list, removed, appState = {}) {
  return serializeSondraSqlite({
    items: list.map(travelling),
    removed,
    appState,
  })
}

export function readSharedMerkliste(input) {
  const sqliteBytes = coerceToSqliteBytes(input)
  if (sqliteBytes) {
    try {
      const snap = deserializeSondraSqlite(sqliteBytes)
      const items = (snap.items ?? []).map((item) => normalizeMerkItem(item))
      const removed = snap.removed ?? {}
      return { items, removed, appState: snap.appState ?? {}, key: sharedKey(items, removed) }
    } catch {
      return null
    }
  }
  const text = typeof input === 'string' ? input : new TextDecoder().decode(input)
  try {
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.items)) return null
    const removed = {}
    if (parsed.removed && typeof parsed.removed === 'object') {
      for (const [id, at] of Object.entries(parsed.removed)) if (typeof at === 'number') removed[id] = at
    }
    const items = parsed.items.filter((item) => Boolean(item) && typeof item === 'object').map((item) => normalizeMerkItem(item))
    return { items, removed, appState: {}, key: sharedKey(items, removed) }
  } catch {
    return null
  }
}

export function isEpisodeWatched(item, seasonNum, episodeNum) {
  const seasons = Array.isArray(item?.seasons) ? item.seasons : []
  const found = seasons.find((s) => s.number === seasonNum)
  if (found && Array.isArray(found.watched) && found.watched.includes(episodeNum)) return true
  return false
}

export function lastActivityAt(item) {
  let latest = typeof item?.lastOpenedAt === 'number' ? item.lastOpenedAt : 0
  if (Array.isArray(item?.history)) {
    for (const h of item.history) {
      if (typeof h?.at === 'number' && h.at > latest) latest = h.at
    }
  }
  if (!latest && typeof item?.updatedAt === 'number') latest = item.updatedAt
  return latest
}
