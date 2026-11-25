export type SavedLinkStatus = 'watching' | 'later' | 'paused' | 'done' | 'dropped'
export type AniworldLanguagePref = 'auto' | 'ger_sub' | 'ger_dub' | 'eng_sub'
export type AudioOutputFormat = 'original' | 'mp3' | 'wav' | 'm4a' | 'flac' | 'opus'
export type VideoFilePref = 'untouched' | 'best' | '1080p' | '720p' | '480p' | '360p'
export type AudioFilePref = 'untouched' | 'high' | 'medium' | 'low' | 'lossless'

export interface MerkSeason {
  number: number
  episodes: number | null
  watched: number[]
  title?: string
  cover?: string
}

export interface WatchHistoryEntry {
  id: string
  season: number
  episode: number
  at: number
}

export interface OnlineAvailableInfo {
  maxSeason: number
  maxEpisode: number
  checkedAt: number
  hasNew?: boolean
}

export interface SavedLinkItem {
  id: string
  url: string
  title: string
  language: AniworldLanguagePref
  season: number
  episode: number | null
  mode: 'video' | 'audio'
  audioFormat: AudioOutputFormat
  videoPref: VideoFilePref
  audioPref: AudioFilePref
  autoTranscribe: boolean
  updatedAt: number
  status?: SavedLinkStatus
  lastOpenedAt?: number
  seasons?: MerkSeason[]
  cover?: string
  notes?: string
  rating?: number
  tags?: string[]
  history?: WatchHistoryEntry[]
  onlineAvailable?: OnlineAvailableInfo
}

export type PanelId = 'uebersicht' | 'merkliste' | 'warteschlange' | 'speicher' | 'protokoll' | 'einstellungen'

export type StorageTarget = 'drive_only' | 'drive_and_local' | 'local_only'
export type BacklogMode = 'from_current' | 'new_only' | 'all_unwatched'
export type InactivityAction = 'drive_archive' | 'compress_archive' | 'offload_local' | 'pause_series' | 'delete'

export interface SeriesOverride {
  enabled?: boolean
  language?: AniworldLanguagePref
  mode?: 'video' | 'audio'
  videoPref?: VideoFilePref
  backlogMode?: BacklogMode
  lookaheadLimit?: number
}

export interface AdConfig {
  enabled: boolean
  autostartWindows: boolean
  closeToTray: boolean
  preventSuspend: boolean
  checkIntervalMinutes: number
  merkSyncIntervalMinutes: number
  concurrency: number
  maxBandwidthKbps: number

  language: AniworldLanguagePref
  waitForPreferredLanguage: boolean
  languageWaitFallbackHours: number
  mode: 'video' | 'audio'
  videoPref: VideoFilePref
  audioPref: AudioFilePref
  audioFormat: AudioOutputFormat
  hosterPriority: string[]
  browserCookies: string
  cookiesFile: string
  bindAddress: string
  useGpuEncoding: boolean

  storageTarget: StorageTarget
  localDir: string
  tempDir: string
  localArchiveDir: string

  watchStatuses: SavedLinkStatus[]
  backlogMode: BacklogMode
  lookaheadLimit: number
  seriesOverrides: Record<string, SeriesOverride>

  maxRetries: number
  retryBaseMinutes: number
  autoRetryOnNetworkRestore: boolean

  cleanupEnabled: boolean
  maxSondraDriveGb: number
  minFreeDriveGb: number
  minFreeLocalGb: number
  emptyDriveTrashFirst: boolean
  deleteWatchedFirst: boolean
  keepRecentWatchedCount: number
  deleteArchivedWhenFull: boolean
  protectUnwatched: boolean

  inactivityEnabled: boolean
  inactivityDays: number
  inactivityActions: InactivityAction[]
  archiveCompressHeight: number
  archiveDeleteAfterDays: number

