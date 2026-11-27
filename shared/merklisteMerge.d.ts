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

export interface EpisodeHint {
  series: string
  season: number
  episode: number
}

export function seasonFolderName(season: number): string
export function seriesFolderName(title: string): string
export function localSeriesFolderName(title: string): string
export function folderMatchKey(name: string): string
export function seasonNumberFromFolderName(name: string): number | null
export function seasonPath(title: string, season: number): string[]
export function archiveSeasonPath(title: string, season: number): string[]
export function hintProperties(hint: EpisodeHint): Record<string, string>
export function hintOf(properties: Record<string, string> | undefined): EpisodeHint | null
export function parseLinkEpisodeInfo(rawUrl: string): { season: number; episode: number }
export function deriveLinkTitle(rawUrl: string): string
export function buildAniworldEpisodeUrl(rawUrl: string, season: number, episode: number): string | null
export function normalizeMerkItem(raw: Partial<SavedLinkItem>): SavedLinkItem
export function mergeShared(
  current: SavedLinkItem[],
  currentRemoved: Record<string, number>,
  remote: { items: SavedLinkItem[]; removed: Record<string, number> },
): { items: SavedLinkItem[]; removed: Record<string, number>; added: number; updated: number }
export function sharedKey(list: SavedLinkItem[], removed: Record<string, number>): string
export function sharedSqliteBytes(
  list: SavedLinkItem[],
  removed: Record<string, number>,
  appState?: Record<string, { valueJson: string; updatedAt: number }>,
): Uint8Array
export function readSharedMerkliste(input: string | Uint8Array): {
  items: SavedLinkItem[]
  removed: Record<string, number>
  appState: Record<string, { valueJson: string; updatedAt: number }>
  key: string
} | null
export function isEpisodeWatched(item: SavedLinkItem, seasonNum: number, episodeNum: number): boolean
export function lastActivityAt(item: SavedLinkItem): number
