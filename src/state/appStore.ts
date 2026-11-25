import { create } from 'zustand'
import type {
  AdConfig,
  DriveStatusInfo,
  EpisodeRecord,
  LogRecord,
  PanelId,
  QueueJob,
  ReleaseCalendarEntry,
  SavedLinkItem,
  SeriesOverride,
  ShutdownState,
  StorageReport,
  ToolsStatusInfo,
} from '../types'

const TOKEN_STORAGE_KEY = 'sondra-ad:access-token'

function getStoredToken(): string {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY) || ''
  } catch {
    return ''
  }
}

export function setStoredToken(token: string): void {
  try {
    if (token) localStorage.setItem(TOKEN_STORAGE_KEY, token)
    else localStorage.removeItem(TOKEN_STORAGE_KEY)
  } catch {}
}

export async function apiCall<T = Record<string, unknown>>(
  endpoint: string,
  options: { method?: 'GET' | 'POST'; body?: unknown } = {},
): Promise<T> {
  const token = getStoredToken()
  const headers: Record<string, string> = {}
  if (token) headers.Authorization = `Bearer ${token}`
  if (options.body !== undefined) headers['Content-Type'] = 'application/json'

  const res = await fetch(`./api/ad/${endpoint}`, {
    method: options.method || (options.body !== undefined ? 'POST' : 'GET'),
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  })
  const data = (await res.json().catch(() => ({}))) as T & { ok?: boolean; error?: string }
  if (res.status === 401) {
    useAppStore.setState({ authRequired: true })
    throw new Error(data.error || 'Zugangsschlüssel erforderlich')
  }
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `Anfrage fehlgeschlagen (${res.status})`)
  }
  return data
}

const SLUGS: Record<PanelId, string> = {
  uebersicht: '',
  merkliste: '#merkliste',
  warteschlange: '#warteschlange',
  speicher: '#speicher',
  protokoll: '#protokoll',
  einstellungen: '#einstellungen',
}