  deviceName: string
  registerInSondraDevices: boolean
  googleClientId: string
  googleClientSecret: string
  desktopNotifications: boolean
  notifyOnComplete: boolean
  notifyOnFailure: boolean
  discordWebhookUrl: string
  remoteAccessToken: string
}

export interface DriveStatusInfo {
  configured: boolean
  hasClientSecret: boolean
  connected: boolean
  lasting: boolean
  expiresAt: number | null
  account: { name: string; email: string } | null
  pendingAuthUrl: string | null
  localSondra: {
    found: boolean
    dataDir: string | null
    hasDriveKey: boolean
    hasDlSettings: boolean
    hasYtdlp: boolean
    cookies?: string | null
    bindAddress?: string | null
    downloadDir?: string | null
  }
}

export interface NetworkAdapterOption {
  id: string
  name: string
  rawName: string
  address: string | null
}

export interface ToolsStatusInfo {
  ytdlpAvailable: boolean
  ytdlpVersion: string | null
  ytdlpPath: string | null
  ffmpegAvailable: boolean
  ffmpegPath: string | null
  gpuEncoder: string | null
  adapters: NetworkAdapterOption[]
}

export type QueueStatus =
  | 'queued'
  | 'downloading'
  | 'uploading'
  | 'retrying'
  | 'waiting_language'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface QueueJob {
  id: string
  url: string
  title: string
  seriesId: string | null
  seriesTitle: string | null
  season: number
  episode: number
  language: AniworldLanguagePref | null
  mode: 'video' | 'audio' | null
  videoPref: VideoFilePref | null
  preferredHoster: string | null
  status: QueueStatus
  progress: number
  loadedBytes: number
  totalBytes: number
  speedBps: number
  etaSeconds: number | null
  attempts: number
  nextRetryAt: number | null
  activeHoster: string | null
  triedHosters: string[]
  driveFileId?: string | null
  drivePath?: string | null
  localPath?: string | null
  error: string | null
  createdAt: number
  updatedAt: number
  completedAt?: number
}

export interface LogRecord {
  id: string
  at: number
  level: 'info' | 'warn' | 'error'
  category: 'download' | 'retry' | 'sync' | 'storage' | 'archive' | 'system'
  title: string
  message: string
  seriesId?: string
  seriesTitle?: string
  season?: number
  episode?: number
  hoster?: string
  triedHosters?: string[]
  detail?: string
}

export interface EpisodeRecord {
  seriesId: string
  season: number
  episode: number
  at?: number
  archivedAt?: number
  fileName?: string
  sizeBytes?: number
  driveFileId?: string | null
  drivePath?: string | null
  localPath?: string | null
  localArchivePath?: string | null
  hoster?: string
}

export interface DriveFileSummary {
  id: string
  name: string
  size: number
  modifiedTime: string | null
  path: string
  hint?: { series: string; season: number; episode: number } | null
}

export interface StorageReport {
  connected: boolean
  drive: {
    limitBytes: number
    usageBytes: number
    usageTrashBytes: number
    freeBytes: number | null
    sondraTotalBytes: number
    seriesBytes: number
    seriesFiles: number
    archiveBytes: number
    archiveFiles: number
    otherSondraBytes: number
    sondraTrashBytes: number
    sondraTrashFiles: number
    files: DriveFileSummary[]
    trashed: { id: string; name: string; size: number; modifiedTime: string | null }[]
  } | null
  local: {
    totalBytes: number
    freeBytes: number
    usedBytes: number
    path: string
    tempBytes: number
    savedBytes: number
    savedFiles: number
    archiveBytes: number
    archiveFiles: number
  }
}

declare global {
  interface Window {
    sondraAd?: {
      isDesktopApp: boolean
      pickFolder: (title?: string) => Promise<string | null>
      openFolder: (dirPath: string) => Promise<boolean>
      hideToTray: () => Promise<boolean>
      getAutostartState: () => Promise<boolean>
      setAutostartState: (enabled: boolean) => Promise<boolean>
    }
  }
}