export function panelFromHash(hash: string): PanelId {
  const clean = hash.replace(/^#/, '').trim().toLowerCase()
  if (clean === 'merkliste') return 'merkliste'
  if (clean === 'warteschlange') return 'warteschlange'
  if (clean === 'speicher') return 'speicher'
  if (clean === 'protokoll') return 'protokoll'
  if (clean === 'einstellungen') return 'einstellungen'
  return 'uebersicht'
}

import { IN_ELECTRON_APP } from '../lib/downloads'

export type SurfaceMode = 'loading' | 'app' | 'website'

function initialSurfaceMode(): SurfaceMode {
  if (typeof window === 'undefined') return 'loading'
  if (import.meta.env.VITE_WEBSITE_ONLY === 'true') return 'website'
  const params = new URLSearchParams(window.location.search)
  if (params.get('web') === '1') return 'website'
  if (IN_ELECTRON_APP) return 'app'
  return 'loading'
}

export interface AppState {
  surfaceMode: SurfaceMode
  panel: PanelId
  enterDirection: number
  ready: boolean
  authRequired: boolean
  runtimeMode: 'desktop' | 'server'
  platform: string
  checking: boolean
  shutdownState: ShutdownState | null
  errorBanner: string | null

  config: AdConfig | null
  drive: DriveStatusInfo | null
  tools: ToolsStatusInfo | null
  merkItems: SavedLinkItem[]
  merkMeta: { lastSyncAt: number; lastCheckAt: number; nextCheckAt: number }
  queue: QueueJob[]
  episodeIndex: { downloaded: Record<string, EpisodeRecord>; archived: Record<string, EpisodeRecord> }
  logs: LogRecord[]
  calendar: ReleaseCalendarEntry[]
  storage: StorageReport | null
  loadingStorage: boolean

  setPanel: (next: PanelId) => void
  bootstrap: () => Promise<void>
  refreshStorage: () => Promise<void>
  refreshCalendar: () => Promise<void>
  updateConfig: (patch: Partial<AdConfig>) => Promise<void>
  toggleEngine: (enabled?: boolean) => Promise<void>
  cancelPendingShutdown: () => Promise<void>
  setShutdownAfterQueue: (enabled: boolean) => Promise<void>
  testPushNotifications: () => Promise<{ channel: string; ok: boolean; status?: number; error?: string }[]>
  testWebdav: () => Promise<{ ok: boolean; status?: number; url?: string }>
  checkNow: (seriesId?: string) => Promise<{ checkedSeries: number; totalQueued: number }>
  syncMerkliste: () => Promise<void>
  upsertSeries: (item: Partial<SavedLinkItem> & { checkImmediately?: boolean }) => Promise<void>
  removeSeries: (id: string) => Promise<void>
  setSeriesOverride: (seriesId: string, override: SeriesOverride | null) => Promise<void>
  addQueueUrl: (payload: { url: string; language?: string; mode?: string; videoPref?: string }) => Promise<number>
  retryJob: (id: string, preferredHoster?: string | null) => Promise<void>
  retryAllFailed: () => Promise<number>
  cancelJob: (id: string) => Promise<void>
  cancelAllJobs: () => Promise<number>
  removeJob: (id: string) => Promise<void>
  clearCompletedJobs: () => Promise<void>
  removeHistoryEntry: (payload: { key?: string; jobId?: string }) => Promise<void>
  clearDownloadHistory: (clearEpisodeIndex?: boolean) => Promise<void>
  removeWatchHistory: (payload: {
    seriesId?: string
    entryId?: string
    clearAll?: boolean
    undoWatched?: boolean
  }) => Promise<void>
  removeLogEntry: (id: string) => Promise<void>
  clearLogs: () => Promise<void>
}

const PANEL_ORDER: PanelId[] = ['uebersicht', 'merkliste', 'warteschlange', 'speicher', 'protokoll', 'einstellungen']

export const useAppStore = create<AppState>((set, get) => ({
  surfaceMode: initialSurfaceMode(),
  panel: typeof window !== 'undefined' ? panelFromHash(window.location.hash) : 'uebersicht',
  enterDirection: 0,
  ready: false,
  authRequired: false,
  runtimeMode: 'server',
  platform: 'win32',
  checking: false,
  shutdownState: null,
  errorBanner: null,

  config: null,
  drive: null,
  tools: null,
  merkItems: [],
  merkMeta: { lastSyncAt: 0, lastCheckAt: 0, nextCheckAt: 0 },
  queue: [],
  episodeIndex: { downloaded: {}, archived: {} },
  logs: [],
  calendar: [],
  storage: null,
  loadingStorage: false,

  setPanel: (next) => {
    const prev = get().panel
    if (prev === next) return
    const dir = PANEL_ORDER.indexOf(next) > PANEL_ORDER.indexOf(prev) ? 20 : -20
    const hash = SLUGS[next]
    if (typeof window !== 'undefined') {
      const url = hash ? `${window.location.pathname}${window.location.search}${hash}` : `${window.location.pathname}${window.location.search}`
      window.history.pushState(null, '', url)
    }
    set({ panel: next, enterDirection: dir })
  },

  bootstrap: async () => {
    if (get().surfaceMode === 'website') return
    try {
      const token = getStoredToken()
      const headers: Record<string, string> = {}
      if (token) headers.Authorization = `Bearer ${token}`
      const res = await fetch('./api/ad/bootstrap', { headers })
      if (res.status === 401) {
        set({ surfaceMode: 'app', authRequired: true, errorBanner: null })
        return
      }
      const ct = res.headers.get('content-type') || ''
      if (!res.ok || !ct.includes('application/json')) {
        if (IN_ELECTRON_APP) {
          set({ surfaceMode: 'app', errorBanner: `Lokaler Dienst antwortete unerwartet (${res.status}).` })
        } else {
          set({ surfaceMode: 'website', errorBanner: null })
        }
        return
      }
      const data = (await res.json()) as {
        ok?: boolean
        runtimeMode: 'desktop' | 'server'
        platform: string
        checking: boolean
        shutdownState?: ShutdownState | null
        config: AdConfig
        drive: DriveStatusInfo
        tools: ToolsStatusInfo
        merkItems: SavedLinkItem[]
        merkMeta: { lastSyncAt: number; lastCheckAt: number; nextCheckAt: number }
        queue: QueueJob[]
        episodeIndex: { downloaded: Record<string, EpisodeRecord>; archived: Record<string, EpisodeRecord> }
        logs: LogRecord[]
        calendar?: ReleaseCalendarEntry[]
      }
      if (!data || typeof data !== 'object' || !data.config) {
        if (IN_ELECTRON_APP) {
          set({ surfaceMode: 'app', errorBanner: 'Ungültige Antwort vom lokalen Dienst.' })
        } else {
          set({ surfaceMode: 'website', errorBanner: null })
        }
        return
      }

      set({
        surfaceMode: 'app',
        ready: true,
        authRequired: false,
        errorBanner: null,
        runtimeMode: data.runtimeMode,
        platform: data.platform,
        checking: data.checking,
        shutdownState: data.shutdownState ?? null,
        config: data.config,
        drive: data.drive,
        tools: data.tools,
        merkItems: data.merkItems,
        merkMeta: data.merkMeta,
        queue: data.queue,
        episodeIndex: data.episodeIndex,
        logs: data.logs,
        calendar: data.calendar ?? [],
      })
      void get().refreshStorage()
    } catch (err) {
      if (IN_ELECTRON_APP) {
        set({ surfaceMode: 'app', errorBanner: err instanceof Error ? err.message : String(err) })
      } else {
        set({ surfaceMode: 'website', errorBanner: null })
      }
    }
  },

  refreshStorage: async () => {
    set({ loadingStorage: true })
    try {
      const res = await apiCall<{
        storage: StorageReport
        episodeIndex: { downloaded: Record<string, EpisodeRecord>; archived: Record<string, EpisodeRecord> }
      }>('storage')
      set({ storage: res.storage, episodeIndex: res.episodeIndex, loadingStorage: false })
    } catch {
      set({ loadingStorage: false })
    }
  },

  refreshCalendar: async () => {
    try {
      const res = await apiCall<{ calendar: ReleaseCalendarEntry[] }>('calendar')
      set({ calendar: res.calendar ?? [] })
    } catch {}
  },

  updateConfig: async (patch) => {
    const prevCfg = get().config
    if (prevCfg) set({ config: { ...prevCfg, ...patch } })
    const res = await apiCall<{
      config: AdConfig
      drive: DriveStatusInfo
      shutdownState?: ShutdownState
      calendar?: ReleaseCalendarEntry[]
    }>('config', {
      body: patch,
    })
    set({
      config: res.config,
      drive: res.drive,
      ...(res.shutdownState ? { shutdownState: res.shutdownState } : {}),
      ...(res.calendar ? { calendar: res.calendar } : {}),
    })
  },

  toggleEngine: async (enabled) => {
    const res = await apiCall<{ config: AdConfig }>('toggle', {
      body: typeof enabled === 'boolean' ? { enabled } : {},
    })
    set({ config: res.config })
  },

  cancelPendingShutdown: async () => {
    const res = await apiCall<{ shutdownState: ShutdownState; config: AdConfig }>('power/cancel-shutdown', {
      body: {},
    })
    set({ shutdownState: res.shutdownState, config: res.config })
  },

  setShutdownAfterQueue: async (enabled) => {
    const res = await apiCall<{ shutdownState: ShutdownState; config: AdConfig }>('power/after-queue', {
      body: { enabled },
    })
    set({ shutdownState: res.shutdownState, config: res.config })
  },

  testPushNotifications: async () => {
    const res = await apiCall<{ results: { channel: string; ok: boolean; status?: number; error?: string }[] }>(
      'notifications/test',
      { body: {} },
    )
    return res.results ?? []
  },

  testWebdav: async () => {
    return apiCall<{ ok: boolean; status?: number; url?: string }>('storage/test-webdav', { body: {} })
  },

  checkNow: async (seriesId) => {
    set({ checking: true })
    try {
      const res = await apiCall<{
        checkedSeries: number
        totalQueued: number
        merkItems: SavedLinkItem[]
        merkMeta: { lastSyncAt: number; lastCheckAt: number; nextCheckAt: number }
        queue: QueueJob[]
      }>('check-now', { body: seriesId ? { seriesId } : {} })
      set({
        checking: false,
        merkItems: res.merkItems,
        merkMeta: res.merkMeta,
        queue: res.queue,
      })
      return { checkedSeries: res.checkedSeries ?? 0, totalQueued: res.totalQueued ?? 0 }
    } catch (err) {
      set({ checking: false })
      throw err
    }
  },

  syncMerkliste: async () => {
    const res = await apiCall<{
      merkItems: SavedLinkItem[]
      merkMeta: { lastSyncAt: number; lastCheckAt: number; nextCheckAt: number }
      episodeIndex: { downloaded: Record<string, EpisodeRecord>; archived: Record<string, EpisodeRecord> }
    }>('merkliste/sync', { body: {} })
    set({ merkItems: res.merkItems, merkMeta: res.merkMeta, episodeIndex: res.episodeIndex })
  },

  upsertSeries: async (item) => {
    const res = await apiCall<{ merkItems: SavedLinkItem[] }>('merkliste/upsert', { body: item })
    set({ merkItems: res.merkItems })
  },

  removeSeries: async (id) => {
    const res = await apiCall<{ merkItems: SavedLinkItem[] }>('merkliste/remove', { body: { id } })
    set({ merkItems: res.merkItems })
  },

  setSeriesOverride: async (seriesId, override) => {
    const res = await apiCall<{ config: AdConfig }>('merkliste/series-override', {
      body: override === null ? { seriesId, reset: true } : { seriesId, override },
    })
    set({ config: res.config })
  },

  addQueueUrl: async (payload) => {
    const res = await apiCall<{ count: number; queue: QueueJob[] }>('queue/add', { body: payload })
    set({ queue: res.queue })
    return res.count
  },

  retryJob: async (id, preferredHoster = null) => {
    const res = await apiCall<{ queue: QueueJob[] }>('queue/retry', { body: { id, preferredHoster } })
    set({ queue: res.queue })
  },

  retryAllFailed: async () => {
    const res = await apiCall<{ count: number; queue: QueueJob[] }>('queue/retry-all', { body: {} })
    set({ queue: res.queue })
    return res.count
  },

  cancelJob: async (id) => {
    const res = await apiCall<{ queue: QueueJob[] }>('queue/cancel', { body: { id } })
    set({ queue: res.queue })
  },

  cancelAllJobs: async () => {
    const res = await apiCall<{ count: number; queue: QueueJob[] }>('queue/cancel-all', { body: {} })
    set({ queue: res.queue })
    return res.count
  },

  removeJob: async (id) => {
    const res = await apiCall<{ queue: QueueJob[] }>('queue/remove', { body: { id } })
    set({ queue: res.queue })
  },

  clearCompletedJobs: async () => {
    const res = await apiCall<{ queue: QueueJob[] }>('queue/clear-completed', { body: {} })
    set({ queue: res.queue })
  },

  removeHistoryEntry: async (payload) => {
    const res = await apiCall<{
      episodeIndex: { downloaded: Record<string, EpisodeRecord>; archived: Record<string, EpisodeRecord> }
      queue: QueueJob[]
    }>('history/remove', { body: payload })
    set({ episodeIndex: res.episodeIndex, queue: res.queue })
  },

  clearDownloadHistory: async (clearEpisodeIndex = true) => {
    const res = await apiCall<{
      episodeIndex: { downloaded: Record<string, EpisodeRecord>; archived: Record<string, EpisodeRecord> }
      queue: QueueJob[]
    }>('history/clear', { body: { clearEpisodeIndex } })
    set({ episodeIndex: res.episodeIndex, queue: res.queue })
  },

  removeWatchHistory: async (payload) => {
    const res = await apiCall<{ merkItems: SavedLinkItem[] }>('watch-history/remove', { body: payload })
    set({ merkItems: res.merkItems })
  },

  removeLogEntry: async (id) => {
    const res = await apiCall<{ logs: LogRecord[] }>('logs/remove', { body: { id } })
    set({ logs: res.logs })
  },

  clearLogs: async () => {
    await apiCall('logs/clear', { body: {} })
    set({ logs: [] })
  },
}))

let sseSource: EventSource | null = null

export function connectLiveEvents(): () => void {
  if (typeof window === 'undefined') return () => undefined

  const openStream = () => {
    sseSource?.close()
    const token = getStoredToken()
    const url = token ? `./api/ad/events?token=${encodeURIComponent(token)}` : './api/ad/events'
    const es = new EventSource(url)
    sseSource = es

    es.addEventListener('job', (ev) => {
      try {
        const updated = JSON.parse((ev as MessageEvent).data) as QueueJob
        useAppStore.setState((s) => {
          const exists = s.queue.some((q) => q.id === updated.id)
          return {
            queue: exists
              ? s.queue.map((q) => (q.id === updated.id ? updated : q))
              : [...s.queue, updated],
          }
        })
      } catch {}
    })

    es.addEventListener('queue', (ev) => {
      try {
        const queue = JSON.parse((ev as MessageEvent).data) as QueueJob[]
        useAppStore.setState({ queue })
      } catch {}
    })

    es.addEventListener('log', (ev) => {
      try {
        const log = JSON.parse((ev as MessageEvent).data) as LogRecord
        useAppStore.setState((s) => ({ logs: [log, ...s.logs].slice(0, 600) }))
      } catch {}
    })

    es.addEventListener('status', (ev) => {
      try {
        const st = JSON.parse((ev as MessageEvent).data) as { checking?: boolean; shutdownState?: ShutdownState }
        const patch: Partial<AppState> = {}
        if (typeof st.checking === 'boolean') patch.checking = st.checking
        if (st.shutdownState) patch.shutdownState = st.shutdownState
        if (Object.keys(patch).length > 0) useAppStore.setState(patch)
      } catch {}
    })

    es.addEventListener('change', (ev) => {
      try {
        const chg = JSON.parse((ev as MessageEvent).data) as { type?: string; id?: string }
        if (chg.type === 'merkliste' || chg.type === 'drive-auth' || chg.type === 'episodes' || chg.type === 'config') {
          void useAppStore.getState().bootstrap()
        } else if (chg.type === 'logs-cleared') {
          useAppStore.setState({ logs: [] })
        } else if (chg.type === 'logs-updated' && chg.id) {
          useAppStore.setState((s) => ({ logs: s.logs.filter((l) => l.id !== chg.id) }))
        }
      } catch {}
    })
  }

  openStream()
  const onPopState = () => {
    useAppStore.setState({ panel: panelFromHash(window.location.hash), enterDirection: 0 })
  }
  window.addEventListener('popstate', onPopState)

  return () => {
    window.removeEventListener('popstate', onPopState)
    sseSource?.close()
    sseSource = null
  }
}
